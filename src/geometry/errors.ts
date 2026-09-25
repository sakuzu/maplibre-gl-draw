// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The error of the geometry module
 *
 * The boolean operations run on polygon-clipping, which reports a failure by throwing an
 * Error whose message is its own internal wording (a sweep-line event, a segment id). Such
 * a failure leaves the module as a GeometryError instead: the reason is a stable code the
 * caller can branch on, and the original error is kept as `cause` for diagnosis.
 */

/**
 * Why a geometry operation failed
 *
 * - `invalid-input`: the input is not a polygon the operation can take (a degenerate
 *   segment, a malformed ring)
 * - `unclosed-ring`: the output ring could not be closed, typically because edges nearly
 *   coincide within floating-point precision (still failing after the retry on the grid)
 * - `too-complex`: the operation gave up on an input too large or tangled for it
 * - `internal`: any other failure inside the boolean operation engine
 */
export type GeometryErrorCode = 'invalid-input' | 'unclosed-ring' | 'too-complex' | 'internal';

/**
 * The boolean operation that failed.
 *
 * It can differ from the function called: {@link normalizeArea} and {@link unionAll} run
 * `union`, and {@link buffer} runs `union` and `difference`.
 */
export type GeometryOperation = 'union' | 'difference' | 'intersection';

/**
 * The error a geometry operation throws when the boolean operation engine cannot compute a
 * result.
 *
 * Every function that runs a boolean operation can throw it: the boolean operations,
 * {@link splitArea}, {@link buffer}, the polygon predicates and {@link sphericalArea}. A
 * failure is first retried once with the coordinates rounded to a 1e-9 degree grid (about
 * 0.1 mm); this error is thrown only when the retry fails too. Branch on `code`, which is
 * stable across versions of the engine; the message is `<operation>: <reason>` in English
 * and is meant for logs.
 *
 * @example
 * ```ts
 * import type { PolygonCoordinates } from '@sakuzu/maplibre-gl-draw/geometry';
 * import { GeometryError, union } from '@sakuzu/maplibre-gl-draw/geometry';
 *
 * function tryMerge(a: PolygonCoordinates, b: PolygonCoordinates) {
 *   try {
 *     return union(a, b);
 *   } catch (error) {
 *     if (error instanceof GeometryError && error.code === 'unclosed-ring') {
 *       // Keep the inputs as they are and tell the user the merge failed
 *       return null;
 *     }
 *     throw error;
 *   }
 * }
 * ```
 */
export class GeometryError extends Error {
  /** Why the operation failed */
  readonly code: GeometryErrorCode;
  /** The boolean operation that failed */
  readonly operation: GeometryOperation;
  /** The error thrown by the boolean operation engine, kept for diagnosis */
  readonly cause: unknown;

  /**
   * Creates the error. The library creates it; a caller only needs to catch it.
   *
   * @param code Why the operation failed
   * @param operation The boolean operation that failed
   * @param message The message, `<operation>: <reason>`
   * @param options The original error as `cause`
   */
  constructor(
    code: GeometryErrorCode,
    operation: GeometryOperation,
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
 * The messages are those of polygon-clipping 0.15; one that is not recognized is `internal`.
 */
function classify(error: unknown): GeometryErrorCode {
  const message = error instanceof Error ? error.message : String(error);
  if (
    message.startsWith('Input geometry is not a valid') ||
    message.startsWith('Tried to create degenerate segment')
  ) {
    return 'invalid-input';
  }
  if (message.startsWith('Unable to complete output ring')) {
    return 'unclosed-ring';
  }
  if (message.startsWith('Infinite loop')) {
    return 'too-complex';
  }
  return 'internal';
}

/** The message of each reason */
const MESSAGES: Record<GeometryErrorCode, string> = {
  'invalid-input': 'the input is not a valid polygon',
  'unclosed-ring': 'the output ring could not be closed',
  'too-complex': 'the input is too complex',
  internal: 'the boolean operation failed',
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
