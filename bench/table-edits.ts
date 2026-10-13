// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The edits of the page of the layers held as rows, repeated, and the changes of others sent at
 * a rate
 *
 * An edit is repeated a number of times, one change per frame (`EDIT_OPS`): a color changed, a
 * color slid, the colors of the steps of a graduated style rule slid, an attribute written (a
 * string, then a number), a point moved, a vertex of the longest line moved, a corner of a
 * building moved. The changes of others are sent at a rate for a time, of one kind: colors,
 * attributes, positions of points, corners of buildings. Rows held as columns are written
 * through the writer of their tables, as the implementation of a Store writes them; features of
 * the Store through `draw.features.update`, as it is drawn today, to compare.
 *
 * Each run measures the frames before, during and after it, the JS heap and the GPU memory, and
 * what the writes in place hold and did (`draw.debug.tables().editStats()`).
 */

import type {
  Draw,
  Feature,
  FeatureTables,
  FeatureTablesWriter,
  RowField,
  TableEditStats,
} from '@sakuzu/maplibre-gl-draw';
import type { Geometry, Position } from 'geojson';
import type * as maplibregl from 'maplibre-gl';
import type { BenchCandidates, EditOp, RemoteKind, TableBenchPageParams } from './table-data';
import { idleFrames, nextFrame, type PhaseResult, phaseOf, recordFrames } from './table-measure';

/** What the edits write to */
export interface EditTarget {
  readonly mode: 'table' | 'store';
  readonly draw: Draw;
  readonly map: maplibregl.Map;
  readonly layerId: string;
  /** The tables of the page (rows held as columns), or null for features of the Store */
  readonly tables: FeatureTables | null;
  readonly writer: FeatureTablesWriter | null;
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
  }
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
  const intervals = await recordFrames(map, async () => {
    changes = await run(() => {
      const stats = statsOf(target);
      cpu.push(stats.prerenderMs + stats.drawMs);
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
  };
}

/** Repeats an edit, one change per frame, and measures it */
export async function runEdit(
  target: EditTarget,
  op: EditOp,
  params: TableBenchPageParams,
): Promise<EditResult> {
  const steps = stepsOf(target, op, params);
  if (typeof steps === 'string') return failed(target, `${op} x${params.reps}`, steps);
  return measured(target, `${op} x${params.reps}`, async (sample) => {
    for (let i = 0; i < params.reps; i++) {
      await steps(i);
      await nextFrame();
      sample();
    }
    return params.reps;
  });
}

/** Sends the changes of others of a kind at a rate for a time, and measures it */
export async function runStream(
  target: EditTarget,
  kind: RemoteKind,
  params: TableBenchPageParams,
): Promise<EditResult> {
  const { candidates } = target;
  const pool =
    kind === 'position'
      ? candidates.points
      : kind === 'corner'
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
    error,
  };
}
