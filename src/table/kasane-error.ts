// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The error the tables of rows throw ({@link KasaneError})
 *
 * The tables throw only this error: an error of `@sakuzu/tabane` thrown while they write or read
 * values is held as the cause of one of the same code ({@link kasaneErrorOf}). What a function
 * given to them throws (a system of coordinates, the rings of a row, a listener) is not theirs,
 * and goes through as it is.
 *
 * A pure module: it depends on nothing but `@sakuzu/tabane`, so the parts that run in a Worker
 * throw it as well.
 */

import { TabaneError } from '@sakuzu/tabane';

/**
 * Why a {@link KasaneError} was thrown
 *
 * - `invalid-input`: an input of the wrong shape or value
 * - `not-found`: something named that is not there
 * - `already-exists`: something that is already there
 * - `invalid-state`: a call that is not possible in the current situation
 * - `unsupported-format`: bytes that cannot be read
 */
export type KasaneErrorCode =
  | 'invalid-input'
  | 'not-found'
  | 'already-exists'
  | 'invalid-state'
  | 'unsupported-format';

/**
 * The error of the tables of rows
 */
export class KasaneError extends Error {
  /** Why it was thrown */
  readonly code: KasaneErrorCode;
  /** The error it was thrown for (an error of `@sakuzu/tabane`), when there is one */
  readonly cause?: unknown;

  /**
   * Creates the error
   *
   * @param code - Why it is thrown
   * @param message - A description in English, for logs
   * @param options - The error it is thrown for
   */
  constructor(code: KasaneErrorCode, message: string, options?: { readonly cause?: unknown }) {
    super(message);
    this.name = 'KasaneError';
    this.code = code;
    if (options && 'cause' in options) this.cause = options.cause;
  }
}

/**
 * An error of `@sakuzu/tabane` as a {@link KasaneError} of the same code, with it as the cause;
 * any other error as it is
 */
export function kasaneErrorOf(error: unknown): unknown {
  if (error instanceof TabaneError) {
    return new KasaneError(error.code, error.message, { cause: error });
  }
  return error;
}
