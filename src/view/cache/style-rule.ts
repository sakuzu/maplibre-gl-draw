// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * StyleRuleCache
 *
 * Caches the result (the color) of evaluating a layer's style rule, keyed by feature ID.
 * It keeps rule evaluation from running every frame even with features on the order of
 * ten thousand.
 *
 * One cache belongs to one draw instance (the render scope of its CustomLayer), so two
 * instances holding a feature with the same id never share an evaluation.
 *
 * There are two paths for invalidating the cache.
 *
 * - The Store's subscribe (CustomLayer): deletes the corresponding entry when a feature is
 *   updated or deleted, and clears the whole cache when the layer's styleRule changes
 * - Rule identity check: each entry keeps the rule used at evaluation time, and when the
 *   reference of the passed rule differs the cache is not used and the rule is evaluated
 *   again. This is a safeguard so that stale colors are not returned on paths without a
 *   subscription (tests, the rendering of datasets)
 */

import type { Feature, StyleRule } from '../../store/types.js';
import { evaluateStyleRule } from '../style-rule.js';

/** A cache entry (the rule used for the evaluation and the resulting color) */
interface StyleRuleCacheEntry {
  rule: StyleRule;
  color: string;
}

/**
 * StyleRuleCache
 *
 * Caches the result of evaluating a rule (the color), keyed by feature ID.
 *
 * @internal
 */
export class StyleRuleCache {
  private cache: Map<string, StyleRuleCacheEntry> = new Map();

  /** Number of cache hits (for statistics) */
  private hits = 0;
  /** Number of cache misses (for statistics) */
  private misses = 0;

  /**
   * Resolves the rule color to apply to a feature (the result is cached)
   *
   * When there is no rule, null is returned without evaluating or caching anything.
   *
   * @param feature The target feature
   * @param rule The layer's style rule
   * @returns The rule color (in #RRGGBB form). null when there is no rule
   */
  resolve(feature: Feature, rule: StyleRule | undefined): string | null {
    if (!rule) return null;

    const entry = this.cache.get(feature.id);
    if (entry && entry.rule === rule) {
      this.hits++;
      return entry.color;
    }

    this.misses++;
    const color = evaluateStyleRule(rule, feature.properties);
    this.cache.set(feature.id, { rule, color });
    return color;
  }

  /**
   * Deletes the cache entry of a specific feature
   */
  delete(featureId: string): void {
    this.cache.delete(featureId);
  }

  /**
   * Deletes the cache entries of several features
   */
  deleteMany(featureIds: string[]): void {
    for (const id of featureIds) {
      this.cache.delete(id);
    }
  }

  /**
   * Clears the cache
   */
  clear(): void {
    this.cache.clear();
    this.hits = 0;
    this.misses = 0;
  }

  /**
   * Gets the cache statistics
   */
  getStats(): { size: number; hits: number; misses: number; hitRate: number } {
    const total = this.hits + this.misses;
    return {
      size: this.cache.size,
      hits: this.hits,
      misses: this.misses,
      hitRate: total > 0 ? this.hits / total : 0,
    };
  }

  /**
   * Resets the statistics
   */
  resetStats(): void {
    this.hits = 0;
    this.misses = 0;
  }
}
