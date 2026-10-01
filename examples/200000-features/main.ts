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
import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import '../maplibre-setup.ts';
import { BASEMAPS, basemapStyle, initialBasemapId } from '../basemap.ts';
import '../example.css';
import { CENTER, createTown } from './data.ts';

const map = new maplibregl.Map({
  container: 'map',
  style: basemapStyle(),
  center: CENTER,
  zoom: 15,
});
const draw = createDraw(map);

// 1. The standard UI. Its layer panel lists up to 1,000 features in a layer (the `features`
// option of `layers` sets the limit); this layer holds more, so its row shows their number and
// they are selected on the map
const locale = new URLSearchParams(location.search).get('locale') === 'ja' ? 'ja' : 'en';
const ui = createDrawUI(draw, { locale, basemaps: BASEMAPS, basemap: initialBasemapId() });

// 2. The town: 500 x 400 plots, each with a building of its own size, place and number of
// floors, the same on every visit (data.ts)
// 3. One load writes them all in one transaction: one change, one redraw. Creating them with
// `draw.features.createMany` is one transaction too
const started = performance.now();
const loaded = draw.document.load(createTown()).then((result) => {
  const ms = Math.round(performance.now() - started);
  console.log(`${result?.featureIds.length.toLocaleString()} features in ${ms} ms`);
});

// For the browser console and the end-to-end tests
Object.assign(window, { map, draw, ui, loaded });
