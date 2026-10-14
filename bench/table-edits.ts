// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The edits of the page of the layers held as rows, repeated, and the changes of others sent at
 * a rate
 *
 * An edit is repeated a number of times, one change per frame (`EDIT_OPS`): a color changed, a
 * color slid, the colors of the steps of a graduated style rule slid, an attribute written (a
 * string, then a number), a point moved, a vertex of the longest line moved, a corner of a
 * building moved, a building drawn and finished in the middle of the order. The changes of others
 * are sent at a rate for a time, of one kind: written in place (colors, attributes, positions of
 * points, corners of buildings) or placed elsewhere (rows put in another place of the order,
 * groups of features put in another place, a vertex added to a building past its place, new rows
 * imported a transaction at a time, run until all are sent). Rows held as columns are written
 * through the writer of their tables, as the implementation of a Store writes them; features of
 * the Store through `draw.features` and `draw.groups`, as it is drawn today, to compare.
 *
 * The edits of a feature at a time are made as the select mode makes them: the pointer moved
 * over the map and a click are sent to the canvas as the events of the mouse (the time each takes
 * is measured: the move, and the click to the frame its handles are drawn in), and the edits of a
 * feature selected go through the Store as the select mode writes them (the middle of a drag,
 * then its end).
 *
 * The edits of many rows: `held` rows selected (the time to hold them is an input) and dragged as
 * the select mode drags them (every row written in the middle of the drag in every frame, then
 * the end in one transaction), or kept selected while the map pans; `members` rows grouped and
 * ungrouped, put in another layer and back, brought to the front and sent to the back (one row,
 * or `members`), each an input timed to the frame nothing is left to build (the longest key of
 * the order of the rows moved is noted); an edit of `members` rows undone and redone by a history
 * of the page (the Store of the page has none): the values before and after the edit written back
 * through the Store (`applyRows`, which returns the values before; the features of the Store are
 * updated with their values for the Store of objects), with the bytes the history holds noted.
 *
 * Each run measures the frames before, during and after it, the JS heap and the GPU memory (and
 * the highest heap during it), and what the writes, the deltas and the versions of the row groups
 * hold and did (`draw.debug.tables().editStats()`).
 */

import type {
  Draw,
  Feature,
  FeatureTables,
  FeatureTablesWriter,
  RowField,
  RowPatch,
  RowValuesSnapshot,
  Store,
  TableEditStats,
} from '@sakuzu/maplibre-gl-draw';
import type { Geometry, Position } from 'geojson';
import type * as maplibregl from 'maplibre-gl';
import type { BenchCandidates, EditOp, RemoteKind, TableBenchPageParams } from './table-data';
import {
  heapMb,
  idleFrames,
  nextFrame,
  type PhaseResult,
  phaseOf,
  recordFrames,
} from './table-measure';

/**
 * The Store of rows of the page as the instance writes it: the values of rows written for this
 * client, returning the values they had (what an undo writes back)
 */
export interface RowsStore {
  applyRows(patch: RowPatch): RowValuesSnapshot | null;
}

/** What the edits write to */
export interface EditTarget {
  readonly mode: 'table' | 'store';
  readonly draw: Draw;
  readonly map: maplibregl.Map;
  readonly layerId: string;
  /** The tables of the page (rows held as columns), or null for features of the Store */
  readonly tables: FeatureTables | null;
  readonly writer: FeatureTablesWriter | null;
  /** The Store, with its writes (the edits of a feature at a time write it as the modes do) */
  readonly store: Store;
  /** The Store of rows of the page (null for features of the Store) */
  readonly rowsStore: RowsStore | null;
  readonly candidates: BenchCandidates;
}

/** What one run of an edit or of the stream measured */
export interface EditResult {
  readonly name: string;
  /** The frames before, during and after the run */
  readonly before: PhaseResult;
  readonly during: PhaseResult;
  readonly after: PhaseResult;
  /** What the writes in place held and did before and after the run */
  readonly statsBefore: TableEditStats;
  readonly statsAfter: TableEditStats;
  /** The time the drawing of the rows took per frame during the run (ms; table mode) */
  readonly frameCpuMs: { readonly mean: number; readonly max: number };
  /** The changes made */
  readonly changes: number;
  /** The highest JS heap during the run (MB; null when the browser does not tell) */
  readonly peakHeapMb: number | null;
  /**
   * The time of each input of an edit of a feature at a time (ms): the handling of a move of the
   * pointer, or a click to the frame its handles are drawn in (absent for the other edits)
   */
  readonly inputMs?: { readonly mean: number; readonly max: number; readonly count: number };
  /** What else an edit noted (the longest key of the order, the bytes of a history) */
  readonly notes?: readonly string[];
  /** Why the run could not be made (absent when it was) */
  readonly error?: string;
}

/** A change of a row */
interface RowChange {
  geometry?: Geometry;
  style?: Record<string, unknown>;
  properties?: Record<string, unknown>;
}

/** The feature of a row as it is now */
function featureOf(target: EditTarget, id: string): Feature | undefined {
  if (!target.tables) return target.draw.features.get(id);
  const handle = target.tables.handleOf(id);
  return handle === undefined ? undefined : target.tables.layer(target.layerId)?.getRow(handle);
}

