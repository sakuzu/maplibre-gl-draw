// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The writes and reads of `groups` as the resources made them before the writes moved to
 * `draw.write`: the internal part each write of a transaction is made with once it is committed
 */

import type { ObjectGroup } from '../../shared/types/model.js';
import type {
  Group,
  GroupFilter,
  GroupInput,
  GroupPatch,
  ItemListOptions,
  MoveTarget,
} from '../model.js';

/**
 * @internal
 */
export interface GroupResource {
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
  /**
   * Creates a group of features and returns it as it was stored.
   *
   * The group takes the place of its frontmost feature in their layer. A group needs at least
   * one feature, in every kind of layer; a group deleted is brought back with `restore`. In a
   * layer held as rows, a group created with the ID of a group deleted that the Store still keeps
   * takes the place that group had, as a feature created with the ID of a row deleted and kept
   * does.
   *
   * @returns The new group, or `null` when the document is read-only
   * @throws `DrawError` with the code `notFound` when one of the features does not exist,
   *   `invalidInput` when there is no feature, the features are not in the same layer (or not
   *   in `layerId`) or its ID is not one the Store takes (`Store.acceptsId`), or
   *   `alreadyExists` when its ID is taken
   */
  create(input: GroupInput): Group | null;
  /**
   * Creates a group checked before against the document as it still is (`prepareGroup`), without
   * checking it again: its members put in stacking order unless they are in it already
   *
   * @returns The group, or `null` when the document is read-only
   */
  createChecked(group: ObjectGroup, options: { readonly membersInOrder: boolean }): Group | null;
  /**
   * Brings back a group this client deleted that a Store that holds its features as rows keeps
   * (`DocumentChange.restoreToken`), at the place it had in its layer, without features: its
   * features come back into it with `features.restore` (the ones deleted with it) or by moving
   * them there (`features.move`), and its name and its flags are written with `update`. Such a
   * Store keeps every group this client deletes (its features deleted with it, moved out of it,
   * or the group deleted) until the token of the deletion is let go of
   * (`features.releaseRestore`); a group deleted from elsewhere is not kept. A Store that holds
   * its features as objects keeps no group it deleted.
   *
   * A lock of its layer refuses it, as it refuses the restore of a feature: an undo writes in a
   * transaction that ignores the locks (`draw.transact(fn, { ignoreLocks: true })`).
   *
   * @returns The group, or `null` when it is refused (read-only, a lock)
   * @throws `DrawError` with the code `notFound` when no deletion keeps a group of this ID (or
   *   its layer is not there), `alreadyExists` when there is a group of this ID, or
   *   `invalidInput` when the ID is not a string
   */
  restore(id: string): Group | null;
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
   * @throws `DrawError` with the code `notFound` when there is no group with this ID, or
   *   `invalidInput` when the patch has the wrong shape
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
   * @throws `DrawError` with the code `notFound` when there is no group with this ID
   */
  delete(id: string): boolean;
  /**
   * Deletes several groups in one transaction: all of them or none. Their features stay in
   * their layers.
   *
   * @returns True when they were deleted, false when the deletion is refused
   * @throws `DrawError` with the code `notFound` when one of the IDs does not exist; nothing
   *   is deleted then
   */
  deleteMany(ids: readonly string[]): boolean;
  /**
   * Moves a group to another layer, or to another position in its layer.
   *
   * @returns True when it moved, false when the move is refused (read-only, a lock)
   * @throws `DrawError` with the code `notFound` when the group or the target does not
   *   exist, `invalidInput` when the target is a group, or `invalidState` when it is a position
   *   by `index` in a layer held as rows (which takes the items around the place instead)
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
