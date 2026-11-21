// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The write of the same patch to any number of features (`features.updateAll`):
 *
 * - It follows the rules of every bulk edit: the parts, an ID that names nothing, a locked
 *   feature left as it is and counted, read-only
 * - It writes the patch as `update` writes it to one feature: the attributes and the look merged
 *   key by key, a key given `undefined` taken off; a feature for which the patch changes nothing
 *   is not counted; a patch of `locked` and `visible` alone is written to the locked features too
 * - A patch of the wrong shape, a geometry among them that does not fit a type of the target,
 *   rejects the promise and changes nothing
 * - The values it writes are made once per kind of row, as many for 10,000 features as for 1,000
 * - `updateMany` stays as it was: one transaction, each feature its own patch, all or none
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Draw } from '../api/draw.js';
import type { DrawError } from '../api/errors.js';
import type { EditCounts } from '../api/features.js';
import { createDrawOnEngine } from '../api/impl/create-draw.js';
import { createEngine, type Engine } from '../api/impl/engine.js';
import { toEngineOptions } from '../api/impl/options.js';
import { createStore } from '../store/built-in/create-store.js';
import type { Store } from '../store/built-in/types.js';
import { createMapStub, expectNotProportional } from '../test-utils.js';

let clock = 0;
let store: Store;
let engine: Engine;
let draw: Draw;

/** A new instance over a new Store, with the layer `l` */
function instance(): void {
  store = createStore();
  engine = createEngine(
    createMapStub().map as unknown as Parameters<typeof createEngine>[0],
    toEngineOptions({ store, initDefaultLayer: false }, () => false),
    { deferDefaultMode: true },
  );
  draw = createDrawOnEngine(engine, { store, initDefaultLayer: false });
  engine.enterDefaultMode();
  draw.layers.create({ id: 'l', name: 'l' });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  clock = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
  instance();
});

