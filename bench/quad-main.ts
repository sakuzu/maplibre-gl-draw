// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The measurement page of the quads of the drawing of the rows (a prototype)
 *
 * The rows of one layer held as rows, on a map with a background layer only (no network, no
 * terrain, not pitched), in a fixed 1280 x 800 map. The quads are the pies of
 * `src/test-support/quad-pie.ts`: a disc of two colors on a point, the share of the first color a
 * value of the row, the colors read from a texture.
 *
 * URL parameters (see README.md):
 *   - `scene`: `alt` (points and pies in turn, `n` of each), `poly` (`n` squares), `drag` (`n` pies
 *     turned, scaled or moved on the GPU, then written)
 *   - `n`: the number (1000 by default); a layer of more than 300,000 rows is refused
 *   - `mode` (alt): `single` (the pies in the draw of their chunk), `each` (the pies one by one),
 *     `baseline` (points in place of the pies)
 *   - `ext` (poly): `1` draws every chunk with the program of the quads (no pie)
 *   - `op` (drag): `rotate`, `scale` or `move`
 *   - `unit`: `px` (the size of a pie on screen) or `m` (on the ground)
 *   - `pan`: `1` moves the camera a little in every frame measured
 *   - `zoom`: the zoom (14 by default)
 *   - `bad`: `1` gives the pies a function that does not compile (drawn one by one then)
 *   - `select` (drag): `0` leaves the pies unselected
 *
 * `window.__bench.ready` settles once the rows are drawn; `window.__bench.run(seconds)` measures
 * for that many seconds (10 at most), drawing every frame with `map.triggerRepaint()`, and returns
 * the result. Nothing is measured until it is called, and nothing is left running after it.
 */

import { createDraw, type Draw } from '@sakuzu/maplibre-gl-draw';
import { createTableStore } from '@sakuzu/maplibre-gl-draw/kasane';
import { createPageBuilder } from '@sakuzu/maplibre-gl-draw/table';
import * as maplibregl from 'maplibre-gl';
import * as hooks from '../src/api/impl/table-diagnostics';
import * as featureTables from '../src/feature-table/feature-tables';
import { PIE_KEYS, PIE_TYPE, piePlugin } from '../src/test-support/quad-pie';
import * as rowMotion from '../src/view/renderers/row-motion';
import * as rowState from '../src/view/renderers/row-state';

// Worker URL setup for v6 (side effect). Required before the Map is created.
import './maplibre-setup';

// === Parameters ===

type Scene = 'alt' | 'poly' | 'drag';
type AltMode = 'single' | 'each' | 'baseline';
type DragOp = 'rotate' | 'scale' | 'move';

const params = new URLSearchParams(location.search);
const pick = <T extends string>(name: string, values: readonly T[], fallback: T): T => {
  const value = params.get(name);
  return values.includes(value as T) ? (value as T) : fallback;
};
const scene = pick<Scene>('scene', ['alt', 'poly', 'drag'], 'alt');
const n = Math.max(1, Math.floor(Number(params.get('n') ?? '1000')) || 1000);
const mode = pick<AltMode>('mode', ['single', 'each', 'baseline'], 'single');
const ext = params.get('ext') === '1';
const op = pick<DragOp>('op', ['rotate', 'scale', 'move'], 'rotate');
const meters = params.get('unit') === 'm';
const pan = params.get('pan') === '1';
const zoom = Number(params.get('zoom') ?? '14') || 14;
const broken = params.get('bad') === '1';
const select = params.get('select') !== '0';

/** The most rows of the layer the page builds */
const MAX_ROWS = 300_000;
/** The most seconds a run measures */
const MAX_SECONDS = 10;
const LAYER_ID = 'rows';
const CENTER: [number, number] = [139.7, 35.68];
const METERS_PER_DEGREE = 111_319.49079327357;
/** The length of the equator, in meters, as the program of the quads takes it */
const EARTH_CIRCUMFERENCE = 2 * Math.PI * 6378137;

