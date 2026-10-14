// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The error thrown for a wrong argument
 *
 * A method throws it when an argument is wrong (an ID that does not exist, an input of the
 * wrong shape) and changes nothing. A refusal because of the state (read-only, a lock) is not
 * an error: the method returns `null` or `false` instead.
 */

export type { DrawErrorCode } from '../shared/draw-error.js';
export { DrawError } from '../shared/draw-error.js';
