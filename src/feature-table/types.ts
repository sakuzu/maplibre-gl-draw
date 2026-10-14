// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The handles of the rows held as columns
 */

/**
 * The handle of a row: a number the document gives a row the first time it sees its id, and
 * never changes while the document is open, whatever group, layer or place the row moves to
 *
 * A host or an extension that keeps a value per row outside the row (a column of its own) keys
 * it by the handle, so the value stays with its row when the groups are built again or the rows
 * are reordered.
 */
export type RowHandle = number;

/**
 * The handle of a row group of a layer. Cutting a group in two or joining two groups gives a
 * handle to the new groups only; the other groups keep theirs
 */
export type RowGroupHandle = number;

/** The handle of a group of features held as columns */
export type GroupHandle = number;

/**
 * The time a frame gives the work done a step at a time (the same shape as the budget of the
 * builds of the chunks, so one budget can be shared by both). Only the time spent in the steps
 * is counted
 */
export interface TableWorkBudget {
  /** Whether one more step may be done in this frame (the first step of a frame always may) */
  canStep(): boolean;
  /**
   * Does one step of work, and counts it and the time it takes
   *
   * @param work The step, given the time the budget runs out at
   */
  step<T>(work: (deadline: number) => T): T;
}

/** A write of the geometry of a row (its coordinates, and the ring of a Circle) */
export const ROW_WRITE_GEOMETRY = 1;
/** A write of the style of a row */
export const ROW_WRITE_STYLE = 2;
/** A write of attributes of a row */
export const ROW_WRITE_VALUES = 4;
/** A write of what is in the state of a row (shown, locked, deleted) */
export const ROW_WRITE_STATE = 8;

/**
 * What was written in place of a row, as the drawing is told of it
 *
 * @internal
 */
export interface InPlaceRowWrite {
  /** The row group and the row */
  readonly group: RowGroupHandle;
  readonly row: number;
  /** What was written: `ROW_WRITE_GEOMETRY`, `ROW_WRITE_STYLE`, ... */
  readonly what: number;
  /**
   * For a geometry written: whether the row kept its shape (only the positions of its
   * coordinates changed), and the coordinates whose `x` or `y` moved, `[from, to)` from its
   * first: what is drawn again. A write of a `z` or an `m` only keeps the shape and moves none
   * (the rows are told, nothing is drawn again)
   */
  readonly sameShape: boolean;
  readonly from: number;
  readonly to: number;
  /** The keys of the attributes written (empty for none) */
  readonly keys: readonly string[];
}
