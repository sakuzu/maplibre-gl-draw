// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Dataset performance measurement demo
 *
 * It generates a dataset of 50,000 polygons automatically and shows the
 * live fps together with the result of the automatic pan / zoom measurement (average / p50 /
 * p90 / worst). It shows on real hardware whether the path of the datasets holds its frame
 * rate.
 */

import type { DatasetRow } from '@sakuzu/maplibre-gl-draw';
import { createMapLibreGLDraw } from '@sakuzu/maplibre-gl-draw';
import * as maplibregl from 'maplibre-gl';
// The stylesheet of the installed maplibre-gl (the version the page runs against).
import 'maplibre-gl/dist/maplibre-gl.css';

// Worker URL setup for v6 (side effect). Required before the Map is created.
import './maplibre-setup';

/** The basemap (public, no key needed) */
const BASEMAP_STYLE = 'https://tiles.openfreemap.org/styles/bright';

const GRID_NX = 250;
const GRID_NY = 200;
const CELL_DEG = 0.003;
const ORIGIN_LNG = 139.3;
const ORIGIN_LAT = 35.5;

const map = new maplibregl.Map({
  container: 'map',
  style: BASEMAP_STYLE,
  center: [139.55, 35.75],
  zoom: 12,
});
map.addControl(new maplibregl.NavigationControl(), 'top-right');

const draw = createMapLibreGLDraw(map, { defaultMode: 'select' });

const el = (id: string): HTMLElement => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`#${id} not found`);
  return node;
};

function buildFeatures(): DatasetRow[] {
  const feats: DatasetRow[] = [];
  for (let i = 0; i < GRID_NX; i++) {
    for (let j = 0; j < GRID_NY; j++) {
      const x = ORIGIN_LNG + i * CELL_DEG;
      const y = ORIGIN_LAT + j * CELL_DEG;
      const s = CELL_DEG * 0.93;
      feats.push({
        type: 'Feature',
        id: `g-${i}-${j}`,
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [x, y],
              [x + s, y],
              [x + s, y + s],
              [x, y + s],
              [x, y],
            ],
          ],
        },
        properties: { v: (i * 7 + j * 13) % 100 },
      });
    }
  }
  return feats;
}

map.on('load', () => {
  const feats = buildFeatures();
  const t0 = performance.now();
  draw.addDataset({
    id: 'perf-grid',
    rows: feats,
    styleRule: {
      kind: 'graduated',
      property: 'v',
      breaks: [33, 66],
      colors: ['#a5d8ff', '#4dabf7', '#1864ab'],
      other: '#868e96',
    },
  });
  el('count').textContent = feats.length.toLocaleString();
  el('add-ms').textContent = `${Math.round(performance.now() - t0)} ms`;
});

// Rough estimate of the number of visible cells (from the intersection of the grid extent
// and the viewport)
function updateVisibleEstimate() {
  const b = map.getBounds();
  const w =
    Math.min(b.getEast(), ORIGIN_LNG + GRID_NX * CELL_DEG) - Math.max(b.getWest(), ORIGIN_LNG);
  const h =
    Math.min(b.getNorth(), ORIGIN_LAT + GRID_NY * CELL_DEG) - Math.max(b.getSouth(), ORIGIN_LAT);
  const cells = w > 0 && h > 0 ? Math.round((w / CELL_DEG) * (h / CELL_DEG)) : 0;
  el('visible').textContent = cells.toLocaleString();
}
map.on('moveend', updateVisibleEstimate);
map.on('load', updateVisibleEstimate);

// Live fps display (average over the last 500ms)
let frameCount = 0;
let windowStart = performance.now();
function liveTick() {
  frameCount++;
  const now = performance.now();
  if (now - windowStart >= 500) {
    const fps = (frameCount * 1000) / (now - windowStart);
    el('live').textContent = fps.toFixed(0);
    frameCount = 0;
    windowStart = now;
  }
  requestAnimationFrame(liveTick);
}
requestAnimationFrame(liveTick);

// Run the same pan / zoom path while recording the frame times
interface MeasureStats {
  avgFps: number;
  avgMs: number;
  p50: number;
  p90: number;
  worst: number;
  frames: number;
}

async function measureOnce(): Promise<MeasureStats> {
  map.jumpTo({ center: [139.55, 35.75], zoom: 12 });
  await new Promise((r) => setTimeout(r, 600));

  const deltas: number[] = [];
  let last = performance.now();
  let running = true;
  const tick = () => {
    const now = performance.now();
    deltas.push(now - last);
    last = now;
    if (running) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  const ease = (opts: Parameters<typeof map.easeTo>[0]) =>
    new Promise<void>((res) => {
      map.once('moveend', () => res());
      map.easeTo({ duration: 2500, ...opts });
    });
  await ease({ center: [139.75, 35.75] });
  await ease({ center: [139.75, 35.75], zoom: 13.2 });
  await ease({ center: [139.5, 35.9], zoom: 12 });
  await ease({ center: [139.55, 35.75], zoom: 12.5 });
  running = false;

  deltas.shift();
  const sorted = [...deltas].sort((a, b) => a - b);
  const pct = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
  const avgMs = deltas.reduce((s, v) => s + v, 0) / deltas.length;
  return {
    avgFps: 1000 / avgMs,
    avgMs,
    p50: pct(0.5),
    p90: pct(0.9),
    worst: Math.max(...deltas),
    frames: deltas.length,
  };
}

const fmt = (s: MeasureStats) =>
  `avg ${s.avgFps.toFixed(1)} fps / p50 ${s.p50.toFixed(1)} ms / ` +
  `p90 ${s.p90.toFixed(1)} ms / worst ${s.worst.toFixed(0)} ms`;

// Automatic measurement: measure the baseline (without the dataset) and with it along
// the same path and compare them
const runBtn = el('run') as HTMLButtonElement;
runBtn.addEventListener('click', async () => {
  runBtn.disabled = true;
  const result = el('result');
  result.className = '';

  // Baseline: remove the dataset and run the same animation
  result.textContent = 'Measuring 1/2 (baseline: without the dataset)...';
  const saved = buildFeatures();
  draw.removeDataset('perf-grid');
  await new Promise((r) => setTimeout(r, 300));
  const base = await measureOnce();

  // Main measurement: put the dataset back and run the same animation
  result.textContent = 'Measuring 2/2 (with the dataset)...';
  draw.addDataset({
    id: 'perf-grid',
    rows: saved,
    styleRule: {
      kind: 'graduated',
      property: 'v',
      breaks: [33, 66],
      colors: ['#a5d8ff', '#4dabf7', '#1864ab'],
      other: '#868e96',
    },
  });
  await new Promise((r) => setTimeout(r, 300));
  const withDc = await measureOnce();

  const pass = withDc.avgFps >= 55 && withDc.p90 <= 20;
  const overheadMs = withDc.avgMs - base.avgMs;

  result.className = pass ? 'pass' : 'fail';
  result.textContent =
    `Without: ${fmt(base)}\n` +
    `With: ${fmt(withDc)}\n` +
    `Overhead from the dataset: ${overheadMs.toFixed(1)} ms/frame on average\n` +
    `Verdict: ${pass ? 'PASS (60fps held)' : 'FAIL'}`;
  runBtn.disabled = false;
});
