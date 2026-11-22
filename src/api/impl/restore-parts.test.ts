// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `features.restore` written in parts, on the clock of the tests: a `restore` that stops when
 * read-only is turned on, and the same values given again, which write the rest (a row a write
 * touched first is not written twice); the values of a move of every feature, which hold the
 * arrays of the geometries before and no object per feature; and the parts of the writing back
 * of such a move, which write no more rows for 10,000 features than for 1,000
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore } from '../../store/built-in/create-store.js';
import type { FeatureRowField, RowValues, Store } from '../../store/built-in/types.js';
import {
  countsOf,
  createMapStub,
  expectNotProportional,
  expectPartsWithin,
  runInParts,
  WORK_SCENES,
  WORK_SIZES,
} from '../../test-utils.js';
import type { Draw } from '../draw.js';
import type { DocumentChange } from '../events.js';
import type { EditCounts } from '../features.js';
import type { FeatureValues } from '../model.js';
import { createDrawOnEngine } from './create-draw.js';
import { createEngine } from './engine.js';
import { type SharedValues, sharedValuesOf } from './feature-values.js';
import { toEngineOptions } from './options.js';

let clock = 0;
let base: Store;
let store: Store;
let draw: Draw;

/** The time a row written takes on the clock of the tests (ms) */
const ROW_MS = 0.05;

/** A Store whose writes take `ROW_MS` a row on the clock of the tests (none when not slow) */
function slowStore(slow: boolean): Store {
  base = createStore();
  return {
    ...base,
    writeRows(values: RowValues) {
      if (slow) clock += values.rows.length * ROW_MS;
      return base.writeRows(values);
    },
  };
}

/** Makes the instance over a new Store */
function open(slow = true): void {
  store = slowStore(slow);
  const engine = createEngine(
    createMapStub().map as unknown as Parameters<typeof createEngine>[0],
    toEngineOptions({ store }, () => false),
    { deferDefaultMode: true },
  );
  draw = createDrawOnEngine(engine, { store });
  engine.enterDefaultMode();
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  clock = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
  open();
});

