// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The changes of the order made from the items a write disturbs and the items next to them
 * (`item-order.ts`, read with `ItemWalk`) are the changes made from the lists of every item of
 * the layers and the groups, as they were made before: the same moves, in the same order, for
 * random writes of few rows and of many, and for new keys of groups of features. What makes them
 * from the whole lists is kept here as the reference.
 */

import { describe, expect, it } from 'vitest';
import type { FeatureTables, FeatureTablesWriter, RowField } from '../api/tables.js';
import type { ItemMove, ItemOrderChange, ItemPosition, RowsMove } from '../shared/types/model.js';
import {
  diffItemOrder,
  type OrderContainer,
  trimmedContainer,
} from '../shared/utils/item-moves.js';
import { createTableStore } from '../store/table-memory.js';
import type { Feature, StoreChange } from '../store/types.js';
import { ROW_FLAG_DELETED } from '../table/row-group-types.js';
import { compareRowKeys } from '../table/row-keys.js';
import { utf8String } from '../table/utf8-column.js';
import { seededRandom } from '../test-utils.js';
import { type FeatureTablesInternals, featureTablesInternals } from './feature-tables.js';
import { groupKeyMoves, type ItemOrderSource, ORDER_ITEM_LIMIT } from './item-order.js';
import type { LayerItems, LayerTable, RowGroup } from './layer-table.js';
import type { GroupHandle, RowHandle } from './types.js';

// === The reference: the changes made from the lists of every item ===

/** The number of a row as an item */
function rowCode(handle: RowHandle): number {
  return handle * 2;
}

/** The number of a group of features as an item */
function groupCode(group: GroupHandle): number {
  return group * 2 + 1;
}

/** The items of a layer as numbers */
function codesOf(items: LayerItems): Int32Array {
  const out = new Int32Array(items.kinds.length);
  for (let i = 0; i < out.length; i++) {
    out[i] = items.kinds[i] === 0 ? rowCode(items.handles[i]) : groupCode(items.handles[i]);
  }
  return out;
}

/** The members of a group as numbers */
function memberCodesOf(members: Int32Array | undefined): Int32Array {
  if (!members) return new Int32Array(0);
  const out = new Int32Array(members.length);
  for (let i = 0; i < out.length; i++) out[i] = rowCode(members[i]);
  return out;
}

/** The place a row is read from (its group and its row there) */
interface RowAt {
  readonly layer: LayerTable;
  readonly group: RowGroup;
  readonly row: number;
}

/** The fields of a row that place it, as a row holds them (what `RowsMove.before` keeps) */
const PLACE_FIELDS: readonly RowField[] = ['layerId', 'groupId', 'order', 'member'];

/**
 * The items of the layers and the groups a write touches as they were, and the rows it puts in
 * another place, to make the changes of the order once it is written
 */
class FullListWatch {
  private readonly layers = new Map<string, LayerItems | null>();
  private readonly groupsBefore = new Map<
    GroupHandle,
    { layerId: string; members: Int32Array | undefined }
  >();
  private readonly moved = new Set<number>();
  private readonly deleted: number[] = [];
  /** The layer, group and keys of each row moved before the write (absent for a new row) */
  private readonly before = new Map<RowHandle, readonly unknown[]>();

  constructor(private readonly source: ItemOrderSource) {}

  /** Whether the write puts a row in another place, creates or deletes one */
  get changes(): boolean {
    return this.moved.size > 0;
  }

  /** A layer whose items the write changes */
  watchLayer(layerId: string): void {
    if (!this.layers.has(layerId)) this.layers.set(layerId, null);
  }

  /** A group of features whose members the write changes (its layer too) */
  watchGroup(group: GroupHandle): void {
    if (group < 0 || this.groupsBefore.has(group)) return;
    const layerId = this.source.groups.layerOf(group);
    if (layerId === undefined) return;
    this.watchLayer(layerId);
    this.groupsBefore.set(group, { layerId, members: undefined });
  }

  /**
   * A row the write puts in another place, creates or deletes (its layer and group before are
   * watched by the caller)
   *
   * @param deleting Whether the write deletes it
   */
  row(handle: RowHandle, deleting: boolean): void {
    const code = rowCode(handle);
    if (this.moved.has(code)) return;
    this.moved.add(code);
    if (deleting) this.deleted.push(code);
  }

