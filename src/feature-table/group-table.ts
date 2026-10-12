// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The table of the groups of features held as columns
 *
 * A row in a group names the group by its handle; the id and the key of the order of the group
 * are here, so moving a group writes one entry and none of its members (`compareRowKeys`).
 */

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
}

/**
 * The groups of a document, by handle
 *
 * @internal
 */
export class GroupTable implements GroupKeySource {
  private readonly entries = new Map<GroupHandle, GroupEntry>();
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

  /** Sets a group (its handle is given by the caller) */
  set(
    group: GroupHandle,
    entry: { id: string; order: string; layerId: string; visible: boolean; locked: boolean },
  ): void {
    this.entries.set(group, { ...entry });
    this.stale = true;
    this.revisionCount++;
  }

  /** Takes a group out */
  delete(group: GroupHandle): void {
    if (!this.entries.delete(group)) return;
    this.stale = true;
    this.revisionCount++;
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
