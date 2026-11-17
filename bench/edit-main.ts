// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The editing benchmark: the scenes of an edit on a document of `n` features, each run once
 * when asked, with the longest task of the main thread and the frames it took
 *
 * The map has a background layer only (no network) and a fixed size of 1280 x 800. The page
 * makes the features in code (`edit-document.ts`) and runs one scene of `edit-scenes.ts` at a
 * time, from a button or from `window.runEditBench(name)`. A scene first puts the page in the
 * state it starts from (not measured), then runs while every frame is drawn, until the drawing
 * has nothing left to do. A scene stops when it has run for 20 seconds, preparation included;
 * nothing runs between scenes.
 *
 * Address parameters:
 *   - `n`: the number of features (default 1000; 1000, 10000 and 100000 are linked)
 *
 * On window:
 *   - `window.editReady`: a Promise that settles once the map is loaded
 *   - `window.runEditBench(name)`: runs one scene and returns its result
 *   - `window.editResults`: the result of the last run of each scene, by its name
 */

import type { DrawDocument } from '@sakuzu/maplibre-gl-draw';
import { createDraw } from '@sakuzu/maplibre-gl-draw';
import * as maplibregl from 'maplibre-gl';
import {
  countFromSearch,
  EDIT_COUNTS,
  featureIdsOf,
  GRID_CENTER,
  gridOf,
  makeDocument,
  makeEmptyDocument,
  makeFeatureCollection,
} from './edit-document';
import {
  longTasksObserved,
  nextFrame,
  type Recorded,
  type Spread,
  spreadOf,
  startRecording,
} from './edit-measure';
import { SCENES, type Scene, type SceneContext } from './edit-scenes';

// Worker URL setup for v6 (side effect). Required before the Map is created.
import './maplibre-setup';

/** The longest a scene may take, preparation included (ms) */
const SCENE_LIMIT_MS = 20_000;

/** The frames drawn at least before the drawing counts as having nothing left to do */
const SETTLE_MIN_FRAMES = 2;

/** The padding around the grid when the camera is home (CSS px) */
const HOME_PADDING_PX = 24;

/** What the page made before any scene */
interface EditInfo {
  readonly n: number;
  /** The time making one document of `n` features took in the page (ms) */
  readonly makeMs: number;
  /** Whether the browser reports the long tasks */
  readonly longTasksObserved: boolean;
}

/** The result of one run of a scene */
interface SceneResult {
  readonly scene: string;
  readonly n: number;
  /** False when the scene failed or its time ran out before the drawing had nothing left */
  readonly completed: boolean;
  readonly error: string | null;
  /** The time the preparation took (ms; not measured otherwise) */
  readonly prepareMs: number;
  /** The time from the start of the edit until the drawing had nothing left to do (ms) */
  readonly runMs: number;
  /**
   * The longest time the main thread could do nothing else (ms): the longest of the long
   * tasks the browser reported, the calls timed and the drawings of the frames
   */
  readonly longestTaskMs: number;
  /** The long tasks (50 ms or more) the browser reported (null when it reports none) */
  readonly longTasks: number | null;
  /** The intervals of the frames */
  readonly frames: Spread;
  /** The time the map took to draw each frame, until the GPU had finished it */
  readonly draws: Spread;
  /** The calls timed: how many and the longest (ms) */
  readonly inputs: { readonly count: number; readonly longestMs: number };
  /** The parts of an edit done in parts: how many and the longest (ms; null for none) */
  readonly parts: { readonly count: number; readonly longestMs: number } | null;
  /** What the scene noted */
  readonly notes: Readonly<Record<string, number | string>>;
}

declare global {
  interface Window {
    editReady: Promise<EditInfo>;
    runEditBench: (name: string) => Promise<SceneResult>;
    editResults: Record<string, SceneResult>;
    editError?: string;
  }
}

const el = (id: string): HTMLElement => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`#${id} not found`);
  return node;
};

const statusEl = el('status');
const resultsEl = el('results');
const scenesEl = el('scenes');
const countsEl = el('counts');

const requested = countFromSearch(location.search);
const n = 'n' in requested ? requested.n : 0;

