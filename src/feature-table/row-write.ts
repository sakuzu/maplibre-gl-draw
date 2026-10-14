// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Writing the values of a row held as columns in place
 *
 * What fits the columns of the group is written into them: the coordinates of a geometry of the
 * same shape (the same type and the same numbers of parts, rings and coordinates), its triangles
 * when there are as many. What does not fit is written into the overrides of the group
 * (`value-overrides.ts`), which every reader looks at first: the attributes (a column of values
 * cannot change in place), the geometry of another shape, and triangles of another number. The
 * next version of the group folds the overrides into its columns.
 *
 * A geometry written moves its row out of the spatial index of its group into the index of the
 * moved rows of its layer, with its new bbox.
 */

import type { Geometry } from 'geojson';
import { circleRingCoords } from '../shared/circle-rings.js';
import { drawPropertyKey } from '../shared/properties.js';
import {
  polygonRanges,
  type RowGeometry,
  ringOffsetsOf,
  rowGeometryOfColumn,
  singleRowColumn,
  toRowGeometry,
  triangulateRow,
} from '../table/row-geometry.js';
import { readValue } from '../table/value-column.js';
import {
  columnGeometryAt,
  geometryAt,
  type LayerTable,
  type RowGeometryAt,
  type RowGroup,
  widenBounds,
} from './layer-table.js';
import { rowNumber, rowTriangles, rowType } from './row-read.js';
import {
  encodeOverrideValue,
  GeometryOverrides,
  type OverrideValue,
  sameOverrideValue,
  ValueOverrides,
} from './value-overrides.js';

/** The key of the radius of a Circle in the attributes of a row */
const RADIUS_KEY = drawPropertyKey('radiusMeters');

/**
 * What a write of the geometry of a row changed
 *
 * @internal
 */
export interface GeometryWrite {
  /**
   * Whether the row keeps its shape: the same numbers of parts, rings and coordinates, and the
   * same triangles, so only the positions of its coordinates changed
   */
  readonly sameShape: boolean;
  /**
   * The coordinates of the row whose `x` or `y` changed, `[from, to)` counted from its first
   * coordinate (a Circle counts the coordinates of its ring): what is drawn of them. Empty when
   * nothing moved, a write of a `z` or an `m` only included
   */
  readonly from: number;
  readonly to: number;
}

/**
 * Writes the value of an attribute of a row (`undefined` takes the key off the row)
 *
 * The value is kept in the overrides of the group, unless it is the value of the column, in
 * which case what was written of it is taken off.
 *
 * @returns Whether the value read changed
 * @throws when the value is not one of the kinds of the canonical form
 * @internal
 */
export function writeRowValue(group: RowGroup, row: number, key: string, value: unknown): boolean {
  const next = encodeOverrideValue(value);
  const column = group.propertyIndex.get(key);
  const held = encodeOverrideValue(
    column === undefined ? undefined : readValue(group.data.properties.columns[column], row),
  );
  const before: OverrideValue = group.values?.get(row, key) ?? held;
  if (sameOverrideValue(next, held)) {
    group.values?.delete(row, key);
  } else {
    group.values ??= new ValueOverrides();
    group.values.set(row, key, next);
  }
  return !sameOverrideValue(before, next);
}

/**
 * Writes the geometry of a row in place, as coordinates of the dimensions of its layer: every
 * value of a coordinate is written (a `z` or an `m` a position does not have is NaN), and the
 * coordinates whose `x` or `y` changed are told apart (only they are drawn again)
 *
 * @param table The layer of the row (its dimensions, its index of the moved rows)
 * @throws when the geometry is not of one of the six types a row holds, or when a position has
 *   more values than the dimensions of the layer
 * @internal
 */
