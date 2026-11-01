// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Transform drags: resize and rotate the selection with its bounding box handles, by the edits
 * `scale` and `rotate` as the Store computes them
 */

import type { DragNormalizedEvent } from '../../../dispatcher/types.js';
import { rotateEditOf, rotationCenterOf } from '../../../operations/rotate.js';
import { type ScaleState, scaleEditOf, startScale } from '../../../operations/scale.js';
import {
  type TransformStart,
  transformedUpdates,
  transformStartOf,
  transformsOf,
} from '../../../operations/transform-features.js';
import type { HandleType } from '../../../shared/config/constants.js';
import { createCoordinateTransform } from '../../../shared/math/index.js';
import type { TransformEdit } from '../../../store/store.js';
import {
  type TransformFieldsRegistry,
  transformFieldsOfStore,
} from '../../../store/transform-roles.js';
import type { DragTargets, Feature } from '../../../store/types.js';
import type { BoundingBoxCoords } from '../../../view/ui/selection-ui/index.js';
import { computeBoundingBox } from '../../../view/ui/selection-ui/index.js';
import type { EngineModeContext } from '../../handler.js';
import type { IntermediateWrites } from './intermediate-writes.js';
import type { DragOperation, DragScope, DragStore } from './operation.js';
import { dragStartLngLat, selectedFeaturesOf } from './operation.js';

/** The values of the features a drag started from, by feature id */
function startsOf(
  features: readonly Feature[],
  fields: TransformFieldsRegistry | null,
): Map<string, TransformStart> {
  const starts = new Map<string, TransformStart>();
  for (const feature of features) starts.set(feature.id, transformStartOf(feature, fields));
  return starts;
}

/** Writes an edit over the selected features the drag started from */
function writeEdit(
  edit: TransformEdit,
  starts: ReadonlyMap<string, TransformStart>,
  store: DragStore,
  writes: IntermediateWrites,
): void {
  const transforms = transformsOf(store);
  for (const feature of selectedFeaturesOf(store)) {
    const start = starts.get(feature.id);
    if (!start) continue;
    const updates = transformedUpdates(transforms, edit, start, feature);
    if (updates) writes.write(store, feature.id, updates);
  }
}

// === Resize operation ===

/** @internal */
export class ResizeDrag implements DragOperation {
  readonly type = 'resize' as const;

  constructor(
    private readonly state: ScaleState,
    private readonly starts: ReadonlyMap<string, TransformStart>,
  ) {}

  update(event: DragNormalizedEvent, store: DragStore, writes: IntermediateWrites): void {
    writeEdit(scaleEditOf(this.state, event.lngLat), this.starts, store, writes);
  }
}

/**
 * Start a resize drag from a bounding box handle
 *
 * @param store The Store of the instance, whose custom types tell the fields the drag writes
 */
export function startResizeDrag(
  event: DragNormalizedEvent,
  handle: HandleType,
  bbox: BoundingBoxCoords,
  features: Feature[],
  map: EngineModeContext['map'],
  store: DragStore,
): ResizeDrag {
  // A box thinner than 1 pixel on screen is not stretched along that axis
  const transform = createCoordinateTransform(map);
  const state = startScale(handle, dragStartLngLat(event), bbox, (lngLat) =>
    transform.metersPerPixel(lngLat),
  );
  return new ResizeDrag(state, startsOf(features, transformFieldsOfStore(store)));
}

// === Rotate operation ===

/** @internal */
export class RotateDrag implements DragOperation {
  readonly type = 'rotate' as const;

  constructor(
    private readonly center: [number, number],
    private readonly startLngLat: { lng: number; lat: number },
    private readonly starts: ReadonlyMap<string, TransformStart>,
  ) {}

  update(event: DragNormalizedEvent, store: DragStore, writes: IntermediateWrites): void {
    const edit = rotateEditOf(this.center, this.startLngLat, event.lngLat);
    writeEdit(edit, this.starts, store, writes);

    // Update the rotation angle (for drawing the bbox during the rotation)
    const currentDragState = store.getDragState();
    if (currentDragState?.rotateInfo) {
      store.setDragState({
        ...currentDragState,
        rotateInfo: {
          ...currentDragState.rotateInfo,
          currentAngle: (edit.angleDegrees * Math.PI) / 180,
        },
      });
    }
  }
}

/**
 * Start a rotate drag from the rotation handle, and set the DragState it draws from
 *
 * @param targets The features the rotation turns, as its drag state records them (snapping
 *   leaves them out)
 */
export function startRotateDrag(
  event: DragNormalizedEvent,
  bbox: BoundingBoxCoords,
  features: Feature[],
  store: DragStore,
  scope: DragScope,
  targets: DragTargets,
): RotateDrag {
  const fields = transformFieldsOfStore(store);
  const center = rotationCenterOf(bbox, features, fields);
  const drag = new RotateDrag(center, dragStartLngLat(event), startsOf(features, fields));

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
    ...targets,
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
      center,
    },
  });
  return drag;
}
