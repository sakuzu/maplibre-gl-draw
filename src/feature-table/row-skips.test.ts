// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The runs of the rows a walk passes in a row group: the row found is the one a walk a row at a
 * time finds, through deletions and deletions undone, and a run of deleted rows costs a few
 * steps
 */

import { describe, expect, it } from 'vitest';
import { ROW_FLAG_DELETED } from '../table/row-group-types.js';
import type { RowGroup } from './layer-table.js';
import { noteRowState, skipsOf, walkReads } from './row-skips.js';
import { STATE_HIDDEN_DELTA } from './row-state.js';

/** A row group of `n` rows of the order, with only what the walk reads of it */
function group(n: number): RowGroup {
  return {
    data: { length: n, flags: new Uint8Array(n) },
    state: new Uint16Array(n),
    delta: false,
    pending: false,
  } as unknown as RowGroup;
}

/** Deletes a row, or writes it not deleted, and notes it as a write of its state does */
function setDeleted(of: RowGroup, row: number, deleted: boolean): void {
  const flags = of.data.flags as Uint8Array;
  flags[row] = deleted ? flags[row] | ROW_FLAG_DELETED : flags[row] & ~ROW_FLAG_DELETED;
  noteRowState(of, row);
}

/** A random number generator of a seed (the same rows every run) */
function random(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
}

describe('the runs of the rows a walk passes', () => {
  it('finds the rows a walk a row at a time finds, through deletions undone', () => {
    const n = 300;
    const of = group(n);
    const skips = skipsOf(of);
    const next = random(7);
    for (let step = 0; step < 3000; step++) {
      const row = Math.floor(next() * n);
      // Mostly deletions, so that runs of deleted rows grow; some undone
      if (next() < 0.8) setDeleted(of, row, true);
      else setDeleted(of, row, false);
      // A copy of a row read elsewhere is passed too
      if (step % 97 === 0) {
        of.state[row] = STATE_HIDDEN_DELTA;
        noteRowState(of, row);
      }
      const at = Math.floor(next() * n);
      let down = at;
      while (down >= 0 && !walkReads(of, down)) down--;
      let up = at;
      while (up < n && !walkReads(of, up)) up++;
      expect(skips.lastAtOrBefore(at)).toBe(down);
      expect(skips.firstAtOrAfter(at)).toBe(up);
    }
  });

  it('passes a run of deleted rows in a few steps', () => {
    const n = 4000;
    const of = group(n);
    const skips = skipsOf(of);
    // Deleted from the front, each walk passing every row deleted before it; then from the back
    for (let row = 0; row < n; row++) {
      setDeleted(of, row, true);
      expect(skips.lastAtOrBefore(row)).toBe(-1);
    }
    const after = group(n);
    const up = skipsOf(after);
    for (let row = n - 1; row >= 0; row--) {
      setDeleted(after, row, true);
      expect(up.firstAtOrAfter(row)).toBe(n);
    }
    // A row at a time would be about n * n / 2 steps
    expect(skips.steps).toBeLessThanOrEqual(3 * n);
    expect(up.steps).toBeLessThanOrEqual(3 * n);
  });
});
