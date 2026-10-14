// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Measurement page of the layers held as rows of columns
 *
 * The same features are drawn either from rows of columns (`mode=table`: Workers build the row
 * groups, each a run of the order, `table-open.ts`; the Store hands out the tables) or as
 * features of the Store, drawn as before
 * (`mode=store`). The rows are drawn in one draw per chunk, or by kind with `drawing=by-kind`.
 * The features are made in the page, or read from a GeoJSON file of `bench/data/`
 * (`data=<file>`, in the order of the file or at random with `shuffle=1`).
 *
 * "Start" runs the measurement: it opens the map, shows the whole of it, stops at zoom 14, then
 * pans and zooms, and reports the time each step of the opening took, the intervals of the
 * animation frames (median, 95th percentile, longest) of every phase, the memory and the GPU
 * memory of the drawing. The run stops when the JS heap goes past the limit, and reports what it
 * measured until then.
 *
 * Once the map is open, "Edit" repeats an edit (`op`, `reps` times, one change per frame) and
 * "Stream" sends changes of others (`remote`, `rate` rows per second for `seconds`; the import
 * of others sends `importN` rows in transactions of `txn` until all are sent), each measured
 * before, during and after (`table-edits.ts`). The large merges and builds of the rows run in a
 * Worker of the page (`worker=0`: on the main thread), and the chunks of the next versions of the
 * row groups are built while the camera moves with `moving=<ms>` (once it is still otherwise).
 *
 * The map has no base map (a background layer only), so nothing is fetched from another origin.
 *
 * For automation the results are also on `window.benchResult`, `window.runTableBench()` runs the
 * measurement, and `window.runTableEdit(op)` and `window.runTableStream(kind, rate)` an edit and
 * a stream (on the map opened by the measurement). The draw instance is `window.benchDraw`.
 */

import { createDraw, type Draw, type Store } from '@sakuzu/maplibre-gl-draw';
import type {
  createTableStore as createPublicTableStore,
  FeatureTablesOptions,
  FeatureTablesWorker,
  RowField,
} from '@sakuzu/maplibre-gl-draw/kasane';
import * as maplibregl from 'maplibre-gl';
import * as tableMemory from '../src/store/table-memory';
import {
  type BenchCandidates,
  type BenchFeature,
  benchFeature,
  bigAreaOf,
  CENTER,
  candidatesOf,
  EDIT_OPS,
  type EditOp,
  extentOf,
  extentOfFeatures,
  featuresOfText,
  parseParams,
  REMOTE_KINDS,
  type RemoteKind,
  stylesOf,
  type TableBenchPageParams,
} from './table-data';
import { type TableDiagnostics, tableDiagnosticsOf } from './table-diagnostics';
import {
  type EditResult,
  type EditTarget,
  type RowsStore,
  runEdit,
  runStream,
} from './table-edits';
import {
  heapMb,
  MB,
  nextFrame,
  type PhaseResult,
  phaseOf,
  recordFrames,
  wait,
} from './table-measure';
import { openRows } from './table-open';
import type { RowsWorkerRequest } from './table-rows-worker';

// Worker URL setup for v6 (side effect). Required before the Map is created.
import './maplibre-setup';

interface TableBenchResult {
  readonly params: TableBenchPageParams;
  /** The time of each step of the opening (ms) */
  readonly open: Record<string, number>;
  readonly phases: PhaseResult[];
  /** The memory of the page measured by the browser after the opening and at the end (MB) */
  readonly memory: { afterOpenMb: number | null; endMb: number | null };
  /** The GPU memory of the drawing at the end, per renderer (MB) */
  readonly gpu: Record<string, number>;
  /** The edits and the streams run on the map opened */
  readonly edits: EditResult[];
  /** Why the run stopped early (absent when it ran to the end) */
  stopped?: string;
}

declare global {
  interface Window {
    benchResult?: TableBenchResult;
    runTableBench: () => Promise<TableBenchResult>;
    runTableEdit: (op?: EditOp) => Promise<EditResult | null>;
    runTableStream: (kind?: RemoteKind, rate?: number) => Promise<EditResult | null>;
    benchMap: maplibregl.Map;
    /** The draw instance */
    benchDraw: Draw;
    /** The hooks of measurement of its rows (`benchTables.editStats()` reads the edits) */
    benchTables: TableDiagnostics;
  }
}

