// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * HitTestStrategy
 *
 * Interface for the precise test logic of each geometry type.
 */

import type { Coordinate, Feature, FeatureType } from '../../../store/types.js';

/**
 * A vertex handle or a midpoint handle that was hit.
 */
export interface VertexHit {
  /** The id of the feature the handle belongs to */
  featureId: string;
  /** The index of the vertex in its ring or line (for a midpoint, the vertex before it) */
  vertexIndex: number;
  /** The index of the ring for a Polygon (0 = the outer ring) */
  ringIndex?: number;
  /** The position of the handle, `[lng, lat]` in degrees */
  coordinate: Coordinate;
  /** Whether it is a vertex or the midpoint of an edge */
  type: 'vertex' | 'midpoint';
}

/**
 * A feature hit by a click, with its distance from the click.
 */
export interface HitTestResult {
  /** The feature that was hit */
  feature: Feature;
  /**
   * The distance from the click to the feature, in degrees of longitude at the click latitude
   * (see {@link HitTestStrategy})
   */
  distance: number;
}

/**
 * The hit tolerances, in screen px.
 */
export interface HitTestOptions {
  /** Tolerance for the click test (pixels) */
  clickTolerance: number;
  /** Tolerance for vertex handles (pixels) */
  vertexTolerance: number;
  /** Tolerance for midpoint handles (pixels) */
  midpointTolerance: number;
}

/**
 * Default hit test options
 *
 * The only default of the click tolerance: the `clickTolerance` option of a draw instance
 * falls back to it too.
 */
export const DEFAULT_HIT_TEST_OPTIONS: HitTestOptions = {
  clickTolerance: 6,
  vertexTolerance: 8,
  midpointTolerance: 6,
};

/**
 * The precise hit test of one feature type, as registered through the `hitTest` of a
 * `FeatureTypeHandler`.
 *
 * The library first narrows the candidates with its spatial index and then calls `test` on
 * each candidate from the front; the first that returns `true` receives the click. The
 * tolerance is the click tolerance (a screen length) expressed in degrees of longitude
 * at the click latitude. It does not depend on the bearing. To compare a latitude
 * difference, divide it by cos φ of the click latitude (or multiply the tolerance by cos φ):
 * one degree of latitude is 1 / cos φ times longer on screen than one degree of longitude.
 * Distances are returned in the same unit.
 */
export interface HitTestStrategy {
  /** The feature type this strategy tests; a registration replaces the one for the type */
  readonly geometryType: FeatureType;

  /**
   * Tests whether the feature was hit
   *
   * @param feature The feature to test
   * @param coordinate The click coordinate [lng, lat]
   * @param toleranceLngLat The tolerance (degrees of longitude at the click latitude)
   * @returns true if it was hit
   */
  test(feature: Feature, coordinate: Coordinate, toleranceLngLat: number): boolean;

  /**
   * Computes the distance to the center or the nearest point of the feature
   *
   * @param feature The target feature
   * @param coordinate The reference coordinate [lng, lat]
   * @returns The distance (degrees of longitude at the reference latitude)
   */
  distance(feature: Feature, coordinate: Coordinate): number;

  /**
   * Performs the hit test and the distance computation in a single scan
   *
   * When it is equivalent to test() returning true, it returns the same distance as
   * distance(). Outside the tolerance it returns null. Strategies without an
   * implementation are substituted by test() + distance().
   *
   * @param feature The feature to test
   * @param coordinate The click coordinate [lng, lat]
   * @param toleranceLngLat The tolerance (degrees of longitude at the click latitude)
   * @returns The distance (same unit) if within the tolerance, null if outside
   */
  testDistance?(feature: Feature, coordinate: Coordinate, toleranceLngLat: number): number | null;
}

/**
 * Hit testing strategy registry
 */
export class HitTestStrategyRegistry {
  private strategies = new Map<FeatureType, HitTestStrategy>();

  /**
   * Registers a strategy
   *
   * @returns a function that cancels the registration and puts back the strategy it replaced
   *   (it does nothing once another strategy has been registered for the type)
   */
  register(strategy: HitTestStrategy): () => void {
    return registerRestoring(this.strategies, strategy.geometryType, strategy);
  }

  /**
   * Gets a strategy
   */
  get(geometryType: FeatureType): HitTestStrategy | undefined {
    return this.strategies.get(geometryType);
  }

  /**
   * Gets all registered strategies
   */
  getAll(): HitTestStrategy[] {
    return Array.from(this.strategies.values());
  }
}

/**
 * Sets a value in a registry keyed by type, and returns the function that cancels it: the
 * value it replaced comes back (a built-in strategy overridden by an extension, for example).
 * Cancelling after another value has been set for the key does nothing.
 *
 * @internal
 */
export function registerRestoring<K, V>(registry: Map<K, V>, key: K, value: V): () => void {
  const replaced = registry.get(key);
  registry.set(key, value);
  return () => {
    if (registry.get(key) !== value) return;
    if (replaced === undefined) registry.delete(key);
    else registry.set(key, replaced);
  };
}