afterEach(() => {
  draw.destroy();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/** `count` points written to the Store at once in the layer `many`, `n` 0 each; their IDs */
function manyPoints(count: number): string[] {
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
      ['properties:n', ids.map(() => 0)],
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

/** The changes of a subscriber that asks for the values before, from now on */
function record(): DocumentChange[] {
  const changes: DocumentChange[] = [];
  draw.document.subscribe((change) => changes.push(change), { previousValues: true });
  return changes;
}

/** The values of the changes of an operation */
const valuesOf = (changes: readonly DocumentChange[], operationId: number): FeatureValues[] =>
  changes
    .filter((change) => change.operationId === operationId)
    .flatMap((change) => (change.previousValues ? [change.previousValues] : []));

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

describe('a restore that stops', () => {
  it('writes the rest when its values are given again, a row written first not twice', async () => {
    const ids = manyPoints(3000);
    const changes = record();
    draw.features.updateMany(ids.map((id) => ({ id, patch: { properties: { n: 1 } } })));
    const values = valuesOf(changes, changes[changes.length - 1].operationId);
    expect(values).toHaveLength(1);
    const first = settled(draw.features.restore(values));
    // A write of this client touches the last feature first: it is written back then
    draw.features.update(ids[2999], { properties: { x: 1 } });
    expect(draw.features.get(ids[2999])?.properties).toEqual({ n: 0, x: 1 });
    await vi.advanceTimersToNextTimerAsync();
    const written = ids.filter((id) => draw.features.get(id)?.properties.n === 0).length;
    expect(written).toBeGreaterThan(1);
    expect(written).toBeLessThan(3000);
    draw.setReadOnly(true);
    await vi.runAllTimersAsync();
    expect(first.value).toEqual(expect.objectContaining({ stopped: true }));
    draw.setReadOnly(false);
    const second = changes.length;
    const rest = settled(draw.features.restore(values));
    await vi.runAllTimersAsync();
    expect((rest.value as EditCounts).changedCount).toBe(3000 - written);
    expect(ids.every((id) => draw.features.get(id)?.properties.n === 0)).toBe(true);
    expect(draw.features.get(ids[2999])?.properties).toEqual({ n: 0, x: 1 });
    // The rows written before are not in the changes of the second
    const again = changes.slice(second).filter((change) => change.source === 'local');
    expect(again.some((change) => change.features.updated.has(ids[2999]))).toBe(false);
    expect(again.some((change) => change.features.updated.has(ids[0]))).toBe(false);
    // Written back whole, the values are used up
    const third = settled(draw.features.restore(values));
    await vi.runAllTimersAsync();
    expect(third.error).toMatchObject({ code: 'invalidInput' });
  });

  it('checks read-only in every part, and stops there', async () => {
    const ids = manyPoints(3000);
    const changes = record();
    draw.features.updateMany(ids.map((id) => ({ id, patch: { properties: { n: 1 } } })));
    const values = valuesOf(changes, changes[changes.length - 1].operationId);
    const run = settled(draw.features.restore(values));
    await vi.advanceTimersToNextTimerAsync();
    draw.setReadOnly(true);
    await vi.runAllTimersAsync();
    const counts = run.value as EditCounts;
    expect(counts.stopped).toBe(true);
    expect(counts.changedCount).toBeLessThan(3000);
  });
});

/** The objects reachable from values held once: maps, arrays and typed arrays, each once */
function objectsOf(value: unknown, seen = new Set<object>()): number {
  if (typeof value !== 'object' || value === null || seen.has(value)) return 0;
  seen.add(value);
  if (ArrayBuffer.isView(value)) return 1;
  let count = 1;
  if (value instanceof Map) {
    for (const [key, item] of value) count += objectsOf(key, seen) + objectsOf(item, seen);
    return count;
  }
  if (Array.isArray(value)) {
    for (const item of value) count += objectsOf(item, seen);
    return count;
  }
  for (const item of Object.values(value)) count += objectsOf(item, seen);
  return count;
}

describe(WORK_SCENES.writeBack, () => {
  describe('the values of a move of every feature', () => {
    /**
     * The values of a move of `size` features: the clock of the tests standing still, a first part
     * of a batch at most and one more with the rest, and then in parts of about 1,000 rows
     */
    const moveOf = async (size: number, slow: boolean): Promise<SharedValues[]> => {
      draw.destroy();
      open(slow);
      manyPoints(size);
      const changes = record();
      const run = settled(
        draw.features.translate({ layerIds: ['many'] }, { from: [139, 35], to: [139.01, 35] }),
      );
      await vi.runAllTimersAsync();
      const operationId = (run.value as EditCounts).operationId;
      return valuesOf(changes, operationId).map((value) => sharedValuesOf(value) as SharedValues);
    };

    /** The objects of the values of the part that holds the most, maps, arrays and typed arrays */
    const objectsOfLargest = (values: readonly SharedValues[]) =>
      Math.max(...values.map((shared) => objectsOf(shared)));

    it('hold the arrays of the geometries before, and no object per feature', async () => {
      const oneSmall = await moveOf(WORK_SIZES.small, false);
      const oneLarge = await moveOf(WORK_SIZES.large, false);
      expect(oneSmall).toHaveLength(1);
      // The first part writes a batch at most: the rest is the second part
      expect(oneLarge).toHaveLength(2);
      for (const shared of [...oneSmall, ...oneLarge]) expect(shared.tracked.size).toBe(0);
      const objects = new Map<number, number>([
        [WORK_SIZES.small, objectsOfLargest(oneSmall)],
        [WORK_SIZES.large, objectsOfLargest(oneLarge)],
      ]);
      expect(objects.get(WORK_SIZES.large)).toBe(objects.get(WORK_SIZES.small));
      expectNotProportional((size) => objects.get(size) as number, 'the objects of the values');
      // In parts, the values of each part have as many objects
      const parts = await moveOf(WORK_SIZES.large, true);
      expect(parts.length).toBeGreaterThan(1);
      const each = parts.map((shared) => objectsOf(shared));
      expect(Math.max(...each)).toBe(objectsOf(oneSmall[oneSmall.length - 1]));
    });
  });

  describe('the writing back of a move of every feature', () => {
    it('writes no more rows in a part for 10,000 features than for 1,000', async () => {
      const largest: number[] = [];
      for (const size of [WORK_SIZES.small, WORK_SIZES.large]) {
        draw.destroy();
        open();
        manyPoints(size);
        const changes = record();
        const move = settled(
          draw.features.translate({ layerIds: ['many'] }, { from: [139, 35], to: [139.01, 35] }),
        );
        await vi.runAllTimersAsync();
        const values = valuesOf(changes, (move.value as EditCounts).operationId);
        const parts = await runInParts({
          counts: countsOf(base),
          run: () => draw.features.restore(values),
        });
        // 0.05 ms a row: about 1,000 rows in a part of 50 ms
        expectPartsWithin(parts, 1_100);
        largest.push(Math.max(...parts.parts));
        expect(draw.features.get('p0')?.geometry).toEqual({
          type: 'Point',
          coordinates: [139, 35],
        });
      }
      expect(largest[1]).toBeLessThanOrEqual(1_100);
    });
  });
});
