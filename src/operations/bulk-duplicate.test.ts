// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The copies of any number of features (`features.duplicate`):
 *
 * - They follow the rules of every bulk edit: the parts, an ID that names nothing, read-only; a
 *   locked feature is copied too, with its lock, and a target of locked features is not refused
 * - A copy has a new ID and the values of its original, its name included, and goes just in
 *   front of its original, in its layer and its group
 * - A group the target holds whole is copied as a new group just in front of it, with its values
 *   and the copies in the order of their originals; the copies of some features of a group go
 *   into the group, each just in front of its original
 * - The offset moves the copies as `translate` moves features; the copies are read from
 *   `createdIds`, and nothing is selected
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Draw } from '../api/draw.js';
import type { DrawError } from '../api/errors.js';
import type { EditCounts } from '../api/features.js';
import { createDrawOnEngine } from '../api/impl/create-draw.js';
import { createEngine } from '../api/impl/engine.js';
import { toEngineOptions } from '../api/impl/options.js';
import { createStore } from '../store/built-in/create-store.js';
import type { Store } from '../store/built-in/types.js';
import { createMapStub } from '../test-utils.js';

let clock = 0;
let store: Store;
let draw: Draw;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  clock = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
  store = createStore();
  const engine = createEngine(
    createMapStub().map as unknown as Parameters<typeof createEngine>[0],
    toEngineOptions({ store, initDefaultLayer: false }, () => false),
    { deferDefaultMode: true },
  );
  draw = createDrawOnEngine(engine, { store, initDefaultLayer: false });
  engine.enterDefaultMode();
  draw.layers.create({ id: 'l', name: 'l' });
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

/** A point of the layer `l`, with a name */
function point(id: string, x: number, more: { locked?: boolean } = {}): string {
  draw.features.create({
    id,
    type: 'Point',
    layerId: 'l',
    geometry: { type: 'Point', coordinates: [x, 0] },
    properties: { name: `name ${id}` },
    style: { fillColor: '#ff0000' },
    ...more,
  });
  return id;
}

/** The items of the layer `l`, from the back */
const items = () => draw.layers.listItemIds('l', { start: 0, end: 100 });

/** The features of a group, from the back */
const members = (groupId: string) => draw.groups.listFeatureIds(groupId, { start: 0, end: 100 });

/** The IDs of the copies an edit made */
const copiesOf = (counts: EditCounts | null) => counts?.createdIds?.toArray() ?? [];

