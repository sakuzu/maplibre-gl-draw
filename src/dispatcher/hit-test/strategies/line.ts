// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * LineHitTestStrategy
 *
 * Hit testing strategy for LineString features.
 * Distances are measured in the local frame of hit testing (local-frame.ts).
 */

import { coordinatesOf } from '../../../shared/utils/coordinates.js';
import type { Coordinate, Feature, FeatureType } from '../../../store/types.js';
import { latitudeScale, localPointToPolylineDistance } from '../local-frame.js';
import { polylineDistanceWithin } from '../segment-grid.js';
import type { HitTestStrategy } from './base.js';

/**
 * Hit testing strategy for the LineString type
 */
export class LineHitTestStrategy implements HitTestStrategy {
  readonly geometryType: FeatureType = 'LineString';

  test(feature: Feature, coordinate: Coordinate, toleranceLngLat: number): boolean {
    return this.testDistance(feature, coordinate, toleranceLngLat) !== null;
  }

  distance(feature: Feature, coordinate: Coordinate): number {
    const lineCoords = coordinatesOf(feature) as Coordinate[];
    // The nearest distance without a tolerance cannot be answered by the index, so this
    // stays a full scan
    return localPointToPolylineDistance(coordinate, lineCoords, latitudeScale(coordinate[1]));
  }

  testDistance(feature: Feature, coordinate: Coordinate, toleranceLngLat: number): number | null {
    const lineCoords = coordinatesOf(feature) as Coordinate[];
    return polylineDistanceWithin(
      lineCoords,
      coordinate,
      toleranceLngLat,
      latitudeScale(coordinate[1]),
    );
  }
}