/** The rows of the layer: two per pair in `alt`, one per item otherwise */
const rowCount = scene === 'alt' ? 2 * n : n;
/** Whether the pies are drawn as quads */
const quads =
  scene === 'drag' || (scene === 'alt' && mode === 'single') || (scene === 'poly' && ext);
/** Whether the page has pies at all (the plugin) */
const hasPlugin = scene !== 'poly' ? !(scene === 'alt' && mode === 'baseline') : ext;

const statusEl = document.getElementById('status') as HTMLElement;
const setStatus = (text: string): void => {
  statusEl.textContent = text;
};

// === The hooks of measurement (not part of the API of the library) ===

interface QuadStats {
  readonly types: number;
  readonly ready: number;
  readonly failed: number;
  readonly compileMs: number;
  readonly checkMs: number;
  readonly chunks: number;
  readonly quadChunks: number;
}

interface Diagnostics {
  recordDraws(): readonly { readonly kind: string; readonly delta?: boolean }[];
  stopRecording(): void;
  quadStats(): QuadStats | null;
  setQuadForAll(on: boolean): void;
  oneDrawOrigins(layerId: string): Map<number, readonly [number, number]>;
  editStats(): Readonly<Record<'prerenderMs' | 'drawMs' | 'uploadedBytes', number>>;
  gpuBytesByRenderer(): Readonly<Record<string, number>>;
}

const diagnosticsOf = (hooks as unknown as { tableDiagnosticsOf(draw: Draw): Diagnostics })
  .tableDiagnosticsOf;

/** An edit that moves, rotates or scales (the shape of `EnuEdit` of the library) */
type EnuEdit =
  | { readonly kind: 'translate'; readonly from: readonly number[]; readonly to: readonly number[] }
  | { readonly kind: 'rotate'; readonly center: readonly number[]; readonly angleDegrees: number }
  | {
      readonly kind: 'scale';
      readonly center: readonly number[];
      readonly eastFactor: number;
      readonly northFactor: number;
      readonly sizeFactor: number;
    };

/** The values of the uniforms of the motions (`MotionStateValues` of the library) */
interface MotionValues {
  readonly flags: number;
  readonly motion: unknown;
  set(
    transforms: ReadonlyArray<EnuEdit | null>,
    origin: readonly [number, number],
    center: readonly [number, number],
  ): void;
}

/** The internals the drag is measured with, read as the hooks are (not part of the API) */
const { featureTablesInternals } = featureTables as unknown as {
  featureTablesInternals(tables: unknown): unknown;
};
const { moveOffsetFloat32 } = rowMotion as unknown as {
  moveOffsetFloat32(
    values: unknown,
    slot: number,
    offset: readonly [number, number],
  ): [number, number];
};
const { MotionStateValues } = rowState as unknown as { MotionStateValues: new () => MotionValues };

/** The state sets of the rows, read for the motions the GPU draws the rows dragged with */
interface RowStates {
  stateOf(handle: number): number;
  transform(set: number): EnuEdit | null;
  translation(set: number): [number, number];
}

// === The page ===

const map = new maplibregl.Map({
  container: 'map',
  style: {
    version: 8,
    sources: {},
    layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#f4f5f7' } }],
  },
  center: CENTER,
  zoom,
  pitch: 0,
  bearing: 0,
  attributionControl: false,
  fadeDuration: 0,
});

/** The draws of the WebGL context so far (every draw call of the frame, maplibre's included) */
let glDraws = 0;

/** Counts the draw calls of the WebGL context of the map */
function countDraws(gl: WebGL2RenderingContext): void {
  const target = gl as unknown as Record<string, (...args: unknown[]) => unknown>;
  for (const name of [
    'drawArrays',
    'drawElements',
    'drawArraysInstanced',
    'drawElementsInstanced',
    'drawRangeElements',
  ]) {
    const call = target[name];
    if (typeof call !== 'function') continue;
    target[name] = (...args: unknown[]) => {
      glDraws++;
      return call.apply(gl, args);
    };
  }
}

