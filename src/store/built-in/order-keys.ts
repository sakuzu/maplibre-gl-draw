// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Keys of the order of the items of a layer and of the members of a group (fractional indexes),
 * and `createOrderKeyBetween`, which makes one for a caller that writes to the Store directly
 *
 * A key is a string compared by its UTF-8 bytes. A key at an end of a container counts up and
 * down from the first key and does not grow (`keyNextTo`): its first digit tells how many digits
 * its whole part has, as the keys of the rows of the pages of the tables do, so a long run of items
 * added at an end keeps its keys short. A key that does not read as one of those, which may be
 * any string, gets a key by its last character: the next digit of `0-9A-Za-z` (in the order of
 * their bytes), or one more digit when it cannot be raised.
 *
 * @internal
 */

import { DrawError } from '../../shared/errors.js';

/** The digits of the keys, in the order of their bytes */
const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/** The key of the first item of an empty container */
export const FIRST_KEY = 'V';

/** The value of the first digit of the keys without a whole part (`V`) */
const NO_WHOLE = 31;

/** The code of each digit */
const CODES: readonly number[] = Array.from(DIGITS, (digit) => digit.charCodeAt(0));
const FIRST = CODES[0];

/** The value of the digit at `at` of a text (-1 for a character that is not a digit) */
function digitAt(text: string, at: number): number {
  return DIGITS.indexOf(text.charAt(at));
}

/**
 * Steps a whole part of digits up or down, past the values that end with `0` (no key does);
 * false when it runs out of its digits
 */
function stepWhole(values: number[], step: 1 | -1): boolean {
  do {
    let k = values.length - 1;
    for (; k >= 0; k--) {
      const value = values[k] + step;
      values[k] = (value + DIGITS.length) % DIGITS.length;
      if (value >= 0 && value < DIGITS.length) break;
    }
    if (k < 0) return false;
  } while (values[values.length - 1] === 0);
  return true;
}

/**
 * The key next to the whole part of `key`, up or down: the first digit tells how many digits the
 * whole part has, `V` none, and one more for each digit up from it (`W` one, `X` two) or down from
 * it (`U` one, `T` two). The keys counted so are `V`, `W1` to `Wz`, `X01` to `X0z`, `X11` and so
 * on, no value ending with `0`. What follows the whole part is left out and the digits it lacks
 * are read as `0`, so any key of digits gives one.
 *
 * @returns The key; null when `key` does not start with digits, or the digits of the whole part
 *   are used up
 */
function keyNextTo(key: string, step: 1 | -1): string | null {
  const head = digitAt(key, 0);
  if (head < 0) return null;
  const width = Math.abs(head - NO_WHOLE);
  const values = new Array<number>(width).fill(0);
  for (let k = 0; k < width && k + 1 < key.length; k++) {
    const value = digitAt(key, k + 1);
    if (value < 0) return null;
    values[k] = value;
  }
  if (stepWhole(values, step)) {
    return DIGITS[head] + values.map((value) => DIGITS[value]).join('');
  }
  const next = head + step;
  if (next < 0 || next >= DIGITS.length) return null;
  const digits = Math.abs(next - NO_WHOLE);
  if (digits === 0) return DIGITS[next];
  return DIGITS[next] + (step > 0 ? `${'0'.repeat(digits - 1)}1` : 'z'.repeat(digits));
}

/**
 * A key that comes after `key` (the first key when there is none)
 *
 * @internal
 */
export function keyAfter(key: string | null | undefined): string {
  if (!key) return FIRST_KEY;
  return keyNextTo(key, 1) ?? raisedKey(key);
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
  return keyNextTo(key, -1) ?? loweredKey(key);
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

/** Throws unless a key given to `createOrderKeyBetween` is a key (undefined for no bound) */
function checkKey(key: unknown, name: string): asserts key is string | undefined {
  if (key === undefined || (typeof key === 'string' && key !== '')) return;
  throw new DrawError(
    'invalidInput',
    `createOrderKeyBetween: ${name} is not a key of order (a non-empty string, or undefined)`,
  );
}

/**
 * Makes a key of order between two keys ({@link FeatureRowField}, `orderKey`), as the instance
 * makes one for an item put between two others: for a caller that writes to the Store directly.
 * The key is greater than `before` and less than `after`, compared as strings of bytes.
 *
 * @param before - The key of the item behind, or `undefined` for the back of all
 * @param after - The key of the item in front, or `undefined` for the front of all
 * @returns The new key
 * @throws `DrawError` with the code `invalidInput` when `before` is not less than `after`
 */
export function createOrderKeyBetween(
  before: string | undefined,
  after: string | undefined,
): string {
  checkKey(before, 'before');
  checkKey(after, 'after');
  if (before !== undefined && after !== undefined && compareKeys(before, after) >= 0) {
    throw new DrawError(
      'invalidInput',
      `createOrderKeyBetween: ${JSON.stringify(before)} is not less than ${JSON.stringify(after)}`,
    );
  }
  if (after === undefined) return keyAfter(before);
  const key = before === undefined ? keyBefore(after) : keyBetween(before, after);
  if (compareKeys(key, after) < 0 && (before === undefined || compareKeys(before, key) < 0)) {
    return key;
  }
  // `after` is `before` followed only by characters below every digit: no key of digits is
  // between them
  throw new DrawError(
    'invalidInput',
    `createOrderKeyBetween: no key is between ${JSON.stringify(before)} and ${JSON.stringify(after)}`,
  );
}
