// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The reference model of the tables: what the writes of rows and of groups mean, in the words of
 * the tables (a parent and a key, the columns declared, values of rows, tokens that are numbers),
 * compared with the implementation of the tables after every step of a sequence
 *
 * - `model.ts`: the model, and the steps turned into operations
 * - `subject.ts`: the thin part that joins it to the tables
 * - `run.ts`: a sequence run on both, compared after every step
 * - `random.ts`: sequences made from a seed
 * - `shrink.ts`: a sequence that fails made as short as it goes on failing
 */

export { GROUP_IDS, ROW_IDS, seededRandom, TABLE_IDS, TablesModel } from './model.js';
export { randomModelSteps } from './random.js';
export {
  firstDifference,
  type ModelRunFailure,
  runModelOperations,
  runModelSteps,
} from './run.js';
export { shrinkModelSteps } from './shrink.js';
export { MODEL_COLUMNS, MODEL_GROUP_COLUMNS, tablesSubject } from './subject.js';
export type * from './types.js';
