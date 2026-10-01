// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// columnar-data-in-a-worker: a large table read in a Worker and drawn from its columns.
// The Worker builds 200,000 rows as typed arrays in the layout of GeoArrow, as a reader of
// GeoParquet or Arrow hands them over, and prepares them there (the extents, the pieces and the
// index of the clicks). It sends them without a copy, and a dataset draws the rows from the
// arrays without making an object per row. A click logs the row, read from the same columns.

import { createDraw } from '@sakuzu/maplibre-gl-draw';
import { createDrawUI } from '@sakuzu/maplibre-gl-draw-ui';
import '@sakuzu/maplibre-gl-draw-ui/style.css';
import type { DictionaryColumn, PreparedTable } from '@sakuzu/maplibre-gl-draw/table';
import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import '../maplibre-setup.ts';
import { BASEMAPS, basemapStyle, initialBasemapId } from '../basemap.ts';
import '../example.css';
import { CENTER, COUNT } from './data.ts';

const map = new maplibregl.Map({
  container: 'map',
  style: basemapStyle(),
  center: CENTER,
  zoom: 11,
});
const draw = createDraw(map);
const locale = new URLSearchParams(location.search).get('locale') === 'ja' ? 'ja' : 'en';
const ui = createDrawUI(draw, { locale, basemaps: BASEMAPS, basemap: initialBasemapId() });

// 1. The dataset, empty until the Worker hands over its table, colored by a column
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

// 2. The Worker reads the table (here it makes one) and prepares it with `prepareTable` from
// `@sakuzu/maplibre-gl-draw/table`, which imports neither maplibre nor WebGL
const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
const started = performance.now();
const loaded = new Promise<PreparedTable>((resolve) => {
  worker.onmessage = (event: MessageEvent<{ prepared: PreparedTable; workerMs: number }>) => {
    worker.terminate();
    const { prepared, workerMs } = event.data;
    // 3. The prepared table goes to the dataset as it arrived: nothing is computed again here
    const arrived = performance.now();
    places.setTable(prepared);
    console.log(
      `${prepared.length.toLocaleString()} rows: ${Math.round(workerMs)} ms in the Worker,`,
      `${Math.round(arrived - started)} ms until they arrived,`,
      `${Math.round(performance.now() - arrived)} ms in setTable`,
    );
    resolve(prepared);
  };
});
worker.postMessage({ count: COUNT, center: CENTER });

// 4. A click gives the index of the row; the page reads its values from the columns it holds
places.on('clicked', async ({ rowIndex }) => {
  const { columns } = (await loaded).table;
  const kind = columns?.kind as DictionaryColumn;
  const value = columns?.value as Float64Array;
  console.log(
    `row ${rowIndex}: ${kind.dictionary[kind.codes[rowIndex]]}, value ${value[rowIndex]}`,
  );
});

// For the browser console and the end-to-end tests
Object.assign(window, { map, draw, ui, loaded });
