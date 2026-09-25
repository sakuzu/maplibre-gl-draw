// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// save-load: getting the drawing out and back in.
// It loads a GeoJSON file, reports the features a load skipped, saves the native format in
// localStorage and restores it, offers both formats as downloads, and loads files dropped on
// the map where they were dropped.

import { createMapLibreGLDraw, type ExportFormat, type LoadResult } from '@sakuzu/maplibre-gl-draw';
import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import '../maplibre-setup.ts';
import { basemapStyle } from '../basemap.ts';
import '../example.css';

const map = new maplibregl.Map({
  container: 'map',
  style: basemapStyle(),
  center: [139.7515, 35.6875],
  zoom: 13.2,
});
const draw = createMapLibreGLDraw(map);

const output = document.getElementById('output') as HTMLPreElement;
const STORAGE_KEY = 'maplibre-gl-draw:save-load';

/** Shows what a load did, including the features it left out */
function report(result: LoadResult): void {
  const lines = [`Loaded ${result.featureIds.length} features (${result.format})`];
  if (result.replaced) lines.push('The previous drawing was replaced');
  for (const { index, reason } of result.skipped ?? []) {
    lines.push(`Skipped feature ${index}: ${reason}`);
  }
  output.textContent = lines.join('\n');
}

// A GeoJSON FeatureCollection is added to what is already drawn
document.getElementById('load-sample')?.addEventListener('click', async () => {
  const response = await fetch('../sample-gis.geojson');
  report(await draw.load(await response.json()));
});

// A File is detected by its content: GeoJSON, the native format or an image
document.getElementById('file')?.addEventListener('change', async (event) => {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  try {
    report(await draw.load(file));
  } catch (error) {
    output.textContent = `The file could not be loaded: ${String(error)}`;
  }
  input.value = '';
});

// Files dropped on the map. The library leaves drops to the page, so the page listens on the
// map's container, turns the position into a coordinate and loads each file there: an image is
// centered where it was dropped, and a data file keeps its own positions.
const container = map.getContainer();
container.addEventListener('dragover', (event) => event.preventDefault());
container.addEventListener('drop', async (event) => {
  event.preventDefault();
  const rect = container.getBoundingClientRect();
  const { lng, lat } = map.unproject([event.clientX - rect.left, event.clientY - rect.top]);
  for (const file of event.dataTransfer?.files ?? []) {
    try {
      report(
        await draw.load(file, {
          coordinate: [lng, lat],
          zoom: map.getZoom(),
          layerId: draw.getActiveLayer(),
        }),
      );
    } catch (error) {
      output.textContent = `${file.name} could not be loaded: ${String(error)}`;
    }
  }
});

// The native format keeps the layers, the groups and their order; loading it replaces the
// current drawing
document.getElementById('save')?.addEventListener('click', () => {
  localStorage.setItem(STORAGE_KEY, draw.export('native').data);
  output.textContent = `Saved ${draw.getAllFeatures().length} features`;
});

document.getElementById('restore')?.addEventListener('click', async () => {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved === null) {
    output.textContent = 'Nothing has been saved yet';
    return;
  }
  report(await draw.load(JSON.parse(saved)));
});

/**
 * Offers an export as a download. `result.fileName` is the name the library suggests: the
 * title of the drawing and the time, with `.geojson` or `.maplibre-gl-draw.json`
 * (`draw.getSuggestedFileName()` gives the native one without exporting)
 */
function download(format: ExportFormat): void {
  const result = draw.export(format);
  const url = URL.createObjectURL(new Blob([result.data], { type: result.mimeType }));
  const link = document.createElement('a');
  link.href = url;
  link.download = result.fileName;
  link.click();
  URL.revokeObjectURL(url);
  output.textContent = `Downloaded ${result.fileName}`;
}

document.getElementById('download-native')?.addEventListener('click', () => download('native'));
document.getElementById('download-geojson')?.addEventListener('click', () => download('geojson'));

// For the browser console and the end-to-end tests
Object.assign(window, { map, draw });
