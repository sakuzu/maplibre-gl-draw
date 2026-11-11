// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The runs of the rows of a row group the walk of the order passes (`RowSkips`)
 *
 * The walk of the items of a layer reads the rows next to a row, and passes the rows that are not
 * items: the deleted rows, and the copies of rows read elsewhere. Rows deleted one write after
 * the other stay in their groups until their next versions, so a walk that passed them one at a
 * time would cost every row deleted before it, and many deletions the square of their number.
 * Each row group a walk reads keeps, for its rows, how far down and up the rows it passes run
 * (pointers made shorter as they are followed, as a union-find does), so a run is passed in a
 * few steps.
 *
 * A row only ever becomes passed (deleted, read elsewhere) without the pointers changing: a run
 * they say is passed stays passed. A row that becomes read again (a deletion undone) makes them
 * be made again at the next walk.
 */

import { ROW_FLAG_DELETED } from '../table/row-group-types.js';
import type { RowGroup } from './layer-table.js';
import { STATE_ELSEWHERE } from './row-state.js';

/**
 * Whether a row of a group is read there in the order of its layer: not the copy of a row read
 * elsewhere (a row of the delta or of the new rows is read where it is)
 *
 * @internal
 */
export function readThere(group: RowGroup, row: number): boolean {
  return group.delta || group.pending || (group.state[row] & STATE_ELSEWHERE) === 0;
}

/**
 * Whether the walk of the order reads a row of a group as an item: read there, and not deleted
 *
 * @internal
 */
export function walkReads(group: RowGroup, row: number): boolean {
  return (group.data.flags[row] & ROW_FLAG_DELETED) === 0 && readThere(group, row);
}

/**
 * The runs of the rows a walk passes in one row group
 *
 * @internal
 */
export class RowSkips {
  /** For a row passed: a row below it such that every row from just above it to it is passed */
  private down: Int32Array | null = null;
  /** For a row passed: a row above it such that every row from it to just below it is passed */
  private up: Int32Array | null = null;
  /** Whether a row became read since the pointers were made (they are made again) */
  private stale = true;
  /** The number of rows the walks looked at (what a test of the cost reads) */
  steps = 0;

  /**
   * @param group The row group
   * @param reads Whether a row is read, not passed
   */
  constructor(
    private readonly group: RowGroup,
    private readonly reads: (group: RowGroup, row: number) => boolean = walkReads,
  ) {}

  /** A row of the group became read again: the pointers are made again at the next walk */
  touch(): void {
    this.stale = true;
  }

  /** The last row at or before a row that the walk reads (-1 for none) */
  lastAtOrBefore(row: number): number {
    if (row < 0) return -1;
    const down = this.pointers().down;
    let at = row;
    while (at >= 0) {
      this.steps++;
      if (this.reads(this.group, at)) break;
      at = down[at] < at ? down[at] : at - 1;
    }
    // Every row passed on the way runs down to the row found
    let fix = row;
    while (fix > at) {
      const next = down[fix] < fix ? down[fix] : fix - 1;
      down[fix] = at;
      fix = next;
    }
    return at;
  }

  /** The first row at or after a row that the walk reads (the number of rows for none) */
  firstAtOrAfter(row: number): number {
    const n = this.group.data.length;
    if (row >= n) return n;
    const up = this.pointers().up;
    let at = row;
    while (at < n) {
      this.steps++;
      if (this.reads(this.group, at)) break;
      at = up[at] > at ? up[at] : at + 1;
    }
    let fix = row;
    while (fix < at) {
      const next = up[fix] > fix ? up[fix] : fix + 1;
      up[fix] = at;
      fix = next;
    }
    return at;
  }

  /** The pointers, made again (each row pointing to itself) when a row became read */
  private pointers(): { down: Int32Array; up: Int32Array } {
    const n = this.group.data.length;
    if (!this.down || !this.up) {
      this.down = new Int32Array(n);
      this.up = new Int32Array(n);
      this.stale = true;
    }
    if (this.stale) {
      for (let r = 0; r < n; r++) {
        this.down[r] = r;
        this.up[r] = r;
      }
      this.stale = false;
    }
    return { down: this.down, up: this.up };
  }
}

/** The runs of each row group a walk read: of the rows not items, of the rows read elsewhere */
const SKIPS = new WeakMap<RowGroup, RowSkips>();
const ELSEWHERE_SKIPS = new WeakMap<RowGroup, RowSkips>();

/**
 * The runs of the rows a walk of the items passes in a row group: deleted, or read elsewhere
 * (made at the first walk of it)
 *
 * @internal
 */
export function skipsOf(group: RowGroup): RowSkips {
  let skips = SKIPS.get(group);
  if (!skips) {
    skips = new RowSkips(group, walkReads);
    SKIPS.set(group, skips);
  }
  return skips;
}

/**
 * The runs of the rows of a row group of the order read elsewhere (the copies of rows moved to
 * the delta or to another group), which a walk of the rows passes
 *
 * @internal
 */
export function elsewhereSkipsOf(group: RowGroup): RowSkips {
  let skips = ELSEWHERE_SKIPS.get(group);
  if (!skips) {
    skips = new RowSkips(group, readThere);
    ELSEWHERE_SKIPS.set(group, skips);
  }
  return skips;
}

/**
 * Notes a write of the state of a row (its flags written before): a row read now may have been
 * passed, so the runs of its group are made again
 *
 * @internal
 */
export function noteRowState(group: RowGroup, row: number): void {
  const skips = SKIPS.get(group);
  if (skips && walkReads(group, row)) skips.touch();
  const elsewhere = ELSEWHERE_SKIPS.get(group);
  if (elsewhere && readThere(group, row)) elsewhere.touch();
}
