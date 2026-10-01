// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// columnar-data-in-a-worker: a GeoParquet file read in a Worker and drawn from its columns.
// The Worker fetches the building footprints of central Tokyo from Overture Maps as GeoParquet
// (examples/public/data/), reads the columns, decodes the geometry into typed arrays in the
// layout of GeoArrow, and prepares them there (the extents, the pieces and the index of the
// clicks). There is no GeoJSON and no object per row: the arrays cross to the page without a
// copy, and a dataset draws the rows from them, colored by the area of each footprint on the
// Dark basemap. The console says how many rows came and how long each step took. A click logs
// the row, read from the same columns.

import { createDraw } from '@sakuzu/maplibre-gl-draw';
import { createDrawUI } from '@sakuzu/maplibre-gl-draw-ui';
import '@sakuzu/maplibre-gl-draw-ui/style.css';
import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import '../maplibre-setup.ts';
import { BASEMAPS, basemapStyle, basemapUrl, initialBasemapId } from '../basemap.ts';
import '../example.css';
import type { Reply, Request } from './worker.ts';

// The Dark basemap, under which the bright colors of the footprints stand out; the basemap row
// of the standard UI names it, and `?basemap=<id>` opens on another
const BASEMAP = 'dark';
const map = new maplibregl.Map({
  container: 'map',
  style: basemapStyle(basemapUrl(BASEMAP)),
  center: [139.778, 35.678],
  zoom: 15,
  attributionControl: {
    customAttribution: '<a href="https://overturemaps.org">Overture Maps Foundation</a>',
  },
});
const draw = createDraw(map);
const locale = new URLSearchParams(location.search).get('locale') === 'ja' ? 'ja' : 'en';
const ui = createDrawUI(draw, { locale, basemaps: BASEMAPS, basemap: initialBasemapId(BASEMAP) });

// 1. The dataset, empty until the Worker hands over its table, colored by the area column (the
// footprint in square metres), from magenta for the small to yellow for the large, all of them
// bright on black, with a dark outline between neighbors
const buildings = draw.datasets.add({
  id: 'buildings',
  styleRule: {
    kind: 'graduated',
    property: 'area',
    breaks: [50, 100, 200, 500],
    colors: ['#cc4778', '#e66c5c', '#f89540', '#fdc328', '#f0f921'],
    other: '#9e9e9e',
  },
  baseStyle: { fill: { fillOpacity: 0.9, strokeColor: '#111111', strokeWidth: 0.5 } },
  interactive: true,
});

// 2. The Worker fetches and reads the file, and prepares the table with `prepareTable` from
// `@sakuzu/maplibre-gl-draw/table`, which imports neither maplibre nor WebGL
const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
const started = performance.now();
/** What the page knows once the rows are drawn: their number and the time of each step (ms) */
type Loaded = { rows: number; times: Reply['times']; firstFrameMs: number };
const loaded = new Promise<Loaded>((resolve) => {
  worker.onmessage = (event: MessageEvent<Reply>) => {
    worker.terminate();
    const { prepared, times } = event.data;
    // 3. The prepared table goes to the dataset as it arrived: nothing is computed again here
    buildings.setTable(prepared);
    // The time from the request to the first frame that draws the rows
    map.once('render', () => {
      const firstFrameMs = performance.now() - started;
      const ms = (value: number): string => `${Math.round(value)} ms`;
      console.info(
        `${prepared.length.toLocaleString('en')} building footprints read from a GeoParquet file`,
        `in a Worker and drawn from its columns: ${ms(times.fetch)} to fetch the file,`,
        `${ms(times.read)} to read the columns, ${ms(times.table)} to build the table,`,
        `${ms(times.prepare)} to prepare it, and ${ms(firstFrameMs)} from the request to the`,
        'first frame that draws them',
      );
      resolve({ rows: prepared.length, times, firstFrameMs });
    });
    map.triggerRepaint();
  };
});
const request: Request = { url: new URL('../data/tokyo-buildings.parquet', location.href).href };
worker.postMessage(request);

// 4. A click gives the row, its properties read from the columns the dataset holds
buildings.on('clicked', ({ row, rowIndex }) => {
  const { name, area, height, floors, class: kind } = row.properties ?? {};
  console.log(
    `row ${rowIndex}: ${name ?? '(no name)'}, ${area ?? 'unknown'} m², height ${height ?? 'unknown'},`,
    `${floors ?? 'unknown'} floors, class ${kind ?? 'unknown'}`,
  );
});

// For the browser console and the end-to-end tests
Object.assign(window, { map, draw, ui, loaded });