  /**
   * Keeps what the changes are made from, before the write: the items of the layers and the
   * members of the groups watched (when the rows moved are few), or the layers, groups and keys
   * of the rows moved (when they are many)
   */
  keep(): void {
    const many = this.moved.size > ORDER_ITEM_LIMIT;
    const deleted = new Set(this.deleted);
    for (const code of this.moved) {
      // The rows deleted tell their place before only one at a time
      if (many && deleted.has(code)) continue;
      const handle = code >> 1;
      const at = this.source.placeOf(handle);
      if (!at || isDeleted(at)) continue;
      const data = at.group.data;
      const group = data.groups[at.row];
      this.before.set(handle, [
        at.layer.layerId,
        group >= 0 ? this.source.groups.idOf(group) : undefined,
        utf8String(data.itemKeys, at.row),
        group >= 0 ? utf8String(data.memberKeys, at.row) : undefined,
      ]);
    }
    if (many) return;
    for (const layerId of this.layers.keys()) {
      this.layers.set(layerId, this.source.layer(layerId)?.itemsOf() ?? null);
    }
    for (const [group, entry] of this.groupsBefore) {
      entry.members = this.layers.get(entry.layerId)?.members.get(group);
    }
  }

  /** The changes of the order the write made (none when it put nothing in another place) */
  finish(): ItemOrderChange[] {
    if (this.moved.size === 0) return [];
    if (this.moved.size > ORDER_ITEM_LIMIT) return this.rowRanges();
    const containers: OrderContainer<number>[] = [];
    const beforeItems = new Set<number>();
    const afterItems = new Set<number>();
    for (const [layerId, items] of this.layers) {
      const after = this.source.layer(layerId)?.itemsOf();
      const before = items ? codesOf(items) : new Int32Array(0);
      const now = after ? codesOf(after) : new Int32Array(0);
      for (const code of before) if ((code & 1) === 1) beforeItems.add(code);
      for (const code of now) if ((code & 1) === 1) afterItems.add(code);
      containers.push(trimmedContainer(layerId, undefined, before, now));
    }
    // The groups the rows left or went to (watched from their layer)
    const groups = new Set<GroupHandle>(this.groupsBefore.keys());
    for (const [layerId] of this.layers) {
      const after = this.source.layer(layerId)?.itemsOf();
      for (const [group, members] of after?.members ?? []) {
        if (!groups.has(group) && members.some((handle) => this.moved.has(rowCode(handle)))) {
          groups.add(group);
        }
      }
    }
    for (const group of groups) {
      const before = this.groupsBefore.get(group);
      const layerId = this.source.groups.layerOf(group) ?? before?.layerId;
      if (layerId === undefined) continue;
      const after = this.source.layer(layerId)?.itemsOf().members.get(group);
      containers.push(
        trimmedContainer(
          layerId,
          this.source.groups.idOf(group) ?? '',
          memberCodesOf(before?.members),
          memberCodesOf(after),
        ),
      );
    }
    // A group of features whose last member left is an item deleted
    const deleted = [...this.deleted];
    for (const code of beforeItems) if (!afterItems.has(code)) deleted.push(code);
    const groupIds = new Map<GroupHandle, string>();
    const moves = diffItemOrder(containers, {
      moved: this.moved,
      deleted,
      isGroup: (code) => (code & 1) === 1,
      idOf: (code) => this.idOf(code, groupIds),
    }) as ItemMove[];
    // A row that was somewhere tells its place before
    const handleOf = new Map<string, RowHandle>();
    for (const handle of this.before.keys()) {
      const id = this.source.idOf(handle);
      if (id !== undefined) handleOf.set(id, handle);
    }
    return moves.map((move) => {
      const handle = move.from ? handleOf.get(move.itemId) : undefined;
      if (handle === undefined) return move;
      const values = this.before.get(handle) as readonly unknown[];
      const fields = new Map<RowField, unknown[]>(
        PLACE_FIELDS.map((field, k) => [field, [values[k]]]),
      );
      return { ...move, before: { handles: Int32Array.of(handle), fields } };
    });
  }

  /** The id of an item */
  private idOf(code: number, groupIds: Map<GroupHandle, string>): string {
    const handle = code >> 1;
    if ((code & 1) === 0) return this.source.idOf(handle) ?? '';
    let id = groupIds.get(handle) ?? this.source.groups.idOf(handle);
    if (id === undefined) id = '';
    groupIds.set(handle, id);
    return id;
  }

