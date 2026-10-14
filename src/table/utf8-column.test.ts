// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import {
  compareUtf8,
  equalUtf8,
  hashString,
  hashUtf8,
  hashUtf8Column,
  Utf8ColumnBuilder,
  utf8ColumnFromStrings,
  utf8ColumnLength,
  utf8LengthOf,
  utf8String,
  writeUtf8,
} from './utf8-column.js';

/** Strings of every width of UTF-8, with surrogate pairs and lone surrogates */
const AWKWARD = [
  '',
  'ascii',
  'x'.repeat(200),
  'é',
  '日本語',
  '🗾',
  'a🗾b',
  '\ud800',
  'a\udc00b',
  '\ud83d',
  '\ud83dx',
  '\uffff\ue000',
  `${'a'.repeat(50)}日${'b'.repeat(50)}`,
];

describe('Utf8Column', () => {
  it('reads back the strings it was built from, empty and non-ASCII ones included', () => {
    const values = ['a', '', '日本', '🗾', 'x'.repeat(300)];
    const column = utf8ColumnFromStrings(values);
    expect(utf8ColumnLength(column)).toBe(values.length);
    expect(values.map((_, i) => utf8String(column, i))).toEqual(values);
    expect(column.offsets[1]).toBe(1);
    expect(column.offsets[2]).toBe(1);
    expect(column.offsets[3] - column.offsets[2]).toBe(6);
  });

  it('orders by the UTF-8 bytes, not by the UTF-16 code units', () => {
    // In UTF-8, U+FF61 (EF BD A1) comes before U+1F5FE (F0 9F 97 BE); in UTF-16 code units
    // the surrogate of U+1F5FE (0xD83D) comes before 0xFF61
    const column = utf8ColumnFromStrings(['｡', '🗾', 'a', 'ab', '']);
    const order = [0, 1, 2, 3, 4].sort((i, j) => compareUtf8(column, i, column, j));
    expect(order.map((i) => utf8String(column, i))).toEqual(['', 'a', 'ab', '｡', '🗾']);
    // The order of the code units differs: the surrogate of 🗾 (0xD83D) comes before 0xFF61
    expect('🗾' < '｡').toBe(true);
  });

  it('compares and hashes entries of different columns alike', () => {
    const a = utf8ColumnFromStrings(['id-1', 'id-2']);
    const b = utf8ColumnFromStrings(['id-2', 'id-1', 'id-10']);
    expect(equalUtf8(a, 0, b, 1)).toBe(true);
    expect(equalUtf8(a, 0, b, 2)).toBe(false);
    expect(compareUtf8(a, 1, b, 0)).toBe(0);
    expect(hashUtf8(a, 0)).toBe(hashUtf8(b, 1));
    expect(hashString('id-1')).toBe(hashUtf8(a, 0));
    expect([...hashUtf8Column(b)]).toEqual([hashUtf8(b, 0), hashUtf8(b, 1), hashUtf8(b, 2)]);
  });

  it('grows past the size it was started with', () => {
    const builder = new Utf8ColumnBuilder(1);
    const values: string[] = [];
    for (let i = 0; i < 1000; i++) {
      const value = `row-${i}-${'é'.repeat(i % 7)}`;
      values.push(value);
      builder.add(value);
    }
    const column = builder.finish();
    expect(column.offsets.length).toBe(1001);
    expect(values.every((value, i) => utf8String(column, i) === value)).toBe(true);
  });

  it('copies the bytes of an entry of another column', () => {
    const source = utf8ColumnFromStrings(['first', 'ü']);
    const builder = new Utf8ColumnBuilder();
    builder.addEntry(source, 1);
    builder.addEntry(source, 0);
    const column = builder.finish();
    expect(utf8String(column, 0)).toBe('ü');
    expect(utf8String(column, 1)).toBe('first');
  });

  it('measures and writes the bytes TextEncoder writes, a lone surrogate as U+FFFD', () => {
    const encoder = new TextEncoder();
    for (const value of AWKWARD) {
      const expected = encoder.encode(value);
      expect(utf8LengthOf(value)).toBe(expected.length);
      const target = new Uint8Array(value.length * 3 + 4);
      const written = writeUtf8(value, target, 2);
      expect(written).toBe(expected.length);
      expect([...target.subarray(2, 2 + written)]).toEqual([...expected]);
    }
    const builder = new Utf8ColumnBuilder(1);
    for (const value of AWKWARD) builder.add(value);
    const column = builder.finish();
    AWKWARD.forEach((value, i) => {
      expect([...column.bytes.subarray(column.offsets[i], column.offsets[i + 1])]).toEqual([
        ...encoder.encode(value),
      ]);
    });
  });
});
