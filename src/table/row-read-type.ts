// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A row as what the user of the tables gives reads it (`RowRead`)
 *
 * What the user of the tables gives for its rows (the rings of `RowRings`) is worked out from a
 * row as it is held: its type, the values of its attributes and its shape, read from the columns
 * of its row block without making anything else of it. The builder of the row blocks, the read of
 * a Tabane block and a write in place each read a row so.
 *
 * A pure module (types only), so it runs in a Worker as well.
 */

/**
 * A column of shapes as a row reads it: its points and the offsets from a row to them
 */
export interface RowShapeColumn {
  /**
   * The form of the shapes of the column: `'Point'`, `'LineString'`, `'Polygon'`,
   * `'MultiPoint'`, `'MultiLineString'` or `'MultiPolygon'`
   */
  readonly type: string;
  /** The points of the column, `stride` values each */
  readonly coords: Float64Array;
  /** The number of values of a point (2 to 4: x and y first) */
  readonly stride: number;
  /**
   * The offsets of the levels of the column, from a row to its points (none for a column of one
   * point a row)
   */
  readonly offsets: readonly Int32Array[];
}

/**
 * The shape of a row: the column it is read from and its row there
 */
export interface RowShape {
  readonly column: RowShapeColumn;
  /** The row of the shape in the column */
  readonly at: number;
}

/**
 * A row as it is held, read without making anything else of it. It is read while it is given
 * only: what reads it does not keep it
 */
export interface RowRead {
  /**
   * The handle of the row (-1 for a row not given one yet: a row of a row block built in a
   * Worker)
   */
  readonly handle: number;
  /** The type of the row */
  readonly type: string;
  /** The value of an attribute of the row (undefined when the row does not hold the key) */
  value(key: string): unknown;
  /** The shape of the row, what was written of it included (null for a row without one) */
  shape(): RowShape | null;
}
