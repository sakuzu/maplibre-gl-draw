// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * CircleHitTestStrategy
 *
 * Hit testing strategy for Circle features.
 * It tests whether the distance from the center is within the radius.
 */

import type { Coordinate, Feature, FeatureType } from '../../../store/types.js';
import type { HitTestStrategy } from './base.js';
import { circleShapeTest, shapeOfFeature } from './shape-tests.js';

/**
 * Hit testing strategy for the Circle type
 */
export class CircleHitTestStrategy implements HitTestStrategy {
  readonly geometryType: FeatureType = 'Circle';

  test(feature: Feature, coordinate: Coordinate, toleranceLngLat: number): boolean {
    return circleShapeTest.testShape(shapeOfFeature(feature), coordinate, toleranceLngLat);
  }

  distance(feature: Feature, coordinate: Coordinate): number {
    return circleShapeTest.distanceShape(shapeOfFeature(feature), coordinate);
  }
}
