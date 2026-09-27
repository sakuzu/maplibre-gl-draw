// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `draw.groups`: the groups of the document
 */

import type { Group, GroupFilter, GroupInput, GroupPatch, MoveTarget } from './model.js';

/**
 * The groups of the document, with the standard methods of a collection and the verbs that
 * move them.
 *
 * A wrong argument (an ID that does not exist, an input of the wrong shape) throws a
 * `DrawError` and changes nothing. A refusal because of the state (read-only, a lock) returns
 * `null` or `false` and changes nothing. A method whose name ends in `Many` runs in one
 * transaction: all of it happens or none of it does.
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
   * Creates a group of features and returns it as it was stored.
   *
   * @returns The new group, or `null` when the document is read-only
   * @throws `DrawError` with the code `not-found` when one of the features does not exist,
   *   `invalid-input` when the features are not in the same layer, or `already-exists` when
   *   its ID is taken
   */
  create(input: GroupInput): Group | null;
  /**
   * Creates several groups in one transaction: all of them or none.
   *
   * @returns The new groups in the order of the inputs, or `null` when the document is
   *   read-only
   * @throws `DrawError` as {@link GroupsCollection.create} does, for any of the inputs;
   *   nothing is created then
   */
  createMany(inputs: readonly GroupInput[]): Group[] | null;
  /**
   * Changes the keys given in the patch and returns the group after the change.
   *
   * @returns The changed group, or `null` when the change is refused (read-only, a lock)
   * @throws `DrawError` with the code `not-found` when there is no group with this ID, or
   *   `invalid-input` when the patch has the wrong shape
   */
  update(id: string, patch: GroupPatch): Group | null;
  /**
   * Changes several groups in one transaction: all of them or none.
   *
   * @returns The changed groups in the order of the patches, or `null` when the change is
   *   refused
   * @throws `DrawError` as {@link GroupsCollection.update} does, for any of the patches;
   *   nothing changes then
   */
  updateMany(patches: readonly { id: string; patch: GroupPatch }[]): Group[] | null;
  /**
   * Deletes a group; its features stay in the layer.
   *
   * @returns True when it was deleted, false when the deletion is refused (read-only, a lock)
   * @throws `DrawError` with the code `not-found` when there is no group with this ID
   */
  delete(id: string): boolean;
  /**
   * Deletes several groups in one transaction: all of them or none. Their features stay in
   * their layers.
   *
   * @returns True when they were deleted, false when the deletion is refused
   * @throws `DrawError` with the code `not-found` when one of the IDs does not exist; nothing
   *   is deleted then
   */
  deleteMany(ids: readonly string[]): boolean;
  /**
   * Moves a group to another layer, or to another position in its layer.
   *
   * @returns True when it moved, false when the move is refused (read-only, a lock)
   * @throws `DrawError` with the code `not-found` when the group or the target does not
   *   exist, or `invalid-input` when the target is a group
   */
  move(id: string, to: MoveTarget): boolean;
  /**
   * Moves several groups in one transaction: all of them or none.
   *
   * @returns True when they moved, false when the move is refused
   * @throws `DrawError` as {@link GroupsCollection.move} does, for any of the groups; nothing
   *   moves then
   */
  moveMany(ids: readonly string[], to: MoveTarget): boolean;
}