/** The next frame drawn (the map asked to draw it), or an error after `timeoutMs` */
function nextFrame(timeoutMs = 5_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      map.off('render', done);
      reject(new Error(`no frame was drawn for ${timeoutMs} ms (is the tab in the background?)`));
    }, timeoutMs);
    const done = (): void => {
      clearTimeout(timer);
      map.off('render', done);
      resolve();
    };
    map.on('render', done);
    map.triggerRepaint();
  });
}

/** The layout of the items: a grid that fills the view */
interface Grid {
  readonly columns: number;
  readonly cellLng: number;
  readonly cellLat: number;
  /** The side of a cell on screen (CSS px) */
  readonly cellPx: number;
  /** The side of a cell on the ground (meters) */
  readonly cellMeters: number;
  center(i: number): [number, number];
}

function gridOf(count: number): Grid {
  const width = 1280;
  const height = 800;
  const columns = Math.max(1, Math.ceil(Math.sqrt((count * width) / height)));
  const rows = Math.max(1, Math.ceil(count / columns));
  const bounds = map.getBounds();
  const west = bounds.getWest();
  const north = bounds.getNorth();
  const cellLng = (bounds.getEast() - west) / columns;
  const cellLat = (north - bounds.getSouth()) / rows;
  return {
    columns,
    cellLng,
    cellLat,
    cellPx: Math.min(width / columns, height / rows),
    cellMeters: Math.min(
      cellLng * METERS_PER_DEGREE * Math.cos((CENTER[1] * Math.PI) / 180),
      cellLat * METERS_PER_DEGREE,
    ),
    center(i) {
      const column = i % columns;
      const row = Math.floor(i / columns);
      return [west + (column + 0.5) * cellLng, north - (row + 0.5) * cellLat];
    },
  };
}

/** What the page built */
interface Info {
  readonly scene: Scene;
  readonly n: number;
  readonly rows: number;
  readonly mode: AltMode | null;
  readonly ext: boolean | null;
  readonly op: DragOp | null;
  readonly unit: 'px' | 'm';
  readonly pan: boolean;
  readonly buildMs: number;
  readonly readyMs: number;
  readonly quads: QuadStats | null;
}

/** One pie, as it was made (the values the drag starts from) */
interface PieMade {
  readonly id: string;
  readonly at: [number, number];
  readonly angle: number;
  readonly size: number;
}

/** Summary of a list of times (nearest rank) */
function summary(values: readonly number[]): { median: number; p90: number; max: number } {
  if (values.length === 0) return { median: Number.NaN, p90: Number.NaN, max: Number.NaN };
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (p: number): number =>
    sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] as number;
  return { median: rank(0.5), p90: rank(0.9), max: sorted[sorted.length - 1] as number };
}

let draw: Draw | null = null;
let diagnostics: Diagnostics | null = null;
let states: RowStates | null = null;
let tables: { getRowRef(id: string): number | undefined } | null = null;
let layout: Grid | null = null;
const pies: PieMade[] = [];

