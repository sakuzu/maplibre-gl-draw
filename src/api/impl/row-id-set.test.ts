// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The sets of the IDs of rows: the references of the rows in their order, and one bit per
 * reference to find a row, read as IDs
 */

import { describe, expect, it } from 'vitest';
import { RowIdSet, type RowIds } from './row-id-set.js';

/** The rows of a document whose row `ref` has the ID `r<ref>` */
function rowsOf(deleted: ReadonlySet<number> = new Set()): RowIds {
  return {
    getRowId: (ref) => (ref >= 0 ? `r${ref}` : undefined),
    getRowRef: (id) => {
      const ref = Number(id.slice(1));
      return id.startsWith('r') && Number.isInteger(ref) && !deleted.has(ref) ? ref : undefined;
    },
  };
}

describe('RowIdSet', () => {
  it('reads the IDs in the order of its rows, and finds them', () => {
    const set = new RowIdSet(rowsOf(), Int32Array.of(40, 3, 70, 1));
    expect(set.count()).toBe(4);
    expect([...set.iterate()]).toEqual(['r40', 'r3', 'r70', 'r1']);
    expect(set.toArray()).toEqual(['r40', 'r3', 'r70', 'r1']);
    for (const id of ['r40', 'r3', 'r70', 'r1']) expect(set.has(id)).toBe(true);
    for (const id of ['r0', 'r2', 'r41', 'r71', 'x']) expect(set.has(id)).toBe(false);
  });

  it('finds the rows of a set of more rows than it looks through one by one', () => {
    const refs = Int32Array.from({ length: 100 }, (_, i) => 1_000 + i * 3);
    const set = new RowIdSet(rowsOf(), refs);
    expect(set.has('r1000')).toBe(true);
    expect(set.has('r1297')).toBe(true);
    expect(set.has('r1001')).toBe(false);
    expect(set.has('r999')).toBe(false);
    expect(set.has('r1300')).toBe(false);
  });

  it('holds 100,000 rows in less than 500,000 bytes, once it has been asked for a row', () => {
    const refs = Int32Array.from({ length: 100_000 }, (_, i) => i * 2);
    const set = new RowIdSet(rowsOf(), refs);
    expect(set.has('r199998')).toBe(true);
    expect(set.has('r199997')).toBe(false);
    expect(set.byteLength).toBeLessThan(500_000);
  });

  it('throws tooManyItems for an array of more than 10,000 IDs, and reads them one at a time', () => {
    const set = new RowIdSet(
      rowsOf(),
      Int32Array.from({ length: 10_001 }, (_, i) => i),
    );
    expect(() => set.toArray()).toThrow(expect.objectContaining({ code: 'tooManyItems' }));
    let read = 0;
    for (const _ of set.iterate()) read += 1;
    expect(read).toBe(10_001);
  });

  it('keeps the IDs of its rows deleted, and leaves them out of the rows it gives', () => {
    const deleted = new Set<number>();
    const rows = rowsOf(deleted);
    const set = new RowIdSet(rows, Int32Array.of(5, 6, 7));
    deleted.add(6);
    // Told while the row still reads its ID, as the layer tells a change
    set.rowsDeleted([Int32Array.of(6)], 1);
    expect(Array.from(set.rowRefs())).toEqual([5, 7]);
    expect([...set.iterate()]).toEqual(['r5', 'r6', 'r7']);
    expect(set.has('r6')).toBe(true);
  });
});
