// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Transform drags: resize and rotate the selection with its bounding box handles, by the edits
 * `scale` and `rotate` of the sketch of the drag
 */

import type { SketchEdit } from '../../../api/sketches.js';
import type { DragNormalizedEvent } from '../../../dispatcher/types.js';
import { rotateEditOf, rotationCenterOf } from '../../../operations/rotate.js';
import { type ScaleState, scaleEditOf, startScale } from '../../../operations/scale.js';
import type { HandleType } from '../../../shared/config/constants.js';
import { createCoordinateTransform } from '../../../shared/math/index.js';
import type { TransformEdit } from '../../../store/store.js';
import { transformFieldsOfStore } from '../../../store/transform-roles.js';
import type { DragState, Feature } from '../../../store/types.js';
import type { BoundingBoxCoords } from '../../../view/ui/selection-ui/index.js';
import { computeBoundingBox } from '../../../view/ui/selection-ui/index.js';
import type { EngineModeContext } from '../../handler.js';
import type { DragScope, DragStore, DragTarget, SketchDrag } from './operation.js';
import {
  dragStartLngLat,
  selectedOfTarget,
  transformEdits,
  transformMovesNothing,
} from './operation.js';

// === Resize operation ===

/** @internal */
export class ResizeDrag implements SketchDrag {
  readonly type = 'resize' as const;
  readonly start: readonly SketchEdit[];
  readonly selected: readonly string[];

  constructor(
    private readonly state: ScaleState,
    from: { lng: number; lat: number },
    private readonly target: DragTarget,
  ) {
    this.start = transformEdits(scaleEditOf(state, from), target);
    this.selected = selectedOfTarget(target);
  }

  editsAt(event: DragNormalizedEvent): readonly SketchEdit[] {
    return transformEdits(scaleEditOf(this.state, event.lngLat), this.target);
  }

  movesNothing(edits: readonly SketchEdit[]): boolean {
    return transformMovesNothing(edits[0] as TransformEdit);
  }
}

/**
 * Start a resize drag from a bounding box handle
 */
export function startResizeDrag(
  event: DragNormalizedEvent,
  handle: HandleType,
  bbox: BoundingBoxCoords,
  map: EngineModeContext['map'],
  target: DragTarget,
): ResizeDrag {
  // A box thinner than 1 pixel on screen is not stretched along that axis
  const transform = createCoordinateTransform(map);
  const from = dragStartLngLat(event);
  const state = startScale(handle, from, bbox, (lngLat) => transform.metersPerPixel(lngLat));
  return new ResizeDrag(state, from, target);
}

// === Rotate operation ===

/** @internal */
export class RotateDrag implements SketchDrag {
  readonly type = 'rotate' as const;
  readonly start: readonly SketchEdit[];
  readonly selected: readonly string[];

  constructor(
    private readonly center: [number, number],
    private readonly from: { lng: number; lat: number },
    /** What the frame is drawn from during the rotation */
    readonly rotateInfo: NonNullable<DragState['rotateInfo']>,
    private readonly target: DragTarget,
  ) {
    this.start = transformEdits(rotateEditOf(center, from, from), target);
    this.selected = selectedOfTarget(target);
  }

  editsAt(event: DragNormalizedEvent): readonly SketchEdit[] {
    return transformEdits(rotateEditOf(this.center, this.from, event.lngLat), this.target);
  }

  movesNothing(edits: readonly SketchEdit[]): boolean {
    return transformMovesNothing(edits[0] as TransformEdit);
  }

  shown(edits: readonly SketchEdit[], store: DragStore): void {
    const edit = edits[0];
    if (edit?.kind !== 'rotate') return;
    // Update the rotation angle (for drawing the bbox during the rotation)
    const dragState = store.getDragState();
    if (dragState?.rotateInfo) {
      store.setDragState({
        ...dragState,
        rotateInfo: { ...dragState.rotateInfo, currentAngle: (edit.angleDegrees * Math.PI) / 180 },
      });
    }
  }
}

/**
 * Start a rotate drag from the rotation handle
 *
 * @param selected The selected features: the frame turned around their center (none for the
 *   features selected in bulk: around the center of their frame)
 * @param features The ones the rotation turns (the locked ones stay)
 */
export function startRotateDrag(
  event: DragNormalizedEvent,
  bbox: BoundingBoxCoords,
  selected: readonly Feature[],
  features: readonly Feature[],
  store: DragStore,
  scope: DragScope,
  target: DragTarget,
): RotateDrag {
  const center = rotationCenterOf(bbox, selected, transformFieldsOfStore(store));

  // On a multiple selection, also save the initialBbox of each feature
  let initialFeatureBboxes: Map<string, BoundingBoxCoords> | undefined;
  if (selected.length > 1) {
    initialFeatureBboxes = new Map();
    for (const feature of features) {
      const featureBbox = computeBoundingBox(feature, scope?.extensions);
      if (featureBbox) {
        initialFeatureBboxes.set(feature.id, featureBbox);
      }
    }
  }

  // Save the bbox at the start of the rotation (for drawing the bbox during the rotation)
  return new RotateDrag(
    center,
    dragStartLngLat(event),
    {
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
    target,
  );
}
