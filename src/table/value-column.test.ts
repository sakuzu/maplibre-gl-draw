// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { utf8ColumnLength } from './utf8-column.js';
import {
  DENSE_MIN_SHARE,
  readNumberValue,
  readValue,
  VALUE_ABSENT,
  VALUE_NESTED,
  VALUE_NULL,
  VALUE_STRING,
  ValueColumnBuilder,
  ValueStringCache,
  valueEntryOf,
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

  it('leaves a row as it was when its nested value is refused', () => {
    const builder = new ValueColumnBuilder(2);
    builder.set(0, 'kept');
    expect(() => builder.set(0, { a: Number.NaN })).toThrow();
    builder.set(1, [1]);
    const column = builder.finish();
    expect(readValue(column, 0)).toBe('kept');
    expect(readValue(column, 1)).toEqual([1]);
  });

  it('keeps a repeated nested value once, apart from a string of the same bytes', () => {
    const source = { dataset: 'OpenStreetMap', license: 'ODbL-1.0' };
    const values: unknown[] = [];
    for (let i = 0; i < 10; i++) values.push([{ ...source }]);
    const column = columnOf(values);
    expect(utf8ColumnLength(column.values as never)).toBe(1);
    expect(values.map((_, row) => readValue(column, row))).toEqual(values);

    // The canonical bytes of [] are 0x06 0x00: a string of those bytes is another value
    const mixed = columnOf([[], '\u0006\u0000', [], '\u0006\u0000']);
    expect(utf8ColumnLength(mixed.values as never)).toBe(2);
    expect([0, 1, 2, 3].map((row) => readValue(mixed, row))).toEqual([
      [],
      '\u0006\u0000',
      [],
      '\u0006\u0000',
    ]);
    expect(valueKindOf(mixed, 0)).toBe(VALUE_NESTED);
    expect(valueKindOf(mixed, 1)).toBe(VALUE_STRING);
  });

  it('gives the same column whatever the order the rows are set in', () => {
    const values = ['b', [1], 'a', 'b', null, { a: 1 }, 'c', [1], 'b', 'b'];
    const backward = new ValueColumnBuilder(values.length);
    for (let row = values.length - 1; row >= 0; row--) backward.set(row, values[row]);
    expect(backward.finish()).toEqual(columnOf(values));
  });

  it('copies entries of other columns as the values set', () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => i);
    const sources = [
      columnOf(['a', null, { x: [1, 'é'] }, 4.5, true, undefined, 'a', false]),
      columnOf(many(40).map((i) => (i % 9 === 0 ? { names: { primary: `n${i}` } } : undefined))),
      columnOf(many(12).map((i) => `name ${i}`)),
    ];
    // Every row of every source, in an order of its own, against the values set as they are
    const picks: Array<[number, number]> = [];
    sources.forEach((column, s) => {
      for (let row = column.length - 1; row >= 0; row--) picks.push([s, row]);
    });
    const copied = new ValueColumnBuilder(picks.length);
    const set = new ValueColumnBuilder(picks.length);
    picks.forEach(([s, row], r) => {
      const column = sources[s];
      const entry = valueEntryOf(column, row);
      if (entry >= 0) copied.copy(r, column, entry);
      set.set(r, readValue(column, row));
    });
    expect(copied.finish()).toEqual(set.finish());
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

  it('drops the oldest strings at no cost growing with the strings it keeps', () => {
    // 20,000 strings through a cache of 10,000, read twice: every read misses and drops one
    const column = columnOf(Array.from({ length: 20_000 }, (_, i) => `name ${i}`));
    const timed = (strings?: ValueStringCache): number => {
      const start = performance.now();
      for (let pass = 0; pass < 2; pass++) {
        for (let row = 0; row < column.length; row++) readValue(column, row, strings);
      }
      return performance.now() - start;
    };
    timed();
    const decoded = Math.min(timed(), timed());
    const cache = new ValueStringCache(10_000);
    const cached = timed(cache);
    expect(cache.size).toBeLessThanOrEqual(10_000);
    expect(readValue(column, 19_999, cache)).toBe('name 19999');
    // A read that misses costs about a decode, not a scan of the strings kept
    expect(cached).toBeLessThan(decoded * 3 + 10);
  });
});
