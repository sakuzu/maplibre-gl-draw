// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Transform drags: resize and rotate the selection with its bounding box handles
 */

import type { DragNormalizedEvent } from '../../../dispatcher/types.js';
import type { ResizeState } from '../../../operations/resize.js';
import { computeResize, startResize } from '../../../operations/resize.js';
import type { RotateState } from '../../../operations/rotate.js';
import { computeRotation, getRotationDelta, startRotation } from '../../../operations/rotate.js';
import type { HandleType } from '../../../shared/config/constants.js';
import type { Feature } from '../../../store/types.js';
import type { BoundingBoxCoords } from '../../../view/ui/selection-ui/index.js';
import { computeBoundingBox } from '../../../view/ui/selection-ui/index.js';
import type { ModeContext } from '../../handler.js';
import type { IntermediateWrites } from './intermediate-writes.js';
import type { DragOperation, DragScope, DragStore } from './operation.js';
import { dragStartLngLat, selectedFeaturesOf } from './operation.js';

// === Resize operation ===

/** @internal */
export class ResizeDrag implements DragOperation {
  readonly type = 'resize' as const;

  constructor(
    private readonly state: ResizeState,
    private readonly scope: DragScope,
  ) {}

  update(event: DragNormalizedEvent, store: DragStore, writes: IntermediateWrites): void {
    // Compute the resize for each feature
    for (const feature of selectedFeaturesOf(store)) {
      const resizeResults = computeResize(
        this.state,
        event.lngLat,
        [feature],
        this.scope?.extensions,
      );
      const result = resizeResults.get(feature.id);

      if (result) {
        const updates: Partial<Feature> = { coordinates: result.coordinates };

        // Update the scale property when there is one (Text, Image, etc.)
        if (result.scale !== undefined) {
          updates.properties = {
            ...feature.properties,
            scale: result.scale,
          };
        }

        // For a Circle, also update the radiusMeters property
        if (result.radiusMeters !== undefined && feature.type === 'Circle') {
          updates.properties = {
            ...feature.properties,
            radiusMeters: result.radiusMeters,
          };
        }

        // For a custom resize, also update the width / height properties (Note, etc.)
        if (result.width !== undefined || result.height !== undefined) {
          updates.properties = {
            ...feature.properties,
            ...(result.width !== undefined && { width: result.width }),
            ...(result.height !== undefined && { height: result.height }),
          };
        }

        writes.write(store, feature.id, updates);
      }
    }
  }
}

/**
 * Start a resize drag from a bounding box handle
 */
export function startResizeDrag(
  event: DragNormalizedEvent,
  handle: HandleType,
  bbox: BoundingBoxCoords,
  features: Feature[],
  map: ModeContext['map'],
  scope: DragScope,
): ResizeDrag {
  // A box thinner than 1 pixel on screen is not stretched along that axis (converted into
  // Web Mercator world units at the current zoom)
  const zoom = map.getZoom?.();
  const tileSize = scope?.extensions.getTileSize() ?? 512;
  const minAxisExtent = Number.isFinite(zoom) ? 1 / (tileSize * 2 ** (zoom as number)) : 0;

  const state = startResize(
    handle,
    dragStartLngLat(event),
    bbox,
    features,
    scope?.extensions,
    minAxisExtent,
  );
  return new ResizeDrag(state, scope);
}

// === Rotate operation ===

/** @internal */
export class RotateDrag implements DragOperation {
  readonly type = 'rotate' as const;

  constructor(private readonly state: RotateState) {}

  update(event: DragNormalizedEvent, store: DragStore, writes: IntermediateWrites): void {
    const rotateResults = computeRotation(this.state, event.lngLat, selectedFeaturesOf(store));

    for (const [id, result] of rotateResults) {
      const feature = store.getFeature(id);
      if (feature) {
        const updates: Partial<Feature> = { coordinates: result.coordinates };

        // Update the rotation property when there is one (Text, Image, Note, etc.)
        if (result.rotation !== undefined) {
          updates.properties = {
            ...feature.properties,
            rotation: result.rotation,
          };
        }

        writes.write(store, id, updates);
      }
    }

    // Update the rotation angle (for drawing the bbox during the rotation)
    const currentAngle = getRotationDelta(this.state, event.lngLat);
    const currentDragState = store.getDragState();
    if (currentDragState?.rotateInfo) {
      store.setDragState({
        ...currentDragState,
        rotateInfo: {
          ...currentDragState.rotateInfo,
          currentAngle,
        },
      });
    }
  }
}

/**
 * Start a rotate drag from the rotation handle, and set the DragState it draws from
 */
export function startRotateDrag(
  event: DragNormalizedEvent,
  bbox: BoundingBoxCoords,
  features: Feature[],
  store: DragStore,
  scope: DragScope,
): RotateDrag {
  const drag = new RotateDrag(
    startRotation(dragStartLngLat(event), bbox, features, scope?.extensions),
  );

  // On a multiple selection, also save the initialBbox of each feature
  let initialFeatureBboxes: Map<string, BoundingBoxCoords> | undefined;
  if (features.length > 1) {
    initialFeatureBboxes = new Map();
    for (const feature of features) {
      const featureBbox = computeBoundingBox(feature, scope?.extensions);
      if (featureBbox) {
        initialFeatureBboxes.set(feature.id, featureBbox);
      }
    }
  }

  // Save the bbox at the start of the rotation (for drawing the bbox during the rotation)
  store.setDragState({
    operation: 'rotate',
    rotateInfo: {
      initialBbox: {
        topLeft: bbox.topLeft,
        topRight: bbox.topRight,
        bottomRight: bbox.bottomRight,
        bottomLeft: bbox.bottomLeft,
        center: bbox.center,
      },
      initialFeatureBboxes,
      currentAngle: 0,
    },
  });
  return drag;
}