const params = parseParams(location.search);
const LAYER_ID = 'bench';

const statusEl = document.getElementById('status') as HTMLElement;
const resultEl = document.getElementById('result') as HTMLElement;
const startButton = document.getElementById('start') as HTMLButtonElement;
const confirmButton = document.getElementById('confirm') as HTMLButtonElement;
const setStatus = (text: string): void => {
  statusEl.textContent = text;
};

// === The form of the parameters ===

const form = document.getElementById('params') as HTMLFormElement;
for (const [key, value] of Object.entries({
  mode: params.mode,
  drawing: params.drawing,
  n: String(params.n),
  kind: params.kind,
  styles: String(params.styles),
  alpha: params.translucent ? '1' : '0',
  cuts: String(params.cuts),
  limit: String(params.limitMb),
  data: params.data,
  shuffle: params.shuffle ? '1' : '0',
  op: params.op,
  reps: String(params.reps),
  remote: params.remote,
  rate: String(params.rate),
  seconds: String(params.seconds),
  rule: `${params.rule.key}:${params.rule.breaks.join(',')}`,
  importN: String(params.importN),
  txn: String(params.txn),
  groups: String(params.groups),
  members: String(params.members),
  moving: String(params.moving),
  worker: params.worker ? '1' : '0',
  workers: String(params.workers),
  bigArea: String(params.bigArea),
  held: String(params.held),
  moveFrom: params.moveFrom === null ? '' : String(params.moveFrom),
})) {
  const field = form.elements.namedItem(key) as HTMLInputElement | HTMLSelectElement | null;
  if (field) field.value = value;
}

// More than 100,000 features need a confirmation before they are made
const LARGE = 100_000;

/** The GPU memory (MB) the drawing may allocate before a run stops */
const GPU_LIMIT_MB = 800;
if (params.n > LARGE) {
  startButton.disabled = true;
  confirmButton.hidden = false;
  confirmButton.addEventListener('click', () => {
    startButton.disabled = false;
    confirmButton.hidden = true;
  });
}

// === The map and the drawing ===

const map = new maplibregl.Map({
  container: 'map',
  style: {
    version: 8,
    sources: {},
    layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#eef0f4' } }],
  },
  center: CENTER,
  zoom: 12,
  attributionControl: false,
  fadeDuration: 0,
});
window.benchMap = map;

/** The Worker the tables hand their large merges and builds to */
function rowsWorker(): FeatureTablesWorker {
  const worker = new Worker(new URL('./table-rows-worker.ts', import.meta.url), { type: 'module' });
  let next = 0;
  const waiting = new Map<number, (groups: unknown) => void>();
  worker.onmessage = (event: MessageEvent<{ id: number; groups: unknown }>) => {
    waiting.get(event.data.id)?.(event.data.groups);
    waiting.delete(event.data.id);
  };
  const ask = (request: Omit<RowsWorkerRequest, 'id'>): Promise<never> =>
    new Promise((resolve) => {
      const id = next++;
      waiting.set(id, resolve as (groups: unknown) => void);
      worker.postMessage({ id, ...request });
    });
  return {
    merge: (merge) => ask({ merge }),
    build: (rows, options) => ask({ rows, options }),
  };
}

// The rows are held by an in-memory Store of rows: its tables are drawn, its writer adds the
// blocks of rows and writes the changes of others. It is made from the module of the library that
// holds it, with an option the library keeps to itself (the number of rows opened from which they
// move by their state), which the declarations of its build leave out
const createTableStore = (
  tableMemory as unknown as {
    createTableStore(
      options: FeatureTablesOptions & { readonly moveOpenedByStateFrom?: number },
    ): ReturnType<typeof createPublicTableStore>;
  }
).createTableStore;
const ofRows =
  params.mode === 'table'
    ? createTableStore({
        ...(params.worker && { worker: rowsWorker() }),
        ...(params.moveFrom !== null && { moveOpenedByStateFrom: params.moveFrom }),
      })
    : null;
const tablesOfPage =
  ofRows?.store.tables !== undefined
    ? { tables: ofRows.store.tables, writer: ofRows.writer }
    : null;
