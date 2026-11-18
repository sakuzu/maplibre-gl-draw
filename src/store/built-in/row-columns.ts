// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The columns the rows of the features are held in, in the tables and in the pages built for
 * them (`createRowPageBuilder`), and the dimensions of the positions of a layer. A pure module, so
 * that a Worker that builds pages runs it as well.
 *
 * @internal
 */

import type { TableColumns } from '@sakuzu/kasane';

/**
 * The columns of the rows of the features
 *
 * @internal
 */
export const ROW_COLUMNS: TableColumns = Object.freeze({
  type: 'value',
  geometry: 'shape',
  style: Object.freeze({ type: 'value', dictionary: 'tables' }),
  properties: 'struct',
  hidden: 'flag',
  locked: 'flag',
});

/**
 * The dimensions of the positions of pages built for a number of values per position (the third
 * value of three is held as a height)
 *
 * @internal
 */
export function dimensionsOfValues(valuesPerPosition: 2 | 3 | 4): 'xy' | 'xyz' | 'xyzm' {
  if (valuesPerPosition === 2) return 'xy';
  return valuesPerPosition === 4 ? 'xyzm' : 'xyz';
}
