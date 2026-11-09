// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The rings rows of some types draw around their point (`RowRings`)
 *
 * A row of some types holds a point and draws a ring around it, made from what is read of the
 * row (`RowRead`: its point and its attributes). The rows do not know how a ring is made: the
 * user of the tables gives it, and the rows keep the box of the ring as the box of the row. The
 * rows have no rings of their own: without any given, every row draws its shape.
 *
 * A pure module (types only), so it runs in a Worker as well.
 */

import type { RowRead } from './row-read-type.js';

/**
 * The rings the rows of some types draw around their point
 */
export interface RowRings {
  /**
   * Whether a row of a type draws a ring around its point (a row of this type without a point,
   * or whose ring is null, draws nothing of it)
   */
  draws(type: string): boolean;
  /**
   * The ring a row draws around its point, as closed coordinates of 2 values each (null for no
   * ring)
   *
   * @param row The row, of a type that {@link RowRings.draws}, whose shape is one point
   */
  ringOf(row: RowRead): Float64Array | null;
  /**
   * The number of coordinates a row that draws a ring is counted as when the rows are cut into
   * blocks (the coordinates of its ring)
   */
  readonly ringVertices: number;
  /**
   * The keys of the attributes a ring is made from: a row written another value of one of them
   * in place has its ring made again
   */
  readonly keys: readonly string[];
}

/**
 * The rings the rows of some types draw around their point, read from the type, the point and
 * the attributes of a row
 */
export interface PointRowRings {
  /**
   * Whether a row of a type draws a ring around its point (a row of this type without a point,
   * or whose ring is null, draws nothing of it)
   */
  draws(type: string): boolean;
  /**
   * The ring a row of a type draws around its point, as closed coordinates of 2 values each
   * (null for no ring)
   *
   * @param type The type of the row (one that {@link PointRowRings.draws})
   * @param x The point
   * @param y The point
   * @param value Reads an attribute of the row
   */
  ringOf(type: string, x: number, y: number, value: (key: string) => unknown): Float64Array | null;
  /**
   * The number of coordinates a row that draws a ring is counted as when the rows are cut into
   * blocks (the coordinates of its ring)
   */
  readonly ringVertices: number;
}

/**
 * The rings read from the type, the point and the attributes of a row, as rings that read a row
 * (`RowRead`). They are made from no attribute a write in place follows: the rows they are given
 * to are built, not written in place
 *
 * @internal
 */
export function rowRingsOfPoint(rings: PointRowRings): RowRings {
  return {
    draws: (type) => rings.draws(type),
    ringOf: (row) => {
      const shape = row.shape();
      if (!shape) return null;
      const { coords, stride } = shape.column;
      const at = shape.at * stride;
      return rings.ringOf(row.type, coords[at], coords[at + 1], (key) => row.value(key));
    },
    ringVertices: rings.ringVertices,
    keys: [],
  };
}
