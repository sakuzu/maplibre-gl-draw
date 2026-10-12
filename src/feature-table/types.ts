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
 * builds of the chunks, so one budget can be shared by both)
 */
export interface TableWorkBudget {
  /** Whether one more step may be done in this frame (the first step of a frame always may) */
  canStep(): boolean;
  /** Counts a step */
  stepped(): void;
}
