// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Benchmark page for the Store rendering path
 *
 * It loads a large number of features into the Store with `draw.load()`, runs the same
 * pan / zoom path and collects statistics on the frame times. It is used for comparative
 * measurements against main / perf.
 *
 * To avoid depending on the network, the map style is an inline style with a background
 * layer only.
 *
 * URL parameters:
 *   - `n`        : total number of features (default 50000)
 *   - `order`    : `grouped` (grouped by type) / `interleaved` (types alternating)
 *   - `retained` : `1` for retained mode, `0` for immediate mode
 *                  (renderingStyle.storeRetained)
 *   - `autoName` : `1` enables automatic name generation (disabled by default)
 *
 * The following are exposed on window for automation.
 *   - `window.benchReady`: a Promise that represents completion of the load
 *   - `window.runBench()`: runs one measurement and returns the statistics
 */

import { createMapLibreGLDraw } from '@sakuzu/maplibre-gl-draw';
import * as maplibregl from 'maplibre-gl';

// Worker URL setup for v6 (side effect). Required before the Map is created.
import './maplibre-setup';

/** Size of one cell (in degrees) */
const CELL_DEG = 0.003;

/** Reference camera of the measurement path */
const HOME_CENTER: [number, number] = [139.55, 35.75];
const HOME_ZOOM = 12;

interface BenchStats {
  frames: number;
  avgMs: number;
  avgFps: number;
  p50: number;
  p90: number;
  p99: number;
  worst: number;
}

interface BenchInfo {
  loadMs: number;
  firstIdleMs: number;
  featureCount: number;
}

declare global {
  interface Window {
    benchReady: Promise<BenchInfo>;
    runBench: () => Promise<BenchStats>;
    benchError?: string;
    /** Exposes the map instance for debugging */
    benchMap: maplibregl.Map;
    /** Duration of each segment of the most recent measurement (ms) */
    benchSegments: number[];
  }
}

const params = new URLSearchParams(location.search);
const featureTotal = Number(params.get('n') ?? '50000');
const order = params.get('order') === 'interleaved' ? 'interleaved' : 'grouped';
const retained = params.get('retained') !== '0';
const autoName = params.get('autoName') === '1';

const statusEl = document.getElementById('status') as HTMLElement;
const setStatus = (text: string): void => {
  statusEl.textContent = text;
};

const map = new maplibregl.Map({
  container: 'map',
  style: {
    version: 8,
    sources: {},
    layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#eef0f4' } }],
  },
  center: HOME_CENTER,
  zoom: HOME_ZOOM,
  attributionControl: false,
  fadeDuration: 0,
});

const draw = createMapLibreGLDraw(map, {
  defaultMode: 'select',
  renderingStyle: { storeRetained: retained },
  // Off by default so it does not disturb the rendering performance measurement (main and
  // perf use the same conditions). Add autoName=1 to measure automatic name generation
  // itself.
  autoName,
});

/**
 * Layout of the grid
 *
 * The number of columns and rows is derived from n, and the origin is shifted so that the
 * center of the whole grid lands on the reference camera position. Without this, a small n
 * puts the grid off screen and the measurement runs with nothing visible.
 */
function gridLayout(n: number): { columns: number; originLng: number; originLat: number } {
  const columns = Math.max(1, Math.ceil(Math.sqrt(n)));
  const rows = Math.ceil(n / columns);
  return {
    columns,
    originLng: HOME_CENTER[0] - (columns * CELL_DEG) / 2,
    originLat: HOME_CENTER[1] - (rows * CELL_DEG) / 2,
  };
}

const grid = gridLayout(featureTotal);

/** Cell coordinates of the grid (deterministic) */
function cellOrigin(index: number, columns: number): [number, number] {
  const col = index % columns;
  const row = Math.floor(index / columns);
  return [grid.originLng + col * CELL_DEG, grid.originLat + row * CELL_DEG];
}

/** Square ring (5 vertices) */
function squareRing(x: number, y: number): [number, number][] {
  const s = CELL_DEG * 0.8;
  return [
    [x, y],
    [x + s, y],
    [x + s, y + s],
    [x, y + s],
    [x, y],
  ];
}

/** Regular 24-gon ring (25 vertices) */
function polygon24Ring(x: number, y: number): [number, number][] {
  const r = CELL_DEG * 0.4;
  const cx = x + CELL_DEG * 0.4;
  const cy = y + CELL_DEG * 0.4;
  const ring: [number, number][] = [];
  for (let k = 0; k < 24; k++) {
    const a = (k / 24) * Math.PI * 2;
    ring.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  ring.push(ring[0]);
  return ring;
}

/** Zigzag polyline of 5 points */
function zigzagLine(x: number, y: number): [number, number][] {
  const s = CELL_DEG * 0.8;
  return [
    [x, y],
    [x + s * 0.25, y + s],
    [x + s * 0.5, y],
    [x + s * 0.75, y + s],
    [x + s, y],
  ];
}

type GeoFeature = GeoJSON.Feature<GeoJSON.Geometry, Record<string, unknown>>;

function makePolygon(i: number, cell: number, columns: number): GeoFeature {
  const [x, y] = cellOrigin(cell, columns);
  // Make one in five a regular 24-gon to bring out the effect of triangulation and indexing
  const ring = i % 5 === 4 ? polygon24Ring(x, y) : squareRing(x, y);
  return {
    type: 'Feature',
    geometry: { type: 'Polygon', coordinates: [ring] },
    properties: { 'maplibre-gl-draw:id': `p-${i}` },
  };
}

function makeLine(i: number, cell: number, columns: number): GeoFeature {
  const [x, y] = cellOrigin(cell, columns);
  return {
    type: 'Feature',
    geometry: { type: 'LineString', coordinates: zigzagLine(x, y) },
    properties: { 'maplibre-gl-draw:id': `l-${i}` },
  };
}

function makePoint(i: number, cell: number, columns: number): GeoFeature {
  const [x, y] = cellOrigin(cell, columns);
  return {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [x + CELL_DEG * 0.4, y + CELL_DEG * 0.4] },
    properties: { 'maplibre-gl-draw:id': `pt-${i}` },
  };
}