/** Builds the rows of the scene and waits until they are drawn */
async function prepare(): Promise<Info> {
  if (rowCount > MAX_ROWS) {
    throw new Error(
      `${rowCount} rows are more than the page builds (${MAX_ROWS}): give a smaller n`,
    );
  }
  await new Promise<void>((resolve) => {
    if (map.loaded()) resolve();
    else map.once('load', () => resolve());
  });
  const gl = map.getCanvas().getContext('webgl2');
  if (gl) countDraws(gl);

  const started = performance.now();
  const { store, writer } = createTableStore();
  store.createLayer({
    id: LAYER_ID,
    name: LAYER_ID,
    visible: true,
    locked: false,
    opacity: 1,
    kind: 'table',
    styleRule: undefined,
    metadata: undefined,
  });
  const instance = createDraw(map, {
    defaultMode: 'select',
    autoName: false,
    initDefaultLayer: false,
    store,
  });
  draw = instance;
  diagnostics = diagnosticsOf(instance);
  tables = store.tables ?? null;
  states =
    (featureTablesInternals(store.tables) as unknown as { states: RowStates } | undefined)
      ?.states ?? null;

  const grid = gridOf(scene === 'alt' ? n : rowCount);
  layout = grid;
  const halfPx = grid.cellPx * 0.45;
  const halfSize = meters ? grid.cellMeters * 0.45 : halfPx;
  if (hasPlugin) {
    instance.extensions.plugins.add(piePlugin({ quads, meters, halfSize, broken }));
  }

  const builder = createPageBuilder();
  let order = 0;
  const key = (): string => `k${String(order++).padStart(7, '0')}`;
  const point = (id: string, at: [number, number], color: string): void => {
    builder.addRow({
      id,
      type: 'Point',
      geometry: { type: 'Point', coordinates: at },
      key: key(),
      style: {
        pointRadius: Math.max(1, halfPx - 1),
        pointColor: color,
        strokeColor: '#ffffff',
        strokeWidth: 1,
      },
      properties: {},
      hidden: false,
      locked: false,
    } as never);
  };
  const pie = (id: string, at: [number, number], share: number): void => {
    pies.push({ id, at, angle: 0, size: 1 });
    builder.addRow({
      id,
      type: PIE_TYPE,
      geometry: { type: 'Point', coordinates: at },
      key: key(),
      style: {},
      properties: { [PIE_KEYS.share]: share, [PIE_KEYS.angle]: 0, [PIE_KEYS.size]: 1 },
      hidden: false,
      locked: false,
    } as never);
  };
  if (scene === 'alt') {
    // Each pair in a cell: the point left of its middle, the pie right of it, so the pie covers
    // its point and the point of the next pair covers the pie
    for (let i = 0; i < n; i++) {
      const [x, y] = grid.center(i);
      point(`pt-${i}`, [x - grid.cellLng * 0.2, y], '#2f9e44');
      const at: [number, number] = [x + grid.cellLng * 0.15, y];
      if (mode === 'baseline') point(`pb-${i}`, at, '#1c7ed6');
      else pie(`pie-${i}`, at, ((i % 9) + 1) / 10);
    }
  } else if (scene === 'poly') {
    for (let i = 0; i < n; i++) {
      const [x, y] = grid.center(i);
      const w = grid.cellLng * 0.4;
      const h = grid.cellLat * 0.4;
      builder.addRow({
        id: `sq-${i}`,
        type: 'Polygon',
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [x - w, y - h],
              [x + w, y - h],
              [x + w, y + h],
              [x - w, y + h],
              [x - w, y - h],
            ],
          ],
        },
        key: key(),
        style: { fillColor: '#4c6ef5', fillOpacity: 0.6, strokeColor: '#364fc7', strokeWidth: 1 },
        properties: {},
        hidden: false,
        locked: false,
      } as never);
    }
  } else {
    for (let i = 0; i < n; i++) pie(`pie-${i}`, grid.center(i), ((i % 9) + 1) / 10);
  }
  writer.addPages(LAYER_ID, builder.finish());
  const buildMs = performance.now() - started;

  // Until everything is built and the program of the quads is done (ready or failed)
  const settled = (): boolean => {
    if (instance.hasPendingWork()) return false;
    if (!quads) return true;
    const stats = diagnostics?.quadStats();
    return (
      stats !== null &&
      stats !== undefined &&
      stats.types > 0 &&
      stats.ready + stats.failed === stats.types
    );
  };
  const deadline = performance.now() + 120_000;
  while (!settled()) {
    if (performance.now() > deadline) throw new Error('the rows were not drawn in 120 s');
    await nextFrame();
  }
  if (scene === 'poly' && ext) diagnostics?.setQuadForAll(true);
  // Two more frames with everything built (a chunk is drawn the frame after it is written)
  await nextFrame();
  await nextFrame();
  return {
    scene,
    n,
    rows: rowCount,
    mode: scene === 'alt' ? mode : null,
    ext: scene === 'poly' ? ext : null,
    op: scene === 'drag' ? op : null,
    unit: meters ? 'm' : 'px',
    pan,
    buildMs,
    readyMs: performance.now() - started,
    quads: diagnostics?.quadStats() ?? null,
  };
}

