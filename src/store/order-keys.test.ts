// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

import { rowSuffixOf } from '@sakuzu/tabane';
import { describe, expect, it } from 'vitest';
import { seededRandom } from '../test-utils.js';
import {
  compareKeys,
  FIRST_KEY,
  keyAfter,
  keyBefore,
  keyBetween,
  keysBetween,
} from './order-keys.js';

describe('the keys of the order', () => {
  it('makes a key between any two keys in their order', () => {
    const random = seededRandom(7);
    const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz~-_ ';
    const word = () =>
      Array.from(
        { length: 1 + Math.floor(random() * 4) },
        () => alphabet[Math.floor(random() * alphabet.length)],
      ).join('');
    for (let k = 0; k < 2000; k++) {
      let [a, b] = [word(), word()];
      if (compareKeys(a, b) === 0) continue;
      if (compareKeys(a, b) > 0) [a, b] = [b, a];
      // No key is between a key and the same key followed by characters at or below '0'
      if (b.startsWith(a) && [...b.slice(a.length)].every((c) => c <= '0')) continue;
      const key = keyBetween(a, b);
      expect(compareKeys(a, key), `${a} < ${key}`).toBeLessThan(0);
      expect(compareKeys(key, b), `${key} < ${b}`).toBeLessThan(0);
    }
    expect(compareKeys(keyBetween(null, 'a0'), 'a0')).toBeLessThan(0);
    expect(compareKeys(keyBetween('zzz', null), 'zzz')).toBeGreaterThan(0);
  });

  it('puts 2,000 items in one place with keys of 64 characters at most', () => {
    // Between two items next to each other, at the front and at the back
    for (const [below, above] of [
      ['V', 'W'],
      [null, 'V'],
      ['V', null],
      ['a0', 'a1'],
    ] as Array<[string | null, string | null]>) {
      const keys = keysBetween(below, above, 2000);
      expect(keys).toHaveLength(2000);
      for (let i = 0; i < keys.length; i++) {
        expect(keys[i].length).toBeLessThanOrEqual(64);
        if (i > 0) expect(compareKeys(keys[i - 1], keys[i])).toBeLessThan(0);
      }
      if (below !== null) expect(compareKeys(below, keys[0])).toBeLessThan(0);
      if (above !== null) expect(compareKeys(keys[keys.length - 1], above)).toBeLessThan(0);
    }
  });

  it('keeps the keys short when items are put again and again in the same place', () => {
    // Each time a run of 50 is put just above the first item
    let low = keyAfter(null);
    const high = keyAfter(low);
    for (let round = 0; round < 20; round++) {
      const keys = keysBetween(low, high, 50);
      for (const key of keys) expect(key.length).toBeLessThanOrEqual(64);
      low = keys[0];
    }
  });
});

describe('the keys of the items put at an end again and again', () => {
  /** The longest key of `n` keys made one after the other from the key made by `next` */
  function longest(n: number, next: (key: string | null) => string): number {
    let key: string | null = null;
    let most = 0;
    for (let i = 0; i < n; i++) {
      const made = next(key);
      if (key !== null && made === key) throw new Error(`the same key after ${key}`);
      key = made;
      most = Math.max(most, made.length);
    }
    return most;
  }

  it('do not grow in 100,000 items added one by one, at the back and at the front', () => {
    expect(longest(100_000, keyAfter)).toBeLessThanOrEqual(5);
    expect(longest(100_000, (key) => keyBefore(key ?? FIRST_KEY))).toBeLessThanOrEqual(5);
    expect(longest(100_000, (key) => keysBetween(key, null, 1)[0])).toBeLessThanOrEqual(5);
    expect(
      longest(100_000, (key) => keysBetween(null, key ?? FIRST_KEY, 1)[0]),
    ).toBeLessThanOrEqual(5);
  });

  it('do not grow in runs of 2,000 items added again and again, at the back and at the front', () => {
    let top: string | null = null;
    let bottom = FIRST_KEY;
    for (let round = 0; round < 100; round++) {
      const after = keysBetween(top, null, 2000);
      const before = keysBetween(null, bottom, 2000);
      for (const keys of [after, before]) {
        expect(keys).toHaveLength(2000);
        for (const [i, key] of keys.entries()) {
          if (key.length > 5) expect(key).toHaveLength(5);
          if (i > 0 && compareKeys(keys[i - 1], key) >= 0) expect(key).toBe(keys[i - 1]);
        }
      }
      if (top !== null) expect(compareKeys(top, after[0])).toBeLessThan(0);
      expect(compareKeys(before[before.length - 1], bottom)).toBeLessThan(0);
      top = after[after.length - 1];
      bottom = before[0];
    }
  });

  it('are the keys next to the key there, in their order', () => {
    expect(keysBetween(null, null, 3)).toEqual(['V', 'W1', 'W2']);
    expect(keysBetween('Wy', null, 3)).toEqual(['Wz', 'X01', 'X02']);
    expect(keysBetween(null, 'U2', 3)).toEqual(['Tzy', 'Tzz', 'U1']);
  });

  it('come after every row of a block, the last row read for the end', () => {
    for (const head of ['V', 'W5', 'X0z', 'Uz', 'T1', 'zV']) {
      const rows = [0, 1, 60, 61, 3721, 3722, 299_999].map((i) => head + rowSuffixOf(i));
      const [key] = keysBetween(rows[rows.length - 1], null, 1);
      for (const row of rows) expect(compareKeys(row, key)).toBeLessThan(0);
    }
  });

  it('are made from any string, by its last character when it reads as no whole number', () => {
    for (const key of ['', 'a~', '~', 'é', 'W~', 'V', 'z'.repeat(31), 'z'.repeat(1024), 'zzz']) {
      for (const n of [1, 2, 50]) {
        const after = keysBetween(key === '' ? null : key, null, n);
        expect(after).toHaveLength(n);
        if (key !== '') expect(compareKeys(key, after[0])).toBeLessThan(0);
        for (let i = 1; i < n; i++) expect(compareKeys(after[i - 1], after[i])).toBeLessThan(0);
        if (key === '') continue;
        const before = keysBetween(null, key, n);
        expect(before).toHaveLength(n);
        expect(compareKeys(before[n - 1], key)).toBeLessThan(0);
        for (let i = 1; i < n; i++) expect(compareKeys(before[i - 1], before[i])).toBeLessThan(0);
      }
    }
  });

  it('are made below the last whole number there is', () => {
    const bottom = `${'0'.repeat(1023)}1`;
    for (const n of [1, 2, 50]) {
      const keys = keysBetween(null, bottom, n);
      expect(keys).toHaveLength(n);
      expect(compareKeys(keys[n - 1], bottom)).toBeLessThan(0);
    }
  });
});
