// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Radius drag: changes the radius of a Circle with its radius handle
 */

import type { SketchEdit } from '../../../api/sketches.js';
import type { DragNormalizedEvent } from '../../../dispatcher/types.js';
import { haversineDistanceMeters, initialBearingDegrees } from '../../../geometry/distance.js';
import { drawProperties } from '../../../shared/properties.js';
import { coordinatesOf } from '../../../shared/utils/coordinates.js';
import type { Coordinate } from '../../../store/types.js';
import type { DragStore, SketchDrag } from './operation.js';

/**
 * State of a Circle radius change operation
 */
export interface RadiusState {
  /** ID of the feature being operated on */
  featureId: string;
  /** Center coordinate of the circle */
  center: Coordinate;
}

/** @internal */
export class RadiusDrag implements SketchDrag {
  readonly type = 'radius' as const;
  readonly start: readonly SketchEdit[];
  readonly selected: readonly string[];

  constructor(private readonly state: RadiusState) {
    this.start = [{ kind: 'set', featureId: state.featureId, patch: {} }];
    this.selected = [state.featureId];
  }

  editsAt(event: DragNormalizedEvent): readonly SketchEdit[] {
    const { center, featureId } = this.state;
    const mousePoint: Coordinate = [event.lngLat.lng, event.lngLat.lat];
    // Take the distance between the mouse position and the center as the new radius, and the
    // great-circle bearing of the radius change handle. The handle is placed with
    // destinationPoint, the inverse of this bearing, so it stays under the pointer
    const properties = drawProperties({
      radiusMeters: haversineDistanceMeters(center, mousePoint),
      radiusHandleAngle: initialBearingDegrees(center, mousePoint),
    });
    return [{ kind: 'set', featureId, patch: { properties } }];
  }

  movesNothing(edits: readonly SketchEdit[]): boolean {
    return edits[0]?.kind === 'set' && edits[0].patch.properties === undefined;
  }
}

/**
 * Start a radius drag. Returns null when the feature is not a Circle
 */
export function startRadiusDrag(featureId: string, store: DragStore): RadiusDrag | null {
  const feature = store.getFeature(featureId);
  if (feature?.type !== 'Circle') return null;

  return new RadiusDrag({ featureId, center: coordinatesOf(feature) as Coordinate });
}
