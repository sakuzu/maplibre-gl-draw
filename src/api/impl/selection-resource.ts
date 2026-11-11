// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The writes of `draw.selection` as the resource made them before the writes moved to
 * `draw.write`: the internal part a write of a transaction that names the selection is made with
 */

import type {
  FeatureFilter,
  StoredFeaturePatch as FeaturePatch,
  FeatureStyleSample,
  Group,
  MoveTarget,
} from '../model.js';
import type { SelectionResource } from '../selection.js';

/**
 * @internal
 */
export interface SelectionWrites extends SelectionResource {
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
