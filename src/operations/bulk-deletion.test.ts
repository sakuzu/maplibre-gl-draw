// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The deletions of any number of features, of layers and of what is selected
 * (`features.deleteMany`, `layers.delete`, `layers.deleteMany`, `selection.delete` and the
 * Delete key):
 *
 * - They follow the rules of every bulk edit: the parts and their number, an ID that names
 *   nothing, a feature deleted or locked meanwhile, read-only and destroy
 * - A group whose last feature goes is deleted with it; an embedded file stays
 * - What is deleted leaves the selection, the editing and the items this client hides at the end
 *   of the edit, in one change of the selection
 * - A layer is deleted in the last part, after its features; it takes no other write of this
 *   client from the first part on (the writes that ignore the locks too); it is refused at the
 *   start when it, a group or a feature of it is locked; a feature locked meanwhile stays, and
 *   the layer with it; a feature another client puts in it meanwhile goes with it; its changes
 *   carry the change of the stacking order, and the values before keep the features
 * - The deletion of what is selected leaves what is locked, keeps one layer, clears the
 *   selection once it deleted something, and is what the Delete key does
 * - A part writes no more rows for 10,000 features than for 1,000, and the parts are as many as
 *   the features call for, each in a task of its own
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Draw } from '../api/draw.js';
import type { DrawError } from '../api/errors.js';
import type { DocumentChange } from '../api/events.js';
import type { EditCounts } from '../api/features.js';
import { createDrawOnEngine } from '../api/impl/create-draw.js';
import { createEngine, type Engine } from '../api/impl/engine.js';
import { toEngineOptions } from '../api/impl/options.js';
import { handleDeleteShortcut } from '../modes/select/shortcut-handler.js';
import { createStore } from '../store/built-in/create-store.js';
import type { Store } from '../store/built-in/types.js';
import {
  countsOf,
  createMapStub,
  expectPartsWithin,
  runInParts,
  WORK_SIZES,
} from '../test-utils.js';

let clock = 0;
let store: Store;
let engine: Engine;
let draw: Draw;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  clock = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
  store = createStore();
  engine = createEngine(
    createMapStub().map as unknown as Parameters<typeof createEngine>[0],
    toEngineOptions({ store, initDefaultLayer: false }, () => false),
    { deferDefaultMode: true },
  );
  draw = createDrawOnEngine(engine, { store, initDefaultLayer: false });
  engine.enterDefaultMode();
});

