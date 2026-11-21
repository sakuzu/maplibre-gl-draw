// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The changes of the document in the words of the features: `document.changed` carries the IDs
 * of what changed as sets that keep the IDs they were given, the operation of the change, and the
 * moves; the events of the features, the selection and the groups come with it in order; and
 * `draw.document.subscribe` gives the values before to the subscribers that ask for them, each
 * its own
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createStore } from '../../store/built-in/create-store.js';
import type { FeatureRowField, Store } from '../../store/built-in/types.js';
import { createMapStub, createSyntheticDrag } from '../../test-utils.js';
import type { Draw } from '../draw.js';
import { createDraw } from '../draw.js';
import { DrawError } from '../errors.js';
import type { DocumentChange, DrawEvents } from '../events.js';
import type { Feature, FeatureValues } from '../model.js';
import { createDrawOnEngine } from './create-draw.js';
import { createEngine } from './engine.js';
import { sharedValuesOf } from './feature-values.js';

const point = (lng = 0, lat = 0) => ({
  type: 'Point' as const,
  geometry: { type: 'Point' as const, coordinates: [lng, lat] },
});

let store: Store;
let draw: Draw;

beforeEach(() => {
  store = createStore();
  draw = createDraw(createMapStub().map, { store });
});

afterEach(() => {
  draw.destroy();
});

/** The changes `document.changed` delivers from now on */
function changesOf(target: Draw = draw): DocumentChange[] {
  const out: DocumentChange[] = [];
  target.on('document.changed', (change) => out.push(change));
  return out;
}

/** The IDs of a set, in its order */
const idsOf = (set: { iterate(): IterableIterator<string> }) => [...set.iterate()];

describe('the sets of IDs of a change', () => {
  it('one write gives one change whose four sets name what it did', () => {
    const a = draw.features.create(point()) as Feature;
    const b = draw.features.create(point(1, 1)) as Feature;
    const changes = changesOf();
    let c: Feature | null = null;
    draw.transact(() => {
      c = draw.features.create(point(2, 2));
      draw.features.update(a.id, { properties: { name: 'A' } });
      draw.features.delete(b.id);
    });
    expect(changes).toHaveLength(1);
    const [change] = changes;
    expect(idsOf(change.features.created)).toEqual([(c as unknown as Feature).id]);
    expect(idsOf(change.features.updated)).toEqual([a.id]);
    expect(idsOf(change.features.deleted)).toEqual([b.id]);
    expect(change.features.moved.count()).toBe(0);
    expect(change.features.deleted.has(b.id)).toBe(true);
    expect(change.features.updated.has(b.id)).toBe(false);
    expect(change.operationId).toEqual(expect.any(Number));
    expect(change.hasMoreParts).toBe(false);
    expect(change.stopped).toBe(false);
    expect(change.reset).toBe(false);
  });

  it('keeps the IDs it was given after later writes, and those of deleted features', () => {
    const a = draw.features.create(point()) as Feature;
    const changes = changesOf();
    const b = draw.features.create(point(1, 1)) as Feature;
    const [created] = changes.map((change) => change.features.created);
    draw.features.delete(b.id);
    draw.features.delete(a.id);
    // Rows deleted and let go of: their references are given to the rows made after them
    draw.features.createMany(Array.from({ length: 200 }, (_, i) => point(i / 100, 0)));
    expect(idsOf(created)).toEqual([b.id]);
    expect(created.has(b.id)).toBe(true);
    expect(created.count()).toBe(1);
    expect(created.toArray()).toEqual([b.id]);
    const deleted = changes[1].features.deleted;
    expect(idsOf(deleted)).toEqual([b.id]);
    // Until the whole document is replaced
    draw.features.deleteMany(draw.features.list().map((feature) => feature.id));
    expect(idsOf(created)).toEqual([b.id]);
    expect(idsOf(deleted)).toEqual([b.id]);
  });

  it('a feature created and deleted in one change is in none of the sets', () => {
    const changes = changesOf();
    draw.transact(() => {
      const a = draw.features.create(point()) as Feature;
      draw.features.update(a.id, { properties: { n: 1 } });
      draw.features.delete(a.id);
      draw.metadata.update({ title: 'T' });
    });
    const { created, updated, deleted, moved } = changes[0].features;
    expect([created.count(), updated.count(), deleted.count(), moved.count()]).toEqual([
      0, 0, 0, 0,
    ]);
  });

  it('a change written to the Store directly gives a change of the same shape', () => {
    const a = draw.features.create(point()) as Feature;
    const changes = changesOf();
    store.transact(() => {
      store.writeRows({
        rows: Int32Array.of(store.tables.getRowRef(a.id) as number),
        fields: new Map<FeatureRowField, unknown[]>([['properties:name', ['remote']]]),
      });
    }, 'remote');
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      source: 'remote',
      operationId: expect.any(Number),
      hasMoreParts: false,
      stopped: false,
      reset: false,
    });
    expect(idsOf(changes[0].features.updated)).toEqual([a.id]);
    expect(changes[0].features.created.count()).toBe(0);
    expect(changes[0]).not.toHaveProperty('selection');
    expect(changes[0]).not.toHaveProperty('layerReorder');
    expect(changes[0]).not.toHaveProperty('previousValues');
  });

  it('carries the keys the metadata wrote, and the order when a layer is created or deleted', async () => {
    const changes = changesOf();
    draw.metadata.update({ title: 'Map' });
    const first = draw.layers.list()[0].id;
    const layer = draw.layers.create({ name: 'Second' });
    await draw.layers.delete(layer?.id as string);
    expect(changes[0].metadata?.keys).toEqual(['title']);
    expect(changes[1].layers?.orderChanged).toEqual({
      order: [first, layer?.id],
      previous: [first],
    });
    expect(changes[2].layers?.orderChanged).toEqual({
      order: [first],
      previous: [first, layer?.id],
    });
  });
});

