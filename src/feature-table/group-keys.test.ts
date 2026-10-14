// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What a Store of rows reads of the groups of features and of the row groups it gives, without
 * a drawing
 *
 * - The key of the order of a group (`FeatureTables.groupOrderOf`) is the key last written, read
 *   in the notification of the change that wrote it: a group created, moved in its layer, moved
 *   to another layer. While a drawing holds the reorder of its members, the rows are read in the
 *   order before, and the key is still the new one
 * - `FeatureTablesWriter.flushAdoption` takes in the row groups given to `adopt` and the new rows
 *   waiting to be built, at once; without it, they wait for the frames of the drawing as before
 */

import { describe, expect, it } from 'vitest';
import { createFeatureTables, type FeatureTables, type RowField } from '../api/tables.js';
import type { StoreChange } from '../shared/types/model.js';
import { createTableMemoryStore } from '../store/table-memory.js';
import { createRowGroupBuilder } from '../table/row-group-builder.js';
import { utf8ColumnFromStrings } from '../table/utf8-column.js';
import { type FeatureTablesInternals, featureTablesInternals } from './feature-tables.js';

/** The key of the order of the `i`-th row of the tests */
const key = (i: number) => `k${String(i).padStart(3, '0')}`;

/** Row groups of points `r<from>`.. in the order of their keys */
function points(from: number, count: number) {
  const builder = createRowGroupBuilder({ targetRows: 4 });
  for (let i = from; i < from + count; i++) {
    builder.addRow({
      id: `r${i}`,
      type: 'Point',
      geometry: { type: 'Point', coordinates: [i, 0] },
      order: key(i),
    });
  }
  return builder.finish();
}

/** A Store of rows with two layers, rows taken into the first, and a drawing that holds versions */
function setup() {
  const { store, writer } = createTableMemoryStore();
  for (const id of ['a', 'b']) {
    store.createLayer({
      id,
      name: id,
      visible: true,
      locked: false,
      opacity: 1,
      kind: 'table',
      metadata: undefined,
      styleRule: undefined,
    });
  }
  writer.adopt('a', points(0, 10));
  writer.flushAdoption();
  const tables = store.tables as FeatureTables;
  const internals = featureTablesInternals(tables) as FeatureTablesInternals;
  // The side that draws: the versions go in when it lets them
  let open = true;
  internals.attachReceiver({ uploaded: () => open, swapped: () => {}, dropped: () => {} });
  const draw = () => {
    open = true;
    internals.flushVersions();
    open = false;
  };
  open = false;
  /** The ids of the items of a layer in their order */
  const items = (layerId: string) => {
    const view = tables.layer(layerId);
    if (!view) return [];
    const refs = view.itemsInOrder(0, view.itemCount);
    return Array.from(refs.handles, (h, i) =>
      refs.kinds[i] === 0 ? tables.idOf(h) : tables.groupIdOf(h),
    );
  };
  return { store, writer, tables, internals, draw, items };
}

describe('the key of the order of a group of features', () => {
  it('is read in the notification of the creation of the group', () => {
    const { store, tables } = setup();
    const read: Array<string | undefined> = [];
    store.subscribe((change) => {
      for (const group of change.groups?.created ?? []) {
        read.push(tables.groupOrderOf(tables.groupHandleOf(group.id) ?? -1));
      }
    });
    store.createGroup({
      id: 'g',
      layerId: 'a',
      name: 'g',
      featureIds: ['r2', 'r3'],
      visible: true,
      locked: false,
    });
    // The group takes the place of its first member
    expect(read).toEqual([key(2)]);
    expect(tables.groupOrderOf(tables.groupHandleOf('g') ?? -1)).toBe(key(2));
  });

  it('is the new key in the notification of a move, while the rows are read in the order before', () => {
    const { store, tables, internals, draw, items } = setup();
    store.createGroup({
      id: 'g',
      layerId: 'a',
      name: 'g',
      featureIds: ['r2', 'r3'],
      visible: true,
      locked: false,
    });
    draw();
    const handle = tables.groupHandleOf('g') as number;
    const before = tables.groupOrderOf(handle) as string;
    expect(items('a')).toEqual(['r0', 'r1', 'g', 'r4', 'r5', 'r6', 'r7', 'r8', 'r9']);
    const read: Array<{ key: string | undefined; drawn: string | undefined; items: unknown[] }> =
      [];
    const moves: StoreChange['order'][] = [];
    store.subscribe((change) => {
      if (!change.order) return;
      moves.push(change.order);
      read.push({
        key: tables.groupOrderOf(handle),
        drawn: internals.groups.orderOf(handle),
        items: items('a'),
      });
    });
    // To the front of the layer
    store.moveItem('g', { layerId: 'a', above: null });
    expect(moves).toHaveLength(1);
    expect(moves[0]?.[0]).toMatchObject({ kind: 'item', itemId: 'g' });
    const moved = read[0]?.key as string;
    expect(moved).not.toBe(before);
    // After the key of the last row
    expect(compareKeys(moved, key(9))).toBeGreaterThan(0);
    // The drawing holds the reorder: the rows are in the order before until it lets it in
    expect(read[0]?.drawn).toBe(before);
    expect(read[0]?.items).toEqual(['r0', 'r1', 'g', 'r4', 'r5', 'r6', 'r7', 'r8', 'r9']);
    expect(tables.groupOrderOf(handle)).toBe(moved);
    draw();
    expect(items('a')).toEqual(['r0', 'r1', 'r4', 'r5', 'r6', 'r7', 'r8', 'r9', 'g']);
    expect(tables.groupOrderOf(handle)).toBe(moved);
    expect(internals.groups.orderOf(handle)).toBe(moved);
  });

  it('is the last key written when moves follow each other before the drawing lets them in', () => {
    const { store, tables, draw, items } = setup();
    store.createGroup({
      id: 'g',
      layerId: 'a',
      name: 'g',
      featureIds: ['r2', 'r3'],
      visible: true,
      locked: false,
    });
    draw();
    const handle = tables.groupHandleOf('g') as number;
    const read: Array<string | undefined> = [];
    store.subscribe((change) => {
      if (change.order) read.push(tables.groupOrderOf(handle));
    });
    store.moveItem('g', { layerId: 'a', above: null });
    store.moveItem('g', { layerId: 'a', below: null });
    expect(read).toHaveLength(2);
    expect(read[0]).not.toBe(read[1]);
    // Behind the first row
    expect(compareKeys(read[1] as string, key(0))).toBeLessThan(0);
    expect(tables.groupOrderOf(handle)).toBe(read[1]);
    draw();
    expect(items('a')).toEqual(['g', 'r0', 'r1', 'r4', 'r5', 'r6', 'r7', 'r8', 'r9']);
    expect(tables.groupOrderOf(handle)).toBe(read[1]);
  });

  it('is read with the layer of the group in the notification of a move to another layer', () => {
    const { store, tables, draw, items } = setup();
    store.createGroup({
      id: 'g',
      layerId: 'a',
      name: 'g',
      featureIds: ['r2', 'r3'],
      visible: true,
      locked: false,
    });
    draw();
    const handle = tables.groupHandleOf('g') as number;
    const before = tables.groupOrderOf(handle);
    const read: Array<{ key: string | undefined; layerId: string | undefined }> = [];
    let updated: string | undefined;
    store.subscribe((change) => {
      updated = change.groups?.updated?.find((entry) => entry.id === 'g')?.group.layerId;
      if (change.order) {
        read.push({ key: tables.groupOrderOf(handle), layerId: store.getGroup('g')?.layerId });
      }
    });
    store.moveItem('g', { layerId: 'b' });
    expect(updated).toBe('b');
    expect(read).toHaveLength(1);
    expect(read[0]?.layerId).toBe('b');
    expect(read[0]?.key).toBeDefined();
    expect(read[0]?.key).not.toBe(before);
    draw();
    expect(items('b')).toEqual(['g']);
    expect(items('a')).toEqual(['r0', 'r1', 'r4', 'r5', 'r6', 'r7', 'r8', 'r9']);
    expect(tables.groupOrderOf(handle)).toBe(read[0]?.key);
  });

  it('is undefined for a handle of no group', () => {
    const { tables } = setup();
    expect(tables.groupOrderOf(42)).toBeUndefined();
  });
});

