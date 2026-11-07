// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Shortcut key handler
 *
 * Responsible for handling keyboard shortcuts in select mode
 */

import { groupSelection, ungroupSelection } from '../../operations/layer-operations.js';
import { deleteSelection } from '../../operations/selection-operations.js';
import { createCoordinateTransform, offsetOnTangentPlane } from '../../shared/math/index.js';
import { coordinatesOf, mapCoordinatesDeep } from '../../shared/utils/coordinates.js';
import { editableFeatures } from '../../store/lock.js';
import type { Feature } from '../../store/types.js';
import { getSelectedFeatureIds } from '../../view/ui/helper.js';
import type { EngineModeContext } from '../handler.js';
import type { Nudge } from './nudge.js';

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
 *
 * @returns whether the key was used (a group was made)
 */
export function handleGroupShortcut(context: EngineModeContext): boolean {
  const { store, autoNameGenerator, generateFeatureId } = context;
  if (store.isReadOnly() || store.isInteractionLocked()) return false;
  return groupSelection(store, generateFeatureId, autoNameGenerator) !== null;
}

/**
 * Handling of the ungroup shortcut (Shift+Cmd+G / Shift+Ctrl+G).
 *
 * The behavior is identical to the API's ungroupSelection (keeping the key, the menu and the API
 * consistent): a group selection is dissolved, and for a member feature selection only that
 * member leaves.
 *
 * @returns whether the key was used (the selection was ungrouped)
 */
export function handleUngroupShortcut(context: EngineModeContext): boolean {
  const { store } = context;
  if (store.isReadOnly() || store.isInteractionLocked()) return false;
  return ungroupSelection(store);
}

/**
 * Handling of the Delete / Backspace key: deletes what is selected (vertices, features, groups
 * or layers; locked items are kept) with `deleteSelection` of `operations/`.
 *
 * @returns whether the key was used (something was deleted); with nothing selected, or only
 *   locked items, the key is left to the page
 */
export function handleDeleteShortcut(context: EngineModeContext): boolean {
  return deleteSelection(context.store);
}

/**
 * Handling of the arrow keys: moves the selected features by a few pixels of the view
 *
 * The press is one move (`translate`) of every feature, as the Store computes it: from the center
 * of the frame of the selection, along the direction of the key on the screen turned by the
 * bearing of the map onto the ground, by the pixels of the press turned into meters with the scale
 * of the frame drawn last (on the plane tangent to the sphere of the map there). On a map turned
 * flat and untilted the selection moves by those pixels on the screen; tilted, it moves by the
 * same length on the ground, foreshortened as the map is.
 * The presses are shown by a sketch of this client and written once, a moment after the last one
 * (`Nudge`): the presses of a key held are one change. Like a drag, a locked feature stays
 * where it is and the others move; nothing moves while read-only, under the interaction lock, or
 * when every selected feature is locked.
 *
 * @returns whether the key was used (a selection was moved); otherwise the key is left to
 *   the map (MapLibre pans with it)
 */
export function handleNudgeShortcut(
  context: EngineModeContext,
  key: string,
  modifiers: { shift: boolean; ctrl: boolean; alt: boolean; meta: boolean },
  nudge: Nudge,
): boolean {
  const direction = ARROW_DIRECTIONS[key];
  if (!direction || modifiers.ctrl || modifiers.alt || modifiers.meta) return false;

  const { store, map } = context;
  const step = modifiers.shift ? NUDGE_LARGE : NUDGE_SMALL;
  const transform = createCoordinateTransform(map);
  // The right and the down of the screen on the ground: up is the bearing of the map (clockwise
  // from north), right is a quarter turn clockwise from it
  const bearing = (map.getBearing() * Math.PI) / 180;
  const [right, down] = direction;
  const east = right * Math.cos(bearing) - down * Math.sin(bearing);
  const north = -right * Math.sin(bearing) - down * Math.cos(bearing);
  /** The point the press takes a point to: moved by the pixels of the press on the ground */
  const pressed = (from: readonly [number, number]): [number, number] => {
    const meters = step * transform.metersPerPixel([from[0], from[1]]);
    return offsetOnTangentPlane(from, east * meters, north * meters);
  };

  // Features selected in bulk: the rows are not listed, and the presses start from the center of
  // their frame
  const bulk = store.getSelection().bulk;
  if (bulk) {
    if (!bulk.bbox) return false;
    const [west, south, east, north] = bulk.bbox;
    return nudge.add(context, null, [(west + east) / 2, (south + north) / 2], pressed);
  }

  const features = getSelectedFeatureIds(store)
    .map((id) => store.getFeature(id))
    .filter((f): f is Feature => f !== undefined);
  if (features.length === 0) return false;
  const moving = editableFeatures(features, store);
  if (moving.length === 0) return false;

  const center = selectionCenterOf(features);
  if (!center) return false;
  return nudge.add(
    context,
    moving.map((feature) => feature.id),
    center,
    pressed,
  );
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
 * Handling of the Escape key: cancels a box selection, or lets go of the vertices selected, or
 * of the selection
 *
 * @returns whether the key was used; with nothing selected, the key is left to the page
 */
export function handleEscapeShortcut(context: EngineModeContext): boolean {
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
    return true;
  }

  // Clear the vertex selection when vertices are selected
  const selectedVertices = store.getVertexSelection();
  if (selectedVertices) {
    store.setSelectedVertices(null);
    return true;
  }

  // Clear the feature selection
  const selection = store.getSelection();
  if (selection.ids.length === 0 && !selection.bulk) return false;
  store.setSelection(null, []);
  return true;
}
