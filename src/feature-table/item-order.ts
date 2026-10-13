// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The changes of the order of the items a write of the rows made (`StoreChange.order`)
 *
 * Before a write that puts rows in another place (another key, group or layer), creates or
 * deletes rows, the items of the layers and the groups it touches are kept as they are (the
 * lists of a layer are not copied: a list read once is not changed afterwards). After it, the
 * moves are made from them and from what the lists are now:
 *
 * - when few rows changed their places (`ORDER_ITEM_LIMIT` at most), a move per item, made one at
 *   a time (`itemMovesBetween`): an item created was nowhere, an item deleted is nowhere, a group
 *   of features is an item from its first member on and until its last member leaves
 * - when more did, one move of many rows per layer (`RowRangeMove`) with the rows that were in a
 *   place before and are in one after, in their new order: the place they were put at together,
 *   or the item just below each of them, and their keys, layers and groups before (written back,
 *   they put the rows back). The rows created and deleted are told by the change of the rows
 *   alone then
 *
 * The items are numbered: a row by twice its handle, a group of features by twice its handle
 * plus one.
 */

import type {
  ItemMove,
  ItemOrderChange,
  ItemPosition,
  RowField,
  RowRangeMove,
} from '../shared/types/model.js';
import {
  itemMovesBetween,
  type OrderContainer,
  trimmedContainer,
} from '../shared/utils/item-moves.js';
import { ROW_FLAG_DELETED } from '../table/row-group-types.js';
import { compareRowKeys } from '../table/row-keys.js';
import { utf8String } from '../table/utf8-column.js';
import type { GroupTable } from './group-table.js';
import type { LayerItems, LayerTable, RowGroup } from './layer-table.js';
import type { GroupHandle, RowHandle } from './types.js';

/**
 * The most rows a write puts in another place, creates or deletes and that are told one at a
 * time; past it, the rows moved are told together by layer (a first value, to be set from
 * measured data)
 *
 * @internal
 */
export const ORDER_ITEM_LIMIT = 256;

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

/**
 * What the changes of the order read of the tables
 *
 * @internal
 */
export interface ItemOrderSource {
  /** The rows of a layer (undefined for a layer that holds none) */
  layer(layerId: string): LayerTable | undefined;
  readonly groups: GroupTable;
  /** The id of a row */
  idOf(handle: RowHandle): string | undefined;
  /** Where a row is read (undefined for no row) */
  placeOf(handle: RowHandle): RowAt | undefined;
}

/** The fields of a row that place it, as a row holds them (what `RowRangeMove.before` keeps) */
const PLACE_FIELDS: readonly RowField[] = ['layerId', 'groupId', 'order', 'member'];

/**
 * The items of the layers and the groups a write touches as they were, and the rows it puts in
 * another place, to make the changes of the order once it is written
 *
 * @internal
 */
export class ItemOrderWatch {
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
    if (this.moved.size > ORDER_ITEM_LIMIT) {
      const deleted = new Set(this.deleted);
      for (const code of this.moved) {
        if (deleted.has(code)) continue;
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
      return;
    }
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
    return itemMovesBetween(containers, {
      moved: this.moved,
      deleted,
      isGroup: (code) => (code & 1) === 1,
      idOf: (code) => this.idOf(code, groupIds),
    }) as ItemMove[];
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
  private rowRanges(): RowRangeMove[] {
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
    const out: RowRangeMove[] = [];
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
 *
 * @internal
 */
export function groupKeyMoves(
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
  return itemMovesBetween([trimmedContainer(layerId, undefined, before, after)], {
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