  /**
   * The rows moved told together, one move per layer: the rows in a place before and after, in
   * their new order, with the place they were put at together or the item just below each
   */
  private rowRanges(): RowsMove[] {
    const byLayer = new Map<LayerTable, RowAt[]>();
    for (const handle of this.before.keys()) {
      const at = this.source.placeOf(handle);
      if (!at || isDeleted(at)) continue;
      let list = byLayer.get(at.layer);
      if (!list) {
        list = [];
        byLayer.set(at.layer, list);
      }
      list.push(at);
    }
    const out: RowsMove[] = [];
    const groupIds = new Map<GroupHandle, string>();
    for (const [layer, rows] of byLayer) {
      rows.sort((a, b) =>
        compareRowKeys(a.group.data, a.row, b.group.data, b.row, this.source.groups),
      );
      const handles = Int32Array.from(rows, (at) => at.group.data.handles[at.row]);
      const fields = new Map<RowField, unknown[]>(PLACE_FIELDS.map((field) => [field, []]));
      for (const handle of handles) {
        const values = this.before.get(handle) as readonly unknown[];
        PLACE_FIELDS.forEach((field, k) => {
          (fields.get(field) as unknown[]).push(values[k]);
        });
      }
      const before = { handles, fields };
      // Where each row is among the items of the layer, or the members of its group
      const items = layer.itemsOf();
      const itemIndex = new Map<number, number>();
      const codes = codesOf(items);
      codes.forEach((code, i) => {
        itemIndex.set(code, i);
      });
      const memberIndex = new Map<GroupHandle, Map<RowHandle, number>>();
      const belowOf = (at: RowAt): { kind: number; handle: number } => {
        const handle = at.group.data.handles[at.row];
        const group = at.group.data.groups[at.row];
        if (group >= 0) {
          const members = items.members.get(group) ?? new Int32Array(0);
          let index = memberIndex.get(group);
          if (!index) {
            index = new Map();
            for (let i = 0; i < members.length; i++) index.set(members[i], i);
            memberIndex.set(group, index);
          }
          const i = index.get(handle) ?? 0;
          return i > 0 ? { kind: 0, handle: members[i - 1] } : { kind: 0, handle: -1 };
        }
        const i = itemIndex.get(rowCode(handle)) ?? 0;
        if (i === 0) return { kind: 0, handle: -1 };
        const code = codes[i - 1];
        return { kind: code & 1, handle: code >> 1 };
      };
      // Put together: one after the other, in the same group (or none)
      const first = rows[0];
      const group = first.group.data.groups[first.row];
      let together = rows.every((at) => at.group.data.groups[at.row] === group);
      for (let k = 1; together && k < rows.length; k++) {
        const below = belowOf(rows[k]);
        if (below.kind !== 0 || below.handle !== handles[k - 1]) together = false;
      }
      if (together) {
        const below = belowOf(first);
        const last = rows[rows.length - 1];
        const lastHandle = last.group.data.handles[last.row];
        let above: number | null = null;
        if (group >= 0) {
          const members = items.members.get(group) ?? new Int32Array(0);
          const i = (memberIndex.get(group)?.get(lastHandle) ?? members.length) + 1;
          above = i < members.length ? rowCode(members[i]) : null;
        } else {
          const i = (itemIndex.get(rowCode(lastHandle)) ?? codes.length) + 1;
          above = i < codes.length ? codes[i] : null;
        }
        const to: ItemPosition = {
          layerId: layer.layerId,
          groupId: group >= 0 ? this.source.groups.idOf(group) : undefined,
          below:
            below.handle < 0
              ? null
              : this.idOf(
                  below.kind === 0 ? rowCode(below.handle) : groupCode(below.handle),
                  groupIds,
                ),
          above: above === null ? null : this.idOf(above, groupIds),
        };
        out.push({ kind: 'rows', layerId: layer.layerId, handles, to, before });
        continue;
      }
      const kinds = new Uint8Array(rows.length);
      const belows = new Int32Array(rows.length);
      rows.forEach((at, k) => {
        const below = belowOf(at);
        kinds[k] = below.kind;
        belows[k] = below.handle;
      });
      out.push({
        kind: 'rows',
        layerId: layer.layerId,
        handles,
        belows: { kinds, handles: belows },
        before,
      });
    }
    return out;
  }
}

