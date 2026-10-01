// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// 200000-features: a city of 208,073 features, every one of them editable.
// The page makes a made-up city in code (data.ts): 174,435 buildings and parks, 24,328 streets
// and 9,310 places. It loads them into the drawing in one step and looks at them from a tilted
// camera, near at hand in front and far into the distance behind. They are features like any
// drawn by hand: click one to select it, drag it, change its vertices, or change it in the
// panel on the right. The numbers and the time of the load are logged in the browser console.

import { createDraw } from '@sakuzu/maplibre-gl-draw';
import { createDrawUI } from '@sakuzu/maplibre-gl-draw-ui';
import '@sakuzu/maplibre-gl-draw-ui/style.css';
import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import '../maplibre-setup.ts';
import { BASEMAPS, basemapStyle, initialBasemapId } from '../basemap.ts';
import '../example.css';
import { CENTER, createCity, HALF_SIZE_KM, PARK_AT_KM, PARK_ID } from './data.ts';

// 1. A tilted camera over the middle of the city, looking north-north-east
const map = new maplibregl.Map({
  container: 'map',
  style: basemapStyle(),
  center: CENTER,
  zoom: 16.2,
  pitch: 60,
  bearing: 28,
});

// 2. The roads, the buildings and the places of the basemap are hidden, as the made-up city
// takes their place. Done whenever a style has loaded (the basemap menu replaces the style)
map.on('style.load', () => {
  for (const layer of map.getStyle().layers) {
    const sourceLayer = 'source-layer' in layer ? layer['source-layer'] : undefined;
    if (
      sourceLayer === 'transportation' ||
      sourceLayer === 'transportation_name' ||
      sourceLayer === 'building' ||
      sourceLayer === 'poi'
    ) {
      map.setLayoutProperty(layer.id, 'visibility', 'none');
    }
  }
});

const draw = createDraw(map, { initDefaultLayer: false });

// 3. The standard UI. Its layer panel lists up to 1,000 features in a layer (the `features`
// option of `layers` sets the limit); the layers of the city hold more, so each shows the
// number of its features in a row of its own, and they are selected on the map
const locale = new URLSearchParams(location.search).get('locale') === 'ja' ? 'ja' : 'en';
const ui = createDrawUI(draw, { locale, basemaps: BASEMAPS, basemap: initialBasemapId() });

// 4. The city, the same on every visit (data.ts): streets on a bent grid, blocks of houses on
// their lots, parks, and places on some of the houses, in three layers with a style rule each
const { document: city, counts } = createCity(CENTER, HALF_SIZE_KM, PARK_AT_KM);

// 5. One load writes them all in one transaction: one change, one redraw. Creating them with
// `draw.features.createMany` is one transaction too. Then the park in front is selected, with
// its vertex handles
const started = performance.now();
const loaded = draw.document.load(city).then(() => {
  const ms = Math.round(performance.now() - started);
  const format = (n: number) => n.toLocaleString('en');
  console.info(
    `${format(counts.total)} features (${format(counts.polygons)} polygons, ` +
      `${format(counts.lines)} lines, ${format(counts.points)} points) loaded in ${ms} ms`,
  );
  draw.selection.set('feature', [PARK_ID]);
  return { ...counts, ms };
});

// For the browser console and the end-to-end tests
Object.assign(window, { map, draw, ui, loaded });