/**
 * Writes changes of rows (of the same fields): through the writer of the tables, or to the
 * features of the Store
 */
function writeRows(target: EditTarget, changes: ReadonlyArray<[string, RowChange]>): void {
  if (changes.length === 0) return;
  const { tables, writer } = target;
  if (!tables || !writer) {
    target.draw.features.updateMany(
      changes.map(([id, change]) => ({ id, patch: change as never })),
    );
    return;
  }
  const handles: number[] = [];
  const fields = new Map<RowField, unknown[]>();
  const field = (name: RowField): unknown[] => {
    let values = fields.get(name);
    if (!values) {
      values = [];
      fields.set(name, values);
    }
    return values;
  };
  for (const [id, change] of changes) {
    const handle = tables.handleOf(id);
    if (handle === undefined) continue;
    handles.push(handle);
    if (change.geometry) field('geometry').push(change.geometry);
    if (change.style) {
      // A row holds its whole style: the keys changed are put on the one it has
      const style = featureOf(target, id)?.style ?? {};
      field('style').push({ ...style, ...change.style });
    }
    for (const [key, value] of Object.entries(change.properties ?? {})) {
      field(`property:${key}`).push(value);
    }
  }
  if (handles.length > 0) writer.apply({ handles: Int32Array.from(handles), fields });
}

/** A color of a hue (0 to 360) */
function hue(h: number): string {
  const c = (n: number): string => {
    const k = (n + h / 30) % 12;
    const v = 0.5 - 0.5 * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(v * 255)
      .toString(16)
      .padStart(2, '0');
  };
  return `#${c(0)}${c(8)}${c(4)}`;
}

/** The style of a color for every kind (a point, a line, a polygon) */
function colored(color: string): Record<string, unknown> {
  return { pointColor: color, strokeColor: color, fillColor: color };
}

/** A geometry with one of its positions moved (the closing one of a ring with its first) */
function moved(
  geometry: Geometry,
  at: (count: number) => number,
  dx: number,
  dy: number,
): Geometry {
  const shift = (p: Position): Position => [p[0] + dx, p[1] + dy];
  switch (geometry.type) {
    case 'Point':
      return { type: 'Point', coordinates: shift(geometry.coordinates) };
    case 'LineString': {
      const coordinates = geometry.coordinates.slice();
      const k = at(coordinates.length);
      coordinates[k] = shift(coordinates[k]);
      return { type: 'LineString', coordinates };
    }
    case 'Polygon': {
      const ring = geometry.coordinates[0].slice();
      const k = at(ring.length - 1);
      ring[k] = shift(ring[k]);
      if (k === 0) ring[ring.length - 1] = ring[0];
      return { type: 'Polygon', coordinates: [ring, ...geometry.coordinates.slice(1)] };
    }
    default:
      return geometry;
  }
}

/** The ids as a column of UTF-8 (what the writer gives handles to) */
function idColumn(ids: readonly string[]): { offsets: Int32Array; bytes: Uint8Array } {
  const encoder = new TextEncoder();
  const parts = ids.map((id) => encoder.encode(id));
  const offsets = new Int32Array(ids.length + 1);
  for (let i = 0; i < parts.length; i++) offsets[i + 1] = offsets[i] + parts[i].length;
  const bytes = new Uint8Array(offsets[ids.length]);
  parts.forEach((part, i) => {
    bytes.set(part, offsets[i]);
  });
  return { offsets, bytes };
}

/** A key of the order just after the key of the row `n` of the page (its rows sort by `k<n>`) */
function keyAfter(params: TableBenchPageParams, n: number, tag: string): string {
  return `k${String(Math.floor(n)).padStart(params.data ? 9 : 8, '0')}${tag}`;
}

/** The rows of the layer */
function rowCount(target: EditTarget): number {
  return target.tables?.layer(target.layerId)?.rowCount ?? target.draw.features.count();
}

/** A building of 5 corners around a position */
function buildingAt(x: number, y: number, size: number): Geometry {
  return {
    type: 'Polygon',
    coordinates: [
      [
        [x, y],
        [x + size, y],
        [x + size, y + size],
        [x, y + size],
        [x, y],
      ],
    ],
  };
}

/**
 * Writes new rows of the layer, each with its key: through the writer (the new rows of a Store
 * implementation, given handles first), or created in the Store and put at their places
 */
function createRows(
  target: EditTarget,
  rows: ReadonlyArray<{ id: string; geometry: Geometry; order: string; index: number }>,
  style: Record<string, unknown>,
): void {
  if (rows.length === 0) return;
  const { tables, writer } = target;
  if (!tables || !writer) {
    target.draw.features.createMany(
      rows.map((row) => ({
        id: row.id,
        type: row.geometry.type,
        geometry: row.geometry,
        layerId: target.layerId,
        style,
      })) as never,
    );
    for (const row of rows)
      target.draw.features.move(row.id, { layerId: target.layerId, index: row.index });
    return;
  }
  const handles = writer.allocateHandles(idColumn(rows.map((row) => row.id)));
  writer.apply({
    handles,
    fields: new Map<RowField, unknown[]>([
      ['type', rows.map((row) => row.geometry.type)],
      ['layerId', rows.map(() => target.layerId)],
      ['geometry', rows.map((row) => row.geometry)],
      ['order', rows.map((row) => row.order)],
      ['style', rows.map(() => style)],
    ]),
  });
}

