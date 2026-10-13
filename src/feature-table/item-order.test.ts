// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The changes of the order a Store of rows notifies (`order`, 13.6 of the design): a write of
 * few rows tells a move per item, which made back from the last one puts the items as they were;
 * a write of many rows tells one move of the rows per layer, whose values before written back
 * put them back; new keys of groups of features tell the groups moved
 */

import { describe, expect, it } from 'vitest';
import type { FeatureTables, FeatureTablesWriter, RowField } from '../api/tables.js';
import { createTableMemoryStore } from '../store/table-memory.js';
import type { Feature, ItemMove, ItemPosition, RowRangeMove, StoreChange } from '../store/types.js';
import { seededRandom } from '../test-utils.js';
import { featureTablesInternals } from './feature-tables.js';
import { ORDER_ITEM_LIMIT } from './item-order.js';

type Lists = Map<string, string[]>;

/** The items of every layer and the members of every group, by `layerId/groupId` */
function listsOf(tables: FeatureTables, layerIds: readonly string[]): Lists {
  const groups = featureTablesInternals(tables)?.groups;
  const out: Lists = new Map();
  for (const layerId of layerIds) {
    const view = tables.layer(layerId);
    if (!view) continue;
    const items = view.itemsInOrder(0, view.itemCount);
    const ids: string[] = [];
    for (let i = 0; i < items.kinds.length; i++) {
      const handle = items.handles[i];
      if (items.kinds[i] === 0) {
        ids.push(tables.idOf(handle) as string);
        continue;
      }
      const id = groups?.idOf(handle) as string;
      ids.push(id);
      const members = view.groupMembersInOrder(handle, 0, view.groupMemberCount(handle));
      // The members of a group go with it to another layer: a group is named by itself
      out.set(
        `/${id}`,
        Array.from(members, (h) => tables.idOf(h) as string),
      );
    }
    if (ids.length > 0) out.set(`${layerId}/`, ids);
  }
  return out;
}

const keyOf = (p: ItemPosition) => (p.groupId ? `/${p.groupId}` : `${p.layerId}/`);

/** Makes the moves back, from the last one */
function undo(lists: Lists, moves: readonly ItemMove[]): Lists {
  const out: Lists = new Map([...lists].map(([key, items]) => [key, [...items]]));
  for (const move of [...moves].reverse()) {
    for (const items of out.values()) {
      const at = items.indexOf(move.itemId);
      if (at >= 0) items.splice(at, 1);
    }
    const from = move.from;
    if (!from) continue;
    const items = out.get(keyOf(from)) ?? [];
    out.set(keyOf(from), items);
    const at = from.below === null ? 0 : items.indexOf(from.below) + 1;
    expect(at, `${from.below} is in ${keyOf(from)}`).toBeGreaterThanOrEqual(0);
    items.splice(at, 0, move.itemId);
    expect(items[at + 1] ?? null).toBe(from.above);
  }
  for (const [key, items] of [...out]) if (items.length === 0) out.delete(key);
  return out;
}

function point(id: string, layerId: string): Feature {
  return {
    id,
    type: 'Point',
    geometry: { type: 'Point', coordinates: [0, 0] },
    layerId,
    groupId: undefined,
    properties: {},
    style: {},
    visible: true,
    locked: false,
  };
}

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
  const tables = store.tables as FeatureTables;
  const notified: StoreChange[] = [];
  store.subscribe((change) => notified.push(change));
  return { store, writer, tables, notified };
}

/** Writes keys of rows from elsewhere */
function writeKeys(
  store: ReturnType<typeof setup>['store'],
  writer: FeatureTablesWriter,
  tables: FeatureTables,
  keys: ReadonlyArray<[string, string]>,
): void {
  store.transact(
    () =>
      writer.apply({
        handles: Int32Array.from(keys, ([id]) => tables.handleOf(id) as number),
        fields: new Map<RowField, unknown[]>([['order', keys.map(([, key]) => key)]]),
      }),
    'remote',
  );
}

