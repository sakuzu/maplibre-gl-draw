// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The tables of the features: taking row groups in, the handles, the state of the rows and the
 * reading of a layer
 */

import { utf8ColumnFromStrings } from '@sakuzu/tabane';
import type { Geometry, Position } from 'geojson';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import type { LayerTableView } from '../api/tables.js';
import type { FeatureRowInput as RowInput } from '../table/feature-row-blocks.js';
import type { RowBlockData } from '../table/row-group-types.js';
import { FEATURE_TABLE_COLUMNS } from '../table/tabane/columns.js';
import { featureRowDataBuilder as createRowBlockDataBuilder } from '../test-utils.js';
import {
  GPU_STATE_BULK,
  GPU_STATE_HIDDEN,
  GPU_STATE_UNIFORM,
  STATE_BULK,
  STATE_HIDDEN_DELETED,
  STATE_HIDDEN_INVISIBLE,
  STATE_HIDDEN_LOCAL,
  toGpuState,
} from './feature-row-states.js';
import { createFeatureTablesStore } from './feature-row-tables.js';
import { type FeatureTablesInternals, featureTablesInternals } from './feature-tables.js';
import type { RowTable } from './row-table.js';

const point = (x: number, y: number): Geometry => ({ type: 'Point', coordinates: [x, y] });

/** Builds the groups of rows `prefix0..` with keys `k000..` */
function groups(
  count: number,
  options: {
    prefix?: string;
    keyOffset?: number;
    targetRows?: number;
    extra?: Partial<RowInput>;
  } = {},
): RowBlockData[] {
  const builder = createRowBlockDataBuilder({
    columns: FEATURE_TABLE_COLUMNS,
    targetRows: options.targetRows,
  });
  for (let i = 0; i < count; i++) {
    const n = i + (options.keyOffset ?? 0);
    builder.addRow({
      id: `${options.prefix ?? 'r'}${n}`,
      type: 'Point',
      geometry: point(n, n),
      key: `k${String(n).padStart(3, '0')}`,
      properties: { n, name: `name ${n}` },
      style: { pointColor: n % 2 === 0 ? '#ff0000' : '#0000ff' },
      ...options.extra,
    });
  }
  return builder.finish();
}

describe('a row block that cannot be added', () => {
  it('is refused at once, and no row block given with it is added', () => {
    const { tables, writer } = createFeatureTablesStore();
    writer.addRowBlocks('layer', groups(3));
    // Its ids are rows already
    expect(() =>
      writer.addRowBlocks('layer', [...groups(2, { prefix: 'x' }), ...groups(2)]),
    ).toThrow(expect.objectContaining({ code: 'already-exists' }));
    expect(tables.get('layer')?.rowCount).toBe(3);
  });
});

describe('the counts and the lists of the rows of a layer', () => {
  it('count the rows not deleted, and every row read with rowCountWithDeleted, which the list reads', () => {
    const { tables, writer } = createFeatureTablesStore();
    writer.addRowBlocks('layer', groups(6, { targetRows: 4 }));
    featureTablesInternals(tables)?.addQueuedRowBlocks();
    const view = tables.get('layer') as LayerTableView;
    writer.apply({
      handles: Int32Array.of(tables.findRow('r2') as number),
      fields: new Map(),
      deleted: Uint8Array.of(1),
    });
    expect(view.rowCount).toBe(5);
    expect(view.rowCountWithDeleted).toBe(6);
    expect(
      Array.from(view.listRowHandles(0, view.rowCountWithDeleted), (h) => tables.getRowId(h)),
    ).toEqual(['r0', 'r1', 'r2', 'r3', 'r4', 'r5']);
  });

  it('read the point of a row as a Position', () => {
    const { tables, writer } = createFeatureTablesStore();
    writer.addRowBlocks('layer', groups(2));
    featureTablesInternals(tables)?.addQueuedRowBlocks();
    const view = tables.get('layer') as LayerTableView;
    expectTypeOf(view.getRowPoint).returns.toEqualTypeOf<Position | null>();
    expect(view.getRowPoint(tables.findRow('r1') as number)).toEqual([1, 1]);
  });
});

