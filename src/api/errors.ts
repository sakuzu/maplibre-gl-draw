// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// The error of the library, as the public types give it: the class lives in the lowest shared
// layer, so that every layer throws the same class.

export type { DrawErrorCode } from '../shared/errors.js';
export { DrawError } from '../shared/errors.js';