export function writeRowGeometry(
  table: LayerTable,
  group: RowGroup,
  row: number,
  geometry: Geometry,
): GeometryWrite {
  const next = toRowGeometry(geometry, table.dims);
  const stride = next.stride;
  const current = geometryAt(group, row);
  let sameStructure = false;
  let from = 0;
  let to = next.coords.length / stride;
  if (current && fits(current, next)) {
    // The coordinates are written over the ones of the column the row is read from
    sameStructure = true;
    const { reader, at } = current;
    const first = reader.vertexStart(at);
    const coords = reader.coords;
    from = to;
    let last = -1;
    for (let v = 0; v < next.coords.length / stride; v++) {
      const target = (first + v) * stride;
      const x = next.coords[v * stride];
      const y = next.coords[v * stride + 1];
      if (coords[target] !== x || coords[target + 1] !== y) {
        if (v < from) from = v;
        last = v;
        coords[target] = x;
        coords[target + 1] = y;
      }
      // A `z` and an `m` are written, and are not drawn
      for (let k = 2; k < stride; k++) coords[target + k] = next.coords[v * stride + k];
    }
    to = last + 1;
    if (last < 0) from = to = 0;
  } else {
    const main = columnGeometryAt(group, row);
    if (main && fits(main, next)) {
      // Back to the shape of the column: written there, and the override is dropped
      const first = main.reader.vertexStart(main.at);
      main.reader.coords.set(next.coords, first * stride);
      group.geometries?.deleteGeometry(row);
    } else {
      group.geometries ??= new GeometryOverrides();
      group.geometries.setGeometry(row, singleRowColumn(next));
    }
  }
  const shape = refreshRowShape(table, group, row);
  if (shape.ring) {
    // A Circle draws its ring: every coordinate of it moves with its center
    return {
      sameShape: sameStructure && shape.sameTriangles,
      from: 0,
      to: shape.ring,
    };
  }
  return { sameShape: sameStructure && shape.sameTriangles, from, to };
}

/**
 * Works out again what follows from the geometry of a row (and the radius of a Circle): its
 * triangles and its bbox, with its place in the index of the moved rows. Called after its
 * geometry or the radius of a Circle was written
 *
 * @returns Whether the triangles stayed the same, and the number of coordinates of the ring of a
 *   Circle (0 for any other row)
 * @internal
 */
export function refreshRowShape(
  table: LayerTable,
  group: RowGroup,
  row: number,
): { sameTriangles: boolean; ring: number } {
  const geometry = geometryAt(group, row);
  if (!geometry) return { sameTriangles: true, ring: 0 };
  const shape = shapeOf(group, row, geometry);
  const sameTriangles = shape.fill ? writeTriangles(group, row, shape.fill) : true;
  const bounds = group.data.rowBounds;
  writeBounds(bounds, row, shape.coords, shape.stride, shape.from, shape.to);
  table.moveRow(group, row, bounds);
  const at = row * 4;
  if (!Number.isNaN(bounds[at])) {
    group.bounds = widenBounds(
      group.bounds,
      bounds[at],
      bounds[at + 1],
      bounds[at + 2],
      bounds[at + 3],
    );
  }
  return { sameTriangles, ring: shape.ring };
}

/**
 * Whether the radius of a row is the key written (the ring of a Circle follows it)
 *
 * @internal
 */
export function isRadiusKey(group: RowGroup, row: number, key: string): boolean {
  return key === RADIUS_KEY && rowType(group.data, row) === 'Circle';
}

/**
 * Whether a geometry has the type, the dimensions and the numbers of parts, rings and coordinates
 * of a row
 */
function fits(current: RowGeometryAt, next: RowGeometry): boolean {
  const { reader, at } = current;
  if (reader.type !== next.type || reader.stride !== next.stride) return false;
  const o = reader.offsets;
  switch (reader.type) {
    case 'Point':
      return next.coords.length === next.stride;
    case 'LineString':
    case 'MultiPoint':
      return o[0][at + 1] - o[0][at] === next.coords.length / next.stride;
    case 'Polygon':
    case 'MultiLineString': {
      if (o[0][at + 1] - o[0][at] !== next.parts.length) return false;
      for (let i = 0; i < next.parts.length; i++) {
        const ring = o[0][at] + i;
        if (o[1][ring + 1] - o[1][ring] !== next.parts[i]) return false;
      }
      return true;
    }
    case 'MultiPolygon': {
      if (o[0][at + 1] - o[0][at] !== next.polygons.length) return false;
      let ring = 0;
      for (let p = 0; p < next.polygons.length; p++) {
        const polygon = o[0][at] + p;
        if (o[1][polygon + 1] - o[1][polygon] !== next.polygons[p]) return false;
        for (let r = 0; r < next.polygons[p]; r++) {
          const at2 = o[1][polygon] + r;
          if (o[2][at2 + 1] - o[2][at2] !== next.parts[ring++]) return false;
        }
      }
      return true;
    }
  }
}

