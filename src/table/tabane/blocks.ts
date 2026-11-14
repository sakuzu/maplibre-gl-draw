// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Features written as blocks of the Tabane format, each with the caches of its file
 *
 * The rows are written as `writeBlocks` of `@sakuzu/tabane` writes them, in the columns of
 * a feature (`columns.ts`). The triangles of the fills of the polygon rows of every page are
 * made here, once, and kept as a cache that follows the page in the file of its block
 * (`triangles.ts`), so that a reader copies them (`toPage`). The name of a block does
 * not depend on its caches.
 *
 * A pure module: it depends on nothing outside `/table` but its error and `@sakuzu/tabane`, so it
 * runs in a Worker as well.
 */

import {
  type CoordinateDimensions,
  readBlockHeader,
  strideOf,
  type TabaneBlock,
  type TabaneCache,
  type TabaneRow,
  type TabaneShape,
  writeBlocks,
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
   * `rowSuffixOf(j)`
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
  /** The most rows of a page (`TABANE_TARGET_ROWS` of `@sakuzu/tabane` when omitted) */
  readonly targetRows?: number;
  /** The most points of a page (`TABANE_TARGET_VERTICES` when omitted) */
  readonly targetVertices?: number;
  /** The most bytes of the pages of a block (`TABANE_TARGET_BYTES` when omitted) */
  readonly targetBytes?: number;
}

/**
 * A block of features written, and the caches of its file
 *
 * @experimental
 */
export interface TabaneFeatureBlock {
  /** The block (its name is the SHA-256 of its content, `digestOf`) */
  readonly block: TabaneBlock;
  /**
   * The caches of its file, each after the part of its page (none for a page without a
   * polygon): give them to `packBlock` with the block
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

/**
 * A row in the dimensions of its layer: Tabane takes the dimensions of each row from its user, and
 * a position of fewer values gets NaN for the others, at its end
 */
function inDimensions(row: TabaneRow, dimensions: CoordinateDimensions): TabaneRow {
  const shape = row.values?.geometry as TabaneShape | undefined;
  if (dimensions === 'xy' || shape === undefined) return row;
  const stride = strideOf(dimensions);
  const pad = (v: unknown, level: number): unknown => {
    if (!Array.isArray(v)) return v;
    if (level < shape.depth) return v.map((item) => pad(item, level + 1));
    if (v.length >= stride) return v;
    return [...v, ...new Array(stride - v.length).fill(Number.NaN)];
  };
  const points = pad(shape.points, 0);
  return {
    ...row,
    dimensions,
    values: { ...row.values, geometry: { ...shape, points: points as TabaneShape['points'] } },
  };
}

/** `writeBlocks` of `@sakuzu/tabane`, its errors those of the library */
function writeBlocksWithDrawErrors(input: Parameters<typeof writeBlocks>[0]): TabaneBlock[] {
  try {
    return writeBlocks(input);
  } catch (error) {
    throw drawErrorOf(error);
  }
}

/**
 * Writes features as the blocks of a long run of rows (as `writeBlocks` of
 * `@sakuzu/tabane`), with the triangles of the fills of the polygons of every page as a cache
 * of the file of its block
 *
 * @example
 * ```ts
 * const blocks = writeTabaneFeatureBlocks({ parent: 'buildings', head: 'V', rows });
 * for (const { block, caches } of blocks) {
 *   const name = await digestOf(block.content);
 *   const file = packBlock(block, compressor, caches);
 * }
 * ```
 *
 * @throws `DrawError` with the code `invalidInput` when a row cannot be written: a geometry that
 *   is not of one of the six GeoJSON types a row holds, a position of more values than the
 *   dimensions, a value that is not one
 * @experimental
 */
export function writeTabaneFeatureBlocks(input: TabaneFeatureBlocksInput): TabaneFeatureBlock[] {
  const rows = input.rows;
  const dimensions = input.dimensions ?? dimensionsOf(rows);
  const blocks = writeBlocksWithDrawErrors({
    parent: input.parent,
    head: input.head,
    columns: TABANE_FEATURE_COLUMNS,
    rows: rows.map((row) => inDimensions(tabaneRowOf(row), dimensions)),
    ...(input.targetRows !== undefined && { targetRows: input.targetRows }),
    ...(input.targetVertices !== undefined && { targetVertices: input.targetVertices }),
    ...(input.targetBytes !== undefined && { targetBytes: input.targetBytes }),
  });
  let at = 0;
  return blocks.map((block) => {
    const caches: TabaneCache[] = [];
    readBlockHeader(block.content).pages.forEach((rowBlock, k) => {
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
