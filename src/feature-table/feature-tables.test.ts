// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The tables of the features: taking row groups in, the handles, the state of the rows and the
 * reading of a layer
 */

import type { Geometry } from 'geojson';
import { describe, expect, it } from 'vitest';
import { createRowGroupBuilder, type RowInput } from '../table/row-group-builder.js';
import type { RowGroupData } from '../table/row-group-types.js';
import { utf8ColumnFromStrings } from '../table/utf8-column.js';
import {
  createFeatureTablesStore as createFeatureTables,
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

  it('refuses a group whose keys overlap another group, an id that is already a row, and an unknown group', () => {
    const { writer } = createFeatureTables();
    writer.adopt('layer', groups(5));
    expect(() => writer.adopt('layer', groups(2, { keyOffset: 3, prefix: 'x' }))).toThrow(
      /overlap/,
    );
    expect(() => writer.adopt('layer', groups(1, { keyOffset: 50 }))).not.toThrow();
    expect(() => writer.adopt('other', groups(1, { keyOffset: 50 }))).toThrow(/already a row/);
    expect(() =>
      writer.adopt('layer', groups(1, { keyOffset: 60, prefix: 'g', extra: { group: 3 } })),
    ).toThrow();
  });

  it('refuses a group whose arrays do not have one entry per row', () => {
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
