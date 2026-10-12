// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { utf8ColumnLength } from './utf8-column.js';
import {
  DENSE_MIN_SHARE,
  readNumberValue,
  readValue,
  VALUE_ABSENT,
  VALUE_NULL,
  ValueColumnBuilder,
  ValueStringCache,
  valueKindOf,
} from './value-column.js';

/** Builds a column from the values of each row (undefined = absent) */
function columnOf(values: readonly unknown[]) {
  const builder = new ValueColumnBuilder(values.length);
  values.forEach((value, row) => {
    builder.set(row, value);
  });
  return builder.finish();
}

describe('ValueColumn', () => {
  it('reads back every kind of value, and tells absent from null', () => {
    const values = [null, undefined, true, false, 3.5, 'text', [1, 'a'], { b: { c: 1 } }];
    const column = columnOf(values);
    expect(values.map((_, row) => readValue(column, row))).toEqual(values);
    expect(valueKindOf(column, 0)).toBe(VALUE_NULL);
    expect(valueKindOf(column, 1)).toBe(VALUE_ABSENT);
  });

  it('is dense when most rows hold the key and sparse otherwise', () => {
    const dense = columnOf([1, 2, undefined, 4]);
    expect(dense.form).toBe('dense');
    expect(dense.tags.length).toBe(4);

    const values: unknown[] = new Array(100).fill(undefined);
    values[7] = 'x';
    values[42] = 9;
    values[99] = null;
    const sparse = columnOf(values);
    expect(sparse.form).toBe('sparse');
    expect([...(sparse.rows as Int32Array)]).toEqual([7, 42, 99]);
    expect(values.map((_, row) => readValue(sparse, row))).toEqual(values);
    expect(readNumberValue(sparse, 42)).toBe(9);
    expect(readNumberValue(sparse, 7)).toBeUndefined();
    expect(readNumberValue(sparse, 8)).toBeUndefined();
  });

  it('decides the form at the share where it crosses', () => {
    const at = (present: number) => {
      const values: unknown[] = new Array(10).fill(undefined);
      for (let i = 0; i < present; i++) values[i] = i;
      return columnOf(values).form;
    };
    const threshold = Math.ceil(10 * DENSE_MIN_SHARE);
    expect(at(threshold)).toBe('dense');
    expect(at(threshold - 1)).toBe('sparse');
  });

  it('keeps a repeated string once, and every string when most of them differ', () => {
    const shared = columnOf(['cafe', 'school', 'cafe', 'cafe', 'school', 'cafe']);
    expect(utf8ColumnLength(shared.values as never)).toBe(2);

    const names = columnOf(['a', 'b', 'c', 'd', 'a']);
    expect(utf8ColumnLength(names.values as never)).toBe(5);
    expect([0, 1, 2, 3, 4].map((row) => readValue(names, row))).toEqual(['a', 'b', 'c', 'd', 'a']);
  });

  it('takes the last value set on a row', () => {
    const builder = new ValueColumnBuilder(2);
    builder.set(0, 'first');
    builder.set(0, 5);
    builder.set(1, 1);
    const column = builder.finish();
    expect(readValue(column, 0)).toBe(5);
  });

  it('refuses a number that is not finite', () => {
    expect(() => new ValueColumnBuilder(1).set(0, Number.NaN)).toThrow();
  });
});

describe('ValueStringCache', () => {
  it('returns the same string and keeps no more than its limit', () => {
    const column = columnOf(['alpha', 'beta', 'gamma', 'delta']);
    const cache = new ValueStringCache(2);
    expect(readValue(column, 0, cache)).toBe('alpha');
    expect(readValue(column, 1, cache)).toBe('beta');
    expect(readValue(column, 2, cache)).toBe('gamma');
    expect(cache.size).toBe(2);
    expect(readValue(column, 0, cache)).toBe('alpha');
    expect(cache.size).toBe(2);
  });
});