const map = new maplibregl.Map({
  container: 'map',
  style: {
    version: 8,
    sources: {},
    layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#eef0f4' } }],
  },
  center: GRID_CENTER,
  zoom: 12,
  attributionControl: false,
  fadeDuration: 0,
});

const draw = createDraw(map, { defaultMode: 'select' });

const grid = gridOf(Math.max(1, n));

// The links to the numbers of features, from the fewest
for (const count of EDIT_COUNTS) {
  const link = document.createElement('a');
  link.href = `?n=${count}`;
  link.textContent = count.toLocaleString('en');
  if (count === n) link.className = 'current';
  countsEl.append(link, ' ');
}

/** The IDs of the features of the document (made once the map is loaded) */
let featureIds: readonly string[] = [];
/** Whether the document of `n` features is open as made */
let opened = false;
/** Whether a scene is running */
let busy = false;
/** The status shown when no scene runs */
let readyText = '';

window.editResults = {};

const fmt = (ms: number): string => (ms < 10 ? ms.toFixed(1) : ms.toFixed(0));

function describe(r: SceneResult): string {
  const notes = Object.entries(r.notes)
    .map(
      ([key, value]) => `${key} ${typeof value === 'number' ? value.toLocaleString('en') : value}`,
    )
    .join(', ');
  return (
    `${r.scene}${r.completed ? '' : ` (not completed${r.error ? `: ${r.error}` : ''})`}\n` +
    `  longest task ${fmt(r.longestTaskMs)} ms` +
    `${r.longTasks === null ? '' : `, long tasks ${r.longTasks}`}, run ${fmt(r.runMs)} ms ` +
    `(prepared in ${fmt(r.prepareMs)} ms)\n` +
    `  frames ${r.frames.count}: interval median ${fmt(r.frames.medianMs)} / worst ` +
    `${fmt(r.frames.worstMs)} ms; draw median ${fmt(r.draws.medianMs)} / worst ` +
    `${fmt(r.draws.worstMs)} ms\n` +
    `  inputs ${r.inputs.count} (longest ${fmt(r.inputs.longestMs)} ms)` +
    `${r.parts ? `, parts ${r.parts.count} (longest ${fmt(r.parts.longestMs)} ms)` : ''}` +
    `${notes ? `\n  ${notes}` : ''}`
  );
}

function showResults(): void {
  resultsEl.textContent = SCENES.filter((s) => window.editResults[s.name])
    .map((s) => describe(window.editResults[s.name]))
    .join('\n');
}

function setButtons(enabled: boolean): void {
  for (const button of scenesEl.querySelectorAll('button')) button.disabled = !enabled;
}