/** What a run measured */
interface RunResult {
  readonly info: Info;
  readonly seconds: number;
  readonly frames: number;
  /** The first frame of the run, from its request to its end (ms) */
  readonly firstFrameMs: number;
  /** The intervals of the frames after it (ms) */
  readonly frameMs: { median: number; p90: number; max: number };
  /** The draw calls of the WebGL context in a frame (maplibre's included) */
  readonly glDrawsPerFrame: { median: number; max: number };
  /** The ranges of rows drawn in one frame (`recordDraws`), by how they are drawn */
  readonly ranges: Readonly<Record<string, number>>;
  /** The chunks, and the time the programs of the quads took to compile */
  readonly quads: QuadStats | null;
  /** The time the drawing of the rows took in the last frame (CPU, ms) */
  readonly rowsCpuMs: { prerender: number; draw: number };
  /** The GPU memory of the drawing, by renderer (MB) */
  readonly gpuMb: Readonly<Record<string, number>>;
  /** The jump of a drag let go (`scene=drag`) */
  readonly drag: DragResult | null;
}

/** How far the pies moved when the drag was written, from where the GPU drew them */
interface DragResult {
  readonly op: DragOp;
  readonly edit: unknown;
  readonly rows: number;
  /** The moving set of the rows and the slot of their motion */
  readonly set: number;
  readonly slot: number;
  /** The largest distance of a corner (CSS px) between the last frame drawn and the write */
  readonly jumpPx: { median: number; p90: number; max: number };
  /** Of it, the anchors alone */
  readonly anchorPx: { median: number; p90: number; max: number };
  readonly written: boolean;
}

/** The ranges of one frame, counted by kind */
async function rangesOfFrame(): Promise<Record<string, number>> {
  const d = diagnostics as Diagnostics;
  const record = d.recordDraws();
  await nextFrame();
  const out: Record<string, number> = { total: record.length };
  for (const range of record) {
    const kind = range.delta ? `${range.kind} (delta)` : range.kind;
    out[kind] = (out[kind] ?? 0) + 1;
  }
  d.stopRecording();
  return out;
}

/** The edit of the drag at a share of the run (0 to 1) */
function dragEdit(share: number, ids: readonly string[]): EnuEdit & Record<string, unknown> {
  const target = { featureIds: ids };
  const center = CENTER;
  const grid = layout as Grid;
  const t = Math.max(1e-3, Math.min(1, share));
  if (op === 'rotate') return { kind: 'rotate', target, center, angleDegrees: 90 * t };
  if (op === 'scale') {
    const f = 1 + t;
    return { kind: 'scale', target, center, eastFactor: f, northFactor: f, sizeFactor: f };
  }
  return {
    kind: 'translate',
    target,
    from: center,
    to: [center[0] + grid.cellLng * 3 * t, center[1] + grid.cellLat * 2 * t],
  };
}

/** The Mercator position of a point (the world is 1) */
function mercator(lng: number, lat: number): [number, number] {
  const phi = (lat * Math.PI) / 180;
  return [(lng + 180) / 360, 0.5 - Math.log(Math.tan(Math.PI / 4 + phi / 2)) / (2 * Math.PI)];
}

