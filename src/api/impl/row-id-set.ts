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

/** The most rows a set looks through one by one to find a row, without its bits */
const LOOKED_THROUGH = 16;

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
  /**
   * One bit per reference from the least one of the set, to find a row: made at the first time
   * it is asked for, for a set of more rows than are looked through one by one
   */
  #bits: Uint32Array | null = null;
  /** The least reference of the set (the first bit) */
  #least = 0;
  /** The IDs of the rows deleted since the set was given, by their references */
  readonly #copied = new Map<number, string>();
  /** The same IDs, for `has` */
  readonly #copiedIds = new Set<string>();

  /** @param refs - The references of the rows, each once (the set keeps them as they are) */
  constructor(rows: RowIds, refs: Int32Array) {
    this.#rows = rows;
    this.#refs = refs;
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
    const refs = this.#refs;
    if (refs.length <= LOOKED_THROUGH) {
      for (let i = 0; i < refs.length; i++) if (refs[i] === ref) return true;
      return false;
    }
    const bits = this.#bits ?? this.#makeBits();
    const at = ref - this.#least;
    if (at < 0 || at >>> 5 >= bits.length) return false;
    return (bits[at >>> 5] & (1 << (at & 31))) !== 0;
  }

  /** Makes the bits of the references (see `#bits`) */
  #makeBits(): Uint32Array {
    const refs = this.#refs;
    let least = refs[0];
    let most = refs[0];
    for (let i = 1; i < refs.length; i++) {
      if (refs[i] < least) least = refs[i];
      else if (refs[i] > most) most = refs[i];
    }
    const bits = new Uint32Array(((most - least) >>> 5) + 1);
    for (let i = 0; i < refs.length; i++) {
      const at = refs[i] - least;
      bits[at >>> 5] |= 1 << (at & 31);
    }
    this.#least = least;
    this.#bits = bits;
    return bits;
  }

  /** The memory the set takes, in bytes: its references, its bits and the IDs it copied */
  get byteLength(): number {
    let bytes = this.#refs.byteLength + (this.#bits?.byteLength ?? 0);
    for (const id of this.#copiedIds) bytes += 2 * id.length;
    return bytes;
  }

  /** Whether the set reads the IDs of its rows from these (it was made by their layer) */
  readsFrom(rows: RowIds): boolean {
    return this.#rows === rows;
  }

  /**
   * The references of the rows of the set that are still there, in the order of the set: a row
   * deleted since the set was given is left out (its reference may be another row's now)
   *
   * @returns The references the set holds, as they are when none is deleted (not to be written)
   */
  rowRefs(): Int32Array {
    if (this.#copied.size === 0) return this.#refs;
    const refs = this.#refs;
    const out = new Int32Array(refs.length - this.#copied.size);
    let at = 0;
    for (let i = 0; i < refs.length; i++) {
      if (!this.#copied.has(refs[i]) && at < out.length) out[at++] = refs[i];
    }
    return at === out.length ? out : out.subarray(0, at);
  }
}
