// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The items of a layer held as rows read a few at a time (`ItemWalk`): where an item stands, the
 * items just below and above it, the first and the last item of a layer or of the members of a
 * group of features
 *
 * The list of the items of a layer (`LayerTable.itemsOf`) is made again after every change of the
 * order, from every row of the layer. What a write of a few items reads of the order (where to put
 * them, the items around them, the changes of the order it made) is read here instead, from the
 * rows next to the items, so it costs the items it reads and not the rows of the layer.
 *
 * The items are numbered as the changes of the order number them: a row by twice its handle, a
 * group of features by twice its handle plus one. A container is the layer (-1), or a group of
 * features whose members are its items.
 *
 * The order walked is the order written, which the writes read: a group of features given a new
 * key stands at the place of that key at once, though its members are read and drawn in the order
 * before until their reorder goes in (`ItemWalkSource.writtenOrders`). Its rows are passed where
 * they stand, and the group is put among the other items by its new key.
 */

import { utf8ColumnFromStrings, utf8String } from '@sakuzu/tabane';
import { ROW_FLAG_DELETED } from '../table/row-group-types.js';
import { compareRowKeys, type GroupKeySource, type RowKeySource } from '../table/row-keys.js';
import type { GroupTable } from './group-table.js';
import type { LayerTable, OrderRow, RowGroup } from './layer-table.js';
import type { GroupHandle, RowHandle } from './types.js';

/**
 * The number of a row as an item
 *
 * @internal
 */
export function rowCode(handle: RowHandle): number {
  return handle * 2;
}

/**
 * The number of a group of features as an item
 *
 * @internal
 */
export function groupCode(group: GroupHandle): number {
  return group * 2 + 1;
}

/**
 * What the items are read from
 *
 * @internal
 */
export interface ItemWalkSource {
  readonly groups: GroupTable;
  /** Where a row is read (undefined for no row) */
  placeOf(
    handle: RowHandle,
  ): { readonly layer: LayerTable; readonly group: RowGroup; readonly row: number } | undefined;
  /**
   * The keys of the order of groups of features written and not in the order read yet: their
   * members are read where the keys before put them until their reorder goes in (none when
   * omitted)
   */
  readonly writtenOrders?: ReadonlyMap<GroupHandle, string>;
}

/**
 * The key an item is ordered by in its container: the key of its order and its id (a row or a
 * group of features in a layer), or the key of its order in its group and its id (a member)
 *
 * @internal
 */
export type ItemKey = readonly [string, string];

/**
 * The order of two items by their keys, then their ids (the order of their UTF-8 bytes)
 *
 * @internal
 */
export function compareItemKeys(a: ItemKey, b: ItemKey): number {
  return compareCodePoints(a[0], b[0]) || compareCodePoints(a[1], b[1]);
}

/** What `down` and `up` pass */
interface Skip {
  has(code: number): boolean;
}

/** The rows an item spans in the order of its layer, deleted rows at its ends left out */
interface ItemSpan {
  readonly first: OrderRow;
  readonly last: OrderRow;
}

/**
 * The items of one layer, read from the rows next to them
 *
 * @internal
 */
export class ItemWalk {
  /** The groups of the layer whose keys written are not in the order read yet, with those keys */
  private readonly written = new Map<GroupHandle, string>();
  /** The keys of the groups the rows are ordered by, the keys written among them (made once) */
  private rowGroupKeys: GroupKeySource | null = null;

  constructor(
    private readonly layer: LayerTable,
    private readonly source: ItemWalkSource,
  ) {
    for (const [group, order] of source.writtenOrders ?? []) {
      if (source.groups.layerOf(group) === layer.layerId) this.written.set(group, order);
    }
  }

  /**
   * The rows an item spans (null when it is not an item of the container: a row of another
   * layer or group, a deleted row, a group of features without a member that is not deleted)
   *
   * @param container -1 for the layer, or the group of features whose members are the items
   */
  span(code: number, container: GroupHandle): ItemSpan | null {
    if ((code & 1) === 0) {
      const place = this.source.placeOf(code >> 1);
      if (!place || place.layer !== this.layer || isDeleted(place)) return null;
      if (place.group.data.groups[place.row] !== Math.max(-1, container)) return null;
      const at: OrderRow = { group: place.group, row: place.row };
      return { first: at, last: at };
    }
    const group = code >> 1;
    if (container >= 0 || !this.source.groups.has(group)) return null;
    // The members are next to each other: the rows deleted among them are passed together
    const first = this.layer.liveRowAtOrAfter(this.layer.rowNotBefore(this.groupStart(group), 0));
    if (!first || !inGroup(first, group)) return null;
    const after = this.rowAfterGroup(group);
    const last = this.layer.liveRowAtOrBefore(
      after ? this.layer.previousRow(after) : this.layer.lastRow(),
    );
    return last ? { first, last } : null;
  }

