// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What the tables call before a read through their reading side (`beforeRead`)
 *
 * - Each read of the reading side calls it first: a row found, an id read, a view of a layer, each
 *   read of a view (a view kept from before included), each batch of a scan, the values read
 * - The reads of the internals do not
 * - Tables given nothing read as they are
 */

import { describe, expect, it } from 'vitest';
import { FEATURE_TABLE_COLUMNS } from '../table/tabane/columns.js';
import { featureRowDataBuilder as createPageDataBuilder } from '../test-utils.js';
import {
  createTables,
  type FeatureTablesInternals,
  featureTablesInternals,
} from './feature-tables.js';

function tablesWith(beforeRead?: () => void) {
  const { tables, writer } = createTables({
    columns: FEATURE_TABLE_COLUMNS,
    ...(beforeRead ? { beforeRead } : {}),
  });
  const builder = createPageDataBuilder({ columns: FEATURE_TABLE_COLUMNS });
  for (let i = 0; i < 5; i++) {
    builder.addRow({
      id: `p${i}`,
      type: 'Point',
      geometry: { type: 'Point', coordinates: [i, 0] },
      key: `a${i}`,
    });
  }
  writer.addPages('a', builder.finish());
  const internals = featureTablesInternals(tables) as FeatureTablesInternals;
  internals.addQueuedPages();
  return { tables, internals };
}

describe('what the tables call before a read', () => {
  it('is called before each read of the reading side, and not by the internals', () => {
    let calls = 0;
    const { tables, internals } = tablesWith(() => {
      calls++;
    });
    const handle = tables.getRowRef('p2') as number;
    expect(calls).toBe(1);
    expect(tables.getRowId(handle)).toBe('p2');
    expect(calls).toBe(2);
    const view = tables.get('a');
    expect(calls).toBe(3);
    expect(view?.rowCount).toBe(5);
    expect(view?.getRowPoint(handle)).toEqual([2, 0]);
    expect(calls).toBe(5);
    const cursor = tables.scan({ layerIds: ['a'], rowsPerRead: 2 });
    expect(calls).toBe(6);
    let batches = 0;
    while (cursor.next()) batches++;
    expect(batches).toBe(3);
    // Each batch, and the read that finds none left
    expect(calls).toBe(10);
    const before = calls;
    internals.view('a')?.rowCount;
    internals.placeOf(handle);
    expect(calls).toBe(before);
  });

  it('reads as they are without it', () => {
    const { tables } = tablesWith();
    const view = tables.get('a');
    expect(view?.rowCount).toBe(5);
    expect(tables.getRowRef('p4')).toBeDefined();
  });
});
