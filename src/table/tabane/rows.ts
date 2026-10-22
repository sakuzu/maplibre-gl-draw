// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A row block of the Tabane format as a row block of the tables
 *
 * The columns of a row block read are those of a row block (`RowBlock`): the geometry, the
 * types, the styles and the attributes are taken as they are. What is made here is what the
 * columns of a row block leave to the reader: the ids and the keys as text (from their runs), the
 * hashes of the ids, the flags, the bbox of every row and the spatial index (they depend on the
 * system of the coordinates of the reader), and the fills of the rows that draw a ring around
 * their point (they depend on the types of the reader). The fills of the polygons are copied
 * from the row block when it holds them, and made otherwise.
 *
 * A pure module: it depends on nothing outside `/table`, so it runs in a Worker as well.
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
  polygonRanges,
  readValue,
  ringOffsetsOf,
  rowGeometryOfColumn,
  sortKeyOf,
  strideOf,
  type TabaneRowBlock,
  type TabaneRowBlockData,
  type TableGeometry,
  type TableMixedGeometry,
  tabaneFlagOf,
  triangulateRow,
  WIDE_VERTICES,
} from '@sakuzu/tabane';
import { circleRowRings } from '../../shared/circle-rings.js';
import { DrawError } from '../../shared/draw-error.js';
import { buildPackedRTree } from '../packed-rtree.js';
import {
  ROW_FLAG_DELETED,
  ROW_FLAG_LOCKED,
  ROW_FLAG_VISIBLE,
  type RowBlock,
  type RowBlockData,
  type TriangleCache,
} from '../row-group-types.js';
import type { RowRings } from '../row-rings.js';

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
  /** The system of the coordinates of the bbox and the spatial index (the plane when omitted) */
  readonly coordinateSystem?: CoordinateSystem;
  /** The rings the rows of some types draw around their point (the Circles when omitted) */
  readonly rings?: RowRings;
}

/** The first coordinate of a row of a child of a geometry (its end is the first of the next row) */
function vertexStart(child: TableGeometry, row: number): number {
  let first = row;
  const levels = child.offsets;
  if (levels) for (let k = 0; k < levels.length; k++) first = levels[k][first];
  return first;
}

/** The geometry with the coordinates of `dims` (the same object when they are its own) */
function widen(
  geometry: TableMixedGeometry,
  from: CoordinateDimensions,
  dims: CoordinateDimensions,
) {
  if (from === dims) return geometry;
  if (!dimsWithin(from, dims))
    throw new DrawError('invalid-input', `Tabane: coordinates of ${from} in a layer of ${dims}`);
  const stride = strideOf(dims);
  const children = geometry.children.map((child) => {
    const count = child.coords.length / strideOf(from);
    const coords = new Float64Array(count * stride);
    copyCoordinates(child.coords, from, 0, count, coords, dims, 0);
    return { ...child, coords, dimensions: dims };
  });
  return { ...geometry, children };
}

/**
 * A row block as a row block of the tables (for `FeatureTablesWriter.addRowBlocks`), its columns
 * taken as they are
 *
 * @throws `DrawError` with the code `invalid-input` when the row block has a dimension the layer does
 *   not
 * @experimental
 */
export function rowBlockOfTabane(
  rowBlock: TabaneRowBlock,
  options: RowBlockOfTabaneOptions = {},
): RowBlock {
  return rowBlockDataOfTabane(rowBlock as TabaneRowBlockData, options);
}

/**
 * A row block as a row block with every column, as the tables read it
 *
 * @internal
 */
export function rowBlockDataOfTabane(
  rowBlock: TabaneRowBlockData,
  options: RowBlockOfTabaneOptions = {},
): RowBlockData {
  const n = rowBlock.length;
  const dims = options.dimensions ?? rowBlock.dimensions;
  const system = options.coordinateSystem ?? planarCoordinates;
  const rings = options.rings ?? circleRowRings;
  const geometry = widen(rowBlock.geometry, rowBlock.dimensions, dims);
  const stride = strideOf(dims);

  const ids = idColumn(rowBlock);
  const idHashes = new Uint32Array(n);
  for (let r = 0; r < n; r++) idHashes[r] = hashUtf8(ids, r);

  const flags = new Uint8Array(n);
  for (let r = 0; r < n; r++) {
    flags[r] =
      (tabaneFlagOf(rowBlock.hidden, r) ? 0 : ROW_FLAG_VISIBLE) |
      (tabaneFlagOf(rowBlock.locked, r) ? ROW_FLAG_LOCKED : 0) |
      (tabaneFlagOf(rowBlock.deleted, r) ? ROW_FLAG_DELETED : 0);
  }

  // The attributes a ring reads, by key
  const columnOf = new Map<string, number>();
  rowBlock.properties.keys.forEach((key, c) => {
    columnOf.set(key, c);
  });
  const drawsRing = rowBlock.typeNames.map((t) => rings.draws(t));

  const rowBounds = new Float64Array(n * 4);
  const fills = rowBlock.fills;
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
    const type = rowBlock.typeNames[rowBlock.types[r]];
    if (child.type === 'Point' && drawsRing[rowBlock.types[r]]) {
      const properties = rowBlock.properties;
      const ring = rings.ringOf(
        type,
        child.coords[first * stride],
        child.coords[first * stride + 1],
        (key) => {
          const k = columnOf.get(key);
          return k === undefined ? undefined : readValue(properties.columns[k], r);
        },
      );
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
    types: rowBlock.types,
    typeNames: rowBlock.typeNames,
    geometry,
    itemKeys: keyColumn(rowBlock),
    memberKeys: { offsets: new Int32Array(n + 1), bytes: new Uint8Array(0) },
    groups: new Int32Array(n).fill(-1),
    flags,
    styles: rowBlock.styles,
    styleDictionary: rowBlock.styleDictionary,
    properties: rowBlock.properties,
    rowBounds,
    triangles,
    index: buildPackedRTree(rowBounds, undefined, sortKeyOf(system)),
    vertexCount,
  };
}