  /**
   * The item just below an item in its container (null when it is the first, or not an item of
   * the container), the items `skip` holds passed
   */
  below(code: number, container: GroupHandle, skip?: ReadonlySet<number>): number | null {
    const span = this.span(code, container);
    if (!span) return null;
    if (container >= 0 || this.written.size === 0) {
      return this.down(this.layer.previousRow(span.first), container, skip);
    }
    const key = this.keyOf(code);
    const from = this.isWritten(code) ? this.rowBefore(key) : this.layer.previousRow(span.first);
    return this.later(this.down(from, -1, this.passing(skip)), this.writtenBefore(key, skip), -1);
  }

  /**
   * The item just above an item in its container (null when it is the last, or not an item of
   * the container), the items `skip` holds passed
   */
  above(code: number, container: GroupHandle, skip?: ReadonlySet<number>): number | null {
    const span = this.span(code, container);
    if (!span) return null;
    if (container >= 0 || this.written.size === 0) {
      return this.up(this.layer.nextRow(span.last), container, skip);
    }
    const key = this.keyOf(code);
    const from = this.isWritten(code)
      ? this.layer.rowNotBefore(probe(key, true), 0)
      : this.layer.nextRow(span.last);
    return this.later(this.up(from, -1, this.passing(skip)), this.writtenAfter(key, skip), 1);
  }

  /** The first item of a container from the back (null for none), the items `skip` holds passed */
  bottom(container: GroupHandle, skip?: ReadonlySet<number>): number | null {
    if (container < 0) {
      const first = this.up(this.layer.firstRow(), container, this.passing(skip));
      return this.later(first, this.writtenAfter(null, skip), 1);
    }
    if (!this.source.groups.has(container)) return null;
    return this.up(this.layer.rowNotBefore(this.groupStart(container), 0), container, skip);
  }

  /** The last item of a container (null for none), the items `skip` holds passed */
  top(container: GroupHandle, skip?: ReadonlySet<number>): number | null {
    if (container < 0) {
      const last = this.down(this.layer.lastRow(), container, this.passing(skip));
      return this.later(last, this.writtenBefore(null, skip), -1);
    }
    if (!this.source.groups.has(container)) return null;
    const after = this.rowAfterGroup(container);
    return this.down(after ? this.layer.previousRow(after) : this.layer.lastRow(), container, skip);
  }

  /**
   * The first item of the layer whose key does not come before a key (null for none), the items
   * `skip` holds passed
   */
  itemNotBefore(key: ItemKey, skip?: ReadonlySet<number>): number | null {
    const at = this.layer.rowNotBefore(probe(key, false), 0);
    return this.later(this.up(at, -1, this.passing(skip)), this.writtenFrom(key, skip), 1);
  }

  /**
   * The last item of the layer whose key comes before a key (null for none), the items `skip`
   * holds passed
   */
  itemBefore(key: ItemKey, skip?: ReadonlySet<number>): number | null {
    const last = this.down(this.rowBefore(key), -1, this.passing(skip));
    return this.later(last, this.writtenBefore(key, skip), -1);
  }

  /** The handles of the members of a group of features, in their order, from `start` on */
  members(group: GroupHandle, start = 0, count = Number.POSITIVE_INFINITY): RowHandle[] {
    const out: RowHandle[] = [];
    if (!this.source.groups.has(group)) return out;
    let index = 0;
    for (
      let at = this.layer.liveRowAtOrAfter(this.layer.rowNotBefore(this.groupStart(group), 0));
      at && inGroup(at, group) && out.length < count;
      at = this.layer.liveRowAtOrAfter(this.layer.nextRow(at))
    ) {
      if (index++ >= start) out.push(at.group.data.handles[at.row]);
    }
    return out;
  }

