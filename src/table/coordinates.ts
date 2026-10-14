// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The dimensions of the coordinates, and what the rows ask of the system of coordinates
 *
 * A coordinate holds `x` and `y`, and may hold a `z` and an `m` (a measure, such as a time). The
 * values of a coordinate are interleaved in one array, in the order of their dimensions, as
 * GeoArrow names them: `xy`, `xyz`, `xym`, `xyzm`. A column holds one of them for all its
 * coordinates, so the coordinate `v` starts at `v * stride`. A column of `xy` pays for no other
 * value. A `z` or an `m` that a coordinate does not have is NaN: a coordinate of 2 values in a
 * column of `xyz` has a `z` of NaN, read back as a coordinate of 2 values.
 *
 * The rows do not know what the values mean. What they compute from them (the bbox of a row and
 * the order of the leaves of the spatial index) goes through a system of coordinates
 * (`CoordinateSystem`), plane by default; the distances and the projection belong to the side
 * that uses the rows.
 *
 * A pure module: it depends on nothing, so it runs in a Worker as well.
 */

/**
 * The dimensions of the coordinates of a column: `x` and `y`, with a `z`, an `m`, or both (the
 * names of GeoArrow). The values of a coordinate are in this order.
 */
export type CoordinateDimensions = 'xy' | 'xyz' | 'xym' | 'xyzm';

/** The number of values of a coordinate of each dimensions */
const STRIDES: Readonly<Record<CoordinateDimensions, 2 | 3 | 4>> = {
  xy: 2,
  xyz: 3,
  xym: 3,
  xyzm: 4,
};

/** Where `z` and `m` are in a coordinate of each dimensions (-1 for none) */
const Z_AT: Readonly<Record<CoordinateDimensions, number>> = { xy: -1, xyz: 2, xym: -1, xyzm: 2 };
const M_AT: Readonly<Record<CoordinateDimensions, number>> = { xy: -1, xyz: -1, xym: 2, xyzm: 3 };

/**
 * Whether a value names dimensions of coordinates
 *
 * @internal
 */
export function isCoordinateDimensions(value: unknown): value is CoordinateDimensions {
  return value === 'xy' || value === 'xyz' || value === 'xym' || value === 'xyzm';
}

/**
 * The number of values of a coordinate of dimensions (`xy` when omitted)
 *
 * @internal
 */
export function strideOf(dims: CoordinateDimensions | undefined): 2 | 3 | 4 {
  return STRIDES[dims ?? 'xy'];
}

/**
 * Whether every dimension of `inner` is one of `outer` (the coordinates of `inner` can be
 * written into a column of `outer` without losing a value)
 *
 * @internal
 */
export function dimsWithin(inner: CoordinateDimensions, outer: CoordinateDimensions): boolean {
  return (Z_AT[inner] < 0 || Z_AT[outer] >= 0) && (M_AT[inner] < 0 || M_AT[outer] >= 0);
}

/**
 * The dimensions that hold every dimension of both
 *
 * @internal
 */
export function unionDims(a: CoordinateDimensions, b: CoordinateDimensions): CoordinateDimensions {
  const z = Z_AT[a] >= 0 || Z_AT[b] >= 0;
  const m = M_AT[a] >= 0 || M_AT[b] >= 0;
  return z ? (m ? 'xyzm' : 'xyz') : m ? 'xym' : 'xy';
}

/**
 * Copies coordinates from a column of some dimensions into one of others that holds them (a
 * dimension the source does not have is NaN)
 *
 * @param source The coordinates read
 * @param sourceDims Their dimensions
 * @param from The first coordinate read
 * @param count The number of coordinates
 * @param target The coordinates written
 * @param targetDims Their dimensions
 * @param at The first coordinate written
 * @throws when the source has a dimension the target does not
 * @internal
 */
export function copyCoordinates(
  source: Float64Array,
  sourceDims: CoordinateDimensions,
  from: number,
  count: number,
  target: Float64Array,
  targetDims: CoordinateDimensions,
  at: number,
): void {
  if (sourceDims === targetDims) {
    const stride = STRIDES[sourceDims];
    const end = (from + count) * stride;
    for (let i = from * stride, o = at * stride; i < end; i++, o++) target[o] = source[i];
    return;
  }
  if (!dimsWithin(sourceDims, targetDims)) {
    throw new Error(`coordinates of ${sourceDims} cannot be written as ${targetDims}`);
  }
  const s = STRIDES[sourceDims];
  const t = STRIDES[targetDims];
  const sz = Z_AT[sourceDims];
  const sm = M_AT[sourceDims];
  const tz = Z_AT[targetDims];
  const tm = M_AT[targetDims];
  for (let v = 0; v < count; v++) {
    const i = (from + v) * s;
    const o = (at + v) * t;
    target[o] = source[i];
    target[o + 1] = source[i + 1];
    if (tz >= 0) target[o + tz] = sz >= 0 ? source[i + sz] : Number.NaN;
    if (tm >= 0) target[o + tm] = sm >= 0 ? source[i + sm] : Number.NaN;
  }
}

/**
 * What the rows ask of the system of their coordinates: the bbox of a row, and the order of the
 * leaves of the spatial index. The distances and the projection are not asked here; the side
 * that uses the rows keeps them. One system serves all the rows of a set of tables
 */
export interface CoordinateSystem {
  /**
   * Writes the bbox of the coordinates `[from, to)` as `[minX, minY, maxX, maxY]` into
   * `out[at..at + 4]`: four NaN when there is no coordinate or one has a NaN `x` or `y`. Only
   * `x` and `y` are read
   *
   * @param coords The coordinates, `stride` values each
   */
  rowBox(
    coords: Float64Array,
    stride: number,
    from: number,
    to: number,
    out: Float64Array,
    at: number,
  ): void;
  /**
   * The key the leaves of the spatial index are put in order by, from the center of the bbox of
   * a row (the Hilbert curve of the centers over the plane when omitted)
   */
  sortKey?(centerX: number, centerY: number): number;
}

/**
 * The bbox of coordinates over the plane (see {@link CoordinateSystem.rowBox})
 *
 * @internal
 */
export function planarRowBox(
  coords: Float64Array,
  stride: number,
  from: number,
  to: number,
  out: Float64Array,
  at: number,
): void {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (let v = from; v < to; v++) {
    const x = coords[v * stride];
    const y = coords[v * stride + 1];
    if (Number.isNaN(x) || Number.isNaN(y)) {
      out.fill(Number.NaN, at, at + 4);
      return;
    }
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  if (minX === Number.POSITIVE_INFINITY) {
    out.fill(Number.NaN, at, at + 4);
    return;
  }
  out[at] = minX;
  out[at + 1] = minY;
  out[at + 2] = maxX;
  out[at + 3] = maxY;
}

/**
 * The plane: the values of `x` and `y` as they are, the leaves of the spatial index along the
 * Hilbert curve of the centers. The system of coordinates when none is given
 *
 * @internal
 */
export const planarCoordinates: CoordinateSystem = { rowBox: planarRowBox };

/**
 * The key of the order of the leaves of the spatial index of a system (undefined for the Hilbert
 * curve of the plane)
 *
 * @internal
 */
export function sortKeyOf(
  system: CoordinateSystem,
): ((centerX: number, centerY: number) => number) | undefined {
  return system.sortKey
    ? (x, y) => (system.sortKey as NonNullable<typeof system.sortKey>).call(system, x, y)
    : undefined;
}
