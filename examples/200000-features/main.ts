// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// 200000-features: 200,000 features, every one of them editable.
// The page makes a made-up town of 200,000 small buildings in code and loads them into the
// drawing in one step. They are features like any drawn by hand: click one to select it, drag
// it, change its vertices, or change it in the panel on the right. The time of the load is
// logged in the browser console.

import { createDraw } from '@sakuzu/maplibre-gl-draw';
import { createDrawUI } from '@sakuzu/maplibre-gl-draw-ui';
import '@sakuzu/maplibre-gl-draw-ui/style.css';
import type { Feature, FeatureCollection, Polygon } from 'geojson';
import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import '../maplibre-setup.ts';
import { BASEMAPS, basemapStyle, initialBasemapId } from '../basemap.ts';
import '../example.css';

const CENTER: [number, number] = [139.767, 35.681];
const map = new maplibregl.Map({
  container: 'map',
  style: basemapStyle(),
  center: CENTER,
  zoom: 15,
});
const draw = createDraw(map);

// 1. The standard UI, with the layer panel listing the layers without their features: the list
// makes a row for each feature, which is too many here
const locale = new URLSearchParams(location.search).get('locale') === 'ja' ? 'ja' : 'en';
const ui = createDrawUI(draw, {
  locale,
  basemaps: BASEMAPS,
  basemap: initialBasemapId(),
  layers: { features: false },
});

// 2. A random number generator with a seed, so the town is the same on every visit
let seed = 42;
function random(): number {
  seed = (seed * 16_807) % 2_147_483_647;
  return seed / 2_147_483_647;
}

// 3. 500 x 400 plots, each with a building of its own size, place and number of floors
const COLUMNS = 500;
const ROWS = 400;
const PLOT = 0.0004; // degrees, about 40 m
function createTown(): FeatureCollection<Polygon> {
  const features: Feature<Polygon>[] = [];
  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLUMNS; col++) {
      const west = CENTER[0] + (col - COLUMNS / 2) * PLOT + random() * PLOT * 0.3;
      const south = CENTER[1] + (row - ROWS / 2) * PLOT * 0.8 + random() * PLOT * 0.2;
      const width = PLOT * (0.3 + random() * 0.35);
      const depth = PLOT * 0.8 * (0.3 + random() * 0.35);
      const ring = [
        [west, south],
        [west + width, south],
        [west + width, south + depth],
        [west, south + depth],
        [west, south],
      ];
      const floors = 1 + Math.floor(random() ** 3 * 30);
      features.push({
        type: 'Feature',
        geometry: { type: 'Polygon', coordinates: [ring] },
        properties: { name: `Building ${row * COLUMNS + col + 1}`, floors },
      });
    }
  }
  return { type: 'FeatureCollection', features };
}

// 4. One load writes them all in one transaction: one change, one redraw. Creating them with
// `draw.features.createMany` is one transaction too
const started = performance.now();
const loaded = draw.document.load(createTown()).then((result) => {
  const ms = Math.round(performance.now() - started);
  console.log(`${result?.featureIds.length.toLocaleString()} features in ${ms} ms`);
});

// For the browser console and the end-to-end tests
Object.assign(window, { map, draw, ui, loaded });