/** The steps of an edit: one change per call */
function stepsOf(
  target: EditTarget,
  op: EditOp,
  params: TableBenchPageParams,
): ((i: number) => Promise<void>) | string {
  const { candidates } = target;
  const building = candidates.polygon ?? candidates.point;
  switch (op) {
    case 'color1':
      if (!building) return 'no polygon or point to color';
      // One color, then the frames go on
      return async (i) => {
        writeRows(target, [[building, { style: colored(hue((i * 137) % 360)) }]]);
        await nextFrame();
        await nextFrame();
      };
    case 'colorSlide':
      if (!building) return 'no polygon or point to color';
      return async (i) => writeRows(target, [[building, { style: colored(hue(i * 3.6)) }]]);
    case 'ruleSlide': {
      const { key, breaks } = params.rule;
      return async (i) => {
        const colors = Array.from({ length: breaks.length + 1 }, (_, k) => hue(i * 3.6 + k * 40));
        target.draw.layers.update(target.layerId, {
          styleRule: {
            kind: 'graduated',
            property: key,
            breaks: [...breaks],
            colors,
            other: '#808080',
          },
        });
      };
    }
    case 'attr': {
      const ids = candidates.ids;
      if (ids.length === 0) return 'no row';
      // A string of another length, then a number where there was none
      return async (i) => {
        const id = ids[Math.floor(i / 2) % ids.length];
        const properties =
          i % 2 === 0 ? { name: `edited ${'x'.repeat(i % 23)}` } : { height: (i * 1.5) % 97 };
        writeRows(target, [[id, { properties }]]);
      };
    }
    case 'point': {
      const point = candidates.point;
      if (!point) return 'no point';
      return async () => {
        const geometry = featureOf(target, point)?.geometry;
        if (geometry)
          writeRows(target, [[point, { geometry: moved(geometry, () => 0, 2e-5, 1e-5) }]]);
      };
    }
    case 'longLine': {
      const line = candidates.line;
      if (!line) return 'no line';
      return async (i) => {
        const geometry = featureOf(target, line)?.geometry;
        const d = (i % 2 === 0 ? 1 : -1) * 2e-5;
        if (geometry) {
          writeRows(target, [
            [line, { geometry: moved(geometry, (n) => Math.floor(n / 2), d, d) }],
          ]);
        }
      };
    }
    case 'corner': {
      const polygon = candidates.polygon;
      if (!polygon) return 'no polygon';
      return async (i) => {
        const geometry = featureOf(target, polygon)?.geometry;
        const d = (i % 2 === 0 ? 1 : -1) * 2e-5;
        if (geometry) writeRows(target, [[polygon, { geometry: moved(geometry, () => 1, d, 0) }]]);
      };
    }
    case 'finish': {
      // A building drawn and finished: a new row in the middle of the order, near the center
      const middle = Math.floor(rowCount(target) / 2);
      return async (i) => {
        const center = target.map.getCenter();
        const size = 1e-4;
        createRows(
          target,
          [
            {
              id: `finished${Date.now().toString(36)}${i}`,
              geometry: buildingAt(
                center.lng + ((i % 10) - 5) * size * 2,
                center.lat + (Math.floor(i / 10) % 10) * size * 2,
                size,
              ),
              order: keyAfter(params, middle, `f${String(i).padStart(6, '0')}`),
              index: middle,
            },
          ],
          { fillColor: '#76b7b2', fillOpacity: 0.5, strokeWidth: 2 },
        );
      };
    }
    case 'hover':
    case 'click':
    case 'vertexAdd':
    case 'vertexRemove':
    case 'delete':
      return featureSteps(target, op, inputs);
    case 'moveHeld':
    case 'panHeld':
    case 'group':
    case 'toLayer':
    case 'order1':
    case 'orderMany':
    case 'undoRedo':
      return manySteps(target, op, params);
  }
}

/** What an edit noted, as it is made */
const notes: string[] = [];

/** A geometry moved as a whole by a translation */
function translated(geometry: Geometry, dx: number, dy: number): Geometry {
  const walk = (value: unknown): unknown =>
    Array.isArray(value) && typeof value[0] === 'number'
      ? [(value[0] as number) + dx, (value[1] as number) + dy, ...value.slice(2)]
      : Array.isArray(value)
        ? value.map(walk)
        : value;
  return {
    ...geometry,
    coordinates: walk((geometry as { coordinates: unknown }).coordinates),
  } as Geometry;
}

/** Draws frames until the drawing has nothing left to build (at most `frames`) */
async function settled(draw: Draw, frames = 600): Promise<void> {
  await nextFrame();
  for (let i = 0; i < frames && draw.hasPendingWork(); i++) await nextFrame();
}

