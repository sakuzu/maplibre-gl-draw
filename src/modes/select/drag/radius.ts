// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Radius drag: changes the radius of a Circle with its radius handle
 */

import type { DragNormalizedEvent } from '../../../dispatcher/types.js';
import { haversineDistanceMeters, initialBearingDegrees } from '../../../geometry/distance.js';
import type { Coordinate, Feature } from '../../../store/types.js';
import type { IntermediateWrites } from './intermediate-writes.js';
import type { DragOperation, DragStore } from './operation.js';

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
export class RadiusDrag implements DragOperation {
  readonly type = 'radius' as const;

  constructor(private readonly state: RadiusState) {}

  update(event: DragNormalizedEvent, store: DragStore, writes: IntermediateWrites): void {
    const feature = store.getFeature(this.state.featureId);
    if (feature?.type !== 'Circle') return;

    const { center } = this.state;
    const mousePoint: Coordinate = [event.lngLat.lng, event.lngLat.lat];

    // Take the distance between the mouse position and the center as the new radius
    const newRadiusMeters = haversineDistanceMeters(center, mousePoint);

    // The great-circle bearing of the radius change handle. The handle is placed with
    // destinationPoint, the inverse of this bearing, so it stays under the pointer
    const newAngle = initialBearingDegrees(center, mousePoint);

    const updates: Partial<Feature> = {
      properties: {
        ...feature.properties,
        radiusMeters: newRadiusMeters,
        radiusHandleAngle: newAngle,
      },
    };

    writes.write(store, this.state.featureId, updates);
  }
}

/**
 * Start a radius drag. Returns null when the feature is not a Circle
 */
export function startRadiusDrag(featureId: string, store: DragStore): RadiusDrag | null {
  const feature = store.getFeature(featureId);
  if (feature?.type !== 'Circle') return null;

  return new RadiusDrag({ featureId, center: feature.coordinates as Coordinate });
}
