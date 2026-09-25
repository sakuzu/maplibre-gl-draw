// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// basic: the page of the getting started guide (docs/getting-started.md), step by step.
// The user draws polygons on a MapLibre map; the page follows the changes, saves the
// drawing in the browser and restores it on the next visit.

import { createMapLibreGLDraw } from '@sakuzu/maplibre-gl-draw';
import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
// 1. Install: set the worker URL of maplibre-gl once, before the first map is created
import '../maplibre-setup.ts';
import { basemapStyle } from '../basemap.ts';
import '../example.css';

// 2. Create the map and draw
const map = new maplibregl.Map({
  container: 'map',
  style: basemapStyle('https://tiles.openfreemap.org/styles/liberty'),
  center: [139.767, 35.681],
  zoom: 12,
});

const draw = createMapLibreGLDraw(map);

// 3. Draw a polygon
document.querySelector('#draw-polygon')?.addEventListener('click', () => {
  draw.setMode('draw_polygon');
});

draw.on('draw.feature.create', ({ feature }) => {
  console.log('created', feature.id, feature.type);
});

draw.on('draw.mode.change', ({ mode }) => {
  document.querySelector('#draw-polygon')?.classList.toggle('active', mode === 'draw_polygon');
});

// 4. Subscribe to changes
draw.on('draw.features.change', ({ created, updated, deleted, source }) => {
  console.log(
    `${created.length} created, ${updated.length} updated,`,
    `${deleted.length} deleted (${source})`,
  );
});

// 5. Save and load
const STORAGE_KEY = 'maplibre-gl-draw:basic';

document.querySelector('#save')?.addEventListener('click', () => {
  const { data } = draw.export('geojson');
  localStorage.setItem(STORAGE_KEY, data);
});

const saved = localStorage.getItem(STORAGE_KEY);
if (saved !== null) {
  const result = await draw.load(JSON.parse(saved));
  console.log(`loaded ${result.featureIds.length} features`);
  for (const { index, reason } of result.skipped ?? []) {
    console.warn(`feature ${index} was skipped: ${reason}`);
  }
}

// For the browser console and the end-to-end tests
Object.assign(window, { map, draw });
