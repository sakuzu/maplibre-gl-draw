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
// The same path carries a million rows: the M key asks the Worker for 1,000,000 points, which
// it makes straight into the typed arrays of a table, prepares and sends without a copy, and a
// second dataset draws them, colored by kind; the console says how long each step took. M again
// removes them. This is the path for the readers of Arrow and GeoParquet: columns, no objects.

import { createDraw, type Dataset } from '@sakuzu/maplibre-gl-draw';
import { transferList } from '@sakuzu/maplibre-gl-draw/table';
import { createDrawUI } from '@sakuzu/maplibre-gl-draw-ui';
import '@sakuzu/maplibre-gl-draw-ui/style.css';
import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import '../maplibre-setup.ts';
import { BASEMAPS, basemapStyle, basemapUrl, initialBasemapId } from '../basemap.ts';
import '../example.css';
import { KINDS, MILLION } from './data.ts';
import type { BuildingsReply, MillionReply, Reply, Request } from './worker.ts';

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
// `@sakuzu/maplibre-gl-draw/table`, which imports neither maplibre nor WebGL. It stays to make
// the million points on request
const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
/** The page waiting for an answer of the Worker, by the kind of request */
const waiting: { [K in Reply['kind']]?: (reply: Extract<Reply, { kind: K }>) => void } = {};
worker.onmessage = (event: MessageEvent<Reply>) => {
  const reply = event.data;
  if (reply.kind === 'buildings') waiting.buildings?.(reply);
  else waiting.million?.(reply);
};
function ask(request: Extract<Request, { kind: 'buildings' }>): Promise<BuildingsReply>;
function ask(request: Extract<Request, { kind: 'million' }>): Promise<MillionReply>;
function ask(request: Request): Promise<Reply> {
  return new Promise((resolve) => {
    waiting[request.kind] = resolve as (reply: Reply) => void;
    worker.postMessage(request);
  });
}

/** A time in whole milliseconds, for the console */
const ms = (value: number): string => `${Math.round(value).toLocaleString('en')} ms`;

/** Resolves with the time of the next frame drawn */
function nextFrame(): Promise<number> {
  return new Promise((resolve) => {
    map.once('render', () => resolve(performance.now()));
    map.triggerRepaint();
  });
}

const started = performance.now();
/** What the page knows once the rows are drawn: their number and the time of each step (ms) */
type Loaded = { rows: number; times: BuildingsReply['times']; firstFrameMs: number };
const loaded: Promise<Loaded> = ask({
  kind: 'buildings',
  url: new URL('../data/tokyo-buildings.parquet', location.href).href,
}).then(async ({ prepared, times }) => {
  // 3. The prepared table goes to the dataset as it arrived: nothing is computed again here
  buildings.setTable(prepared);
  // The time from the request to the first frame that draws the rows
  const firstFrameMs = (await nextFrame()) - started;
  console.info(
    `${prepared.length.toLocaleString('en')} building footprints read from a GeoParquet file`,
    `in a Worker and drawn from its columns: ${ms(times.fetch)} to fetch the file,`,
    `${ms(times.read)} to read the columns, ${ms(times.table)} to build the table,`,
    `${ms(times.prepare)} to prepare it, and ${ms(firstFrameMs)} from the request to the`,
    'first frame that draws them',
  );
  return { rows: prepared.length, times, firstFrameMs };
});

// 4. A click gives the row, its properties read from the columns the dataset holds
buildings.on('clicked', ({ row, rowIndex }) => {
  const { name, area, height, floors, class: kind } = row.properties ?? {};
  console.log(
    `row ${rowIndex}: ${name ?? '(no name)'}, ${area ?? 'unknown'} m², height ${height ?? 'unknown'},`,
    `${floors ?? 'unknown'} floors, class ${kind ?? 'unknown'}`,
  );
});

// 5. The M key asks the Worker for 1,000,000 points over the wider Tokyo area. The Worker
// makes them straight into typed arrays in the layout of GeoArrow (data.ts), prepares them and
// moves them to the page without a copy, and a second dataset draws them, colored by the `kind`
// column, in front of the buildings. The console says how long each step took, how large the
// arrays are, and how large the heap of JavaScript is where the browser tells it: the rows add
// no object to it. M again removes the dataset. The keys typed into a field are left alone
type Memory = { usedJSHeapSize: number };
const heapMb = (): number | null => {
  const memory = (performance as Performance & { memory?: Memory }).memory;
  return memory ? memory.usedJSHeapSize / 2 ** 20 : null;
};
let million: Dataset | null = null;
let busy = false;
async function toggleMillion(): Promise<void> {
  if (busy) return;
  if (million) {
    draw.datasets.remove(million.id);
    million = null;
    console.info('million: removed');
    return;
  }
  busy = true;
  const heapBefore = heapMb();
  const { prepared, times, sentAt } = await ask({ kind: 'million', count: MILLION.count });
  const transfer = performance.timeOrigin + performance.now() - sentAt;
  const given = performance.now();
  million = draw.datasets.add({
    id: 'million',
    table: prepared,
    styleRule: {
      kind: 'categorical',
      property: 'kind',
      map: Object.fromEntries(
        KINDS.map((kind, i) => [kind, ['#22d3ee', '#4ade80', '#a78bfa', '#f8fafc'][i]]),
      ),
      other: '#9e9e9e',
    },
    baseStyle: { point: { pointRadius: 2, pointStrokeWidth: 0 } },
    order: 'above-store',
    interactive: true,
  });
  million.on('clicked', ({ row, rowIndex }) => {
    const { kind, minutes } = row.properties ?? {};
    console.log(`million row ${rowIndex}: ${kind}, ${minutes} minutes`);
  });
  const firstFrame = (await nextFrame()) - given;
  const heapAfter = heapMb();
  // The size of the typed arrays, which lie outside the heap of JavaScript
  const arrays =
    transferList(prepared).reduce((sum, buffer) => sum + buffer.byteLength, 0) / 2 ** 20;
  const heap =
    heapBefore !== null && heapAfter !== null
      ? ` (JavaScript heap ${Math.round(heapBefore)} MB before, ${Math.round(heapAfter)} MB after)`
      : '';
  console.info(
    `${prepared.length.toLocaleString('en')} points made in a Worker as typed arrays:`,
    `${ms(times.build)} to build the table, ${ms(times.prepare)} to prepare it,`,
    `${ms(transfer)} to transfer it without a copy, and ${ms(firstFrame)} from handing it to`,
    `the dataset to the first frame that draws them; the arrays hold ${Math.round(arrays)} MB${heap}`,
  );
  busy = false;
}
console.info('Keys: M loads 1,000,000 points from the Worker, and removes them');
window.addEventListener('keydown', (event) => {
  const { target } = event;
  if (
    event.key.toLowerCase() !== 'm' ||
    event.metaKey ||
    event.ctrlKey ||
    event.altKey ||
    (target instanceof Element && target.closest('input, textarea, [contenteditable]'))
  ) {
    return;
  }
  toggleMillion();
});

// For the browser console and the end-to-end tests
Object.assign(window, { map, draw, ui, loaded });
