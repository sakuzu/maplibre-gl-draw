// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The columns of a feature as a row of Tabane and as the tables hold them: the same columns
 */

import { describe, expect, it } from 'vitest';
import { FEATURE_TABLE_COLUMNS, TABANE_FEATURE_COLUMNS } from './columns.js';

/** The type of a column of the tables for each kind of a column of Tabane */
const TYPE_OF_KIND: Readonly<Record<string, string>> = {
  shape: 'shape',
  flag: 'flag',
  value: 'value',
  struct: 'struct',
};

describe('the columns of a feature', () => {
  it('are the same columns, in the same order, as a row of Tabane and in the tables', () => {
    const tables = Object.entries(FEATURE_TABLE_COLUMNS).map(([name, declared]) => [
      name,
      typeof declared === 'string' ? declared : declared.type,
    ]);
    const tabane = Object.entries(TABANE_FEATURE_COLUMNS).map(([name, kind]) => [
      name,
      TYPE_OF_KIND[kind],
    ]);
    // The order makes the bits of the flags: it is the same too
    expect(tables).toEqual(tabane);
  });
});
