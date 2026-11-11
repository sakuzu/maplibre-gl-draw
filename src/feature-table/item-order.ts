// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The changes of the order of the items a write of the rows made (`StoreChange.order`)
 *
 * Before a write that puts rows in another place (another key, group or layer), creates or
 * deletes rows, what the changes are made from is kept; after it, the moves are made from it and
 * from the order as it is then:
 *
 * - when few rows changed their places (`ORDER_ITEM_LIMIT` at most), a move per item, made one at
 *   a time (`diffItemOrder`): an item created was nowhere, an item deleted is nowhere, a group
 *   of features is an item from its first member on and until its last member leaves. A row that
 *   was somewhere tells its key, layer and group before, as a move of many rows does
 * - when more did, one move of many rows per layer (`RowsMove`) with the rows that were in a
 *   place before and are in one after, in their new order: the place they were put at together,
 *   or the item just below each of them, and their keys, layers and groups before (written back,
 *   they put the rows back). The rows created and deleted are told by the change of the rows
 *   alone then
 *
 * The items are numbered: a row by twice its handle, a group of features by twice its handle
 * plus one.
 *
 * The moves are made from the items the write disturbs (the rows it puts elsewhere, creates or
 * deletes, and the groups of features they leave or join) and the items that stay next to them,
 * read before and after the write from the rows around them (`ItemWalk`), not from the lists of
 * every item of the layers. The items that stay keep their order, and an item the write disturbs
 * only ever stands next to another one it disturbs or to the item that stays just below or above
 * it before or after the write; so the moves made from these few items in their order are the
 * moves made from the whole lists, and a write costs the items it disturbs, not the rows of the
 * layers.
 */

import { utf8String } from '@sakuzu/tabane';
import type {
  ItemMove,
  ItemOrderChange,
  ItemPosition,
  RowField,
  RowsMove,
} from '../shared/types/model.js';
import {
  diffItemOrder,
  type OrderContainer,
  trimmedContainer,
} from '../shared/utils/item-moves.js';
import { ROW_FLAG_DELETED } from '../table/row-group-types.js';
import type { GroupTable } from './group-table.js';
import { compareItemKeys, groupCode, type ItemKey, type ItemWalk, rowCode } from './item-walk.js';
import type { LayerTable, RowGroup } from './layer-table.js';
import type { GroupHandle, RowHandle } from './types.js';

/**
 * The most rows a write puts in another place, creates or deletes and that are told one at a
 * time; past it, the rows moved are told together by layer (a first value, to be set from
 * measured data)
 *
 * @internal
 */
export const ORDER_ITEM_LIMIT = 256;

/** The place a row is read from (its group and its row there) */
interface RowAt {
  readonly layer: LayerTable;
  readonly group: RowGroup;
  readonly row: number;
}

/**
 * What the changes of the order read of the tables: the order through the walks of the items
 * (`walkItems`) and the keys of the groups written (`getGroupKey`), the places of the rows
 *
 * @internal
 */
export interface ItemOrderSource {
  /**
   * The walk of the items of a layer, in the order written (null for a layer that holds no row)
   */
  walkItems(layerId: string): ItemWalk | null;
  /**
   * The key of the order of a group of features last written (undefined for an unknown group):
   * the one not in the order read yet, or the one of the table of the groups
   */
  getGroupKey(group: GroupHandle): string | undefined;
  readonly groups: GroupTable;
  /** The id of a row */
  idOf(handle: RowHandle): string | undefined;
  /** Where a row is read (undefined for no row) */
  placeOf(handle: RowHandle): RowAt | undefined;
}

/** The fields of a row that place it, as a row holds them (what `RowsMove.before` keeps) */
const PLACE_FIELDS: readonly RowField[] = ['parent', 'key'];

/**
 * The items of a container the moves are made from, at one time (before or after the write): the
 * items the write disturbs that stand in it, and the items that stay next to them, with their
 * keys
 */
type ItemsKept = Map<number, ItemKey>;

/** A container: a layer (`groupId` undefined), or a group of features of a layer */
interface ContainerKey {
  readonly layerId: string;
  readonly group: GroupHandle;
}

/**
 * The items of the layers and the groups a write touches, read before it, and the rows it puts
 * in another place, to make the changes of the order once it is written
 *
 * @internal
 */
