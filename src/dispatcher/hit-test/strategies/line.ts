// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * LineHitTestStrategy
 *
 * Hit testing strategy for LineString features.
 * Distances are measured in the local frame of hit testing (local-frame.ts).
 */

import type { Coordinate, Feature, FeatureType } from '../../../store/types.js';
import type { HitTestStrategy } from './base.js';
import { linesShapeTest, shapeOfFeature } from './shape-tests.js';

/**
 * Hit testing strategy for the LineString type
 */
export class LineHitTestStrategy implements HitTestStrategy {
  readonly geometryType: FeatureType = 'LineString';

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
