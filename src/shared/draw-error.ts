// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The one shape of a failure (re-exported by the main entry, `api/errors.ts`)
 *
 * A pure module: it depends on nothing, so the parts that run in a Worker throw it as well.
 */

/**
 * Why a {@link DrawError} was thrown. An open union: a reader writes a default case, and a code
 * is added in a minor release.
 *
 * What was given is wrong:
 *
 * - `invalid-input`: an input of the wrong shape or value
 * - `not-found`: an ID that does not exist
 * - `already-exists`: an ID that is already taken
 * - `unsupported-format`: a source that cannot be read
 * - `too-large`: what was asked for does not fit under a limit
 *
 * The state does not allow it now:
 *
 * - `invalid-state`: a call that is not possible in the current situation, such as an undo with
 *   nothing to undo, or any call on an instance that was removed
 * - `not-open`: the document is not open
 * - `not-editable`: the document cannot be written now (the instance is read-only)
 * - `locked`: a feature, a group or a layer written is locked
 *
 * The transaction:
 *
 * - `transaction-closed`: a write of a transaction whose function has ended
 * - `write-not-finished`: a read of a transaction while one of its writes is still under way
 * - `nested-write`: `draw.write` called in the synchronous part of the function of another
 * - `unsent-writes`: the document would be replaced while writes are not yet sent
 *
 * The storage:
 *
 * - `refused`: the storage refused a commit
 * - `credential`: the credential of the storage ran out
 * - `permission`: the storage does not allow it
 * - `network`: the storage could not be reached
 *
 * - `aborted`: stopped by the signal of the call
 */
export type DrawErrorCode =
  | 'invalid-input'
  | 'not-found'
  | 'already-exists'
  | 'unsupported-format'
  | 'too-large'
  | 'invalid-state'
  | 'not-open'
  | 'not-editable'
  | 'locked'
  | 'transaction-closed'
  | 'write-not-finished'
  | 'nested-write'
  | 'unsent-writes'
  | 'refused'
  | 'credential'
  | 'permission'
  | 'network'
  | 'aborted';

/** The codes for which the same call may succeed when made again later */
const RETRYABLE: ReadonlySet<DrawErrorCode> = new Set(['network', 'write-not-finished']);

/**
 * The one shape of a failure. What was called and failed throws it (a promise rejects with it);
 * nothing changed then.
 */
export class DrawError extends Error {
  /** Why it was thrown */
  readonly code: DrawErrorCode;
  /** Whether the same call has a chance to succeed when made again */
  readonly retryable: boolean;
  /** The IDs of the features, layers and groups it is about */
  readonly ids: readonly string[];
  /** What failed underneath, when something did */
  declare readonly cause?: unknown;

  /**
   * Creates the error
   *
   * @param code - Why it is thrown
   * @param message - A description in English, for logs
   * @param options - `cause` is what failed underneath, `ids` the IDs it is about
   */
  constructor(
    code: DrawErrorCode,
    message: string,
    options?: { readonly cause?: unknown; readonly ids?: readonly string[] },
  ) {
    super(message);
    this.name = 'DrawError';
    if (options?.cause !== undefined) {
      Object.defineProperty(this, 'cause', {
        value: options.cause,
        writable: true,
        configurable: true,
      });
    }
    this.code = code;
    this.retryable = RETRYABLE.has(code);
    this.ids = Object.freeze([...(options?.ids ?? [])]);
  }
}

/**
 * A `too-large` refusal of a share of a limit: `retryable` tells whether it can succeed later,
 * once others hold less
 *
 * @internal
 */
export function limitError(message: string, retryable: boolean): DrawError {
  const error = new DrawError('too-large', message);
  Object.defineProperty(error, 'retryable', { value: retryable });
  return error;
}
