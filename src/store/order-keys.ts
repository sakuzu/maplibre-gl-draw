// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Keys of the order of the items of a layer (fractional indexes)
 *
 * A key is a string compared by its UTF-8 bytes. A key after another is made by raising its last
 * character to the next digit of `0-9A-Za-z` (in the order of their bytes), or by adding a digit
 * when it cannot be raised, so a long run of items added at the end keeps its keys short.
 */

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
 * A key that comes before `key`: its last character lowered to the digit below it (with the last
 * digit after it when that is the first digit, which no key ends with)
 */
function keyBefore(key: string): string {
  const last = key.charCodeAt(key.length - 1);
  for (let d = CODES.length - 1; d >= 1; d--) {
    if (CODES[d] >= last) continue;
    return key.slice(0, -1) + DIGITS[d];
  }
  if (last > FIRST) return `${key.slice(0, -1)}${DIGITS[0]}${DIGITS[DIGITS.length - 1]}`;
  return keyBetween(null, key);
}

/**
 * `n` keys in their order between two keys (see {@link keyBetween}), made in halves so that many
 * keys put in one place stay short
 *
 * @internal
 */
export function keysBetween(below: string | null, above: string | null, n: number): string[] {
  if (n <= 0) return [];
  // One key at an end: the next one (an item put at the front or the back again and again grows
  // its key by a character every few dozen times)
  if (n === 1 && above === null) return [keyAfter(below)];
  if (n === 1 && below === null && above !== null) return [keyBefore(above)];
  if (n === 1) return [keyBetween(below, above)];
  // Many at the front: between the last key and the next one, in halves
  if (above === null) return keysBetween(below, keyAfter(below), n);
  const half = n >> 1;
  const middle = keyBetween(below, above);
  return [...keysBetween(below, middle, half), middle, ...keysBetween(middle, above, n - half - 1)];
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
