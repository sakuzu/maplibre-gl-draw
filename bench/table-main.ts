// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Measurement page of the layers held as rows of columns
 *
 * The same features are drawn either from rows of columns (`mode=table`: a Worker builds the
 * row groups, the Store hands out the tables) or as features of the Store, drawn as before
 * (`mode=store`). "Start" runs the measurement: it opens the map, shows the whole of it, stops
 * at zoom 14, then pans and zooms, and reports the time each step of the opening took, the
 * intervals of the animation frames (median, 95th percentile, longest) of every phase, the
 * memory and the GPU memory of the drawing. The run stops when the JS heap goes past the limit,
 * and reports what it measured until then.
 *
 * The map has no base map (a background layer only), so nothing is fetched from the network.
 *
 * For automation the results are also on `window.benchResult`, and `window.runTableBench()`
 * runs the measurement.
 */

import { createDraw, createFeatureTables, type Draw } from '@sakuzu/maplibre-gl-draw';
import * as maplibregl from 'maplibre-gl';
import {
  benchFeature,
  CENTER,
  extentOf,
  parseParams,
  stylesOf,
  type TableBenchPageParams,
} from './table-data';
import { TableStore } from './table-store';
import type { TableWorkerResult } from './table-worker';

// Worker URL setup for v6 (side effect). Required before the Map is created.
import './maplibre-setup';

/** The statistics of the frames of one phase */
interface PhaseResult {
  readonly name: string;
  readonly frames: number;
  readonly medianMs: number;
  readonly p95Ms: number;
  readonly maxMs: number;
  /** The JS heap at the end of the phase (MB; null when the browser does not tell) */
  readonly heapMb: number | null;
  /** The GPU memory of the drawing at the end of the phase (MB) */
  readonly gpuMb: number;
}

interface TableBenchResult {
  readonly params: TableBenchPageParams;
  /** The time of each step of the opening (ms) */
  readonly open: Record<string, number>;
  readonly phases: PhaseResult[];
  /** The memory of the page measured by the browser after the opening and at the end (MB) */
  readonly memory: { afterOpenMb: number | null; endMb: number | null };
  /** The GPU memory of the drawing at the end, per renderer (MB) */
  readonly gpu: Record<string, number>;
  /** Why the run stopped early (absent when it ran to the end) */
  stopped?: string;
}

declare global {
  interface Window {
    benchResult?: TableBenchResult;
    runTableBench: () => Promise<TableBenchResult>;
    benchMap: maplibregl.Map;
  }
  interface Performance {
    memory?: { usedJSHeapSize: number };
    measureUserAgentSpecificMemory?: () => Promise<{ bytes: number }>;
  }
}

const params = parseParams(location.search);
const LAYER_ID = 'bench';
const MB = 1024 * 1024;

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
  n: String(params.n),
  kind: params.kind,
  styles: String(params.styles),
  alpha: params.translucent ? '1' : '0',
  cuts: String(params.cuts),
  limit: String(params.limitMb),
})) {
  const field = form.elements.namedItem(key) as HTMLInputElement | HTMLSelectElement | null;
  if (field) field.value = value;
}

// More than 100,000 features need a confirmation before they are made
const LARGE = 100_000;

/** The GPU memory (MB) the drawing may allocate before a run stops */
const GPU_LIMIT_MB = 500;
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

const tablesOfPage = params.mode === 'table' ? createFeatureTables() : null;
const store = tablesOfPage ? new TableStore(tablesOfPage.tables) : undefined;
store?.createLayer({
  id: LAYER_ID,
  name: LAYER_ID,
  visible: true,
  locked: false,
  opacity: 1,
  items: [],
  styleRule: undefined,
  metadata: undefined,
});
const draw: Draw = createDraw(map, {
  defaultMode: 'select',
  autoName: false,
  initDefaultLayer: false,
  ...(store ? { store } : {}),
});

// === Measuring ===

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const nextFrame = (): Promise<number> => new Promise((resolve) => requestAnimationFrame(resolve));

/** The JS heap now (MB; null when the browser does not tell) */
function heapMb(): number | null {
  const memory = performance.memory;
  return memory ? memory.usedJSHeapSize / MB : null;
}

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

/** Draws frames until the drawing has nothing left to build (or the time runs out) */
async function settle(timeoutMs = 120_000): Promise<void> {
  const start = performance.now();
  await nextFrame();
  while (draw.hasPendingWork() || !map.loaded()) {
    if (performance.now() - start > timeoutMs) break;
    map.triggerRepaint();
    await nextFrame();
  }
}

