// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Where the row groups of a layer are cut when groups of features are given new keys of their
 * order (`groupRunCuts`): at the runs of the members of the groups, and at the places the new keys
 * put them
 *
 * The members of a group of features follow each other in the order of the layer, at the key of
 * the group, so the row groups that hold them are found by the keys of the group, and the place a
 * new key puts them is found by its key among the rows that stay: what a group given a new key
 * reads is the row groups around its members and its place, not every row of the layer.
 */

import { compareRowKeys, type GroupKeySource, type RowKeySource } from '../table/row-keys.js';
import { utf8ColumnFromStrings } from '../table/utf8-column.js';
import type { GroupTable } from './group-table.js';
import type { LayerTable, RowGroup } from './layer-table.js';
import type { GroupHandle } from './types.js';

/**
 * Where the row groups of a layer are cut
 *
 * @internal
 */
export interface GroupRunCuts {
  /**
   * The rows each row group is cut before (a row group that holds members is listed, cut or not;
   * a row group the members go into is listed when it is cut)
   */
  readonly cuts: Map<RowGroup, Set<number>>;
  /** Whether a row group holds a member of a group given a new key */
  readonly members: boolean;
}

/**
 * The cuts of the row groups of a layer for groups of features given new keys: before and after
 * each run of their members, and before the first row that is no member of them and comes after
 * them with the new keys
 *
 * @param orders The new keys of the groups
 * @param groups The groups as they are (the keys the rows are in the order of)
 * @internal
 */
export function groupRunCuts(
  layer: LayerTable,
  orders: ReadonlyMap<GroupHandle, string>,
  groups: GroupTable,
): GroupRunCuts {
  const cuts = new Map<RowGroup, Set<number>>();
  const cut = (group: RowGroup, row: number): void => {
    if (row <= 0 || row >= group.data.length) return;
    let set = cuts.get(group);
    if (!set) {
      set = new Set();
      cuts.set(group, set);
    }
    set.add(row);
  };
  const count = layer.groupCount;
  // The runs of the members
  const members: Array<{ group: RowGroup; row: number; of: GroupHandle }> = [];
  for (const g of rowGroupsHolding(layer, orders.keys(), groups)) {
    const group = layer.groupAt(g);
    const data = group.data;
    let run = -1;
    for (let r = 0; r <= data.length; r++) {
      const inside = r < data.length && orders.has(data.groups[r]);
      if (inside && run < 0) {
        run = r;
        members.push({ group, row: r, of: data.groups[r] });
        cuts.set(group, cuts.get(group) ?? new Set());
        cut(group, r);
      } else if (!inside && run >= 0) {
        cut(group, r);
        run = -1;
      } else if (inside && data.groups[r] !== data.groups[r - 1]) {
        cut(group, r);
        members.push({ group, row: r, of: data.groups[r] });
      }
    }
  }
  if (members.length === 0) return { cuts, members: false };
  // The places the members go to: before the first row that is no member of a group put in
  // another order and comes after them with the new keys. The members of a group all go to the
  // same place (a row that is no member of it comes before or after all of them)
  const keys = groups.withOrders(orders);
  const stays = (data: RowKeySource, row: number): boolean => !orders.has(data.groups[row]);
  /** The last row of a row group that stays (-1 for none) */
  const lastStaying = (g: number): number => {
    const data = layer.groupAt(g).data;
    let r = data.length - 1;
    while (r >= 0 && !stays(data, r)) r--;
    return r;
  };
  const placed = new Set<GroupHandle>();
  for (const member of members) {
    if (placed.has(member.of)) continue;
    placed.add(member.of);
    const after = (data: RowKeySource, row: number): boolean =>
      compareRowKeys(member.group.data, member.row, data, row, keys) < 0;
    // The first row group whose last row that stays comes after the members (a row group with no
    // row that stays is passed)
    let found = count;
    let lo = 0;
    let hi = count;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      let g = mid;
      let last = lastStaying(g);
      while (last < 0 && ++g < hi) last = lastStaying(g);
      if (last < 0) {
        hi = mid;
      } else if (after(layer.groupAt(g).data, last)) {
        found = g;
        hi = mid;
      } else {
        lo = g + 1;
      }
    }
    if (found === count) continue;
    const group = layer.groupAt(found);
    const data = group.data;
    for (let r = 0; r < data.length; r++) {
      if (!stays(data, r) || !after(data, r)) continue;
      if (r > 0 && stays(data, r - 1)) cut(group, r);
      break;
    }
  }
  return { cuts, members: true };
}

/**
 * The places in the order of a layer of the row groups that can hold members of groups of
 * features: the ones whose rows meet the keys of a group (its members follow each other there),
 * found by a search of the keys, in their order
 *
 * @internal
 */
export function rowGroupsHolding(
  layer: LayerTable,
  groupsOf: Iterable<GroupHandle>,
  groups: GroupTable,
): number[] {
  const count = layer.groupCount;
  const holding = new Set<number>();
  for (const group of groupsOf) {
    if (!groups.has(group)) continue;
    const start = groupStart(group);
    const end = groupEnd(group, groups);
    // The first row group whose last row does not come before the group
    let lo = 0;
    let hi = count;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const data = layer.groupAt(mid).data;
      if (compareRowKeys(data, data.length - 1, start, 0, groups) < 0) lo = mid + 1;
      else hi = mid;
    }
    for (let g = lo; g < count; g++) {
      const data = layer.groupAt(g).data;
      if (compareRowKeys(data, 0, end, 0, groups) >= 0) break;
      holding.add(g);
    }
  }
  return [...holding].sort((a, b) => a - b);
}

/** A key before every member of a group of features and after every item before the group */
function groupStart(group: GroupHandle): RowKeySource {
  return { ids: EMPTY, itemKeys: EMPTY, memberKeys: EMPTY, groups: Int32Array.of(group) };
}

/** A key after every member of a group of features and before every item after the group */
function groupEnd(group: GroupHandle, groups: GroupKeySource & GroupTable): RowKeySource {
  // The id of the group followed by the smallest character: no item id comes between them
  return {
    ids: utf8ColumnFromStrings([`${groups.idOf(group) ?? ''}\u0000`]),
    itemKeys: utf8ColumnFromStrings([groups.orderOf(group) ?? '']),
    memberKeys: EMPTY,
    groups: Int32Array.of(-1),
  };
}

/** A column of one empty entry */
const EMPTY = utf8ColumnFromStrings(['']);
