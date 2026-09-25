// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * CircleHitTestStrategy
 *
 * Hit testing strategy for Circle features.
 * It tests whether the distance from the center is within the radius.
 */

import { haversineDistanceMeters, metersToLng } from '../../../shared/math/index.js';
import { getCircleRadius } from '../../../shared/utils/property.js';
import type { Coordinate, Feature, FeatureType } from '../../../store/types.js';
import type { HitTestStrategy } from './base.js';

/**
 * Hit testing strategy for the Circle type
 */
export class CircleHitTestStrategy implements HitTestStrategy {
  readonly geometryType: FeatureType = 'Circle';

  test(feature: Feature, coordinate: Coordinate, toleranceLngLat: number): boolean {
    const center = feature.coordinates as Coordinate;
    const radiusMeters = getCircleRadius(feature);

    if (radiusMeters === undefined || radiusMeters <= 0) {
      return false;
    }

    // Compute the distance from the center (meters)
    const distanceMeters = haversineDistanceMeters(coordinate, center);

    // Convert the tolerance to meters
    // toleranceLngLat is a longitude difference, so convert it using the latitude
    const toleranceMeters =
      Math.abs(metersToLng(1, center[1])) > 0
        ? (toleranceLngLat / metersToLng(1, center[1])) * 1
        : 0;

    // Simplified tolerance computation, taking the pixel tolerance into account
    // The actual tolerance is roughly 10-20 meters (it depends on the zoom level)
    const effectiveTolerance = Math.max(toleranceMeters, 10);

    return distanceMeters <= radiusMeters + effectiveTolerance;
  }

  distance(feature: Feature, coordinate: Coordinate): number {
    const center = feature.coordinates as Coordinate;
    const radiusMeters = getCircleRadius(feature);

    if (radiusMeters === undefined || radiusMeters <= 0) {
      return Number.POSITIVE_INFINITY;
    }

    // Distance from the center (meters)
    const distanceMeters = haversineDistanceMeters(coordinate, center);

    // Return the distance from the boundary of the circle
    // Negative inside (the closer to the boundary, the closer to 0), positive outside
    const distanceFromEdge = distanceMeters - radiusMeters;

    // For hit testing, return the absolute distance from the boundary
    // Inside it is the distance to the boundary, and outside it is also the distance to it
    return Math.abs(distanceFromEdge);
  }
}