/** The layer the rows are put in and taken back from, made once per page */
const OTHER_LAYER = 'bench-other';

/** Makes the other layer the rows are put in, the same kind as the layer of the page */
function ensureOtherLayer(target: EditTarget): void {
  if (target.store.getLayer(OTHER_LAYER)) return;
  if (target.tables) {
    target.store.createLayer({
      id: OTHER_LAYER,
      name: OTHER_LAYER,
      visible: true,
      locked: false,
      opacity: 1,
      kind: 'table',
      styleRule: undefined,
      metadata: undefined,
    } as never);
  } else {
    target.draw.layers.create({ id: OTHER_LAYER, name: OTHER_LAYER });
  }
}

/** The longest key of the order of rows (table mode; 0 for features of the Store) */
function longestKey(target: EditTarget, ids: readonly string[]): number {
  const { tables } = target;
  if (!tables) return 0;
  const handles = ids.map((id) => tables.handleOf(id)).filter((h) => h !== undefined) as number[];
  if (handles.length === 0) return 0;
  const read = tables.snapshot({
    handles: Int32Array.from(handles),
    fields: new Map<RowField, unknown[]>([['order', handles.map(() => undefined)]]),
  });
  let longest = 0;
  for (const key of read.fields.get('order') ?? []) {
    if (typeof key === 'string') longest = Math.max(longest, key.length);
  }
  return longest;
}

/** The bytes of values of rows as a history holds them (the values as JSON, and the handles) */
function snapshotBytes(snapshot: RowValuesSnapshot): number {
  let bytes = snapshot.handles.length * 4 + (snapshot.deleted?.length ?? 0);
  for (const values of snapshot.fields.values()) {
    for (const value of values) bytes += JSON.stringify(value ?? null).length;
  }
  return bytes;
}

/**
 * The steps of the edits of many rows: `held` rows selected and dragged or kept while the map
 * pans, `members` rows grouped, put in another layer, brought to the front and sent to the back,
 * an edit undone and redone (the times of their inputs go to `inputs`, what they note to `notes`)
 */
function manySteps(
  target: EditTarget,
  op: 'moveHeld' | 'panHeld' | 'group' | 'toLayer' | 'order1' | 'orderMany' | 'undoRedo',
  params: TableBenchPageParams,
): ((i: number) => Promise<void>) | string {
  const { draw, map, store, candidates, layerId } = target;
  const ids = candidates.ids;
  if (ids.length === 0) return 'no row';
  const held = ids.slice(0, params.held);
  const members = ids.slice(0, Math.min(params.members, ids.length));
  /** Selects the rows held, timing it (the rows are held as features) */
  const select = (): void => {
    const t0 = performance.now();
    store.setSelection('feature', held);
    inputs.push(performance.now() - t0);
    notes.push(`selected ${store.getSelection().ids.length} of ${held.length}`);
  };
  /** Runs a change of the order and times it to the frame nothing is left to build */
  const timed = async (change: () => void): Promise<void> => {
    const t0 = performance.now();
    change();
    await settled(draw);
    inputs.push(performance.now() - t0);
  };
  switch (op) {
    case 'moveHeld': {
      // A drag of 10 frames, ended, then another: every row written in every frame of it, as the
      // select mode writes them, the end in one transaction
      const DRAG_FRAMES = 10;
      let starts = new Map<string, Geometry>();
      return async (i) => {
        if (i === 0) select();
        const frame = i % DRAG_FRAMES;
        if (frame === 0) {
          starts = new Map();
          for (const id of held) {
            const geometry = store.getFeature(id)?.geometry;
            if (geometry) starts.set(id, geometry);
          }
        }
        const sign = Math.floor(i / DRAG_FRAMES) % 2 === 0 ? 1 : -1;
        const d = sign * (frame + 1) * 1e-5;
        const t0 = performance.now();
        if (frame < DRAG_FRAMES - 1) {
          for (const [id, geometry] of starts) {
            store.updateFeature(
              id,
              { geometry: translated(geometry, d, d / 2) },
              {
                isIntermediate: true,
              },
            );
          }
        } else {
          store.transact(() => {
            for (const [id, geometry] of starts) {
              store.updateFeature(id, { geometry: translated(geometry, d, d / 2) });
            }
          });
        }
        inputs.push(performance.now() - t0);
      };
    }
    case 'panHeld':
      // A pan of a few pixels per frame, back and forth, the rows selected
      return async (i) => {
        if (i === 0) select();
        const sign = Math.floor(i / 50) % 2 === 0 ? 1 : -1;
        map.panBy([sign * 6, sign * 2], { animate: false });
      };
    case 'group': {
      // Grouped at the place of the frontmost, then ungrouped at the place of the group
      let group: string | null = null;
      return async () => {
        await timed(() => {
          if (group) {
            draw.groups.delete(group);
            group = null;
          } else {
            group = draw.groups.create({ featureIds: members })?.id ?? null;
          }
        });
      };
    }
    case 'toLayer': {
      ensureOtherLayer(target);
      return async (i) => {
        await timed(() => {
          draw.features.moveMany(members, { layerId: i % 2 === 0 ? OTHER_LAYER : layerId });
        });
        if (i % 2 === 1) notes.push(`longest key ${longestKey(target, members)}`);
      };
    }
    case 'order1':
    case 'orderMany': {
      const moved = op === 'order1' ? ids.slice(0, 1) : members;
      return async (i) => {
        await timed(() => {
          draw.features.moveMany(
            moved,
            i % 2 === 0 ? { layerId, above: null } : { layerId, below: null },
          );
        });
        if (i === params.reps - 1) notes.push(`longest key ${longestKey(target, moved)}`);
      };
    }
    case 'undoRedo':
      return undoRedoSteps(target, members);
  }
}

