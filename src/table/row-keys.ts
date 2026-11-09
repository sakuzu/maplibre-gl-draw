// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The order of the rows of a layer
 *
 * Every row has a key of its own order, and a row in a group has a key of its order within the
 * group. The items of a layer are its rows outside a group and its groups; a group is ordered by
 * its own key, and its members follow each other at the place of the group, in the order of
 * their keys within it. The keys are fractional indexes: strings compared by their UTF-8 bytes,
 * so that a key between any two keys can always be made.
 *
 * The order of two rows is decided by, in turn:
 *
 * 1. the key of their item: the key of the group for a member of a group, the key of the row
 *    otherwise
 * 2. the id of their item: the id of the group for a member, the id of the row otherwise (two
 *    items with the same key are ordered by their ids)
 * 3. the key within the group (empty for a row outside a group)
 * 4. the id of the row
 *
 * A member does not hold the key of its group: it names the group, and the key is looked up in
 * the groups. Moving a group therefore moves its members without writing them.
 *
 * A pure module: it depends on nothing outside `/table`, so it runs in a Worker as well.
 */

import { compareByteRuns, type Utf8Column } from '@sakuzu/tabane';
import { KasaneError } from './kasane-error.js';

/**
 * The columns of rows the order is read from
 */
export interface RowKeySource {
  /** The id of each row */
  readonly ids: Utf8Column;
  /** The key of the order of each row */
  readonly itemKeys: Utf8Column;
  /** The key of the order of each row within its group (empty outside a group) */
  readonly memberKeys: Utf8Column;
  /** The group of each row, as the groups below name it (-1 outside a group) */
  readonly groups: Int32Array;
}

/**
 * The ids and keys of the groups the rows name
 */
export interface GroupKeySource {
  /** The ids of the groups */
  readonly ids: Utf8Column;
  /** The keys of the order of the groups */
  readonly keys: Utf8Column;
  /** The entry of `ids` and `keys` of a group named by a row, or -1 when there is none */
  entryOf(group: number): number;
}

/**
 * Compares row `i` of `a` with row `j` of `b` in the order of the layer
 *
 * @param groups The groups the rows name (null when no row is in a group)
 * @returns A negative number when row `i` comes first, a positive one when row `j` does, 0 when
 *   they are the same row
 * @throws when a row names a group that `groups` does not hold
 */
export function compareRowKeys(
  a: RowKeySource,
  i: number,
  b: RowKeySource,
  j: number,
  groups: GroupKeySource | null,
): number {
  const aGroup = groupEntry(a.groups[i], groups);
  const bGroup = groupEntry(b.groups[j], groups);

  // 1. The key of the item
  const aKeys = aGroup < 0 ? a.itemKeys : (groups as GroupKeySource).keys;
  const aKeyAt = aGroup < 0 ? i : aGroup;
  const bKeys = bGroup < 0 ? b.itemKeys : (groups as GroupKeySource).keys;
  const bKeyAt = bGroup < 0 ? j : bGroup;
  let order = compareEntries(aKeys, aKeyAt, bKeys, bKeyAt);
  if (order !== 0) return order;

  // 2. The id of the item
  const aIds = aGroup < 0 ? a.ids : (groups as GroupKeySource).ids;
  const bIds = bGroup < 0 ? b.ids : (groups as GroupKeySource).ids;
  order = compareEntries(aIds, aGroup < 0 ? i : aGroup, bIds, bGroup < 0 ? j : bGroup);
  if (order !== 0) return order;

  // 3. The key within the group (the same item: both rows are in the same group, or are the
  //    same row)
  if (aGroup >= 0 || bGroup >= 0) {
    order = compareEntries(a.memberKeys, i, b.memberKeys, j);
    if (order !== 0) return order;
  }

  // 4. The id of the row
  return compareEntries(a.ids, i, b.ids, j);
}

/** The entry of the group of a row (-1 outside a group) */
function groupEntry(group: number, groups: GroupKeySource | null): number {
  if (group < 0) return -1;
  const entry = groups ? groups.entryOf(group) : -1;
  if (entry < 0)
    throw new KasaneError(
      'not-found',
      `compareRowKeys: a row names the group ${group}, which is unknown`,
    );
  return entry;
}

/** The order of two entries of two columns */
function compareEntries(a: Utf8Column, i: number, b: Utf8Column, j: number): number {
  return compareByteRuns(
    a.bytes,
    a.offsets[i],
    a.offsets[i + 1],
    b.bytes,
    b.offsets[j],
    b.offsets[j + 1],
  );
}
