// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The table of the groups of features held as columns
 *
 * A row in a group names the group by its handle; the id and the key of the order of the group
 * are here, so moving a group writes one entry and none of its members (`compareRowKeys`).
 */

import type { RowGroupKey } from '../table/row-group-builder.js';
import type { GroupKeySource } from '../table/row-keys.js';
import { type Utf8Column, utf8ColumnFromStrings } from '../table/utf8-column.js';
import type { GroupHandle } from './types.js';

/** One group */
interface GroupEntry {
  readonly id: string;
  order: string;
  layerId: string;
  visible: boolean;
  locked: boolean;
  /** Advances with every change of `order` */
  orderVersion: number;
}

/**
 * The groups of a document, by handle
 *
 * @internal
 */
export class GroupTable implements GroupKeySource {
  private readonly entries = new Map<GroupHandle, GroupEntry>();
  /** The handle of each id */
  private readonly byId = new Map<string, GroupHandle>();
  /** The handles in the order of the columns below (rebuilt on a change) */
  private handles: GroupHandle[] = [];
  private entryIndex = new Map<GroupHandle, number>();
  private idColumn: Utf8Column = utf8ColumnFromStrings([]);
  private keyColumn: Utf8Column = utf8ColumnFromStrings([]);
  private stale = false;
  private revisionCount = 0;

  /** Changes with every change of a group */
  get revision(): number {
    return this.revisionCount;
  }

  /** The number of groups */
  get size(): number {
    return this.entries.size;
  }

  /** The ids of the groups, by entry */
  get ids(): Utf8Column {
    this.sync();
    return this.idColumn;
  }

  /** The keys of the order of the groups, by entry */
  get keys(): Utf8Column {
    this.sync();
    return this.keyColumn;
  }

  /** The entry of a group in `ids` and `keys` (-1 for an unknown handle) */
  entryOf(group: GroupHandle): number {
    this.sync();
    return this.entryIndex.get(group) ?? -1;
  }

  /** Whether the handle names a group */
  has(group: GroupHandle): boolean {
    return this.entries.has(group);
  }

  /** The id of a group */
  idOf(group: GroupHandle): string | undefined {
    return this.entries.get(group)?.id;
  }

  /** Whether a group is shown (true for an unknown handle) */
  isVisible(group: GroupHandle): boolean {
    return this.entries.get(group)?.visible ?? true;
  }

  /** Whether a group is locked (false for an unknown handle) */
  isLocked(group: GroupHandle): boolean {
    return this.entries.get(group)?.locked ?? false;
  }

  /** The handle of a group by its id (-1 for an unknown id) */
  handleOfId(id: string): GroupHandle {
    return this.byId.get(id) ?? -1;
  }

  /** The key of the order of a group (undefined for an unknown handle) */
  orderOf(group: GroupHandle): string | undefined {
    return this.entries.get(group)?.order;
  }

  /** The layer of a group (undefined for an unknown handle) */
  layerOf(group: GroupHandle): string | undefined {
    return this.entries.get(group)?.layerId;
  }

  /**
   * The version of the key of the order of a group: it advances with every change of the key
   * (-1 for an unknown handle)
   */
  orderVersionOf(group: GroupHandle): number {
    return this.entries.get(group)?.orderVersion ?? -1;
  }

  /** Sets a group (its handle is given by the caller) */
  set(
    group: GroupHandle,
    entry: { id: string; order: string; layerId: string; visible: boolean; locked: boolean },
  ): void {
    const old = this.entries.get(group);
    if (old) this.byId.delete(old.id);
    const orderVersion = old ? old.orderVersion + (old.order === entry.order ? 0 : 1) : 0;
    this.entries.set(group, { ...entry, orderVersion });
    this.byId.set(entry.id, group);
    this.stale = true;
    this.revisionCount++;
  }

  /** Writes the key of the order of a group */
  setOrder(group: GroupHandle, order: string): void {
    const entry = this.entries.get(group);
    if (!entry || entry.order === order) return;
    entry.order = order;
    entry.orderVersion++;
    this.stale = true;
    this.revisionCount++;
  }

  /** Takes a group out */
  delete(group: GroupHandle): void {
    const old = this.entries.get(group);
    if (!old) return;
    this.entries.delete(group);
    this.byId.delete(old.id);
    this.stale = true;
    this.revisionCount++;
  }

  /** Every group, as the builder of the row groups takes them */
  keyList(): RowGroupKey[] {
    return [...this.entries].map(([handle, entry]) => ({
      handle,
      id: entry.id,
      order: entry.order,
    }));
  }

  /**
   * The keys of the groups with the keys of some of them replaced (the order the rows will have
   * once the new keys are in)
   */
  withOrders(orders: ReadonlyMap<GroupHandle, string>): GroupKeySource {
    const handles = [...this.entries.keys()];
    const index = new Map(handles.map((handle, i) => [handle, i]));
    const entries = handles.map((handle) => this.entries.get(handle) as GroupEntry);
    const ids = utf8ColumnFromStrings(entries.map((entry) => entry.id));
    const keys = utf8ColumnFromStrings(
      handles.map((handle, i) => orders.get(handle) ?? entries[i].order),
    );
    return { ids, keys, entryOf: (group) => index.get(group) ?? -1 };
  }

  private sync(): void {
    if (!this.stale) return;
    this.handles = [...this.entries.keys()];
    this.entryIndex = new Map(this.handles.map((handle, i) => [handle, i]));
    const entries = this.handles.map((handle) => this.entries.get(handle) as GroupEntry);
    this.idColumn = utf8ColumnFromStrings(entries.map((entry) => entry.id));
    this.keyColumn = utf8ColumnFromStrings(entries.map((entry) => entry.order));
    this.stale = false;
  }
}
