// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The triangles of the fills of the rows, as a cache of the rows the library declares
 * (`FILL_TRIANGLES`)
 *
 * The fill of a polygon row, and of a row that draws a ring around its point (a Circle), is drawn
 * from triangles made with earcut (`triangulateRow`). The library declares them as a cache of the
 * rows of its tables, so that the tables make them where a row is built or written, and copy them
 * where it does not change.
 *
 * The triangles of a row are indices into the vertices of its fill: the rings of each of its
 * polygons in turn, without the closing coordinate of a ring, leaving out a ring of fewer than 3
 * coordinates (and a polygon whose outer ring has fewer than 3). They are held in pairs, as the
 * fill draws them in strips of 4 vertices: 4 indices `(a, b, c, d)` per pair, the triangles
 * `(a, b, c)` and `(c, b, d)` sharing the edge `b, c`, and a triangle without a partner as
 * `(a, b, c, c)`. The pairs of a polygon of the row come before the pairs of the next. A row of
 * fewer than 65,536 such vertices keeps its indices in 16 bits; a larger one in 32.
 *
 * A pure module: it runs in a Worker as well.
 */

import type { RowCache, RowRead, RowShape } from '@sakuzu/kasane';
import { polygonRingRuns } from './polygon-rings.js';
import { triangulateRow, WIDE_VERTICES } from './row-geometry.js';
import { FILL_TRIANGLES_CACHE } from './tabane/triangles.js';

/** The triangles of a row without a fill */
const NO_TRIANGLES: readonly number[] = [];

/** The rings of the fill of a ring drawn around a point: the ring itself */
const RING_POLYGONS: ReadonlyArray<readonly [number, number]> = [[0, 1]];

/** The runs of the rings of a polygon, reused by the counts of the vertices of a fill */
const RUNS: number[] = [];

/**
 * The coordinates of the polygons of a shape of a polygon form: the offsets from a ring to its
 * first coordinate, and the rings of each polygon (null for a shape of another form)
 */
function polygonsOf(
  shape: RowShape,
): { rings: Int32Array; polygons: Array<[number, number]> } | null {
  const { column, at } = shape;
  const o = column.offsets;
  if (column.type === 'Polygon') return { rings: o[1], polygons: [[o[0][at], o[0][at + 1]]] };
  if (column.type !== 'MultiPolygon') return null;
  const polygons: Array<[number, number]> = [];
  for (let p = o[0][at]; p < o[0][at + 1]; p++) polygons.push([o[1][p], o[1][p + 1]]);
  return { rings: o[2], polygons };
}

/**
 * The number of vertices of the fill of a row: the rings it draws of its polygons, or of the ring
 * it draws around its point (0 for a row without a fill)
 *
 * @internal
 */
export function fillVerticesOf(row: RowRead, ring: Float64Array | null): number {
  if (ring) {
    RUNS.length = 0;
    return polygonRingRuns(ring, 2, Int32Array.of(0, ring.length / 2), 0, 1, RUNS);
  }
  const shape = row.shape();
  const fill = shape ? polygonsOf(shape) : null;
  if (!shape || !fill) return 0;
  let count = 0;
  for (const [first, end] of fill.polygons) {
    RUNS.length = 0;
    count += polygonRingRuns(
      shape.column.flatCoordinates,
      shape.column.stride,
      fill.rings,
      first,
      end,
      RUNS,
    );
  }
  return count;
}

/**
 * The triangles of the fill of a row, in pairs (none for a row without a fill): of the ring it
 * draws around its point, or of its polygons. A fill of 65,536 vertices or more gives its indices
 * in 32 bits
 *
 * @internal
 */
export function fillTrianglesOf(row: RowRead, ring: Float64Array | null): ArrayLike<number> {
  let made: { indices: number[]; vertices: number };
  if (ring) {
    made = triangulateRow(ring, Int32Array.of(0, ring.length / 2), RING_POLYGONS, 2);
  } else {
    const shape = row.shape();
    const fill = shape ? polygonsOf(shape) : null;
    if (!shape || !fill) return NO_TRIANGLES;
    made = triangulateRow(
      shape.column.flatCoordinates,
      fill.rings,
      fill.polygons,
      shape.column.stride,
    );
  }
  return made.vertices >= WIDE_VERTICES ? Uint32Array.from(made.indices) : made.indices;
}

/**
 * The triangles of the fills of the rows, a cache of the rows the library declares: its name is
 * the one of the cache of the file of a block (`FILL_TRIANGLES_CACHE`), the triangles kept with a
 * block fit a row when they are in pairs and every index is within the vertices of its fill
 *
 * @internal
 */
export const FILL_TRIANGLES: RowCache = {
  name: FILL_TRIANGLES_CACHE,
  width: 16,
  build: fillTrianglesOf,
  fits: (row, ring, numbers) => fillTrianglesFit(row, ring, numbers),
};

/**
 * Whether triangles kept of a row elsewhere fit the row (`FILL_TRIANGLES.fits`): in pairs, every
 * index within the vertices of its fill, and, when the number of vertices they were made of is
 * kept with them (the cache of the file of a block), that number is the one of the fill
 *
 * @param vertices - The number of vertices kept with the triangles (none: not compared)
 * @internal
 */
export function fillTrianglesFit(
  row: RowRead,
  ring: Float64Array | null,
  numbers: ArrayLike<number>,
  vertices?: number,
): boolean {
  if (numbers.length % 4 !== 0) return false;
  const count = fillVerticesOf(row, ring);
  if (vertices !== undefined && vertices !== count) return false;
  for (let k = 0; k < numbers.length; k++) if (numbers[k] >= count) return false;
  return true;
}

/**
 * The caches of the rows the library declares for its tables and the builders of their row
 * blocks
 *
 * @internal
 */
export const FEATURE_CACHES: readonly RowCache[] = [FILL_TRIANGLES];

/**
 * The place of the triangles of the fills in the caches of the library (`FEATURE_CACHES`)
 *
 * @internal
 */
export const FILL_TRIANGLES_AT = 0;
