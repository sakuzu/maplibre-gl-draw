// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The error of the geometry module
 *
 * The boolean operations run on polygon-clipping, which reports a failure by throwing an
 * Error whose message is its own internal wording (a sweep-line event, a segment id). Such
 * a failure leaves the module as a GeometryError instead: the reason is a stable code the
 * caller can branch on, and the original error is kept as `cause` for diagnosis. An input
 * whose shape a function cannot take leaves as a GeometryError too.
 */

/**
 * Why a geometry function failed: `invalid-input` for an input whose shape the function cannot
 * take, `engine-failure` for a boolean operation that could not compute a result.
 */
export type GeometryErrorCode = 'invalid-input' | 'engine-failure';

/**
 * The boolean operation that runs inside a function
 *
 * @internal
 */
export type GeometryOperation = 'union' | 'difference' | 'intersection';

/**
 * The error a geometry function throws for an input it cannot take or when its boolean
 * operation cannot compute a result.
 *
 * A failure of a boolean operation is first retried once with the coordinates rounded to a
 * 1e-9 degree grid (about 0.1 mm); the error is thrown only when the retry fails too. Branch
 * on `code`; the message is `<operation>: <reason>` in English and is meant for logs.
 *
 * @example
 * ```ts
 * import type { Polygon } from 'geojson';
 * import { GeometryError, union } from '@sakuzu/maplibre-gl-draw/geometry';
 *
 * function tryMerge(a: Polygon, b: Polygon) {
 *   try {
 *     return union([a, b]);
 *   } catch (error) {
 *     if (error instanceof GeometryError && error.code === 'engine-failure') {
 *       // Keep the inputs as they are and tell the user the merge failed
 *       return null;
 *     }
 *     throw error;
 *   }
 * }
 * ```
 */
export class GeometryError extends Error {
  /** Why the function failed */
  readonly code: GeometryErrorCode;
  /** The name of the function that failed, such as `union` or `buffer` */
  readonly operation: string;
  /** The error that caused this one, kept for diagnosis */
  readonly cause: unknown;

  /**
   * Creates the error. The library creates it; a caller only needs to catch it.
   *
   * @param code Why the function failed
   * @param operation The name of the function that failed
   * @param message The message, `<operation>: <reason>`
   * @param options The original error as `cause`
   */
  constructor(
    code: GeometryErrorCode,
    operation: string,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message);
    this.name = 'GeometryError';
    this.code = code;
    this.operation = operation;
    this.cause = options?.cause;
  }
}

/**
 * Classifies an error thrown by polygon-clipping by its message
 *
 * The messages are those of polygon-clipping 0.15. An input it rejects is `invalid-input`;
 * everything else is `engine-failure`.
 */
function classify(error: unknown): GeometryErrorCode {
  const message = error instanceof Error ? error.message : String(error);
  if (
    message.startsWith('Input geometry is not a valid') ||
    message.startsWith('Tried to create degenerate segment')
  ) {
    return 'invalid-input';
  }
  return 'engine-failure';
}

/** The message of each reason of a boolean operation */
const MESSAGES: Record<GeometryErrorCode, string> = {
  'invalid-input': 'the input is not a valid polygon',
  'engine-failure': 'the boolean operation failed',
};

/**
 * Wraps an error thrown by polygon-clipping into a GeometryError
 *
 * @internal
 */
export function toGeometryError(error: unknown, operation: GeometryOperation): GeometryError {
  const code = classify(error);
  return new GeometryError(code, operation, `${operation}: ${MESSAGES[code]}`, { cause: error });
}

/**
 * Creates the error for an input whose shape a function cannot take
 *
 * @internal
 */
export function invalidInput(operation: string, reason: string): GeometryError {
  return new GeometryError('invalid-input', operation, `${operation}: ${reason}`);
}

/**
 * Runs a computation and renames the function of a GeometryError it throws
 *
 * The boolean operations name themselves (`union`, `difference`, `intersection`); a public
 * function that runs them reports its own name instead, keeping the reason and the cause.
 *
 * @internal
 */
export function withOperation<T>(operation: string, run: () => T): T {
  try {
    return run();
  } catch (error) {
    if (error instanceof GeometryError && error.operation !== operation) {
      const reason = error.message.slice(error.message.indexOf(': ') + 2);
      throw new GeometryError(error.code, operation, `${operation}: ${reason}`, {
        cause: error.cause,
      });
    }
    throw error;
  }
}
