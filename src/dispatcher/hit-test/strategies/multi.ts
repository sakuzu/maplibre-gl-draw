// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Hit testing strategies for the Multi geometries
 *
 * MultiPoint / MultiLineString / MultiPolygon are tested as "a hit if any part is hit"
 * and "the distance is the minimum over the parts". The tests are the ones of the single
 * geometries, run on each part (shape-tests.ts). Distances are measured in the local frame of
 * hit testing (local-frame.ts).
 */

import type { Coordinate, Feature, FeatureType } from '../../../store/types.js';
import type { HitTestStrategy } from './base.js';
import {
  linesShapeTest,
  pointsShapeTest,
  polygonsShapeTest,
  shapeOfFeature,
} from './shape-tests.js';

/**
 * Hit testing strategy for the MultiPoint type
 *
 * The coordinates are `Coordinate[]` (one part = one point).
 */
export class MultiPointHitTestStrategy implements HitTestStrategy {
  readonly geometryType: FeatureType = 'MultiPoint';

  test(feature: Feature, coordinate: Coordinate, toleranceLngLat: number): boolean {
    return pointsShapeTest.testShape(shapeOfFeature(feature), coordinate, toleranceLngLat);
  }

  distance(feature: Feature, coordinate: Coordinate): number {
    return pointsShapeTest.distanceShape(shapeOfFeature(feature), coordinate);
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
    return linesShapeTest.testShape(shapeOfFeature(feature), coordinate, toleranceLngLat);
  }

  distance(feature: Feature, coordinate: Coordinate): number {
    return linesShapeTest.distanceShape(shapeOfFeature(feature), coordinate);
  }

  testDistance(feature: Feature, coordinate: Coordinate, toleranceLngLat: number): number | null {
    return linesShapeTest.testDistanceShape(shapeOfFeature(feature), coordinate, toleranceLngLat);
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
}
