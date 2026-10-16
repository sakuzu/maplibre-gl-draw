// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The ids and the keys of the rows of the Tabane format
 *
 * An id is an origin and a number. The origin is a 64-bit number that names where ids are made
 * (each origin numbers its ids from 1 and never uses a number twice); the number is from 1 to
 * 2^53 - 1. As text, an id is the origin in 13 digits of Crockford's base 32 (uppercase, most
 * significant first; the first digit holds the top 4 bits, so it is `0` to `F`), `-`, and the
 * number in base 32 without leading zeros: `1AAAAAAAAAAAA-1A`. Rows made together take numbers
 * that follow each other, so the ids of a run of rows are a few bytes.
 *
 * The rows of a run have no key of their own: row `i` of a run that follows the key `head` has
 * the key `head` followed by the suffix of `i`: one digit for the number of digits of `i` in base
 * 61, then those digits, written with `1` to `z` (`0-9A-Za-z` without `0`). A suffix never holds
 * a `0` and a larger `i` gives a larger suffix, so the rows keep their order and a key can be
 * made between two of them.
 *
 * A pure module: it depends on nothing outside `/table`, so it runs in a Worker as well.
 */

import { DrawError } from '../../shared/draw-error.js';

/** The digits of Crockford's base 32 */
const BASE32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
/** The value of each character code in {@link BASE32} (-1 for the others) */
const BASE32_VALUE = new Int8Array(128).fill(-1);
for (let k = 0; k < BASE32.length; k++) BASE32_VALUE[BASE32.charCodeAt(k)] = k;

/** The digits of a key, in the order of their values and their codes */
const KEY_DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/**
 * The id of a row: its origin (13 digits of base 32) and its number
 */
export interface TabaneId {
  readonly origin: string;
  readonly number: number;
}

/**
 * Whether a string is an origin: 13 digits of Crockford's base 32, the first `0` to `F`
 */
export function isTabaneOrigin(s: string): boolean {
  if (s.length !== 13) return false;
  for (let k = 0; k < 13; k++) {
    const c = s.charCodeAt(k);
    const v = c < 128 ? BASE32_VALUE[c] : -1;
    if (v < 0 || (k === 0 && v > 15)) return false;
  }
  return true;
}

/**
 * The 8 bytes of an origin, big-endian
 *
 * @internal
 */
export function originBytes(origin: string): Uint8Array {
  if (!isTabaneOrigin(origin))
    throw new DrawError('invalid-input', `Tabane: not an origin: ${origin}`);
  // 4 bits, then 12 digits of 5 bits: 64 bits as two halves of 32
  let hi = 0;
  let lo = BASE32_VALUE[origin.charCodeAt(0)];
  for (let k = 1; k < 13; k++) {
    const v = BASE32_VALUE[origin.charCodeAt(k)];
    // Shift (hi, lo) left by 5 and add v
    hi = ((hi << 5) | (lo >>> 27)) >>> 0;
    lo = ((lo << 5) | v) >>> 0;
  }
  const out = new Uint8Array(8);
  const view = new DataView(out.buffer);
  view.setUint32(0, hi, false);
  view.setUint32(4, lo, false);
  return out;
}

/**
 * The origin of 8 bytes, big-endian
 *
 * @internal
 */
export function originOf(bytes: Uint8Array, at = 0): string {
  const view = new DataView(bytes.buffer, bytes.byteOffset + at, 8);
  let hi = view.getUint32(0, false);
  let lo = view.getUint32(4, false);
  const digits = new Array<string>(13);
  for (let k = 12; k >= 1; k--) {
    digits[k] = BASE32[lo & 31];
    lo = ((lo >>> 5) | ((hi & 31) << 27)) >>> 0;
    hi >>>= 5;
  }
  digits[0] = BASE32[lo & 15];
  return digits.join('');
}

/**
 * A number in base 32 without leading zeros
 *
 * @internal
 */
export function base32Of(n: number): string {
  let s = '';
  let rest = n;
  do {
    s = BASE32[rest % 32] + s;
    rest = Math.floor(rest / 32);
  } while (rest > 0);
  return s;
}

/**
 * The text of an id: the origin, `-`, the number in base 32
 */
export function tabaneIdText(id: TabaneId): string {
  return `${id.origin}-${base32Of(id.number)}`;
}

/**
 * The id of a text, or null when the text is not one: 13 digits of an origin, `-`, and a number
 * from 1 to 2^53 - 1 in base 32 without leading zeros
 */
export function parseTabaneId(text: string): TabaneId | null {
  if (text.length < 15 || text.length > 25 || text.charCodeAt(13) !== 45) return null;
  const origin = text.slice(0, 13);
  if (!isTabaneOrigin(origin)) return null;
  if (text.charCodeAt(14) === 48) return null;
  let n = 0;
  for (let k = 14; k < text.length; k++) {
    const c = text.charCodeAt(k);
    const v = c < 128 ? BASE32_VALUE[c] : -1;
    if (v < 0) return null;
    n = n * 32 + v;
  }
  if (n < 1 || n > Number.MAX_SAFE_INTEGER) return null;
  return { origin, number: n };
}

/**
 * The suffix of row `i` of a run: the number of its digits (one key digit), then its digits in
 * base 61 written with `1` to `z`
 */
export function tabaneRowSuffix(i: number): string {
  if (!Number.isSafeInteger(i) || i < 0)
    throw new DrawError('invalid-input', `Tabane: not a row: ${i}`);
  let digits = '';
  let rest = i;
  do {
    digits = KEY_DIGITS[1 + (rest % 61)] + digits;
    rest = Math.floor(rest / 61);
  } while (rest > 0);
  return KEY_DIGITS[digits.length] + digits;
}

/**
 * The bytes of the suffix of row `i` (see {@link tabaneRowSuffix}) written into `out` at `at`
 *
 * @returns The number of bytes written (at most 10)
 * @internal
 */
export function writeRowSuffix(i: number, out: Uint8Array, at: number): number {
  let count = 0;
  let rest = i;
  do {
    count++;
    rest = Math.floor(rest / 61);
  } while (rest > 0);
  out[at] = KEY_DIGITS.charCodeAt(count);
  rest = i;
  for (let k = count; k >= 1; k--) {
    out[at + k] = KEY_DIGITS.charCodeAt(1 + (rest % 61));
    rest = Math.floor(rest / 61);
  }
  return count + 1;
}
