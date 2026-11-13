// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The columns of a feature as a row of Tabane and as the tables hold them: the same columns
 */

import { describe, expect, it } from 'vitest';
import { FEATURE_TABLE_COLUMNS, TABANE_FEATURE_COLUMNS } from './columns.js';

describe('the columns of a feature', () => {
  it('are the same columns, in the same order, as a row of Tabane and in the tables', () => {
    const tables = Object.entries(FEATURE_TABLE_COLUMNS).map(([name, declared]) => [
      name,
      typeof declared === 'string' ? declared : declared.type,
    ]);
    // The kinds of a column of Tabane are the types of a column of the tables. The order makes the
    // bits of the flags: it is the same too
    expect(tables).toEqual(Object.entries(TABANE_FEATURE_COLUMNS));
  });
});
