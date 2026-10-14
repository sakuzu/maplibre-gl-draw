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
 */

import { ROW_FLAG_DELETED } from '../table/row-group-types.js';
import { compareRowKeys, type RowKeySource } from '../table/row-keys.js';
import { utf8ColumnFromStrings } from '../table/utf8-column.js';
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
  constructor(
    private readonly layer: LayerTable,
    private readonly source: ItemWalkSource,
  ) {}

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
    let first = this.layer.rowNotBefore(this.groupStart(group), 0);
    while (first && inGroup(first, group) && isDeleted(first)) first = this.layer.nextRow(first);
    if (!first || !inGroup(first, group)) return null;
    let last = this.rowAfterGroup(group);
    last = last ? this.layer.previousRow(last) : this.layer.lastRow();
    while (last && inGroup(last, group) && isDeleted(last)) last = this.layer.previousRow(last);
    return last ? { first, last } : null;
  }

  /**
   * The item just below an item in its container (null when it is the first, or not an item of
   * the container), the items `skip` holds passed
   */
  below(code: number, container: GroupHandle, skip?: ReadonlySet<number>): number | null {
    const span = this.span(code, container);
    return span ? this.down(this.layer.previousRow(span.first), container, skip) : null;
  }

  /**
   * The item just above an item in its container (null when it is the last, or not an item of
   * the container), the items `skip` holds passed
   */
  above(code: number, container: GroupHandle, skip?: ReadonlySet<number>): number | null {
    const span = this.span(code, container);
    return span ? this.up(this.layer.nextRow(span.last), container, skip) : null;
  }

  /** The first item of a container from the back (null for none), the items `skip` holds passed */
  bottom(container: GroupHandle, skip?: ReadonlySet<number>): number | null {
    if (container < 0) return this.up(this.layer.firstRow(), container, skip);
    if (!this.source.groups.has(container)) return null;
    return this.up(this.layer.rowNotBefore(this.groupStart(container), 0), container, skip);
  }

  /** The last item of a container (null for none), the items `skip` holds passed */
  top(container: GroupHandle, skip?: ReadonlySet<number>): number | null {
    if (container < 0) return this.down(this.layer.lastRow(), container, skip);
    if (!this.source.groups.has(container)) return null;
    const after = this.rowAfterGroup(container);
    return this.down(after ? this.layer.previousRow(after) : this.layer.lastRow(), container, skip);
  }

  /**
   * The item of the layer a row is in, or the first one after it (null for none), the items
   * `skip` holds passed
   */
  itemFrom(at: OrderRow | null, skip?: ReadonlySet<number>): number | null {
    return this.up(at, -1, skip);
  }

  /**
   * The item of the layer a row is in, or the last one before it (null for none), the items
   * `skip` holds passed
   */
  itemUntil(at: OrderRow | null, skip?: ReadonlySet<number>): number | null {
    return this.down(at, -1, skip);
  }

  /** The handles of the members of a group of features, in their order, from `start` on */
  members(group: GroupHandle, start = 0, count = Number.POSITIVE_INFINITY): RowHandle[] {
    const out: RowHandle[] = [];
    if (!this.source.groups.has(group)) return out;
    let index = 0;
    for (
      let at = this.layer.rowNotBefore(this.groupStart(group), 0);
      at && inGroup(at, group) && out.length < count;
      at = this.layer.nextRow(at)
    ) {
      if (isDeleted(at)) continue;
      if (index++ >= start) out.push(at.group.data.handles[at.row]);
    }
    return out;
  }

  /** The number of the members of a group of features (deleted rows left out) */
  memberCount(group: GroupHandle): number {
    return this.members(group).length;
  }

  /**
   * The order of two items of the layer (each read where it stands: an item it is not gives 0
   * against anything)
   *
   * @returns A negative number when `a` comes first
   */
  compare(a: number, b: number): number {
    const x = this.span(a, -1);
    const y = this.span(b, -1);
    if (!x || !y) return 0;
    return compareRowKeys(
      x.first.group.data,
      x.first.row,
      y.first.group.data,
      y.first.row,
      this.source.groups,
    );
  }

  /**
   * The first item at or below a row, read down (null when there is none in the container)
   */
  private down(
    from: OrderRow | null,
    container: GroupHandle,
    skip: ReadonlySet<number> | undefined,
  ): number | null {
    let at = from;
    while (at) {
      if (isDeleted(at)) {
        at = this.layer.previousRow(at);
        continue;
      }
      const data = at.group.data;
      const group = data.groups[at.row];
      if (container >= 0 && group !== container) return null;
      const code = container < 0 && group >= 0 ? groupCode(group) : rowCode(data.handles[at.row]);
      if (!skip?.has(code)) return code;
      if ((code & 1) === 1) {
        // Past the group: the row before its first one
        const first = this.layer.rowNotBefore(this.groupStart(group), 0);
        at = first ? this.layer.previousRow(first) : null;
      } else {
        at = this.layer.previousRow(at);
      }
    }
    return null;
  }

  /** The first item at or above a row, read up (null when there is none in the container) */
  private up(
    from: OrderRow | null,
    container: GroupHandle,
    skip: ReadonlySet<number> | undefined,
  ): number | null {
    let at = from;
    while (at) {
      if (isDeleted(at)) {
        at = this.layer.nextRow(at);
        continue;
      }
      const data = at.group.data;
      const group = data.groups[at.row];
      if (container >= 0 && group !== container) return null;
      const code = container < 0 && group >= 0 ? groupCode(group) : rowCode(data.handles[at.row]);
      if (!skip?.has(code)) return code;
      // Past the group: the row after its last one
      at = (code & 1) === 1 ? this.rowAfterGroup(group) : this.layer.nextRow(at);
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

/** Whether a row is deleted */
function isDeleted(at: { readonly group: RowGroup; readonly row: number }): boolean {
  return (at.group.data.flags[at.row] & ROW_FLAG_DELETED) !== 0;
}

/** Whether a row is a member of a group of features */
function inGroup(at: OrderRow, group: GroupHandle): boolean {
  return at.group.data.groups[at.row] === group;
}
