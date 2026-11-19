// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The sets of IDs the instance hands out for rows (`IdSet`): a copy of the references of the
 * rows, read as IDs
 *
 * A set keeps the references of its rows, not their IDs: an ID is read from the reference of its
 * row when it is read, so that a set of many rows makes no array of IDs. The reference of a row
 * lasts only as long as the row: once a deleted row is let go of, its reference may be given to
 * another row. The layer over the Store tells every set alive the rows a change deletes, while
 * the change is told (when their IDs are still read from them), and a set then copies the IDs of
 * those of its rows, which it reads from the copy afterwards. So the set stays the set it was
 * when it was given.
 */

import { DrawError } from '../errors.js';
import type { IdSet } from '../model.js';

/** The most IDs `toArray` gives in one array */
const ARRAY_LIMIT = 10_000;

/** What a set reads the IDs of its rows from */
export interface RowIds {
  /** The ID of the row of a reference (undefined for none) */
  getRowId(ref: number): string | undefined;
  /** The reference of the row of an ID that is not deleted (undefined for none) */
  getRowRef(id: string): number | undefined;
}

/**
 * A set of the IDs of rows, over a copy of their references, in order, each once
 *
 * @internal
 */
export class RowIdSet implements IdSet {
  readonly #rows: RowIds;
  /** The references, in the order of the set; never changed */
  readonly #refs: Int32Array;
  /** The same references in rising order, to find a row */
  readonly #sorted: Int32Array;
  /** The IDs of the rows deleted since the set was given, by their references */
  readonly #copied = new Map<number, string>();
  /** The same IDs, for `has` */
  readonly #copiedIds = new Set<string>();

  /** @param refs - The references of the rows, each once (the set keeps them as they are) */
  constructor(rows: RowIds, refs: Int32Array) {
    this.#rows = rows;
    this.#refs = refs;
    this.#sorted = refs.slice().sort();
  }

  count(): number {
    return this.#refs.length;
  }

  has(id: string): boolean {
    if (typeof id !== 'string') return false;
    if (this.#copiedIds.has(id)) return true;
    const ref = this.#rows.getRowRef(id);
    return ref !== undefined && this.#holds(ref) && !this.#copied.has(ref);
  }

  *iterate(): IterableIterator<string> {
    const refs = this.#refs;
    for (let i = 0; i < refs.length; i++) {
      const id = this.#idAt(i);
      if (id !== undefined) yield id;
    }
  }

  toArray(): string[] {
    const refs = this.#refs;
    if (refs.length > ARRAY_LIMIT) {
      throw new DrawError(
        'tooManyItems',
        `The set holds ${refs.length} IDs, more than ${ARRAY_LIMIT} for one array; read them with iterate`,
      );
    }
    const out: string[] = [];
    for (let i = 0; i < refs.length; i++) {
      const id = this.#idAt(i);
      if (id !== undefined) out.push(id);
    }
    return out;
  }

  /**
   * Copies the IDs of the rows of the set among the rows a change deleted, while the change is
   * told: the work is that of the smaller of the two
   *
   * @param deleted - The references of the rows deleted, by layer
   * @param count - How many they are
   * @returns How many IDs were copied
   */
  rowsDeleted(deleted: Iterable<Int32Array>, count: number): number {
    let copied = 0;
    const refs = this.#refs;
    if (refs.length <= count) {
      // Each row of the set: a deleted one is no longer found by its ID
      for (let i = 0; i < refs.length; i++) {
        const ref = refs[i];
        if (this.#copied.has(ref)) continue;
        const id = this.#rows.getRowId(ref);
        if (id === undefined || this.#rows.getRowRef(id) === ref) continue;
        this.#copy(ref, id);
        copied += 1;
      }
      return copied;
    }
    for (const list of deleted) {
      for (let k = 0; k < list.length; k++) {
        const ref = list[k];
        if (!this.#holds(ref) || this.#copied.has(ref)) continue;
        const id = this.#rows.getRowId(ref);
        if (id === undefined) continue;
        this.#copy(ref, id);
        copied += 1;
      }
    }
    return copied;
  }

  #copy(ref: number, id: string): void {
    this.#copied.set(ref, id);
    this.#copiedIds.add(id);
  }

  #idAt(at: number): string | undefined {
    const ref = this.#refs[at];
    return this.#copied.get(ref) ?? this.#rows.getRowId(ref);
  }

  /** Whether the set holds a reference */
  #holds(ref: number): boolean {
    const sorted = this.#sorted;
    let lo = 0;
    let hi = sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid] < ref) lo = mid + 1;
      else hi = mid;
    }
    return lo < sorted.length && sorted[lo] === ref;
  }
}
