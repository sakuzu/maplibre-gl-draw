// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The bulk edits whose work writes several features at a time: the batches it is given (their
 * size, the first small, none over the most), the parts cut by the clock of the tests after each
 * batch, the number of the operation and the size of the target given to the function that
 * makes the work, a feature deleted while its batch is written, and a write of a few features
 * that touches a feature first
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore } from '../../store/built-in/create-store.js';
import type { FeatureRowField, Store } from '../../store/built-in/types.js';
import type { InstanceDocument } from '../../store/document-access.js';
import { createMapStub } from '../../test-utils.js';
import type { Draw } from '../draw.js';
import { DrawError } from '../errors.js';
import type { EditCounts } from '../features.js';
import {
  BULK_BATCH_MAX,
  BULK_FIRST_BATCH,
  BULK_PART_BUDGET_MS,
  type BulkEditBatchWork,
  type BulkEditStart,
  type BulkEdits,
  bulkEditsOf,
} from './bulk-edits.js';
import { createDrawOnEngine } from './create-draw.js';
import { createEngine } from './engine.js';
import { toEngineOptions } from './options.js';

let clock = 0;
let store: Store;
let draw: Draw;
let edits: BulkEdits;
let layer: InstanceDocument;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  clock = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
  store = createStore();
  const engine = createEngine(
    createMapStub().map as unknown as Parameters<typeof createEngine>[0],
    toEngineOptions({ store }, () => false),
    { deferDefaultMode: true },
  );
  draw = createDrawOnEngine(engine, { store });
  engine.enterDefaultMode();
  layer = engine.context.store;
  edits = bulkEditsOf(draw) as BulkEdits;
});

