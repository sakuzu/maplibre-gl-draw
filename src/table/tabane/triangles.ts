// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The triangles of the fills of the polygons of a row block, kept as a cache of its file
 *
 * A file of a block of the Tabane format can keep, after the part of each row block, caches the
 * format does not read and that its name does not depend on. The triangles of the fills of the
 * polygon rows (`triangulateRow`) are kept in one, so that a reader copies them rather than making
 * them again with earcut. The name of the cache says what it holds and how they were made: a
 * change to how the triangles are made (earcut, how they are paired, which rings are drawn) is a
 * new version of the name, and a cache of another name is not read.
 *
 * The content: the number of rows of the row block, the number of its polygon rows, then a run of
 * the number of vertices and of pairs of each polygon row in turn, and a run of the indices of
 * their pairs, 4 per pair (each a varint of `@sakuzu/tabane`). A reader checks it against the rows
 * it reads (the number of rows and of polygon rows, the vertices of each fill, every index within
 * them) and makes the triangles again when it does not fit.
 *
 * A pure module: it depends on nothing outside `/table` but `@sakuzu/tabane`, so it runs in a
 * Worker as well.
 */

import { ByteSink, ByteSource, strideOf, type TabaneShapeColumn } from '@sakuzu/tabane';
import { polygonRingRuns } from '../polygon-rings.js';
import { polygonRanges, type RowGeometry, ringOffsetsOf, triangulateRow } from '../row-geometry.js';

/**
 * The name of the cache of the triangles of the fills of the polygon rows of a row block: what it
 * holds and the version of how they are made
 */
export const FILL_TRIANGLES_CACHE = 'maplibre-gl-draw:fill-triangles:1';

/**
 * The content of the cache of the triangles of the rows of a row block (null when no row is a
 * polygon: a reader then has none to make)
 *
 * @param geometries The geometry of each row (null for a row without one)
 */
export function fillTrianglesCacheOf(
  geometries: readonly (RowGeometry | null)[],
): Uint8Array | null {
  const heads = new ByteSink();
  const indices = new ByteSink();
  let polygons = 0;
  for (const g of geometries) {
    if (!g || (g.type !== 'Polygon' && g.type !== 'MultiPolygon')) continue;
    const made = triangulateRow(g.coords, ringOffsetsOf(g), polygonRanges(g), g.stride);
    heads.uint(made.vertices);
    heads.uint(made.indices.length / 4);
    for (const index of made.indices) indices.uint(index);
    polygons++;
  }
  if (polygons === 0) return null;
  const out = new ByteSink();
  out.uint(geometries.length);
  out.uint(polygons);
  out.run(heads.finish());
  out.run(indices.finish());
  return out.finish();
}

/**
 * The fills of the polygon rows of a row block read from a cache: the triangles of row `r` are
 * `indices[offsets[r]..offsets[r + 1]]`, into its `vertices[r]` vertices (-1 for a row that is
 * not a polygon)
 *
 * @internal
 */
export interface CachedFills {
  readonly vertices: Int32Array;
  readonly offsets: Int32Array;
  readonly indices: Uint32Array;
}

/** The number of vertices of the fill of row `row` of a polygon form (the rings drawn) */
function fillVertices(
  points: Float64Array,
  stride: number,
  offsets: readonly Int32Array[],
  row: number,
  runs: number[],
): number {
  let count = 0;
  if (offsets.length === 2) {
    runs.length = 0;
    count = polygonRingRuns(points, stride, offsets[1], offsets[0][row], offsets[0][row + 1], runs);
  } else {
    for (let p = offsets[0][row]; p < offsets[0][row + 1]; p++) {
      runs.length = 0;
      count += polygonRingRuns(points, stride, offsets[2], offsets[1][p], offsets[1][p + 1], runs);
    }
  }
  return count;
}

/**
 * The fills of the polygon rows of a row block, read from the content of the cache of their
 * triangles when it fits the rows: as many rows and polygon rows, the vertices of each fill those
 * of the rings it draws, every index within them, nothing left after them
 *
 * @param content The content of the cache
 * @param rows The number of rows of the row block
 * @param geometry The geometry column of the row block (null when no row has a geometry)
 * @returns The fills, or null when the cache does not fit the rows
 * @internal
 */
export function readFillTrianglesCache(
  content: Uint8Array,
  rows: number,
  geometry: TabaneShapeColumn | null,
): CachedFills | null {
  try {
    const r = new ByteSource(content);
    if (r.uint() !== rows) return null;
    const polygons = r.uint();
    const heads = new ByteSource(r.run());
    const indexRun = r.run();
    if (!r.done) return null;
    const indexSource = new ByteSource(indexRun);
    const vertices = new Int32Array(rows).fill(-1);
    const offsets = new Int32Array(rows + 1);
    // At most one index per byte
    const indices = new Uint32Array(indexRun.length);
    const stride = geometry ? strideOf(geometry.dimensions) : 2;
    const runs: number[] = [];
    let at = 0;
    let seen = 0;
    for (let row = 0; row < rows; row++) {
      const f = geometry ? geometry.formIndex[row] : -1;
      const form = f >= 0 ? (geometry as TabaneShapeColumn).forms[f] : null;
      if (form && (form.name === 'Polygon' || form.name === 'MultiPolygon')) {
        if (seen++ === polygons) return null;
        const v = heads.uint();
        const pairs = heads.uint();
        const at2 = (geometry as TabaneShapeColumn).formRow[row];
        if (v !== fillVertices(form.points, stride, form.offsets, at2, runs)) return null;
        if (at + pairs * 4 > indices.length) return null;
        vertices[row] = v;
        for (let k = 0; k < pairs * 4; k++) {
          const index = indexSource.uint();
          if (index >= v) return null;
          indices[at++] = index;
        }
      }
      offsets[row + 1] = at;
    }
    if (seen !== polygons || !heads.done || !indexSource.done) return null;
    return { vertices, offsets, indices: indices.subarray(0, at) };
  } catch {
    // Bytes that are not a cache of this form
    return null;
  }
}
