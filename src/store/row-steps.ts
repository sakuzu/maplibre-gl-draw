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
 * was made in (an undo is one step for whoever keeps the steps of the writes: its stamps and what
 * keeps its rows are told once).
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
import type { DocumentSnapshot, LastingSnapshot } from './read-snapshot.js';
import type { ItemPlacement, RowValues } from './types.js';

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
 * What lets a write of this client made over several tasks be one transaction of a Store of core
 * (the commit of a transaction of `draw.write` too long for one task): its notification held from
 * its first step to its last, and its later steps written into it
 *
 * @internal
 */
export interface HeldWrites {
  /**
   * Holds the notification of the transaction under way (called inside it): `finish` writes the
   * rest and lets go of it, and is called when anything else comes first (a write, a read of the
   * document)
   */
  hold(finish: () => void): void;
  /** Writes a later step into the transaction held (outside a transaction of the Store) */
  step<T>(fn: () => T): T;
  /** Lets go of the notification held: it goes out now (the snapshot ends with it) */
  release(): void;
  /**
   * Begins the snapshot of the write (called in its first step, before it writes): what the
   * instance reads until its last step reads the document as it is now (`read-snapshot.ts`)
   */
  openSnapshot(): void;
  /** Ends the snapshot of a write made in its first step */
  closeSnapshot(): void;
  /** The snapshot of the write over several tasks under way (null for none) */
  snapshot(): DocumentSnapshot | null;
  /**
   * Begins the snapshot of a transaction, kept until it is let go of: the document as the reads of
   * the instance read it now, over any number of commits after
   */
  openLasting(): LastingSnapshot;
  /**
   * Begins a write of rows made in several parts, told as one write of all of them would be: its
   * changes of the order (see `FeatureTablesStoreWriter.watchOrderOf`) and the groups its parts
   * leave without a member are told and deleted by the function returned, called (in a
   * transaction) once the last part is written
   */
  beginRowParts(patch: RowValues): () => void;
  /**
   * The values that put rows in a place, in their order (their parent and the keys of their
   * order among the items there now), to be written in parts: the write of all of them a write
   * that puts them there makes
   */
  placeRows(rows: Int32Array, to: ItemPlacement): RowValues;
}

/**
 * The transactions over several tasks of the Stores of core that have them, by the contract (a
 * Store given by the host writes such a write at once)
 *
 * @internal
 */
export const heldWritesOf = new WeakMap<object, HeldWrites>();

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
