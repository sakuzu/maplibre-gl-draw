// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Spatial index of the datasets
 *
 * A packed R-tree over the bboxes of the rows (`packed-rtree.ts`). The contents of a dataset
 * are replaced as a whole, so the tree is built once per replacement, and the search results are
 * put back into the draw order (the order of the rows) before they are returned.
 */

import type { BoundingBox } from '../shared/types/model.js';
import { buildPackedRTree, type PackedRTree, searchPackedRTree } from '../table/packed-rtree.js';

/**
 * Spatial index of a dataset
 *
 * @internal
 */
export class DisplaySpatialIndex {
  private tree: PackedRTree | null = null;

  /** Number of rows stored */
  get size(): number {
    return this.tree?.numItems ?? 0;
  }

  /**
   * Builds the tree over the bboxes of the rows (the existing contents are discarded)
   *
   * @param bounds `[minX, minY, maxX, maxY]` per row (a NaN row is left out)
   */
  load(bounds: Float64Array): void {
    this.tree = buildPackedRTree(bounds);
  }

  /** Takes a tree built elsewhere (in a Worker, for example) */
  adopt(tree: PackedRTree): void {
    this.tree = tree;
  }

  /**
   * Returns the rows whose bbox intersects the bounding box, in draw order
   */
  search(bounds: BoundingBox): number[] {
    if (!this.tree) return [];
    const rows = searchPackedRTree(this.tree, bounds.minX, bounds.minY, bounds.maxX, bounds.maxY);
    rows.sort((a, b) => a - b);
    return rows;
  }

  /**
   * Returns the rows whose bbox intersects the bounding box and that `keep` accepts, in draw order
   *
   * The rows are filtered before they are sorted, so a filter that drops most of what is in the
   * range keeps the sort as small as what is kept.
   */
  searchWhere(bounds: BoundingBox, keep: (row: number) => boolean): Int32Array {
    if (!this.tree) return new Int32Array(0);
    const hits = searchPackedRTree(this.tree, bounds.minX, bounds.minY, bounds.maxX, bounds.maxY);
    const rows = new Int32Array(hits.length);
    let count = 0;
    for (let i = 0; i < hits.length; i++) {
      const row = hits[i];
      if (keep(row)) rows[count++] = row;
    }
    const kept = count === rows.length ? rows : rows.slice(0, count);
    // A typed array sorts its numbers by value
    return kept.sort();
  }

  /**
   * Empties the index
   */
  clear(): void {
    this.tree = null;
  }
}
