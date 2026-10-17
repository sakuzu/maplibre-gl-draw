// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The items of a layer held as rows read a few at a time (`ItemWalk`): what it reads is what the
 * lists of every item read (the items next to each item, the first and the last, the members of
 * the groups), with rows of the delta, new rows read before their groups are taken in and
 * deleted rows among them; and an edit of a few items of a large layer reads the rows next to
 * them, not the rows of the layer, as many steps for a layer ten times as large.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Draw } from '../api/draw.js';
import { createDrawOnEngine } from '../api/impl/create-draw.js';
import { createEngine } from '../api/impl/engine.js';
import type { FeatureTables, RowField } from '../api/tables.js';
import { groupsInStackingOrder, groupsInStackingOrderOf } from '../store/item-lists.js';
import { createTableStore } from '../store/table-memory.js';
import { createRowBlockDataBuilder } from '../table/row-group-builder.js';
import { ROW_FLAG_DELETED } from '../table/row-group-types.js';
import { createMapStub, seededRandom } from '../test-utils.js';
import { type FeatureTablesInternals, featureTablesInternals } from './feature-tables.js';
import { groupCode, ItemWalk, rowCode } from './item-walk.js';
import { LayerTable } from './layer-table.js';

const LAYER = {
  name: 'rows',
  visible: true,
  locked: false,
  opacity: 1,
  kind: 'table' as const,
  metadata: undefined,
  styleRule: undefined,
};

/** A Store of rows of one layer `rows` of `n` points, taken in as row groups */
function storeOf(n: number) {
  const { store, writer } = createTableStore();
  store.createLayer({ ...LAYER, id: 'rows' });
  const builder = createRowBlockDataBuilder({ targetRows: 512 });
  for (let i = 0; i < n; i++) {
    builder.addRow({
      id: `r${i}`,
      type: 'Point',
      geometry: { type: 'Point', coordinates: [i % 100, Math.floor(i / 100)] },
      order: `k${String(i).padStart(6, '0')}`,
    });
  }
  writer.addRowBlocks('rows', builder.finish());
  const tables = store.tables as FeatureTables;
  const internals = featureTablesInternals(tables) as FeatureTablesInternals;
  internals.addQueuedRowBlocks();
  return { store, writer, tables, internals };
}

/** The ids of a column of UTF-8 */
function idColumn(ids: readonly string[]): { offsets: Int32Array; bytes: Uint8Array } {
  const encoder = new TextEncoder();
  const parts = ids.map((id) => encoder.encode(id));
  const offsets = new Int32Array(ids.length + 1);
  parts.forEach((part, i) => {
    offsets[i + 1] = offsets[i] + part.length;
  });
  const bytes = new Uint8Array(offsets[ids.length]);
  parts.forEach((part, i) => {
    bytes.set(part, offsets[i]);
  });
  return { offsets, bytes };
}

/**
 * The items of a layer from its order, a row at a time: its rows outside a group of features and
 * its groups (one item at each run of their members), deleted rows left out
 */
function itemsOfOrder(table: LayerTable) {
  const order = table.rowOrder();
  const kinds: number[] = [];
  const handles: number[] = [];
  const members = new Map<number, number[]>();
  let last = -1;
  let deleted = 0;
  for (let i = 0; i < order.handles.length; i++) {
    const data = order.groups[i].data;
    const r = order.rows[i];
    if ((data.flags[r] & ROW_FLAG_DELETED) !== 0) {
      deleted++;
      continue;
    }
    const group = data.groups[r];
    if (group < 0) {
      kinds.push(0);
      handles.push(data.handles[r]);
      last = -1;
      continue;
    }
    members.set(group, [...(members.get(group) ?? []), data.handles[r]]);
    if (group !== last) {
      kinds.push(1);
      handles.push(group);
      last = group;
    }
  }
  return { kinds, handles, members, rowCount: order.handles.length - deleted };
}