describe('createFeatureTables', () => {
  it('takes row groups into a layer and gives their rows handles', () => {
    const { tables, writer } = createFeatureTablesStore();
    writer.addRowBlocks('layer', groups(10, { targetRows: 4 }));
    const view = tables.get('layer');
    expect(view?.rowCount).toBe(10);
    expect(tables.get('other')).toBeUndefined();
    const handle = tables.findRow('r3') as number;
    expect(tables.getRowId(handle)).toBe('r3');
    expect(view?.getRowPoint(handle)).toEqual([3, 3]);
    expect(view?.getRowValue(handle, 'name')).toBe('name 3');
    expect(view?.getRowValue(handle, 'missing')).toBeUndefined();
    expect(view?.getRowType(handle)).toBe('Point');
    expect(Array.from(view?.listRowHandles(0, 10) ?? []).map((h) => tables.getRowId(h))).toEqual(
      Array.from({ length: 10 }, (_, i) => `r${i}`),
    );
    expect(Array.from(view?.listRowHandles(8, 5) ?? []).map((h) => tables.getRowId(h))).toEqual([
      'r8',
      'r9',
    ]);
  });

  it('keeps handles given beforehand', () => {
    const { tables, writer } = createFeatureTablesStore();
    const [group] = groups(3);
    const handles = writer.allocateHandles(group.ids, group.idHashes);
    group.handles.set(handles);
    writer.addRowBlocks('layer', [group]);
    expect(tables.findRow('r1')).toBe(handles[1]);
  });

  it('numbers the styles of the groups in one table', () => {
    const { tables, writer } = createFeatureTablesStore();
    writer.addRowBlocks('layer', groups(4, { targetRows: 2 }));
    const internals = featureTablesInternals(tables);
    expect(internals?.styles.size).toBe(2);
    const view = tables.get('layer');
    const red = view?.getRow(tables.findRow('r0') as number);
    const alsoRed = view?.getRow(tables.findRow('r2') as number);
    expect(red?.style).toEqual({ pointColor: '#ff0000' });
    expect(red?.style).toBe(alsoRed?.style);
  });

  it('reads a row back as a feature', () => {
    const { tables, writer } = createFeatureTablesStore();
    writer.addRowBlocks('layer', groups(2, { extra: { locked: true } }));
    const feature = tables.get('layer')?.getRow(tables.findRow('r1') as number);
    expect(feature).toEqual({
      id: 'r1',
      type: 'Point',
      geometry: { type: 'Point', coordinates: [1, 1] },
      layerId: 'layer',
      groupId: undefined,
      properties: { n: 1, name: 'name 1' },
      style: { pointColor: '#0000ff' },
      locked: true,
      visible: true,
    });
  });

  it('puts the groups of separate calls at their places in the order', () => {
    const { tables, writer } = createFeatureTablesStore();
    writer.addRowBlocks('layer', groups(3, { keyOffset: 10, prefix: 'b' }));
    writer.addRowBlocks('layer', groups(3, { keyOffset: 0, prefix: 'a' }));
    writer.addRowBlocks('layer', groups(3, { keyOffset: 20, prefix: 'c' }));
    const view = tables.get('layer');
    expect(Array.from(view?.listRowHandles(0, 9) ?? []).map((h) => tables.getRowId(h))).toEqual([
      'a0',
      'a1',
      'a2',
      'b10',
      'b11',
      'b12',
      'c20',
      'c21',
      'c22',
    ]);
  });

  it('puts the rows of a group whose keys overlap another group in the delta, at their places', () => {
    const { tables, writer } = createFeatureTablesStore();
    writer.addRowBlocks('layer', groups(5));
    // Not left out: read and drawn at their places at once
    expect(() =>
      writer.addRowBlocks('layer', groups(2, { keyOffset: 3, prefix: 'x' })),
    ).not.toThrow();
    const internals = featureTablesInternals(tables) as FeatureTablesInternals;
    const x3 = tables.findRow('x3') as number;
    expect(internals.ids.deltaTable(x3)).toBeGreaterThanOrEqual(0);
    const view = tables.get('layer');
    const ids = () => Array.from(view?.listRowHandles(0, 10) ?? []).map((h) => tables.getRowId(h));
    const order = ['r0', 'r1', 'r2', 'r3', 'x3', 'r4', 'x4'];
    expect(ids()).toEqual(order);
    expect(view?.getRow(x3)?.properties).toEqual({ n: 3, name: 'name 3' });
    expect(view?.getRowPoint(x3)).toEqual([3, 3]);
    const drawn = Array.from(view?.listDrawnRows([-1, -1, 10, 10]) ?? []).map((h) =>
      tables.getRowId(h),
    );
    expect(drawn).toEqual(order);
    // And into the row groups with their next versions
    internals.flushVersions();
    expect(internals.ids.deltaTable(x3)).toBeLessThan(0);
    expect(internals.ids.mainGroup(x3)).toBeGreaterThanOrEqual(0);
    expect(ids()).toEqual(order);
  });

  it('puts the rows of a group not in the order of their keys in the delta, at their places', () => {
    const { tables, writer } = createFeatureTablesStore();
    writer.addRowBlocks('layer', groups(3));
    // u100 and u101 with their keys swapped: u101 comes first
    const [built] = groups(2, { keyOffset: 100, prefix: 'u' });
    const swapped = { ...built, keys: utf8ColumnFromStrings(['k101', 'k100']) };
    expect(() => writer.addRowBlocks('layer', [swapped])).not.toThrow();
    const internals = featureTablesInternals(tables) as FeatureTablesInternals;
    const u100 = tables.findRow('u100') as number;
    expect(internals.ids.deltaTable(u100)).toBeGreaterThanOrEqual(0);
    const view = tables.get('layer');
    const ids = () => Array.from(view?.listRowHandles(0, 10) ?? []).map((h) => tables.getRowId(h));
    const order = ['r0', 'r1', 'r2', 'u101', 'u100'];
    expect(ids()).toEqual(order);
    const drawn = Array.from(view?.listDrawnRows([-1, -1, 200, 200]) ?? []).map((h) =>
      tables.getRowId(h),
    );
    expect(drawn).toEqual(order);
    expect(view?.getRowPoint(u100)).toEqual([100, 100]);
    internals.flushVersions();
    expect(internals.ids.mainGroup(u100)).toBeGreaterThanOrEqual(0);
    expect(ids()).toEqual(order);
  });

  it('refuses an id that is already a row, and an unknown group', () => {
    const { writer } = createFeatureTablesStore();
    writer.addRowBlocks('layer', groups(5));
    expect(() => writer.addRowBlocks('layer', groups(1, { keyOffset: 50 }))).not.toThrow();
    expect(() => writer.addRowBlocks('other', groups(1, { keyOffset: 50 }))).toThrow(
      /already a row/,
    );
    expect(() =>
      writer.addRowBlocks('layer', groups(1, { keyOffset: 60, prefix: 'g', extra: { group: 3 } })),
    ).toThrow();
  });

  it('refuses a group whose arrays do not have one entry per row', () => {
    // Refused before anything is queued
    const { writer } = createFeatureTablesStore();
    const [group] = groups(3);
    const broken = { ...group, flags: new Uint8Array(2) };
    expect(() => writer.addRowBlocks('layer', [broken])).toThrow(/flags/);
  });

  it('hides the rows that are not shown or are deleted, and not their handles', () => {
    const { tables, writer } = createFeatureTablesStore();
    const builder = createRowBlockDataBuilder({ columns: FEATURE_TABLE_COLUMNS });
    builder.addRow({ id: 'shown', type: 'Point', geometry: point(0, 0), key: 'a' });
    builder.addRow({
      id: 'hidden',
      type: 'Point',
      geometry: point(0, 0),
      key: 'b',
      hidden: true,
    });
    builder.addRow({ id: 'gone', type: 'Point', geometry: point(0, 0), key: 'c', deleted: true });
    builder.addRow({ id: 'circle', type: 'Circle', geometry: point(0, 0), key: 'd' });
    writer.addRowBlocks('layer', builder.finish());
    const internals = featureTablesInternals(tables);
    const group = internals?.rowTable('layer')?.groupAt(0);
    expect(Array.from(group?.state ?? []).slice(0, 3)).toEqual([
      0,
      STATE_HIDDEN_INVISIBLE,
      STATE_HIDDEN_DELETED,
    ]);
    expect(Array.from(group?.gpuState ?? [])).toEqual([
      0,
      GPU_STATE_HIDDEN,
      GPU_STATE_HIDDEN,
      GPU_STATE_UNIFORM,
    ]);
    expect(tables.findRow('gone')).toBeUndefined();
    expect(tables.findRow('hidden')).toBeDefined();
    const view = tables.get('layer');
    const all: [number, number, number, number] = [-1, -1, 1, 1];
    expect(Array.from(view?.listDrawnRows(all) ?? []).map((h) => tables.getRowId(h))).toEqual([
      'shown',
      'circle',
    ]);
  });

  it('makes the copies of the state again when the sets of handles change', () => {
    const { tables, writer } = createFeatureTablesStore();
    writer.addRowBlocks('layer', groups(6, { targetRows: 3 }));
    const internals = featureTablesInternals(tables);
    const layer = internals?.rowTable('layer') as RowTable;
    const versions = [layer.groupAt(0).stateVersion, layer.groupAt(1).stateVersion];
    const revision = tables.get('layer')?.getDrawnRowsRevision();
    const r4 = tables.findRow('r4') as number;
    internals?.states.setHidden(Int32Array.of(r4), true);
    internals?.states.setBulk(Int32Array.of(r4, tables.findRow('r0') as number), true);
    expect(layer.groupAt(1).state[1]).toBe(STATE_HIDDEN_LOCAL | STATE_BULK);
    expect(layer.groupAt(1).gpuState[1]).toBe(GPU_STATE_HIDDEN | GPU_STATE_BULK);
    expect(layer.groupAt(0).gpuState[0]).toBe(GPU_STATE_BULK);
    expect(layer.groupAt(0).stateVersion).toBe(versions[0] + 1);
    expect(layer.groupAt(1).stateVersion).toBe(versions[1] + 2);
    expect(tables.get('layer')?.getDrawnRowsRevision()).not.toBe(revision);
    internals?.states.setMoving(Int32Array.of(r4), 2);
    expect((layer.groupAt(1).gpuState[1] >> 1) & 3).toBe(2);
    expect(toGpuState(layer.groupAt(1).state[1])).toBe(layer.groupAt(1).gpuState[1]);
    internals?.states.setHidden(Int32Array.of(r4), false);
    expect(layer.groupAt(1).gpuState[1] & GPU_STATE_HIDDEN).toBe(0);
  });

  it('gives nothing to a handle of another layer', () => {
    const { tables, writer } = createFeatureTablesStore();
    writer.addRowBlocks('a', groups(2, { prefix: 'a' }));
    writer.addRowBlocks('b', groups(2, { prefix: 'b' }));
    const handle = tables.findRow('a0') as number;
    expect(tables.get('b')?.getRow(handle)).toBeUndefined();
    expect(tables.get('b')?.getRowBBox(handle)).toBeNull();
    expect(tables.get('a')?.getRowBBox(handle)).toEqual([0, 0, 0, 0]);
  });

  it('allocates handles for the ids of a column', () => {
    const { tables, writer } = createFeatureTablesStore();
    const handles = writer.allocateHandles(utf8ColumnFromStrings(['x', 'y']));
    expect(tables.getRowId(handles[1])).toBe('y');
    // A handle with no row yet is not a row
    expect(tables.findRow('x')).toBeUndefined();
  });
});