const store = ofRows?.store;
store?.createLayer({
  id: LAYER_ID,
  name: LAYER_ID,
  visible: true,
  locked: false,
  opacity: 1,
  kind: 'table',
  styleRule: undefined,
  metadata: undefined,
});
const draw: Draw = createDraw(map, {
  defaultMode: 'select',
  autoName: false,
  initDefaultLayer: false,
  ...(store ? { store } : {}),
});
window.benchDraw = draw;
// The hooks of measurement are read from the module of the library that holds them (they are
// not part of its API)
const diagnostics = tableDiagnosticsOf(draw);
window.benchTables = diagnostics;
if (params.drawing === 'by-kind') diagnostics.setDrawingByKind(true);
if (params.moving > 0) diagnostics.setVersionBudgetWhileMoving(params.moving);

// === Measuring ===

/** The memory of the page as the browser measures it (MB; null when it cannot) */
async function measuredMemoryMb(): Promise<number | null> {
  if (!crossOriginIsolated || !performance.measureUserAgentSpecificMemory) return null;
  const measured = performance.measureUserAgentSpecificMemory().then((m) => m.bytes / MB);
  const timeout = wait(30_000).then(() => null);
  return Promise.race([measured, timeout]);
}

/** Whether the heap went past the limit */
function overLimit(): boolean {
  // The GPU memory the drawing allocated is capped as well, so a leak cannot run on unseen
  if (draw.debug.gpu().bytes / MB > GPU_LIMIT_MB) return true;
  const heap = heapMb();
  return heap !== null && heap > params.limitMb;
}

/**
 * Draws frames until the drawing has nothing left to build (or the time runs out)
 *
 * @returns Whether it has nothing left
 */
async function settle(timeoutMs = 120_000): Promise<boolean> {
  const start = performance.now();
  await nextFrame();
  while (draw.hasPendingWork() || !map.loaded()) {
    if (performance.now() - start > timeoutMs) return false;
    map.triggerRepaint();
    await nextFrame();
  }
  return true;
}

/** The longest the drawing of the rows taken in may take before the opening stops (ms) */
const OPEN_DRAW_MS = 60_000;

/** The address of the file the features are read from (null for features made in the page) */
const dataUrl = params.data ? new URL(`./data/${params.data}`, location.href).href : null;

/** What the map opened holds: the extent of its features and the rows the edits change */
let opened: { extent: [number, number, number, number]; candidates: BenchCandidates } | null = null;

/** The features of the page, for the Store (made in the page, or read from the file) */
async function pageFeatures(): Promise<BenchFeature[]> {
  if (dataUrl) {
    const response = await fetch(dataUrl);
    if (!response.ok) throw new Error(`${dataUrl}: ${response.status}`);
    const features = featuresOfText(
      await response.text(),
      /\.(ndjson|geojsonl)$/.test(dataUrl),
      params,
    );
    // The Store draws them in the order of their keys, as the rows are
    return features.sort((a, b) => (a.order < b.order ? -1 : a.order > b.order ? 1 : 0));
  }
  const styles = stylesOf(params);
  const features: BenchFeature[] = [];
  for (let i = 0; i < params.n; i++) features.push(benchFeature(params, styles, i));
  return features;
}

