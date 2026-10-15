// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A restore of many rows written in steps (`draw.features.restore`, an undo or a redo of a step
 * of many rows)
 *
 * Written at once, the rows of a layer of 100,000 take longer than a frame. A Store of core of
 * rows writes them as the write of a drag of features selected in bulk is written
 * (`operations/bulk-sliced.ts`): the rows a few hundred at a time (`BULK_SLICE_ROWS`) until the
 * time of a step is spent (`BULK_SLICE_BUDGET_MS`), the first step in the call, the next in a
 * later task. Unlike that write, it is one transaction: its notification is held until the last
 * rows are written (`ChangeBus.hold`), and goes out once, with the source of the transaction it
 * was made in (an undo is one step of a history, its stamps and what keeps its rows told once).
 *
 * - Another write of the document, or of the state of this client, from this client or from
 *   elsewhere, finishes the rest first: the writes keep their order, and the notification of the
 *   restore goes out before the one of the write
 * - A read of the rows through the reading side of the tables (`FeatureTables`, which the reads
 *   of the instance go through: a feature, the items of a layer, an export) finishes the rest
 *   first: no read sees the rows half written. The drawing reads the rows through the internals
 *   of the tables, and draws them as they are written
 * - A group the rows left with no member is deleted once the last rows are written (in the
 *   notification of the restore), not between two steps
 *
 * It is not part of the contract of a Store: the Store of core of rows tells it through
 * `rowStepsOf`, and a Store given by the host writes a restore at once.
 */

import type { RowField, RowWrite } from '../api/tables.js';
import type { RowValues } from './types.js';

/**
 * The time of one step of a write of many rows in steps (ms): rows are written until it is spent.
 * A step then lasts about 20 ms (the last rows and the notification of the step past it), so that
 * a frame with the drawing of the rows written stays near 50 ms
 */
export const BULK_SLICE_BUDGET_MS = 12;

/** The rows written at a time within a step (the time is looked at between two of them) */
export const BULK_SLICE_ROWS = 256;

/**
 * What writes a restore of rows in steps
 *
 * @internal
 */
export interface RowSteps {
  /**
   * Writes the rows of a restore (in a transaction of the Store): the first step now, the next in
   * later tasks, finishing a restore under way first. `onEnd` is called once the last rows are
   * written and the notification went out (or was let go of into the transaction under way)
   *
   * @returns whether steps are left (false: every row was written in this step, `onEnd` not called)
   */
  begin(write: RowWrite, onEnd: () => void): boolean;
  /** Writes the rest of the restore under way now (nothing when none is) */
  finish(): void;
}

/**
 * The writing in steps of the Stores of core that have it, by the contract
 *
 * @internal
 */
export const rowStepsOf = new WeakMap<object, RowSteps>();

/**
 * The rows `from` to `to` of values of rows (the same fields)
 *
 * @internal
 */
export function sliceRowValues(values: RowValues, from: number, to: number): RowValues {
  const fields = new Map<RowField, unknown[]>();
  for (const [field, column] of values.fields) fields.set(field, column.slice(from, to));
  return {
    handles: values.handles.slice(from, to),
    fields,
    ...(values.deleted && { deleted: values.deleted.slice(from, to) }),
  };
}