/**
 * The steps of an edit of rows undone and redone by a history of the page: the edit (the rows
 * moved and colored) is made once, then undone and redone in turn, each a write of the values
 * the history holds (through `applyRows` for rows, `updateMany` for features of the Store)
 */
function undoRedoSteps(target: EditTarget, ids: readonly string[]): (i: number) => Promise<void> {
  const { draw, tables, rowsStore } = target;
  // The edit: every row moved and colored
  const after = new Map<string, { geometry: Geometry; style: Record<string, unknown> }>();
  for (const id of ids) {
    const feature = featureOf(target, id);
    if (!feature) continue;
    after.set(id, {
      geometry: translated(feature.geometry, 3e-5, 3e-5),
      style: { ...feature.style, ...colored('#e15759') },
    });
  }
  let undo: (() => void) | null = null;
  let redo: (() => void) | null = null;
  if (tables && rowsStore) {
    const handles = [...after.keys()].map((id) => tables.handleOf(id) as number);
    const patch: RowPatch = {
      handles: Int32Array.from(handles),
      fields: new Map<RowField, unknown[]>([
        ['geometry', [...after.values()].map((v) => v.geometry)],
        ['style', [...after.values()].map((v) => v.style)],
      ]),
    };
    let before: RowValuesSnapshot | null = null;
    let done: RowValuesSnapshot | null = null;
    undo = () => {
      done = before ? rowsStore.applyRows(before as RowPatch) : null;
    };
    redo = () => {
      before = rowsStore.applyRows(done ?? patch);
    };
    redo();
    const bytes = (before ? snapshotBytes(before) : 0) * 2;
    notes.push(
      `history ${(bytes / 1024).toFixed(1)} KB (the values before and after, ${handles.length} rows)`,
    );
  } else {
    const previous = [...after.keys()].map((id) => {
      const feature = draw.features.get(id) as Feature;
      return { id, patch: { geometry: feature.geometry, style: feature.style } };
    });
    const next = [...after].map(([id, values]) => ({ id, patch: values }));
    undo = () => {
      draw.features.updateMany(previous as never);
    };
    redo = () => {
      draw.features.updateMany(next as never);
    };
    redo();
    const bytes = JSON.stringify(previous).length + JSON.stringify(next).length;
    notes.push(`history ${(bytes / 1024).toFixed(1)} KB (the features before and after)`);
  }
  return async (i) => {
    const t0 = performance.now();
    if (i % 2 === 0) undo?.();
    else redo?.();
    inputs.push(performance.now() - t0);
  };
}

/** The times of the inputs of the edits of a feature at a time, as they are made (ms) */
const inputs: number[] = [];

/** Sends an event of the mouse to the canvas of the map, at a point of the map (CSS px) */
function mouse(
  map: maplibregl.Map,
  type: 'mousemove' | 'mousedown' | 'mouseup' | 'click',
  x: number,
  y: number,
  buttons = 0,
): void {
  const canvas = map.getCanvas();
  const rect = canvas.getBoundingClientRect();
  canvas.dispatchEvent(
    new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      clientX: rect.left + x,
      clientY: rect.top + y,
      button: 0,
      buttons,
      view: window,
    }),
  );
}

/** A position inside a feature (the mean of the corners of a polygon, a point, a vertex of a line) */
function insideOf(feature: Feature): Position | null {
  const geometry = feature.geometry;
  switch (geometry.type) {
    case 'Point':
      return geometry.coordinates;
    case 'LineString':
      return geometry.coordinates[Math.floor(geometry.coordinates.length / 2)];
    case 'Polygon': {
      const ring = geometry.coordinates[0].slice(0, -1);
      if (ring.length === 0) return null;
      const x = ring.reduce((sum, p) => sum + p[0], 0) / ring.length;
      const y = ring.reduce((sum, p) => sum + p[1], 0) / ring.length;
      return [x, y];
    }
    default:
      return null;
  }
}

/** A polygon with a vertex put after its first corner, at an offset of the middle of its first edge */
function withVertex(geometry: Geometry, offset: number): Geometry {
  if (geometry.type !== 'Polygon') return geometry;
  const ring = geometry.coordinates[0].slice();
  const [a, b] = ring;
  ring.splice(1, 0, [(a[0] + b[0]) / 2 + offset, (a[1] + b[1]) / 2 + offset]);
  return { type: 'Polygon', coordinates: [ring, ...geometry.coordinates.slice(1)] };
}

