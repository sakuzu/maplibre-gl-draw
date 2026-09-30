// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * cursor control for SelectMode (onMouseMove)
 *
 * 1. There is a selected feature and a handle was hit -> the cursor that matches the handle kind
 *    (move / resize / vertex, etc.)
 * 1.5. A selection-independent auxiliary handle (provided by an extension implementation) was
 *    hit -> that handle's cursor
 * 2. Otherwise, a Store feature or an interactive dataset is in the very
 *    foreground -> 'pointer'
 * 3. Otherwise (a dataset that merely occludes / nothing) -> 'default'
 */

import type { MouseNormalizedEvent } from '../../dispatcher/types.js';
import type { SelectionUIConfig } from '../../shared/config/selection.js';
import { createCoordinateTransform } from '../../shared/math/index.js';
import { getDisplayFeatures } from '../../store/local-visibility.js';
import { isInteractionBlocked } from '../../store/lock.js';
import {
  getCursorForHandle,
  hitTestGlobalAuxiliaryHandles,
  hitTestHandles,
} from '../../view/ui/handle-test.js';
import {
  computeSelectionBoundingBox,
  getSelectedFeatureIds,
  getSelectedFeatures,
} from '../../view/ui/helper.js';
import type { EngineModeContext } from '../handler.js';
import {
  getAdditionalResizeHandlesCallback,
  getAuxiliaryHandlesCallback,
  getGlobalAuxiliaryHandlesCallback,
} from './hit-helpers.js';

export function updateCursorForSelection(
  event: MouseNormalizedEvent,
  context: EngineModeContext,
  config: SelectionUIConfig,
): void {
  const { store, map } = context;
  // Group / layer selections are also resolved to their members (so the operation cursor is
  // shown over a group).
  const selectedIds = getSelectedFeatureIds(store);
  const canvas = map.getCanvas();
  const transform = createCoordinateTransform(map);

  // Handle hit test on the selected features
  // No operation cursor (move / resize, etc.) is shown for a selection whose editing operations
  // are suppressed (effective lock / read-only / interaction lock). Dragging is rejected by
  // startDrag with the same predicate, so the cursor alone would be a lie suggesting it is
  // possible. It falls through to the feature hit test below (pointer), matching the operation
  // that is actually possible: "it can be selected by clicking".
  if (selectedIds.length > 0) {
    const selectedFeatures = getSelectedFeatures(store);
    const blocked = selectedFeatures.some((f) => isInteractionBlocked(f, store));
    const bbox = blocked
      ? null
      : computeSelectionBoundingBox(selectedFeatures, context.selectionScope.extensions);

    if (bbox) {
      const zoom = map.getZoom();
      const getAdditionalHandles = getAdditionalResizeHandlesCallback(
        selectedFeatures,
        context.selectionScope,
      );
      const getAuxiliaryHandles = getAuxiliaryHandlesCallback(
        selectedFeatures,
        context.selectionScope,
      );
      const handleHit = hitTestHandles(
        event.point,
        selectedFeatures,
        transform,
        config,
        zoom,
        context.selectionScope,
        getAdditionalHandles,
        getAuxiliaryHandles,
      );

      if (handleHit) {
        canvas.style.cursor = getCursorForHandle(handleHit);
        return;
      }
    }
  }

  // Selection-independent auxiliary handles (an extension implementation's focus, etc.). They
  // appear regardless of whether there is a selection, so they are looked at after the selection
  // handles and before the feature hit. They are not shown in a state where they cannot be
  // grabbed (readOnly / interaction lock) (the cursor alone would be a lie suggesting it is
  // possible).
  if (!store.isReadOnly() && !store.isInteractionLocked()) {
    const globalHit = hitTestGlobalAuxiliaryHandles(
      event.point,
      transform,
      config,
      map.getZoom(),
      getGlobalAuxiliaryHandlesCallback(context.selectionScope),
    );
    if (globalHit) {
      canvas.style.cursor = getCursorForHandle(globalHit);
      return;
    }
  }

  // Feature hit test (unified z traversal)
  // When a dataset is in the foreground, the cursor becomes pointer only when it
  // can fire click / hover (interactive). Showing pointer for a dataset that merely occludes
  // would be a lie suggesting "it can be pressed".
  const orderedFeatures = getDisplayFeatures(store);
  const top = context.hitTestTopmost(event.point, { orderedFeatures });

  canvas.style.cursor =
    top === null || (top.kind === 'dataset' && !top.dataset.interactive) ? 'default' : 'pointer';
}
