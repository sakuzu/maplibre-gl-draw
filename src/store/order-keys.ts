// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Keys of the order of the items of a layer (fractional indexes)
 *
 * A key is a string compared by its UTF-8 bytes. A key at an end of a container is made by the
 * Tabane format, whose keys count up and down from the first key and do not grow, so a long run
 * of items added at an end keeps its keys short. A key that does not read as one of those, which
 * may be any string, gets a key by its last character: the next digit of `0-9A-Za-z` (in the order
 * of their bytes), or one more digit when it cannot be raised.
 */

import { tabaneKeyAfter, tabaneKeyBefore } from '@sakuzu/tabane';

/** The digits of the keys, in the order of their bytes */
const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/** The key of the first item of an empty container */
export const FIRST_KEY = 'V';

/**
 * A key that comes after `key` (the first key when there is none)
 *
 * @internal
 */
export function keyAfter(key: string | null | undefined): string {
  if (!key) return FIRST_KEY;
  return tabaneKeyAfter(key) ?? raisedKey(key);
}

/** A key that comes after `key`, by its last character */
function raisedKey(key: string): string {
  const last = key.charCodeAt(key.length - 1);
  // The next digit above the last character, when there is one
  for (let d = 0; d < DIGITS.length; d++) {
    if (DIGITS.charCodeAt(d) > last) return key.slice(0, -1) + DIGITS[d];
  }
  return key + FIRST_KEY;
}

/** The code of a digit */
const CODES = Array.from(DIGITS, (digit) => digit.charCodeAt(0));
const FIRST = CODES[0];

/**
 * A digit between two codes (exclusive), the one in their middle, or null when none is (a code
 * of -1 is below every digit, one of 0x10000 above)
 */
function digitBetween(low: number, high: number): string | null {
  let first = -1;
  let last = -1;
  for (let d = 0; d < CODES.length; d++) {
    if (CODES[d] <= low || CODES[d] >= high) continue;
    if (first < 0) first = d;
    last = d;
  }
  if (first < 0) return null;
  return DIGITS[(first + last + 1) >> 1];
}

/** A key that comes after `key`, with no bound above */
function after(key: string): string {
  for (let i = 0; i < key.length; i++) {
    const digit = digitBetween(key.charCodeAt(i), 0x10000);
    if (digit !== null) return key.slice(0, i) + digit;
  }
  return key + FIRST_KEY;
}

/**
 * A key between two keys: after `below` (null: from the start) and before `above` (null: to the
 * end), compared by their UTF-8 bytes. The keys around may be any strings; the key made is of the
 * digits `0-9A-Za-z`, as short as the keys around let it be. When no key is between them (the two
 * are in the wrong order, or `above` is `below` followed only by characters at or below `0`), the
 * key made comes after `below`.
 *
 * @internal
 */
export function keyBetween(below: string | null, above: string | null): string {
  const a = below ?? '';
  if (above !== null && compareKeys(a, above) >= 0) return after(a);
  let prefix = '';
  for (let i = 0; ; i++) {
    const low = i < a.length ? a.charCodeAt(i) : -1;
    const high = above !== null && i < above.length ? above.charCodeAt(i) : 0x10000;
    if (low === high) {
      prefix += a[i];
      continue;
    }
    const digit = digitBetween(low, high);
    if (digit !== null) {
      // A key that ends in the first digit leaves no key between it and what it starts with
      return prefix + (digit.charCodeAt(0) === FIRST ? `${digit}${FIRST_KEY}` : digit);
    }
    if (low >= 0) return prefix + a[i] + after(a.slice(i + 1));
    // `below` ends here and `above` goes on with a character at or below the first digit
    const rest = (above as string).slice(i + 1);
    if (rest === '') return after(a);
    return prefix + (above as string)[i] + keyBetween(null, rest);
  }
}

/**
 * A key that comes before `key`
 *
 * @internal
 */
export function keyBefore(key: string): string {
  return tabaneKeyBefore(key) ?? loweredKey(key);
}

/**
 * A key that comes before `key`, by its last character: lowered to the digit below it (with the
 * last digit after it when that is the first digit, which no key ends with)
 */
function loweredKey(key: string): string {
  const last = key.charCodeAt(key.length - 1);
  for (let d = CODES.length - 1; d >= 1; d--) {
    if (CODES[d] >= last) continue;
    return key.slice(0, -1) + DIGITS[d];
  }
  if (last > FIRST) return `${key.slice(0, -1)}${DIGITS[0]}${DIGITS[DIGITS.length - 1]}`;
  return keyBetween(null, key);
}

/** `n` keys in their order between two keys (see {@link keyBetween}), made in halves */
function keysInHalves(below: string | null, above: string | null, n: number): string[] {
  if (n <= 0) return [];
  if (n === 1) return [keyBetween(below, above)];
  const half = n >> 1;
  const middle = keyBetween(below, above);
  return [
    ...keysInHalves(below, middle, half),
    middle,
    ...keysInHalves(middle, above, n - half - 1),
  ];
}

/** `n` keys in their order after `key` with no bound above, each the next one */
function keysAfter(key: string | null, n: number): string[] {
  const keys: string[] = [];
  let last = key;
  while (keys.length < n) {
    const next = last ? tabaneKeyAfter(last) : FIRST_KEY;
    if (next === null) {
      // A key that does not read as one of the keys counted: the rest in halves, up to the next
      const rest = n - keys.length;
      const end = raisedKey(last as string);
      return [...keys, ...(rest === 1 ? [end] : keysInHalves(last, end, rest))];
    }
    keys.push(next);
    last = next;
  }
  return keys;
}

/** `n` keys in their order before `key` with no bound below, each the next one down */
function keysBefore(key: string, n: number): string[] {
  const keys: string[] = [];
  let first = key;
  while (keys.length < n) {
    const next = tabaneKeyBefore(first);
    if (next === null) {
      const rest = n - keys.length;
      const made = rest === 1 ? [loweredKey(first)] : keysInHalves(null, first, rest);
      return [...made, ...keys.reverse()];
    }
    keys.push(next);
    first = next;
  }
  return keys.reverse();
}

/**
 * `n` keys in their order between two keys, made in halves so that many keys put in one place stay
 * short (see {@link keyBetween}); with no bound at one side, the keys next to the key at the other
 * (see {@link keyAfter}), and from the first key when there is none
 *
 * @internal
 */
export function keysBetween(below: string | null, above: string | null, n: number): string[] {
  if (n <= 0) return [];
  if (above === null) return keysAfter(below, n);
  if (below === null) return keysBefore(above, n);
  return keysInHalves(below, above, n);
}

/**
 * The order of two keys by their UTF-8 bytes (the order of their code points)
 *
 * @internal
 */
export function compareKeys(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a.codePointAt(i) as number;
    const y = b.codePointAt(i) as number;
    if (x !== y) return x - y;
    if (x > 0xffff) i++;
  }
  return a.length - b.length;
}
