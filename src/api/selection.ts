// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `draw.selection` and `draw.vertexSelection`: what this client has selected
 */

import type {
  Feature,
  FeatureFilter,
  FeatureListOptions,
  FeaturePatch,
  FeatureStyleSample,
  Group,
  MoveTarget,
} from './model.js';
import type { Selection, SelectionType, VertexRef, VertexSelection } from './state.js';

/**
 * The selection of this client: features, groups or layers, one type at a time, and the
 * verbs that act on what is selected.
 */
export interface SelectionResource {
  /**
   * The type and the IDs of what is selected. Many features selected at once in a Store that
   * holds its features as rows have no list of IDs: `bulk` tells how many, in which layers and
   * where.
   */
  get(): Selection;
  /**
   * Selects these items instead of the current selection.
   *
   * @param type - The type of the items
   * @returns False when none of the items can be selected
   * @throws `DrawError` with the code `not-found` when one of the IDs is not an item of this
   *   type
   */
  set(type: SelectionType, ids: readonly string[]): boolean;
  /**
   * Selects every feature that matches a filter (every feature when it is left out), as
   * Cmd+A does. Only what can be seen is selected. In a Store that holds its features as rows,
   * more features than are made at once are selected in bulk (`Selection.bulk`), and no ID is
   * listed.
   *
   * @returns False when no feature can be selected
   * @throws `DrawError` with the code `invalid-input` when the filter has another shape
   */
  setAll(filter?: FeatureFilter): boolean;
  /**
   * Selects again what a selection read before held (`get`, `selection.changed`, a change of the
   * document), features selected in bulk included: what is no longer there or cannot be seen is
   * left out.
   *
   * @returns False when nothing of it can be selected (the selection is cleared then)
   */
  restore(selection: Selection): boolean;
  /**
   * Adds items of the selected type to the selection.
   *
   * @returns False when none of them can be added
   * @throws `DrawError` with the code `not-found` when one of the IDs is not an item of the
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
  /**
   * The selected features that match a filter (all when it is left out); for a group or a layer,
   * the features in it, in stacking order.
   *
   * @param options - At most `limit` features, read on after the feature `after`. Features
   *   selected in bulk (`Selection.bulk`) are read a page at a time: they need it
   * @throws `DrawError` with the code `invalid-state` for features selected in bulk without a
   *   limit; `not-found` when `after` is not a selected feature; `invalid-input` when the filter
   *   or the options have another shape
   */
  features(filter?: FeatureFilter, options?: FeatureListOptions): Feature[];
  /**
   * The number of the selected features that match a filter (all when it is left out); for a
   * group or a layer, of the features in it. No feature is made for it, so it counts features
   * selected in bulk too.
   *
   * @throws `DrawError` with the code `invalid-input` when the filter has another shape
   */
  count(filter?: FeatureFilter): number;
  /**
   * Changes the selected features that match a filter (all when it is left out), as
   * `features.updateMany` does, in one change. The patch is the same for every feature, or made
   * by a function once per kind of feature (`FeatureStyleSample`: the type, the style and the zoom
   * it was created at) and given to every feature of the kind: a selection of many features asks
   * for a few patches. A patch that changes the geometry is refused. A locked feature is left as
   * it is and the others are changed, unless the patch is of `locked` and `visible` only.
   *
   * @param patch - The patch, or the function that makes it for a kind of feature (null: the kind
   *   is left as it is)
   * @returns False when nothing is changed (every feature is locked, too), or the change is
   *   refused (read-only, the interaction lock)
   * @throws `DrawError` with the code `invalid-input` when a patch has another shape or changes
   *   the geometry
   */
  update(
    patch: FeaturePatch | ((sample: FeatureStyleSample) => FeaturePatch | null),
    filter?: FeatureFilter,
  ): boolean;
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
