// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// save-and-load: getting the drawing out and back in.
// The page opens with a GeoJSON file, which adds its features and reports the one it left out.
// S saves the whole document in the browser, in the format of the library; O loads the saved
// document back in place of the drawing; D and G download the drawing in the format of the
// library and as GeoJSON; B opens a file from the disk; and a file dropped on the map is loaded
// there. The next visit opens with what was saved.

import { createDraw, type LoadResult } from '@sakuzu/maplibre-gl-draw';
import { createDrawUI } from '@sakuzu/maplibre-gl-draw-ui';
import '@sakuzu/maplibre-gl-draw-ui/style.css';
import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import '../maplibre-setup.ts';
import { BASEMAPS, basemapStyle, initialBasemapId } from '../basemap.ts';
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
const ui = createDrawUI(draw, { locale, basemaps: BASEMAPS, basemap: initialBasemapId() });

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

// 5. A file of the drawing, offered as a download: the page makes a Blob of the text and clicks
// a link to it that names the file. The format of the library keeps the whole document, and
// GeoJSON the features alone, for other tools
function download(format: 'native' | 'geojson'): void {
  const title = draw.metadata.get().title?.trim() || 'drawing';
  const [data, extension, type] =
    format === 'native'
      ? [draw.document.toJSON(), '.maplibre-gl-draw.json', 'application/json']
      : [draw.document.toGeoJSON(), '.geojson', 'application/geo+json'];
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([JSON.stringify(data)], { type }));
  link.download = `${title.replace(/[\\/:*?"<>|]/g, '_')}${extension}`;
  link.click();
  URL.revokeObjectURL(link.href);
  console.info(`Downloaded ${link.download}`);
}

// 6. A file from the disk, through an input made for the moment: the browser opens its chooser,
// and the file goes where a dropped one would go, its image at the center of the view
async function loadFile(file: File, coordinate: [number, number]): Promise<void> {
  try {
    const layerId = draw.layers.getActive()?.id;
    report(await draw.document.load(file, { coordinate, zoom: map.getZoom(), layerId }));
  } catch (error) {
    console.error(`${file.name} was not loaded`, error);
  }
}

function openFile(): void {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json,.geojson,image/*';
  input.addEventListener('change', () => {
    const file = input.files?.[0];
    if (file === undefined) return;
    const { lng, lat } = map.getCenter();
    void loadFile(file, [lng, lat]);
  });
  input.click();
  console.info('Opening a file');
}

// 7. The keys of the page, listed in the console as it opens. A key typed into a field of the
// panels is left alone, and so is one held with a modifier
const KEYS: Record<string, { label: string; run: () => void }> = {
  s: { label: 'Save the drawing in this browser', run: save },
  o: { label: 'Load the drawing saved in this browser', run: () => void restore() },
  d: { label: 'Download the drawing in the format of the library', run: () => download('native') },
  g: { label: 'Download the drawing as GeoJSON', run: () => download('geojson') },
  b: { label: 'Open a file from the disk', run: openFile },
};
console.info(
  [
    'The keys of this page:',
    ...Object.entries(KEYS).map(([k, { label }]) => `  ${k.toUpperCase()}  ${label}`),
  ].join('\n'),
);
window.addEventListener('keydown', (event) => {
  const typing =
    event.target instanceof Element &&
    event.target.closest('input, textarea, select, [contenteditable]') !== null;
  if (typing || event.repeat || event.ctrlKey || event.metaKey || event.altKey) return;
  KEYS[event.key.toLowerCase()]?.run();
});

// 8. Files dropped on the map: the library leaves drops to the page. An image is placed where it
// was dropped, a data file keeps its own positions, and both go into the active layer
const container = map.getContainer();
container.addEventListener('dragover', (event) => event.preventDefault());
container.addEventListener('drop', async (event) => {
  event.preventDefault();
  const rect = container.getBoundingClientRect();
  const { lng, lat } = map.unproject([event.clientX - rect.left, event.clientY - rect.top]);
  for (const file of event.dataTransfer?.files ?? []) await loadFile(file, [lng, lat]);
});

// For the browser console and the end-to-end tests
Object.assign(window, { map, draw, ui, loaded });