  /** The number of the members of a group of features (deleted rows left out) */
  memberCount(group: GroupHandle): number {
    return this.members(group).length;
  }

  /**
   * The order of two items of the layer, by their keys written (an item it is not gives 0
   * against anything)
   *
   * @returns A negative number when `a` comes first
   */
  compare(a: number, b: number): number {
    if (!this.span(a, -1) || !this.span(b, -1)) return 0;
    return compareItemKeys(this.keyOf(a), this.keyOf(b));
  }

  /**
   * The order of two rows, by their keys written: the members of a group at the key written of
   * the group (the order the rows will have once the keys written are in)
   *
   * @returns A negative number when `a` comes first, 0 for the same row
   */
  compareRows(a: OrderRow, b: OrderRow): number {
    if (!this.rowGroupKeys) {
      const written = this.source.writtenOrders;
      const groups = this.source.groups;
      this.rowGroupKeys = written && written.size > 0 ? groups.withOrders(written) : groups;
    }
    return compareRowKeys(a.group.data, a.row, b.group.data, b.row, this.rowGroupKeys);
  }

  /**
   * The key an item of the layer is ordered by: the key written of a group of features, the key
   * of the order of a row
   */
  keyOf(code: number): ItemKey {
    const groups = this.source.groups;
    if ((code & 1) === 1) {
      const group = code >> 1;
      return [this.written.get(group) ?? groups.orderOf(group) ?? '', groups.idOf(group) ?? ''];
    }
    const place = this.source.placeOf(code >> 1);
    if (!place) return ['', ''];
    return [
      utf8String(place.group.data.itemKeys, place.row),
      utf8String(place.group.data.ids, place.row),
    ];
  }

  /** Whether an item is a group of features whose key written is not in the order read yet */
  private isWritten(code: number): boolean {
    return (code & 1) === 1 && this.written.has(code >> 1);
  }

  /** The items `skip` holds and the groups whose keys written are not read yet, passed */
  private passing(skip: ReadonlySet<number> | undefined): Skip | undefined {
    if (this.written.size === 0) return skip;
    return { has: (code) => this.isWritten(code) || (skip?.has(code) ?? false) };
  }

  /** The last row of the order whose key comes before a key (null for none) */
  private rowBefore(key: ItemKey): OrderRow | null {
    const at = this.layer.rowNotBefore(probe(key, false), 0);
    return at ? this.layer.previousRow(at) : this.layer.lastRow();
  }

  /**
   * Of the groups whose keys written are not read yet and that are items of the layer, the one
   * of the largest key before a key (null for none; the largest of all for no key)
   */
  private writtenBefore(key: ItemKey | null, skip: ReadonlySet<number> | undefined): number | null {
    let best: number | null = null;
    for (const code of this.writtenItems(skip)) {
      const own = this.keyOf(code);
      if (key && compareItemKeys(own, key) >= 0) continue;
      if (best === null || compareItemKeys(own, this.keyOf(best)) > 0) best = code;
    }
    return best;
  }

  /**
   * Of the groups whose keys written are not read yet and that are items of the layer, the one
   * of the smallest key after a key (null for none; the smallest of all for no key)
   */
  private writtenAfter(key: ItemKey | null, skip: ReadonlySet<number> | undefined): number | null {
    let best: number | null = null;
    for (const code of this.writtenItems(skip)) {
      const own = this.keyOf(code);
      if (key && compareItemKeys(own, key) <= 0) continue;
      if (best === null || compareItemKeys(own, this.keyOf(best)) < 0) best = code;
    }
    return best;
  }

  /** As `writtenAfter`, the key itself counted */
  private writtenFrom(key: ItemKey, skip: ReadonlySet<number> | undefined): number | null {
    let best: number | null = null;
    for (const code of this.writtenItems(skip)) {
      const own = this.keyOf(code);
      if (compareItemKeys(own, key) < 0) continue;
      if (best === null || compareItemKeys(own, this.keyOf(best)) < 0) best = code;
    }
    return best;
  }

  /** The groups whose keys written are not read yet that are items of the layer, not skipped */
  private *writtenItems(skip: ReadonlySet<number> | undefined): Iterable<number> {
    for (const group of this.written.keys()) {
      const code = groupCode(group);
      if (!skip?.has(code) && this.span(code, -1)) yield code;
    }
  }

