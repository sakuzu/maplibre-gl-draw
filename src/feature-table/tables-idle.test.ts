// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The work the tables do while the page is idle: the build of the index of the boxes of the rows
 *
 * - Tables of many rows build the index in slices at the idle periods they are given
 *   (`whenIdle`), so that no search waits for it; a search before the build ends finishes it
 * - The tables of a Store of core build it at the idle periods of the page (a timer where
 *   `requestIdleCallback` is missing)
 * - Tables given no idle periods leave the build to the first search
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTableStore } from '../store/table-memory.js';
import { createRowBlockDataBuilder } from '../table/row-group-builder.js';
import { FEATURE_TABLE_COLUMNS } from '../table/tabane/columns.js';
import { createFeatureTablesStore } from './feature-row-tables.js';
import type { FeatureTablesInternals } from './feature-tables.js';
import { createTables, featureTablesInternals } from './feature-tables.js';
import { IDLE_BUILD_FROM, type RowBoxIndex } from './row-box-index.js';

const COUNT = IDLE_BUILD_FROM + 100;

function blocks() {
  const builder = createRowBlockDataBuilder({ columns: FEATURE_TABLE_COLUMNS });
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

/** The index of the boxes of the rows of tables */
function indexOf(internals: FeatureTablesInternals): RowBoxIndex {
  return (internals as unknown as { rowBoxes: RowBoxIndex }).rowBoxes;
}

/** The number of rows of a layer whose boxes meet a box */
function countIn(internals: FeatureTablesInternals, minX: number, maxX: number): number {
  let count = 0;
  internals.searchRowBoxes(internals.layerTable('a') as never, minX, -1, maxX, 1, () => {
    count++;
  });
  return count;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('the work of the tables while the page is idle', () => {
  it('builds the index of the boxes at the idle periods given', () => {
    const tasks: ((deadline: number) => void)[] = [];
    const { tables, writer } = createFeatureTablesStore({
      whenIdle: (task) => {
        tasks.push(task);
        return () => {
          const at = tasks.indexOf(task);
          if (at >= 0) tasks.splice(at, 1);
        };
      },
    });
    writer.addRowBlocks('a', blocks());
    const internals = featureTablesInternals(tables) as FeatureTablesInternals;
    internals.addQueuedRowBlocks();
    expect(tasks.length).toBeGreaterThan(0);
    expect(indexOf(internals).building).toBe(true);
    for (let i = 0; i < 10_000 && tasks.length > 0; i++) {
      (tasks.shift() as (deadline: number) => void)(performance.now() + 50);
    }
    expect(indexOf(internals).building).toBe(false);
    expect(indexOf(internals).size).toBe(COUNT);
    expect(countIn(internals, -0.0005, 0.0995)).toBe(100);
  });

  it('finishes the build at a search that comes before its end', () => {
    const tasks: ((deadline: number) => void)[] = [];
    const { tables, writer } = createFeatureTablesStore({
      whenIdle: (task) => {
        tasks.push(task);
        return () => {
          const at = tasks.indexOf(task);
          if (at >= 0) tasks.splice(at, 1);
        };
      },
    });
    writer.addRowBlocks('a', blocks());
    const internals = featureTablesInternals(tables) as FeatureTablesInternals;
    internals.addQueuedRowBlocks();
    expect(countIn(internals, -0.0005, 0.0995)).toBe(100);
    expect(indexOf(internals).building).toBe(false);
    expect(tasks).toHaveLength(0);
  });

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
    writer.addRowBlocks('a', blocks());
    const internals = featureTablesInternals(store.tables) as FeatureTablesInternals;
    internals.addQueuedRowBlocks();
    expect(indexOf(internals).building).toBe(true);
    for (let i = 0; i < 10_000 && indexOf(internals).building; i++) vi.advanceTimersByTime(100);
    expect(indexOf(internals).building).toBe(false);
    expect(indexOf(internals).size).toBe(COUNT);
  });

  it('leaves the build to the first search in tables given no idle periods', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { tables, writer } = createTables({ columns: FEATURE_TABLE_COLUMNS });
    writer.addRowBlocks('a', blocks());
    const internals = featureTablesInternals(tables) as FeatureTablesInternals;
    internals.addQueuedRowBlocks();
    expect(indexOf(internals).building).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    expect(countIn(internals, -0.0005, 0.0995)).toBe(100);
    expect(indexOf(internals).size).toBe(COUNT);
  });
});