describe('taking in the row groups without a drawing', () => {
  it('leaves the row groups given waiting for the frames until it is called', () => {
    const { tables, writer } = createFeatureTables();
    writer.adopt('a', points(0, 10));
    const internals = featureTablesInternals(tables) as FeatureTablesInternals;
    expect(internals.hasPendingAdoption).toBe(true);
    expect(tables.handleOf('r0')).toBeUndefined();
    writer.flushAdoption();
    expect(internals.hasPendingAdoption).toBe(false);
    const view = tables.layer('a');
    const order = Array.from(view?.rowsInOrder(0, 20) ?? [], (h) => tables.idOf(h));
    expect(order).toEqual(Array.from({ length: 10 }, (_, i) => `r${i}`));
  });

  it('builds the new rows waiting into row groups of their own and takes them in', () => {
    const { tables, writer } = createFeatureTables();
    writer.adopt('a', points(0, 4));
    writer.flushAdoption();
    const internals = featureTablesInternals(tables) as FeatureTablesInternals;
    // A run of new rows after the last row: built into row groups of their own over the frames
    const n = 100;
    const ids = Array.from({ length: n }, (_, i) => `r${i + 4}`);
    const handles = writer.allocateHandles(utf8ColumnFromStrings(ids));
    writer.apply({
      handles,
      fields: new Map<RowField, unknown[]>([
        ['type', ids.map(() => 'Point')],
        ['layerId', ids.map(() => 'a')],
        ['geometry', ids.map((_, i) => ({ type: 'Point', coordinates: [i + 4, 0] }))],
        ['order', ids.map((_, i) => key(i + 4))],
      ]),
    });
    expect(internals.hasPendingWork).toBe(true);
    expect(internals.ids.mainGroup(handles[0])).toBeLessThan(0);
    writer.flushAdoption();
    // In row groups of the layer, not in its delta
    for (const handle of handles) {
      expect(internals.ids.mainGroup(handle)).toBeGreaterThanOrEqual(0);
      expect(internals.ids.deltaLayer(handle)).toBeLessThan(0);
    }
    expect(internals.deltaRowCount()).toBe(0);
    const view = tables.layer('a');
    expect(view?.rowCount).toBe(n + 4);
    const order = Array.from(view?.rowsInOrder(0, n + 4) ?? [], (h) => tables.idOf(h));
    expect(order).toEqual(Array.from({ length: n + 4 }, (_, i) => `r${i}`));
  });

  it('throws for a row group that cannot be taken in, and the groups after it keep waiting', () => {
    const { tables, writer } = createFeatureTables();
    writer.adopt('a', points(0, 4));
    writer.flushAdoption();
    // Its ids are rows already, then a group that can be taken in
    writer.adopt('a', [...points(0, 1), ...points(10, 1)]);
    expect(() => writer.flushAdoption()).toThrow();
    const internals = featureTablesInternals(tables) as FeatureTablesInternals;
    expect(internals.hasPendingAdoption).toBe(true);
    writer.flushAdoption();
    expect(tables.handleOf('r10')).toBeDefined();
  });
});

/** Compares two keys of the order (ASCII here: byte by byte is the order of the strings) */
function compareKeys(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
