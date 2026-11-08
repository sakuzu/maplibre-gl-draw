// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

import {
  encodeUtf8Into,
  equalUtf8,
  equalUtf8Bytes,
  hashByteRun,
  hashUtf8,
  type Utf8Column,
  utf8ColumnFromStrings,
  utf8String,
} from '@sakuzu/tabane';
import type { RowGroupHandle, RowHandle } from './types.js';

/** A slot of the table that never held a handle */
const EMPTY = -1;
/** A slot whose handle was removed (the probing goes on past it) */
const REMOVED = -2;

/**
 * The ids of the rows, their handles, and where each row is
 *
 * @internal
 */
export class IdIndex {
  /** The handle in each slot (EMPTY or REMOVED for none); the length is a power of two */
  private slots: Int32Array = new Int32Array(64).fill(EMPTY);
  /** The number of slots in use, removed ones included (what fills the table) */
  private used = 0;
  /** The columns the ids are read from */
  private readonly sources: Utf8Column[] = [];
  /** The index in `sources` of the column of each handle's id (-1 for a removed handle) */
  private sourceOf: Int32Array = new Int32Array(64).fill(-1);
  /** The entry of that column */
  private entryOf: Int32Array = new Int32Array(64);
  /** The hash of each handle's id */
  private hashOf: Uint32Array = new Uint32Array(64);
  /** The row group of each handle (-1 when the row is in none) */
  private groupOf: Int32Array = new Int32Array(64).fill(-1);
  /** The row of each handle in its row group */
  private rowOf: Int32Array = new Int32Array(64).fill(-1);
  /** The place of each handle among the changed rows (-1 for none) */
  private deltaOf: Int32Array = new Int32Array(64).fill(-1);
  /** The layer of the changed rows each handle is among (-1 for none) */
  private deltaLayerOf: Int32Array = new Int32Array(64).fill(-1);
  /** Whether each handle is found by its id (a handle forgotten is not, until it is freed) */
  private linkedOf: Uint8Array = new Uint8Array(64);
  /** The number of the handles whose id is read from each column of `sources` */
  private readonly sourceRefs: number[] = [];
  /** The handles freed, given again to new ids */
  private readonly freeList: number[] = [];
  /** The number of handles given */
  private count = 0;
  /** The bytes of the id looked up last by `handleOf` (grown to the longest one, never shrunk) */
  private scratch = new Uint8Array(256);
  /**
   * The id `handleOf` looked up last and its answer, while the table has not changed since
   * (`changes`): one write of a row looks its id up several times
   */
  private lastId: string | null = null;
  private lastHandle: RowHandle = -1;
  private lastChanges = -1;
  /** Changes whenever an id gets a handle or loses it */
  private changes = 0;

  /** The number of handles given (no handle is this number or more) */
  get size(): number {
    return this.count;
  }

  /** A number that changes whenever an id gets a handle or loses it */
  get version(): number {
    return this.changes;
  }

  /** The number of handles in use (given and not freed) */
  get live(): number {
    return this.count - this.freeList.length;
  }

  /**
   * The handle of each entry of a column, given to the ids not seen yet
   *
   * @param hashes The hash of each entry (computed when omitted)
   * @returns The handle of each entry
   */
  allocate(ids: Utf8Column, hashes?: Uint32Array): Int32Array {
    const n = ids.offsets.length - 1;
    const out = new Int32Array(n);
    let source = -1;
    for (let i = 0; i < n; i++) {
      const hash = hashes ? hashes[i] : hashUtf8(ids, i);
      let handle = this.find(ids, i, hash);
      if (handle < 0) {
        if (source < 0) {
          source = this.sources.length;
          this.sources.push(ids);
          this.sourceRefs.push(0);
        }
        handle = this.insert(source, i, hash);
      }
      out[i] = handle;
    }
    return out;
  }

  /**
   * The handle of an id, or -1 when it has none
   */
  handleOf(id: string): RowHandle {
    if (id === this.lastId && this.lastChanges === this.changes) return this.lastHandle;
    // The bytes of the id written into an array kept for it: nothing is made per look-up
    if (this.scratch.length < id.length * 3) this.scratch = new Uint8Array(id.length * 3);
    const bytes = this.scratch;
    const length = encodeUtf8Into(id, bytes);
    const hash = hashByteRun(bytes, 0, length);
    const mask = this.slots.length - 1;
    let slot = hash & mask;
    let found: RowHandle = -1;
    for (;;) {
      const handle = this.slots[slot];
      if (handle === EMPTY) break;
      if (
        handle >= 0 &&
        this.hashOf[handle] === hash &&
        equalUtf8Bytes(this.sources[this.sourceOf[handle]], this.entryOf[handle], bytes, length)
      ) {
        found = handle;
        break;
      }
      slot = (slot + 1) & mask;
    }
    this.lastId = id;
    this.lastHandle = found;
    this.lastChanges = this.changes;
    return found;
  }

