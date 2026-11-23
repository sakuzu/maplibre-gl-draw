// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `features.restore` with `exceptProperties`, written in parts on the clock of the tests: no part
 * writes the key it names, a `restore` that stopped goes on with the keys its next call names,
 * and the writing back gives the Store, and carries in its changes, no object per feature
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore } from '../../store/built-in/create-store.js';
import type { FeatureRowField, RowValues, Store } from '../../store/built-in/types.js';
import {
  countsOf,
  createMapStub,
  expectNotProportional,
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
import { sharedValuesOf } from './feature-values.js';
import { toEngineOptions } from './options.js';

let clock = 0;
let base: Store;
let store: Store;
let draw: Draw;
/** The fields of each write of rows made to the Store, and its objects, while `watching` */
let writes: Array<{ fields: FeatureRowField[]; objects: number }> = [];
let watching = false;

/** The time a row written takes on the clock of the tests (ms) */
const ROW_MS = 0.05;

/** A Store whose writes take `ROW_MS` a row on the clock of the tests (none when not slow) */
function slowStore(slow: boolean): Store {
  base = createStore();
  return {
    ...base,
    writeRows(values: RowValues) {
      if (slow) clock += values.rows.length * ROW_MS;
      if (watching) writes.push({ fields: [...values.fields.keys()], objects: objectsOf(values) });
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
  writes = [];
  watching = false;
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
      ['properties:m', ids.map(() => 0)],
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

/** Writes `n` 1 and a new position to every feature of `many` as one bulk edit; its values */
async function changeEvery(): Promise<FeatureValues[]> {
  const changes = record();
  const run = settled(
    draw.features.updateAll(
      { layerIds: ['many'] },
      { geometry: { type: 'Point', coordinates: [140, 36] }, properties: { n: 1 } },
    ),
  );
  await vi.runAllTimersAsync();
  return valuesOf(changes, (run.value as EditCounts).operationId);
}

describe('the keys left as they are, in parts', () => {
  it('writes back 10,000 features in parts, no part writing the key it names', async () => {
    const ids = manyPoints(WORK_SIZES.large);
    const values = await changeEvery();
    expect(draw.features.get('p0')?.properties.n).toBe(1);
    watching = true;
    const run = await runInParts({
      counts: countsOf(base),
      run: () => draw.features.restore(values, { exceptProperties: ['n'] }),
    });
    watching = false;
    expect(run.parts.filter((rows) => rows > 0).length).toBeGreaterThan(1);
    expect(writes.length).toBeGreaterThan(1);
    for (const { fields } of writes) expect(fields).not.toContain('properties:n');
    expect(draw.features.get('p0')?.geometry).toEqual({ type: 'Point', coordinates: [139, 35] });
    expect(ids.every((id) => draw.features.get(id)?.properties.n === 1)).toBe(true);
    /** The longitude of a point, or NaN when it is not there */
    const longitude = (id: string): number => {
      const geometry = draw.features.get(id)?.geometry;
      return geometry?.type === 'Point' ? geometry.coordinates[0] : Number.NaN;
    };
    expect(ids.every((id) => longitude(id) < 140)).toBe(true);
  });

  it('goes on after it stopped with the keys the next call names', async () => {
    const ids = manyPoints(3000);
    const changes = record();
    draw.features.updateMany(ids.map((id) => ({ id, patch: { properties: { n: 1, m: 1 } } })));
    const values = valuesOf(changes, changes[changes.length - 1].operationId);
    const first = settled(draw.features.restore(values, { exceptProperties: ['n'] }));
    await vi.advanceTimersToNextTimerAsync();
    draw.setReadOnly(true);
    await vi.runAllTimersAsync();
    expect(first.value).toEqual(expect.objectContaining({ stopped: true }));
    const written = ids.filter((id) => draw.features.get(id)?.properties.m === 0);
    expect(written.length).toBeGreaterThan(1);
    expect(written.length).toBeLessThan(3000);
    draw.setReadOnly(false);
    // The keys are not kept with the values: the rest is written whole when none is named
    const rest = settled(draw.features.restore(values));
    await vi.runAllTimersAsync();
    expect((rest.value as EditCounts).changedCount).toBe(3000 - written.length);
    const writtenSet = new Set(written);
    for (const id of ids) {
      expect(draw.features.get(id)?.properties).toEqual(
        writtenSet.has(id) ? { n: 1, m: 0 } : { n: 0, m: 0 },
      );
    }
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
  describe('the writing back of a move and a key, the key left as it is', () => {
    /**
     * Moves every feature of `size` and writes `n` to them, then writes both back with `n` left
     * as it is: the objects of the writes it gives the Store, and those of the values its changes
     * carry (the write and the part that hold the most)
     */
    const restoreOf = async (size: number): Promise<{ written: number; carried: number }> => {
      draw.destroy();
      open(false);
      manyPoints(size);
      const changes = record();
      const move = settled(
        draw.features.translate({ layerIds: ['many'] }, { from: [139, 35], to: [139.01, 35] }),
      );
      await vi.runAllTimersAsync();
      const update = settled(
        draw.features.updateAll({ layerIds: ['many'] }, { properties: { n: 1 } }),
      );
      await vi.runAllTimersAsync();
      const values = [
        ...valuesOf(changes, (move.value as EditCounts).operationId),
        ...valuesOf(changes, (update.value as EditCounts).operationId),
      ];
      writes = [];
      watching = true;
      const back = settled(draw.features.restore(values, { exceptProperties: ['n'] }));
      await vi.runAllTimersAsync();
      watching = false;
      for (const { fields } of writes) expect(fields).not.toContain('properties:n');
      expect(draw.features.get('p0')?.properties.n).toBe(1);
      expect(draw.features.get('p0')?.geometry).toEqual({ type: 'Point', coordinates: [139, 35] });
      const carried = valuesOf(changes, (back.value as EditCounts).operationId).map((value) =>
        objectsOf(sharedValuesOf(value)),
      );
      return {
        written: Math.max(...writes.map(({ objects }) => objects)),
        carried: Math.max(...carried),
      };
    };

    it('gives the Store and carries as many objects for 10,000 features as for 1,000', async () => {
      const scenes = new Map<number, { written: number; carried: number }>([
        [WORK_SIZES.small, await restoreOf(WORK_SIZES.small)],
        [WORK_SIZES.large, await restoreOf(WORK_SIZES.large)],
      ]);
      const written = expectNotProportional(
        (size) => scenes.get(size)?.written as number,
        'the objects of a write given to the Store',
      );
      expect(written.large).toBe(written.small);
      const carried = expectNotProportional(
        (size) => scenes.get(size)?.carried as number,
        'the objects of the values its changes carry',
      );
      expect(carried.large).toBe(carried.small);
    });
  });
});