afterEach(() => {
  draw.destroy();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

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

/** Runs an edit to its end and returns its counts */
async function finish(promise: Promise<EditCounts | null>): Promise<EditCounts | null> {
  const run = settled(promise);
  await vi.runAllTimersAsync();
  if (!run.done) throw new Error('the edit did not end');
  if (run.error) throw run.error;
  return run.value as EditCounts | null;
}

/** The code of the error a promise rejects with */
async function rejection(promise: Promise<unknown>): Promise<string | undefined> {
  const run = settled(promise);
  await vi.runAllTimersAsync();
  return (run.error as DrawError | undefined)?.code;
}

/** Points of the layer `l` */
function points(count: number, options: { locked?: number[]; styles?: number } = {}): string[] {
  const ids: string[] = [];
  const inputs = [];
  for (let i = 0; i < count; i++) {
    ids.push(`p${i}`);
    inputs.push({
      id: `p${i}`,
      type: 'Point' as const,
      layerId: 'l',
      locked: options.locked?.includes(i) === true,
      geometry: { type: 'Point' as const, coordinates: [i * 0.001, 0] },
      properties: { n: i, keep: 'yes' },
      style: { fillColor: `#00000${i % (options.styles ?? 1)}` },
    });
  }
  draw.features.createMany(inputs);
  return ids;
}

const counts = (fields: Partial<EditCounts>) => expect.objectContaining(fields);

describe('features.updateAll', () => {
  it('writes the patch to every feature, merging the attributes and the look key by key', async () => {
    const ids = points(3);
    expect(
      await finish(
        draw.features.updateAll([...ids, 'none'], {
          properties: { n: 7, keep: undefined, added: true },
          style: { strokeColor: '#ffffff' },
        }),
      ),
    ).toEqual(counts({ changedCount: 3, missingCount: 1, lockedCount: 0 }));
    for (const id of ids) {
      const feature = draw.features.get(id);
      expect(feature?.properties).toEqual({ n: 7, added: true });
      expect(feature?.style).toEqual({ fillColor: '#000000', strokeColor: '#ffffff' });
    }
  });

  it('does not count a feature the patch changes nothing of', async () => {
    const ids = points(3);
    draw.features.update(ids[1], { properties: { n: 9 } });
    expect(await finish(draw.features.updateAll(ids, { properties: { n: 9 } }))).toEqual(
      counts({ changedCount: 2 }),
    );
    expect(await finish(draw.features.updateAll(ids, { visible: true }))).toEqual(
      counts({ changedCount: 0 }),
    );
    expect(await finish(draw.features.updateAll(ids, { style: { fillColor: '#000000' } }))).toEqual(
      counts({ changedCount: 0 }),
    );
  });

  it('leaves a locked feature and counts it, but writes a patch of the lock and the visibility alone to it', async () => {
    const ids = points(3, { locked: [1] });
    expect(await finish(draw.features.updateAll(ids, { properties: { n: 100 } }))).toEqual(
      counts({ changedCount: 2, lockedCount: 1 }),
    );
    expect(draw.features.get(ids[1])?.properties.n).toBe(1);
    expect(await finish(draw.features.updateAll(ids, { locked: false }))).toEqual(
      counts({ changedCount: 1, lockedCount: 0 }),
    );
    expect(draw.features.get(ids[1])?.locked).toBe(false);
    // Every feature locked: refused, unless the patch is of the lock or the visibility alone
    await finish(draw.features.updateAll(ids, { locked: true }));
    expect(await finish(draw.features.updateAll(ids, { properties: { n: 0 } }))).toBeNull();
    expect(await finish(draw.features.updateAll(ids, { visible: false }))).toEqual(
      counts({ changedCount: 3 }),
    );
  });

  it('is refused while read-only', async () => {
    const ids = points(2);
    draw.setReadOnly(true);
    expect(await finish(draw.features.updateAll(ids, { visible: false }))).toBeNull();
    expect(draw.features.get(ids[0])?.visible).toBe(true);
  });

  it('rejects a patch of the wrong shape, or a geometry that does not fit a feature of the target, and changes nothing', async () => {
    const ids = points(2);
    draw.features.create({
      id: 'line',
      type: 'LineString',
      layerId: 'l',
      geometry: {
        type: 'LineString',
        coordinates: [
          [0, 0],
          [1, 1],
        ],
      },
    });
    expect(await rejection(draw.features.updateAll(ids, { nope: 1 } as never))).toBe(
      'invalidInput',
    );
    expect(await rejection(draw.features.updateAll(ids, { visible: 1 } as never))).toBe(
      'invalidInput',
    );
    expect(await rejection(draw.features.updateAll([1] as never, { visible: false }))).toBe(
      'invalidInput',
    );
    const geometry = { type: 'Point' as const, coordinates: [5, 5] };
    expect(await rejection(draw.features.updateAll([...ids, 'line'], { geometry }))).toBe(
      'invalidInput',
    );
    expect(draw.features.get(ids[0])?.geometry).toEqual({ type: 'Point', coordinates: [0, 0] });
    expect(await finish(draw.features.updateAll(ids, { geometry }))).toEqual(
      counts({ changedCount: 2 }),
    );
    expect(draw.features.get(ids[1])?.geometry).toEqual(geometry);
  });

  it('writes in parts, with one operation', async () => {
    const ids = points(300);
    const original = store.writeRows.bind(store);
    store.writeRows = (values) => {
      clock += 1;
      return original(values);
    };
    const operations = new Set<number>();
    let parts = 0;
    draw.document.subscribe((change) => {
      parts += 1;
      if (change.operationId !== undefined) operations.add(change.operationId);
    });
    expect(await finish(draw.features.updateAll(ids, { properties: { n: -1 } }))).toEqual(
      counts({ changedCount: 300 }),
    );
    expect(parts).toBeGreaterThan(1);
    expect(operations.size).toBe(1);
  });

  it('makes the values it writes as many times for 10,000 features as for 1,000 (once per kind of row)', async () => {
    const made: number[] = [];
    for (const size of [1_000, 10_000]) {
      draw.destroy();
      instance();
      const ids = points(size, { styles: 3 });
      const layer = engine.context.store;
      const styles = new Set<unknown>();
      const write = layer.updateFeature.bind(layer);
      layer.updateFeature = (id, updates, options) => {
        styles.add(updates.style);
        return write(id, updates, options);
      };
      await finish(draw.features.updateAll(ids, { style: { strokeColor: '#ffffff' } }));
      made.push(styles.size);
    }
    expectNotProportional((size) => made[size === 1_000 ? 0 : 1], 'the values made');
    expect(made).toEqual([3, 3]);
  });
});

describe('features.updateMany', () => {
  it('stays one transaction of a patch per feature, all or none', () => {
    const ids = points(3, { locked: [2] });
    let notifications = 0;
    draw.document.subscribe(() => {
      notifications += 1;
    });
    expect(
      draw.features.updateMany([
        { id: ids[0], patch: { properties: { n: 10 } } },
        { id: ids[2], patch: { properties: { n: 12 } } },
      ]),
    ).toBeNull();
    expect(draw.features.get(ids[0])?.properties.n).toBe(0);
    const written = draw.features.updateMany([
      { id: ids[0], patch: { properties: { n: 10 } } },
      { id: ids[1], patch: { properties: { n: 11 } } },
    ]);
    expect(written?.map((feature) => feature.properties.n)).toEqual([10, 11]);
    expect(notifications).toBe(1);
  });
});
