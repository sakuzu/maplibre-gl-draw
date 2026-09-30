// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * PointHitTestStrategy
 *
 * Hit testing strategy for Point features.
 * Distances are measured in the local frame of hit testing (local-frame.ts).
 */

import type { Feature, FeatureType } from '../../../api/model.js';
import { coordinatesOf } from '../../../shared/utils/coordinates.js';
import type { Coordinate } from '../../../store/types.js';
import { latitudeScale, localDistance } from '../local-frame.js';

/**
 * The built-in hit test of `Point` features: hit within the tolerance of the position.
 *
 * The distance is measured in a local frame around the click, where a degree of longitude is
 * scaled by the cosine of the latitude. A feature type drawn as a point can reuse it, or
 * extend it to widen the hit area. The engine uses it as the hit test of its points.
 */
export class PointHitTestStrategy {
  /** The feature type, `'Point'` */
  readonly geometryType: FeatureType = 'Point';

  /** Whether the feature is within `toleranceLngLat` degrees of the coordinate */
  test(feature: Feature, coordinate: [number, number], toleranceLngLat: number): boolean {
    const pointCoord = coordinatesOf(feature) as Coordinate;
    const dist = localDistance(coordinate, pointCoord, latitudeScale(coordinate[1]));
    return dist <= toleranceLngLat;
  }

  /** The distance from the coordinate to the feature, in degrees of the local frame */
  distance(feature: Feature, coordinate: [number, number]): number {
    const pointCoord = coordinatesOf(feature) as Coordinate;
    return localDistance(coordinate, pointCoord, latitudeScale(coordinate[1]));
  }
}
