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
 * - `not-found`: an ID that does not exist
 * - `already-exists`: an ID that is already taken
 * - `invalid-input`: an input of the wrong shape or value
 * - `unsupported-format`: a source that cannot be read
 * - `invalid-state`: a call that is not possible in the current situation, such as deleting
 *   a feature while it is being drawn, or any call on an instance that was destroyed
 */
export type DrawErrorCode =
  | 'not-found'
  | 'already-exists'
  | 'invalid-input'
  | 'unsupported-format'
  | 'invalid-state';

/**
 * The error a method throws when an argument is wrong; the method has changed nothing.
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
