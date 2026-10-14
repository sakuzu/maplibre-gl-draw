// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The rings rows of some types draw around their point
 *
 * A row of some types holds a point and draws a ring around it, made from the point and its
 * attributes (a circle of a radius). The rows do not know how a ring is made: they ask the types
 * of the rows (`RowRings`), and keep the bbox and the triangles of the ring as those of the row.
 * Without one, every row draws its geometry.
 *
 * A pure module (types only), so it runs in a Worker as well.
 */

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
   * The ring a row of a type draws around its point, as closed coordinates of 2 values each
   * (null for no ring)
   *
   * @param type The type of the row (one that {@link RowRings.draws})
   * @param x The point
   * @param y The point
   * @param value Reads an attribute of the row
   */
  ringOf(type: string, x: number, y: number, value: (key: string) => unknown): Float64Array | null;
  /**
   * The number of coordinates a row that draws a ring is counted as when the rows are cut into
   * groups (the coordinates of its ring)
   */
  readonly ringVertices: number;
}
