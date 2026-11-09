// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A row block of the Tabane format as a row block of the tables
 *
 * The columns of a row block read are the columns of a feature (`columns.ts`), and they are taken
 * as columns: the points of the geometry are the coordinates of its children, the types, the
 * styles and the attributes are taken as they are. What is made here is what the columns of a
 * row block leave to the reader: the ids as text (from their runs), the keys as text (the key of
 * each row of a row block that writes them, or else its head and the numbers of its rows), the
 * hashes of the ids, the flags, the bbox of every row (it depends on the system of
 * the coordinates of the reader), and the fills of the rows that draw a ring around their
 * point (they depend on the types of the reader). The fills of the polygons are copied from the
 * cache of their triangles that follows the row block in its file (`triangles.ts`) when it fits the
 * rows, and made otherwise.
 *
 * A pure module: it depends on nothing outside `/table` but its error and `@sakuzu/tabane`, so it
 * runs in a Worker as well.
 */

import {
  type CoordinateDimensions,
  type CoordinateSystem,
  copyCoordinates,
  dimsWithin,
  hashUtf8,
  idColumn,
  keyColumn,
  planarCoordinates,
  readValue,
  strideOf,
  type TabaneCache,
  type TabaneRowBlock,
  type TabaneShapeColumn,
  tabaneFlagOf,
} from '@sakuzu/tabane';
import { DrawError } from '../../shared/draw-error.js';
import { circleRowRings } from '../circle-rings.js';
import {
  polygonRanges,
  ringOffsetsOf,
  rowGeometryOfColumn,
  triangulateRow,
  WIDE_VERTICES,
} from '../row-geometry.js';
import {
  ROW_FLAG_DELETED,
  ROW_FLAG_LOCKED,
  ROW_FLAG_VISIBLE,
  type RowBlock,
  type RowBlockData,
  type TriangleCache,
} from '../row-group-types.js';
import type { RowRead, RowShape } from '../row-read-type.js';
import { type PointRowRings, rowRingsOfPoint } from '../row-rings.js';
import type { TableGeometry, TableMixedGeometry } from '../types.js';
import { featureColumnsOf, geometryTypeOf, stylesOf, typesOf } from './columns.js';
import { type CachedFills, FILL_TRIANGLES_CACHE, readFillTrianglesCache } from './triangles.js';

/**
 * The options of {@link rowBlockOfTabane}
 *
 * @experimental
 */
export interface RowBlockOfTabaneOptions {
  /**
   * The dimensions of the coordinates of the layer (those of the row block when omitted); a row block of
   * fewer dimensions gets NaN for the others, one of more is refused
   */
  readonly dimensions?: CoordinateDimensions;
  /** The system of the coordinates of the bbox (the plane when omitted) */
  readonly coordinateSystem?: CoordinateSystem;
  /** The rings the rows of some types draw around their point (the Circles when omitted) */
  readonly rings?: PointRowRings;
  /**
   * The caches that follow the row block in its file (those of its part, `TabaneBlockFile.caches`
   * whose `part` is the number of the row block plus one): the triangles of its polygons are
   * copied from the one of the triangles when it fits the rows, and made when there is none or it
   * does not fit. A cache of another name is not read
   */
  readonly caches?: readonly TabaneCache[];
}

/** The first coordinate of a row of a child of a geometry (its end is the first of the next row) */
function vertexStart(child: TableGeometry, row: number): number {
  let first = row;
  const levels = child.offsets;
  if (levels) for (let k = 0; k < levels.length; k++) first = levels[k][first];
  return first;
}

/**
 * The geometry of the shapes of a row block, its points with the coordinates of `dims`: the
 * points of each form are the coordinates of a child, the form of each row its child
 */
function geometryOf(
  column: TabaneShapeColumn | null,
  rows: number,
  dims: CoordinateDimensions,
): TableMixedGeometry {
  if (column === null) {
    return {
      type: 'Mixed',
      types: new Int8Array(rows).fill(-1),
      offsets: new Int32Array(rows),
      children: [],
    };
  }
  const from = column.dimensions;
  if (!dimsWithin(from, dims))
    throw new DrawError('invalid-input', `Tabane: coordinates of ${from} in a layer of ${dims}`);
  const stride = strideOf(dims);
  const children: TableGeometry[] = column.forms.map((form) => {
    const type = geometryTypeOf(form.name, form.depth);
    let coords = form.points;
    if (from !== dims) {
      const count = coords.length / strideOf(from);
      coords = new Float64Array(count * stride);
      copyCoordinates(form.points, from, 0, count, coords, dims, 0);
    }
    return form.offsets.length > 0
      ? { type, coords, dimensions: dims, offsets: [...form.offsets] }
      : { type, coords, dimensions: dims };
  });
  return {
    type: 'Mixed',
    types: Int8Array.from(column.formIndex),
    offsets: column.formRow,
    children,
  };
}

/**
 * A row block as a row block of the tables (for `FeatureTablesWriter.addRowBlocks`), its columns
 * taken as they are
 *
 * @throws `DrawError` with the code `invalid-input` when the row block has a dimension the layer
 *   does not, or is not one of features: a column that is not one of `TABANE_FEATURE_COLUMNS` or
 *   of another kind, a row without a type, a geometry of another name or depth, a style that is
 *   not an object
 * @experimental
 */
export function rowBlockOfTabane(
  rowBlock: TabaneRowBlock,
  options: RowBlockOfTabaneOptions = {},
): RowBlock {
  return rowBlockDataOfTabane(rowBlock, options);
}

/**
 * A row block as a row block with every column, as the tables read it
 *
 * @internal
 */