  /**
   * The handle of entry `index` of a column, or -1 when it has none
   */
  handleOfEntry(ids: Utf8Column, index: number, hash = hashUtf8(ids, index)): RowHandle {
    return this.find(ids, index, hash);
  }

  /** The id of a handle (undefined for a handle that was never given or was removed) */
  idOf(handle: RowHandle): string | undefined {
    if (!this.has(handle)) return undefined;
    return utf8String(this.sources[this.sourceOf[handle]], this.entryOf[handle]);
  }

  /** Whether the handle was given and not removed */
  has(handle: RowHandle): boolean {
    return handle >= 0 && handle < this.count && this.sourceOf[handle] >= 0;
  }

  /**
   * Takes a handle out of the table: its id gets a new handle the next time it is seen
   */
  remove(handle: RowHandle): void {
    if (!this.has(handle)) return;
    this.unlink(handle);
    this.unref(this.sourceOf[handle]);
    this.sourceOf[handle] = -1;
    this.groupOf[handle] = -1;
    this.rowOf[handle] = -1;
    this.deltaOf[handle] = -1;
    this.deltaLayerOf[handle] = -1;
  }

  /**
   * Moves the id of a handle to another column (the column of the row group that now holds the
   * row), so the column it was first read from is not kept for it
   */
  rehome(handle: RowHandle, ids: Utf8Column, index: number): void {
    if (!this.has(handle)) return;
    let source = this.sources.lastIndexOf(ids);
    if (source < 0) {
      source = this.sources.length;
      this.sources.push(ids);
      this.sourceRefs.push(0);
    }
    if (source === this.sourceOf[handle]) {
      this.entryOf[handle] = index;
      return;
    }
    this.sourceRefs[source]++;
    this.unref(this.sourceOf[handle]);
    this.sourceOf[handle] = source;
    this.entryOf[handle] = index;
  }

  /**
   * Takes a handle out of the table of the ids: its id gets a new handle the next time it is seen,
   * while the handle keeps its id and where its row is until it is freed
   */
  unlink(handle: RowHandle): void {
    if (!this.has(handle) || this.linkedOf[handle] === 0) return;
    this.changes++;
    const mask = this.slots.length - 1;
    let slot = this.hashOf[handle] & mask;
    while (this.slots[slot] !== EMPTY) {
      if (this.slots[slot] === handle) {
        this.slots[slot] = REMOVED;
        break;
      }
      slot = (slot + 1) & mask;
    }
    this.linkedOf[handle] = 0;
  }

  /** Whether a handle is found by its id (given, and neither unlinked nor freed) */
  isLinked(handle: RowHandle): boolean {
    return this.has(handle) && this.linkedOf[handle] === 1;
  }

  /**
   * Frees a handle: it is unlinked, forgets its id and its place, and is given again to a new id
   */
  free(handle: RowHandle): void {
    if (!this.has(handle)) return;
    this.unlink(handle);
    this.unref(this.sourceOf[handle]);
    this.sourceOf[handle] = -1;
    this.groupOf[handle] = -1;
    this.rowOf[handle] = -1;
    this.deltaOf[handle] = -1;
    this.deltaLayerOf[handle] = -1;
    this.freeList.push(handle);
  }

  /** One handle less reads its id from a column: the column is let go of when none does */
  private unref(source: number): void {
    if (source < 0) return;
    this.sourceRefs[source]--;
    if (this.sourceRefs[source] <= 0) this.sources[source] = EMPTY_COLUMN;
  }

  // === Where the rows are ===

  /** The row group of a handle (-1 when the row is in none) */
  mainGroup(handle: RowHandle): RowGroupHandle {
    return handle >= 0 && handle < this.count ? this.groupOf[handle] : -1;
  }

  /** The row of a handle in its row group (-1 when the row is in none) */
  mainRow(handle: RowHandle): number {
    return handle >= 0 && handle < this.count ? this.rowOf[handle] : -1;
  }

  /** The place of a handle among the changed rows (-1 for none) */
  deltaSlot(handle: RowHandle): number {
    return handle >= 0 && handle < this.count ? this.deltaOf[handle] : -1;
  }

