// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Shortcut key handler
 *
 * Responsible for handling keyboard shortcuts in select mode
 */

import { bulkSelectionLocked } from '../../operations/bulk-selection.js';
import { groupSelection, ungroupSelection } from '../../operations/layer-operations.js';
import { deleteSelection } from '../../operations/selection-operations.js';
import {
  transformedUpdates,
  transformStartOf,
  transformsOf,
} from '../../operations/transform-features.js';
import { coordinatesOf, mapCoordinatesDeep } from '../../shared/utils/coordinates.js';
import { isInteractionBlocked } from '../../store/lock.js';
import type { TransformEdit } from '../../store/store.js';
import type { Feature } from '../../store/types.js';
import { getSelectedFeatureIds } from '../../view/ui/helper.js';
import type { EngineModeContext } from '../handler.js';
import type { BulkNudge } from './bulk.js';

/** The distance an arrow key moves the selection (pixels; with Shift, NUDGE_LARGE) */
const NUDGE_SMALL = 1;
const NUDGE_LARGE = 10;

/** Screen direction of each arrow key */
const ARROW_DIRECTIONS: Readonly<Record<string, readonly [number, number]>> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
};

/**
 * Handling of the group shortcut (Cmd+G / Ctrl+G).
 *
 * The behavior is identical to the API's groupSelection (the key, the menu and the API place the
 * new group at the same position).
 */
export function handleGroupShortcut(context: EngineModeContext): void {
  const { store, autoNameGenerator, generateFeatureId } = context;
  if (store.isReadOnly() || store.isInteractionLocked()) return;
  groupSelection(store, generateFeatureId, autoNameGenerator);
}

/**
 * Handling of the ungroup shortcut (Shift+Cmd+G / Shift+Ctrl+G).
 *
 * The behavior is identical to the API's ungroupSelection (keeping the key, the menu and the API
 * consistent): a group selection is dissolved, and for a member feature selection only that
 * member leaves.
 */
export function handleUngroupShortcut(context: EngineModeContext): void {
  const { store } = context;
  if (store.isReadOnly() || store.isInteractionLocked()) return;
  ungroupSelection(store);
}

/**
 * Handling of the Delete / Backspace key: deletes what is selected (vertices, features, groups
 * or layers; locked items are kept) with `deleteSelection` of `operations/`.
 */
export function handleDeleteShortcut(context: EngineModeContext): void {
  deleteSelection(context.store);
}

/**
 * Handling of the arrow keys: moves the selected features by a few pixels on the screen
 *
 * The press is one move (`translate`) of every feature, as the Store computes it: from the center
 * of the frame of the selection to the point the pixels of the press take it to on the screen.
 * One key press is one committed change (one notification). Like a drag, nothing moves while any
 * selected feature is blocked (read-only, the interaction lock or a lock of its own).
 *
 * @returns whether the key was used (a selection was moved); otherwise the key is left to
 *   the map (MapLibre pans with it)
 */
export function handleNudgeShortcut(
  context: EngineModeContext,
  key: string,
  modifiers: { shift: boolean; ctrl: boolean; alt: boolean; meta: boolean },
  bulkNudge?: BulkNudge,
): boolean {
  const direction = ARROW_DIRECTIONS[key];
  if (!direction || modifiers.ctrl || modifiers.alt || modifiers.meta) return false;

  const { store, map } = context;
  const step = modifiers.shift ? NUDGE_LARGE : NUDGE_SMALL;
  /** The point the press takes a point to: moved by the pixels of the press on the screen */
  const pressed = (from: readonly [number, number]): [number, number] => {
    const at = map.project([from[0], from[1]]);
    const to = map.unproject([at.x + direction[0] * step, at.y + direction[1] * step]);
    return [to.lng, to.lat];
  };

  // Features selected in bulk: moved by their moving set while the keys are pressed, and written
  // once a moment after the last press (the presses of a key held are one change)
  const bulk = store.getSelection().bulk;
  if (bulk) {
    if (!bulkNudge || !bulk.bounds) return false;
    if (store.isReadOnly() || store.isInteractionLocked() || bulkSelectionLocked(store)) {
      return false;
    }
    const [west, south, east, north] = bulk.bounds;
    return bulkNudge.add(context, [(west + east) / 2, (south + north) / 2], pressed);
  }

  const features = getSelectedFeatureIds(store)
    .map((id) => store.getFeature(id))
    .filter((f): f is Feature => f !== undefined);
  if (features.length === 0) return false;
  if (features.some((f) => isInteractionBlocked(f, store))) return false;

  const center = selectionCenterOf(features);
  if (!center) return false;
  const edit: TransformEdit = { kind: 'translate', from: center, to: pressed(center) };
  const transforms = transformsOf(store);

  store.transact(() => {
    for (const feature of features) {
      const updates = transformedUpdates(transforms, edit, transformStartOf(feature), feature);
      if (updates?.geometry) store.updateFeature(feature.id, { geometry: updates.geometry });
    }
  });
  return true;
}

/** The center of the extent of the positions of features (null without a position) */
function selectionCenterOf(features: readonly Feature[]): [number, number] | null {
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (const feature of features) {
    mapCoordinatesDeep(coordinatesOf(feature), (position) => {
      const x = position[0] as number;
      const y = position[1] as number;
      if (x < west) west = x;
      if (x > east) east = x;
      if (y < south) south = y;
      if (y > north) north = y;
      return position;
    });
  }
  if (!(west <= east && south <= north)) return null;
  return [(west + east) / 2, (south + north) / 2];
}

/**
 * Handling of the Escape key
 */
export function handleEscapeShortcut(context: EngineModeContext): void {
  const { store, map } = context;
  const boxSelection = store.getBoxSelection();

  if (boxSelection) {
    // Cancel when a box selection is in progress (restore the selection as it was when the drag
    // started, features selected in bulk included)
    if (boxSelection.previous) {
      store.restoreSelection(boxSelection.previous);
    } else if (boxSelection.previousSelection.length === 0) {
      store.setSelection(null, []);
    } else {
      store.setSelection('feature', boxSelection.previousSelection);
    }
    store.setBoxSelection(null);
    map.dragPan.enable();
    map.triggerRepaint();
    return;
  }

  // Clear the vertex selection when vertices are selected
  const selectedVertices = store.getVertexSelection();
  if (selectedVertices) {
    store.setSelectedVertices(null);
    return;
  }

  // Clear the feature selection
  store.setSelection(null, []);
}
