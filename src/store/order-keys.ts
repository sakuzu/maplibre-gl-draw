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