/** Checks every item the walk reads against the lists of every item of the layer */
function expectWalkAsLists(internals: FeatureTablesInternals): void {
  const table = internals.layerTable('rows') as LayerTable;
  const walk = new ItemWalk(table, internals);
  const items = table.itemsOf();
  // The lists are the items of the order read a row at a time, made at their sizes
  const reference = itemsOfOrder(table);
  expect(Array.from(items.kinds)).toEqual(reference.kinds);
  expect(Array.from(items.handles)).toEqual(reference.handles);
  expect(items.kinds.buffer.byteLength).toBe(items.kinds.length);
  expect(items.handles.buffer.byteLength).toBe(items.handles.length * 4);
  expect(new Map([...items.members].map(([g, m]) => [g, Array.from(m)]))).toEqual(
    reference.members,
  );
  expect(items.rowCount).toBe(reference.rowCount);
  const ordered = table.rowOrder();
  expect(ordered.groups.length).toBe(ordered.handles.length);
  expect(ordered.rows.length).toBe(ordered.handles.length);
  expect(ordered.handles.buffer.byteLength).toBe(ordered.handles.length * 4);
  const codes = Array.from(items.kinds, (kind, i) =>
    kind === 0 ? rowCode(items.handles[i]) : groupCode(items.handles[i]),
  );
  expect(walk.bottom(-1)).toBe(codes[0] ?? null);
  expect(walk.top(-1)).toBe(codes[codes.length - 1] ?? null);
  codes.forEach((code, i) => {
    expect(walk.below(code, -1), `below ${i}`).toBe(i > 0 ? codes[i - 1] : null);
    expect(walk.above(code, -1), `above ${i}`).toBe(i + 1 < codes.length ? codes[i + 1] : null);
  });
  for (const [group, members] of items.members) {
    const list = Array.from(members, rowCode);
    expect(walk.members(group)).toEqual(Array.from(members));
    expect(walk.memberCount(group)).toBe(members.length);
    expect(walk.bottom(group)).toBe(list[0]);
    expect(walk.top(group)).toBe(list[list.length - 1]);
    list.forEach((code, i) => {
      expect(walk.below(code, group)).toBe(i > 0 ? list[i - 1] : null);
      expect(walk.above(code, group)).toBe(i + 1 < list.length ? list[i + 1] : null);
    });
  }
  // Every other item skipped
  const skip = new Set(codes.filter((_, i) => i % 2 === 1));
  const kept = codes.filter((code) => !skip.has(code));
  kept.forEach((code, i) => {
    expect(walk.below(code, -1, skip)).toBe(i > 0 ? kept[i - 1] : null);
    expect(walk.above(code, -1, skip)).toBe(i + 1 < kept.length ? kept[i + 1] : null);
  });
  // The rows of the order, one step at a time
  const order = table.rowOrder();
  let at = table.firstRow();
  for (let i = 0; i < order.handles.length; i++) {
    expect(at?.group.data.handles[at.row], `row ${i}`).toBe(order.handles[i]);
    if (!at) break;
    const back = table.previousRow(at);
    expect(back?.group.data.handles[back.row] ?? null).toBe(i > 0 ? order.handles[i - 1] : null);
    at = table.nextRow(at);
  }
  expect(at).toBeNull();
}

let draw: Draw | undefined;

afterEach(() => {
  draw?.destroy();
  draw = undefined;
  vi.restoreAllMocks();
});

describe('ItemWalk', () => {
  it('reads what the lists of every item read, as rows are written, deleted and created', () => {
    for (const seed of [1, 2, 3]) {
      const random = seededRandom(seed);
      const { store, writer, tables, internals } = storeOf(300);
      store.transact(() => {
        for (const id of ['g0', 'g1', 'g2']) {
          store.createGroup({
            id,
            layerId: 'rows',
            name: id,
            kind: 'table',
            visible: true,
            locked: false,
          });
        }
      });
      let next = 0;
      for (let step = 0; step < 40; step++) {
        // Rows there (a row deleted from elsewhere is forgotten after a while)
        const there: number[] = [];
        const cursor = tables.scan({ layerIds: ['rows'] });
        for (let batch = cursor.next(); batch; batch = cursor.next()) there.push(...batch);
        const picked = Array.from({ length: 6 }, () => there[Math.floor(random() * there.length)]);
        const handles = Int32Array.from(new Set(picked));
        const r = random();
        let fields: Map<RowField, unknown[]>;
        let deleted: Uint8Array | undefined;
        if (r < 0.35) {
          fields = new Map<RowField, unknown[]>([
            ['order', Array.from(handles, () => `k${String(Math.floor(random() * 300))}`)],
          ]);
        } else if (r < 0.65) {
          fields = new Map<RowField, unknown[]>([
            ['groupId', Array.from(handles, () => `g${Math.floor(random() * 3)}`)],
            ['member', Array.from(handles, () => String.fromCharCode(65 + random() * 50))],
          ]);
        } else if (r < 0.75) {
          fields = new Map<RowField, unknown[]>([
            ['groupId', Array.from(handles, () => '')],
            ['member', Array.from(handles, () => undefined)],
          ]);
        } else if (r < 0.85) {
          fields = new Map();
          deleted = new Uint8Array(handles.length).fill(1);
        } else {
          // New rows, enough to be read before their groups are taken in
          const fresh = Array.from({ length: 70 }, () => `n${next++}`);
          const created = writer.allocateHandles(idColumn(fresh));
          store.transact(() =>
            writer.apply(
              {
                handles: created,
                fields: new Map<RowField, unknown[]>([
                  ['type', fresh.map(() => 'Point')],
                  ['layerId', fresh.map(() => 'rows')],
                  ['geometry', fresh.map(() => ({ type: 'Point', coordinates: [0, 0] }))],
                  ['order', fresh.map(() => `k${String(Math.floor(random() * 300))}z`)],
                ]),
              },
              {},
            ),
          );
          expectWalkAsLists(internals);
          continue;
        }
        store.transact(() => writer.apply({ handles, fields, deleted }), 'remote');
        expectWalkAsLists(internals);
        // The groups in stacking order, read where each stands
        const groups = store.listGroups();
        expect(groupsInStackingOrderOf(store, groups.slice(1))).toEqual(
          groupsInStackingOrder(store).filter((group) => group.id !== groups[0].id),
        );
        if (step % 10 === 9) {
          internals.addQueuedRowBlocks();
          internals.flushVersions();
          expectWalkAsLists(internals);
        }
      }
    }
  });
});

