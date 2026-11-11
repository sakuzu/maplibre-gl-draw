// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The reading of a `shape` column: the shapes of a form read by their depth, their offsets and
 * their points, and the form and the row there of every row of a column
 *
 * A form is the shapes of one name and one depth (the number of its offset arrays). The points of
 * row `r` of a form are those from the offsets followed level by level from `r`: at depth 0 the
 * point `r`; at depth 1 the points `offsets[0][r]` to `offsets[0][r + 1]`; at depth 2 the lists
 * `offsets[0][r]` to `offsets[0][r + 1]`, list `l` the points `offsets[1][l]` to
 * `offsets[1][l + 1]`; at depth 3 one level more. The name is read by the user of the tables only.
 *
 * The readers read the arrays they are given as they are, without a copy: the form of each row as
 * an `Int8Array` or an `Int16Array` (negative for a row without a shape). What they read is not
 * checked here: the user that reads arrays from outside checks them before.
 *
 * A pure module (it depends on nothing but `@sakuzu/tabane`), so it runs in a Worker as well.
 */

import { type CoordinateDimensions, strideOf } from '@sakuzu/tabane';

/**
 * The shapes of one form of a `shape` column
 *
 * @internal
 */
export interface ShapeForm<T extends string = string> {
  /** The name of the shapes (what the user of the tables reads them as) */
  readonly type: T;
  /** The points, interleaved: the values of the dimensions of each point in their order */
  readonly coords: Float64Array;
  /** The dimensions of the points (`xy` when omitted) */
  readonly dimensions?: CoordinateDimensions;
  /** The offset array of each level, outermost first: as many as the depth (none at depth 0) */
  readonly offsets?: readonly Int32Array[];
}

/**
 * A `shape` column of a row block: its forms, and the form and the row there of every row
 *
 * @internal
 */
export interface ShapeColumn {
  /**
   * The form of each row, as an index into `children` (negative for a row without a shape): an
   * `Int8Array`, or an `Int16Array` for a column of more than 127 forms
   */
  readonly types: Int8Array | Int16Array;
  /** The row of each row within its form */
  readonly offsets: Int32Array;
  /** The forms */
  readonly children: readonly ShapeForm[];
}

/**
 * The most forms a column holds with the form of each row in an `Int8Array`
 *
 * @internal
 */
export const INT8_FORMS = 127;

/**
 * An array for the form of each of `length` rows that holds `forms` forms: an `Int8Array` for
 * up to {@link INT8_FORMS}, an `Int16Array` past
 *
 * @internal
 */
export function formArrayOf(length: number, forms: number): Int8Array | Int16Array {
  return forms > INT8_FORMS ? new Int16Array(length) : new Int8Array(length);
}

/** A point read as its first two values */
export type ShapePoint = [number, number];

/** The points of a row with their first two values, nested as deep as its form */
export type ShapePoints = ShapePoint | ShapePoint[] | ShapePoint[][] | ShapePoint[][][];

/** The points of a row with every value of their dimensions, nested as deep as its form */
export type ShapeFullPoints = number[] | number[][] | number[][][] | number[][][][];

/**
 * The reader of the shapes of one form
 *
 * @internal
 */
export class ShapeFormReader<T extends string = string> {
  /** The name of the shapes */
  readonly type: T;
  /** The depth of the shapes: the number of offset arrays */
  readonly depth: number;
  readonly coords: Float64Array;
  /** The dimensions of the points */
  readonly dimensions: CoordinateDimensions;
  /** The number of values per point (2 to 4) */
  readonly stride: number;
  readonly offsets: readonly Int32Array[];
  /** The number of rows the form holds */
  readonly length: number;

  /**
   * @param form The shapes, read as they are
   * @param rows The number of rows, or undefined to read it from the arrays (the points at depth
   *   0, the first offset array past)
   */
  constructor(form: ShapeForm<T>, rows?: number) {
    const dimensions = form.dimensions ?? 'xy';
    const stride = strideOf(dimensions);
    const offsets = form.offsets ?? [];
    this.type = form.type;
    this.depth = offsets.length;
    this.coords = form.coords;
    this.dimensions = dimensions;
    this.stride = stride;
    this.offsets = offsets;
    this.length =
      rows ??
      Math.max(
        0,
        offsets.length === 0 ? Math.floor(form.coords.length / stride) : offsets[0].length - 1,
      );
  }

  /** The first point of the run of a row */
  vertexStart(row: number): number {
    let at = row;
    for (let level = 0; level < this.offsets.length; level++) at = this.offsets[level][at];
    return at;
  }