export function rowBlockDataOfTabane(
  rowBlock: TabaneRowBlock,
  options: RowBlockOfTabaneOptions = {},
): RowBlockData {
  const n = rowBlock.length;
  const columns = featureColumnsOf(rowBlock);
  const dims = options.dimensions ?? columns.geometry?.dimensions ?? 'xy';
  const system = options.coordinateSystem ?? planarCoordinates;
  const rings = options.rings ? rowRingsOfPoint(options.rings) : circleRowRings;
  const geometry = geometryOf(columns.geometry, n, dims);
  const stride = strideOf(dims);
  const { typeNames, types } = typesOf(columns.type, n);
  const { styleDictionary, styles } = stylesOf(columns.style, n);
  const properties = columns.properties;

  const ids = idColumn(rowBlock);
  const idHashes = new Uint32Array(n);
  for (let r = 0; r < n; r++) idHashes[r] = hashUtf8(ids, r);

  const flags = new Uint8Array(n);
  for (let r = 0; r < n; r++) {
    flags[r] =
      (tabaneFlagOf(columns.hidden, r) ? 0 : ROW_FLAG_VISIBLE) |
      (tabaneFlagOf(columns.locked, r) ? ROW_FLAG_LOCKED : 0) |
      (tabaneFlagOf(rowBlock.deleted, r) ? ROW_FLAG_DELETED : 0);
  }

  // The attributes a ring reads, by key
  const columnOf = new Map<string, number>();
  properties.keys.forEach((key, c) => {
    columnOf.set(key, c);
  });
  const drawsRing = typeNames.map((t) => rings.draws(t));

  const cache = options.caches?.find((c) => c.name === FILL_TRIANGLES_CACHE);
  const fills: CachedFills | null = cache
    ? readFillTrianglesCache(cache.content, n, columns.geometry)
    : null;

  const rowBounds = new Float64Array(n * 4);
  const triOffsets = new Int32Array(n + 1);
  let indices = new Uint16Array(fills ? fills.indices.length : n * 8);
  let narrow = 0;
  const wideRows: number[] = [];
  const wideOffsets: number[] = [0];
  const wideIndices: number[] = [];
  let vertexCount = 0;
  const putIndices = (
    row: number,
    source: ArrayLike<number>,
    from: number,
    to: number,
    vertices: number,
  ) => {
    if (vertices >= WIDE_VERTICES) {
      wideRows.push(row);
      for (let k = from; k < to; k++) wideIndices.push(source[k]);
      wideOffsets.push(wideIndices.length);
      return;
    }
    if (narrow + (to - from) > indices.length) {
      // An empty array (a block whose fills hold no triangle) grows too
      let size = Math.max(64, indices.length * 2);
      while (size < narrow + (to - from)) size *= 2;
      const next = new Uint16Array(size);
      next.set(indices.subarray(0, narrow));
      indices = next;
    }
    for (let k = from; k < to; k++) indices[narrow++] = source[k];
  };

  for (let r = 0; r < n; r++) {
    const c = geometry.types[r];
    if (c < 0) {
      rowBounds.fill(Number.NaN, r * 4, r * 4 + 4);
      triOffsets[r + 1] = narrow;
      continue;
    }
    const child = geometry.children[c];
    const at = geometry.offsets[r];
    const first = vertexStart(child, at);
    const end = vertexStart(child, at + 1);
    const type = typeNames[types[r]];
    if (child.type === 'Point' && drawsRing[types[r]]) {
      const ring = rings.ringOf({
        handle: -1,
        type,
        value: (key) => {
          const k = columnOf.get(key);
          return k === undefined ? undefined : readValue(properties.columns[k], r);
        },
        shape: (): RowShape => ({ column: { ...child, stride, offsets: child.offsets ?? [] }, at }),
      } satisfies RowRead);
      vertexCount += ring ? ring.length / 2 : 1;
      if (ring) {
        system.rowBox(ring, 2, 0, ring.length / 2, rowBounds, r * 4);
        const made = triangulateRow(ring, new Int32Array([0, ring.length / 2]), [[0, 1]], 2);
        putIndices(r, made.indices, 0, made.indices.length, made.vertices);
      } else {
        system.rowBox(child.coords, stride, first, end, rowBounds, r * 4);
      }
      triOffsets[r + 1] = narrow;
      continue;
    }
    vertexCount += end - first;
    system.rowBox(child.coords, stride, first, end, rowBounds, r * 4);
    if (child.type === 'Polygon' || child.type === 'MultiPolygon') {
      if (fills) {
        putIndices(r, fills.indices, fills.offsets[r], fills.offsets[r + 1], fills.vertices[r]);
      } else {
        const g = rowGeometryOfColumn(child, at, dims);
        const made = triangulateRow(g.coords, ringOffsetsOf(g), polygonRanges(g), g.stride);
        putIndices(r, made.indices, 0, made.indices.length, made.vertices);
      }
    }
    triOffsets[r + 1] = narrow;
  }
  const triangles: TriangleCache = {
    offsets: triOffsets,
    indices: indices.slice(0, narrow),
    wideRows: Int32Array.from(wideRows),
    wideOffsets: Int32Array.from(wideOffsets),
    wideIndices: Uint32Array.from(wideIndices),
  };

  return {
    length: n,
    handles: new Int32Array(n).fill(-1),
    ids,
    idHashes,
    types,
    typeNames,
    geometry,
    itemKeys: keyColumn(rowBlock),
    memberKeys: { offsets: new Int32Array(n + 1), bytes: new Uint8Array(0) },
    groups: new Int32Array(n).fill(-1),
    flags,
    styles,
    styleDictionary,
    properties,
    rowBounds,
    triangles,
    vertexCount,
  };
}
