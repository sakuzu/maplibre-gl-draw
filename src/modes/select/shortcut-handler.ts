// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Shortcut key handler
 *
 * Responsible for handling keyboard shortcuts in select mode
 */

import { groupSelection, ungroupSelection } from '../../operations/layer-operations.js';
import { deleteSelection } from '../../operations/selection-operations.js';
import {
  coordinatesOf,
  geometryFromCoordinates,
  mapCoordinatesDeep,
} from '../../shared/utils/coordinates.js';
import { isInteractionBlocked } from '../../store/lock.js';
import type { Coordinate, Feature, FeatureCoordinates } from '../../store/types.js';
import { getSelectedFeatureIds } from '../../view/ui/helper.js';
import type { ModeContext } from '../handler.js';

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
export function handleGroupShortcut(context: ModeContext): void {
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
export function handleUngroupShortcut(context: ModeContext): void {
  const { store } = context;
  if (store.isReadOnly() || store.isInteractionLocked()) return;
  ungroupSelection(store);
}

/**
 * Handling of the Delete / Backspace key: deletes what is selected, exactly like
 * `draw.deleteSelection()` (vertices, features, groups or layers; locked items are kept).
 */
export function handleDeleteShortcut(context: ModeContext): void {
  deleteSelection(context.store);
}

/**
 * Handling of the arrow keys: moves the selected features by a few pixels on the screen
 *
 * One key press is one committed change (one notification). Like a drag, nothing moves while
 * any selected feature is blocked (read-only, the interaction lock or a lock of its own).
 *
 * @returns whether the key was used (a selection was moved); otherwise the key is left to
 *   the map (MapLibre pans with it)
 */
export function handleNudgeShortcut(
  context: ModeContext,
  key: string,
  modifiers: { shift: boolean; ctrl: boolean; alt: boolean; meta: boolean },
): boolean {
  const direction = ARROW_DIRECTIONS[key];
  if (!direction || modifiers.ctrl || modifiers.alt || modifiers.meta) return false;

  const { store, map } = context;
  const features = getSelectedFeatureIds(store)
    .map((id) => store.getFeature(id))
    .filter((f): f is Feature => f !== undefined);
  if (features.length === 0) return false;
  if (features.some((f) => isInteractionBlocked(f, store))) return false;

  // One offset in degrees for every feature, taken at a point of the selection, so the
  // features keep their relative placement (the same translation as a move drag)
  const reference = firstCoordinate(coordinatesOf(features[0]));
  if (!reference) return false;
  const step = modifiers.shift ? NUDGE_LARGE : NUDGE_SMALL;
  const from = map.project(reference);
  const to = map.unproject([from.x + direction[0] * step, from.y + direction[1] * step]);
  const dx = to.lng - reference[0];
  const dy = to.lat - reference[1];

  store.transact(() => {
    for (const feature of features) {
      const coordinates = mapCoordinatesDeep(coordinatesOf(feature), (c) => [c[0] + dx, c[1] + dy]);
      store.updateFeature(feature.id, {
        geometry: geometryFromCoordinates(feature.type, coordinates),
      });
    }
  });
  return true;
}

function firstCoordinate(coordinates: FeatureCoordinates): Coordinate | null {
  let value: unknown = coordinates;
  while (Array.isArray(value) && Array.isArray(value[0])) value = value[0];
  return Array.isArray(value) && typeof value[0] === 'number' ? (value as Coordinate) : null;
}

/**
 * Handling of the Escape key
 */
export function handleEscapeShortcut(context: ModeContext): void {
  const { store, map } = context;
  const boxSelection = store.getBoxSelection();

  if (boxSelection) {
    // Cancel when a box selection is in progress (restore the selection as it was when the drag
    // started)
    if (boxSelection.previousSelection.length === 0) {
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
