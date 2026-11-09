// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Features written as blocks of the Tabane format, each with the caches of its file
 *
 * The rows are written as `writeTabaneBlocks` of `@sakuzu/tabane` writes them, in the columns of
 * a feature (`columns.ts`). The triangles of the fills of the polygon rows of every row block are
 * made here, once, and kept as a cache that follows the row block in the file of its block
 * (`triangles.ts`), so that a reader copies them (`rowBlockOfTabane`). The name of a block does
 * not depend on its caches.
 *
 * A pure module: it depends on nothing outside `/table` but its error and `@sakuzu/tabane`, so it
 * runs in a Worker as well.
 */

import {
  type CoordinateDimensions,
  readTabaneBlockHead,
  type TabaneBlock,
  type TabaneCache,
  writeTabaneBlocks,
} from '@sakuzu/tabane';
import type { Position } from 'geojson';
import { drawErrorOf } from '../draw-error-of.js';
import { type RowGeometry, toRowGeometry } from '../row-geometry.js';
import { TABANE_FEATURE_COLUMNS, type TabaneFeatureRow, tabaneRowOf } from './columns.js';
import { FILL_TRIANGLES_CACHE, fillTrianglesCacheOf } from './triangles.js';

/**
 * What {@link writeTabaneFeatureBlocks} writes from: a run of features of one parent
 *
 * @experimental
 */
export interface TabaneFeatureBlocksInput {
  /** The id of the parent of the rows (the layer; the empty string for none) */
  readonly parent: string;
  /**
   * The key the rows follow: block `j` holds the rows that follow the key `head` followed by
   * `tabaneRowSuffixOf(j)`
   */
  readonly head: string;
  /**
   * The dimensions of the coordinates (those of the longest position when omitted: `xyz` for
   * three values, `xyzm` for four). The values of a position are those of the dimensions, in
   * their order
   */
  readonly dimensions?: CoordinateDimensions;
  /** The features, in their order */
  readonly rows: readonly TabaneFeatureRow[];
  /** The most rows of a row block (`TABANE_TARGET_ROWS` of `@sakuzu/tabane` when omitted) */
  readonly targetRows?: number;
  /** The most points of a row block (`TABANE_TARGET_VERTICES` when omitted) */
  readonly targetVertices?: number;
  /** The most bytes of the row blocks of a block (`TABANE_TARGET_BYTES` when omitted) */
  readonly targetBytes?: number;
}

/**
 * A block of features written, and the caches of its file
 *
 * @experimental
 */
export interface TabaneFeatureBlock {
  /** The block (its name is the SHA-256 of its content, `tabaneNameOf`) */
  readonly block: TabaneBlock;
  /**
   * The caches of its file, each after the part of its row block (none for a row block without a
   * polygon): give them to `packTabaneBlock` with the block
   */
  readonly caches: TabaneCache[];
}

/** The number of values of the longest position of a geometry */
function longestPosition(points: unknown, longest: number): number {
  if (!Array.isArray(points)) return longest;
  if (typeof points[0] === 'number') return Math.max(longest, points.length);
  let most = longest;
  for (const item of points) most = longestPosition(item, most);
  return most;
}

/** The dimensions of the longest position of the rows */
function dimensionsOf(rows: readonly TabaneFeatureRow[]): CoordinateDimensions {
  let longest = 2;
  for (const row of rows) {
    const g = row.geometry as { coordinates?: Position | Position[] } | null;
    if (g) longest = longestPosition(g.coordinates, longest);
  }
  return longest >= 4 ? 'xyzm' : longest === 3 ? 'xyz' : 'xy';
}

/** `writeTabaneBlocks`, its errors those of the library */
function writeBlocks(input: Parameters<typeof writeTabaneBlocks>[0]): TabaneBlock[] {
  try {
    return writeTabaneBlocks(input);
  } catch (error) {
    throw drawErrorOf(error);
  }
}

/**
 * Writes features as the blocks of a long run of rows (as `writeTabaneBlocks` of
 * `@sakuzu/tabane`), with the triangles of the fills of the polygons of every row block as a cache
 * of the file of its block
 *
 * @example
 * ```ts
 * const blocks = writeTabaneFeatureBlocks({ parent: 'buildings', head: 'V', rows });
 * for (const { block, caches } of blocks) {
 *   const name = await tabaneNameOf(block.content);
 *   const file = packTabaneBlock(block, compressor, caches);
 * }
 * ```
 *
 * @throws `DrawError` with the code `invalid-input` when a row cannot be written: a geometry that
 *   is not of one of the six GeoJSON types a row holds, a position of more values than the
 *   dimensions, a value that is not one
 * @experimental
 */
export function writeTabaneFeatureBlocks(input: TabaneFeatureBlocksInput): TabaneFeatureBlock[] {
  const rows = input.rows;
  const dimensions = input.dimensions ?? dimensionsOf(rows);
  const blocks = writeBlocks({
    parent: input.parent,
    head: input.head,
    dimensions,
    columns: TABANE_FEATURE_COLUMNS,
    rows: rows.map(tabaneRowOf),
    ...(input.targetRows !== undefined && { targetRows: input.targetRows }),
    ...(input.targetVertices !== undefined && { targetVertices: input.targetVertices }),
    ...(input.targetBytes !== undefined && { targetBytes: input.targetBytes }),
  });
  let at = 0;
  return blocks.map((block) => {
    const caches: TabaneCache[] = [];
    readTabaneBlockHead(block.content).rowBlocks.forEach((rowBlock, k) => {
      const geometries: (RowGeometry | null)[] = [];
      for (let r = 0; r < rowBlock.rows; r++) {
        const g = rows[at++].geometry;
        geometries.push(
          g && (g.type === 'Polygon' || g.type === 'MultiPolygon')
            ? toRowGeometry(g, dimensions)
            : null,
        );
      }
      const content = fillTrianglesCacheOf(geometries);
      if (content) caches.push({ part: k + 1, name: FILL_TRIANGLES_CACHE, content });
    });
    return { block, caches };
  });
}
