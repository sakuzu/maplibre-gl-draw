// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The bulk edits whose target is given as references of rows (`BulkStartOptions.targetRows`):
 * the rows written in parts, deleted rows that are kept among them, the locks read by the
 * references, a reference given twice, a row deleted meanwhile, a write that touches a row first,
 * and the vertices the work left as they are carried by the result
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore } from '../../store/built-in/create-store.js';
import type { DeletedRowsToken, FeatureRowField, Store } from '../../store/built-in/types.js';
import type { InstanceDocument } from '../../store/document-access.js';
import { createMapStub } from '../../test-utils.js';
import type { Draw } from '../draw.js';
import type { EditCounts } from '../features.js';
import { type BulkEditRowWork, type BulkEdits, bulkEditsOf } from './bulk-edits.js';
import { createDrawOnEngine } from './create-draw.js';
import { createEngine } from './engine.js';
import { toEngineOptions } from './options.js';

let clock = 0;
let store: Store;
let draw: Draw;
let edits: BulkEdits;
let layer: InstanceDocument;
/** The tokens of the rows deleted, kept until the test ends */
let tokens: DeletedRowsToken[];

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
  tokens = [];
  // The rows deleted are kept, as the values before a change keep them
  store.subscribe(
    (change) => {
      if (change.deletedRowsToken !== undefined) tokens.push(change.deletedRowsToken);
    },
    { keepDeletedRows: true },
  );
});

