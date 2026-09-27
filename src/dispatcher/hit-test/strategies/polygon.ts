// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * PolygonHitTestStrategy
 *
 * Hit testing strategy for Polygon features.
 * Distances to the edges are measured in the local frame of hit testing (local-frame.ts).
 * The inside test is unaffected by that frame (it only scales the latitude axis).
 */

import { coordinatesOf } from '../../../shared/utils/coordinates.js';
import type { Coordinate, Feature, FeatureType } from '../../../store/types.js';
import { latitudeScale, localPointToSegmentDistance } from '../local-frame.js';
import { polylineDistanceWithin } from '../segment-grid.js';
import type { HitTestStrategy } from './base.js';

/**
 * Hit testing strategy for the Polygon type
 */
export class PolygonHitTestStrategy implements HitTestStrategy {
  readonly geometryType: FeatureType = 'Polygon';

  test(feature: Feature, coordinate: Coordinate, toleranceLngLat: number): boolean {
    const rings = coordinatesOf(feature) as Coordinate[][];
    return this.testRings(rings, coordinate, toleranceLngLat);
  }

  distance(feature: Feature, coordinate: Coordinate): number {
    const rings = coordinatesOf(feature) as Coordinate[][];
    return this.distanceToRings(rings, coordinate);
  }

  testDistance(feature: Feature, coordinate: Coordinate, toleranceLngLat: number): number | null {
    const rings = coordinatesOf(feature) as Coordinate[][];
    return this.testDistanceRings(rings, coordinate, toleranceLngLat);
  }

  /**
   * Hit test and distance computation for one part, an array of rings (a single scan)
   *
   * Returns 0 when inside, the distance to the edge when outside and that distance is
   * within the tolerance, and null otherwise. Reused from the part iteration of
   * MultiPolygon.
   */
  testDistanceRings(
    rings: Coordinate[][],
    coordinate: Coordinate,
    toleranceLngLat: number,
  ): number | null {
    if (rings.length === 0) return null;

    // 1. Test for being inside the polygon (point in polygon)
    // Ray casting stays a full scan of every ring, because the index can only answer
    // "the shortest distance within the tolerance", while the inside/outside test needs
    // the total number of crossings.
    if (this.pointInPolygon(coordinate, rings)) {
      return 0;
    }

    // 2. Test the distance to the edges (per ring, a threshold switches between the full
    // scan and the index)
    const latScale = latitudeScale(coordinate[1]);
    let minDistance = Number.POSITIVE_INFINITY;
    for (const ring of rings) {
      const distance = polylineDistanceWithin(ring, coordinate, toleranceLngLat, latScale);
      if (distance !== null && distance < minDistance) {
        minDistance = distance;
      }
    }

    return minDistance <= toleranceLngLat ? minDistance : null;
  }

  /**
   * Hit test for one part, an array of rings
   *
   * Reused from the part iteration of MultiPolygon.
   */
  testRings(rings: Coordinate[][], coordinate: Coordinate, toleranceLngLat: number): boolean {
    if (rings.length === 0) return false;

    // 1. Test for being inside the polygon (point in polygon)
    if (this.pointInPolygon(coordinate, rings)) {
      return true;
    }

    // 2. Test the distance to the edges (a hit when within the tolerance)
    return this.pointToPolygonEdgeDistance(coordinate, rings) <= toleranceLngLat;
  }

  /**
   * Distance to one part, an array of rings
   *
   * Reused from the part iteration of MultiPolygon.
   */
  distanceToRings(rings: Coordinate[][], coordinate: Coordinate): number {
    if (rings.length === 0) return Number.POSITIVE_INFINITY;

    // If it is inside, the distance is 0
    if (this.pointInPolygon(coordinate, rings)) {
      return 0;
    }

    // Distance to the edges
    return this.pointToPolygonEdgeDistance(coordinate, rings);
  }

  /**
   * Point in polygon test
   *
   * true when it is contained in the outer ring and not contained in a hole
   */
  private pointInPolygon(point: Coordinate, rings: Coordinate[][]): boolean {
    const [lng, lat] = point;

    // Test against the outer ring
    if (!this.pointInRing(lng, lat, rings[0])) {
      return false;
    }

    // Test against the hole rings (false if it is inside a hole)
    for (let i = 1; i < rings.length; i++) {
      if (this.pointInRing(lng, lat, rings[i])) {
        return false;
      }
    }

    return true;
  }

  /**
   * Test for being inside a ring, using the ray casting algorithm
   */
  private pointInRing(x: number, y: number, ring: Coordinate[]): boolean {
    let inside = false;
    const n = ring.length;

    for (let i = 0, j = n - 1; i < n; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];

      const cond1 = yi > y !== yj > y;
      const cond2 = x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
      if (cond1 && cond2) {
        inside = !inside;
      }
    }

    return inside;
  }

  /**
   * Computes the shortest distance from a point to the edges of the polygon
   */
  private pointToPolygonEdgeDistance(point: Coordinate, rings: Coordinate[][]): number {
    const latScale = latitudeScale(point[1]);
    let minDistance = Number.POSITIVE_INFINITY;

    for (const ring of rings) {
      for (let i = 0; i < ring.length - 1; i++) {
        const distance = localPointToSegmentDistance(point, ring[i], ring[i + 1], latScale);
        minDistance = Math.min(minDistance, distance);
      }
    }

    return minDistance;
  }
}