  /**
   * Of two items of the layer, the one that comes later in a direction (1: the smaller key, the
   * one met first going up; -1: the larger, the one met first going down), or the one there is
   */
  private later(a: number | null, b: number | null, direction: 1 | -1): number | null {
    if (a === null) return b;
    if (b === null) return a;
    const order = compareItemKeys(this.keyOf(a), this.keyOf(b));
    return direction === 1 ? (order <= 0 ? a : b) : order >= 0 ? a : b;
  }

  /**
   * The first item at or below a row, read down (null when there is none in the container)
   */
  private down(
    from: OrderRow | null,
    container: GroupHandle,
    skip: Skip | undefined,
  ): number | null {
    // The rows deleted are passed together (`LayerTable.liveRowAtOrBefore`)
    let at = this.layer.liveRowAtOrBefore(from);
    while (at) {
      const data = at.group.data;
      const group = data.groups[at.row];
      if (container >= 0 && group !== container) return null;
      const code = container < 0 && group >= 0 ? groupCode(group) : rowCode(data.handles[at.row]);
      if (!skip?.has(code)) return code;
      if ((code & 1) === 1) {
        // Past the group: the row before its first one
        const first = this.layer.rowNotBefore(this.groupStart(group), 0);
        at = this.layer.liveRowAtOrBefore(first ? this.layer.previousRow(first) : null);
      } else {
        at = this.layer.liveRowAtOrBefore(this.layer.previousRow(at));
      }
    }
    return null;
  }

  /** The first item at or above a row, read up (null when there is none in the container) */
  private up(from: OrderRow | null, container: GroupHandle, skip: Skip | undefined): number | null {
    let at = this.layer.liveRowAtOrAfter(from);
    while (at) {
      const data = at.group.data;
      const group = data.groups[at.row];
      if (container >= 0 && group !== container) return null;
      const code = container < 0 && group >= 0 ? groupCode(group) : rowCode(data.handles[at.row]);
      if (!skip?.has(code)) return code;
      // Past the group: the row after its last one
      at = this.layer.liveRowAtOrAfter(
        (code & 1) === 1 ? this.rowAfterGroup(group) : this.layer.nextRow(at),
      );
    }
    return null;
  }

  /** The first row of the order after the members of a group (null when they are the last) */
  private rowAfterGroup(group: GroupHandle): OrderRow | null {
    return this.layer.rowNotBefore(this.groupEnd(group), 0);
  }

  /** A key before every member of a group and after every item before the group */
  private groupStart(group: GroupHandle): RowKeySource {
    return {
      ids: EMPTY,
      itemKeys: EMPTY,
      memberKeys: EMPTY,
      groups: Int32Array.of(group),
    };
  }

  /** A key after every member of a group and before every item after the group */
  private groupEnd(group: GroupHandle): RowKeySource {
    const groups = this.source.groups;
    // The id of the group followed by the smallest character: no item id comes between them
    return {
      ids: utf8ColumnFromStrings([`${groups.idOf(group) ?? ''}\u0000`]),
      itemKeys: utf8ColumnFromStrings([groups.orderOf(group) ?? '']),
      memberKeys: EMPTY,
      groups: NO_GROUP,
    };
  }
}

/** A column of one empty entry */
const EMPTY = utf8ColumnFromStrings(['']);

/** The group of a row outside a group */
const NO_GROUP = Int32Array.of(-1);

/**
 * A key of the order of no row: the place just before the rows of an item of a key (or just
 * after them)
 */
function probe(key: ItemKey, after: boolean): RowKeySource {
  // The id followed by the smallest character: no item id comes between them
  return {
    ids: utf8ColumnFromStrings([after ? `${key[1]}\u0000` : key[1]]),
    itemKeys: utf8ColumnFromStrings([key[0]]),
    memberKeys: EMPTY,
    groups: NO_GROUP,
  };
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

/** Whether a row is deleted */
function isDeleted(at: { readonly group: RowGroup; readonly row: number }): boolean {
  return (at.group.data.flags[at.row] & ROW_FLAG_DELETED) !== 0;
}

/** Whether a row is a member of a group of features */
function inGroup(at: OrderRow, group: GroupHandle): boolean {
  return at.group.data.groups[at.row] === group;
}
