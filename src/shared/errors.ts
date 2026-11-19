// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The error thrown for a wrong argument
 *
 * A method throws it when an argument is wrong (an ID that does not exist, an input of the
 * wrong shape) and changes nothing. A refusal because of the state (read-only, a lock) is not
 * an error: the method returns `null` or `false` instead.
 */

/**
 * Why a {@link DrawError} was thrown.
 *
 * - `notFound`: an ID that does not exist
 * - `alreadyExists`: an ID that is already taken
 * - `invalidInput`: an input of the wrong shape or value
 * - `unsupportedFormat`: a source that cannot be read
 * - `invalidState`: a call that is not possible in the current situation, such as deleting
 *   a feature while it is being drawn, or any call on an instance that was destroyed
 * - `tooManyItems`: a read that would return more than 10,000 features, groups or IDs in one
 *   array; they are read with an `iterate` method, `IdSet.iterate` or a range instead
 */
export type DrawErrorCode =
  | 'notFound'
  | 'alreadyExists'
  | 'invalidInput'
  | 'unsupportedFormat'
  | 'invalidState'
  | 'tooManyItems';

/**
 * The error a method throws when an argument is wrong, or when a read would return more than
 * it returns at once; the method has changed nothing.
 */
export class DrawError extends Error {
  /** Why it was thrown */
  readonly code: DrawErrorCode;
  /** More about the cause, such as the ID that was not found */
  readonly details?: unknown;

  /**
   * Creates the error
   *
   * @param code - Why it is thrown
   * @param message - A description in English, for logs
   * @param details - More about the cause
   */
  constructor(code: DrawErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'DrawError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}