  /** The layer of the changed rows a handle is among (-1 for none) */
  deltaLayer(handle: RowHandle): number {
    return handle >= 0 && handle < this.count ? this.deltaLayerOf[handle] : -1;
  }

  /** Records where the row of a handle is */
  setMain(handle: RowHandle, group: RowGroupHandle, row: number): void {
    this.groupOf[handle] = group;
    this.rowOf[handle] = row;
  }

  /**
   * Records the place of a handle among the changed rows of a layer (`layer` and `slot` -1 for
   * none)
   */
  setDelta(handle: RowHandle, layer: number, slot: number): void {
    this.deltaLayerOf[handle] = layer;
    this.deltaOf[handle] = slot;
  }

  // === The table ===

  /** The handle of an id, or -1 */
  private find(ids: Utf8Column, index: number, hash: number): RowHandle {
    const mask = this.slots.length - 1;
    let slot = hash & mask;
    for (;;) {
      const handle = this.slots[slot];
      if (handle === EMPTY) return -1;
      if (
        handle >= 0 &&
        this.hashOf[handle] === hash &&
        equalUtf8(this.sources[this.sourceOf[handle]], this.entryOf[handle], ids, index)
      ) {
        return handle;
      }
      slot = (slot + 1) & mask;
    }
  }

  /** Gives a new handle to an id that has none (a handle freed, when there is one) */
  private insert(source: number, index: number, hash: number): RowHandle {
    this.changes++;
    const handle = this.freeList.length > 0 ? (this.freeList.pop() as number) : this.count++;
    this.reserve(this.count);
    this.sourceOf[handle] = source;
    this.sourceRefs[source]++;
    this.entryOf[handle] = index;
    this.hashOf[handle] = hash;
    this.groupOf[handle] = -1;
    this.rowOf[handle] = -1;
    this.deltaOf[handle] = -1;
    this.deltaLayerOf[handle] = -1;
    this.linkedOf[handle] = 1;
    if ((this.used + 1) * 2 > this.slots.length) this.rehash(handle);
    const mask = this.slots.length - 1;
    let slot = hash & mask;
    while (this.slots[slot] >= 0) slot = (slot + 1) & mask;
    if (this.slots[slot] === EMPTY) this.used++;
    this.slots[slot] = handle;
    return handle;
  }

  /**
   * Builds the table again at a size that keeps it at most half full (removed slots dropped)
   *
   * @param inserting The handle being inserted, which has no slot yet
   */
  private rehash(inserting: RowHandle): void {
    let live = 0;
    for (let handle = 0; handle < this.count; handle++) {
      if (this.sourceOf[handle] >= 0 && this.linkedOf[handle] === 1) live++;
    }
    let size = 64;
    while (size < (live + 1) * 4) size *= 2;
    const slots = new Int32Array(size).fill(EMPTY);
    const mask = size - 1;
    for (let handle = 0; handle < this.count; handle++) {
      if (this.sourceOf[handle] < 0 || this.linkedOf[handle] === 0) continue;
      if (handle === inserting) continue;
      let slot = this.hashOf[handle] & mask;
      while (slots[slot] !== EMPTY) slot = (slot + 1) & mask;
      slots[slot] = handle;
    }
    this.slots = slots;
    this.used = live - 1;
  }

  /** Makes the arrays per handle hold at least `n` handles */
  private reserve(n: number): void {
    if (n <= this.sourceOf.length) return;
    let size = this.sourceOf.length * 2;
    while (size < n) size *= 2;
    this.sourceOf = grow(this.sourceOf, size, -1);
    this.entryOf = grow(this.entryOf, size, 0);
    this.hashOf = growUint(this.hashOf, size);
    this.groupOf = grow(this.groupOf, size, -1);
    this.rowOf = grow(this.rowOf, size, -1);
    this.deltaOf = grow(this.deltaOf, size, -1);
    this.deltaLayerOf = grow(this.deltaLayerOf, size, -1);
    const linked = new Uint8Array(size);
    linked.set(this.linkedOf);
    this.linkedOf = linked;
  }
}

/** The column of a source no handle reads its id from any more */
const EMPTY_COLUMN: Utf8Column = utf8ColumnFromStrings([]);

function grow(array: Int32Array, size: number, fill: number): Int32Array {
  const next = new Int32Array(size).fill(fill);
  next.set(array);
  return next;
}

function growUint(array: Uint32Array, size: number): Uint32Array {
  const next = new Uint32Array(size);
  next.set(array);
  return next;
}