/** The corners of a pie in CSS px of the world (meters) or of the screen (px) */
function cornersOf(at: readonly number[], half: number, angleDegrees: number): [number, number][] {
  const a = (angleDegrees * Math.PI) / 180;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  const out: [number, number][] = [];
  const lng = at[0] as number;
  const lat = at[1] as number;
  for (const [ux, uy] of [
    [-1, -1],
    [1, -1],
    [-1, 1],
    [1, 1],
  ] as const) {
    // East and north of the corner (uy: down on screen), turned counterclockwise
    const e = ux * half;
    const nn = -uy * half;
    const te = e * cos - nn * sin;
    const tn = e * sin + nn * cos;
    if (meters) {
      const world = 512 * 2 ** map.getZoom();
      const perMeter = 1 / (EARTH_CIRCUMFERENCE * Math.cos((lat * Math.PI) / 180));
      const [mx, my] = mercator(lng, lat);
      out.push([(mx + te * perMeter) * world, (my - tn * perMeter) * world]);
    } else {
      const p = map.project([lng, lat]);
      out.push([p.x + te, p.y - tn]);
    }
  }
  return out;
}

/**
 * Where the GPU draws the anchor of a row dragged, as the program moves it in float32
 * (`moveOffsetFloat32`): from its offset from the origin of its chunk, by the motion of its set
 * for the center of the view
 */
function gpuAnchor(
  at: readonly number[],
  origin: readonly [number, number],
  set: number,
  slot: number,
  edit: EnuEdit,
): [number, number] {
  const values = new MotionStateValues();
  const transforms: (EnuEdit | null)[] = [null, null, null, null];
  transforms[set] = edit;
  const c = map.getCenter();
  const center: [number, number] = [Math.fround(c.lng), Math.fround(c.lat)];
  values.set(transforms, origin, center);
  const f = Math.fround;
  const offset: [number, number] = [
    f((at[0] as number) - origin[0]),
    f((at[1] as number) - origin[1]),
  ];
  const translation = states?.translation(set) ?? [0, 0];
  if ((values.flags & (1 << set)) === 0) {
    return [origin[0] + offset[0] + translation[0], origin[1] + offset[1] + translation[1]];
  }
  const moved = moveOffsetFloat32(values.motion, slot, offset);
  return [center[0] + moved[0] + translation[0], center[1] + moved[1] + translation[1]];
}

/** The largest distance between two lists of corners */
function farthest(a: readonly [number, number][], b: readonly [number, number][]): number {
  let most = 0;
  for (let i = 0; i < a.length; i++) {
    const p = a[i] as [number, number];
    const q = b[i] as [number, number];
    most = Math.max(most, Math.hypot(p[0] - q[0], p[1] - q[1]));
  }
  return most;
}

/** The bit of the rows turned and scaled by their values, and that of a Circle */
const STATE_BY_VALUES = 1 << 5;
const STATE_UNIFORM = 1 << 9;
const STATE_MOVE_SHIFT = 3;