/** Opens the map: the features held as rows or as features of the Store */
async function open(result: TableBenchResult): Promise<void> {
  const t0 = performance.now();
  if (tablesOfPage) {
    const rows = await openRows({
      params,
      dataUrl,
      layerId: LAYER_ID,
      writer: tablesOfPage.writer,
      createWorker: () =>
        new Worker(new URL('./table-worker.ts', import.meta.url), { type: 'module' }),
      cores: navigator.hardwareConcurrency,
      start: t0,
      onProgress: (text) => setStatus(`Opening: ${text}`),
    });
    setStatus('Opening: drawing the rows taken in');
    Object.assign(result.open, rows.open);
    opened = { extent: rows.extent, candidates: rows.candidates };
    if (overLimit()) return;
  } else {
    const g0 = performance.now();
    const made = await pageFeatures();
    const features = made.map((f) => ({
      id: f.id,
      type: f.type,
      geometry: f.geometry,
      layerId: LAYER_ID,
      groupId: undefined,
      properties: f.properties,
      style: f.style,
      locked: false,
      visible: true,
    }));
    result.open.rows = features.length;
    result.open.generate = performance.now() - g0;
    opened = {
      extent: dataUrl ? extentOfFeatures(made) : extentOf(params),
      candidates: candidatesOf(made),
    };
    if (overLimit()) return;
    const l0 = performance.now();
    await draw.document.load({
      version: '3.0.0',
      layers: [
        {
          id: LAYER_ID,
          name: LAYER_ID,
          visible: true,
          locked: false,
          opacity: 1,
          items: features.map((f) => f.id),
          styleRule: undefined,
          metadata: undefined,
        },
      ],
      layerOrder: [LAYER_ID],
      features,
    } as never);
    result.open.load = performance.now() - l0;
  }
  const d0 = performance.now();
  if (!(await settle(OPEN_DRAW_MS))) {
    throw new Error(
      `the drawing still had work after ${OPEN_DRAW_MS / 1000} s ` +
        `(work left: ${draw.hasPendingWork()}, map loaded: ${map.loaded()})`,
    );
  }
  result.open.firstDraw = performance.now() - d0;
  result.open.total = performance.now() - t0;
  if (params.bigArea > 0 && opened) {
    const b0 = performance.now();
    putBigArea(opened.extent);
    await settle();
    result.open.bigArea = performance.now() - b0;
  }
}

/** Puts a large area under every row (the first item of the layer) */
function putBigArea(extent: [number, number, number, number]): void {
  const geometry = bigAreaOf(extent, params.bigArea);
  const style = { fillColor: '#bfd3c1', fillOpacity: 1, strokeColor: '#5b7f63', strokeWidth: 2 };
  if (tablesOfPage) {
    // A key before the keys of the rows (`k...`)
    const encoder = new TextEncoder();
    const bytes = encoder.encode('bigArea');
    const [handle] = tablesOfPage.writer.allocateHandles({
      offsets: Int32Array.of(0, bytes.length),
      bytes,
    });
    tablesOfPage.writer.apply({
      handles: Int32Array.of(handle),
      fields: new Map<RowField, unknown[]>([
        ['type', ['Polygon']],
        ['layerId', [LAYER_ID]],
        ['geometry', [geometry]],
        ['order', ['a']],
        ['style', [style]],
      ]),
    });
    return;
  }
  draw.features.create({
    id: 'bigArea',
    type: 'Polygon',
    geometry,
    layerId: LAYER_ID,
    style,
  } as never);
  draw.features.move('bigArea', { layerId: LAYER_ID, index: 0 });
}

/** Eases the camera and waits for the end of the move */
function ease(options: Parameters<maplibregl.Map['easeTo']>[0]): Promise<void> {
  return new Promise((resolve) => {
    map.once('moveend', () => resolve());
    map.easeTo({ duration: 2500, essential: true, ...options });
  });
}

