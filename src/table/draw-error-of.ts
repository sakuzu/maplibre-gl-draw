// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The errors of the packages the library calls, as its own error (`drawErrorOf`)
 *
 * The library throws only `DrawError` from its entries. An error of the tables of rows
 * (`KasaneError`) or of `@sakuzu/tabane` (`TabaneError`) is wrapped where the library called
 * them, in a `DrawError` of the same reason and message, the error wrapped held as `cause` (the
 * tables write their codes in camelCase, core in kebab-case: `DRAW_CODES` maps them).
 * What a function given by the caller throws (a listener, a system of coordinates, the rings of a
 * row) is the caller's, and is not wrapped: an entry that runs such a function wraps only the
 * errors of the tables (`KasaneError`), which no function of the caller throws.
 */

import { KasaneError, type KasaneErrorCode } from '@sakuzu/kasane';
import { TabaneError } from '@sakuzu/tabane';
import { DrawError, type DrawErrorCode } from '../shared/draw-error.js';

/** The code of a `DrawError` of the same reason as each code of the tables */
const DRAW_CODES: Readonly<Record<KasaneErrorCode, DrawErrorCode>> = {
  invalidInput: 'invalid-input',
  notFound: 'not-found',
  alreadyExists: 'already-exists',
  invalidState: 'invalid-state',
  unsupportedFormat: 'unsupported-format',
};

/**
 * A `KasaneError` or a `TabaneError` as a `DrawError` of the same reason and message, with it as
 * the cause (`cause`); any other error, a `DrawError` among them, as it is
 *
 * @internal
 */
export function drawErrorOf(error: unknown): unknown {
  if (error instanceof KasaneError) {
    return new DrawError(DRAW_CODES[error.code] ?? 'invalid-input', error.message, {
      cause: error,
    });
  }
  if (error instanceof TabaneError) {
    return new DrawError(error.code, error.message, { cause: error });
  }
  return error;
}
