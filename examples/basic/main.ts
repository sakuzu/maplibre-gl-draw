// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// basic: the page of the getting started guide (docs/getting-started.md), step by step.
// The user draws polygons on a MapLibre map; the page follows the changes, saves the
// drawing in the browser and restores it on the next visit.

import { createDraw } from '@sakuzu/maplibre-gl-draw';
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

const draw = createDraw(map);

// 3. Draw a polygon
document.querySelector('#draw-polygon')?.addEventListener('click', () => {
  draw.setMode('draw_polygon');
});

draw.on('feature.created', ({ feature }) => {
  console.log('created', feature.id, feature.type);
});

draw.on('mode.changed', ({ mode }) => {
  document.querySelector('#draw-polygon')?.classList.toggle('active', mode === 'draw_polygon');
});

// 4. Subscribe to changes: one event per transaction, whatever made it
draw.on('document.changed', ({ features, source }) => {
  if (!features) return;
  console.log(
    `${features.created?.length ?? 0} created, ${features.updated?.length ?? 0} updated,`,
    `${features.deleted?.length ?? 0} deleted (${source})`,
  );
});

// 5. Save and load
const STORAGE_KEY = 'maplibre-gl-draw:basic';

document.querySelector('#save')?.addEventListener('click', () => {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(draw.document.toGeoJSON()));
});

const saved = localStorage.getItem(STORAGE_KEY);
if (saved !== null) {
  const result = await draw.document.load(JSON.parse(saved));
  console.log(`loaded ${result?.featureIds.length ?? 0} features`);
  for (const { index, reason } of result?.skipped ?? []) {
    console.warn(`feature ${index} was skipped: ${reason}`);
  }
}

// For the browser console and the end-to-end tests
Object.assign(window, { map, draw });
