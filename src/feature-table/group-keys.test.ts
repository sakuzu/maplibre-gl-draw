// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What a Store of rows reads of the groups of features and of the row groups it gives, without
 * a drawing
 *
 * - The key of the order of a group (`FeatureTablesWriter.getGroupOrder`) is the key last written, read
 *   in the notification of the change that wrote it: a group created, moved in its layer, moved
 *   to another layer. While a drawing holds the reorder of its members, the rows are read in the
 *   order before, and the key is still the new one
 * - The writes of the Store and the changes of the order it notifies read the order written: an
 *   item put next to a group whose reorder the drawing holds goes next to the group where its new
 *   key puts it, and a key written in another layer is not overwritten by the reorder of before
 * - The groups written through the writer of the Store (from elsewhere) are the groups of the
 *   document: created, moved to another layer, renamed, shown, locked and deleted, and notified
 * - the tables take in, all at once, the blocks given to `addRowBlocks` and the new rows
 *   waiting to be built, at once; without it, they wait for the frames of the drawing as before
 */

import { describe, expect, it, vi } from 'vitest';
import {
  createFeatureTables,
  type FeatureTables,
  type RowField,
  type TableGroupField,
} from '../api/tables.js';
import type { StoreChange } from '../shared/types/model.js';
import { createTableStore } from '../store/table-memory.js';
import { createRowBlockDataBuilder } from '../table/row-group-builder.js';
import { utf8ColumnFromStrings } from '../table/utf8-column.js';
import { seededRandom } from '../test-utils.js';
import { type FeatureTablesInternals, featureTablesInternals } from './feature-tables.js';
import type { TableWorkBudget } from './types.js';

/** A budget of one step at a time */
const ONE_STEP: TableWorkBudget = { canStep: () => true, step: (work) => work(Infinity) };

/** The key of the order of the `i`-th row of the tests */
const key = (i: number) => `k${String(i).padStart(3, '0')}`;

/** Row groups of points `r<from>`.. in the order of their keys */
function points(from: number, count: number) {
  const builder = createRowBlockDataBuilder({ targetRows: 4 });
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
  const { store, writer } = createTableStore();
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
  writer.addRowBlocks('a', points(0, 10));
  const tables = store.tables as FeatureTables;
  const internals = featureTablesInternals(tables) as FeatureTablesInternals;
  internals.addQueuedRowBlocks();
  // The side that draws: the versions go in when it lets them
  let open = true;
  internals.attachReceiver({ uploaded: () => open, swapped: () => {}, dropped: () => {} });
  const draw = () => {
    open = true;
    internals.flushVersions();
    open = false;
  };
  open = false;
  /**
   * One frame of the drawing, in its order: the row groups waiting and the next versions are
   * advanced, then the versions whose GPU side is up are swapped in (`up`: whether it is)
   */
  const frame = (up: boolean) => {
    internals.advanceQueuedBlocks(ONE_STEP);
    internals.advanceVersions(ONE_STEP);
    open = up;
    internals.swapVersions();
    open = false;
  };
  /** The ids of the items of a layer in their order */
  const items = (layerId: string) => {
    const view = tables.get(layerId);
    if (!view) return [];
    const refs = view.listItems(0, view.itemCount);
    return Array.from(refs.handles, (h, i) =>
      refs.kinds[i] === 0 ? tables.getRowId(h) : tables.getGroupId(h),
    );
  };
  return { store, writer, tables, internals, draw, frame, items };
}