/**
 * Feature generation (deterministic, without random numbers)
 *
 * The total n is split into 50% polygons / 30% lines / 20% points, and they are placed one
 * per grid cell. `grouped` puts them together by type (polygons -> lines -> points), and
 * `interleaved` alternates the types.
 */
function buildFeatures(n: number, mode: 'grouped' | 'interleaved'): GeoFeature[] {
  const polygonCount = Math.floor(n * 0.5);
  const lineCount = Math.floor(n * 0.3);
  const pointCount = n - polygonCount - lineCount;
  const columns = grid.columns;
  const features: GeoFeature[] = [];

  if (mode === 'grouped') {
    let cell = 0;
    for (let i = 0; i < polygonCount; i++) features.push(makePolygon(i, cell++, columns));
    for (let i = 0; i < lineCount; i++) features.push(makeLine(i, cell++, columns));
    for (let i = 0; i < pointCount; i++) features.push(makePoint(i, cell++, columns));
    return features;
  }

  // interleaved: emit 5 polygons / 3 lines / 2 points alternately in a cycle of 10
  let pi = 0;
  let li = 0;
  let ti = 0;
  for (let cell = 0; cell < n; cell++) {
    const phase = cell % 10;
    if (phase % 2 === 0 && pi < polygonCount) {
      features.push(makePolygon(pi++, cell, columns));
    } else if (phase % 3 === 1 && li < lineCount) {
      features.push(makeLine(li++, cell, columns));
    } else if (ti < pointCount) {
      features.push(makePoint(ti++, cell, columns));
    } else if (li < lineCount) {
      features.push(makeLine(li++, cell, columns));
    } else if (pi < polygonCount) {
      features.push(makePolygon(pi++, cell, columns));
    }
  }
  return features;
}

/** Statistics (percentiles use the nearest-rank method) */
function summarize(deltas: number[]): BenchStats {
  const sorted = [...deltas].sort((a, b) => a - b);
  const pct = (p: number): number =>
    sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
  const avgMs = deltas.reduce((s, v) => s + v, 0) / deltas.length;
  return {
    frames: deltas.length,
    avgMs,
    avgFps: 1000 / avgMs,
    p50: pct(0.5),
    p90: pct(0.9),
    p99: pct(0.99),
    worst: Math.max(...deltas),
  };
}

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * One measurement run
 *
 * With vsync disabled, rAF keeps running even while idle in some environments, so recording
 * is limited to while easeTo is running (the first frame of each segment is dropped because
 * it only serves to fix the timestamp at which the segment started).
 */
async function runBench(): Promise<BenchStats> {
  map.jumpTo({ center: HOME_CENTER, zoom: HOME_ZOOM });
  await wait(600);

  const deltas: number[] = [];
  let recording = false;
  let segmentHead = true;
  let last = performance.now();
  let alive = true;

  const tick = (): void => {
    const now = performance.now();
    if (recording) {
      if (segmentHead) segmentHead = false;
      else deltas.push(now - last);
    }
    last = now;
    if (alive) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  const segments: number[] = [];
  const ease = (opts: Parameters<typeof map.easeTo>[0]): Promise<void> =>
    new Promise<void>((resolve) => {
      const started = performance.now();
      map.once('moveend', () => {
        recording = false;
        segments.push(performance.now() - started);
        resolve();
      });
      recording = true;
      segmentHead = true;
      last = performance.now();
      map.easeTo({ duration: 2500, essential: true, ...opts });
    });

  await ease({ center: [139.75, 35.75] });
  await ease({ center: [139.75, 35.75], zoom: 13.2 });
  await ease({ center: [139.5, 35.9], zoom: 12 });
  await ease({ center: [139.55, 35.75], zoom: 12.5 });
  alive = false;
  window.benchSegments = segments;

  return summarize(deltas);
}

window.benchMap = map;
window.runBench = runBench;

window.benchReady = (async (): Promise<BenchInfo> => {
  await new Promise<void>((resolve) => {
    if (map.loaded()) resolve();
    else map.once('load', () => resolve());
  });

  const features = buildFeatures(featureTotal, order);
  const idlePromise = new Promise<number>((resolve) => {
    const t = performance.now();
    map.once('idle', () => resolve(performance.now() - t));
  });

  const t0 = performance.now();
  const result = await draw.load({ type: 'FeatureCollection', features });
  const loadMs = performance.now() - t0;
  const firstIdleMs = await idlePromise;

  const info: BenchInfo = {
    loadMs,
    firstIdleMs,
    featureCount: result.featureIds.length,
  };
  setStatus(
    `n=${featureTotal} order=${order} retained=${retained ? 1 : 0} ` +
      `autoName=${autoName ? 1 : 0}\n` +
      `features=${info.featureCount}\n` +
      `loadMs=${loadMs.toFixed(1)} firstIdleMs=${firstIdleMs.toFixed(1)}`,
  );
  return info;
})();

window.benchReady.catch((error: unknown) => {
  window.benchError = error instanceof Error ? error.message : String(error);
  setStatus(`ERROR: ${window.benchError}`);
});