/** Lets the drag go: measures where the GPU drew the pies against the write, then writes */
async function letGo(sketchId: string): Promise<DragResult> {
  const instance = draw as Draw;
  const grid = layout as Grid;
  const halfBase = meters ? grid.cellMeters * 0.45 : grid.cellPx * 0.45;
  const origins = (diagnostics as Diagnostics).oneDrawOrigins(LAYER_ID);
  // The drawn place of each pie in the last frame, from the state of its row
  const drawn: { corners: [number, number][]; anchor: [number, number] }[] = [];
  let set = 0;
  let slot = 0;
  for (const pieMade of pies) {
    const handle = tables?.getRowRef(pieMade.id);
    const origin = handle === undefined ? undefined : origins.get(handle);
    const state = handle === undefined ? 0 : (states?.stateOf(handle) ?? 0);
    set = (state >> STATE_MOVE_SHIFT) & 3;
    const motion = set > 0 ? (states?.transform(set) ?? null) : null;
    if (!origin || !motion || set === 0) {
      drawn.push({ corners: [], anchor: [Number.NaN, Number.NaN] });
      continue;
    }
    const byValues = (state & (STATE_BY_VALUES | STATE_UNIFORM)) !== 0;
    slot = 2 * (set - 1) + (byValues ? 1 : 0);
    const anchor = gpuAnchor(pieMade.at, origin, set, slot, motion);
    // The angle and the factor of the set, on the rows turned and scaled by their values
    const turn = motion.kind === 'rotate' ? motion.angleDegrees : 0;
    const factor = motion.kind === 'scale' ? motion.sizeFactor : 1;
    const half = halfBase * pieMade.size * (byValues ? factor : 1);
    drawn.push({ anchor, corners: cornersOf(anchor, half, pieMade.angle + (byValues ? turn : 0)) });
  }
  const edit = instance.sketches.get(sketchId)?.edits[0] ?? null;
  const written = instance.sketches.commit(sketchId);
  const jumps: number[] = [];
  const anchors: number[] = [];
  pies.forEach((pieMade, i) => {
    const before = drawn[i];
    const feature = instance.features.get(pieMade.id);
    if (!before || before.corners.length === 0 || !feature || feature.geometry.type !== 'Point') {
      return;
    }
    const at = feature.geometry.coordinates;
    const properties = (feature.properties ?? {}) as Record<string, unknown>;
    const size =
      typeof properties[PIE_KEYS.size] === 'number' ? (properties[PIE_KEYS.size] as number) : 1;
    const angle =
      typeof properties[PIE_KEYS.angle] === 'number' ? (properties[PIE_KEYS.angle] as number) : 0;
    const after = cornersOf(at, halfBase * size, angle);
    jumps.push(farthest(before.corners, after));
    const anchorAfter = cornersOf(at, 0, 0);
    const anchorBefore = cornersOf(before.anchor, 0, 0);
    anchors.push(farthest(anchorBefore, anchorAfter));
  });
  await nextFrame();
  await nextFrame();
  return {
    op,
    edit,
    rows: jumps.length,
    set,
    slot,
    jumpPx: summary(jumps),
    anchorPx: summary(anchors),
    written,
  };
}

let running = false;

