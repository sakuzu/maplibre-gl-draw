// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The write of a drag of many features selected in bulk once let go, made in steps
 *
 * A hundred thousand rows moved, turned or resized take far longer to write than a frame: written
 * at once, the map stops for the whole of it. They are written in steps instead, each of the rows
 * that fit in a budget of time (`BULK_SLICE_BUDGET_MS`), one transaction per step, the next step
 * in a later task, so the map draws between two of them. The rows not written yet are drawn moved
 * by their moving set, as they were while dragged (the caller keeps it), and a row leaves it in
 * the task it is written in: what is seen does not jump.
 *
 * - The rows are planned in the step that writes them, from the values they have then. A row
 *   changed from elsewhere meanwhile is written from its values with that change (the move is
 *   made to what it is then); a row deleted meanwhile is left out; a row locked meanwhile is left
 *   as it is (`skipLocked`), and leaves the moving set with the others of its step. A locked row
 *   when the drag is let go refuses the whole, as before
 * - Another write of this client finishes the rest at once before it is made (the Store, see
 *   `Store.beginSlicedWrite`), so the writes keep their order; a write from elsewhere does not
 * - The end is told once, when the last rows are written (`onDone`): the end of the drag is
 *   announced then, so what keeps a drag as one step of the history keeps all the steps
 */

import type { BulkOperation } from '../feature-table/bulk-plan.js';
import { TableSelection } from '../feature-table/selection.js';
import { BULK_SLICE_BUDGET_MS, BULK_SLICE_ROWS } from '../store/row-steps.js';
import type { SlicedWrite, Store } from '../store/store.js';
import { rowsLocked } from './bulk-selection.js';
import type { BulkKinds } from './bulk-transform.js';

export { BULK_SLICE_BUDGET_MS, BULK_SLICE_ROWS };

/**
 * How a write in steps goes
 *
 * @internal
 */
export interface SlicedWriteOptions {
  /** Called in the task the rows were written in (or left out), with them */
  readonly onWritten?: (rows: readonly number[]) => void;
  /** Called once, after the last rows: whether anything was written */
  readonly onDone: (written: boolean) => void;
  /** The time of a step (ms) */
  readonly budgetMs?: number;
  /** Runs the next step in a later task (`setTimeout` by default) */
  readonly schedule?: (step: () => void) => void;
  /** The clock of the budget (`performance.now` by default) */
  readonly now?: () => number;
}

/** An operation that leaves a row locked meanwhile as it is */
function skippingLocked(op: BulkOperation): BulkOperation {
  return op.kind === 'rows' ? { ...op, skipLocked: true } : op;
}

/**
 * Writes the kinds of rows of an operation in steps; the first step is made now
 *
 * @returns false when refused at once (no rows, or a row locked): `onDone(false)` was called
 * @internal
 */
export function writeKindsInSlices(
  store: Store,
  rows: TableSelection,
  kinds: BulkKinds,
  options: SlicedWriteOptions,
): boolean {
  if (rows.count === 0 || rowsLocked(store, rows)) {
    options.onDone(false);
    return false;
  }
  const budget = options.budgetMs ?? BULK_SLICE_BUDGET_MS;
  const schedule = options.schedule ?? ((step: () => void) => void setTimeout(step, 0));
  const now = options.now ?? (() => performance.now());
  const ops = kinds.map((kind) => skippingLocked(kind.op));
  let kind = 0;
  let at = 0;
  let written = false;
  let ended = false;

  /** Writes rows until the deadline, in one transaction */
  const writeUntil = (deadline: number): void => {
    store.runSlicedStep(() =>
      store.transact(() => {
        while (kind < kinds.length) {
          const list = kinds[kind].rows;
          const op = ops[kind];
          if (at >= list.length) {
            kind++;
            at = 0;
            continue;
          }
          const slice = list.slice(at, at + BULK_SLICE_ROWS);
          at += slice.length;
          if (at >= list.length) {
            kind++;
            at = 0;
          }
          if (store.applyBulk(op, TableSelection.of(slice))) written = true;
          options.onWritten?.(slice);
          if (now() >= deadline) break;
        }
      }),
    );
  };
  const end = (): void => {
    if (ended) return;
    ended = true;
    store.endSlicedWrite(write);
    options.onDone(written);
  };
  const write: SlicedWrite = {
    finish: () => {
      if (ended) return;
      writeUntil(Number.POSITIVE_INFINITY);
      end();
    },
  };
  const step = (): void => {
    if (ended) return;
    writeUntil(now() + budget);
    if (kind >= kinds.length) end();
    else schedule(step);
  };
  store.beginSlicedWrite(write);
  step();
  return true;
}
