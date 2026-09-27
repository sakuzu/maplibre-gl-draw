// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * BoxSelectionStrategy
 *
 * Intersection test strategy interface for box selection.
 * Like HitTestStrategy, it defines the test logic per Feature type.
 * Tests for custom types can be added through FeatureTypeHandler.
 */

import type { BoundingBox, Feature, FeatureType } from '../../store/types.js';
import { registerRestoring } from './strategies/base.js';

/**
 * The test of one feature type against the rectangle of a box selection in select mode, as
 * registered through the `boxSelection` of a `FeatureTypeHandler`. A box that crosses the
 * ±180 degree meridian is tested as two rectangles.
 *
 * @example
 * ```ts
 * import type { BoxSelectionStrategy } from '@sakuzu/maplibre-gl-draw';
 *
 * const markerBoxSelection: BoxSelectionStrategy = {
 *   featureType: 'Marker',
 *   intersects(feature, rect) {
 *     const [lng, lat] = feature.coordinates as [number, number];
 *     return lng >= rect.minX && lng <= rect.maxX && lat >= rect.minY && lat <= rect.maxY;
 *   },
 * };
 * ```
 */
export interface BoxSelectionStrategy {
  /** The target feature type */
  readonly featureType: FeatureType;

  /**
   * Tests whether the Feature intersects the selection box
   *
   * @param feature The feature to test
   * @param rect The selection box in degrees
   * @returns `true` if it intersects (the feature is then selected)
   */
  intersects(feature: Feature, rect: BoundingBox): boolean;
}

/**
 * The registry of {@link BoxSelectionStrategy} by feature type; one strategy per type.
 */
export class BoxSelectionStrategyRegistry {
  private strategies = new Map<FeatureType, BoxSelectionStrategy>();

  /**
   * Registers a strategy
   *
   * @returns a function that cancels the registration and puts back the strategy it replaced
   *   (it does nothing once another strategy has been registered for the type)
   */
  register(strategy: BoxSelectionStrategy): () => void {
    return registerRestoring(this.strategies, strategy.featureType, strategy);
  }

  /**
   * Returns the strategy of a type, or `undefined` when none is registered
   */
  get(featureType: FeatureType): BoxSelectionStrategy | undefined {
    return this.strategies.get(featureType);
  }

  /**
   * Returns every registered strategy, in registration order
   */
  getAll(): BoxSelectionStrategy[] {
    return Array.from(this.strategies.values());
  }
}