/** What follows from the geometry of a row: the coordinates of its bbox and its fill */
interface RowShape {
  readonly coords: Float64Array;
  readonly stride: number;
  /** The coordinates `[from, to)` the bbox is made of */
  readonly from: number;
  readonly to: number;
  /** The triangles of its fill (null for a row without one) */
  readonly fill: number[] | null;
  /** The coordinates of the ring of a Circle (0 for any other row) */
  readonly ring: number;
}

function shapeOf(group: RowGroup, row: number, geometry: RowGeometryAt): RowShape {
  const { reader, at } = geometry;
  if (rowType(group.data, row) === 'Circle' && reader.type === 'Point') {
    const center = reader.position(at);
    const ring = circleRingCoords([center[0], center[1]], rowNumber(group, row, RADIUS_KEY) ?? 0);
    if (!ring) {
      return {
        coords: reader.coords,
        stride: reader.stride,
        from: at,
        to: at + 1,
        fill: [],
        ring: 0,
      };
    }
    const count = ring.length / 2;
    const fill = triangulateRow(ring, Int32Array.of(0, count), [[0, 1]]).indices;
    return { coords: ring, stride: 2, from: 0, to: count, fill, ring: count };
  }
  const from = reader.vertexStart(at);
  const to = reader.vertexStart(at + 1);
  if (reader.type !== 'Polygon' && reader.type !== 'MultiPolygon') {
    return { coords: reader.coords, stride: reader.stride, from, to, fill: null, ring: 0 };
  }
  const local = rowGeometryOfColumn(reader, at);
  const fill = triangulateRow(
    local.coords,
    ringOffsetsOf(local),
    polygonRanges(local),
    local.stride,
  ).indices;
  return { coords: reader.coords, stride: reader.stride, from, to, fill, ring: 0 };
}

/**
 * Writes the triangles of a row: into the cache of the group when there are as many as it holds
 * for the row, into the overrides otherwise
 *
 * @returns Whether they are the triangles the row had
 */
function writeTriangles(group: RowGroup, row: number, next: number[]): boolean {
  const current = rowTriangles(group, row);
  if (current.length === next.length) {
    let same = true;
    for (let i = 0; i < next.length && same; i++) same = current[i] === next[i];
    if (same) return true;
  }
  const written = group.geometries?.rowTriangles(row) !== undefined;
  const narrow = current instanceof Uint16Array;
  let max = 0;
  for (const index of next) if (index > max) max = index;
  if (!written && current.length === next.length && (!narrow || max < 65_536)) {
    // The slot of the row in the cache of the group takes them
    current.set(next);
    return false;
  }
  group.geometries ??= new GeometryOverrides();
  group.geometries.setTriangles(
    row,
    max < 65_536 ? Uint16Array.from(next) : Uint32Array.from(next),
  );
  return false;
}

/** Writes the bbox of the coordinates `[from, to)` (NaN when there is none or one is NaN) */
function writeBounds(
  bounds: Float64Array,
  row: number,
  coords: Float64Array,
  stride: number,
  from: number,
  to: number,
): void {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let ok = to > from;
  for (let v = from; v < to && ok; v++) {
    const x = coords[v * stride];
    const y = coords[v * stride + 1];
    if (Number.isNaN(x) || Number.isNaN(y)) ok = false;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const at = row * 4;
  if (!ok) {
    bounds.fill(Number.NaN, at, at + 4);
    return;
  }
  bounds[at] = minX;
  bounds[at + 1] = minY;
  bounds[at + 2] = maxX;
  bounds[at + 3] = maxY;
}
