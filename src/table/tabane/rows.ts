// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A row block of the Tabane format as a row block of the tables, and as rows
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

import type { Geometry } from 'geojson';
import { circleRowRings } from '../../shared/circle-rings.js';
import { DrawError } from '../../shared/draw-error.js';
import { setOwnProperty } from '../../shared/utils/own-property.js';
import { decodeCanonicalValue } from '../canonical-value.js';
import {
  type CoordinateDimensions,
  type CoordinateSystem,
  copyCoordinates,
  dimsWithin,
  planarCoordinates,
  sortKeyOf,
  strideOf,
} from '../coordinates.js';
import { buildPackedRTree } from '../packed-rtree.js';
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
import type { RowRings } from '../row-rings.js';
import type { TableGeometry, TableMixedGeometry } from '../types.js';
import { hashUtf8, type Utf8Column } from '../utf8-column.js';
import { readValue } from '../value-column.js';
import { base32Of, formatTabaneId, writeRowSuffix } from './ids.js';
import type {
  TabaneFill,
  TabaneRevision,
  TabaneRow,
  TabaneRowBlock,
  TabaneRowBlockData,
} from './types.js';

const encoder = new TextEncoder();

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

/** The first and the end coordinate of a row of a child of a geometry */
function vertexRange(child: TableGeometry, row: number): [number, number] {
  let first = row;
  let end = row + 1;
  for (const level of child.offsets ?? []) {
    first = level[first];
    end = level[end];
  }
  return [first, end];
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
 * The ids of the rows of a row block as a column of text
 *
 * @internal
 */
export function idColumn(rowBlock: TabaneRowBlock): Utf8Column {
  const n = rowBlock.length;
  const offsets = new Int32Array(n + 1);
  // 13 digits, `-`, at most 11 digits of a number
  const bytes = new Uint8Array(n * 25);
  let at = 0;
  let row = 0;
  for (const [origin, first, count] of rowBlock.ids) {
    const prefix = encoder.encode(`${origin}-`);
    for (let k = 0; k < count; k++) {
      bytes.set(prefix, at);
      at += prefix.length;
      const digits = base32Of(first + k);
      for (let d = 0; d < digits.length; d++) bytes[at++] = digits.charCodeAt(d);
      offsets[++row] = at;
    }
  }
  return { offsets, bytes: bytes.slice(0, at) };
}

/**
 * The keys of the rows of a row block as a column of text
 *
 * @internal
 */
export function keyColumn(rowBlock: TabaneRowBlock): Utf8Column {
  const n = rowBlock.length;
  const head = encoder.encode(rowBlock.place.head);
  const offsets = new Int32Array(n + 1);
  const bytes = new Uint8Array(n * (head.length + 11));
  let at = 0;
  for (let r = 0; r < n; r++) {
    bytes.set(head, at);
    at += head.length;
    at += writeRowSuffix(rowBlock.place.firstIndex + r, bytes, at);
    offsets[r + 1] = at;
  }
  return { offsets, bytes: bytes.slice(0, at) };
}

/** Whether the bit of a row is set in a column of flags (none set when it is null) */
function flagOf(bits: Uint8Array | null, row: number): boolean {
  return bits !== null && (bits[row >> 3] & (1 << (row & 7))) !== 0;
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
      (flagOf(rowBlock.hidden, r) ? 0 : ROW_FLAG_VISIBLE) |
      (flagOf(rowBlock.locked, r) ? ROW_FLAG_LOCKED : 0) |
      (flagOf(rowBlock.deleted, r) ? ROW_FLAG_DELETED : 0);
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
    const [first, end] = vertexRange(child, at);
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

// === Rows ===

/** The GeoJSON geometry of a row of a child */
function geometryOf(child: TableGeometry, row: number, stride: number): Geometry {
  const o = child.offsets ?? [];
  const position = (v: number): number[] =>
    Array.from(child.coords.subarray(v * stride, v * stride + stride));
  const walk = (level: number, at: number): unknown => {
    if (level === o.length) return position(at);
    const items: unknown[] = [];
    for (let k = o[level][at]; k < o[level][at + 1]; k++) items.push(walk(level + 1, k));
    return items;
  };
  return { type: child.type, coordinates: walk(0, row) } as Geometry;
}

/**
 * The rows of a row block, as the writer took them: the coordinates read back to the same bits, the
 * values to the same values
 *
 * @experimental
 */
export function tabaneRowsOf(read: TabaneRowBlock): TabaneRow[] {
  const rowBlock = read as TabaneRowBlockData;
  const n = rowBlock.length;
  const stride = strideOf(rowBlock.dimensions);
  const ids: string[] = [];
  for (const [origin, first, count] of rowBlock.ids) {
    for (let k = 0; k < count; k++) ids.push(formatTabaneId({ origin, number: first + k }));
  }
  const created: TabaneRevision[] = [];
  for (const [revision, count] of rowBlock.created ?? [])
    for (let k = 0; k < count; k++) created.push(revision);
  const revisions: Record<string, TabaneRevision>[] = Array.from({ length: n }, () => ({}));
  const rv = rowBlock.revisions;
  for (let k = 0; k < rv.rows.length; k++) {
    revisions[rv.rows[k]][rv.names[rv.cells[k]]] = [
      rv.sequences[k],
      rv.origins[rv.originIndex[k]],
      rv.steps[k],
    ];
  }
  const out: TabaneRow[] = [];
  for (let r = 0; r < n; r++) {
    const c = rowBlock.geometry.types[r];
    const child = c >= 0 ? rowBlock.geometry.children[c] : null;
    const geometry = child ? geometryOf(child, rowBlock.geometry.offsets[r], stride) : null;
    const s = rowBlock.styles[r];
    const style = decodeCanonicalValue(
      rowBlock.styleDictionary.bytes,
      rowBlock.styleDictionary.offsets[s],
      rowBlock.styleDictionary.offsets[s + 1],
    ) as Record<string, unknown>;
    const properties: Record<string, unknown> = {};
    rowBlock.properties.keys.forEach((key, k) => {
      const v = readValue(rowBlock.properties.columns[k], r);
      if (v !== undefined) setOwnProperty(properties, key, v);
    });
    let fill: TabaneFill | undefined;
    const f = rowBlock.fills;
    if (f && f.vertices[r] >= 0) {
      fill = {
        vertices: f.vertices[r],
        indices: Array.from(f.indices.subarray(f.offsets[r], f.offsets[r + 1])),
      };
    }
    out.push({
      id: ids[r],
      type: rowBlock.typeNames[rowBlock.types[r]],
      geometry,
      style,
      properties,
      ...(flagOf(rowBlock.deleted, r) && { deleted: true }),
      ...(flagOf(rowBlock.hidden, r) && { visible: false }),
      ...(flagOf(rowBlock.locked, r) && { locked: true }),
      ...(rowBlock.created && { created: created[r] }),
      ...(Object.keys(revisions[r]).length > 0 && { revisions: revisions[r] }),
      ...(fill && { fill }),
    });
  }
  return out;
}