describe('the changes of the order of a Store of rows', () => {
  it('made back, put the items as they were before each write', () => {
    for (const seed of [1, 2, 3, 4]) {
      const random = seededRandom(seed);
      const { store, writer, tables, notified } = setup();
      let next = 0;
      let movedBetween = 0;
      for (let step = 0; step < 100; step++) {
        const ids: string[] = [];
        for (const layerId of ['a', 'b']) {
          const cursor = tables.scan({ layerIds: [layerId] });
          for (let batch = cursor.next(); batch; batch = cursor.next()) {
            for (const handle of batch) ids.push(tables.idOf(handle) as string);
          }
        }
        const pick = () => ids[Math.floor(random() * ids.length)];
        const before = listsOf(tables, ['a', 'b']);
        notified.length = 0;
        const r = random();
        const layerId = random() < 0.5 ? 'a' : 'b';
        if (r < 0.25 || ids.length < 4) {
          store.createFeature(point(`f${next++}`, layerId));
        } else if (r < 0.35) {
          store.deleteFeature(pick());
        } else if (r < 0.5) {
          store.updateFeature(pick(), { layerId, groupId: undefined });
        } else if (r < 0.6) {
          const members = ids.filter((id) => !store.getFeature(id)?.groupId).slice(0, 2);
          if (members.length < 2) continue;
          store.transact(() => {
            for (const id of members) store.updateFeature(id, { layerId: 'a' });
            store.createGroup({
              id: `g${next++}`,
              layerId: 'a',
              name: 'g',
              kind: 'table',
              visible: true,
              locked: false,
            });
            for (const id of members) store.updateFeature(id, { groupId: `g${next - 1}` });
          });
        } else if (r < 0.65) {
          const member = ids.find((id) => store.getFeature(id)?.groupId);
          if (!member) continue;
          store.updateFeature(member, { groupId: undefined });
        } else if (r < 0.72) {
          const group = store.listGroups()[0];
          if (!group) continue;
          store.deleteGroup(group.id);
        } else if (r < 0.85) {
          // Items put in a place of a layer at once
          const moved = [pick(), pick(), ...store.listGroups().map((g) => g.id)].filter(
            (id, k, all) => all.indexOf(id) === k && !store.getFeature(id)?.groupId,
          );
          const target = listsOf(tables, [layerId]).get(`${layerId}/`) ?? [];
          const below = target[Math.floor(random() * target.length)] ?? null;
          store.moveItems(moved.slice(0, 3), { layerId, below });
        } else {
          // Keys written from elsewhere, a few rows at a time
          const keys: Array<[string, string]> = [];
          for (let k = 0; k < 3; k++) {
            const id = pick();
            if (store.getFeature(id)?.groupId || keys.some(([other]) => other === id)) continue;
            keys.push([id, String.fromCharCode(65 + Math.floor(random() * 50))]);
          }
          if (keys.length === 0) continue;
          writeKeys(store, writer, tables, keys);
        }
        const moves = notified.flatMap((change) => change.order ?? []) as ItemMove[];
        expect(moves.every((move) => move.kind === 'item')).toBe(true);
        movedBetween += moves.filter((move) => move.from && move.to).length;
        expect(undo(listsOf(tables, ['a', 'b']), moves), `seed ${seed}, step ${step}`).toEqual(
          before,
        );
      }
      // Items were put in other places, not only created and deleted
      expect(movedBetween).toBeGreaterThan(20);
    }
  });

  it('tells many rows put in another place at once as one move of the layer', () => {
    const { store, writer, tables, notified } = setup();
    const count = ORDER_ITEM_LIMIT + 10;
    store.transact(() => {
      for (let i = 0; i < count; i++) store.createFeature(point(`f${i}`, 'a'));
    });
    const before = listsOf(tables, ['a']);
    notified.length = 0;
    // Every row put in front of the first one, in the order they were: one after the other
    const ids = before.get('a/') as string[];
    const moved = ids.slice(5);
    writeKeys(
      store,
      writer,
      tables,
      moved.map((id, i) => [id, `0${String(i).padStart(4, '0')}`]),
    );
    const order = notified.flatMap((change) => change.order ?? []);
    expect(order).toHaveLength(1);
    const move = order[0] as RowRangeMove;
    expect(move.kind).toBe('rows');
    expect(Array.from(move.handles, (h) => tables.idOf(h))).toEqual(moved);
    expect(move.to).toEqual({ layerId: 'a', groupId: undefined, below: null, above: ids[0] });
    expect(move.belows).toBeUndefined();
    // The values before written back put the rows back
    store.transact(() => writer.apply(move.before), 'remote');
    expect(listsOf(tables, ['a'])).toEqual(before);
  });

  it('tells rows each put elsewhere with the item just below each', () => {
    const { store, writer, tables, notified } = setup();
    const count = ORDER_ITEM_LIMIT * 2 + 4;
    store.transact(() => {
      for (let i = 0; i < count; i++) store.createFeature(point(`f${i}`, 'a'));
    });
    const before = listsOf(tables, ['a']);
    const ids = before.get('a/') as string[];
    notified.length = 0;
    // Every other row goes up by one: its key between the next row and the one after
    const keyOfRow = (id: string) => {
      const handle = tables.handleOf(id) as number;
      const place = featureTablesInternals(tables)?.placeOf(handle);
      return place ? new TextDecoder().decode(rowKey(place.group.data.itemKeys, place.row)) : '';
    };
    const keys: Array<[string, string]> = [];
    for (let i = 0; i + 1 < ids.length; i += 2) keys.push([ids[i], `${keyOfRow(ids[i + 1])}V`]);
    writeKeys(store, writer, tables, keys);
    const order = notified.flatMap((change) => change.order ?? []);
    expect(order).toHaveLength(1);
    const move = order[0] as RowRangeMove;
    expect(move.to).toBeUndefined();
    // The item just below each row moved is the one it went past
    const below = Array.from(move.belows?.handles ?? [], (h) => tables.idOf(h));
    expect(below).toEqual(keys.map(([id]) => ids[ids.indexOf(id) + 1]));
    store.transact(() => writer.apply(move.before), 'remote');
    expect(listsOf(tables, ['a'])).toEqual(before);
  });

  it('tells a group of features given a new key as one item moved', () => {
    const { store, writer, tables, notified } = setup();
    store.transact(() => {
      for (let i = 0; i < 4; i++) store.createFeature(point(`f${i}`, 'a'));
      store.createGroup({
        id: 'g',
        layerId: 'a',
        name: 'g',
        kind: 'table',
        visible: true,
        locked: false,
      });
      store.updateFeature('f0', { groupId: 'g' });
    });
    const lists = listsOf(tables, ['a']);
    expect(lists.get('a/')).toEqual(['f1', 'f2', 'f3', 'g']);
    notified.length = 0;
    const groups = featureTablesInternals(tables)?.groups;
    store.transact(
      () =>
        writer.applyGroups({
          handles: Int32Array.of(groups?.handleOfId('g') as number),
          fields: new Map([['order', ['0']]]),
        }),
      'remote',
    );
    expect(notified.flatMap((change) => change.order ?? [])).toEqual([
      {
        kind: 'item',
        itemId: 'g',
        from: { layerId: 'a', groupId: undefined, below: 'f3', above: null },
        to: { layerId: 'a', groupId: undefined, below: null, above: 'f1' },
      },
    ]);
  });
});

/** The bytes of an entry of a column */
function rowKey(column: { offsets: Int32Array; bytes: Uint8Array }, row: number): Uint8Array {
  return column.bytes.subarray(column.offsets[row], column.offsets[row + 1]);
}