/** Whether the row a place reads is deleted */
function isDeleted(at: RowAt): boolean {
  return (at.group.data.flags[at.row] & ROW_FLAG_DELETED) !== 0;
}

/**
 * The moves of groups of features given new keys of their order, made before the keys go in: the
 * items of their layer as they are, and as they are with the new keys (a group that has no member
 * is not an item, and is not moved)
 */
function fullGroupKeyMoves(
  source: ItemOrderSource,
  layerId: string,
  orders: ReadonlyMap<GroupHandle, string>,
): ItemMove[] {
  const layer = source.layer(layerId);
  if (!layer) return [];
  const before = codesOf(layer.itemsOf());
  const moved = new Set<number>();
  for (const group of orders.keys()) moved.add(groupCode(group));
  const keyOf = (code: number): [string, string] => {
    const handle = code >> 1;
    if ((code & 1) === 1) {
      return [
        orders.get(handle) ?? source.groups.orderOf(handle) ?? '',
        source.groups.idOf(handle) ?? '',
      ];
    }
    const at = source.placeOf(handle);
    return [at ? utf8String(at.group.data.itemKeys, at.row) : '', source.idOf(handle) ?? ''];
  };
  const compare = (a: [string, string], b: [string, string]): number =>
    compareCodePoints(a[0], b[0]) || compareCodePoints(a[1], b[1]);
  const after: number[] = [];
  const placing: number[] = [];
  for (const code of before) {
    if (moved.has(code)) placing.push(code);
    else after.push(code);
  }
  if (placing.length === 0) return [];
  placing.sort((a, b) => compare(keyOf(a), keyOf(b)));
  for (const code of placing) {
    const key = keyOf(code);
    let lo = 0;
    let hi = after.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (compare(keyOf(after[mid]), key) < 0) lo = mid + 1;
      else hi = mid;
    }
    after.splice(lo, 0, code);
  }
  return diffItemOrder([trimmedContainer(layerId, undefined, before, after)], {
    moved,
    deleted: [],
    isGroup: (code) => (code & 1) === 1,
    idOf: (code) =>
      ((code & 1) === 1 ? source.groups.idOf(code >> 1) : source.idOf(code >> 1)) ?? '',
  });
}

/** The order of two strings by their code points (the order of their UTF-8 bytes) */
function compareCodePoints(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a.codePointAt(i) as number;
    const y = b.codePointAt(i) as number;
    if (x !== y) return x - y;
    if (x > 0xffff) i++;
  }
  return a.length - b.length;
}

// === The tests ===

/** The source of the changes of the order of the tables of a Store */
function sourceOf(internals: FeatureTablesInternals): ItemOrderSource {
  return {
    layer: (layerId) => internals.layerTable(layerId),
    groups: internals.groups,
    idOf: (handle) => internals.ids.idOf(handle),
    placeOf: (handle) => internals.placeOf(handle),
  };
}

/** The reference watch of a write, given the rows as the tables give them (`watchOrder`) */
function referenceWatch(
  internals: FeatureTablesInternals,
  patch: { handles: Int32Array; fields: Map<RowField, unknown[]>; deleted?: Uint8Array },
): FullListWatch | null {
  const watch = new FullListWatch(sourceOf(internals));
  const { handles, fields, deleted } = patch;
  const layerIds = fields.get('layerId');
  const groupIds = fields.get('groupId');
  const orders = fields.get('order');
  const members = fields.get('member');
  const groupOf = (value: unknown): GroupHandle =>
    typeof value === 'string' && value !== '' ? internals.groups.handleOfId(value) : -1;
  for (let i = 0; i < handles.length; i++) {
    const handle = handles[i];
    const place = internals.placeOf(handle);
    const deleting = !!deleted?.[i];
    if (!place || (place.group.data.flags[place.row] & ROW_FLAG_DELETED) !== 0) {
      const layerId = (layerIds?.[i] as string | undefined) ?? place?.layer.layerId;
      if (deleting || layerId === undefined) continue;
      watch.watchLayer(layerId);
      watch.watchGroup(groupOf(groupIds?.[i]));
      watch.row(handle, false);
      continue;
    }
    const data = place.group.data;
    const row = place.row;
    const group = data.groups[row];
    if (deleting) {
      watch.watchLayer(place.layer.layerId);
      watch.watchGroup(group);
      watch.row(handle, true);
      continue;
    }
    const layerId = layerIds?.[i] as string | undefined;
    const nextGroup = groupIds ? groupOf(groupIds[i]) : group;
    const order = orders?.[i];
    const moved =
      (layerId !== undefined && layerId !== place.layer.layerId) ||
      nextGroup !== group ||
      (order !== undefined && order !== utf8String(data.itemKeys, row)) ||
      (members !== undefined &&
        nextGroup >= 0 &&
        (members[i] ?? '') !== utf8String(data.memberKeys, row));
    if (!moved) continue;
    watch.watchLayer(place.layer.layerId);
    if (layerId !== undefined) watch.watchLayer(layerId);
    watch.watchGroup(group);
    watch.watchGroup(nextGroup);
    watch.row(handle, false);
  }
  if (!watch.changes) return null;
  watch.keep();
  return watch;
}