/** The intervals of the frames while `run` goes, drawing every frame */
async function recordFrames(run: () => Promise<void>): Promise<number[]> {
  const intervals: number[] = [];
  let last = performance.now();
  let alive = true;
  const tick = (now: number): void => {
    intervals.push(now - last);
    last = now;
    map.triggerRepaint();
    if (alive) requestAnimationFrame(tick);
  };
  requestAnimationFrame((now) => {
    last = now;
    requestAnimationFrame(tick);
  });
  await run();
  alive = false;
  return intervals;
}

/** The statistics of the intervals of a phase */
function phaseOf(name: string, intervals: number[]): PhaseResult {
  const sorted = [...intervals].sort((a, b) => a - b);
  const pick = (p: number): number =>
    sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
  return {
    name,
    frames: intervals.length,
    medianMs: pick(0.5),
    p95Ms: pick(0.95),
    maxMs: sorted.length === 0 ? 0 : sorted[sorted.length - 1],
    heapMb: heapMb(),
    gpuMb: draw.debug.gpu().bytes / MB,
  };
}

/** Opens the map: the features held as rows or as features of the Store */
async function open(result: TableBenchResult): Promise<void> {
  const t0 = performance.now();
  if (tablesOfPage) {
    const worker = new Worker(new URL('./table-worker.ts', import.meta.url), { type: 'module' });
    const response = await new Promise<TableWorkerResult>((resolve) => {
      worker.onmessage = (event: MessageEvent<TableWorkerResult>) => resolve(event.data);
      worker.postMessage({
        n: params.n,
        kind: params.kind,
        styles: params.styles,
        translucent: params.translucent,
      });
    });
    worker.terminate();
    const received = performance.now();
    result.open.generate = response.generateMs;
    result.open.addRows = response.addMs;
    result.open.buildGroups = response.buildMs;
    result.open.workerTotal = received - t0;
    if (overLimit()) return;
    // The groups are queued here and taken in over the frames (within their budget), so the
    // time of taking them in is part of the first drawing below
    const a0 = performance.now();
    tablesOfPage.writer.adopt(LAYER_ID, response.groups);
    result.open.adoptQueue = performance.now() - a0;
  } else {
    const g0 = performance.now();
    const styles = stylesOf(params);
    const features = [];
    for (let i = 0; i < params.n; i++) {
      const f = benchFeature(params, styles, i);
      features.push({
        id: f.id,
        type: f.type,
        geometry: f.geometry,
        layerId: LAYER_ID,
        groupId: undefined,
        properties: f.properties,
        style: f.style,
        locked: false,
        visible: true,
      });
    }
    result.open.generate = performance.now() - g0;
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
  await settle();
  result.open.firstDraw = performance.now() - d0;
  result.open.total = performance.now() - t0;
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
  };
  window.benchResult = result;
  const finish = (stopped?: string): TableBenchResult => {
    if (stopped) result.stopped = stopped;
    for (const [name, bytes] of Object.entries(draw.debug.gpu().byRenderer)) {
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
  const openIntervals = await recordFrames(() => open(result));
  result.phases.push(phaseOf('opening', openIntervals));
  render(result);
  if (overLimit())
    return finish(
      `the JS heap went past ${params.limitMb} MB or the GPU memory past ${GPU_LIMIT_MB} MB while opening`,
    );
  result.memory.afterOpenMb = await measuredMemoryMb();
  if (params.mode === 'table' && params.cuts > 0)
    draw.debug.tables().setArtificialCuts(params.cuts);

  const [west, south, east, north] = extentOf(params);
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
        map.jumpTo({ center: CENTER, zoom: 14 });
        await settle();
        await wait(3000);
      },
    ],
    [
      'pan and zoom',
      async () => {
        const span = Math.min(east - west, 0.2);
        await ease({ center: [CENTER[0] + span / 2, CENTER[1]] });
        await ease({ center: [CENTER[0] + span / 2, CENTER[1]], zoom: 15 });
        await ease({ center: [CENTER[0] - span / 2, CENTER[1] + span / 4], zoom: 13 });
        await ease({ center: CENTER, zoom: 14 });
      },
    ],
  ];
  for (const [name, run] of phases) {
    setStatus(`Measuring: ${name}`);
    const intervals = await recordFrames(run);
    result.phases.push(phaseOf(name, intervals));
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
  `;
}

window.runTableBench = runTableBench;
startButton.addEventListener('click', () => {
  void runTableBench();
});
setStatus(
  `${params.mode} n=${params.n} kind=${params.kind} styles=${params.styles} ` +
    `alpha=${params.translucent ? 1 : 0} cuts=${params.cuts} limit=${params.limitMb}MB ` +
    `isolated=${crossOriginIsolated}`,
);