afterEach(() => {
  draw.destroy();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/** `count` points written to the Store at once, in a layer of their own; their IDs */
function manyPoints(count: number, layerId = 'many'): string[] {
  store.createLayer({
    id: layerId,
    name: layerId,
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
    ids.push(`${layerId}-${i}`);
    coordinates[i * 2] = (i % 1000) * 0.001;
    coordinates[i * 2 + 1] = Math.floor(i / 1000) * 0.001;
    starts[i + 1] = i + 1;
  }
  store.createRows({
    ids,
    fields: new Map<FeatureRowField, unknown[]>([
      ['type', ids.map(() => 'Point')],
      ['parent', ids.map(() => layerId)],
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
  return ids;
}

/** Creates points through the instance and returns their IDs */
function points(count: number): string[] {
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const feature = draw.features.create({
      type: 'Point',
      geometry: { type: 'Point', coordinates: [i * 0.01, 0] },
    });
    if (!feature) throw new Error('not created');
    ids.push(feature.id);
  }
  return ids;
}

/** The log of a feature */
const logOf = (id: string): string =>
  (draw.features.get(id)?.properties.log as string | undefined) ?? '';

/** Runs every task until none is left */
const allTasks = () => vi.runAllTimersAsync();

/** Records what a promise settles with */
function settled<T>(promise: Promise<T>): { value?: T; error?: unknown; done: boolean } {
  const out: { value?: T; error?: unknown; done: boolean } = { done: false };
  promise.then(
    (value) => {
      out.value = value;
      out.done = true;
    },
    (error: unknown) => {
      out.error = error;
      out.done = true;
    },
  );
  return out;
}

/**
 * A work of the tests that writes several features at a time: it takes `time` per feature on the
 * clock of the tests, tags them when `write` is true, and keeps the IDs of each batch
 */
function batches(time: number, write = false) {
  const calls: string[][] = [];
  const work: BulkEditBatchWork = {
    writeFeatures(ids, changed) {
      calls.push([...ids]);
      for (let i = 0; i < ids.length; i++) {
        clock += time;
        if (!write) {
          changed[i] = 1;
          continue;
        }
        const feature = draw.features.get(ids[i]);
        if (!feature) continue;
        const log = (feature.properties.log as string | undefined) ?? '';
        if (draw.features.update(ids[i], { properties: { log: `${log}B;` } })) changed[i] = 1;
      }
    },
  };
  return { work, calls };
}

describe('a bulk edit that writes several features at a time', () => {
  it('is given batches that start small and are never over the most, in parts within twice the budget', async () => {
    const ids = manyPoints(100_000);
    const { work, calls } = batches(0.002);
    const run = settled(edits.start(ids, undefined, work));
    // The time of each part, read on the clock of the tests between the tasks
    const parts: number[] = [];
    while (!run.done) {
      const before = clock;
      await vi.runOnlyPendingTimersAsync();
      if (clock > before) parts.push(clock - before);
    }
    const counts = run.value as EditCounts;
    expect(counts.changedCount).toBe(100_000);
    expect(calls[0]).toHaveLength(BULK_FIRST_BATCH);
    expect(Math.max(...calls.map((call) => call.length))).toBeLessThanOrEqual(BULK_BATCH_MAX);
    // Every feature once, in the order of the target
    expect(calls.flat()).toEqual(ids);
    expect(parts.length).toBeGreaterThan(1);
    expect(Math.max(...parts)).toBeLessThanOrEqual(BULK_PART_BUDGET_MS * 2);
  });

  it('keeps every part within twice the budget when the features take different times', async () => {
    const ids = manyPoints(20_000);
    const calls: number[] = [];
    // A feature takes 0.001 ms, but one in seven takes 0.02 ms
    const work: BulkEditBatchWork = {
      writeFeatures(batch, changed) {
        calls.push(batch.length);
        for (let i = 0; i < batch.length; i++) {
          clock += Number(batch[i].slice(5)) % 7 === 0 ? 0.02 : 0.001;
          changed[i] = 1;
        }
      },
    };
    const run = settled(edits.start(ids, undefined, work));
    const parts: number[] = [];
    while (!run.done) {
      const before = clock;
      await vi.runOnlyPendingTimersAsync();
      if (clock > before) parts.push(clock - before);
    }
    expect((run.value as EditCounts).changedCount).toBe(20_000);
    expect(Math.max(...calls)).toBeLessThanOrEqual(BULK_BATCH_MAX);
    expect(Math.max(...parts)).toBeLessThanOrEqual(BULK_PART_BUDGET_MS * 2);
  });

  it('leaves out of a batch the features locked and those deleted since the edit started', async () => {
    const ids = points(8);
    draw.features.update(ids[2], { locked: true });
    const { work, calls } = batches(1, true);
    const run = settled(edits.start(ids, undefined, work));
    // Deleted from elsewhere before the edit reaches it
    const ref = store.tables.getRowRef(ids[5]) as number;
    store.writeRows({ rows: Int32Array.of(ref), fields: new Map(), deleted: Uint8Array.of(1) });
    await allTasks();
    expect(calls.flat()).toEqual([ids[0], ids[1], ids[3], ids[4], ids[6], ids[7]]);
    expect(run.value).toEqual(
      expect.objectContaining({ changedCount: 6, lockedCount: 1, missingCount: 0 }),
    );
  });

  it('writes the others of a batch when one of them is deleted while the batch is written', async () => {
    const ids = points(6);
    const work: BulkEditBatchWork = {
      writeFeatures(batch, changed) {
        for (let i = 0; i < batch.length; i++) {
          // Writing the first deletes the fourth, as a work that writes its features one after
          // another may meet
          if (batch[i] === ids[0]) layer.deleteFeature(ids[3]);
          const feature = draw.features.get(batch[i]);
          if (!feature) continue;
          if (layer.updateFeature(batch[i], { properties: { log: 'B;' } })) changed[i] = 1;
        }
      },
    };
    const run = settled(edits.start(ids, undefined, work));
    await allTasks();
    expect(draw.features.has(ids[3])).toBe(false);
    expect([0, 1, 2, 4, 5].map((i) => logOf(ids[i]))).toEqual(['B;', 'B;', 'B;', 'B;', 'B;']);
    expect(run.value).toEqual(expect.objectContaining({ changedCount: 5, missingCount: 0 }));
  });

  it('gives a feature a write touches first a batch of its own', async () => {
    const ids = points(4);
    const { work, calls } = batches(0, true);
    const run = settled(edits.start(ids, undefined, work));
    // Before the first part: the write of the last applies the edit to it first
    draw.features.update(ids[3], { properties: { name: 'last' } });
    expect(calls).toEqual([[ids[3]]]);
    expect(logOf(ids[3])).toBe('B;');
    await allTasks();
    expect(calls.slice(1).flat()).toEqual([ids[0], ids[1], ids[2]]);
    expect(ids.map(logOf)).toEqual(['B;', 'B;', 'B;', 'B;']);
    expect((run.value as EditCounts).changedCount).toBe(4);
  });
});

describe('the function that makes the work of an edit', () => {
  it('is given the number of the operation and the features of the target, the one of a single feature', async () => {
    const ids = points(3);
    const started: BulkEditStart[] = [];
    const make = (start: BulkEditStart) => {
      started.push(start);
      return batches(0).work;
    };
    const many = settled(edits.start([...ids, ids[0], 'none'], undefined, make));
    await allTasks();
    const one = settled(edits.start([ids[1], ids[1], 'none'], undefined, make));
    await allTasks();
    expect(started).toEqual([
      { operationId: (many.value as EditCounts).operationId, featureCount: 3, onlyId: undefined },
      { operationId: (one.value as EditCounts).operationId, featureCount: 1, onlyId: ids[1] },
    ]);
  });

  it('is given the number of the transaction of draw.transact the edit is started in', async () => {
    const ids = points(2);
    let given: BulkEditStart | null = null;
    let run: { value?: EditCounts | null; done: boolean } = { done: false };
    draw.transact(() => {
      run = settled(
        edits.start(ids, undefined, (start) => {
          given = start;
          return batches(0).work;
        }),
      );
    });
    await allTasks();
    expect(given).toEqual(
      expect.objectContaining({ operationId: (run.value as EditCounts).operationId }),
    );
  });

  it('is not called when the edit is refused at once, and what it throws starts nothing', async () => {
    const ids = points(2);
    const make = vi.fn(() => batches(0).work);
    draw.setReadOnly(true);
    expect(await edits.start(ids, undefined, make)).toBeNull();
    draw.setReadOnly(false);
    expect(make).not.toHaveBeenCalled();
    expect(() =>
      edits.start(ids, undefined, () => {
        throw new DrawError('invalidInput', 'refused');
      }),
    ).toThrow(DrawError);
    // Nothing waits: the next edit is written at once
    const next = settled(edits.start(ids, undefined, batches(0, true).work));
    await allTasks();
    expect((next.value as EditCounts).changedCount).toBe(2);
    expect(ids.map(logOf)).toEqual(['B;', 'B;']);
  });
});