function point(id: string, layerId: string, x: number): Feature {
  return {
    id,
    type: 'Point',
    geometry: { type: 'Point', coordinates: [x, 0] },
    layerId,
    groupId: undefined,
    properties: {},
    style: {},
    visible: true,
    locked: false,
  };
}

const LAYERS = ['a', 'b'];
const GROUPS = ['g0', 'g1', 'g2', 'g3'];

function setup(rows: number) {
  const { store, writer } = createTableStore();
  for (const id of LAYERS) {
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
  store.transact(() => {
    for (let i = 0; i < rows; i++) store.createFeature(point(`f${i}`, LAYERS[i % 2], i));
    GROUPS.forEach((id, k) => {
      store.createGroup({
        id,
        layerId: LAYERS[k % 2],
        name: id,
        kind: 'table',
        visible: true,
        locked: false,
      });
    });
  });
  const tables = store.tables as FeatureTables;
  const internals = featureTablesInternals(tables) as FeatureTablesInternals;
  const notified: StoreChange[] = [];
  store.subscribe((change) => notified.push(change));
  return { store, writer, tables, internals, notified };
}

/** A key of the order at random (a few letters) */
function randomKey(random: () => number): string {
  const n = 1 + Math.floor(random() * 3);
  let key = '';
  for (let k = 0; k < n; k++) key += String.fromCharCode(65 + Math.floor(random() * 58));
  return key;
}

/** The ids of the rows of the layers, in their order */
function rowIds(tables: FeatureTables): string[] {
  const out: string[] = [];
  const cursor = tables.scan({ layerIds: LAYERS });
  for (let batch = cursor.next(); batch; batch = cursor.next()) {
    for (const handle of batch) out.push(tables.getRowId(handle) as string);
  }
  return out;
}

/** A write of rows from elsewhere at random: keys, layers, groups, deletions or new rows */
function randomPatch(
  random: () => number,
  tables: FeatureTables,
  writer: FeatureTablesWriter,
  internals: FeatureTablesInternals,
  next: { value: number },
  many: boolean,
): { handles: Int32Array; fields: Map<RowField, unknown[]>; deleted?: Uint8Array } | null {
  const ids = rowIds(tables);
  if (ids.length < 4) return null;
  const count = many
    ? ORDER_ITEM_LIMIT + 1 + Math.floor(random() * 20)
    : 1 + Math.floor(random() * 6);
  // Rows at random, each once
  const pool = [...ids];
  const picked: string[] = [];
  while (picked.length < Math.min(count, pool.length)) {
    const k = picked.length + Math.floor(random() * (pool.length - picked.length));
    [pool[picked.length], pool[k]] = [pool[k], pool[picked.length]];
    picked.push(pool[picked.length]);
  }
  const handles = Int32Array.from(picked, (id) => tables.findRow(id) as number);
  const layerOfRow = (handle: number) => internals.placeOf(handle)?.layer.layerId ?? 'a';
  const kind = random();
  if (kind < 0.3 || many) {
    // New keys of their order (a member keeps its place in its group)
    return {
      handles,
      fields: new Map<RowField, unknown[]>([['order', picked.map(() => randomKey(random))]]),
    };
  }
  if (kind < 0.45) {
    // To a layer, outside a group
    return {
      handles,
      fields: new Map<RowField, unknown[]>([
        ['layerId', picked.map(() => LAYERS[Math.floor(random() * 2)])],
        ['groupId', picked.map(() => '')],
        ['member', picked.map(() => undefined)],
        ['order', picked.map(() => randomKey(random))],
      ]),
    };
  }
  if (kind < 0.65) {
    // Into a group of their layer, at a key in it
    return {
      handles,
      fields: new Map<RowField, unknown[]>([
        [
          'groupId',
          Array.from(handles, (handle) => {
            const layerId = layerOfRow(handle);
            const own = GROUPS.filter((_, k) => LAYERS[k % 2] === layerId);
            return own[Math.floor(random() * own.length)];
          }),
        ],
        ['member', picked.map(() => randomKey(random))],
      ]),
    };
  }
  if (kind < 0.75) {
    // Out of their group, at the key they have
    return {
      handles,
      fields: new Map<RowField, unknown[]>([
        ['groupId', picked.map(() => '')],
        ['member', picked.map(() => undefined)],
      ]),
    };
  }
  if (kind < 0.87) {
    return { handles, fields: new Map(), deleted: new Uint8Array(handles.length).fill(1) };
  }
  // New rows (sometimes enough to be built into groups of their own, read until they are)
  const length = random() < 0.3 ? 70 : 1 + Math.floor(random() * 4);
  const fresh = Array.from({ length }, () => `n${next.value++}`);
  const created = writer.allocateHandles({
    offsets: Int32Array.from(
      { length: fresh.length + 1 },
      (_, k) => new TextEncoder().encode(fresh.slice(0, k).join('')).length,
    ),
    bytes: new TextEncoder().encode(fresh.join('')),
  });
  return {
    handles: created,
    fields: new Map<RowField, unknown[]>([
      ['type', fresh.map(() => 'Point')],
      ['layerId', fresh.map(() => LAYERS[Math.floor(random() * 2)])],
      ['geometry', fresh.map(() => ({ type: 'Point', coordinates: [random(), random()] }))],
      ['order', fresh.map(() => randomKey(random))],
    ]),
  };
}

describe('the changes of the order read from the items next to the ones a write disturbs', () => {
  it('are the changes made from the lists of every item, for writes of few rows and of many', () => {
    let told = 0;
    let ranges = 0;
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const random = seededRandom(seed);
      const { store, writer, tables, internals, notified } = setup(seed % 2 === 0 ? 40 : 600);
      const next = { value: 0 };
      for (let step = 0; step < 120; step++) {
        const many = random() < 0.08;
        const patch = randomPatch(random, tables, writer, internals, next, many);
        if (!patch) continue;
        const reference = referenceWatch(internals, patch);
        notified.length = 0;
        store.transact(() => writer.apply(patch), 'remote');
        const expected: ItemOrderChange[] = reference?.finish() ?? [];
        const actual = notified.flatMap((change) => change.order ?? []);
        expect(actual, `seed ${seed}, step ${step}`).toEqual(expected);
        told += actual.length;
        ranges += actual.filter((change) => change.kind === 'rows').length;
        // The next versions of the row groups now and then: the rows written go back to them
        if (step % 30 === 29) {
          internals.addQueuedRowBlocks();
          internals.flushVersions();
        }
      }
    }
    // Moves of items and of many rows were both told
    expect(told).toBeGreaterThan(200);
    expect(ranges).toBeGreaterThan(5);
  });

  it('are the moves made from the lists of every item for new keys of groups of features', () => {
    for (const seed of [1, 2, 3]) {
      const random = seededRandom(seed);
      const { store, writer, tables, internals } = setup(200);
      const next = { value: 0 };
      // Members in the groups
      for (let step = 0; step < 30; step++) {
        const patch = randomPatch(random, tables, writer, internals, next, false);
        if (patch) store.transact(() => writer.apply(patch), 'remote');
      }
      for (let step = 0; step < 40; step++) {
        const groups = GROUPS.filter(() => random() < 0.5).map((id) =>
          internals.groups.handleOfId(id),
        );
        if (groups.length === 0) continue;
        const keys = groups.map(() => randomKey(random));
        for (const layerId of LAYERS) {
          const orders = new Map(
            groups
              .map((group, k) => [group, keys[k]] as const)
              .filter(([group]) => internals.groups.layerOf(group) === layerId),
          );
          const source = sourceOf(internals);
          expect(groupKeyMoves(source, layerId, orders), `seed ${seed}, step ${step}`).toEqual(
            fullGroupKeyMoves(source, layerId, orders),
          );
        }
        store.transact(
          () =>
            writer.applyGroups({
              handles: Int32Array.from(groups),
              fields: new Map([['order', keys]]),
            }),
          'remote',
        );
        internals.flushVersions();
      }
    }
  });
});