describe('the key of the order of a group of features', () => {
  it('is read in the notification of the creation of the group', () => {
    const { store, tables, writer } = setup();
    const read: Array<string | undefined> = [];
    store.subscribe((change) => {
      for (const group of change.groups?.created ?? []) {
        read.push(writer.getGroupOrder(tables.findGroup(group.id) ?? -1));
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
    expect(writer.getGroupOrder(tables.findGroup('g') ?? -1)).toBe(key(2));
  });

  it('is the new key in the notification of a move, while the rows are read in the order before', () => {
    const { store, tables, internals, draw, items, writer } = setup();
    store.createGroup({
      id: 'g',
      layerId: 'a',
      name: 'g',
      featureIds: ['r2', 'r3'],
      visible: true,
      locked: false,
    });
    draw();
    const handle = tables.findGroup('g') as number;
    const before = writer.getGroupOrder(handle) as string;
    expect(items('a')).toEqual(['r0', 'r1', 'g', 'r4', 'r5', 'r6', 'r7', 'r8', 'r9']);
    const read: Array<{ key: string | undefined; drawn: string | undefined; items: unknown[] }> =
      [];
    const moves: StoreChange['order'][] = [];
    store.subscribe((change) => {
      if (!change.order) return;
      moves.push(change.order);
      read.push({
        key: writer.getGroupOrder(handle),
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
    expect(writer.getGroupOrder(handle)).toBe(moved);
    draw();
    expect(items('a')).toEqual(['r0', 'r1', 'r4', 'r5', 'r6', 'r7', 'r8', 'r9', 'g']);
    expect(writer.getGroupOrder(handle)).toBe(moved);
    expect(internals.groups.orderOf(handle)).toBe(moved);
  });

  it('is the last key written when moves follow each other before the drawing lets them in', () => {
    const { store, tables, draw, items, writer } = setup();
    store.createGroup({
      id: 'g',
      layerId: 'a',
      name: 'g',
      featureIds: ['r2', 'r3'],
      visible: true,
      locked: false,
    });
    draw();
    const handle = tables.findGroup('g') as number;
    const read: Array<string | undefined> = [];
    store.subscribe((change) => {
      if (change.order) read.push(writer.getGroupOrder(handle));
    });
    store.moveItem('g', { layerId: 'a', above: null });
    store.moveItem('g', { layerId: 'a', below: null });
    expect(read).toHaveLength(2);
    expect(read[0]).not.toBe(read[1]);
    // Behind the first row
    expect(compareKeys(read[1] as string, key(0))).toBeLessThan(0);
    expect(writer.getGroupOrder(handle)).toBe(read[1]);
    draw();
    expect(items('a')).toEqual(['g', 'r0', 'r1', 'r4', 'r5', 'r6', 'r7', 'r8', 'r9']);
    expect(writer.getGroupOrder(handle)).toBe(read[1]);
  });

  it('is read with the layer of the group in the notification of a move to another layer', () => {
    const { store, tables, draw, items, writer } = setup();
    store.createGroup({
      id: 'g',
      layerId: 'a',
      name: 'g',
      featureIds: ['r2', 'r3'],
      visible: true,
      locked: false,
    });
    draw();
    const handle = tables.findGroup('g') as number;
    const before = writer.getGroupOrder(handle);
    const read: Array<{ key: string | undefined; layerId: string | undefined }> = [];
    let updated: string | undefined;
    store.subscribe((change) => {
      updated = change.groups?.updated?.find((entry) => entry.id === 'g')?.group.layerId;
      if (change.order) {
        read.push({ key: writer.getGroupOrder(handle), layerId: store.getGroup('g')?.layerId });
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
    expect(writer.getGroupOrder(handle)).toBe(read[0]?.key);
  });

  it('is undefined for a handle of no group', () => {
    const { writer } = setup();
    expect(writer.getGroupOrder(42)).toBeUndefined();
  });
});

describe('the order written, while the drawing holds the reorder of a group', () => {
  /** A group `g` of r2 and r3 in the layer `a`, drawn */
  function grouped() {
    const setupOf = setup();
    setupOf.store.createGroup({
      id: 'g',
      layerId: 'a',
      name: 'g',
      featureIds: ['r2', 'r3'],
      visible: true,
      locked: false,
    });
    setupOf.draw();
    return { ...setupOf, handle: setupOf.tables.findGroup('g') as number };
  }

  it('puts an item just above a group moved to the front, where its new key puts it', () => {
    const { store, draw, items } = grouped();
    store.moveItem('g', { layerId: 'a', above: null });
    const moves: StoreChange['order'][] = [];
    store.subscribe((change) => moves.push(change.order));
    store.moveItem('r5', { layerId: 'a', below: 'g' });
    // Told where it goes in the order written
    expect(moves[0]).toEqual([
      expect.objectContaining({
        kind: 'item',
        itemId: 'r5',
        from: expect.objectContaining({ below: 'r4', above: 'r6' }),
        to: expect.objectContaining({ below: 'g', above: null }),
      }),
    ]);
    draw();
    expect(items('a')).toEqual(['r0', 'r1', 'r4', 'r6', 'r7', 'r8', 'r9', 'g', 'r5']);
  });

  it('puts an item at the front, and a new group after it, above a group moved to the front', () => {
    const { store, draw, items } = grouped();
    store.moveItem('g', { layerId: 'a', above: null });
    store.moveItem('r0', { layerId: 'a', above: null });
    store.createGroup({
      id: 'h',
      layerId: 'a',
      name: 'h',
      kind: 'table',
      visible: true,
      locked: false,
    });
    store.moveItems(['r1'], { layerId: 'a', groupId: 'h' });
    draw();
    expect(items('a')).toEqual(['r4', 'r5', 'r6', 'r7', 'r8', 'r9', 'g', 'r0', 'h']);
  });

  it('tells a second move of the group from where the first one put it', () => {
    const { store, draw, items } = grouped();
    store.moveItem('g', { layerId: 'a', above: null });
    const moves: StoreChange['order'][] = [];
    store.subscribe((change) => moves.push(change.order));
    store.moveItem('g', { layerId: 'a', below: null });
    expect(moves[0]).toEqual([
      expect.objectContaining({
        kind: 'item',
        itemId: 'g',
        from: expect.objectContaining({ below: 'r9', above: null }),
        to: expect.objectContaining({ below: null, above: 'r0' }),
      }),
    ]);
    draw();
    expect(items('a')).toEqual(['g', 'r0', 'r1', 'r4', 'r5', 'r6', 'r7', 'r8', 'r9']);
  });

  it('puts the items where the order written says, whenever the drawing lets the reorders in', () => {
    for (const seed of [7, 8, 9]) {
      const random = seededRandom(seed);
      const { store, internals, draw, items } = setup();
      for (const [id, members] of [
        ['g0', ['r2', 'r3']],
        ['g1', ['r6', 'r7']],
      ] as const) {
        store.createGroup({
          id,
          layerId: 'a',
          name: id,
          featureIds: [...members],
          visible: true,
          locked: false,
        });
      }
      draw();
      // The items of the layer as the writes put them (the reference)
      const reference = items('a') as string[];
      let held = 0;
      for (let step = 0; step < 60; step++) {
        if (internals.writtenOrders.size > 0) held++;
        const pick = random();
        if (pick < 0.15) {
          // Sometimes the drawing lets the versions in, sometimes it only starts them
          if (random() < 0.5) draw();
          else internals.advanceVersions(ONE_STEP);
          continue;
        }
        const id = reference[Math.floor(random() * reference.length)];
        const others = reference.filter((other) => other !== id);
        const k = Math.floor(random() * (others.length + 2));
        reference.splice(reference.indexOf(id), 1);
        if (k === others.length) {
          store.moveItem(id, { layerId: 'a', below: null });
          reference.unshift(id);
        } else if (k === others.length + 1) {
          store.moveItem(id, { layerId: 'a', above: null });
          reference.push(id);
        } else if (random() < 0.5) {
          store.moveItem(id, { layerId: 'a', below: others[k] });
          reference.splice(reference.indexOf(others[k]) + 1, 0, id);
        } else {
          store.moveItem(id, { layerId: 'a', above: others[k] });
          reference.splice(reference.indexOf(others[k]), 0, id);
        }
      }
      // Reorders were held while items were put next to the groups
      expect(held).toBeGreaterThan(5);
      draw();
      expect(items('a')).toEqual(reference);
    }
  });

  it('keeps the key a group was given in another layer when the reorder of before goes in', () => {
    const { store, internals, draw, items, handle, writer } = grouped();
    store.moveItem('g', { layerId: 'a', above: null });
    store.moveItem('g', { layerId: 'b' });
    const key = writer.getGroupOrder(handle);
    draw();
    expect(writer.getGroupOrder(handle)).toBe(key);
    expect(internals.groups.orderOf(handle)).toBe(key);
    expect(internals.writtenOrders.size).toBe(0);
    expect(items('b')).toEqual(['g']);
    expect(items('a')).toEqual(['r0', 'r1', 'r4', 'r5', 'r6', 'r7', 'r8', 'r9']);
    // And it is put back in its layer where the keys put it
    store.moveItem('g', { layerId: 'a', below: 'r1' });
    draw();
    expect(items('a')).toEqual(['r0', 'r1', 'g', 'r4', 'r5', 'r6', 'r7', 'r8', 'r9']);
  });
});

describe('the row groups taken in while the drawing holds the reorder of a group', () => {
  /**
   * A group `g` of r2 and r3 moved to the front of the layer `a`, its reorder held by the
   * drawing, and two keys around its new key, after the last row
   */
  function heldReorder() {
    const setupOf = setup();
    setupOf.store.createGroup({
      id: 'g',
      layerId: 'a',
      name: 'g',
      featureIds: ['r2', 'r3'],
      visible: true,
      locked: false,
    });
    setupOf.draw();
    setupOf.store.moveItem('g', { layerId: 'a', above: null });
    const handle = setupOf.tables.findGroup('g') as number;
    const written = setupOf.writer.getGroupOrder(handle) as string;
    expect(setupOf.internals.writtenOrders.get(handle)).toBe(written);
    // After the last row in the order drawn, and around the new key of the group
    const low = `${key(9)}0`;
    const high = `${written}z`;
    expect(compareKeys(low, key(9))).toBeGreaterThan(0);
    expect(compareKeys(low, written)).toBeLessThan(0);
    expect(compareKeys(high, written)).toBeGreaterThan(0);
    return { ...setupOf, handle, low, high };
  }

  /** Two points `n0` and `n1` of these keys */
  function around(low: string, high: string) {
    const builder = createRowBlockDataBuilder({ targetRows: 4 });
    ['n0', 'n1'].forEach((id, i) => {
      builder.addRow({
        id,
        type: 'Point',
        geometry: { type: 'Point', coordinates: [20 + i, 0] },
        order: i === 0 ? low : high,
      });
    });
    return builder.finish();
  }

  /** The order once the group of `n0` and `n1` and the reorder are in */
  const BETWEEN = ['r0', 'r1', 'n0', 'n1', 'r4', 'r5', 'r6', 'r7', 'r8', 'r9', 'g'];

  it('wait for the reorder, and are taken in the frame after it goes in', () => {
    const { writer, tables, frame, items } = heldReorder();
    // Where the members of the group stood: among them in the order drawn, free once it is in
    writer.addRowBlocks('a', around(`${key(1)}5`, `${key(2)}5`));
    const takenIn: number[] = [];
    // The drawing holds the reorder for three frames
    for (let f = 1; f <= 6; f++) {
      frame(f >= 4);
      if (takenIn.length === 0 && tables.findRow('n0') !== undefined) takenIn.push(f);
    }
    // The reorder goes in at the end of the fourth frame, the group in the fifth (taken in at
    // the start of a frame, before its versions are swapped in)
    expect(takenIn).toEqual([5]);
    expect(items('a')).toEqual(BETWEEN);
  });

  it('wait for the reorder when taken in at once, and are taken in once it is', () => {
    const { writer, tables, internals, draw, items } = heldReorder();
    writer.addRowBlocks('a', around(`${key(1)}5`, `${key(2)}5`));
    internals.addQueuedRowBlocks();
    expect(internals.hasQueuedBlocks).toBe(true);
    expect(tables.findRow('n0')).toBeUndefined();
    draw();
    expect(internals.hasQueuedBlocks).toBe(false);
    expect(items('a')).toEqual(BETWEEN);
  });

  it('put a group whose keys hold the new key of the group in the delta once it is in', () => {
    const { writer, tables, internals, frame, draw, items, low, high } = heldReorder();
    writer.addRowBlocks('a', around(low, high));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    let placed = 0;
    for (let f = 1; f <= 6; f++) {
      frame(f >= 4);
      if (placed === 0 && tables.findRow('n0') !== undefined) placed = f;
    }
    // Not left out: taken in by its rows (it would overlap the members of the group), in the
    // frame after the reorder is in, read and drawn at their places
    expect(error).not.toHaveBeenCalled();
    error.mockRestore();
    expect(placed).toBe(5);
    const n0 = tables.findRow('n0') as number;
    expect(internals.ids.deltaLayer(n0)).toBeGreaterThanOrEqual(0);
    const after = ['r0', 'r1', 'r4', 'r5', 'r6', 'r7', 'r8', 'r9', 'n0', 'g', 'n1'];
    expect(items('a')).toEqual(after);
    const view = tables.get('a');
    const drawn = Array.from(view?.listDrawnRows([-1, -1, 30, 1]) ?? [], (h) => tables.getRowId(h));
    expect(drawn).toEqual(['r0', 'r1', 'r4', 'r5', 'r6', 'r7', 'r8', 'r9', 'n0', 'r2', 'r3', 'n1']);
    expect(view?.getRowPoint(n0)).toEqual([20, 0]);
    // And into the row groups with their next versions
    draw();
    expect(internals.ids.mainGroup(n0)).toBeGreaterThanOrEqual(0);
    expect(items('a')).toEqual(after);
  });

  /** Writes `n` new rows `c00`.. of these keys (a run no row of the order drawn is within) */
  function createRows(
    writer: ReturnType<typeof setup>['writer'],
    keyOf: (i: number) => string,
    n = 80,
  ) {
    const ids = Array.from({ length: n }, (_, i) => `c${String(i).padStart(2, '0')}`);
    const handles = writer.allocateHandles(utf8ColumnFromStrings(ids));
    writer.apply({
      handles,
      fields: new Map<RowField, unknown[]>([
        ['type', ids.map(() => 'Point')],
        ['layerId', ids.map(() => 'a')],
        ['geometry', ids.map((_, i) => ({ type: 'Point', coordinates: [i, 1] }))],
        ['order', ids.map((_, i) => keyOf(i))],
      ]),
    });
    return { ids, handles };
  }

  it('build new rows into a row group of their own once the reorder is in', () => {
    const { writer, tables, internals, frame, items, low } = heldReorder();
    // Between the last row and the new key of the group
    const { ids, handles } = createRows(writer, (i) => `${low}${String(i).padStart(2, '0')}`);
    let built = 0;
    for (let f = 1; f <= 10; f++) {
      // The drawing holds the reorder for five frames
      frame(f >= 6);
      if (built === 0 && internals.ids.mainGroup(handles[0]) >= 0) built = f;
      // Read from their creation meanwhile
      expect(tables.findRow(ids[0])).toBe(handles[0]);
    }
    // Gathered for two frames, then waiting for the reorder (in at the end of the sixth frame):
    // built in the seventh and taken in at the start of the eighth, in a group of their own, not
    // in the delta (without the reorder: built in the third frame, taken in in the fourth)
    expect(built).toBe(8);
    expect(internals.ids.deltaLayer(handles[0])).toBeLessThan(0);
    const order = items('a');
    expect(order.slice(0, 8)).toEqual(['r0', 'r1', 'r4', 'r5', 'r6', 'r7', 'r8', 'r9']);
    expect(order.slice(8, 8 + ids.length)).toEqual(ids);
    expect(order[order.length - 1]).toBe('g');
  });

  it('put new rows whose keys hold the new key of the group into the delta once it is in', () => {
    const { writer, tables, internals, frame, items, low, high } = heldReorder();
    const n = 80;
    const { ids, handles } = createRows(writer, (i) =>
      i < n / 2 ? `${low}${String(i).padStart(2, '0')}` : `${high}${String(i).padStart(2, '0')}`,
    );
    let left = 0;
    for (let f = 1; f <= 10; f++) {
      frame(f >= 6);
      const placed =
        internals.ids.mainGroup(handles[0]) >= 0 || internals.ids.deltaLayer(handles[0]) >= 0;
      if (left === 0 && placed) left = f;
      expect(tables.findRow(ids[0])).toBe(handles[0]);
    }
    // Not built before the reorder is in (they would be built by the keys before); built in the
    // seventh frame, their group overlaps the members of the group when it is taken in, in the
    // eighth, so they go to the delta then
    expect(left).toBe(8);
    const order = items('a');
    expect(order.indexOf('g')).toBe(order.indexOf(ids[n / 2 - 1]) + 1);
    expect(order.indexOf(ids[n / 2])).toBe(order.indexOf('g') + 1);
  });

  it('put the rows of new rows written again into the delta while the reorder waits', () => {
    const { writer, tables, internals, draw, items, low, high } = heldReorder();
    const n = 80;
    const ids = Array.from({ length: n }, (_, i) => `c${String(i).padStart(2, '0')}`);
    const keys = ids.map((_, i) =>
      i < n / 2 ? `${low}${String(i).padStart(2, '0')}` : `${high}${String(i).padStart(2, '0')}`,
    );
    const handles = writer.allocateHandles(utf8ColumnFromStrings(ids));
    writer.apply({
      handles,
      fields: new Map<RowField, unknown[]>([
        ['type', ids.map(() => 'Point')],
        ['layerId', ids.map(() => 'a')],
        ['geometry', ids.map((_, i) => ({ type: 'Point', coordinates: [i, 1] }))],
        ['order', keys],
      ]),
    });
    // A row of them written before they are built
    writer.apply({
      handles: handles.subarray(0, 1),
      fields: new Map<RowField, unknown[]>([
        ['geometry', [{ type: 'Point', coordinates: [9, 9] }]],
      ]),
    });
    expect(tables.get('a')?.getRowPoint(handles[0])).toEqual([9, 9]);
    expect(internals.ids.mainGroup(handles[1])).toBeLessThan(0);
    draw();
    const order = items('a');
    expect(order.indexOf('g')).toBe(order.indexOf(ids[n / 2 - 1]) + 1);
    expect(order.indexOf(ids[n / 2])).toBe(order.indexOf('g') + 1);
  });
});

describe('the groups written through the writer of the Store of rows', () => {
  it('follow a group moved to another layer from elsewhere, notified as remote', () => {
    const { store, writer, tables, draw, items } = setup();
    store.createGroup({
      id: 'g',
      layerId: 'a',
      name: 'g',
      featureIds: ['r2', 'r3'],
      visible: true,
      locked: false,
    });
    draw();
    const handle = tables.findGroup('g') as number;
    const members = ['r2', 'r3'].map((id) => tables.findRow(id) as number);
    const notified: StoreChange[] = [];
    store.subscribe((change) => notified.push(change));
    store.transact(() => {
      writer.apply({
        handles: Int32Array.from(members),
        fields: new Map<RowField, unknown[]>([['layerId', ['b', 'b']]]),
      });
      writer.applyGroups({
        handles: Int32Array.of(handle),
        fields: new Map<TableGroupField, unknown[]>([
          ['layerId', ['b']],
          ['order', ['m']],
        ]),
      });
    }, 'remote');
    expect(notified).toHaveLength(1);
    expect(notified[0]?.source).toBe('remote');
    expect(notified[0]?.groups?.updated).toEqual([
      expect.objectContaining({
        id: 'g',
        group: expect.objectContaining({ layerId: 'b' }),
        previous: expect.objectContaining({ layerId: 'a' }),
      }),
    ]);
    expect(store.getGroup('g')?.layerId).toBe('b');
    expect(writer.getGroupOrder(handle)).toBe('m');
    draw();
    expect(items('b')).toEqual(['g']);
    expect(store.getFeature('r2')?.layerId).toBe('b');
    // A write here reads the group where it is now
    store.moveItem('r0', { layerId: 'b', below: 'g' });
    draw();
    expect(items('b')).toEqual(['g', 'r0']);
  });

  it('rename, show and lock the groups, and notify them once', () => {
    const { store, writer, tables } = setup();
    store.createGroup({
      id: 'g',
      layerId: 'a',
      name: 'g',
      featureIds: ['r2'],
      visible: true,
      locked: false,
    });
    const handle = tables.findGroup('g') as number;
    const notified: StoreChange[] = [];
    store.subscribe((change) => notified.push(change));
    store.transact(() => {
      writer.applyGroups({
        handles: Int32Array.of(handle),
        fields: new Map<TableGroupField, unknown[]>([
          ['name', ['renamed']],
          ['visible', [false]],
          ['locked', [true]],
        ]),
      });
    }, 'remote');
    expect(store.getGroup('g')).toMatchObject({ name: 'renamed', visible: false, locked: true });
    expect(notified).toHaveLength(1);
    expect(notified[0]?.groups?.updated?.map((entry) => entry.id)).toEqual(['g']);
    // The same values again change nothing
    notified.length = 0;
    store.transact(() => {
      writer.applyGroups({
        handles: Int32Array.of(handle),
        fields: new Map<TableGroupField, unknown[]>([['visible', [false]]]),
      });
    }, 'remote');
    expect(notified[0]?.groups).toBeUndefined();
    // A change here is notified once, as before
    notified.length = 0;
    store.updateGroup('g', { visible: true });
    expect(notified).toHaveLength(1);
    expect(notified[0]?.groups?.updated).toHaveLength(1);
  });

  it('create and delete groups, and the groups created here take other handles', () => {
    const { store, writer, tables } = setup();
    const notified: StoreChange[] = [];
    store.subscribe((change) => notified.push(change));
    store.transact(() => {
      writer.applyGroups({
        handles: Int32Array.of(40),
        fields: new Map<TableGroupField, unknown[]>([
          ['id', ['far']],
          ['name', ['Far']],
          ['order', ['m']],
          ['layerId', ['a']],
        ]),
      });
    }, 'remote');
    expect(store.getGroup('far')).toMatchObject({
      id: 'far',
      name: 'Far',
      layerId: 'a',
      visible: true,
      locked: false,
      kind: 'table',
    });
    expect(notified[0]?.groups?.created?.map((group) => group.id)).toEqual(['far']);
    store.createGroup({
      id: 'near',
      layerId: 'a',
      name: 'near',
      kind: 'table',
      visible: true,
      locked: false,
    });
    expect(tables.findGroup('near')).toBeGreaterThan(40);
    expect(tables.findGroup('far')).toBe(40);
    notified.length = 0;
    store.transact(() => {
      writer.applyGroups({
        handles: Int32Array.of(40),
        fields: new Map(),
        deleted: Uint8Array.of(1),
      });
    }, 'remote');
    expect(store.getGroup('far')).toBeUndefined();
    expect(notified[0]?.groups?.deleted?.map((group) => group.id)).toEqual(['far']);
  });

  it('are moved to another layer here by putting them in a place, not by updateGroup', () => {
    const { store } = setup();
    store.createGroup({
      id: 'g',
      layerId: 'a',
      name: 'g',
      featureIds: ['r2'],
      visible: true,
      locked: false,
    });
    expect(() => store.updateGroup('g', { layerId: 'b' })).toThrow();
    store.moveItem('g', { layerId: 'b' });
    expect(store.getGroup('g')?.layerId).toBe('b');
  });
});

describe('taking in the row groups without a drawing', () => {
  it('leaves the row groups given waiting for the frames until it is called', () => {
    const { tables, writer } = createFeatureTables();
    writer.addRowBlocks('a', points(0, 10));
    const internals = featureTablesInternals(tables) as FeatureTablesInternals;
    expect(internals.hasQueuedBlocks).toBe(true);
    expect(tables.findRow('r0')).toBeUndefined();
    internals.addQueuedRowBlocks();
    expect(internals.hasQueuedBlocks).toBe(false);
    const view = tables.get('a');
    const order = Array.from(view?.listRowHandles(0, 20) ?? [], (h) => tables.getRowId(h));
    expect(order).toEqual(Array.from({ length: 10 }, (_, i) => `r${i}`));
  });

  it('builds the new rows waiting into row groups of their own and takes them in', () => {
    const { tables, writer } = createFeatureTables();
    writer.addRowBlocks('a', points(0, 4));
    const internals = featureTablesInternals(tables) as FeatureTablesInternals;
    internals.addQueuedRowBlocks();
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
    internals.addQueuedRowBlocks();
    // In row groups of the layer, not in its delta
    for (const handle of handles) {
      expect(internals.ids.mainGroup(handle)).toBeGreaterThanOrEqual(0);
      expect(internals.ids.deltaLayer(handle)).toBeLessThan(0);
    }
    expect(internals.deltaRowCount()).toBe(0);
    const view = tables.get('a');
    expect(view?.rowCount).toBe(n + 4);
    const order = Array.from(view?.listRowHandles(0, n + 4) ?? [], (h) => tables.getRowId(h));
    expect(order).toEqual(Array.from({ length: n + 4 }, (_, i) => `r${i}`));
  });

  it('throws for a row group that cannot be taken in, and the groups after it keep waiting', () => {
    const { tables, writer } = createFeatureTables();
    writer.addRowBlocks('a', points(0, 4));
    const internals = featureTablesInternals(tables) as FeatureTablesInternals;
    internals.addQueuedRowBlocks();
    // Its ids are rows already, then a group that can be taken in
    writer.addRowBlocks('a', [...points(0, 1), ...points(10, 1)]);
    expect(() => internals.addQueuedRowBlocks()).toThrow();
    expect(internals.hasQueuedBlocks).toBe(true);
    internals.addQueuedRowBlocks();
    expect(tables.findRow('r10')).toBeDefined();
  });
});

/** Compares two keys of the order (ASCII here: byte by byte is the order of the strings) */
function compareKeys(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
