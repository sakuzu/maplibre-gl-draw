// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `draw.selection` and `draw.vertexSelection`: what this client has selected
 */

import type { EditCounts } from './features.js';
import type { Feature, Group, MoveTarget } from './model.js';
import type { Selection, SelectionType, VertexRef, VertexSelection } from './state.js';

/**
 * The selection of this client: features, groups or layers, one type at a time, and the
 * verbs that act on what is selected.
 */
export interface SelectionResource {
  /** The type and the IDs of what is selected. */
  get(): Selection;
  /**
   * Selects these items instead of the current selection.
   *
   * @param type - The type of the items
   * @returns False when none of the items can be selected
   * @throws `DrawError` with the code `notFound` when one of the IDs is not an item of this
   *   type
   */
  set(type: SelectionType, ids: readonly string[]): boolean;
  /**
   * Adds items of the selected type to the selection.
   *
   * @returns False when none of them can be added
   * @throws `DrawError` with the code `notFound` when one of the IDs is not an item of the
   *   selected type
   */
  add(ids: readonly string[]): boolean;
  /**
   * Removes items from the selection.
   *
   * @returns False when none of them was selected
   */
  remove(ids: readonly string[]): boolean;
  /** Clears the selection. */
  clear(): void;
  /** The selected features; for a group or a layer, the features in it. */
  features(): Feature[];
  /**
   * Deletes what is selected: the selected features, or the selected groups with their
   * features, or the selected layers with their features and groups. Features and groups are
   * deleted as `features.deleteMany({ selection: true })` deletes them, and layers as
   * `layers.deleteMany` deletes them (the layers in the last part): a bulk edit in parts, as
   * the Delete key does. What is locked stays, and the rest is deleted: a selected layer that
   * holds a lock is left out, and its features are counted (`EditCounts.lockedCount`). The
   * document keeps one layer: when every layer is selected, the last of the selection stays.
   * Once the edit has deleted something, nothing is selected. The selected vertices are not
   * deleted (see {@link VertexSelectionResource.delete}).
   *
   * @returns The counts of the edit, or `null` when nothing is selected or the deletion is
   *   refused (read-only, the interaction lock, or everything selected is locked)
   */
  delete(): Promise<EditCounts | null>;
  /**
   * Makes a group of the selected features.
   *
   * @returns The new group, or `null` when the features cannot be grouped
   */
  group(): Group | null;
  /**
   * Takes what is selected out of the groups, as the shortcut Shift+Cmd+G (Shift+Ctrl+G) does:
   * the selected groups are dissolved, their features taking their place in the layer, and
   * selected features that are in a group leave it (the group stays unless it becomes empty).
   *
   * @returns False when nothing selected is a group or in one, or the document is read-only
   */
  ungroup(): boolean;
  /**
   * Moves what is selected.
   *
   * @returns False when nothing is selected or the move is refused
   * @throws `DrawError` with the code `notFound` when the target does not exist
   */
  move(to: MoveTarget): boolean;
}

/**
 * The selected vertices of one feature in this client.
 */
export interface VertexSelectionResource {
  /**
   * The selected vertices.
   *
   * @returns The vertices, or `null` when no vertex is selected
   */
  get(): VertexSelection | null;
  /**
   * Selects vertices of a feature.
   *
   * @returns False when the vertices cannot be selected (a lock)
   * @throws `DrawError` with the code `notFound` when the feature or one of the vertices
   *   does not exist
   */
  set(featureId: string, vertices: readonly VertexRef[]): boolean;
  /** Clears the vertex selection. */
  clear(): void;
  /**
   * Deletes the selected vertices.
   *
   * @returns False when no vertex is selected or the deletion is refused (read-only, a lock)
   */
  delete(): boolean;
}