  /** Point `v` as `[x, y]` (what is drawn and hit; the values past them are not read) */
  position(v: number): ShapePoint {
    const at = v * this.stride;
    return [this.coords[at], this.coords[at + 1]];
  }

  /**
   * Point `v` with every value of its dimensions, in their order, without the values at the end
   * that are NaN (a value it does not have): `[x, y]`, `[x, y, z]`, `[x, y, z, m]` of `xyzm`,
   * `[x, y, m]` of `xym`
   */
  fullPosition(v: number): number[] {
    const stride = this.stride;
    const at = v * stride;
    const coords = this.coords;
    if (stride === 2) return [coords[at], coords[at + 1]];
    let end = stride;
    while (end > 2 && Number.isNaN(coords[at + end - 1])) end--;
    const out: number[] = new Array(end);
    for (let k = 0; k < end; k++) out[k] = coords[at + k];
    return out;
  }

  /** The points `[from, to)` as `[x, y]` each */
  positions(from: number, to: number): ShapePoint[] {
    const out: ShapePoint[] = new Array(to - from);
    for (let v = from; v < to; v++) out[v - from] = this.position(v);
    return out;
  }

  /** The points of a row as `[x, y]` each, nested as deep as the form */
  coordinatesOf(row: number): ShapePoints {
    const o = this.offsets;
    switch (this.depth) {
      case 0:
        return this.position(row);
      case 1:
        return this.positions(o[0][row], o[0][row + 1]);
      case 2: {
        const lists: ShapePoint[][] = [];
        for (let r = o[0][row]; r < o[0][row + 1]; r++) {
          lists.push(this.positions(o[1][r], o[1][r + 1]));
        }
        return lists;
      }
      default: {
        const outer: ShapePoint[][][] = [];
        for (let p = o[0][row]; p < o[0][row + 1]; p++) {
          const lists: ShapePoint[][] = [];
          for (let r = o[1][p]; r < o[1][p + 1]; r++) {
            lists.push(this.positions(o[2][r], o[2][r + 1]));
          }
          outer.push(lists);
        }
        return outer;
      }
    }
  }

  /** The points of a row with every value of their dimensions (`fullPosition`), nested */
  fullCoordinatesOf(row: number): ShapeFullPoints {
    if (this.stride === 2) return this.coordinatesOf(row);
    const o = this.offsets;
    const run = (from: number, to: number): number[][] => {
      const out: number[][] = new Array(to - from);
      for (let v = from; v < to; v++) out[v - from] = this.fullPosition(v);
      return out;
    };
    switch (this.depth) {
      case 0:
        return this.fullPosition(row);
      case 1:
        return run(o[0][row], o[0][row + 1]);
      case 2: {
        const lists: number[][][] = [];
        for (let r = o[0][row]; r < o[0][row + 1]; r++) lists.push(run(o[1][r], o[1][r + 1]));
        return lists;
      }
      default: {
        const outer: number[][][][] = [];
        for (let p = o[0][row]; p < o[0][row + 1]; p++) {
          const lists: number[][][] = [];
          for (let r = o[1][p]; r < o[1][p + 1]; r++) lists.push(run(o[2][r], o[2][r + 1]));
          outer.push(lists);
        }
        return outer;
      }
    }
  }
}

/**
 * The reader of a `shape` column: a reader per form, and the form and the row there of each row
 *
 * @internal
 */
export class ShapeColumnReader<T extends string = string> {
  /**
   * @param forms The form of each row (negative for a row without a shape), read as it is; null
   *   for a column of one form, where every row is in form 0
   * @param rows The row of each row within its form, read as it is; null for the same row
   * @param readers The reader of each form
   */
  constructor(
    readonly forms: Int8Array | Int16Array | null,
    readonly rows: Int32Array | null,
    readonly readers: readonly ShapeFormReader<T>[],
  ) {}

  /** The form of a row (-1 for a row without a shape) */
  formOf(row: number): number {
    const forms = this.forms;
    if (forms === null) return 0;
    const form = forms[row];
    return form < 0 ? -1 : form;
  }

  /** The row within its form of a row */
  rowOf(row: number): number {
    return this.rows === null ? row : this.rows[row];
  }

  /** The reader of the form of a row (undefined for a row without a shape) */
  readerOf(row: number): ShapeFormReader<T> | undefined {
    const form = this.formOf(row);
    return form < 0 ? undefined : this.readers[form];
  }
}

/**
 * The reader of a `shape` column of a row block
 *
 * @internal
 */
export function shapeColumnReaderOf(column: ShapeColumn): ShapeColumnReader {
  return new ShapeColumnReader(
    column.types,
    column.offsets,
    column.children.map((form) => new ShapeFormReader(form)),
  );
}