export class ItemOrderWatch {
  /** The layers watched, in the order they were */
  private readonly layers = new Set<string>();
  /** The groups watched and their layer before the write */
  private readonly groupsBefore = new Map<GroupHandle, string>();
  private readonly moved = new Set<number>();
  private readonly deleted: number[] = [];
  /** The layer, group and keys of each row moved before the write (absent for a new row) */
  private readonly before = new Map<RowHandle, readonly unknown[]>();
  /** The id of each row of `before`, when the moves are told one at a time */
  private readonly beforeIds = new Map<string, RowHandle>();
  /** The items of each container before the write (the layers by id, the groups by handle) */
  private readonly layerItems = new Map<string, ItemsKept>();
  private readonly groupItems = new Map<GroupHandle, ItemsKept>();
  /** The groups watched that were items before the write */
  private readonly groupsThere = new Set<GroupHandle>();

  constructor(private readonly source: ItemOrderSource) {}

  /** Whether the write puts a row in another place, creates or deletes one */
  get changes(): boolean {
    return this.moved.size > 0;
  }

  /** A layer whose items the write changes */
  watchLayer(layerId: string): void {
    this.layers.add(layerId);
  }

  /**
   * A group of features whose members the write changes (its layer too)
   *
   * @param layerId The layer its members are read in before the write (the layer of the group when
   *   omitted): the members of a group given another layer are there until they are written
   */
  watchGroup(group: GroupHandle, layerId = this.source.groups.layerOf(group)): void {
    if (group < 0 || this.groupsBefore.has(group)) return;
    if (layerId === undefined) return;
    this.watchLayer(layerId);
    this.groupsBefore.set(group, layerId);
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
   * Keeps what the changes are made from, before the write: the items the write disturbs in the
   * layers and the groups watched and the items next to them (when the rows moved are few), or
   * the layers, groups and keys of the rows moved (when they are many)
   */
  keep(): void {
    const many = this.moved.size > ORDER_ITEM_LIMIT;
    const deleted = new Set(this.deleted);
    for (const code of this.moved) {
      // Many rows: the rows that stay in a place; one at a time: the rows deleted too
      if (many && deleted.has(code)) continue;
      const handle = code >> 1;
      const at = this.source.placeOf(handle);
      if (!at || isDeleted(at)) continue;
      const data = at.group.data;
      const group = data.groups[at.row];
      this.before.set(handle, [
        group >= 0 ? this.source.groups.idOf(group) : at.layer.layerId,
        utf8String(data.keys, at.row),
      ]);
      if (!many) {
        const id = this.source.idOf(handle);
        if (id !== undefined) this.beforeIds.set(id, handle);
      }
    }
    if (many) return;
    for (const layerId of this.layers) {
      this.layerItems.set(layerId, this.itemsNow({ layerId, group: -1 }));
    }
    for (const [group, layerId] of this.groupsBefore) {
      this.groupItems.set(group, this.itemsNow({ layerId, group }));
      if (this.walkOf(layerId)?.span(groupCode(group), -1)) this.groupsThere.add(group);
    }
  }

  /** The changes of the order the write made (none when it put nothing in another place) */
  finish(): ItemOrderChange[] {
    if (this.moved.size === 0) return [];
    if (this.moved.size > ORDER_ITEM_LIMIT) return this.rowRanges();
    const containers: OrderContainer<number>[] = [];
    const groupsAfter = new Set<GroupHandle>();
    for (const layerId of this.layers) {
      const before = this.layerItems.get(layerId) ?? new Map();
      const after = this.itemsNow({ layerId, group: -1 });
      containers.push(this.container(layerId, undefined, before, after));
      for (const code of after.keys()) if ((code & 1) === 1) groupsAfter.add(code >> 1);
    }
    // The groups the rows left or went to: the ones watched, and any a row moved is in now
    const groups: GroupHandle[] = [...this.groupsBefore.keys()];
    const joined: Array<{ group: GroupHandle; layer: number; key: ItemKey }> = [];
    const layerOrder = [...this.layers];
    for (const code of this.moved) {
      const at = this.source.placeOf(code >> 1);
      if (!at || isDeleted(at)) continue;
      const group = at.group.data.groups[at.row];
      const layer = layerOrder.indexOf(at.layer.layerId);
      if (group < 0 || layer < 0 || this.groupsBefore.has(group)) continue;
      if (joined.some((entry) => entry.group === group)) continue;
      joined.push({ group, layer, key: this.groupKey(group) });
    }
    joined.sort((a, b) => a.layer - b.layer || compareItemKeys(a.key, b.key));
    for (const { group } of joined) groups.push(group);
    for (const group of groups) {
      const layerBefore = this.groupsBefore.get(group);
      const layerId = this.source.groups.layerOf(group) ?? layerBefore;
      if (layerId === undefined) continue;
      const before = this.groupItems.get(group) ?? new Map();
      const after = this.itemsNow({ layerId, group });
      containers.push(this.container(layerId, this.source.groups.idOf(group) ?? '', before, after));
    }
    // A group of features whose last member left is an item deleted (in the order the groups
    // stood before the write)
    const deleted = [...this.deleted];
    const gone: Array<{ group: GroupHandle; layer: number; key: ItemKey }> = [];
    for (const group of this.groupsThere) {
      if (groupsAfter.has(group)) continue;
      const layerId = this.groupsBefore.get(group) as string;
      const key = this.layerItems.get(layerId)?.get(groupCode(group));
      if (key) gone.push({ group, layer: layerOrder.indexOf(layerId), key });
    }
    gone.sort((a, b) => a.layer - b.layer || compareItemKeys(a.key, b.key));
    for (const { group } of gone) deleted.push(groupCode(group));
    const groupIds = new Map<GroupHandle, string>();
    const moves = diffItemOrder(containers, {
      moved: this.moved,
      deleted,
      isGroup: (code) => (code & 1) === 1,
      idOf: (code) => this.idOf(code, groupIds),
    }) as ItemMove[];
    // A row that was somewhere tells its place before
    return moves.map((move) => {
      const handle = move.from ? this.beforeIds.get(move.itemId) : undefined;
      if (handle === undefined) return move;
      return { ...move, before: this.placeBefore(Int32Array.of(handle)) };
    });
  }

  /** The parents and keys of rows before the write, as `RowsMove.before` holds them */
  private placeBefore(handles: Int32Array): RowsMove['before'] {
    const fields = new Map<RowField, unknown[]>(PLACE_FIELDS.map((field) => [field, []]));
    for (const handle of handles) {
      const values = this.before.get(handle) as readonly unknown[];
      PLACE_FIELDS.forEach((field, k) => {
        (fields.get(field) as unknown[]).push(values[k]);
      });
    }
    return { handles, fields };
  }

  /**
   * The items of a container now that the moves are made from: the items the write disturbs that
   * stand in it (the rows moved, the groups watched), and the items that stay just below and
   * above each of them
   */
  private itemsNow(container: ContainerKey): ItemsKept {
    const out: ItemsKept = new Map();
    const walk = this.walkOf(container.layerId);
    if (!walk) return out;
    const disturbed = this.disturbed();
    const add = (code: number | null): void => {
      if (code !== null && !out.has(code)) out.set(code, this.keyOf(code));
    };
    const visit = (code: number): void => {
      if (!walk.span(code, container.group)) return;
      add(code);
      add(walk.below(code, container.group, disturbed));
      add(walk.above(code, container.group, disturbed));
    };
    for (const code of this.moved) visit(code);
    if (container.group < 0) for (const group of this.groupsBefore.keys()) visit(groupCode(group));
    return out;
  }

  /** The items the write disturbs: the rows it moves, creates or deletes, the groups watched */
  private disturbed(): Set<number> {
    const out = new Set(this.moved);
    for (const group of this.groupsBefore.keys()) out.add(groupCode(group));
    return out;
  }

  /**
   * A container of the items kept before and read after, in their order, cut to the run where
   * they differ (as the whole lists would be)
   */
  private container(
    layerId: string,
    groupId: string | undefined,
    before: ItemsKept,
    after: ItemsKept,
  ): OrderContainer<number> {
    // An item that stays is read in both: one read at one time only stands there at the other
    for (const [code, key] of before) if (!this.isDisturbed(code)) after.set(code, key);
    for (const [code, key] of after) if (!this.isDisturbed(code)) before.set(code, key);
    return trimmedContainer(layerId, groupId, inOrder(before), inOrder(after));
  }

  /** Whether the write disturbs an item */
  private isDisturbed(code: number): boolean {
    return this.moved.has(code) || ((code & 1) === 1 && this.groupsBefore.has(code >> 1));
  }

  /** The key an item is ordered by now, in a layer or in a group */
  private keyOf(code: number): ItemKey {
    if ((code & 1) === 1) return this.groupKey(code >> 1);
    const handle = code >> 1;
    const at = this.source.placeOf(handle);
    const id = this.source.idOf(handle) ?? '';
    if (!at) return ['', id];
    const data = at.group.data;
    // A row is ordered by its key among the members of its group, or among the items of its layer
    return [utf8String(data.keys, at.row), id];
  }

  /** The key a group of features is ordered by in its layer (the key written) */
  private groupKey(group: GroupHandle): ItemKey {
    return [this.source.getGroupKey(group) ?? '', this.source.groups.idOf(group) ?? ''];
  }

  /** The walk of the items of a layer (null for a layer that holds no row) */
  private walkOf(layerId: string): ItemWalk | null {
    return this.source.walkItems(layerId);
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
   * their new order, with the place they were put at together or the item just below each (read
   * from the rows next to each)
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
      const walk = this.walkOf(layer.layerId) as ItemWalk;
      // In the order written (the keys of the groups written and not read yet)
      rows.sort((a, b) => walk.compareRows(a, b));
      const handles = Int32Array.from(rows, (at) => at.group.data.handles[at.row]);
      const before = this.placeBefore(handles);
      /** The item just below a row among the items of its layer, or the members of its group */
      const belowOf = (at: RowAt): { kind: number; handle: number } => {
        const handle = at.group.data.handles[at.row];
        const below = walk.below(rowCode(handle), at.group.data.groups[at.row]);
        return below === null ? { kind: 0, handle: -1 } : { kind: below & 1, handle: below >> 1 };
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
        const above = walk.above(rowCode(handles[handles.length - 1]), group);
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

/** The items kept in their order (by their keys) */
function inOrder(items: ItemsKept): number[] {
  return [...items.keys()].sort((a, b) =>
    compareItemKeys(items.get(a) as ItemKey, items.get(b) as ItemKey),
  );
}

/**
 * The moves of groups of features given new keys of their order, made before the keys go in: the
 * groups that are items of their layer, and the items that stay just below and above each of them
 * where they stand and where their new keys put them (a group that has no member is not an item,
 * and is not moved)
 *
 * @internal
 */
export function groupKeyMoves(
  source: ItemOrderSource,
  layerId: string,
  orders: ReadonlyMap<GroupHandle, string>,
): ItemMove[] {
  const walk = source.walkItems(layerId);
  if (!walk) return [];
  const moved = new Set<number>();
  for (const group of orders.keys()) {
    if (walk.span(groupCode(group), -1)) moved.add(groupCode(group));
  }
  if (moved.size === 0) return [];
  const keyOf = (code: number): ItemKey => walk.keyOf(code);
  const before: ItemsKept = new Map();
  const after: ItemsKept = new Map();
  const stay = (code: number | null): void => {
    if (code === null || moved.has(code) || before.has(code)) return;
    const key = keyOf(code);
    before.set(code, key);
    after.set(code, key);
  };
  for (const code of moved) {
    const group = code >> 1;
    const id = source.groups.idOf(group) ?? '';
    const order = orders.get(group) as string;
    before.set(code, keyOf(code));
    after.set(code, [order, id]);
    // Where it stands
    stay(walk.below(code, -1, moved));
    stay(walk.above(code, -1, moved));
    // Where its new key puts it: the items that stay just above and below the key
    stay(walk.itemNotBefore([order, id], moved));
    stay(walk.itemBefore([order, id], moved));
  }
  return diffItemOrder([trimmedContainer(layerId, undefined, inOrder(before), inOrder(after))], {
    moved,
    deleted: [],
    isGroup: (code) => (code & 1) === 1,
    idOf: (code) =>
      ((code & 1) === 1 ? source.groups.idOf(code >> 1) : source.idOf(code >> 1)) ?? '',
  });
}