/** Runs one scene once: its preparation, then the edit while the page records */
async function runScene(scene: Scene): Promise<SceneResult> {
  const startedAt = performance.now();
  const deadline = startedAt + SCENE_LIMIT_MS;
  const expired = (): boolean => performance.now() > deadline;

  const inputs: number[] = [];
  const blockingInputs: number[] = [];
  const parts: number[] = [];
  const notes: Record<string, number | string> = {};

  const settle = async (): Promise<boolean> => {
    for (let frames = 0; ; frames++) {
      if (frames >= SETTLE_MIN_FRAMES && !draw.hasPendingWork() && map.loaded()) return true;
      if (expired()) return false;
      map.triggerRepaint();
      await nextFrame();
    }
  };

  const load = async (doc: DrawDocument): Promise<void> => {
    const result = await draw.document.load(doc);
    if (!result) throw new Error('the document is read-only');
  };

  const ctx: SceneContext = {
    map,
    draw,
    n,
    featureIds,
    async openDocument() {
      if (opened) return;
      await load(makeDocument(n));
      opened = true;
      await settle();
    },
    async openEmpty() {
      opened = false;
      await load(makeEmptyDocument());
      await settle();
    },
    markOpened() {
      opened = true;
    },
    markChanged() {
      opened = false;
    },
    makeDocument: () => makeDocument(n),
    makeGeoJsonText: () => JSON.stringify(makeFeatureCollection(n)),
    home() {
      map.fitBounds(
        [
          [grid.west, grid.south],
          [grid.east, grid.north],
        ],
        { padding: HOME_PADDING_PX, animate: false },
      );
    },
    input<T>(run: () => T): T {
      const t0 = performance.now();
      try {
        return run();
      } finally {
        const ms = performance.now() - t0;
        inputs.push(ms);
        blockingInputs.push(ms);
      }
    },
    async inputAsync<T>(run: () => Promise<T>): Promise<T> {
      const t0 = performance.now();
      try {
        return await run();
      } finally {
        inputs.push(performance.now() - t0);
      }
    },
    part(ms) {
      parts.push(ms);
    },
    note(key, value) {
      notes[key] = value;
    },
    async frame() {
      await nextFrame();
    },
    settle,
    expired,
  };

  let error: string | null = null;
  let completed = false;
  let prepareMs = 0;
  let runMs = 0;
  let recorded: Recorded = {
    intervals: [],
    draws: [],
    longTasks: null,
  };
  try {
    const prepared = await scene.prepare(ctx);
    prepareMs = performance.now() - startedAt;
    if (expired()) throw new Error('the time ran out while the scene was prepared');
    const recording = startRecording(map);
    const runStart = performance.now();
    try {
      await scene.run(ctx, prepared);
      completed = !expired();
      if (!completed) error = 'the time ran out';
    } finally {
      runMs = performance.now() - runStart;
      recorded = recording.stop();
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
    completed = false;
  }

  const longest = (values: readonly number[]): number => Math.max(0, ...values);
  return {
    scene: scene.name,
    n,
    completed,
    error,
    prepareMs,
    runMs,
    longestTaskMs: Math.max(
      longest(recorded.longTasks ?? []),
      longest(blockingInputs),
      longest(recorded.draws),
    ),
    longTasks: recorded.longTasks?.length ?? null,
    frames: spreadOf(recorded.intervals),
    draws: spreadOf(recorded.draws),
    inputs: { count: inputs.length, longestMs: longest(inputs) },
    parts: parts.length > 0 ? { count: parts.length, longestMs: longest(parts) } : null,
    notes,
  };
}

async function runEditBench(name: string): Promise<SceneResult> {
  const scene = SCENES.find((s) => s.name === name);
  if (!scene) {
    throw new Error(`no scene ${name}; the scenes are ${SCENES.map((s) => s.name).join(', ')}`);
  }
  await window.editReady;
  if (busy) throw new Error('a scene is running');
  busy = true;
  setButtons(false);
  statusEl.textContent = `n=${n.toLocaleString('en')}: running ${name}...`;
  try {
    const result = await runScene(scene);
    window.editResults[name] = result;
    showResults();
    return result;
  } finally {
    busy = false;
    setButtons(true);
    statusEl.textContent = readyText;
  }
}

window.runEditBench = runEditBench;

// A button for each scene
for (const scene of SCENES) {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = scene.name;
  button.title = scene.label;
  button.disabled = true;
  button.addEventListener('click', () => {
    runEditBench(scene.name).catch((e: unknown) => {
      statusEl.textContent = `ERROR: ${e instanceof Error ? e.message : String(e)}`;
    });
  });
  const row = document.createElement('div');
  const label = document.createElement('span');
  label.textContent = ` ${scene.label}`;
  row.append(button, label);
  scenesEl.append(row);
}

window.editReady = (async (): Promise<EditInfo> => {
  if ('error' in requested) throw new Error(requested.error);
  await new Promise<void>((resolve) => {
    if (map.loaded()) resolve();
    else map.once('load', () => resolve());
  });
  const t0 = performance.now();
  makeDocument(n);
  const makeMs = performance.now() - t0;
  featureIds = featureIdsOf(n);
  const info: EditInfo = {
    n,
    makeMs,
    longTasksObserved: longTasksObserved(),
  };
  readyText =
    `n=${n.toLocaleString('en')}: ready\n` +
    `a document made in ${fmt(makeMs)} ms; long tasks ` +
    `${info.longTasksObserved ? 'reported' : 'not reported by this browser'}`;
  statusEl.textContent = readyText;
  setButtons(true);
  return info;
})();

window.editReady.catch((error: unknown) => {
  window.editError = error instanceof Error ? error.message : String(error);
  statusEl.textContent = `ERROR: ${window.editError}`;
});
