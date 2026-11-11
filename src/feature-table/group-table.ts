// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The table of the groups of features held as columns
 *
 * A row in a group names the group by its handle; the id and the key of the order of the group
 * are here, so moving a group writes one entry and none of its members (`compareRowKeys`).
 */

import { type Utf8Column, utf8ColumnFromStrings } from '@sakuzu/tabane';
import type { GroupEntry } from '../table/row-group-builder.js';
import type { GroupKeySource } from '../table/row-keys.js';
import type { GroupHandle } from './types.js';

/** One group */
interface GroupState {
  readonly id: string;
  order: string;
  tableId: string;
  /** The values of the `flag` columns of the group, a bit each (`flagBitOf`) */
  flags: number;
  /** Advances with every change of `order` */
  orderVersion: number;
  /** The bits of the state of the group (`setGroupStates`) */
  states: number;
  /** The bits of the state its members take: its own, and those its flags give them */
  memberStates: number;
}

/** A `flag` column of the groups, and the bits of the state it gives the members of a group */
export interface GroupFlagStates {
  /** The bit of the column in the flags of a group (`GroupTable.flagBitOf`) */
  readonly flag: number;
  /** The bits of the state of the members of a group whose flag is set */
  readonly states: number;
}

/**
 * The groups of a document, by handle
 *
 * @internal
 */
export class GroupTable implements GroupKeySource {
  private readonly entries = new Map<GroupHandle, GroupState>();
  /** The bits of the flags of the groups, by the names of their columns */
  private readonly flagBits: ReadonlyMap<string, number>;
  /** The bits of the state the flags give the members */
  private memberFlags: readonly GroupFlagStates[] = [];

  /**
   * @param flagColumns - The names of the `flag` columns of the groups, in the order of their bits
   */
  constructor(flagColumns: readonly string[] = []) {
    // The bits of `groupFlagBitOf`
    this.flagBits = new Map(flagColumns.map((name, at) => [name, 1 << at]));
  }

  /** The bit of a `flag` column in the flags of a group (0 for a name that is not one) */
  flagBitOf(name: string): number {
    return this.flagBits.get(name) ?? 0;
  }

  /**
   * Declares the bits of the state the flags of a group give its members (before any group is
   * set)
   */
  setMemberFlags(memberFlags: readonly GroupFlagStates[]): void {
    this.memberFlags = memberFlags;
  }
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

  /** The values of the `flag` columns of a group, a bit each (0 for an unknown handle) */
  flagsOf(group: GroupHandle): number {
    return this.entries.get(group)?.flags ?? 0;
  }

  /** The handle of a group by its id (-1 for an unknown id) */
  handleOfId(id: string): GroupHandle {
    return this.byId.get(id) ?? -1;
  }

  /** The key of the order of a group (undefined for an unknown handle) */
  orderOf(group: GroupHandle): string | undefined {
    return this.entries.get(group)?.order;
  }

  /** The table of a group (undefined for an unknown handle) */
  tableOf(group: GroupHandle): string | undefined {
    return this.entries.get(group)?.tableId;
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
    entry: { id: string; order: string; tableId: string; flags: number },
  ): void {
    const old = this.entries.get(group);
    if (old) this.byId.delete(old.id);
    const orderVersion = old ? old.orderVersion + (old.order === entry.order ? 0 : 1) : 0;
    const states = old?.states ?? 0;
    this.entries.set(group, {
      ...entry,
      orderVersion,
      states,
      memberStates: states | this.flagStates(entry.flags),
    });
    this.byId.set(entry.id, group);
    this.stale = true;
    this.revisionCount++;
  }

  /** The bits of the state of a group (`setGroupStates`; 0 for an unknown handle) */
  statesOf(group: GroupHandle): number {
    return this.entries.get(group)?.states ?? 0;
  }

  /**
   * The bits of the state the members of a group take: its own, and those its flags give them (0
   * for an unknown handle)
   */
  memberStatesOf(group: GroupHandle): number {
    return this.entries.get(group)?.memberStates ?? 0;
  }

  /**
   * Sets the bits under a mask of the state of a group
   *
   * @returns Whether they changed (false for an unknown handle)
   */
  setStates(group: GroupHandle, mask: number, bits: number): boolean {
    const entry = this.entries.get(group);
    if (!entry) return false;
    const next = (entry.states & ~mask) | (bits & mask);
    if (next === entry.states) return false;
    entry.states = next;
    entry.memberStates = next | this.flagStates(entry.flags);
    return true;
  }

  /** The bits of the state the flags of a group give its members */
  private flagStates(flags: number): number {
    let states = 0;
    for (const { flag, states: bits } of this.memberFlags) if ((flags & flag) !== 0) states |= bits;
    return states;
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
  keyList(): GroupEntry[] {
    return [...this.entries].map(([handle, entry]) => ({
      handle,
      id: entry.id,
      key: entry.order,
    }));
  }

  /**
   * The keys of the groups with the keys of some of them replaced (the order the rows will have
   * once the new keys are in)
   */
  withOrders(orders: ReadonlyMap<GroupHandle, string>): GroupKeySource {
    const handles = [...this.entries.keys()];
    const index = new Map(handles.map((handle, i) => [handle, i]));
    const entries = handles.map((handle) => this.entries.get(handle) as GroupState);
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
    const entries = this.handles.map((handle) => this.entries.get(handle) as GroupState);
    this.idColumn = utf8ColumnFromStrings(entries.map((entry) => entry.id));
    this.keyColumn = utf8ColumnFromStrings(entries.map((entry) => entry.order));
    this.stale = false;
  }
}
