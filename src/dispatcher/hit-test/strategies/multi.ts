// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Hit testing strategies for the Multi geometries
 *
 * MultiPoint / MultiLineString / MultiPolygon are tested as "a hit if any part is hit"
 * and "the distance is the minimum over the parts". The test logic itself reuses the
 * strategy of the single geometry for each part. Distances are measured in the local frame
 * of hit testing (local-frame.ts).
 */

import { coordinatesOf } from '../../../shared/utils/coordinates.js';
import type { Coordinate, Feature, FeatureType } from '../../../store/types.js';
import { latitudeScale, localDistance, localPointToPolylineDistance } from '../local-frame.js';
import { polylineDistanceWithin } from '../segment-grid.js';
import type { HitTestStrategy } from './base.js';
import { PolygonHitTestStrategy } from './polygon.js';

/**
 * Hit testing strategy for the MultiPoint type
 *
 * The coordinates are `Coordinate[]` (one part = one point).
 */
export class MultiPointHitTestStrategy implements HitTestStrategy {
  readonly geometryType: FeatureType = 'MultiPoint';

  test(feature: Feature, coordinate: Coordinate, toleranceLngLat: number): boolean {
    const parts = coordinatesOf(feature) as Coordinate[];
    const latScale = latitudeScale(coordinate[1]);
    for (const part of parts) {
      if (localDistance(coordinate, part, latScale) <= toleranceLngLat) {
        return true;
      }
    }
    return false;
  }

  distance(feature: Feature, coordinate: Coordinate): number {
    const parts = coordinatesOf(feature) as Coordinate[];
    const latScale = latitudeScale(coordinate[1]);
    let min = Number.POSITIVE_INFINITY;
    for (const part of parts) {
      min = Math.min(min, localDistance(coordinate, part, latScale));
    }
    return min;
  }
}

/**
 * Hit testing strategy for the MultiLineString type
 *
 * The coordinates are `Coordinate[][]` (one part = one polyline).
 */
export class MultiLineStringHitTestStrategy implements HitTestStrategy {
  readonly geometryType: FeatureType = 'MultiLineString';

  test(feature: Feature, coordinate: Coordinate, toleranceLngLat: number): boolean {
    const parts = coordinatesOf(feature) as Coordinate[][];
    const latScale = latitudeScale(coordinate[1]);
    for (const part of parts) {
      if (part.length === 0) continue;
      if (localPointToPolylineDistance(coordinate, part, latScale) <= toleranceLngLat) {
        return true;
      }
    }
    return false;
  }

  distance(feature: Feature, coordinate: Coordinate): number {
    const parts = coordinatesOf(feature) as Coordinate[][];
    const latScale = latitudeScale(coordinate[1]);
    let min = Number.POSITIVE_INFINITY;
    for (const part of parts) {
      if (part.length === 0) continue;
      min = Math.min(min, localPointToPolylineDistance(coordinate, part, latScale));
    }
    return min;
  }

  testDistance(feature: Feature, coordinate: Coordinate, toleranceLngLat: number): number | null {
    const parts = coordinatesOf(feature) as Coordinate[][];
    const latScale = latitudeScale(coordinate[1]);
    let min = Number.POSITIVE_INFINITY;
    for (const part of parts) {
      if (part.length === 0) continue;
      const distance = polylineDistanceWithin(part, coordinate, toleranceLngLat, latScale);
      if (distance !== null && distance < min) {
        min = distance;
      }
    }
    return min <= toleranceLngLat ? min : null;
  }
}

/**
 * Hit testing strategy for the MultiPolygon type
 *
 * The coordinates are `Coordinate[][][]` (one part = an array of rings, where rings[0] is
 * the outer ring and the rest are inner rings).
 */
export class MultiPolygonHitTestStrategy implements HitTestStrategy {
  readonly geometryType: FeatureType = 'MultiPolygon';

  private readonly polygonStrategy = new PolygonHitTestStrategy();

  test(feature: Feature, coordinate: Coordinate, toleranceLngLat: number): boolean {
    const parts = coordinatesOf(feature) as Coordinate[][][];
    for (const rings of parts) {
      if (this.polygonStrategy.testRings(rings, coordinate, toleranceLngLat)) {
        return true;
      }
    }
    return false;
  }

  distance(feature: Feature, coordinate: Coordinate): number {
    const parts = coordinatesOf(feature) as Coordinate[][][];
    let min = Number.POSITIVE_INFINITY;
    for (const rings of parts) {
      min = Math.min(min, this.polygonStrategy.distanceToRings(rings, coordinate));
    }
    return min;
  }

  testDistance(feature: Feature, coordinate: Coordinate, toleranceLngLat: number): number | null {
    const parts = coordinatesOf(feature) as Coordinate[][][];
    let min = Number.POSITIVE_INFINITY;
    for (const rings of parts) {
      const distance = this.polygonStrategy.testDistanceRings(rings, coordinate, toleranceLngLat);
      if (distance !== null && distance < min) {
        min = distance;
      }
    }
    return min <= toleranceLngLat ? min : null;
  }
}