/** A polygon without the vertex after its first corner (as long as 3 corners stay) */
function withoutVertex(geometry: Geometry): Geometry | null {
  if (geometry.type !== 'Polygon') return null;
  const ring = geometry.coordinates[0].slice();
  if (ring.length <= 4) return null;
  ring.splice(1, 1);
  return { type: 'Polygon', coordinates: [ring, ...geometry.coordinates.slice(1)] };
}

/**
 * The steps of the edits of a feature at a time, made as the select mode makes them (the times
 * of their inputs go to `times`)
 */
function featureSteps(
  target: EditTarget,
  op: 'hover' | 'click' | 'vertexAdd' | 'vertexRemove' | 'delete',
  times: number[],
): ((i: number) => Promise<void>) | string {
  const { map, store, candidates } = target;
  const polygons = candidates.polygons.length > 0 ? candidates.polygons : candidates.ids;
  if (polygons.length === 0) return 'no feature';
  switch (op) {
    case 'hover': {
      // Around the center of the map, a move per frame: the cursor follows what it is over
      const canvas = map.getCanvas();
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      return async (i) => {
        const a = i * 0.21;
        const r = Math.min(width, height) * (0.1 + 0.3 * ((i % 50) / 50));
        const t0 = performance.now();
        mouse(map, 'mousemove', width / 2 + r * Math.cos(a), height / 2 + r * Math.sin(a));
        times.push(performance.now() - t0);
      };
    }
    case 'click':
      // A building clicked, to the frame its handles are drawn in
      return async (i) => {
        const id = polygons[i % polygons.length];
        const feature = featureOf(target, id);
        const inside = feature ? insideOf(feature) : null;
        if (!inside) return;
        map.jumpTo({ center: [inside[0], inside[1]] });
        await nextFrame();
        const point = map.project([inside[0], inside[1]]);
        const t0 = performance.now();
        mouse(map, 'mousedown', point.x, point.y, 1);
        mouse(map, 'mouseup', point.x, point.y);
        mouse(map, 'click', point.x, point.y);
        await nextFrame();
        await nextFrame();
        times.push(performance.now() - t0);
      };
    case 'vertexAdd': {
      // A drag of a midpoint of a building selected: the vertex put, moved over frames, ended
      const id = candidates.polygon ?? polygons[0];
      return async (i) => {
        store.setSelection('feature', [id]);
        const feature = store.getFeature(id);
        if (!feature) return;
        const start = withVertex(feature.geometry, 0);
        store.updateFeature(id, { geometry: start });
        const d = (i % 2 === 0 ? 1 : -1) * 1e-6;
        for (let f = 1; f <= 6; f++) {
          store.updateFeature(
            id,
            { geometry: withVertex(feature.geometry, f * d) },
            {
              isIntermediate: true,
            },
          );
          await nextFrame();
        }
        store.updateFeature(id, { geometry: withVertex(feature.geometry, 6 * d) });
      };
    }
    case 'vertexRemove': {
      // A vertex of a building selected taken off, then put back
      const id = candidates.polygon ?? polygons[0];
      return async () => {
        store.setSelection('feature', [id]);
        const feature = store.getFeature(id);
        if (!feature) return;
        const fewer = withoutVertex(withVertex(feature.geometry, 0));
        if (fewer) store.updateFeature(id, { geometry: withVertex(feature.geometry, 0) });
        await nextFrame();
        if (fewer) store.updateFeature(id, { geometry: fewer });
      };
    }
    case 'delete': {
      // A feature selected and deleted
      let next = 0;
      return async () => {
        while (next < polygons.length && !store.getFeature(polygons[next])) next++;
        const id = polygons[next++];
        if (!id) return;
        store.setSelection('feature', [id]);
        await nextFrame();
        store.deleteFeature(id);
      };
    }
  }
}

/** The groups of features the reorders of others move, made once per page */
let benchGroups: string[] | null = null;

/**
 * Makes the groups of features the reorders of others move: `groups` groups of `members` rows
 * each, every one at the key of one of its members
 */
function ensureGroups(target: EditTarget, params: TableBenchPageParams): string[] {
  if (benchGroups) return benchGroups;
  const ids = target.candidates.ids;
  const out: string[] = [];
  const count = Math.min(params.groups, Math.floor(ids.length / params.members));
  const { tables, writer } = target;
  for (let g = 0; g < count; g++) {
    const id = `benchGroup${g}`;
    const members = ids.slice(g * params.members, (g + 1) * params.members);
    if (tables && writer) {
      writer.applyGroups({
        handles: Int32Array.of(1000 + g),
        fields: new Map<'id' | 'order' | 'layerId', unknown[]>([
          ['id', [id]],
          ['order', [keyAfter(params, (g * rowCount(target)) / count, 'g')]],
          ['layerId', [target.layerId]],
        ]),
      });
      const handles = members.map((m) => tables.handleOf(m)).filter((h) => h !== undefined);
      writer.apply({
        handles: Int32Array.from(handles as number[]),
        fields: new Map<RowField, unknown[]>([
          ['groupId', handles.map(() => id)],
          ['member', handles.map((_, k) => `m${String(k).padStart(4, '0')}`)],
        ]),
      });
    } else {
      target.draw.groups.create({ id, featureIds: members });
    }
    out.push(id);
  }
  benchGroups = out;
  return out;
}

