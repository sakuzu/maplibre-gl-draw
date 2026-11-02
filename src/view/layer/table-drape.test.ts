// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests of the copy numbers of the rows of the groups on the drape (`DrapeCopyIndex`)
 *
 * - A row keeps its copy number while it is kept, whatever group it is in
 * - A number given back is not given again until no tile names it any more (`release`)
 * - Rows coming in and going again and again (an import undone and done again) do not make the
 *   numbers grow past the rows there are at once
 */

import { describe, expect, it } from 'vitest';
import { DrapeCopyIndex } from './table-drape.js';

describe('the copy numbers of the rows on the drape', () => {
  it('keeps the number of a row, and gives a number back only once it is released', () => {
    const index = new DrapeCopyIndex();
    const a = index.copyOf(10);
    const b = index.copyOf(11);
    expect(index.copyOf(10)).toBe(a);
    expect(a).not.toBe(b);
    expect(index.drop(10)).toBe(a);
    // Not given again while a tile may still name it
    const c = index.copyOf(12);
    expect(c).not.toBe(a);
    index.release();
    expect(index.copyOf(13)).toBe(a);
    expect(index.peek(10)).toBe(-1);
  });

  it('does not grow past the rows there are at once, whatever comes and goes', () => {
    const index = new DrapeCopyIndex();
    let next = 0;
    for (let round = 0; round < 50; round++) {
      // An import of 1,000 rows, undone
      const handles = Array.from({ length: 1000 }, () => next++);
      for (const handle of handles) index.copyOf(handle);
      for (const handle of handles) index.drop(handle);
      index.release();
    }
    expect(index.range).toBe(1000);
    expect(index.size).toBe(0);
  });
});
