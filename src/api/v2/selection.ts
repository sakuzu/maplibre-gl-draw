// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `draw.selection` and `draw.vertexSelection`: what this client has selected
 */

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
   * @param type - The type of the items; taken from the IDs when it is left out
   * @returns False when none of the items can be selected
   */
  // TODO(api-2): confirm how the type is found when it is left out, and whether an unknown ID throws
  set(ids: readonly string[], type?: SelectionType): boolean;
  /**
   * Adds items of the selected type to the selection.
   *
   * @returns False when none of them can be added
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
   * Deletes what is selected.
   *
   * @returns False when nothing is selected or the deletion is refused (read-only, a lock)
   */
  delete(): boolean;
  /**
   * Makes a group of the selected features.
   *
   * @returns The new group, or `null` when the features cannot be grouped
   */
  group(): Group | null;
  /**
   * Ungroups the selected groups.
   *
   * @returns False when no group is selected or the change is refused
   */
  ungroup(): boolean;
  /**
   * Moves what is selected.
   *
   * @returns False when nothing is selected or the move is refused
   * @throws `DrawError` with the code `not-found` when the target does not exist
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
   * @throws `DrawError` with the code `not-found` when the feature or one of the vertices
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