/** Runs the measurement */
async function runTableBench(): Promise<TableBenchResult> {
  startButton.disabled = true;
  const result: TableBenchResult = {
    params,
    open: {},
    phases: [],
    memory: { afterOpenMb: null, endMb: null },
    gpu: {},
    edits: [],
  };
  window.benchResult = result;
  const finish = (stopped?: string): TableBenchResult => {
    if (stopped) result.stopped = stopped;
    for (const [name, bytes] of Object.entries(diagnostics.gpuBytesByRenderer())) {
      result.gpu[name] = bytes / MB;
    }
    render(result);
    setStatus(stopped ? `Stopped: ${stopped}` : 'Done');
    return result;
  };

  await new Promise<void>((resolve) => {
    if (map.loaded()) resolve();
    else map.once('load', () => resolve());
  });

  setStatus('Opening...');
  // The frames of the opening: the longest one is the longest the page stops while it opens
  let failure: string | null = null;
  const openIntervals = await recordFrames(map, () =>
    open(result).catch((error) => {
      failure = String(error);
    }),
  );
  result.phases.push(phaseOf(draw, 'opening', openIntervals));
  if (failure) return finish(`the opening stopped: ${failure}`);
  render(result);
  if (overLimit())
    return finish(
      `the JS heap went past ${params.limitMb} MB or the GPU memory past ${GPU_LIMIT_MB} MB while opening`,
    );
  result.memory.afterOpenMb = await measuredMemoryMb();
  if (params.mode === 'table' && params.cuts > 0) diagnostics.setArtificialCuts(params.cuts);

  const [west, south, east, north] = opened?.extent ?? extentOf(params);
  const center: [number, number] = opened ? [(west + east) / 2, (south + north) / 2] : CENTER;
  const phases: Array<[string, () => Promise<void>]> = [
    [
      'whole map',
      async () => {
        map.fitBounds(
          [
            [west, south],
            [east, north],
          ],
          { animate: false, padding: 20 },
        );
        await settle();
        await wait(3000);
      },
    ],
    [
      'stopped at z14',
      async () => {
        map.jumpTo({ center, zoom: 14 });
        await settle();
        await wait(3000);
      },
    ],
    [
      'pan and zoom',
      async () => {
        const span = Math.min(east - west, 0.2);
        await ease({ center: [center[0] + span / 2, center[1]] });
        await ease({ center: [center[0] + span / 2, center[1]], zoom: 15 });
        await ease({ center: [center[0] - span / 2, center[1] + span / 4], zoom: 13 });
        await ease({ center, zoom: 14 });
      },
    ],
  ];
  for (const [name, run] of phases) {
    setStatus(`Measuring: ${name}`);
    const intervals = await recordFrames(map, run);
    result.phases.push(phaseOf(draw, name, intervals));
    render(result);
    if (overLimit())
      return finish(
        `the JS heap went past ${params.limitMb} MB or the GPU memory past ${GPU_LIMIT_MB} MB (${name})`,
      );
  }
  result.memory.endMb = await measuredMemoryMb();
  return finish();
}

/** Writes the results into the tables of the page */
function render(result: TableBenchResult): void {
  const fmt = (value: number | null | undefined, digits = 1): string =>
    value === null || value === undefined ? '-' : value.toFixed(digits);
  const rows = (cells: string[][]): string =>
    cells.map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join('')}</tr>`).join('');
  resultEl.innerHTML = `
    <table>
      <tr><th>Opening</th><th>ms</th></tr>
      ${rows(Object.entries(result.open).map(([name, ms]) => [name, fmt(ms)]))}
    </table>
    <table>
      <tr><th>Phase</th><th>frames</th><th>median ms</th><th>p95 ms</th><th>max ms</th><th>heap MB</th><th>GPU MB</th></tr>
      ${rows(
        result.phases.map((phase) => [
          phase.name,
          String(phase.frames),
          fmt(phase.medianMs),
          fmt(phase.p95Ms),
          fmt(phase.maxMs),
          fmt(phase.heapMb),
          fmt(phase.gpuMb),
        ]),
      )}
    </table>
    <table>
      <tr><th>Memory</th><th>MB</th></tr>
      ${rows([
        ['measured after opening', fmt(result.memory.afterOpenMb)],
        ['measured at the end', fmt(result.memory.endMb)],
        ...Object.entries(result.gpu).map(([name, mb]) => [`GPU ${name}`, fmt(mb, 2)]),
      ])}
    </table>
    ${result.stopped ? `<p class="stopped">Stopped: ${result.stopped}</p>` : ''}
    ${renderEdits(result.edits)}
  `;
}

/** The table of the edits and the streams run: the frames before, during and after each */
function renderEdits(edits: readonly EditResult[]): string {
  if (edits.length === 0) return '';
  const fmt = (value: number | null, digits = 1): string =>
    value === null ? '-' : value.toFixed(digits);
  const cells = edits.flatMap((edit) => {
    const a = edit.statsBefore;
    const b = edit.statsAfter;
    const sum = (phase: PhaseResult): number | null =>
      phase.heapMb === null ? null : phase.heapMb + phase.gpuMb;
    const phases = [edit.before, edit.during, edit.after].map((phase, k) => [
      k === 0 ? edit.name : '',
      ['before', 'during', 'after'][k],
      fmt(phase.medianMs),
      fmt(phase.p95Ms),
      fmt(phase.maxMs),
      fmt(phase.heapMb),
      fmt(phase.gpuMb, 2),
      fmt(sum(phase)),
    ]);
    const facts = [
      `changes ${edit.changes}`,
      `styles ${a.styles} → ${b.styles}`,
      `resolved ${a.resolvedStyles} → ${b.resolvedStyles}`,
      `overrides ${fmt(a.overrideBytes / 1024)} → ${fmt(b.overrideBytes / 1024)} KB`,
      `uploaded ${fmt((b.uploadedBytes - a.uploadedBytes) / 1024)} KB`,
      `in place ${b.inPlace - a.inPlace} (coords ${b.coordsOnly - a.coordsOnly}, style ${
        b.styleOnly - a.styleOnly
      })`,
      `past their places ${b.rebuilt - a.rebuilt}`,
      `restarted ${b.restarted - a.restarted}`,
      `classified otherwise ${b.reclassified - a.reclassified}`,
      `delta rows ${a.deltaRows} → ${b.deltaRows}`,
      `cuts (last frame) ${b.cuts}`,
      `versions swapped ${b.versionsSwapped - a.versionsSwapped} (most held ${b.versionsMostPending}, last merge ${fmt(b.lastMergeMs, 2)} ms)`,
      `peak heap ${fmt(edit.peakHeapMb)} MB`,
      edit.inputMs
        ? `input ${fmt(edit.inputMs.mean, 2)} ms (max ${fmt(edit.inputMs.max, 2)}, ${edit.inputMs.count} inputs)`
        : '',
      ...(edit.notes ?? []),
      `CPU of the rows per frame ${fmt(edit.frameCpuMs.mean, 2)} ms (max ${fmt(edit.frameCpuMs.max, 2)})`,
      edit.error ? `error: ${edit.error}` : '',
    ].filter((fact) => fact !== '');
    return [...phases, ['', facts.join(' / '), '', '', '', '', '', '']];
  });
  return `
    <table>
      <tr><th>Edit</th><th>phase</th><th>median ms</th><th>p95 ms</th><th>max ms</th><th>heap MB</th><th>GPU MB</th><th>heap + GPU MB</th></tr>
      ${cells.map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join('')}</tr>`).join('')}
    </table>
  `;
}

