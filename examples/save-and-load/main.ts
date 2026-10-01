// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// save-and-load: getting the drawing out and back in.
// The page opens with a GeoJSON file, which adds its features and reports the one it left out.
// The buttons in the card of actions at the bottom left, each with a key: Save (S) keeps the whole
// document in the browser, in the format of the library; Load (O) loads the saved document back in
// place of the drawing; Download (D) and Download GeoJSON (G) download the drawing in the format
// of the library and as GeoJSON; Open a file (B) opens a file from the disk. A file dropped on the
// map is loaded there. The next visit opens with what was saved.

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
    console.log('Nothing has been saved yet: press Save (S)');
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

// 7. The buttons in the card of actions of the standard UI, each with its key (listed with ?, and
// left alone while a field of the panels has the keyboard)
const ja = locale === 'ja';
ui.actions.add({
  id: 'save',
  label: ja ? '保存' : 'Save',
  kind: 'action',
  shortcut: 'S',
  run: save,
});
ui.actions.add({
  id: 'load',
  label: ja ? '読み込む' : 'Load',
  kind: 'action',
  shortcut: 'O',
  run: () => void restore(),
});
ui.actions.add({
  id: 'download',
  label: ja ? 'ダウンロード' : 'Download',
  kind: 'action',
  shortcut: 'D',
  run: () => download('native'),
});
ui.actions.add({
  id: 'download-geojson',
  label: ja ? 'GeoJSON でダウンロード' : 'Download GeoJSON',
  kind: 'action',
  shortcut: 'G',
  run: () => download('geojson'),
});
ui.actions.add({
  id: 'open',
  label: ja ? 'ファイルを開く' : 'Open a file',
  kind: 'action',
  shortcut: 'B',
  run: openFile,
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