describe('the events that come with a change', () => {
  it('selection.changed arrives before the change it came with, with its operation', () => {
    const a = draw.features.create(point()) as Feature;
    draw.selection.set('feature', [a.id]);
    const order: string[] = [];
    let selection: DrawEvents['selection.changed'] | null = null;
    let change: DocumentChange | null = null;
    draw.on('selection.changed', (payload) => {
      order.push('selection.changed');
      selection = payload;
    });
    draw.on('document.changed', (payload) => {
      order.push('document.changed');
      change = payload;
    });
    draw.features.delete(a.id);
    expect(order).toEqual(['selection.changed', 'document.changed']);
    expect((selection as unknown as DrawEvents['selection.changed']).operationId).toBe(
      (change as unknown as DocumentChange).operationId,
    );
    // The selection alone
    const b = draw.features.create(point()) as Feature;
    draw.selection.set('feature', [b.id]);
    expect((selection as unknown as DrawEvents['selection.changed']).operationId).toBeNull();
  });

  it('a reorder within a layer gives feature.moved, and no layer.updated', () => {
    const layerId = draw.layers.list()[0].id;
    const a = draw.features.create(point()) as Feature;
    const b = draw.features.create(point(1, 1)) as Feature;
    const moved: DrawEvents['feature.moved'][] = [];
    const updated: DrawEvents['layer.updated'][] = [];
    draw.on('feature.moved', (payload) => moved.push(payload));
    draw.on('layer.updated', (payload) => updated.push(payload));
    const changes = changesOf();
    draw.features.move(b.id, { layerId, index: 0 });
    expect(updated).toEqual([]);
    expect(moved).toEqual([
      {
        feature: expect.objectContaining({ id: b.id }),
        from: { layerId, index: 1 },
        to: { layerId, index: 0 },
        source: 'local',
        hasMoreParts: false,
      },
    ]);
    expect(idsOf(changes[0].features.moved)).toEqual([b.id]);
    expect(changes[0].features.updated.count()).toBe(0);
    expect(changes[0].layers).toBeUndefined();
    void a;
  });

  it('group.moved carries where the group was and where it is now', () => {
    const layerId = draw.layers.list()[0].id;
    const a = draw.features.create(point()) as Feature;
    draw.features.create(point(1, 1));
    const group = draw.groups.create({ featureIds: [a.id] });
    draw.features.create(point(2, 2));
    const items = () => draw.layers.listItemIds(layerId, { start: 0, end: 100 });
    const from = items().indexOf(group?.id as string);
    const moves: DrawEvents['group.moved'][] = [];
    const updated: DrawEvents['layer.updated'][] = [];
    draw.on('group.moved', (payload) => moves.push(payload));
    draw.on('layer.updated', (payload) => updated.push(payload));
    const changes = changesOf();
    // To the front
    draw.groups.move(group?.id as string, { layerId });
    const to = items().indexOf(group?.id as string);
    expect(to).not.toBe(from);
    expect(moves).toEqual([
      {
        group: expect.objectContaining({ id: group?.id }),
        from: { layerId, index: from },
        to: { layerId, index: to },
        source: 'local',
      },
    ]);
    expect(updated).toEqual([]);
    expect(changes[0].groups?.moved).toEqual([
      {
        id: group?.id,
        group: expect.objectContaining({ id: group?.id }),
        from: { layerId, index: from },
        to: { layerId, index: to },
      },
    ]);
  });

  it('a listener of document.changed can write', () => {
    const a = draw.features.create(point()) as Feature;
    const seen: DocumentChange[] = [];
    let wrote = false;
    draw.on('document.changed', (change) => {
      seen.push(change);
      if (wrote) return;
      wrote = true;
      expect(draw.features.update(a.id, { properties: { n: 2 } })).not.toBeNull();
    });
    draw.features.update(a.id, { properties: { n: 1 } });
    expect(seen).toHaveLength(2);
    expect(draw.features.get(a.id)?.properties.n).toBe(2);
  });

  it('feature.updated of a drag carries intermediate as before', () => {
    const engine = createEngine(createMapStub().map, { store: createStore() });
    const local = createDrawOnEngine(engine);
    try {
      const a = local.features.create(point(0.2, 0.2)) as Feature;
      local.selection.set('feature', [a.id]);
      const updates: DrawEvents['feature.updated'][] = [];
      local.on('feature.updated', (payload) => updates.push(payload));
      const drag = createSyntheticDrag(engine);
      drag.start([0.2, 0.2]);
      drag.move([0.3, 0.2]);
      drag.move([0.4, 0.2]);
      drag.end([0.4, 0.2]);
      expect(updates.length).toBeGreaterThan(1);
      expect(updates.some((update) => update.intermediate)).toBe(true);
      expect(updates[updates.length - 1].intermediate).toBe(false);
    } finally {
      local.destroy();
    }
  });
});