/** What the edits write to (null before the map is opened) */
function editTarget(): EditTarget | null {
  if (!opened) return null;
  return {
    mode: params.mode,
    draw,
    map,
    layerId: LAYER_ID,
    tables: tablesOfPage?.tables ?? null,
    writer: tablesOfPage?.writer ?? null,
    // The Store the instance writes (`getStore` gives the Store itself, typed as its view)
    store: draw.getStore() as unknown as Store,
    rowsStore: (store as unknown as RowsStore | undefined) ?? null,
    candidates: opened.candidates,
  };
}

/** Runs an edit (or a stream) on the map opened, and adds its result to the results */
async function runEditOf(
  name: string,
  run: (target: EditTarget) => Promise<EditResult>,
): Promise<EditResult | null> {
  const target = editTarget();
  const result = window.benchResult;
  if (!target || !result) {
    setStatus('Open the map first (Start)');
    return null;
  }
  editButton.disabled = true;
  streamButton.disabled = true;
  setStatus(`Measuring: ${name}`);
  try {
    const edit = await run(target);
    result.edits.push(edit);
    render(result);
    setStatus(edit.error ? `Not run: ${edit.error}` : 'Done');
    return edit;
  } finally {
    editButton.disabled = false;
    streamButton.disabled = false;
  }
}

const editButton = document.getElementById('edit') as HTMLButtonElement;
const streamButton = document.getElementById('stream') as HTMLButtonElement;

window.runTableEdit = (op = params.op) =>
  runEditOf(op, (target) => runEdit(target, EDIT_OPS.includes(op) ? op : params.op, params));
window.runTableStream = (kind = params.remote, rate = params.rate) =>
  runEditOf(`stream ${kind}`, (target) =>
    runStream(target, REMOTE_KINDS.includes(kind) ? kind : params.remote, { ...params, rate }),
  );
editButton.addEventListener('click', () => {
  void window.runTableEdit();
});
streamButton.addEventListener('click', () => {
  void window.runTableStream();
});

window.runTableBench = runTableBench;
startButton.addEventListener('click', () => {
  void runTableBench();
});
setStatus(
  `${params.mode} n=${params.n} kind=${params.kind} styles=${params.styles} ` +
    `alpha=${params.translucent ? 1 : 0} cuts=${params.cuts} limit=${params.limitMb}MB ` +
    `isolated=${crossOriginIsolated}`,
);
