// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The reference model of the Store: what the rewrites of a document mean, compared with a Store
 * after every step of a sequence
 *
 * - `model.ts`: the model, and the steps turned into operations
 * - `store-subject.ts`: the thin part that joins it to a Store of core
 * - `run.ts`: a sequence run on both, compared after every step
 * - `random.ts`: sequences made from a seed
 * - `shrink.ts`: a sequence that fails made as short as it goes on failing
 */

export { compareIds, TableModel } from './model.js';
export { randomSteps, seededRandom } from './random.js';
export { firstDifference, type RunFailure, type RunResult, runSteps } from './run.js';
export { shrinkSteps } from './shrink.js';
export { readStore, storeSubject } from './store-subject.js';
export type * from './types.js';
