// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// save-and-load: getting the drawing out and back in.
// The page opens with a GeoJSON file, imported into the drawing, and reports the feature it left
// out. The buttons in the card of actions at the bottom left, each with a key: Save (S) keeps the
// whole document in the browser, in the format of the library; Load (O) opens the saved document
// in place of the drawing; Download (D) and Download GeoJSON (G) download the drawing in the format
// of the library and as GeoJSON; Open a file (B) imports a file from the disk. A file dropped on
// the map is imported there. The next visit opens with what was saved.

import { createDraw, type SkippedFeature } from '@sakuzu/maplibre-gl-draw';
import { createDrawUI } from '@sakuzu/maplibre-gl-draw-ui';
import '@sakuzu/maplibre-gl-draw-ui/style.css';
import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import '../maplibre-setup.ts';
import { BASEMAPS, basemapStyle, initialBasemapId } from '../basemap.ts';
import '../example.css';
import { SAMPLE } from './data.ts';
import { imageFeature, isImageFile } from './image-feature.ts';

const map = new maplibregl.Map({
  container: 'map',
  style: basemapStyle(),
  center: [139.7735, 35.678],
  zoom: 14.3,
});
const draw = createDraw(map);
const locale = new URLSearchParams(location.search).get('locale') === 'ja' ? 'ja' : 'en';
const ui = createDrawUI(draw, { locale, basemaps: BASEMAPS, basemap: initialBasemapId() });

// 1. What was read: the features, and those left out with the error that left each out
function report(
  what: string,
  result: { readonly skipped: readonly SkippedFeature[] },
  count: number,
): void {
  console.log(`${what} ${count} features`);
  for (const { index, error } of result.skipped) {
    console.warn(`Left out feature ${index}: ${error.message}`);
  }
}

// 2. Open the document saved on the last visit in place of the drawing, or else import the
// GeoJSON file, whose features are added to the drawing. Both take an object, a JSON string or a
// File
const STORAGE_KEY = 'maplibre-gl-draw:save-and-load';
const saved = localStorage.getItem(STORAGE_KEY);
const loaded =
  saved !== null
    ? draw.open(saved).then((result) => report('Opened', result, result.features))
    : draw
        .write((tx) => tx.import(SAMPLE))
        .then((result) => report('Imported', result, result.count));

// 3. The format of the library keeps the whole document: the layers, the groups, their order and
// the styles. GeoJSON keeps the features alone, for other tools; here it goes to the console
function save(): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(draw.document.toJSON()));
  console.log(`Saved ${draw.features.count()} features`, draw.document.toGeoJSON());
}

// 4. `draw.open` replaces the drawing with the document; the steps of undo are dropped
async function restore(): Promise<void> {
  const text = localStorage.getItem(STORAGE_KEY);
  if (text === null) {
    console.log('Nothing has been saved yet: press Save (S)');
    return;
  }
  const result = await draw.open(text);
  report('Opened', result, result.features);
}

// 5. A file of the drawing, offered as a download: the page makes a Blob of the text and clicks
// a link to it that names the file. The format of the library keeps the whole document, and
// GeoJSON the features alone, for other tools
function download(format: 'native' | 'geojson'): void {
  const title = draw.document.title.trim() || 'drawing';
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
// and the file goes where a dropped one would go, its image at the center of the view. A data
// file (GeoJSON or the format of the library) is imported into the active layer, its features
// added to the drawing; an image is imported as a feature of the type Image (image-feature.ts)
async function loadFile(file: File, coordinate: [number, number]): Promise<void> {
  try {
    const source = isImageFile(file)
      ? {
          type: 'FeatureCollection' as const,
          features: [await imageFeature(file, coordinate, map.getZoom())],
        }
      : file;
    const layer = draw.layers.getActive()?.id;
    const result = await draw.write((tx) =>
      tx.import(source, layer === undefined ? {} : { layer }),
    );
    report(`Imported ${file.name}:`, result, result.count);
  } catch (error) {
    console.error(`${file.name} was not imported`, error);
  }
}

function openFile(): void {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json,.geojson,image/png,image/jpeg,image/webp,image/gif';
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

// 8. Files dropped on the map: the library leaves drops to the page. An image is imported where
// it was dropped, a data file keeps its own positions, and both go into the active layer
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
