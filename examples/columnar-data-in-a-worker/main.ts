// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// columnar-data-in-a-worker: a GeoParquet file read in a Worker and drawn from its columns.
// The Worker fetches the buildings of central Tokyo from Overture Maps as GeoParquet
// (examples/public/data/), reads the columns, decodes the geometry into typed arrays in the
// layout of GeoArrow, and prepares them there (the extents, the pieces and the index of the
// clicks). There is no GeoJSON and no object per row: the arrays cross to the page without a
// copy, and a dataset draws the rows from them. A click logs the row, read from the same columns.

import { createDraw } from '@sakuzu/maplibre-gl-draw';
import { createDrawUI } from '@sakuzu/maplibre-gl-draw-ui';
import '@sakuzu/maplibre-gl-draw-ui/style.css';
import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import '../maplibre-setup.ts';
import { basemapStyle } from '../basemap.ts';
import '../example.css';
import type { Reply, Request } from './worker.ts';

const map = new maplibregl.Map({
  container: 'map',
  style: basemapStyle(),
  center: [139.778, 35.678],
  zoom: 15,
  attributionControl: {
    customAttribution: '<a href="https://overturemaps.org">Overture Maps Foundation</a>',
  },
});
const draw = createDraw(map);
const locale = new URLSearchParams(location.search).get('locale') === 'ja' ? 'ja' : 'en';
const ui = createDrawUI(draw, { locale });

// 1. The dataset, empty until the Worker hands over its table, colored by the height column
const buildings = draw.datasets.add({
  id: 'buildings',
  styleRule: {
    kind: 'graduated',
    property: 'height',
    breaks: [10, 20, 40, 80],
    colors: ['#fff5eb', '#fdbe85', '#fd8d3c', '#d94701', '#8c2d04'],
    other: '#d9d9d9',
  },
  baseStyle: { fill: { fillOpacity: 0.85, strokeColor: '#ffffff', strokeWidth: 0.5 } },
  interactive: true,
});

// 2. The Worker fetches and reads the file, and prepares the table with `prepareTable` from
// `@sakuzu/maplibre-gl-draw/table`, which imports neither maplibre nor WebGL
const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
const started = performance.now();
const loaded = new Promise<{ rows: number; firstFrameMs: number }>((resolve) => {
  worker.onmessage = (event: MessageEvent<Reply>) => {
    worker.terminate();
    const { prepared, times } = event.data;
    // 3. The prepared table goes to the dataset as it arrived: nothing is computed again here
    buildings.setTable(prepared);
    // The time from the request to the first frame that draws the rows
    map.once('render', () => {
      const firstFrameMs = performance.now() - started;
      const ms = (value: number): string => `${Math.round(value)} ms`;
      console.log(
        `${prepared.length.toLocaleString()} buildings: ${ms(times.fetch)} to fetch,`,
        `${ms(times.read)} to read the columns, ${ms(times.table)} to build the table,`,
        `${ms(times.prepare)} to prepare it, ${ms(firstFrameMs)} from the request to the first frame`,
      );
      resolve({ rows: prepared.length, firstFrameMs });
    });
    map.triggerRepaint();
  };
});
const request: Request = { url: new URL('../data/tokyo-buildings.parquet', location.href).href };
worker.postMessage(request);

// 4. A click gives the row, its properties read from the columns the dataset holds
buildings.on('clicked', ({ row, rowIndex }) => {
  const { name, height, floors, class: kind } = row.properties ?? {};
  console.log(
    `row ${rowIndex}: ${name ?? '(no name)'}, height ${height ?? 'unknown'},`,
    `${floors ?? 'unknown'} floors, class ${kind ?? 'unknown'}`,
  );
});

// For the browser console and the end-to-end tests
Object.assign(window, { map, draw, ui, loaded });
