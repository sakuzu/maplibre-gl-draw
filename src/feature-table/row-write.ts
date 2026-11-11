// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Writing the values of a row held as columns in place
 *
 * What fits the columns of the group is written into them: the coordinates of a geometry of the
 * same shape (the same type and the same numbers of parts, rings and coordinates), the numbers of
 * its caches (`RowCache`, made again of the row written) when there are as many. What does not
 * fit is written into the overrides of the group (`value-overrides.ts`), which every reader looks
 * at first: the attributes (a column of values cannot change in place), the geometry of another
 * shape, and numbers of a cache of another count. The next version of the group folds the
 * overrides into its columns.
 *
 * A geometry written marks its row moved in its group, with its new bbox, and tells the index of
 * the boxes of the rows of its layer to read the row again.
 */

import { type CoordinateSystem, type PropertyColumns, readValue } from '@sakuzu/tabane';
import type { Geometry } from 'geojson';
import { PROPERTIES_COLUMN } from '../table/feature-row-columns.js';
import type { RowCache } from '../table/row-caches.js';
import { type RowGeometry, singleRowColumn, toRowGeometry } from '../table/row-geometry.js';
import type { RowRead } from '../table/row-read-type.js';
import type { RowRings } from '../table/row-rings.js';
import { groupRowRead, rowCacheNumbers, rowType } from './row-read.js';
import {
  columnGeometryAt,
  geometryAt,
  type RowGeometryAt,
  type RowGroup,
  type RowTable,
  widenBounds,
} from './row-table.js';
import {
  encodeOverrideValue,
  GeometryOverrides,
  type OverrideValue,
  sameOverrideValue,
  ValueOverrides,
} from './value-overrides.js';

/**
 * What a write of the geometry of a row changed
 *
 * @internal
 */
export interface GeometryWrite {
  /**
   * Whether the row keeps its shape: the same numbers of parts, rings and coordinates, and the
   * same numbers of its caches, so only the positions of its coordinates changed
   */
  readonly sameShape: boolean;
  /**
   * The coordinates of the row whose `x` or `y` changed, `[from, to)` counted from its first
   * coordinate (a row that draws a ring counts the coordinates of its ring): what is drawn of
   * them. Empty when
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
    column === undefined
      ? undefined
      : readValue((group.data.keyed[PROPERTIES_COLUMN] as PropertyColumns).columns[column], row),
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
 * @param table The layer of the row (its dimensions, its rows moved)
 * @param system The system of the coordinates the bbox of the row is made in (that of the tables)
 * @param rings The rings the rows of some types draw around their point (those of the tables;
 *   none when omitted)
 * @param caches The caches of the rows (those of the tables; none when omitted)
 * @throws when the geometry is not of one of the six types a row holds, or when a position has
 *   more values than the dimensions of the layer
 * @internal
 */
export function writeRowGeometry(
  table: RowTable,
  group: RowGroup,
  row: number,
  geometry: Geometry,
  system: CoordinateSystem,
  rings: RowRings | null = null,
  caches: readonly RowCache[] = [],
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
  const shape = refreshRowShape(table, group, row, system, rings, caches);
  if (shape.ring) {
    // A row that draws a ring: every coordinate of it moves with its point
    return {
      sameShape: sameStructure && shape.sameTriangles,
      from: 0,
      to: shape.ring,
    };
  }
  return { sameShape: sameStructure && shape.sameTriangles, from, to };
}

/**
 * Works out again what follows from the geometry of a row (and from the attributes its ring is
 * made from): the numbers of its caches and its bbox, and records it moved in its layer. Called
 * after its geometry or an attribute its ring is made from was written
 *
 * @param system The system of the coordinates the bbox of the row is made in, as for every other
 *   row of the tables (that of the tables)
 * @param rings The rings the rows of some types draw around their point (those of the tables;
 *   none when omitted)
 * @param caches The caches of the rows (those of the tables; none when omitted)
 * @returns Whether the numbers of its caches stayed the same, and the number of coordinates of
 *   the ring the row draws (0 for a row that draws none)
 * @internal
 */
export function refreshRowShape(
  table: RowTable,
  group: RowGroup,
  row: number,
  system: CoordinateSystem,
  rings: RowRings | null = null,
  caches: readonly RowCache[] = [],
): { sameTriangles: boolean; ring: number } {
  const geometry = geometryAt(group, row);
  if (!geometry) return { sameTriangles: true, ring: 0 };
  const read = groupRowRead(group, row);
  const shape = shapeOf(group, row, geometry, rings, read);
  let sameTriangles = true;
  for (let c = 0; c < caches.length; c++) {
    const numbers = caches[c].build(read, shape.ring > 0 ? shape.coords : null);
    if (!writeCacheNumbers(group, row, c, numbers)) sameTriangles = false;
  }
  const bounds = group.data.rowBounds;
  system.rowBox(shape.coords, shape.stride, shape.from, shape.to, bounds, row * 4);
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
 * Whether the ring of a row is made from the attribute of a key (its ring follows it)
 *
 * @param rings The rings of the tables (null for none)
 * @internal
 */
export function isRingKey(
  rings: RowRings | null,
  group: RowGroup,
  row: number,
  key: string,
): boolean {
  return rings?.keys.includes(key) === true && rings.draws(rowType(group.data, row));
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

/** What follows from the geometry of a row: the coordinates of its bbox, and the ring it draws */
interface RowShape {
  readonly coords: Float64Array;
  readonly stride: number;
  /** The coordinates `[from, to)` the bbox is made of */
  readonly from: number;
  readonly to: number;
  /** The coordinates of the ring the row draws, `coords` (0 for a row that draws none) */
  readonly ring: number;
}

function shapeOf(
  group: RowGroup,
  row: number,
  geometry: RowGeometryAt,
  rings: RowRings | null,
  read: RowRead,
): RowShape {
  const { reader, at } = geometry;
  if (rings && reader.type === 'Point' && rings.draws(rowType(group.data, row))) {
    const ring = rings.ringOf(read);
    if (ring)
      return { coords: ring, stride: 2, from: 0, to: ring.length / 2, ring: ring.length / 2 };
  }
  const from = reader.vertexStart(at);
  const to = reader.vertexStart(at + 1);
  return { coords: reader.coords, stride: reader.stride, from, to, ring: 0 };
}

/**
 * Writes the numbers of a cache of a row: into the column of the cache of the group when there
 * are as many as it holds for the row, into the overrides otherwise
 *
 * @param cache The place of the cache in the caches of the tables
 * @returns Whether they are the numbers the row had
 */
function writeCacheNumbers(
  group: RowGroup,
  row: number,
  cache: number,
  next: ArrayLike<number>,
): boolean {
  const current = rowCacheNumbers(group, row, cache);
  if (current.length === next.length) {
    let same = true;
    for (let i = 0; i < next.length && same; i++) same = current[i] === next[i];
    if (same) return true;
  }
  const written = group.geometries?.cacheNumbers(cache, row) !== undefined;
  const narrow = current instanceof Uint16Array;
  let max = 0;
  for (let i = 0; i < next.length; i++) if (next[i] > max) max = next[i];
  if (!written && current.length === next.length && (!narrow || max < 65_536)) {
    // The slot of the row in the column of the cache of the group takes them
    current.set(next);
    return false;
  }
  const width = group.data.caches[cache]?.numbers instanceof Uint32Array ? 32 : 16;
  group.geometries ??= new GeometryOverrides();
  group.geometries.setCacheNumbers(
    cache,
    row,
    width === 16 && max < 65_536 ? Uint16Array.from(next) : Uint32Array.from(next),
  );
  return false;
}
