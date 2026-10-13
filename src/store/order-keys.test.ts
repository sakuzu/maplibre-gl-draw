// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { seededRandom } from '../test-utils.js';
import { compareKeys, keyAfter, keyBetween, keysBetween } from './order-keys.js';

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
  it('grow by a character every few dozen times', () => {
    let top: string | null = keyAfter(null);
    let bottom: string = top;
    for (let i = 0; i < 400; i++) {
      const [next] = keysBetween(top, null, 1);
      expect(compareKeys(next, top as string)).toBeGreaterThan(0);
      top = next;
      const [first] = keysBetween(null, bottom, 1);
      expect(compareKeys(first, bottom)).toBeLessThan(0);
      bottom = first;
    }
    expect((top as string).length).toBeLessThanOrEqual(16);
    expect(bottom.length).toBeLessThanOrEqual(16);
  });
});
