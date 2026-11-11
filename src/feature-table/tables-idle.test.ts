// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The work the tables of a Store of core do while the page is idle: the build of the index of the
 * boxes of the rows, at the idle periods of the page (a timer where `requestIdleCallback` is
 * missing). How the tables build it at the idle periods they are given, and without them, is in
 * the tests of Kasane.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTableStore } from '../store/table-memory.js';
import { FEATURE_TABLE_COLUMNS } from '../table/tabane/columns.js';
import { featureRowDataBuilder as createPageDataBuilder } from '../test-utils.js';
import type { FeatureTablesInternals } from './feature-tables.js';
import { featureTablesInternals } from './feature-tables.js';

/** More rows than the tables index at once: their index is built at idle periods */
const COUNT = 20_000;

function blocks() {
  const builder = createPageDataBuilder({ columns: FEATURE_TABLE_COLUMNS });
  for (let i = 0; i < COUNT; i++) {
    builder.addRow({
      id: `p${i}`,
      type: 'Point',
      geometry: { type: 'Point', coordinates: [i * 0.001, 0] },
      key: `a${String(i).padStart(6, '0')}`,
    });
  }
  return builder.finish();
}

/** The number of rows of a layer whose boxes meet a box */
function countIn(internals: FeatureTablesInternals, minX: number, maxX: number): number {
  let count = 0;
  internals.searchRowBoxes(internals.rowTable('a') as never, minX, -1, maxX, 1, () => {
    count++;
  });
  return count;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('the work of the tables of a Store of core while the page is idle', () => {
  it('builds the index of the boxes of a Store of core at the idle periods of the page', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { store, writer } = createTableStore();
    store.createLayer({
      id: 'a',
      name: 'a',
      visible: true,
      locked: false,
      opacity: 1,
      kind: 'table',
      styleRule: undefined,
      metadata: undefined,
    });
    writer.addPages('a', blocks());
    const internals = featureTablesInternals(store.tables) as FeatureTablesInternals;
    internals.addQueuedPages();
    // The build waits for an idle period of the page
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    for (let i = 0; i < 10_000 && vi.getTimerCount() > 0; i++) vi.advanceTimersByTime(100);
    // Built, it asks for no more
    expect(vi.getTimerCount()).toBe(0);
    expect(countIn(internals, -0.0005, 0.0995)).toBe(100);
    expect(internals.rowBoxIndexSize().rows).toBe(COUNT);
  });
});
