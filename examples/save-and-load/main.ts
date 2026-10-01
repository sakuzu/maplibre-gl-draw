// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// save-and-load: getting the drawing out and back in.
// The page opens with a GeoJSON file, which adds its features and reports the one it left out.
// S saves the whole document in the browser, in the format of the library; O loads the saved
// document back in place of the drawing; and a file dropped on the map is loaded there. The next
// visit opens with what was saved.

import { createDraw, type LoadResult } from '@sakuzu/maplibre-gl-draw';
import { createDrawUI } from '@sakuzu/maplibre-gl-draw-ui';
import '@sakuzu/maplibre-gl-draw-ui/style.css';
import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import '../maplibre-setup.ts';
import { basemapStyle } from '../basemap.ts';
import '../example.css';
import { SAMPLE } from './data.ts';

const map = new maplibregl.Map({
  container: 'map',
  style: basemapStyle(),
  center: [139.7735, 35.678],
  zoom: 14.3,
});
const draw = createDraw(map);
const locale = new URLSearchParams(location.search).get('locale') === 'ja' ? 'ja' : 'en';
const ui = createDrawUI(draw, { locale });

// 1. What a load read: the format it detected, the features, and those it left out
function report(result: LoadResult | null): void {
  if (result === null) {
    console.log('The drawing is read-only');
    return;
  }
  const replaced = result.replaced ? ', in place of the drawing' : '';
  console.log(`Loaded ${result.featureIds.length} features (${result.format})${replaced}`);
  for (const { index, reason } of result.skipped ?? []) {
    console.warn(`Left out feature ${index}: ${reason}`);
  }
}

// 2. Open with the document saved on the last visit, or else with the GeoJSON file, whose
// features are added to the drawing. `load` takes an object, a JSON string or a File
const STORAGE_KEY = 'maplibre-gl-draw:save-and-load';
const saved = localStorage.getItem(STORAGE_KEY);
const loaded = draw.document.load(saved ?? SAMPLE).then(report);

// 3. The format of the library keeps the whole document: the layers, the groups, their order and
// the styles. GeoJSON keeps the features alone, for other tools; here it goes to the console
function save(): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(draw.document.toJSON()));
  console.log(`Saved ${draw.features.count()} features`, draw.document.toGeoJSON());
}

// 4. A document of the library replaces the drawing when it is loaded
async function restore(): Promise<void> {
  const text = localStorage.getItem(STORAGE_KEY);
  if (text === null) {
    console.log('Nothing has been saved yet: press S');
    return;
  }
  report(await draw.document.load(text));
}

// 5. The two keys of the page, left alone while a field of the panels has the keyboard
window.addEventListener('keydown', (event) => {
  const typing =
    event.target instanceof Element &&
    event.target.closest('input, textarea, select, [contenteditable]') !== null;
  if (typing || event.repeat || event.ctrlKey || event.metaKey || event.altKey) return;
  if (event.key === 's' || event.key === 'S') save();
  if (event.key === 'o' || event.key === 'O') void restore();
});

// 6. Files dropped on the map: the library leaves drops to the page. An image is placed where it
// was dropped, a data file keeps its own positions, and both go into the active layer
const container = map.getContainer();
container.addEventListener('dragover', (event) => event.preventDefault());
container.addEventListener('drop', async (event) => {
  event.preventDefault();
  const rect = container.getBoundingClientRect();
  const { lng, lat } = map.unproject([event.clientX - rect.left, event.clientY - rect.top]);
  for (const file of event.dataTransfer?.files ?? []) {
    try {
      const layerId = draw.layers.getActive()?.id;
      report(
        await draw.document.load(file, { coordinate: [lng, lat], zoom: map.getZoom(), layerId }),
      );
    } catch (error) {
      console.error(`${file.name} was not loaded`, error);
    }
  }
});

// For the browser console and the end-to-end tests
Object.assign(window, { map, draw, ui, loaded });
