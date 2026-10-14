// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { TableSelection } from './selection.js';

describe('TableSelection', () => {
  it('keeps each handle once, ascending, without the negative ones', () => {
    const set = TableSelection.of([5, 3, -1, 5, 0, 3]);
    expect(Array.from(set.handles)).toEqual([0, 3, 5]);
    expect(set.count).toBe(3);
  });

  it('answers whether a handle is in it', () => {
    const set = TableSelection.of([1, 40, 70]);
    expect(set.has(1)).toBe(true);
    expect(set.has(40)).toBe(true);
    expect(set.has(70)).toBe(true);
    expect(set.has(0)).toBe(false);
    expect(set.has(39)).toBe(false);
    expect(set.has(71)).toBe(false);
    expect(set.has(-1)).toBe(false);
    expect(TableSelection.empty.has(0)).toBe(false);
  });

  it('makes a new set to add and take out rows, leaving the one before as it was', () => {
    const before = TableSelection.of([1, 2, 3]);
    const added = before.with([4, 2]);
    const removed = added.without([1, 9]);
    expect(Array.from(before.handles)).toEqual([1, 2, 3]);
    expect(Array.from(added.handles)).toEqual([1, 2, 3, 4]);
    expect(Array.from(removed.handles)).toEqual([2, 3, 4]);
    expect(before.with([1])).toBe(before);
    expect(before.without([7])).toBe(before);
  });

  it('keeps the rows a test keeps', () => {
    const set = TableSelection.of([1, 2, 3, 4]);
    expect(Array.from(set.filter((h) => h % 2 === 0).handles)).toEqual([2, 4]);
    expect(set.filter(() => true)).toBe(set);
    expect(set.filter(() => false)).toBe(TableSelection.empty);
  });

  it('compares the rows of two sets', () => {
    expect(TableSelection.of([3, 1]).equals(TableSelection.of([1, 3]))).toBe(true);
    expect(TableSelection.of([1]).equals(TableSelection.of([1, 3]))).toBe(false);
  });

  it('holds 100,000 rows in a few hundred kilobytes', () => {
    const handles = Int32Array.from({ length: 100_000 }, (_, i) => i * 2);
    const set = TableSelection.of(handles);
    expect(set.has(199_998)).toBe(true);
    expect(set.has(199_997)).toBe(false);
    expect(set.byteLength).toBeLessThan(500_000);
  });
});
