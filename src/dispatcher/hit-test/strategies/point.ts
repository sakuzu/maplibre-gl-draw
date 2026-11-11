// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * PointHitTestStrategy
 *
 * Hit testing strategy for Point features.
 * Distances are measured in the local frame of hit testing (local-frame.ts).
 */

import type { StoredFeature as Feature, FeatureType } from '../../../api/model.js';
import type { Feature as StoredFeature } from '../../../store/types.js';
import { pointsShapeTest, shapeOfFeature } from './shape-tests.js';

/**
 * The built-in hit test of `Point` features: hit within the tolerance of the position.
 *
 * The distance is measured on local axes around the click, where a degree of longitude is
 * scaled by the cosine of the latitude. A feature type drawn as a point can reuse it, or
 * extend it to widen the hit area. The engine uses it as the hit test of its points.
 */
export class PointHitTestStrategy {
  /** The feature type, `'Point'` */
  readonly geometryType: FeatureType = 'Point';

  /** Whether the feature is within `toleranceLngLat` degrees of the coordinate */
  test(feature: Feature, coordinate: [number, number], toleranceLngLat: number): boolean {
    return pointsShapeTest.testShape(
      shapeOfFeature(feature as StoredFeature),
      coordinate,
      toleranceLngLat,
    );
  }

  /** The distance from the coordinate to the feature, in degrees of the local axes */
  distance(feature: Feature, coordinate: [number, number]): number {
    return pointsShapeTest.distanceShape(shapeOfFeature(feature as StoredFeature), coordinate);
  }
}