afterEach(() => {
  draw.destroy();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// ----------------------------------------------------------------------------
// Tools
// ----------------------------------------------------------------------------

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

/** Runs every task until none is left */
const allTasks = () => vi.runAllTimersAsync();

/** Runs an edit to its end and returns its counts */
async function finish(promise: Promise<EditCounts | null>): Promise<EditCounts | null> {
  const run = settled(promise);
  await allTasks();
  if (!run.done) throw new Error('the edit did not end');
  if (run.error) throw run.error;
  return run.value as EditCounts | null;
}

/** A layer with points in it; their IDs */
function layerOfPoints(layerId: string, count: number, locked: number[] = []): string[] {
  draw.layers.create({ id: layerId, name: layerId });
  const ids: string[] = [];
  const inputs = [];
  for (let i = 0; i < count; i++) {
    const id = `${layerId}-${i}`;
    ids.push(id);
    inputs.push({
      id,
      type: 'Point' as const,
      layerId,
      locked: locked.includes(i),
      geometry: { type: 'Point' as const, coordinates: [i * 0.001, 0] },
    });
  }
  draw.features.createMany(inputs);
  return ids;
}

/** The changes of the document, from now on */
function changes(): DocumentChange[] {
  const out: DocumentChange[] = [];
  draw.document.subscribe((change) => out.push(change));
  return out;
}

/** Counts as an edit gives them, with the fields given and the others left out */
const counts = (fields: Partial<EditCounts>) => expect.objectContaining(fields);

// ----------------------------------------------------------------------------
// features.deleteMany
// ----------------------------------------------------------------------------

describe('features.deleteMany', () => {
  it('deletes the features, leaves the locked ones and counts the IDs that name nothing', async () => {
    const ids = layerOfPoints('a', 4, [1]);
    expect(await finish(draw.features.deleteMany([...ids, 'none']))).toEqual(
      counts({ changedCount: 3, lockedCount: 1, missingCount: 1, stopped: false }),
    );
    expect(draw.features.list().map((f) => f.id)).toEqual(['a-1']);
  });

  it('is refused when every feature is locked or the document is read-only', async () => {
    const ids = layerOfPoints('a', 2, [0, 1]);
    expect(await finish(draw.features.deleteMany(ids))).toBeNull();
    draw.features.update(ids[0], { locked: false });
    draw.setReadOnly(true);
    expect(await finish(draw.features.deleteMany(ids))).toBeNull();
    expect(draw.features.count()).toBe(2);
  });

  it('rejects a target of the wrong shape and deletes nothing', async () => {
    layerOfPoints('a', 2);
    const run = settled(draw.features.deleteMany([1] as unknown as string[]));
    await allTasks();
    expect((run.error as DrawError).code).toBe('invalidInput');
    expect(draw.features.count()).toBe(2);
  });

  it('deletes a group with its last feature, and keeps an embedded file', async () => {
    const ids = layerOfPoints('a', 3);
    const group = draw.groups.create({ featureIds: [ids[0], ids[1]] });
    store.createFile({ id: 'file', mimeType: 'image/png', dataURL: 'data:image/png;base64,AAAA' });
    expect(await finish(draw.features.deleteMany([ids[0], ids[1]]))).toEqual(
      counts({ changedCount: 2 }),
    );
    expect(draw.groups.has(group?.id ?? '')).toBe(false);
    expect(store.getFile('file')).toBeDefined();
  });

  it('lets go of the features deleted in the selection, the editing and the hidden items at its end, in one change of the selection', async () => {
    const ids = layerOfPoints('a', 3000);
    draw.selection.set('feature', ids);
    draw.editingFeatures.add([ids[0]]);
    draw.hidden.add(ids[1]);
    const selections: number[] = [];
    draw.on('selection.changed', (event) => selections.push(event.selection.ids.length));
    const parts = changes();
    // Each row takes a millisecond: the edit is written in many parts
    const original = store.writeRows.bind(store);
    store.writeRows = (values) => {
      clock += 1;
      return original(values);
    };
    const run = settled(draw.features.deleteMany(ids.slice(0, 2900)));
    await vi.advanceTimersByTimeAsync(0);
    // A part has deleted some features: the selection holds them still
    expect(parts.length).toBeGreaterThan(0);
    expect(draw.selection.get().ids.length).toBe(2999);
    await allTasks();
    expect(run.done).toBe(true);
    expect(parts.length).toBeGreaterThan(2);
    expect(selections).toEqual([100]);
    expect(draw.editingFeatures.get().count()).toBe(0);
    expect(draw.hidden.has(ids[1])).toBe(false);
  });
});

// ----------------------------------------------------------------------------
// layers.delete and layers.deleteMany
// ----------------------------------------------------------------------------

describe('layers.delete', () => {
  it('deletes the features and groups in parts, and the layer in the last part, with the change of the order', async () => {
    draw.layers.create({ id: 'keep', name: 'keep' });
    const ids = layerOfPoints('gone', 600);
    draw.groups.create({ featureIds: [ids[0], ids[1]] });
    const parts = changes();
    const original = store.writeRows.bind(store);
    store.writeRows = (values) => {
      clock += 1;
      return original(values);
    };
    expect(await finish(draw.layers.delete('gone'))).toEqual(
      counts({ changedCount: 600, lockedCount: 0, missingCount: 0, stopped: false }),
    );
    expect(parts.length).toBeGreaterThan(2);
    // The layer goes in the last part only, with the change of the stacking order
    const withLayer = parts.filter((change) => (change.layers?.deleted?.length ?? 0) > 0);
    expect(withLayer).toEqual([parts[parts.length - 1]]);
    expect(parts[parts.length - 1].layers?.orderChanged).toEqual({
      order: ['keep'],
      previous: ['keep', 'gone'],
    });
    expect(parts.slice(0, -1).every((change) => change.hasMoreParts)).toBe(true);
    expect(draw.layers.has('gone')).toBe(false);
  });

  it('carries the change of the order when a layer is created', () => {
    const parts = changes();
    draw.layers.create({ id: 'first', name: 'first' });
    expect(parts[0].layers?.orderChanged).toEqual({ order: ['first'], previous: [] });
  });

  it('is refused at its start when the layer, one of its groups or one of its features is locked', async () => {
    const ids = layerOfPoints('a', 3, [2]);
    expect(await finish(draw.layers.delete('a'))).toBeNull();
    draw.features.update(ids[2], { locked: false });
    const group = draw.groups.create({ featureIds: [ids[0]] });
    draw.groups.update(group?.id ?? '', { locked: true });
    expect(await finish(draw.layers.delete('a'))).toBeNull();
    draw.groups.update(group?.id ?? '', { locked: false });
    draw.layers.update('a', { locked: true });
    expect(await finish(draw.layers.delete('a'))).toBeNull();
    expect(draw.features.count()).toBe(3);
    // Ignoring the locks, it deletes them all
    expect(await finish(draw.layers.delete('a', { ignoreLocks: true }))).toEqual(
      counts({ changedCount: 3 }),
    );
    expect(draw.layers.has('a')).toBe(false);
  });

  it('keeps a feature locked while it writes, and the layer with it', async () => {
    const ids = layerOfPoints('a', 600);
    const original = store.writeRows.bind(store);
    store.writeRows = (values) => {
      clock += 1;
      return original(values);
    };
    const run = settled(draw.layers.delete('a'));
    await vi.advanceTimersByTimeAsync(0);
    // Another client locks the last feature meanwhile
    const ref = store.tables.getRowRef(ids[599]) as number;
    store.transact(() => {
      original({ rows: Int32Array.of(ref), fields: new Map([['locked', [true]]]) });
    }, 'remote');
    await allTasks();
    expect(run.value).toEqual(counts({ changedCount: 599, lockedCount: 1 }));
    expect(draw.layers.has('a')).toBe(true);
    expect(draw.features.list().map((f) => f.id)).toEqual([ids[599]]);
  });

  it('deletes with the layer a feature another client put in it meanwhile', async () => {
    layerOfPoints('a', 600);
    const original = store.writeRows.bind(store);
    store.writeRows = (values) => {
      clock += 1;
      return original(values);
    };
    const run = settled(draw.layers.delete('a'));
    await vi.advanceTimersByTimeAsync(0);
    store.transact(() => {
      store.createRows({
        ids: ['late'],
        fields: new Map<string, unknown[]>([
          ['type', ['Point']],
          ['parent', ['a']],
          ['orderKey', ['zz']],
        ]) as never,
        geometry: {
          types: Uint8Array.of(1),
          coordinates: Float64Array.of(5, 5),
          valuesPerPosition: 2,
          partStarts: Int32Array.of(0, 1),
          ringStarts: Int32Array.of(0, 1),
          positionStarts: Int32Array.of(0, 1),
        } as never,
      });
    }, 'remote');
    expect(draw.features.has('late')).toBe(true);
    await allTasks();
    expect(run.value).toEqual(counts({ changedCount: 601 }));
    expect(draw.layers.has('a')).toBe(false);
    expect(draw.features.has('late')).toBe(false);
  });

  it('refuses the other writes of this client to the layer from its first part on, those that ignore the locks too', async () => {
    draw.layers.create({ id: 'other', name: 'other' });
    const ids = layerOfPoints('a', 600);
    const original = store.writeRows.bind(store);
    store.writeRows = (values) => {
      clock += 1;
      return original(values);
    };
    // Waiting for the edit before it, the layer takes the writes
    const first = settled(draw.features.translate(['other-x'], { from: [0, 0], to: [1, 0] }));
    const run = settled(draw.layers.delete('a'));
    expect(draw.features.update(ids[599], { properties: { n: 1 } })).not.toBeNull();
    // The edit before it ends, and then the deletion writes its first part
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(first.done).toBe(true);
    // From its first part on, the layer refuses them
    expect(draw.features.has(ids[599])).toBe(true);
    expect(draw.features.isEditable(ids[599])).toBe(false);
    expect(draw.features.update(ids[599], { properties: { n: 2 } })).toBeNull();
    expect(draw.features.delete(ids[598])).toBe(false);
    expect(
      draw.features.create({
        type: 'Point',
        layerId: 'a',
        geometry: { type: 'Point', coordinates: [0, 0] },
      }),
    ).toBeNull();
    expect(draw.layers.update('a', { name: 'renamed' })).toBeNull();
    expect(draw.features.move(ids[597], { layerId: 'other' })).toBe(false);
    expect(draw.groups.create({ featureIds: [ids[596]] })).toBeNull();
    draw.transact(
      () => {
        expect(draw.features.update(ids[599], { properties: { n: 3 } })).toBeNull();
      },
      { ignoreLocks: true },
    );
    await allTasks();
    expect(run.value).toEqual(counts({ changedCount: 600 }));
    // The layer is gone, and the other layers take the writes
    expect(draw.layers.has('a')).toBe(false);
    expect(draw.layers.update('other', { name: 'renamed' })).not.toBeNull();
  });

  it('stops when the document turns read-only: the layer stays with the features not deleted yet', async () => {
    layerOfPoints('a', 600);
    const original = store.writeRows.bind(store);
    store.writeRows = (values) => {
      clock += 1;
      return original(values);
    };
    const run = settled(draw.layers.delete('a'));
    await vi.advanceTimersByTimeAsync(0);
    draw.setReadOnly(true);
    await allTasks();
    const result = run.value as EditCounts;
    expect(result.stopped).toBe(true);
    expect(draw.layers.has('a')).toBe(true);
    expect(draw.features.count()).toBe(600 - result.changedCount);
    expect(result.changedCount).toBeGreaterThan(0);
    // The mark is gone: the layer takes writes again once read-only is off
    draw.setReadOnly(false);
    expect(draw.layers.update('a', { name: 'renamed' })).not.toBeNull();
  });

  it('keeps the deleted features in the values before, for a subscriber that asks', async () => {
    const ids = layerOfPoints('a', 3);
    draw.layers.create({ id: 'b', name: 'b' });
    let kept = 0;
    draw.document.subscribe(
      (change) => {
        kept += change.previousValues?.featureCount ?? 0;
      },
      { previousValues: true },
    );
    await finish(draw.layers.delete('a'));
    expect(kept).toBe(ids.length);
  });

  it('counts a layer that is not there', async () => {
    layerOfPoints('a', 1);
    expect(await finish(draw.layers.delete('none'))).toEqual(
      counts({ changedCount: 0, missingCount: 1 }),
    );
  });
});

describe('layers.deleteMany', () => {
  it('deletes several layers as one edit, and refuses them all when one of them is refused', async () => {
    layerOfPoints('a', 2);
    layerOfPoints('b', 2, [0]);
    layerOfPoints('c', 2);
    expect(await finish(draw.layers.deleteMany(['a', 'b']))).toBeNull();
    expect(draw.layers.count()).toBe(3);
    const parts = changes();
    expect(await finish(draw.layers.deleteMany(['a', 'c']))).toEqual(counts({ changedCount: 4 }));
    expect(draw.layers.list().map((l) => l.id)).toEqual(['b']);
    expect(new Set(parts.map((change) => change.operationId)).size).toBe(1);
  });

  it('rejects IDs that are not an array of strings', async () => {
    const run = settled(draw.layers.deleteMany([1] as unknown as string[]));
    await allTasks();
    expect((run.error as DrawError).code).toBe('invalidInput');
  });

  it('can delete the last layer', async () => {
    layerOfPoints('a', 1);
    await finish(draw.layers.deleteMany(['a']));
    expect(draw.layers.count()).toBe(0);
  });
});

// ----------------------------------------------------------------------------
// selection.delete and the Delete key
// ----------------------------------------------------------------------------

describe('selection.delete', () => {
  it('deletes the selected features, leaves the locked ones and then selects nothing', async () => {
    const ids = layerOfPoints('a', 3, [1]);
    draw.selection.set('feature', ids);
    expect(await finish(draw.selection.delete())).toEqual(
      counts({ changedCount: 2, lockedCount: 1 }),
    );
    expect(draw.features.list().map((f) => f.id)).toEqual([ids[1]]);
    expect(draw.selection.get().type).toBeNull();
  });

  it('deletes the selected groups with their features, and an empty one', async () => {
    const ids = layerOfPoints('a', 3, [2]);
    const whole = draw.groups.create({ featureIds: [ids[0], ids[1]] });
    const kept = draw.groups.create({ featureIds: [ids[2]] });
    draw.selection.set('group', [whole?.id ?? '', kept?.id ?? '']);
    expect(await finish(draw.selection.delete())).toEqual(
      counts({ changedCount: 2, lockedCount: 1 }),
    );
    expect(draw.groups.has(whole?.id ?? '')).toBe(false);
    expect(draw.groups.has(kept?.id ?? '')).toBe(true);
  });

  it('deletes the selected layers, leaves out one that holds a lock and counts its features, and keeps one layer', async () => {
    layerOfPoints('a', 2);
    layerOfPoints('b', 3, [0]);
    layerOfPoints('c', 1);
    draw.selection.set('layer', ['a', 'b', 'c']);
    expect(await finish(draw.selection.delete())).toEqual(
      counts({ changedCount: 3, lockedCount: 3 }),
    );
    // b holds a lock: a and c go, and the document keeps b
    expect(draw.layers.list().map((l) => l.id)).toEqual(['b']);
    expect(draw.selection.get().type).toBeNull();
    // Every layer selected: the last of the selection stays
    draw.features.update('b-0', { locked: false });
    layerOfPoints('d', 1);
    draw.selection.set('layer', ['b', 'd']);
    expect(await finish(draw.selection.delete())).toEqual(counts({ changedCount: 3 }));
    expect(draw.layers.list().map((l) => l.id)).toEqual(['d']);
    // The last layer stays: nothing to delete
    draw.selection.set('layer', ['d']);
    expect(await finish(draw.selection.delete())).toBeNull();
    expect(draw.layers.has('d')).toBe(true);
  });

  it('is refused when nothing is selected, read-only, the interaction lock, or everything locked', async () => {
    const ids = layerOfPoints('a', 2, [0, 1]);
    expect(await finish(draw.selection.delete())).toBeNull();
    draw.selection.set('feature', ids);
    expect(await finish(draw.selection.delete())).toBeNull();
    draw.features.update(ids[0], { locked: false });
    draw.setInteractionLocked(true);
    expect(await finish(draw.selection.delete())).toBeNull();
    draw.setInteractionLocked(false);
    draw.setReadOnly(true);
    expect(await finish(draw.selection.delete())).toBeNull();
    expect(draw.features.count()).toBe(2);
  });

  it('looks at the locks in a draw.transact that ignores them', async () => {
    const ids = layerOfPoints('a', 2, [0]);
    draw.selection.set('feature', ids);
    let run: Promise<EditCounts | null> = Promise.resolve(null);
    draw.transact(
      () => {
        run = draw.selection.delete();
      },
      { ignoreLocks: true },
    );
    expect(await finish(run)).toEqual(counts({ changedCount: 1, lockedCount: 1 }));
    expect(draw.features.has(ids[0])).toBe(true);
  });

  it('leaves the selected vertices, which the Delete key deletes first', async () => {
    draw.layers.create({ id: 'a', name: 'a' });
    const line = draw.features.create({
      type: 'LineString',
      geometry: {
        type: 'LineString',
        coordinates: [
          [0, 0],
          [1, 0],
          [2, 0],
        ],
      },
    });
    const id = line?.id ?? '';
    draw.selection.set('feature', [id]);
    draw.vertexSelection.set(id, [{ ring: 0, index: 1 }]);
    handleDeleteShortcut(modeContextOf(engine));
    await allTasks();
    expect(draw.features.get(id)?.geometry).toEqual({
      type: 'LineString',
      coordinates: [
        [0, 0],
        [2, 0],
      ],
    });
    // Then the feature, the same way as the API
    handleDeleteShortcut(modeContextOf(engine));
    await allTasks();
    expect(draw.features.has(id)).toBe(false);
  });

  it('is what the Delete key does', async () => {
    const ids = layerOfPoints('a', 3, [1]);
    draw.selection.set('feature', ids);
    handleDeleteShortcut(modeContextOf(engine));
    await allTasks();
    expect(draw.features.list().map((f) => f.id)).toEqual([ids[1]]);
    expect(draw.selection.get().type).toBeNull();
  });
});

/** The context the engine gives its modes */
function modeContextOf(engine: Engine): Parameters<typeof handleDeleteShortcut>[0] {
  return { store: engine.context.store, bulkEdits: engine.edits } as unknown as Parameters<
    typeof handleDeleteShortcut
  >[0];
}

// ----------------------------------------------------------------------------
// The work
// ----------------------------------------------------------------------------

describe('the work of a deletion of a layer', () => {
  it('writes no more rows in a part for 10,000 features than for 1,000, in parts of their own tasks', async () => {
    const largest: number[] = [];
    const partCounts: number[] = [];
    for (const size of [WORK_SIZES.small, WORK_SIZES.large]) {
      draw.destroy();
      store = createStore();
      engine = createEngine(
        createMapStub().map as unknown as Parameters<typeof createEngine>[0],
        toEngineOptions({ store, initDefaultLayer: false }, () => false),
        { deferDefaultMode: true },
      );
      draw = createDrawOnEngine(engine, { store, initDefaultLayer: false });
      engine.enterDefaultMode();
      draw.layers.create({ id: 'keep', name: 'keep' });
      layerOfPoints('many', size);
      const original = store.writeRows.bind(store);
      store.writeRows = (values) => {
        clock += 0.05;
        return original(values);
      };
      const parts = await runInParts({
        counts: countsOf(store),
        run: () => draw.layers.delete('many'),
      });
      // 0.05 ms a row: about 1,000 rows in a part of 50 ms
      expectPartsWithin(parts, 1_100);
      largest.push(Math.max(...parts.parts));
      partCounts.push(parts.parts.length);
    }
    expect(largest[1]).toBeLessThanOrEqual(1_100);
    // The parts are as many as the features call for
    expect(partCounts[1]).toBeGreaterThan(partCounts[0] * 5);
  });
});
