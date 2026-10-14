// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The tables of the features: taking row groups in, the handles, the state of the rows and the
 * reading of a layer
 */

import type { Geometry } from 'geojson';
import { describe, expect, it, vi } from 'vitest';
import { createRowGroupBuilder, type RowInput } from '../table/row-group-builder.js';
import type { RowGroupData } from '../table/row-group-types.js';
import { utf8ColumnFromStrings } from '../table/utf8-column.js';
import {
  createFeatureTablesStore,
  type FeatureTablesInternals,
  featureTablesInternals,
} from './feature-tables.js';
import type { LayerTable } from './layer-table.js';
import {
  GPU_STATE_BULK,
  GPU_STATE_HIDDEN,
  GPU_STATE_UNIFORM,
  STATE_HIDDEN_DELETED,
  STATE_HIDDEN_INVISIBLE,
  STATE_HIDDEN_LOCAL,
  toGpuState,
} from './row-state.js';
import type { TableWorkBudget } from './types.js';

/**
 * Tables whose `adopt` takes the groups in at once (the queue and the budget are tested in
 * their own section)
 */
function createFeatureTables(): ReturnType<typeof createFeatureTablesStore> {
  const made = createFeatureTablesStore();
  const internals = featureTablesInternals(made.tables);
  return {
    tables: made.tables,
    writer: {
      ...made.writer,
      adopt: (layerId, groups) => {
        made.writer.adopt(layerId, groups);
        internals?.flushAdoption();
      },
    },
  };
}

/** A budget of `steps` steps */
function stepBudget(steps: number): TableWorkBudget & { taken: number } {
  const budget = {
    taken: 0,
    canStep: () => budget.taken < steps,
    step: <T>(work: (deadline: number) => T): T => {
      budget.taken++;
      return work(Number.POSITIVE_INFINITY);
    },
  };
  return budget;
}

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
): RowGroupData[] {
  const builder = createRowGroupBuilder({ targetRows: options.targetRows });
  for (let i = 0; i < count; i++) {
    const n = i + (options.keyOffset ?? 0);
    builder.addRow({
      id: `${options.prefix ?? 'r'}${n}`,
      type: 'Point',
      geometry: point(n, n),
      order: `k${String(n).padStart(3, '0')}`,
      properties: { n, name: `name ${n}` },
      style: { pointColor: n % 2 === 0 ? '#ff0000' : '#0000ff' },
      ...options.extra,
    });
  }
  return builder.finish();
}