describe('RowTable', () => {
  it('finds the place of a key and orders places', () => {
    const { tables, writer } = createFeatureTablesStore();
    writer.addRowBlocks('layer', groups(6, { targetRows: 3 }));
    const layer = featureTablesInternals(tables)?.rowTable('layer') as RowTable;
    const [first, second] = layer.groupHandles;

    const key = (order: string, id: string) => ({
      ids: utf8ColumnFromStrings([id]),
      keys: utf8ColumnFromStrings([order]),
      groups: Int32Array.of(-1),
    });
    // The key of an existing row is that row
    expect(layer.positionOfKey(key('k004', 'r4'), 0)).toEqual({ group: second, slot: 3, k: 0 });
    // Between rows: just before the first row that does not come before it
    expect(layer.positionOfKey(key('k0015', 'x'), 0)).toEqual({ group: first, slot: 4, k: 0 });
    // Before every row, and after every row
    expect(layer.positionOfKey(key('a', 'x'), 0)).toEqual({ group: first, slot: 0, k: 0 });
    expect(layer.positionOfKey(key('z', 'x'), 0, 2)).toEqual({ group: second, slot: 6, k: 2 });

    const p = (group: number, slot: number, k = 0) => ({ group, slot, k });
    expect(layer.comparePositions(p(first, 5), p(second, 0))).toBeLessThan(0);
    expect(layer.comparePositions(p(second, 1), p(second, 2))).toBeLessThan(0);
    expect(layer.comparePositions(p(second, 2, 1), p(second, 2, 0))).toBeGreaterThan(0);
    expect(() => layer.comparePositions(p(99, 0), p(first, 0))).toThrow();
  });
});

