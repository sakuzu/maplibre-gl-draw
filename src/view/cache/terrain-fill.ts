// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Cache for terrain tessellation
 *
 * Polygon fills are subdivided on a grid after earcut (terrain/tessellation.ts).
 * Immediate mode redoes the same subdivision every frame, so the results are kept.
 *
 * Invalidation rides on the same subscription as the earcut cache (the store.subscribe in
 * custom-layer). In addition, when the subdivision step changes (crossing a zoom level)
 * the generation changes, and records from a different generation do not match.
 */

/** Contents of a cache entry */
interface TerrainFillEntry {
  flatCoords: number[];
  indices: number[];
  /**
   * Fingerprint of the subdivision (the configuration of steps that produced this result)
   *
   * Back when it was held as a sequential generation number, everything went stale as soon
   * as the subdivision range moved, and even features that stayed entirely inside the range
   * were subdivided again (several hundred milliseconds on every pan). With a fingerprint
   * the result can be reused as long as "the tile configuration and coarsening covering
   * that feature" is the same.
   */
  signature: string;
  /** The original triangulation index array (only the reference is kept, to check identity) */
  source: readonly number[];
  /**
   * The grid spacing actually used for the subdivision (in Mercator units)
   *
   * The outline drifts apart unless it is subdivided on the same grid as the fill. The step
   * of the fill becomes coarser depending on the budget, so unless it is remembered along
   * with the result, the outline would sit on a different grid only when the cache is hit.
   */
  grid: number;
}

/**
 * Result cache for terrain tessellation
 */
export class TerrainFillCache {
  private cache: Map<string, Map<number, TerrainFillEntry>> = new Map();

  /**
   * Gets a subdivision result (null when the fingerprint or the source data differs)
   */
  get(
    featureId: string,
    partIndex: number,
    signature: string,
    source: readonly number[],
  ): { flatCoords: number[]; indices: number[]; grid: number } | null {
    const entry = this.cache.get(featureId)?.get(partIndex);
    if (!entry || entry.signature !== signature || entry.source !== source) return null;
    return { flatCoords: entry.flatCoords, indices: entry.indices, grid: entry.grid };
  }

  /**
   * Stores a subdivision result
   */
  set(
    featureId: string,
    partIndex: number,
    signature: string,
    source: readonly number[],
    flatCoords: number[],
    indices: number[],
    grid: number,
  ): void {
    let parts = this.cache.get(featureId);
    if (!parts) {
      parts = new Map();
      this.cache.set(featureId, parts);
    }
    parts.set(partIndex, { flatCoords, indices, signature, source, grid });
  }

  /**
   * Deletes the records of a specific feature (all parts)
   */
  delete(featureId: string): void {
    this.cache.delete(featureId);
  }

  /**
   * Discards everything
   */
  clear(): void {
    this.cache.clear();
  }

  /**
   * The number of parts held
   */
  size(): number {
    let size = 0;
    for (const parts of this.cache.values()) size += parts.size;
    return size;
  }
}

// No global instance is placed here. A subdivision result depends on "the generation and
// step of that instance", so its owner is the TerrainContext of each draw instance
// (`view/terrain/context.ts`). Back when it was shared by feature id, there was a defect
// where triangles subdivided with the step of another instance could be picked up.