describe('draw.document.subscribe', () => {
  /** Subscribes with the options and keeps the changes */
  const subscribed = (options?: Parameters<Draw['document']['subscribe']>[1]) => {
    const out: DocumentChange[] = [];
    draw.document.subscribe((change) => out.push(change), options);
    return out;
  };

  it('gives the values before only to the subscribers that asked, for the sources they named', () => {
    const a = draw.features.create(point()) as Feature;
    const all = subscribed({ previousValues: true });
    const local = subscribed({ previousValues: ['local'] });
    const notRemote = subscribed({ previousValues: { except: ['remote'] } });
    const none = subscribed();
    const onEvent = changesOf();
    draw.features.update(a.id, { properties: { name: 'A' } });
    store.transact(() => {
      store.writeRows({
        rows: Int32Array.of(store.tables.getRowRef(a.id) as number),
        fields: new Map<FeatureRowField, unknown[]>([['properties:name', ['B']]]),
      });
    }, 'remote');
    const carried = (list: DocumentChange[]) =>
      list.map((change) => change.previousValues !== undefined);
    expect(carried(all)).toEqual([true, true]);
    expect(carried(local)).toEqual([true, false]);
    expect(carried(notRemote)).toEqual([true, false]);
    expect(carried(none)).toEqual([false, false]);
    expect(carried(onEvent)).toEqual([false, false]);
    expect(all[0].previousValues?.featureCount).toBe(1);
    expect(all[0].previousValues?.byteLength).toBeGreaterThan(0);
  });

  it('asks a function once per change, before it is written', () => {
    const a = draw.features.create(point()) as Feature;
    const asked: Array<{ source: string; operationId: number; name: unknown }> = [];
    const changes = subscribed({
      previousValues: (change) => {
        asked.push({ ...change, name: draw.features.get(a.id)?.properties.name });
        return change.source === 'local';
      },
    });
    draw.features.update(a.id, { properties: { name: 'A' } });
    expect(asked).toEqual([
      { source: 'local', operationId: changes[0].operationId, name: undefined },
    ]);
    expect(changes[0].previousValues).toBeDefined();
  });

  it('gives each subscriber values of its own over the same arrays', () => {
    const a = draw.features.create(point()) as Feature;
    const first = subscribed({ previousValues: true });
    const second = subscribed({ previousValues: true });
    draw.features.update(a.id, { properties: { name: 'A' } });
    const one = first[0].previousValues as FeatureValues;
    const two = second[0].previousValues as FeatureValues;
    expect(one).not.toBe(two);
    expect(sharedValuesOf(one)).toBe(sharedValuesOf(two));
    expect(sharedValuesOf(one)?.holders).toBe(2);
    expect(first[0].features).toBe(second[0].features);
  });

  it('stops with the function it returns, and refuses what is not a listener', () => {
    const a = draw.features.create(point()) as Feature;
    const changes: DocumentChange[] = [];
    const stop = draw.document.subscribe((change) => changes.push(change));
    draw.features.update(a.id, { properties: { n: 1 } });
    stop();
    draw.features.update(a.id, { properties: { n: 2 } });
    expect(changes).toHaveLength(1);
    expect(() => draw.document.subscribe(null as never)).toThrow(DrawError);
    expect(() => draw.document.subscribe(() => {}, { previousValues: 'local' as never })).toThrow(
      DrawError,
    );
  });
});