describe('adding row blocks', () => {
  it('takes them in at once, in the order of their keys, and returns their rows created', () => {
    const { tables, writer } = createFeatureTablesStore();
    const internals = featureTablesInternals(tables);
    if (!internals) throw new Error('no internals');
    const before = internals.revision;
    const added = writer.addRowBlocks('layer', groups(9, { targetRows: 3 }));
    expect(internals.hasQueuedBlocks).toBe(false);
    expect(internals.revision).toBeGreaterThan(before);
    expect(tables.get('layer')?.rowCount).toBe(9);
    expect(added.layers.get('layer')?.created.length).toBe(9);
    expect(added.layers.get('layer')?.fields.has('properties:name')).toBe(true);
    writer.addRowBlocks('layer', groups(3, { keyOffset: 20, prefix: 'z', targetRows: 3 }));
    const view = tables.get('layer');
    expect(Array.from(view?.listRowHandles(0, 12) ?? []).map((h) => tables.getRowId(h))).toEqual([
      ...Array.from({ length: 9 }, (_, i) => `r${i}`),
      'z20',
      'z21',
      'z22',
    ]);
  });

  it('puts a row block whose keys overlap the rows of the layer in the delta', () => {
    const { tables, writer } = createFeatureTablesStore();
    const internals = featureTablesInternals(tables);
    if (!internals) throw new Error('no internals');
    writer.addRowBlocks('layer', groups(5));
    writer.addRowBlocks('layer', groups(2, { keyOffset: 3, prefix: 'x' }));
    writer.addRowBlocks('layer', groups(2, { keyOffset: 10, prefix: 'y' }));
    expect(tables.findRow('x3')).toBeDefined();
    expect(tables.findRow('y10')).toBeDefined();
    expect(internals.deltaRowCount()).toBe(2);
  });

  it('refuses at once, and queues nothing, when a row names an unknown group', () => {
    const { tables, writer } = createFeatureTablesStore();
    const internals = featureTablesInternals(tables);
    expect(() =>
      writer.addRowBlocks('layer', [
        ...groups(1),
        ...groups(1, { keyOffset: 60, prefix: 'g', extra: { group: 3 } }),
      ]),
    ).toThrow(/unknown/);
    expect(internals?.hasQueuedBlocks).toBe(false);
    expect(tables.get('layer')?.rowCount ?? 0).toBe(0);
  });

  it('gives the rows handles from the hashes the groups carry (not hashing on the main thread)', () => {
    const { tables, writer } = createFeatureTablesStore();
    const internals = featureTablesInternals(tables);
    if (!internals) throw new Error('no internals');
    const [group] = groups(3);
    const allocate = vi.spyOn(internals.ids, 'allocate');
    writer.addRowBlocks('layer', [group]);
    internals.addQueuedRowBlocks();
    expect(allocate).toHaveBeenCalledTimes(1);
    expect(allocate.mock.calls[0][1]).toBe(group.idHashes);
    for (const id of ['r0', 'r1', 'r2']) expect(tables.findRow(id)).toBeDefined();
  });
});
