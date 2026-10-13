// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The rows of a layer changed since their row groups were built (`DeltaRows`)
 *
 * A row whose change cannot be written into its group in place (it moves in the order or to
 * another layer, its shape no longer fits its place in the GPU chunk, it is new) is held here
 * until the next version of the group its key falls in takes it. The delta has the columns of a
 * row group: its rows are one row group in the order of the layer, made again when rows come in
 * or leave (`rebuild`), and written in place as the rows of a group are otherwise. While a row is
 * in the delta, its copy in its group is hidden and not read: the delta copy is the row.
 *
 * Every row of the delta has the number of the change it was last written in, so the next
 * version of a group, which takes the rows of the delta written up to a number when it starts,
 * leaves the rows written after it in the delta. Every row also has a copy number for the
 * drawings that number the copies of the rows (a draped drawing keeps one element per copy): it
 * is given when the row comes into the delta and kept until it leaves, whatever the rows are made
 * again around it.
 */

import type { RowGroup } from './layer-table.js';
import type { RowGroupHandle, RowHandle } from './types.js';

/**
 * The rows of a layer changed since their groups were built
 *
 * @internal
 */
export class DeltaRows {
  /** The rows in the order of the layer, as one row group (null when there is none) */
  private rowGroup: RowGroup | null = null;
  /** The number each row was last written in, by row of the group */
  private written: Float64Array = new Float64Array(0);
  /** The copy number of each handle */
  private readonly copies = new Map<RowHandle, number>();
  private readonly freeCopies: number[] = [];
  private nextCopy = 0;
  private revisionCount = 0;

  /** @param handle The handle the drawing knows the rows of the delta by */
  constructor(readonly handle: RowGroupHandle) {}

  /** The rows (null when there is none) */
  get group(): RowGroup | null {
    return this.rowGroup;
  }

  /** The number of rows */
  get length(): number {
    return this.rowGroup?.data.length ?? 0;
  }

  /** Advances whenever rows come in, leave or are made again (`rebuild`) */
  get revision(): number {
    return this.revisionCount;
  }

  /** The number a row was last written in */
  writtenOf(row: number): number {
    return this.written[row];
  }

  /** Records the number a row is written in */
  setWritten(row: number, number: number): void {
    this.written[row] = number;
  }

  /** The copy number of a handle in the delta (-1 for a handle not in it) */
  copyOf(handle: RowHandle): number {
    return this.copies.get(handle) ?? -1;
  }

  /** The number of copy numbers given (the highest one plus one) */
  get copyRange(): number {
    return this.nextCopy;
  }

  /**
   * Puts the rows made again in place
   *
   * @param group The rows (null for none)
   * @param written The number each row was last written in
   */
  rebuild(group: RowGroup | null, written: Float64Array): void {
    const before = this.rowGroup;
    const kept = new Set<RowHandle>();
    if (group) {
      for (const handle of group.data.handles) kept.add(handle);
    }
    if (before) {
      for (const handle of before.data.handles) {
        if (kept.has(handle)) continue;
        const copy = this.copies.get(handle);
        if (copy === undefined) continue;
        this.copies.delete(handle);
        this.freeCopies.push(copy);
      }
    }
    for (const handle of kept) {
      if (this.copies.has(handle)) continue;
      this.copies.set(handle, this.freeCopies.pop() ?? this.nextCopy++);
    }
    this.rowGroup = group;
    this.written = written;
    this.revisionCount++;
  }
}