/** Measures for `seconds` (10 at most), drawing every frame */
async function run(seconds = 3): Promise<RunResult> {
  const info = await ready;
  if (running) throw new Error('a run is going on');
  running = true;
  const instance = draw as Draw;
  const d = diagnostics as Diagnostics;
  const limitMs = Math.min(MAX_SECONDS, Math.max(0.1, Number(seconds) || 3)) * 1000;
  try {
    const ranges = await rangesOfFrame();
    // The drag: the pies selected, and the sketch that turns, scales or moves them on the GPU
    let sketchId: string | null = null;
    const ids = pies.map((p) => p.id);
    if (scene === 'drag') {
      if (select) instance.selection.set('feature', ids);
      const sketch = instance.sketches.add({ edits: [dragEdit(0, ids)] as never });
      if (!sketch) throw new Error('the sketch of the drag was refused');
      sketchId = sketch.id;
      await nextFrame();
    }
    const step = (elapsed: number): void => {
      if (pan) {
        const grid = layout as Grid;
        const dx = Math.sin((elapsed / 4000) * 2 * Math.PI) * grid.cellLng * grid.columns * 0.05;
        map.jumpTo({ center: [CENTER[0] + dx, CENTER[1]] });
      }
      if (sketchId) {
        instance.sketches.update(sketchId, { edits: [dragEdit(elapsed / limitMs, ids)] as never });
      }
    };
    const intervals: number[] = [];
    const draws: number[] = [];
    const measured = await new Promise<{ first: number; frames: number }>((resolve, reject) => {
      const start = performance.now();
      let last = start;
      let frames = 0;
      let first = Number.NaN;
      let drawsAt = glDraws;
      const finish = (error?: Error): void => {
        clearTimeout(guard);
        map.off('render', onRender);
        if (error) reject(error);
        else resolve({ first, frames });
      };
      const guard = setTimeout(
        () => finish(new Error('no frame was drawn (is the tab in the background?)')),
        limitMs + 5_000,
      );
      const onRender = (): void => {
        const now = performance.now();
        if (frames === 0) first = now - start;
        else intervals.push(now - last);
        draws.push(glDraws - drawsAt);
        drawsAt = glDraws;
        last = now;
        frames++;
        if (now - start >= limitMs) {
          finish();
          return;
        }
        step(now - start);
        map.triggerRepaint();
      };
      map.on('render', onRender);
      step(0);
      map.triggerRepaint();
    });
    const drag = sketchId ? await letGo(sketchId) : null;
    const stats = d.editStats();
    const gpuMb: Record<string, number> = {};
    for (const [owner, bytes] of Object.entries(d.gpuBytesByRenderer())) {
      gpuMb[owner] = Math.round((bytes / 2 ** 20) * 100) / 100;
    }
    const drawSummary = summary(draws);
    const result: RunResult = {
      info,
      seconds: limitMs / 1000,
      frames: measured.frames,
      firstFrameMs: measured.first,
      frameMs: summary(intervals),
      glDrawsPerFrame: { median: drawSummary.median, max: drawSummary.max },
      ranges,
      quads: d.quadStats(),
      rowsCpuMs: { prerender: stats.prerenderMs, draw: stats.drawMs },
      gpuMb,
      drag,
    };
    setStatus(describe(result));
    return result;
  } finally {
    running = false;
  }
}

/** The result as text for the page */
function describe(result: RunResult): string {
  const f = (v: number): string => (Number.isFinite(v) ? v.toFixed(2) : String(v));
  const lines = [
    `scene=${scene} n=${n} rows=${rowCount} unit=${meters ? 'm' : 'px'} pan=${pan ? 1 : 0}`,
    scene === 'alt' ? `mode=${mode}` : scene === 'poly' ? `ext=${ext ? 1 : 0}` : `op=${op}`,
    `frames=${result.frames} first=${f(result.firstFrameMs)} ms`,
    `frame median=${f(result.frameMs.median)} p90=${f(result.frameMs.p90)} max=${f(result.frameMs.max)} ms`,
    `gl draws/frame median=${result.glDrawsPerFrame.median} max=${result.glDrawsPerFrame.max}`,
    `ranges ${JSON.stringify(result.ranges)}`,
    `rows cpu prerender=${f(result.rowsCpuMs.prerender)} draw=${f(result.rowsCpuMs.draw)} ms`,
    `quads ${JSON.stringify(result.quads)}`,
    `gpu MB ${JSON.stringify(result.gpuMb)}`,
  ];
  if (result.drag) {
    const g = result.drag;
    lines.push(
      `drag rows=${g.rows} set=${g.set} slot=${g.slot} written=${g.written}`,
      `jump px median=${f(g.jumpPx.median)} p90=${f(g.jumpPx.p90)} max=${f(g.jumpPx.max)}`,
      `anchor px median=${f(g.anchorPx.median)} max=${f(g.anchorPx.max)}`,
    );
  }
  return lines.join('\n');
}

const ready = prepare();
ready.then(
  (info) => setStatus(`Ready\n${JSON.stringify(info, null, 1)}\n\nwindow.__bench.run(seconds)`),
  (error: unknown) => setStatus(`Refused or failed: ${String(error)}`),
);

declare global {
  interface Window {
    __bench: {
      readonly ready: Promise<Info>;
      run(seconds?: number): Promise<RunResult>;
      readonly map: maplibregl.Map;
      draw(): Draw | null;
    };
  }
}

window.__bench = { ready, run, map, draw: () => draw };