describe('features.duplicate', () => {
  it('copies each feature with a new ID and its values, just in front of its original', async () => {
    point('a', 0);
    point('b', 1);
    point('c', 2);
    const counts = await finish(draw.features.duplicate(['a', 'c', 'none']));
    expect(counts).toEqual(
      expect.objectContaining({ changedCount: 2, lockedCount: 0, missingCount: 1 }),
    );
    const [copyOfA, copyOfC] = copiesOf(counts);
    expect(items()).toEqual(['a', copyOfA, 'b', 'c', copyOfC]);
    const original = draw.features.get('a');
    const copy = draw.features.get(copyOfA);
    expect({ ...copy, id: 'a' }).toEqual(original);
    expect(copy?.properties.name).toBe('name a');
  });

  it('does not select the copies', async () => {
    point('a', 0);
    draw.selection.set('feature', ['a']);
    await finish(draw.features.duplicate({ selection: true }));
    expect({ type: draw.selection.get().type, ids: draw.selection.get().ids.toArray() }).toEqual({
      type: 'feature',
      ids: ['a'],
    });
    expect(draw.features.count()).toBe(2);
  });

  it('copies a locked feature with its lock, and refuses only read-only', async () => {
    point('a', 0, { locked: true });
    const counts = await finish(draw.features.duplicate(['a']));
    expect(counts).toEqual(expect.objectContaining({ changedCount: 1, lockedCount: 0 }));
    expect(draw.features.get(copiesOf(counts)[0])?.locked).toBe(true);
    draw.layers.update('l', { locked: true });
    expect(await finish(draw.features.duplicate(['a']))).toEqual(
      expect.objectContaining({ changedCount: 1 }),
    );
    draw.setReadOnly(true);
    expect(await finish(draw.features.duplicate(['a']))).toBeNull();
    expect(draw.features.count()).toBe(3);
  });

  it('makes a new group of the copies of a group the target holds whole, just in front of it', async () => {
    point('a', 0);
    point('b', 1);
    point('c', 2);
    point('d', 3);
    const group = draw.groups.create({ featureIds: ['b', 'c'], name: 'pair' });
    const groupId = group?.id ?? '';
    draw.groups.update(groupId, { locked: true, visible: false });
    // The members in the reverse order of the group in the target
    const counts = await finish(draw.features.duplicate(['c', 'b']));
    expect(counts).toEqual(expect.objectContaining({ changedCount: 2 }));
    const copies = copiesOf(counts);
    const layerItems = items();
    expect(layerItems).toHaveLength(4);
    expect(layerItems.slice(0, 2)).toEqual(['a', groupId]);
    const copyGroup = layerItems[2];
    expect(layerItems[3]).toBe('d');
    expect(draw.groups.get(copyGroup)).toEqual(
      expect.objectContaining({ name: 'pair', locked: true, visible: false, layerId: 'l' }),
    );
    // The copies take the order of their originals: the copy of b, then the copy of c
    const [copyOfC, copyOfB] = copies;
    expect(members(copyGroup)).toEqual([copyOfB, copyOfC]);
    expect(members(groupId)).toEqual(['b', 'c']);
  });

  it('puts the copies of some features of a group into the group, each just in front of its original', async () => {
    point('a', 0);
    point('b', 1);
    point('c', 2);
    const group = draw.groups.create({ featureIds: ['a', 'b', 'c'] });
    const groupId = group?.id ?? '';
    const counts = await finish(draw.features.duplicate(['a', 'c']));
    const [copyOfA, copyOfC] = copiesOf(counts);
    expect(members(groupId)).toEqual(['a', copyOfA, 'b', 'c', copyOfC]);
    expect(items()).toEqual([groupId]);
  });

  it('copies the groups of a layer whole', async () => {
    point('a', 0);
    point('b', 1);
    const group = draw.groups.create({ featureIds: ['a', 'b'] });
    const counts = await finish(draw.features.duplicate({ layerIds: ['l'] }));
    expect(counts).toEqual(expect.objectContaining({ changedCount: 2 }));
    expect(draw.groups.count()).toBe(2);
    expect(items()[0]).toBe(group?.id);
  });

  it('moves the copies by the offset, as translate moves features', async () => {
    point('a', 10);
    const counts = await finish(
      draw.features.duplicate(['a'], { offset: { from: [10, 0], to: [11, 0] } }),
    );
    /** The position of a point */
    const at = (id: string) =>
      (draw.features.get(id)?.geometry as { coordinates: number[] } | undefined)?.coordinates;
    const [x, y] = at(copiesOf(counts)[0]) ?? [];
    expect(x).toBeCloseTo(11, 6);
    expect(y).toBeCloseTo(0, 6);
    expect(at('a')).toEqual([10, 0]);
  });

  it('rejects a target or an offset of the wrong shape, and copies nothing', async () => {
    point('a', 0);
    const wrong = settled(draw.features.duplicate([1] as unknown as string[]));
    const offset = settled(
      draw.features.duplicate(['a'], { offset: { from: [0, 95], to: [1, 0] } }),
    );
    await vi.runAllTimersAsync();
    expect((wrong.error as DrawError).code).toBe('invalidInput');
    expect((offset.error as DrawError).code).toBe('invalidInput');
    expect(draw.features.count()).toBe(1);
  });

  it('writes in parts, with one operation', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 300; i++) ids.push(point(`p${i}`, i * 0.001));
    const original = store.createRows.bind(store);
    store.createRows = (values) => {
      clock += values.ids.length;
      return original(values);
    };
    const operations = new Set<number>();
    let parts = 0;
    draw.document.subscribe((change) => {
      parts += 1;
      if (change.operationId !== undefined) operations.add(change.operationId);
    });
    const counts = await finish(draw.features.duplicate(ids));
    expect(counts?.changedCount).toBe(300);
    expect(parts).toBeGreaterThan(1);
    expect(operations.size).toBe(1);
    expect(draw.features.count()).toBe(600);
  });
});
