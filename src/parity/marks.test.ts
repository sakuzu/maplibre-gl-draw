// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The marks of the rows a decided change of the public API changes (src/parity/marks.json)
 *
 * A mark names the changes by their numbers in the list of the changes of the specification of
 * 3.0 (numbered 1 to 176) and says what the row reads after them. Only a marked row may have its
 * record changed, and only as its mark says; a row without a mark keeps its record.
 */

import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { PARITY_AXES, readParityRecords } from '../test-utils.js';

interface Mark {
  changes: number[];
  after: string;
}

const { marks } = JSON.parse(await readFile(new URL('./marks.json', import.meta.url), 'utf8')) as {
  marks: Record<string, Record<string, Mark>>;
};

/** The numbers of the list of the changes */
const FIRST_CHANGE = 1;
const LAST_CHANGE = 176;

describe('the marks of the rows that decided changes change', () => {
  it('are on the axes of the table', () => {
    expect(
      Object.keys(marks).filter((axis) => !(PARITY_AXES as readonly string[]).includes(axis)),
    ).toEqual([]);
  });

  for (const axis of PARITY_AXES) {
    const rows = marks[axis] ?? {};
    it(`of ${axis} are on recorded rows`, async () => {
      const recorded = await readParityRecords(axis);
      expect(Object.keys(rows).filter((row) => !recorded.rows.has(row))).toEqual([]);
    });
    it(`of ${axis} carry the numbers of the changes and the value after them`, () => {
      const wrong = Object.entries(rows).filter(([, mark]) => {
        const numbers = Array.isArray(mark.changes) ? mark.changes : [];
        return (
          numbers.length === 0 ||
          numbers.some((n) => !Number.isInteger(n) || n < FIRST_CHANGE || n > LAST_CHANGE) ||
          typeof mark.after !== 'string' ||
          numbers.some((n) => !mark.after.includes(`${n}: `))
        );
      });
      expect(wrong.map(([row]) => row)).toEqual([]);
    });
  }
});
