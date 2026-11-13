// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `draw.groups`: the groups of the document
 */

import type { Group, GroupFilter, ItemListOptions } from './model.js';

/**
 * The groups of the document, to read. They are written through the transaction of `draw.write`
 * (`tx.groups`).
 */
export interface GroupsCollection {
  /**
   * Gets a group by ID.
   *
   * @returns The group, or `undefined` when there is none with this ID
   */
  get(id: string): Group | undefined;
  /**
   * Gets groups by ID, in the order of the IDs.
   *
   * @returns One entry per ID: the group, or `undefined` when there is none with that ID
   */
  getMany(ids: readonly string[]): (Group | undefined)[];
  /**
   * Lists the groups in stacking order, from the back.
   *
   * @param filter - Keeps only the groups that match every key given
   */
  list(filter?: GroupFilter): Group[];
  /**
   * Counts the groups.
   *
   * @param filter - Counts only the groups that match every key given
   */
  count(filter?: GroupFilter): number;
  /** Whether a group with this ID exists. */
  has(id: string): boolean;
  /**
   * Lists the IDs of the features of a group in stacking order from the back: the ones in a
   * range of positions (see {@link ItemListOptions}). It reads a group of objects
   * (`Group.featureIds`) and a group of a layer held as rows alike, without making features; they
   * are counted with `features.count({ groupId })`.
   *
   * @returns The IDs, as a new array (empty past the last feature)
   * @throws `DrawError` with the code `notFound` when there is no group with this ID, or
   *   `invalidInput` when the range is not of non-negative integers
   */
  listMembers(id: string, options?: ItemListOptions): string[];
}
