// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The parts of the bulk edits on a clock of the tests where both the writes and the work of the
 * listeners of each change take time per row: a move (a row written at a time, dear) and the
 * writing back of that move (rows written as columns, cheap), with 1,000, 10,000 and 100,000
 * features
 *
 * - Every part, its transaction and the work of the listeners of its change together, takes no
 *   more than twice the budget of a part
 * - The first part, written before the work of the listeners is known, writes no more than a
 *   batch, whatever the number of features
 * - The largest part with 100,000 features writes less than twice the rows of the largest part
 *   with 10,000
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore } from '../../store/built-in/create-store.js';
import type { FeatureRowField, RowValues, Store, StoreChange } from '../../store/built-in/types.js';
import { createMapStub } from '../../test-utils.js';
import type { Draw } from '../draw.js';
import type { DocumentChange } from '../events.js';
import type { EditCounts } from '../features.js';
import type { FeatureValues } from '../model.js';
import { BULK_BATCH_MAX, BULK_PART_BUDGET_MS } from './bulk-edits.js';
import { createDrawOnEngine } from './create-draw.js';
import { createEngine } from './engine.js';
import { toEngineOptions } from './options.js';

/** The time of one write of the Store, whatever its rows (ms) */
const WRITE_MS = 0.04;
/** The time a row written takes besides (ms) */
const ROW_MS = 0.002;
/** The time the listeners of a change take for each row it names (ms) */
const TOLD_MS = 0.006;

let clock = 0;
let base: Store;
let draw: Draw;
/** The parts written to the Store: the rows of each and its time, the listeners included */
let parts: Array<{ operationId: number | undefined; rows: number; ms: number }> = [];

/** The rows a change names */
function rowsOf(change: StoreChange): number {
  let rows = 0;
  for (const layer of change.rows?.layers.values() ?? []) {
    rows += layer.created.length + layer.updated.length + layer.deleted.length;
  }
  return rows;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  clock = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
  base = createStore();
  parts = [];
  let depth = 0;
  let started = 0;
  let told = 0;
  const store: Store = {
    ...base,
    writeRows(values: RowValues) {
      clock += WRITE_MS + values.rows.length * ROW_MS;
      return base.writeRows(values);
    },
    transact(fn, source, options) {
      if (depth === 0) {
        started = clock;
        told = 0;
      }
      depth += 1;
      try {
        return base.transact(fn, source, options);
      } finally {
        depth -= 1;
        if (depth === 0) {
          parts.push({ operationId: options?.operationId, rows: told, ms: clock - started });
        }
      }
    },
  };
  const engine = createEngine(
    createMapStub().map as unknown as Parameters<typeof createEngine>[0],
    toEngineOptions({ store }, () => false),
    { deferDefaultMode: true },
  );
  draw = createDrawOnEngine(engine, { store });
  engine.enterDefaultMode();
  // The work of the listeners of each change, for the rows it names
  base.subscribe((change) => {
    const rows = rowsOf(change);
    told += rows;
    clock += rows * TOLD_MS;
  });
});

afterEach(() => {
  draw.destroy();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/** `count` points written to the Store at once in the layer `many`; their IDs */
function manyPoints(count: number): void {
  base.createLayer({
    id: 'many',
    name: 'many',
    visible: true,
    locked: false,
    opacity: 1,
    styleRule: undefined,
    metadata: undefined,
  } as Parameters<Store['createLayer']>[0]);
  const ids: string[] = [];
  const coordinates = new Float64Array(count * 2);
  const starts = new Int32Array(count + 1);
  for (let i = 0; i < count; i++) {
    ids.push(`p${i}`);
    coordinates[i * 2] = 139 + (i % 1000) * 0.0001;
    coordinates[i * 2 + 1] = 35 + Math.floor(i / 1000) * 0.0001;
    starts[i + 1] = i + 1;
  }
  base.createRows({
    ids,
    fields: new Map<FeatureRowField, unknown[]>([
      ['type', ids.map(() => 'Point')],
      ['parent', ids.map(() => 'many')],
      ['orderKey', ids.map((_, i) => `k${String(i).padStart(7, '0')}`)],
      ['visible', ids.map(() => true)],
      ['locked', ids.map(() => false)],
      ['style', ids.map(() => ({}))],
    ]),
    geometry: {
      types: new Uint8Array(count),
      coordinates,
      valuesPerPosition: 2,
      partStarts: starts,
      ringStarts: starts,
      positionStarts: starts,
    },
  });
}

/** Runs an edit on the clock of the tests to its end; its counts */
async function runToEnd(edit: Promise<EditCounts | null>): Promise<EditCounts> {
  let counts: EditCounts | null = null;
  edit.then((value) => {
    counts = value;
  });
  await vi.runAllTimersAsync();
  if (counts === null) throw new Error('the edit did not end');
  return counts;
}

/** The parts of an operation: the rows each wrote and its time */
const partsOf = (operationId: number) => parts.filter((part) => part.operationId === operationId);

/** The parts of a move of every feature and of its writing back */
async function moveAndBack(count: number) {
  manyPoints(count);
  const changes: DocumentChange[] = [];
  draw.document.subscribe((change) => changes.push(change), { previousValues: true });
  parts = [];
  const move = await runToEnd(
    draw.features.translate({ layerIds: ['many'] }, { from: [139, 35], to: [139.01, 35] }),
  );
  const values = changes
    .filter((change) => change.operationId === move.operationId)
    .flatMap((change) => (change.previousValues ? [change.previousValues] : [])) as FeatureValues[];
  const back = await runToEnd(draw.features.restore(values));
  expect(draw.features.get('p0')?.geometry).toEqual({ type: 'Point', coordinates: [139, 35] });
  return { move: partsOf(move.operationId), back: partsOf(back.operationId) };
}

/** The largest part of each edit with each number of features */
const largest = new Map<string, number>();

describe('the parts of a move and of its writing back', () => {
  for (const count of [1_000, 10_000, 100_000]) {
    it(`take no more than twice the budget, the first a batch at most, with ${count} features`, async () => {
      const { move, back } = await moveAndBack(count);
      for (const [name, edit] of [
        ['move', move],
        ['back', back],
      ] as const) {
        expect(edit.reduce((sum, part) => sum + part.rows, 0)).toBe(count);
        expect(edit[0].rows).toBeLessThanOrEqual(BULK_BATCH_MAX);
        const slowest = Math.max(...edit.map((part) => part.ms));
        expect(
          slowest,
          `${name}: ${edit.map((part) => `${part.rows} rows ${part.ms.toFixed(1)} ms`).join(', ')}`,
        ).toBeLessThanOrEqual(BULK_PART_BUDGET_MS * 2);
        largest.set(`${name} ${count}`, Math.max(...edit.map((part) => part.rows)));
      }
    }, 120_000);
  }

  it('write less than twice the rows in the largest part with 100,000 features as with 10,000', () => {
    for (const name of ['move', 'back']) {
      const small = largest.get(`${name} 10000`) as number;
      const large = largest.get(`${name} 100000`) as number;
      expect(large, `${name}: ${small} and ${large}`).toBeLessThan(small * 2);
    }
  });
});