/** What the writes in place hold and did now (zero for features of the Store) */
function statsOf(target: EditTarget): TableEditStats {
  return target.draw.debug.tables().editStats();
}

/**
 * Runs `run` between frames measured before and after it, with what the frames took (`run`
 * calls `sample` once per frame; it returns the number of changes made)
 */
async function measured(
  target: EditTarget,
  name: string,
  run: (sample: () => void) => Promise<number>,
): Promise<EditResult> {
  const { draw, map } = target;
  const before = phaseOf(draw, `${name}: before`, await idleFrames(map));
  const statsBefore = statsOf(target);
  const cpu: number[] = [];
  let changes = 0;
  let peak: number | null = heapMb();
  const intervals = await recordFrames(map, async () => {
    changes = await run(() => {
      const stats = statsOf(target);
      cpu.push(stats.prerenderMs + stats.drawMs);
      const heap = heapMb();
      if (heap !== null) peak = Math.max(peak ?? 0, heap);
    });
  });
  const during = phaseOf(draw, `${name}: during`, intervals);
  const after = phaseOf(draw, `${name}: after`, await idleFrames(map));
  return {
    name,
    before,
    during,
    after,
    statsBefore,
    statsAfter: statsOf(target),
    frameCpuMs: {
      mean: cpu.length > 0 ? cpu.reduce((a, b) => a + b, 0) / cpu.length : 0,
      max: cpu.length > 0 ? Math.max(...cpu) : 0,
    },
    changes,
    peakHeapMb: peak,
  };
}

/** Repeats an edit, one change per frame, and measures it */
export async function runEdit(
  target: EditTarget,
  op: EditOp,
  params: TableBenchPageParams,
): Promise<EditResult> {
  inputs.length = 0;
  notes.length = 0;
  const steps = stepsOf(target, op, params);
  if (typeof steps === 'string') return failed(target, `${op} x${params.reps}`, steps);
  const result = await measured(target, `${op} x${params.reps}`, async (sample) => {
    for (let i = 0; i < params.reps; i++) {
      await steps(i);
      await nextFrame();
      sample();
    }
    return params.reps;
  });
  const noted = notes.length > 0 ? { notes: [...new Set(notes)] } : {};
  if (inputs.length === 0) return { ...result, ...noted };
  return {
    ...result,
    ...noted,
    inputMs: {
      mean: inputs.reduce((a, b) => a + b, 0) / inputs.length,
      max: Math.max(...inputs),
      count: inputs.length,
    },
  };
}

/** Sends the changes of others of a kind at a rate for a time, and measures it */
export async function runStream(
  target: EditTarget,
  kind: RemoteKind,
  params: TableBenchPageParams,
): Promise<EditResult> {
  if (kind === 'import') return runImport(target, params);
  if (kind === 'reorder' || kind === 'group') return runReorders(target, kind, params);
  const { candidates } = target;
  const pool =
    kind === 'position'
      ? candidates.points
      : kind === 'corner' || kind === 'vertex'
        ? candidates.polygons
        : candidates.ids;
  const name = `stream ${kind} ${params.rate}/s ${params.seconds}s`;
  if (pool.length === 0) return failed(target, name, `no row for ${kind}`);
  let next = 0;
  let sent = 0;
  const changeOf = (id: string): RowChange | null => {
    const n = sent++;
    switch (kind) {
      case 'color':
        return { style: colored(hue((n * 47) % 360)) };
      case 'attr':
        return { properties: n % 2 === 0 ? { name: `remote ${n}` } : { height: n % 97 } };
      case 'position':
      case 'corner': {
        const geometry = featureOf(target, id)?.geometry;
        if (!geometry) return null;
        const d = (n % 2 === 0 ? 1 : -1) * 2e-5;
        return { geometry: moved(geometry, () => (kind === 'corner' ? 1 : 0), d, d) };
      }
      case 'vertex': {
        // A vertex added between the first two corners: past the place of the row
        const geometry = featureOf(target, id)?.geometry;
        if (geometry?.type !== 'Polygon') return null;
        const ring = geometry.coordinates[0].slice();
        const [a, b] = ring;
        ring.splice(1, 0, [(a[0] + b[0]) / 2 + 1e-5, (a[1] + b[1]) / 2 + 1e-5]);
        return {
          geometry: { type: 'Polygon', coordinates: [ring, ...geometry.coordinates.slice(1)] },
        };
      }
      default:
        return null;
    }
  };
  return measured(target, name, async (sample) => {
    const end = performance.now() + params.seconds * 1000;
    let last = performance.now();
    let carry = 0;
    while (performance.now() < end) {
      await nextFrame();
      const now = performance.now();
      carry += (params.rate * (now - last)) / 1000;
      last = now;
      const count = Math.floor(carry);
      carry -= count;
      const changes: Array<[string, RowChange]> = [];
      for (let k = 0; k < count; k++) {
        const id = pool[next++ % pool.length];
        const change = changeOf(id);
        if (change) changes.push([id, change]);
      }
      writeRows(target, changes);
      sample();
    }
    return sent;
  });
}

