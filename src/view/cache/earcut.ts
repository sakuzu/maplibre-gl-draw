// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * EarcutCache
 *
 * Caches the results of polygon triangulation (earcut).
 * The triangulation results are stored keyed by feature ID + part index (for MultiPolygon).
 *
 * One cache belongs to one draw instance (the render scope of its CustomLayer), so two
 * instances holding a feature with the same id never share triangles.
 *
 * Cache invalidation happens through the Store's subscribe:
 * - Delete the cache entry when a feature is updated
 * - Delete the cache entry when a feature is deleted
 */

/**
 * Contents of a cache entry
 *
 * signature is a fingerprint of the geometry (optional). The Store rendering path does not
 * use the fingerprint because it has a subscription that deletes the entry when a feature
 * is updated. On the dataset path the feature IDs are rebuilt on every
 * fetch (the row number in `<data ID>#<row number>` shifts with the fetched range), so the
 * ID alone can pick up the cache entry of a different feature. Therefore a fingerprint
 * built from the geometry is attached and compared.
 */
interface EarcutCacheEntry {
  indices: number[];
  signature: string | undefined;
}

/**
 * EarcutCache
 *
 * Caches earcut results keyed by feature ID + part index
 *
 * @internal
 */
export class EarcutCache {
  /**
   * Holds, for each feature ID, a map of part index -> earcut result.
   *
   * Because a MultiPolygon has several polygon parts in a single feature,
   * the cache key includes the part index as well. Invalidation is still done
   * per feature ID, deleting all the parts of that feature.
   */
  private cache: Map<string, Map<number, EarcutCacheEntry>> = new Map();

  /** Number of cache hits (for statistics) */
  private hits = 0;
  /** Number of cache misses (for statistics) */
  private misses = 0;

  /**
   * Gets an earcut result from the cache
   *
   * @param featureId Feature ID
   * @param partIndex Part index (0 for a single polygon)
   * @param signature Fingerprint of the geometry (when omitted, only entries recorded
   *   without a fingerprint are matched)
   * @returns The index array on a cache hit, null on a miss
   */
  get(featureId: string, partIndex = 0, signature?: string): number[] | null {
    const entry = this.cache.get(featureId)?.get(partIndex);
    if (entry && entry.signature === signature) {
      this.hits++;
      return entry.indices;
    }
    this.misses++;
    return null;
  }

  /**
   * Stores an earcut result in the cache
   *
   * @param featureId Feature ID
   * @param indices Earcut result
   * @param partIndex Part index (0 for a single polygon)
   * @param signature Fingerprint of the geometry (when omitted, the entry is recorded
   *   without a fingerprint)
   */
  set(featureId: string, indices: number[], partIndex = 0, signature?: string): void {
    let parts = this.cache.get(featureId);
    if (!parts) {
      parts = new Map();
      this.cache.set(featureId, parts);
    }
    parts.set(partIndex, { indices, signature });
  }

  /**
   * Deletes the cache entries of a specific feature (all parts)
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
   *
   * size is the number of parts held (a MultiPolygon counts as several within one feature).
   */
  getStats(): { size: number; hits: number; misses: number; hitRate: number } {
    const total = this.hits + this.misses;
    let size = 0;
    for (const parts of this.cache.values()) {
      size += parts.size;
    }
    return {
      size,
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
