// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A value given to the library, read as Tabane reads it (`valueOfInput` of `@sakuzu/tabane`), with
 * the error of the library: what is not a value is refused with a `DrawError`, as every input of
 * the API is
 */

import { type Value, valueOfInput } from '@sakuzu/tabane';
import { drawErrorOf } from './draw-error-of.js';

/**
 * The value given, in the one form the library holds
 *
 * @param what - What the value is, for the message of the error
 * @throws `DrawError` with the code `invalid-input` when it is not a value
 */
export function drawValueOfInput(value: unknown, what: string): Value {
  try {
    return valueOfInput(value, what);
  } catch (error) {
    throw drawErrorOf(error);
  }
}
