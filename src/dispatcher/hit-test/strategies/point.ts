// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * PointHitTestStrategy
 *
 * Hit testing strategy for Point features.
 * Distances are measured in the local frame of hit testing (local-frame.ts).
 */

import { coordinatesOf } from '../../../shared/utils/coordinates.js';
import type { Coordinate, Feature, FeatureType } from '../../../store/types.js';
import { latitudeScale, localDistance } from '../local-frame.js';
import type { HitTestStrategy } from './base.js';

/**
 * The built-in hit test of `Point` features: hit within the tolerance of the position.
 *
 * The distance is measured in the local frame of the click (see {@link HitTestStrategy}).
 * A custom type drawn as a point can reuse it, or extend it to widen the hit area.
 */
export class PointHitTestStrategy implements HitTestStrategy {
  /** The feature type, `'Point'` */
  readonly geometryType: FeatureType = 'Point';

  test(feature: Feature, coordinate: Coordinate, toleranceLngLat: number): boolean {
    const pointCoord = coordinatesOf(feature) as Coordinate;
    const dist = localDistance(coordinate, pointCoord, latitudeScale(coordinate[1]));
    return dist <= toleranceLngLat;
  }

  distance(feature: Feature, coordinate: Coordinate): number {
    const pointCoord = coordinatesOf(feature) as Coordinate;
    return localDistance(coordinate, pointCoord, latitudeScale(coordinate[1]));
  }
}
