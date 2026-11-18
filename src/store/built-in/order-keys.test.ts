// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The keys of the order: `createOrderKeyBetween` makes a key between two keys, compared as strings
 * of bytes, and the keys made at an end again and again do not grow
 */

import { describe, expect, it } from 'vitest';
import { DrawError } from '../../shared/errors.js';
import { compareKeys, createOrderKeyBetween, FIRST_KEY } from './order-keys.js';

/** Numbers between 0 and 1 from a seed, the same every run */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

/** The order of two strings by their UTF-8 bytes */
function byBytes(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/** The digits of the keys, in the order of their bytes */
const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/**
 * The suffix the keys of the rows of a page built in a Worker end with, after the key of their
 * run: the number of its digits (one digit), then its digits in base 61 written with `1` to `z`
 */
function rowSuffixOf(i: number): string {
  let digits = '';
  let rest = i;
  do {
    digits = DIGITS[1 + (rest % 61)] + digits;
    rest = Math.floor(rest / 61);
  } while (rest > 0);
  return DIGITS[digits.length] + digits;
}

describe('createOrderKeyBetween', () => {
  it('makes a key between any two keys, compared as strings of bytes', () => {
    const random = seeded(7);
    const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz~-_ éｚ😀';
    const word = () =>
      Array.from(
        { length: 1 + Math.floor(random() * 4) },
        () => [...alphabet][Math.floor(random() * [...alphabet].length)],
      ).join('');
    let made = 0;
    for (let k = 0; k < 2000; k++) {
      let [a, b] = [word(), word()];
      expect(Math.sign(compareKeys(a, b))).toBe(Math.sign(byBytes(a, b)));
      if (byBytes(a, b) === 0) continue;
      if (byBytes(a, b) > 0) [a, b] = [b, a];
      // No key of digits is between a key and the same key followed by characters below '0'
      if (b.startsWith(a) && [...b.slice(a.length)].every((c) => c < '0')) {
        expect(() => createOrderKeyBetween(a, b)).toThrow(DrawError);
        continue;
      }
      const key = createOrderKeyBetween(a, b);
      expect(byBytes(a, key), `${a} < ${key}`).toBeLessThan(0);
      expect(byBytes(key, b), `${key} < ${b}`).toBeLessThan(0);
      made++;
    }
    expect(made).toBeGreaterThan(1500);
    expect(byBytes(createOrderKeyBetween(undefined, 'a0'), 'a0')).toBeLessThan(0);
    expect(byBytes(createOrderKeyBetween('zzz', undefined), 'zzz')).toBeGreaterThan(0);
    expect(createOrderKeyBetween(undefined, undefined)).toBe(FIRST_KEY);
  });

  it('makes keys that do not grow over 100,000 items added one by one, at the back and at the front', () => {
    let back: string | undefined;
    let front: string | undefined;
    let longest = 0;
    for (let i = 0; i < 100_000; i++) {
      const after = createOrderKeyBetween(back, undefined);
      if (back !== undefined) expect(byBytes(back, after)).toBeLessThan(0);
      back = after;
      const before = createOrderKeyBetween(undefined, front);
      if (front !== undefined) expect(byBytes(before, front)).toBeLessThan(0);
      front = before;
      longest = Math.max(longest, after.length, before.length);
    }
    expect(longest).toBeLessThanOrEqual(5);
  });

  it('makes a key after every row of a page, from the key of its last row', () => {
    for (const head of ['V', 'W5', 'X0z', 'Uz', 'T1', 'zV']) {
      const rows = [0, 1, 60, 61, 3721, 3722, 299_999].map((i) => head + rowSuffixOf(i));
      const key = createOrderKeyBetween(rows[rows.length - 1], undefined);
      for (const row of rows) expect(byBytes(row, key)).toBeLessThan(0);
    }
  });

  it('makes keys after and before any string, by its last character when it reads as no whole number', () => {
    for (const key of [
      'a~',
      '~',
      'é',
      'W~',
      'V',
      'z'.repeat(31),
      'z'.repeat(1024),
      'zzz',
      `${'0'.repeat(1023)}1`,
    ]) {
      expect(byBytes(key, createOrderKeyBetween(key, undefined))).toBeLessThan(0);
      expect(byBytes(createOrderKeyBetween(undefined, key), key)).toBeLessThan(0);
    }
  });

  it('throws when the key behind is not less than the key in front, or a key is not one', () => {
    for (const [before, after] of [
      ['b', 'a'],
      ['a', 'a'],
      ['', 'a'],
      ['a', ''],
      [1, undefined],
      [undefined, null],
    ] as Array<[string, string]>) {
      let thrown: unknown;
      try {
        createOrderKeyBetween(before, after);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(DrawError);
      expect((thrown as DrawError).code).toBe('invalidInput');
    }
    // No key is between a key and the key followed by the character below every other
    expect(() => createOrderKeyBetween('a', 'a\u0000')).toThrow(DrawError);
    expect(() => createOrderKeyBetween(undefined, '0')).toThrow(DrawError);
  });
});