describe('createFeatureTables', () => {
  it('takes row groups into a layer and gives their rows handles', () => {
    const { tables, writer } = createFeatureTables();
    writer.adopt('layer', groups(10, { targetRows: 4 }));
    const view = tables.layer('layer');
    expect(view?.rowCount).toBe(10);
    expect(tables.layer('other')).toBeUndefined();
    const handle = tables.handleOf('r3') as number;
    expect(tables.idOf(handle)).toBe('r3');
    expect(view?.getRowPoint(handle)).toEqual([3, 3]);
    expect(view?.valueAt(handle, 'name')).toBe('name 3');
    expect(view?.valueAt(handle, 'missing')).toBeUndefined();
    expect(view?.getRowType(handle)).toBe('Point');
    expect(Array.from(view?.rowsInOrder(0, 10) ?? []).map((h) => tables.idOf(h))).toEqual(
      Array.from({ length: 10 }, (_, i) => `r${i}`),
    );
    expect(Array.from(view?.rowsInOrder(8, 5) ?? []).map((h) => tables.idOf(h))).toEqual([
      'r8',
      'r9',
    ]);
  });

  it('keeps handles given beforehand', () => {
    const { tables, writer } = createFeatureTables();
    const [group] = groups(3);
    const handles = writer.allocateHandles(group.ids, group.idHashes);
    group.handles.set(handles);
    writer.adopt('layer', [group]);
    expect(tables.handleOf('r1')).toBe(handles[1]);
  });

  it('numbers the styles of the groups in one table', () => {
    const { tables, writer } = createFeatureTables();
    writer.adopt('layer', groups(4, { targetRows: 2 }));
    const internals = featureTablesInternals(tables);
    expect(internals?.styles.size).toBe(2);
    const view = tables.layer('layer');
    const red = view?.getRow(tables.handleOf('r0') as number);
    const alsoRed = view?.getRow(tables.handleOf('r2') as number);
    expect(red?.style).toEqual({ pointColor: '#ff0000' });
    expect(red?.style).toBe(alsoRed?.style);
  });

  it('reads a row back as a feature', () => {
    const { tables, writer } = createFeatureTables();
    writer.adopt('layer', groups(2, { extra: { locked: true } }));
    const feature = tables.layer('layer')?.getRow(tables.handleOf('r1') as number);
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
    const { tables, writer } = createFeatureTables();
    writer.adopt('layer', groups(3, { keyOffset: 10, prefix: 'b' }));
    writer.adopt('layer', groups(3, { keyOffset: 0, prefix: 'a' }));
    writer.adopt('layer', groups(3, { keyOffset: 20, prefix: 'c' }));
    const view = tables.layer('layer');
    expect(Array.from(view?.rowsInOrder(0, 9) ?? []).map((h) => tables.idOf(h))).toEqual([
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
    const { tables, writer } = createFeatureTables();
    writer.adopt('layer', groups(5));
    // Not left out: read and drawn at their places at once
    expect(() => writer.adopt('layer', groups(2, { keyOffset: 3, prefix: 'x' }))).not.toThrow();
    const internals = featureTablesInternals(tables) as FeatureTablesInternals;
    const x3 = tables.handleOf('x3') as number;
    expect(internals.ids.deltaLayer(x3)).toBeGreaterThanOrEqual(0);
    const view = tables.layer('layer');
    const ids = () => Array.from(view?.rowsInOrder(0, 10) ?? []).map((h) => tables.idOf(h));
    const order = ['r0', 'r1', 'r2', 'r3', 'x3', 'r4', 'x4'];
    expect(ids()).toEqual(order);
    expect(view?.getRow(x3)?.properties).toEqual({ n: 3, name: 'name 3' });
    expect(view?.getRowPoint(x3)).toEqual([3, 3]);
    const drawn = Array.from(view?.listDrawnRows([-1, -1, 10, 10]) ?? []).map((h) =>
      tables.idOf(h),
    );
    expect(drawn).toEqual(order);
    // And into the row groups with their next versions
    internals.flushVersions();
    expect(internals.ids.deltaLayer(x3)).toBeLessThan(0);
    expect(internals.ids.mainGroup(x3)).toBeGreaterThanOrEqual(0);
    expect(ids()).toEqual(order);
  });

  it('puts the rows of a group not in the order of their keys in the delta, at their places', () => {
    const { tables, writer } = createFeatureTables();
    writer.adopt('layer', groups(3));
    // u100 and u101 with their keys swapped: u101 comes first
    const [built] = groups(2, { keyOffset: 100, prefix: 'u' });
    const swapped = { ...built, itemKeys: utf8ColumnFromStrings(['k101', 'k100']) };
    expect(() => writer.adopt('layer', [swapped])).not.toThrow();
    const internals = featureTablesInternals(tables) as FeatureTablesInternals;
    const u100 = tables.handleOf('u100') as number;
    expect(internals.ids.deltaLayer(u100)).toBeGreaterThanOrEqual(0);
    const view = tables.layer('layer');
    const ids = () => Array.from(view?.rowsInOrder(0, 10) ?? []).map((h) => tables.idOf(h));
    const order = ['r0', 'r1', 'r2', 'u101', 'u100'];
    expect(ids()).toEqual(order);
    const drawn = Array.from(view?.listDrawnRows([-1, -1, 200, 200]) ?? []).map((h) =>
      tables.idOf(h),
    );
    expect(drawn).toEqual(order);
    expect(view?.getRowPoint(u100)).toEqual([100, 100]);
    internals.flushVersions();
    expect(internals.ids.mainGroup(u100)).toBeGreaterThanOrEqual(0);
    expect(ids()).toEqual(order);
  });

  it('refuses an id that is already a row, and an unknown group', () => {
    const { writer } = createFeatureTables();
    writer.adopt('layer', groups(5));
    expect(() => writer.adopt('layer', groups(1, { keyOffset: 50 }))).not.toThrow();
    expect(() => writer.adopt('other', groups(1, { keyOffset: 50 }))).toThrow(/already a row/);
    expect(() =>
      writer.adopt('layer', groups(1, { keyOffset: 60, prefix: 'g', extra: { group: 3 } })),
    ).toThrow();
  });

  it('refuses a group whose arrays do not have one entry per row', () => {
    // Refused before anything is queued
    const { writer } = createFeatureTables();
    const [group] = groups(3);
    const broken = { ...group, flags: new Uint8Array(2) };
    expect(() => writer.adopt('layer', [broken])).toThrow(/flags/);
  });

  it('hides the rows that are not shown or are deleted, and not their handles', () => {
    const { tables, writer } = createFeatureTables();
    const builder = createRowGroupBuilder();
    builder.addRow({ id: 'shown', type: 'Point', geometry: point(0, 0), order: 'a' });
    builder.addRow({
      id: 'hidden',
      type: 'Point',
      geometry: point(0, 0),
      order: 'b',
      visible: false,
    });
    builder.addRow({ id: 'gone', type: 'Point', geometry: point(0, 0), order: 'c', deleted: true });
    builder.addRow({ id: 'circle', type: 'Circle', geometry: point(0, 0), order: 'd' });
    writer.adopt('layer', builder.finish());
    const internals = featureTablesInternals(tables);
    const group = internals?.layerTable('layer')?.groupAt(0);
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
    expect(tables.handleOf('gone')).toBeUndefined();
    expect(tables.handleOf('hidden')).toBeDefined();
    const view = tables.layer('layer');
    const all: [number, number, number, number] = [-1, -1, 1, 1];
    expect(Array.from(view?.listDrawnRows(all) ?? []).map((h) => tables.idOf(h))).toEqual([
      'shown',
      'circle',
    ]);
  });

  it('makes the copies of the state again when the sets of handles change', () => {
    const { tables, writer } = createFeatureTables();
    writer.adopt('layer', groups(6, { targetRows: 3 }));
    const internals = featureTablesInternals(tables);
    const layer = internals?.layerTable('layer') as LayerTable;
    const versions = [layer.groupAt(0).stateVersion, layer.groupAt(1).stateVersion];
    const revision = tables.layer('layer')?.getDrawnRowsRevision();
    const r4 = tables.handleOf('r4') as number;
    internals?.states.setHidden(Int32Array.of(r4), true);
    internals?.states.setBulk(Int32Array.of(r4, tables.handleOf('r0') as number), true);
    expect(layer.groupAt(1).state[1]).toBe(STATE_HIDDEN_LOCAL | (1 << 8));
    expect(layer.groupAt(1).gpuState[1]).toBe(GPU_STATE_HIDDEN | GPU_STATE_BULK);
    expect(layer.groupAt(0).gpuState[0]).toBe(GPU_STATE_BULK);
    expect(layer.groupAt(0).stateVersion).toBe(versions[0] + 1);
    expect(layer.groupAt(1).stateVersion).toBe(versions[1] + 2);
    expect(tables.layer('layer')?.getDrawnRowsRevision()).not.toBe(revision);
    internals?.states.setMoving(Int32Array.of(r4), 2);
    expect((layer.groupAt(1).gpuState[1] >> 1) & 3).toBe(2);
    expect(toGpuState(layer.groupAt(1).state[1])).toBe(layer.groupAt(1).gpuState[1]);
    internals?.states.setHidden(Int32Array.of(r4), false);
    expect(layer.groupAt(1).gpuState[1] & GPU_STATE_HIDDEN).toBe(0);
  });

  it('gives nothing to a handle of another layer', () => {
    const { tables, writer } = createFeatureTables();
    writer.adopt('a', groups(2, { prefix: 'a' }));
    writer.adopt('b', groups(2, { prefix: 'b' }));
    const handle = tables.handleOf('a0') as number;
    expect(tables.layer('b')?.getRow(handle)).toBeUndefined();
    expect(tables.layer('b')?.getRowBounds(handle)).toBeNull();
    expect(tables.layer('a')?.getRowBounds(handle)).toEqual([0, 0, 0, 0]);
  });

  it('allocates handles for the ids of a column', () => {
    const { tables, writer } = createFeatureTables();
    const handles = writer.allocateHandles(utf8ColumnFromStrings(['x', 'y']));
    expect(tables.idOf(handles[1])).toBe('y');
    // A handle with no row yet is not a row
    expect(tables.handleOf('x')).toBeUndefined();
  });
});

describe('LayerTable', () => {
  it('finds the place of a key and orders places', () => {
    const { tables, writer } = createFeatureTables();
    writer.adopt('layer', groups(6, { targetRows: 3 }));
    const layer = featureTablesInternals(tables)?.layerTable('layer') as LayerTable;
    const [first, second] = layer.groupHandles;

    const key = (order: string, id: string) => ({
      ids: utf8ColumnFromStrings([id]),
      itemKeys: utf8ColumnFromStrings([order]),
      memberKeys: utf8ColumnFromStrings(['']),
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

describe('adopt over the frames', () => {
  it('queues the groups and takes them in a group per step, within the budget', () => {
    const { tables, writer } = createFeatureTablesStore();
    const internals = featureTablesInternals(tables);
    if (!internals) throw new Error('no internals');
    const asked = vi.fn();
    internals.onPendingWork(asked);

    writer.adopt('layer', groups(9, { targetRows: 3 }));
    expect(asked).toHaveBeenCalledTimes(1);
    expect(internals.hasPendingAdoption).toBe(true);
    // Nothing is taken in yet: the layer is there and empty
    expect(tables.layer('layer')?.rowCount).toBe(0);
    expect(tables.handleOf('r0')).toBeUndefined();

    // Queuing more while groups wait does not ask again
    writer.adopt('layer', groups(3, { keyOffset: 20, prefix: 'z', targetRows: 3 }));
    expect(asked).toHaveBeenCalledTimes(1);

    const budget = stepBudget(2);
    expect(internals.advanceAdoption(budget)).toBe(true);
    expect(budget.taken).toBe(2);
    expect(tables.layer('layer')?.rowCount).toBe(6);
    expect(tables.handleOf('r4')).toBeDefined();
    expect(tables.handleOf('r6')).toBeUndefined();

    expect(internals.advanceAdoption(stepBudget(10))).toBe(false);
    expect(internals.hasPendingAdoption).toBe(false);
    const view = tables.layer('layer');
    expect(Array.from(view?.rowsInOrder(0, 12) ?? []).map((h) => tables.idOf(h))).toEqual([
      ...Array.from({ length: 9 }, (_, i) => `r${i}`),
      'z20',
      'z21',
      'z22',
    ]);
  });

  it('changes the revision of the rows drawn with every group taken in', () => {
    const { tables, writer } = createFeatureTablesStore();
    const internals = featureTablesInternals(tables);
    if (!internals) throw new Error('no internals');
    writer.adopt('layer', groups(4, { targetRows: 2 }));
    const before = internals.revision;
    internals.advanceAdoption(stepBudget(1));
    expect(internals.revision).toBeGreaterThan(before);
  });

  it('leaves out a group that cannot be taken in, reports it and takes the others in', () => {
    const { tables, writer } = createFeatureTablesStore();
    const internals = featureTablesInternals(tables);
    if (!internals) throw new Error('no internals');
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      writer.adopt('layer', groups(5));
      // Ids that are rows already, keys that overlap the first group (taken in by their rows,
      // in the delta), then a group that is fine
      writer.adopt('layer', groups(1, { keyOffset: 30 }));
      writer.adopt('layer', groups(1, { keyOffset: 0 }));
      writer.adopt('layer', groups(2, { keyOffset: 3, prefix: 'x' }));
      writer.adopt('layer', groups(2, { keyOffset: 10, prefix: 'y' }));
      expect(internals.advanceAdoption(stepBudget(10))).toBe(false);
      expect(error).toHaveBeenCalledTimes(1);
      expect(String(error.mock.calls[0][0])).toMatch(/already a row/);
      expect(tables.handleOf('x3')).toBeDefined();
      expect(tables.handleOf('y10')).toBeDefined();
      expect(tables.handleOf('r30')).toBeDefined();
      expect(internals.deltaRowCount()).toBe(2);
    } finally {
      error.mockRestore();
    }
  });

  it('refuses at once, and queues nothing, when a row names an unknown group', () => {
    const { tables, writer } = createFeatureTablesStore();
    const internals = featureTablesInternals(tables);
    expect(() =>
      writer.adopt('layer', [
        ...groups(1),
        ...groups(1, { keyOffset: 60, prefix: 'g', extra: { group: 3 } }),
      ]),
    ).toThrow(/unknown/);
    expect(internals?.hasPendingAdoption).toBe(false);
  });

  it('gives the rows handles from the hashes the groups carry (not hashing on the main thread)', () => {
    const { tables, writer } = createFeatureTablesStore();
    const internals = featureTablesInternals(tables);
    if (!internals) throw new Error('no internals');
    const [group] = groups(3);
    const allocate = vi.spyOn(internals.ids, 'allocate');
    writer.adopt('layer', [group]);
    internals.flushAdoption();
    expect(allocate).toHaveBeenCalledTimes(1);
    expect(allocate.mock.calls[0][1]).toBe(group.idHashes);
    for (const id of ['r0', 'r1', 'r2']) expect(tables.handleOf(id)).toBeDefined();
  });
});
