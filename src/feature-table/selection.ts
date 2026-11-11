// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A selection of many rows held as columns: the set of their handles
 *
 * A selection of more features than the selection lists the IDs of is not a list of IDs: it is the
 * set of the handles of its rows. The set is the one place the selection is kept; the bits the rows
 * are marked with for the drawing are made from it (`RowStateSets.setBulk`).
 *
 * A set never changes once made: adding and taking out rows make a new one, so a set kept for
 * later (the selection before an operation, to put it back after an undo) stays as it was.
 */

import type { RowHandle } from '@sakuzu/kasane';

/**
 * A set of the handles of rows, kept sorted
 *
 * @internal
 */
export class TableSelection {
  /** The handles, ascending, each once */
  readonly handles: Int32Array;
  /** One bit per handle, made when first asked (the handles are dense) */
  #bits: Uint32Array | null = null;

  private constructor(handles: Int32Array) {
    this.handles = handles;
  }

  /** An empty set */
  static readonly empty = new TableSelection(new Int32Array(0));

  /**
   * The set of these handles (in any order, repeated or not; negative ones left out)
   */
  static of(handles: ArrayLike<number>): TableSelection {
    if (handles.length === 0) return TableSelection.empty;
    const sorted = Int32Array.from(handles).sort();
    let n = 0;
    for (let i = 0; i < sorted.length; i++) {
      const handle = sorted[i];
      if (handle < 0) continue;
      if (n > 0 && sorted[n - 1] === handle) continue;
      sorted[n++] = handle;
    }
    return n === 0 ? TableSelection.empty : new TableSelection(sorted.slice(0, n));
  }

  /** The number of rows */
  get count(): number {
    return this.handles.length;
  }

  /** Whether the row of a handle is in the set */
  has(handle: RowHandle): boolean {
    if (handle < 0 || this.handles.length === 0) return false;
    const last = this.handles[this.handles.length - 1];
    if (handle > last) return false;
    let bits = this.#bits;
    if (!bits) {
      bits = new Uint32Array((last >>> 5) + 1);
      for (const h of this.handles) bits[h >>> 5] |= 1 << (h & 31);
      this.#bits = bits;
    }
    return (bits[handle >>> 5] & (1 << (handle & 31))) !== 0;
  }

  /** The set with these rows added (this set when none is new) */
  with(handles: ArrayLike<number>): TableSelection {
    const added: number[] = [];
    for (let i = 0; i < handles.length; i++) {
      if (handles[i] >= 0 && !this.has(handles[i])) added.push(handles[i]);
    }
    if (added.length === 0) return this;
    const all = new Int32Array(this.handles.length + added.length);
    all.set(this.handles);
    all.set(added, this.handles.length);
    return TableSelection.of(all);
  }

  /** The set without these rows (this set when none is in it) */
  without(handles: ArrayLike<number>): TableSelection {
    const removed = new Set<number>();
    for (let i = 0; i < handles.length; i++) if (this.has(handles[i])) removed.add(handles[i]);
    if (removed.size === 0) return this;
    return this.filter((handle) => !removed.has(handle));
  }

  /** The rows of the set a test keeps (this set when it keeps them all) */
  filter(keep: (handle: RowHandle) => boolean): TableSelection {
    const kept = new Int32Array(this.handles.length);
    let n = 0;
    for (const handle of this.handles) if (keep(handle)) kept[n++] = handle;
    if (n === this.handles.length) return this;
    return n === 0 ? TableSelection.empty : new TableSelection(kept.slice(0, n));
  }

  /** Whether two sets hold the same rows */
  equals(other: TableSelection): boolean {
    if (other === this) return true;
    if (other.handles.length !== this.handles.length) return false;
    for (let i = 0; i < this.handles.length; i++) {
      if (other.handles[i] !== this.handles[i]) return false;
    }
    return true;
  }

  /** The bytes the set holds (its handles and its bits) */
  get byteLength(): number {
    return this.handles.byteLength + (this.#bits?.byteLength ?? 0);
  }
}
