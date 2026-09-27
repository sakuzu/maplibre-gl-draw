// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// table-worker: a large table read in a Worker and drawn from its columns.
// The Worker builds the rows as typed arrays in the layout of GeoArrow and prepares them
// (the bboxes, the chunks and the spatial index of the hit testing), then sends them without a
// copy. The page hands them to a dataset, which draws the rows from the arrays
// without building an object per row. A click reports the row, read from the same columns.

import { createDraw } from '@sakuzu/maplibre-gl-draw';
import type { DictionaryColumn, PreparedTable, Table } from '@sakuzu/maplibre-gl-draw/table';
import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import '../maplibre-setup.ts';
import { basemapStyle } from '../basemap.ts';
import '../example.css';

const CENTER: [number, number] = [139.767, 35.681];
const map = new maplibregl.Map({
  container: 'map',
  style: basemapStyle(),
  center: CENTER,
  zoom: 11,
});
const draw = createDraw(map);
const output = document.getElementById('output') as HTMLPreElement;

// Empty until the Worker hands over its table
const places = draw.datasets.add({
  id: 'places',
  rows: [],
  styleRule: {
    kind: 'categorical',
    property: 'kind',
    map: { shop: '#e15759', school: '#59a14f', station: '#4e79a7', park: '#76b7b2' },
    other: '#cccccc',
  },
  baseStyle: { point: { pointRadius: 3 } },
  interactive: true,
});

/** The table the dataset holds (the page reads its columns too) */
let table: Table | null = null;

/** Reads `count` points in the Worker and shows them */
function load(count: number): Promise<void> {
  output.textContent = `Reading ${count.toLocaleString()} points in a Worker...`;
  const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  const started = performance.now();
  return new Promise((resolve) => {
    worker.onmessage = (event: MessageEvent<{ prepared: PreparedTable; workerMs: number }>) => {
      worker.terminate();
      const { prepared, workerMs } = event.data;
      const handedOver = performance.now();
      places.setTable(prepared);
      table = prepared.table;
      const setMs = performance.now() - handedOver;
      output.textContent =
        `${count.toLocaleString()} points: ${Math.round(workerMs)} ms in the Worker, ` +
        `${Math.round(handedOver - started)} ms until they arrived, ` +
        `${Math.round(setMs)} ms in setTable`;
      resolve();
    };
    worker.postMessage({ count, center: CENTER });
  });
}

// A click reports the row; the page reads the values from its own columns
places.on('clicked', ({ rowIndex }) => {
  if (!table?.columns) return;
  const kind = table.columns.kind as DictionaryColumn;
  const value = table.columns.value as Float64Array;
  output.textContent = `row ${rowIndex}: ${kind.dictionary[kind.codes[rowIndex]]}, value ${value[rowIndex]}`;
});

document.getElementById('load-200k')?.addEventListener('click', () => load(200_000));
document.getElementById('load-1m')?.addEventListener('click', () => load(1_000_000));

const loaded = load(200_000);

// For the browser console and the end-to-end tests
Object.assign(window, { map, draw, loaded });
