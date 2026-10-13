// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * PolygonHitTestStrategy
 *
 * Hit testing strategy for Polygon features.
 * Distances to the edges are measured in the local frame of hit testing (local-frame.ts).
 * The inside test is unaffected by that frame (it only scales the latitude axis).
 */

import { CoordinateRun } from '../../../shared/math/position-runs.js';
import type { Coordinate, Feature, FeatureType } from '../../../store/types.js';
import type { HitTestStrategy } from './base.js';
import {
  distanceToRings,
  polygonsShapeTest,
  shapeOfFeature,
  testDistanceRings,
  testRings,
} from './shape-tests.js';

/**
 * Hit testing strategy for the Polygon type
 */
export class PolygonHitTestStrategy implements HitTestStrategy {
  readonly geometryType: FeatureType = 'Polygon';

  test(feature: Feature, coordinate: Coordinate, toleranceLngLat: number): boolean {
    return polygonsShapeTest.testShape(shapeOfFeature(feature), coordinate, toleranceLngLat);
  }

  distance(feature: Feature, coordinate: Coordinate): number {
    return polygonsShapeTest.distanceShape(shapeOfFeature(feature), coordinate);
  }

  testDistance(feature: Feature, coordinate: Coordinate, toleranceLngLat: number): number | null {
    return polygonsShapeTest.testDistanceShape(
      shapeOfFeature(feature),
      coordinate,
      toleranceLngLat,
    );
  }

  /**
   * Hit test and distance computation for one part, an array of rings (a single scan)
   *
   * Returns 0 when inside, the distance to the edge when outside and that distance is
   * within the tolerance, and null otherwise.
   */
  testDistanceRings(
    rings: Coordinate[][],
    coordinate: Coordinate,
    toleranceLngLat: number,
  ): number | null {
    return testDistanceRings(runsOf(rings), coordinate, toleranceLngLat);
  }

  /** Hit test for one part, an array of rings */
  testRings(rings: Coordinate[][], coordinate: Coordinate, toleranceLngLat: number): boolean {
    return testRings(runsOf(rings), coordinate, toleranceLngLat);
  }

  /** Distance to one part, an array of rings */
  distanceToRings(rings: Coordinate[][], coordinate: Coordinate): number {
    return distanceToRings(runsOf(rings), coordinate);
  }
}

/** The rings of a polygon as runs of their positions */
function runsOf(rings: Coordinate[][]): CoordinateRun[] {
  return rings.map((ring) => new CoordinateRun(ring));
}