describe('an edit of a few items of a layer held as rows', () => {
  /**
   * Groups and ungroups 50 rows spread over the layer, brings them to the front and back, puts
   * 300 rows in front, sends a group to the back and gives it a new key from elsewhere: the
   * steps read from the rows next to the items, and whether the list of every row or item of the
   * layer was made
   */
  function edit(n: number): { steps: number; listed: number } {
    const { store, writer, tables, internals } = storeOf(n);
    const engine = createEngine(
      createMapStub().map,
      { store, initDefaultLayer: false },
      { deferDefaultMode: true },
    );
    draw = createDrawOnEngine(engine, { store, initDefaultLayer: false });
    engine.enterDefaultMode();
    const at = (k: number, count: number) => `r${Math.floor((k * n) / count)}`;
    const members = Array.from({ length: 50 }, (_, k) => at(k, 50));
    const many = Array.from({ length: 300 }, (_, k) => at(k, 300));
    // The lists are made once before the edits (as a host reads them)
    internals.layerTable('rows')?.itemsOf();
    const counted = ['previousRow', 'nextRow', 'rowNotBefore', 'firstRow', 'lastRow'] as const;
    const spies = counted.map((name) => vi.spyOn(LayerTable.prototype, name));
    const listed = [
      vi.spyOn(LayerTable.prototype, 'rowOrder'),
      vi.spyOn(LayerTable.prototype, 'itemsOf'),
    ];
    const group = draw.groups.create({ featureIds: members });
    draw.features.moveMany(members.slice(0, 10), { layerId: 'rows', above: null });
    if (group) draw.groups.delete(group.id);
    draw.features.moveMany(members, { layerId: 'rows', below: null });
    draw.features.moveMany(many, { layerId: 'rows', above: null });
    const again = draw.groups.create({ featureIds: members.slice(0, 5) });
    if (again) draw.groups.move(again.id, { layerId: 'rows', below: null });
    const handle = internals.groups.handleOfId(again?.id ?? '');
    store.transact(
      () =>
        writer.applyGroups({
          handles: Int32Array.of(handle),
          fields: new Map([['order', ['0']]]),
        }),
      'remote',
    );
    void tables;
    return {
      steps: spies.reduce((sum, spy) => sum + spy.mock.calls.length, 0),
      listed: listed.reduce((sum, spy) => sum + spy.mock.calls.length, 0),
    };
  }

  it('reads the rows next to the items, not the rows of the layer', () => {
    const small = edit(2_000);
    vi.restoreAllMocks();
    draw?.destroy();
    draw = undefined;
    const large = edit(20_000);
    expect(small.listed).toBe(0);
    expect(large.listed).toBe(0);
    expect(small.steps).toBeGreaterThan(0);
    // As many steps for a layer ten times as large (the rows passed around the items are as many)
    expect(large.steps).toBeLessThanOrEqual(small.steps * 1.2);
  });
});