/**
 * Sends reorders of others at a rate for a time: rows put in another place of the order, or
 * groups of features put in another place (made first)
 */
async function runReorders(
  target: EditTarget,
  kind: 'reorder' | 'group',
  params: TableBenchPageParams,
): Promise<EditResult> {
  const name = `stream ${kind} ${params.rate}/s ${params.seconds}s`;
  const pool = kind === 'group' ? ensureGroups(target, params) : target.candidates.ids;
  if (pool.length === 0) return failed(target, name, `no row for ${kind}`);
  // The groups made settle before the run
  if (kind === 'group') await idleFrames(target.map, 120);
  const count = rowCount(target);
  let sent = 0;
  let seed = 7;
  const random = (): number => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    return seed / 2_147_483_648;
  };
  const send = (n: number): void => {
    const { tables, writer, draw } = target;
    const ids: string[] = [];
    const orders: string[] = [];
    const indices: number[] = [];
    for (let k = 0; k < n; k++) {
      ids.push(pool[Math.floor(random() * pool.length)]);
      const at = random() * count;
      orders.push(keyAfter(params, at, `r${sent++}`));
      indices.push(Math.floor(at));
    }
    if (kind === 'group') {
      if (tables && writer) {
        writer.applyGroups({
          handles: Int32Array.from(ids.map((id) => 1000 + pool.indexOf(id))),
          fields: new Map([['order', orders]]),
        });
      } else {
        ids.forEach((id, k) => {
          draw.groups.move(id, { layerId: target.layerId, index: indices[k] });
        });
      }
      return;
    }
    if (tables && writer) {
      const handles = ids.map((id) => tables.handleOf(id));
      writer.apply({
        handles: Int32Array.from(handles.filter((h) => h !== undefined) as number[]),
        fields: new Map<RowField, unknown[]>([
          ['order', orders.filter((_, k) => handles[k] !== undefined)],
        ]),
      });
    } else {
      ids.forEach((id, k) => {
        draw.features.move(id, { layerId: target.layerId, index: indices[k] });
      });
    }
  };
  return measured(target, name, async (sample) => {
    const end = performance.now() + params.seconds * 1000;
    let last = performance.now();
    let carry = 0;
    while (performance.now() < end) {
      await nextFrame();
      const now = performance.now();
      carry += (params.rate * (now - last)) / 1000;
      last = now;
      const n = Math.floor(carry);
      carry -= n;
      if (n > 0) send(n);
      sample();
    }
    return sent;
  });
}

/**
 * Sends the import of others: `importN` new rows (buildings), a transaction of `txn` rows at a
 * time at `rate` rows per second, after the rows of the layer; run until every row is sent
 */
async function runImport(target: EditTarget, params: TableBenchPageParams): Promise<EditResult> {
  const name = `import ${params.importN} by ${params.txn} at ${params.rate}/s`;
  const center = target.map.getCenter();
  const columns = Math.ceil(Math.sqrt(params.importN));
  const size = 2e-4;
  let sent = 0;
  const stamp = Date.now().toString(36);
  const sendTransaction = (): void => {
    const n = Math.min(params.txn, params.importN - sent);
    const rows = Array.from({ length: n }, (_, k) => {
      const i = sent + k;
      return {
        id: `import${stamp}-${i}`,
        geometry: buildingAt(
          center.lng + ((i % columns) - columns / 2) * size * 1.5,
          center.lat + (Math.floor(i / columns) - columns / 2) * size * 1.5,
          size,
        ),
        // After every row of the layer: a run no row is within
        order: `z${String(i).padStart(9, '0')}`,
        index: rowCount(target) + k,
      };
    });
    createRows(target, rows, { fillColor: '#e15759', fillOpacity: 0.5, strokeWidth: 1 });
    sent += n;
  };
  return measured(target, name, async (sample) => {
    let last = performance.now();
    let carry = 0;
    while (sent < params.importN) {
      await nextFrame();
      const now = performance.now();
      carry += (params.rate * (now - last)) / 1000;
      last = now;
      while (carry >= Math.min(params.txn, params.importN - sent) && sent < params.importN) {
        carry -= Math.min(params.txn, params.importN - sent);
        sendTransaction();
      }
      sample();
    }
    // The groups of the import built and drawn
    for (let i = 0; i < 600 && target.draw.hasPendingWork(); i++) {
      await nextFrame();
      sample();
    }
    return sent;
  });
}

/** A run that could not be made */
function failed(target: EditTarget, name: string, error: string): EditResult {
  const empty = phaseOf(target.draw, name, []);
  const stats = statsOf(target);
  return {
    name,
    before: empty,
    during: empty,
    after: empty,
    statsBefore: stats,
    statsAfter: stats,
    frameCpuMs: { mean: 0, max: 0 },
    changes: 0,
    peakHeapMb: null,
    error,
  };
}