afterEach(() => {
  draw.destroy();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/** `count` points written to the Store at once, in a layer of their own; their references */
function manyPoints(count: number, layerId = 'many'): Int32Array {
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
  return Int32Array.from(ids, (id) => store.tables.getRowRef(id) as number);
}

/** Deletes rows through the Store: they are kept by the token of their change */
function deleteRows(refs: Int32Array): void {
  store.writeRows({ rows: refs, fields: new Map(), deleted: new Uint8Array(refs.length).fill(1) });
}

/** Locks rows through the Store */
function lockRows(refs: Int32Array): void {
  store.writeRows({
    rows: refs,
    fields: new Map<FeatureRowField, unknown[]>([['locked', Array.from(refs, () => true)]]),
  });
}

/** A work of rows of the tests: it takes `time` per row on the clock, and keeps each batch */
function rowWork(time = 0, more: Partial<BulkEditRowWork> = {}) {
  const calls: number[][] = [];
  const work: BulkEditRowWork = {
    writeRows(rows, changed) {
      calls.push([...rows]);
      for (let i = 0; i < rows.length; i++) {
        clock += time;
        changed[i] = 1;
      }
    },
    ...more,
  };
  return { work, calls };
}

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

describe('a bulk edit of a target of rows', () => {
  it('writes 1,000 rows, deleted rows kept among them, in parts, each once in its order', async () => {
    const refs = manyPoints(1000);
    deleteRows(refs.subarray(100, 300));
    expect(store.tables.getRowRef('many-150')).toBeUndefined();
    expect(store.tables.getRowId(refs[150])).toBe('many-150');
    const { work, calls } = rowWork(0.5);
    const run = settled(edits.start([], undefined, work, { targetRows: refs }));
    let parts = 0;
    while (!run.done) {
      const before = calls.length;
      await vi.runOnlyPendingTimersAsync();
      if (calls.length > before) parts += 1;
    }
    expect(parts).toBeGreaterThan(1);
    expect(calls.flat()).toEqual([...refs]);
    expect(run.value).toEqual(
      expect.objectContaining({ changedCount: 1000, lockedCount: 0, missingCount: 0 }),
    );
    expect(tokens.length).toBeGreaterThan(0);
  });

  it('copies the references once when it starts', async () => {
    const refs = manyPoints(4);
    const given = refs.slice();
    const { work, calls } = rowWork();
    const run = settled(edits.start([], undefined, work, { targetRows: given }));
    given.fill(refs[0]);
    await vi.runAllTimersAsync();
    expect(calls.flat()).toEqual([...refs]);
    expect((run.value as EditCounts).changedCount).toBe(4);
  });

  it('counts the locked rows, those there and those deleted, and gives them to no work', async () => {
    const refs = manyPoints(6);
    lockRows(Int32Array.of(refs[1], refs[4]));
    // A row deleted while it was locked is read by the lock it was kept with
    deleteRows(Int32Array.of(refs[4], refs[5]));
    const { work, calls } = rowWork();
    const run = settled(edits.start([], undefined, work, { targetRows: refs }));
    await vi.runAllTimersAsync();
    expect(calls.flat()).toEqual([refs[0], refs[2], refs[3], refs[5]]);
    expect(run.value).toEqual(expect.objectContaining({ changedCount: 4, lockedCount: 2 }));
  });

  it('reads a deleted row as locked by the layer it goes back to', async () => {
    const refs = manyPoints(3);
    deleteRows(Int32Array.of(refs[2]));
    store.updateLayer('many', { locked: true });
    expect(layer.isRowLocked(refs[2])).toBe(true);
    expect(layer.isRowLocked(refs[0])).toBe(true);
    store.updateLayer('many', { locked: false });
    expect(layer.isRowLocked(refs[2])).toBe(false);
    expect(layer.isRowLocked(-5)).toBe(false);
  });

  it('is refused with null when every row is locked, and writes them when the locks are ignored', async () => {
    const refs = manyPoints(3);
    lockRows(refs);
    deleteRows(Int32Array.of(refs[0]));
    const { work, calls } = rowWork();
    await expect(edits.start([], undefined, work, { targetRows: refs })).resolves.toBeNull();
    expect(calls).toEqual([]);
    const run = settled(edits.start([], { ignoreLocks: true }, work, { targetRows: refs }));
    await vi.runAllTimersAsync();
    expect(calls.flat()).toEqual([...refs]);
    expect(run.value).toEqual(expect.objectContaining({ changedCount: 3, lockedCount: 0 }));
  });

  it('visits a reference given twice once', async () => {
    const refs = manyPoints(3);
    const { work, calls } = rowWork();
    const target = Int32Array.of(refs[2], refs[0], refs[2], refs[1], refs[0]);
    const run = settled(edits.start([], undefined, work, { targetRows: target }));
    await vi.runAllTimersAsync();
    expect(calls.flat()).toEqual([refs[2], refs[0], refs[1]]);
    expect((run.value as EditCounts).changedCount).toBe(3);
  });

  it('leaves out a row deleted since it started, and one whose reference names nothing', async () => {
    const refs = manyPoints(5);
    const { work, calls } = rowWork();
    const run = settled(
      edits.start([], undefined, work, { targetRows: Int32Array.of(...refs, 99_999) }),
    );
    deleteRows(Int32Array.of(refs[3]));
    await vi.runAllTimersAsync();
    expect(calls.flat()).toEqual([refs[0], refs[1], refs[2], refs[4]]);
    expect(run.value).toEqual(expect.objectContaining({ changedCount: 4, missingCount: 0 }));
  });

  it('is applied first, alone, to a row a write of this client touches', async () => {
    const refs = manyPoints(4);
    const written: number[][] = [];
    const work: BulkEditRowWork = {
      writeRows(rows, changed) {
        written.push([...rows]);
        for (let i = 0; i < rows.length; i++) {
          const id = store.tables.getRowId(rows[i]) as string;
          if (layer.updateFeature(id, { properties: { log: 'B;' } })) changed[i] = 1;
        }
      },
    };
    const run = settled(edits.start([], undefined, work, { targetRows: refs }));
    // Before the first part: the write of the last applies the edit to it first
    draw.features.update('many-3', { properties: { name: 'last' } });
    expect(written).toEqual([[refs[3]]]);
    expect(draw.features.get('many-3')?.properties).toEqual({ log: 'B;', name: 'last' });
    await vi.runAllTimersAsync();
    expect(written.slice(1).flat()).toEqual([refs[0], refs[1], refs[2]]);
    expect((run.value as EditCounts).changedCount).toBe(4);
  });

  it('carries the vertices the work left as they are, and none for a work that does not count them', async () => {
    const refs = manyPoints(2);
    const counting = rowWork(0, { skippedVertexCount: () => 3 });
    const first = settled(edits.start([], undefined, counting.work, { targetRows: refs }));
    await vi.runAllTimersAsync();
    expect((first.value as EditCounts).skippedVertexCount).toBe(3);
    const plain = rowWork();
    const second = settled(edits.start([], undefined, plain.work, { targetRows: refs }));
    await vi.runAllTimersAsync();
    expect(second.value).not.toHaveProperty('skippedVertexCount');
  });

  it('takes a work of rows for a target of rows only', () => {
    const refs = manyPoints(1);
    const { work } = rowWork();
    expect(() => edits.start(['many-0'], undefined, work)).toThrow(/target of rows/);
    expect(() =>
      edits.start([], undefined, { writeFeature: () => true }, { targetRows: refs }),
    ).toThrow(/work that writes rows/);
  });
});
