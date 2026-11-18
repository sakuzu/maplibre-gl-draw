// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The amounts of work a Store and the instance over it have done
 *
 * The tests bound the cost of an operation by the amount of work it does, not by the time it
 * takes: the time varies from machine to machine, the amount does not. The places that do the
 * work add to these numbers where they do it (a mark is one addition, in production as in the
 * tests). The numbers belong to one Store, which holds them in a field no other module can
 * name; the instance and the drawing reach them through the Store they already hold. A Store
 * the host wrapped holds none, and the marks then do nothing.
 *
 * Not exported from any entry of the package. The number of the GL draw calls is not counted
 * here: the tests give the map a GL that counts its calls.
 *
 * @internal
 */

/**
 * The numbers of one Store
 *
 * @internal
 */
export interface WorkCounts {
  /** The rows read or written while drawing one frame or running one operation */
  rowsTouched: number;
  /** The objects made: a feature, an array of ids, an object of values per row */
  objectsCreated: number;
  /** The rows written by the parts of an operation that runs in parts (read per part) */
  rowsWritten: number;
  /** The notifications given to the listeners of the Store */
  notifications: number;
  /** The entries of a change looked up to fold a write into the writes before it of its transaction */
  changeLookups: number;
}

/** The field of the Store that holds its numbers */
const WORK_COUNTS = Symbol('work counts');

/**
 * New numbers, all zero
 *
 * @internal
 */
export function createWorkCounts(): WorkCounts {
  return { rowsTouched: 0, objectsCreated: 0, rowsWritten: 0, notifications: 0, changeLookups: 0 };
}

/**
 * Gives the numbers to the object that holds them (a Store, once, when it is made)
 *
 * The field is not enumerable, so the object reads, copies and serializes as before.
 *
 * @internal
 */
export function holdWorkCounts(holder: object, counts: WorkCounts): void {
  Object.defineProperty(holder, WORK_COUNTS, { value: counts });
}

/**
 * The numbers an object holds, or undefined when it holds none
 *
 * @internal
 */
export function workCountsOf(holder: unknown): WorkCounts | undefined {
  if (typeof holder !== 'object' || holder === null) return undefined;
  return (holder as { [WORK_COUNTS]?: WorkCounts })[WORK_COUNTS];
}

/**
 * Adds to one of the numbers (the mark); nothing happens without numbers
 *
 * @internal
 */
export function countWork(
  counts: WorkCounts | undefined,
  kind: keyof WorkCounts,
  amount = 1,
): void {
  if (counts) counts[kind] += amount;
}
