// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for a change that replaces the whole document, written to the Store from elsewhere
 * (`clear`, then the new document, in one transaction of the source `'remote'`)
 *
 * - Every feature taken out is told as deleted, whatever the number of features the instance
 *   keeps made, before the features the change writes are told as created
 * - The selection and the items this client hides let go of what is gone, and keep an ID the
 *   change writes again
 * - Without a listener of `feature.deleted`, no feature is made of what is taken out; while the
 *   state of this client holds nothing, no ID of a row taken out is read
 * - The built-in Store carries every field of the rows taken out to a listener that asked for
 *   the values before, and reads nothing for them otherwise
 * - The summary of the change (`document.changed` and `draw.document.subscribe`) lists every
 *   feature, layer and group taken out as deleted and every one written as created: one written
 *   again with its ID is in both, and none is updated
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkCounts } from '../../shared/work-counts.js';
import { storeOf } from '../../store/built-in/create-store.js';
import { openDocument } from '../../store/built-in/document.js';
import type { FeatureRowField, Store, StoreChange } from '../../store/built-in/types.js';
import {
  compareWork,
  countsOf,
  createCountingStore,
  createMapStub,
  gridPoints,
  rowWrites,
  workDuring,
} from '../../test-utils.js';
import type { Draw } from '../draw.js';
import type { DocumentChange } from '../events.js';
import type { Feature, Layer } from '../model.js';
import { createDrawOnEngine } from './create-draw.js';
import { createEngine } from './engine.js';

const draws: Draw[] = [];

afterEach(() => {
  for (const draw of draws.splice(0)) draw.destroy();
  vi.useRealTimers();
});

/** A layer of the Store, by its ID */
function layer(id: string): Layer {
  return {
    id,
    name: id,
    visible: true,
    locked: false,
    opacity: 1,
    styleRule: undefined,
    metadata: undefined,
  } as Layer;
}

/** A point of the layer `next`, as the change writes it */
function nextPoint(id: string): Feature {
  return {
    id,
    type: 'Point',
    geometry: { type: 'Point', coordinates: [0.5, 0.5] },
    properties: { again: true },
    layerId: 'next',
    groupId: undefined,
    style: {},
    visible: true,
    locked: false,
  };
}

/**
 * An instance over a built-in Store, the Store, the numbers of the work it does for the values
 * before, and what goes through the Store the instance was given. `first` is subscribed to the
 * Store before the instance is made, and `last` after it
 */
function instance(
  first: (change: StoreChange) => void = () => {},
  last: (change: StoreChange) => void = () => {},
) {
  vi.useFakeTimers();
  const document = openDocument();
  const store = storeOf(document);
  store.subscribe(first);
  const counting = createCountingStore(store);
  const engine = createEngine(
    createMapStub().map,
    { store: counting.store },
    { deferDefaultMode: true },
  );
  const draw = createDrawOnEngine(engine, { store: counting.store });
  engine.enterDefaultMode();
  store.subscribe(last);
  draws.push(draw);
  return {
    draw,
    store,
    counts: countsOf(store),
    before: document.changes.beforeCounts as WorkCounts,
    storeWork: counting.work,
  };
}

/** A document of `size` points, with a style, attributes and a group of the first two */
function fill(draw: Draw, size: number): string[] {
  const ids = (
    draw.features.createMany(
      gridPoints(size).map((input, i) => ({
        ...input,
        properties: { n: i },
        style: { strokeColor: i % 2 === 0 ? '#ff0000' : '#00ff00' },
      })),
    ) as Feature[]
  ).map((feature) => feature.id);
  draw.groups.create({ featureIds: ids.slice(0, 2) });
  return ids;
}

/** Replaces the whole document from elsewhere: a layer, and the points of the IDs given */
function replace(store: Store, again: readonly string[] = []): void {
  store.transact(() => {
    store.clear();
    store.createLayer(layer('next'));
    const rows = rowWrites(store);
    for (const id of again) rows.createFeature(nextPoint(id));
  }, 'remote');
}

describe('a change that replaces the whole document', () => {
  it.each([3, 1_500, 3_000])(
    'tells every one of %i features taken out, before the features it writes',
    (size) => {
      const { draw, store } = instance();
      const ids = fill(draw, size);
      const before = new Map(draw.features.list().map((feature) => [feature.id, feature]));
      const told: Array<{ kind: 'created' | 'deleted'; feature: Feature }> = [];
      draw.on('feature.deleted', ({ feature }) => told.push({ kind: 'deleted', feature }));
      draw.on('feature.created', ({ feature }) => told.push({ kind: 'created', feature }));
      replace(store, ['written']);
      const deleted = told.filter((entry) => entry.kind === 'deleted');
      expect(deleted).toHaveLength(size);
      expect(new Set(deleted.map((entry) => entry.feature.id))).toEqual(new Set(ids));
      expect(told[told.length - 1]).toEqual({
        kind: 'created',
        feature: draw.features.get('written'),
      });
      expect(told.findIndex((entry) => entry.kind === 'created')).toBe(size);
      // Each as it was before the change
      for (const { feature } of deleted) expect(feature).toEqual(before.get(feature.id));
    },
  );

  it.each([3, 1_500, 3_000])(
    'lets go of the %i features selected and hidden that are gone',
    (size) => {
      const { draw, store } = instance();
      const ids = fill(draw, size);
      draw.selection.set('feature', [ids[size - 1]]);
      draw.hidden.add(ids[1]);
      draw.hidden.add(ids[size - 2]);
      replace(store);
      expect({ type: draw.selection.get().type, ids: draw.selection.get().ids.toArray() }).toEqual({
        type: null,
        ids: [],
      });
      expect([...draw.hidden.list().iterate()]).toEqual([]);
    },
  );

  it.each([3, 1_500, 3_000])('keeps an ID of %i features it writes again', (size) => {
    const { draw, store } = instance();
    const ids = fill(draw, size);
    draw.selection.set('feature', [ids[size - 1]]);
    draw.hidden.add(ids[0]);
    draw.hidden.add(ids[1]);
    replace(store, [ids[size - 1], ids[0]]);
    expect(draw.selection.get().type).toBe('feature');
    expect(draw.selection.get().ids.toArray()).toEqual([ids[size - 1]]);
    expect([...draw.hidden.list().iterate()]).toEqual([ids[0]]);
  });

  it('makes no feature of what it takes out without a listener of feature.deleted', () => {
    const work = compareWork(
      (size) => {
        let start = 0;
        let made = 0;
        const { draw, store, counts, before } = instance(
          () => {
            start = counts.objectsCreated - before.objectsCreated;
          },
          () => {
            made += counts.objectsCreated - before.objectsCreated - start;
          },
        );
        fill(draw, size);
        // Read as many as the instance keeps made
        draw.features.list();
        draw.on('feature.created', () => {});
        made = 0;
        replace(store);
        return made;
      },
      { zero: true },
    );
    expect(work).toEqual({ small: 0, large: 0, ratio: 0 });
  });

  it('reads no ID of a row taken out while the state of this client holds nothing', () => {
    const work = compareWork(
      (size) => {
        const { draw, store, storeWork } = instance();
        fill(draw, size);
        draw.features.list();
        const calls = storeWork.calls.get('getRowId') ?? 0;
        replace(store);
        return (storeWork.calls.get('getRowId') ?? 0) - calls;
      },
      { zero: true },
    );
    expect(work).toEqual({ small: 0, large: 0, ratio: 0 });
  });
});

/** The IDs of a summary of the features, read while the change is told */
interface ReadIds {
  deletedCount: number;
  deletedHas: boolean[];
  created: string[];
  updatedCount: number;
}

/** Reads a summary of the features against the IDs that were there before the change */
function readIds(features: DocumentChange['features'], before: readonly string[]): ReadIds {
  return {
    deletedCount: features.deleted.count(),
    deletedHas: before.map((id) => features.deleted.has(id)),
    created: [...features.created.iterate()].sort(),
    updatedCount: features.updated.count(),
  };
}

describe('the summary of a change that replaces the whole document', () => {
  it.each([3, 1_500])(
    'lists every one of %i features taken out as deleted, and one written again as created too',
    (size) => {
      const { draw, store } = instance();
      const ids = fill(draw, size);
      const told: ReadIds[] = [];
      const subscribed: ReadIds[] = [];
      draw.on('document.changed', (change) => {
        if (change.reset) told.push(readIds(change.features, ids));
      });
      draw.document.subscribe((change) => {
        if (change.reset) subscribed.push(readIds(change.features, ids));
      });
      replace(store, [ids[1], 'written']);
      const expected: ReadIds = {
        deletedCount: size,
        deletedHas: ids.map(() => true),
        created: [ids[1], 'written'].sort(),
        updatedCount: 0,
      };
      expect(told).toEqual([expected]);
      expect(subscribed).toEqual([expected]);
    },
  );

  it('lists a layer and a group written again with their IDs as deleted and created', () => {
    const { draw, store } = instance();
    const ids = fill(draw, 3);
    const groupId = draw.features.get(ids[0])?.groupId as string;
    const layerId = draw.features.get(ids[0])?.layerId as string;
    const read = (change: DocumentChange) => ({
      layersCreated: (change.layers?.created ?? []).map((item) => item.id).sort(),
      layersDeleted: (change.layers?.deleted ?? []).map((item) => item.id).sort(),
      layersUpdated: (change.layers?.updated ?? []).map((item) => item.id),
      groupsCreated: (change.groups?.created ?? []).map((item) => item.id).sort(),
      groupsDeleted: (change.groups?.deleted ?? []).map((item) => item.id).sort(),
      groupsUpdated: (change.groups?.updated ?? []).map((item) => item.id),
      features: readIds(change.features, ids),
    });
    const told: Array<ReturnType<typeof read>> = [];
    const subscribed: Array<ReturnType<typeof read>> = [];
    draw.on('document.changed', (change) => {
      if (change.reset) told.push(read(change));
    });
    draw.document.subscribe((change) => {
      if (change.reset) subscribed.push(read(change));
    });
    store.transact(() => {
      store.clear();
      store.createLayer(layer(layerId));
      store.createLayer(layer('next'));
      store.createGroup({
        id: groupId,
        layerId,
        orderKey: 'm',
        name: 'Again',
        visible: true,
        locked: false,
      } as Parameters<Store['createGroup']>[0]);
      rowWrites(store).createFeature({ ...nextPoint(ids[0]), layerId, groupId });
    }, 'remote');
    const expected = {
      layersCreated: [layerId, 'next'].sort(),
      layersDeleted: [layerId],
      layersUpdated: [],
      groupsCreated: [groupId],
      groupsDeleted: [groupId],
      groupsUpdated: [],
      features: {
        deletedCount: 3,
        deletedHas: [true, true, true],
        created: [ids[0]],
        updatedCount: 0,
      },
    };
    expect(told).toEqual([expected]);
    expect(subscribed).toEqual([expected]);
  });
});

describe('the clear of the built-in Store', () => {
  /** A Store of two points in the layer `a`, one of them in the group `g` */
  function written() {
    const document = openDocument();
    const store = storeOf(document);
    store.createLayer(layer('a'));
    store.createGroup({
      id: 'g',
      layerId: 'a',
      orderKey: 'm',
      name: 'G',
      visible: true,
      locked: false,
    } as Parameters<Store['createGroup']>[0]);
    store.createRows({
      ids: ['p', 'q'],
      fields: new Map<FeatureRowField, unknown[]>([
        ['type', ['Point', 'Point']],
        ['parent', ['a', 'g']],
        ['orderKey', ['k1', 'k2']],
        ['visible', [true, false]],
        ['locked', [false, true]],
        ['style', [{ strokeColor: '#111111' }, { fillColor: '#222222', strokeWidth: 3 }]],
        ['properties:name', ['P', undefined]],
        ['properties:size', [undefined, 7]],
      ]),
      geometry: {
        types: new Uint8Array([0, 0]),
        coordinates: Float64Array.of(1, 2, 3, 4),
        valuesPerPosition: 2,
        partStarts: Int32Array.of(0, 1, 2),
        ringStarts: Int32Array.of(0, 1, 2),
        positionStarts: Int32Array.of(0, 1, 2),
      },
    });
    const refs = ['p', 'q'].map((id) => store.tables.getRowRef(id) as number);
    return { store, refs, before: document.changes.beforeCounts as WorkCounts };
  }

  it('carries every field of the rows taken out to a listener that asked for the values before', () => {
    const { store, refs } = written();
    const changes: StoreChange[] = [];
    store.subscribe((change) => changes.push(change), { previousValues: true });
    store.clear();
    const values = changes[0].previousValues?.get('a');
    expect(changes[0].reset).toBe(true);
    expect(values?.rows).toEqual(Int32Array.from(refs));
    const fields = Object.fromEntries(values?.fields ?? []);
    expect(fields).toEqual({
      type: ['Point', 'Point'],
      parent: ['a', 'g'],
      orderKey: ['k1', 'k2'],
      visible: [true, false],
      locked: [false, true],
      'properties:name': ['P', undefined],
      'properties:size': [undefined, 7],
      'style:strokeColor': ['#111111', undefined],
      'style:fillColor': [undefined, '#222222'],
      'style:strokeWidth': [undefined, 3],
    });
    expect(Array.from(values?.geometry?.coordinates ?? [])).toEqual([1, 2, 3, 4]);
    expect(Array.from(values?.deleted ?? [])).toEqual([0, 0]);
  });

  it('reads nothing for the values before while no listener asks for them', () => {
    const { store, before } = written();
    store.subscribe(() => {}, { previousValues: ['local'] });
    const work = workDuring(before, () => store.clear());
    expect(work.rowsTouched).toBe(0);
    expect(work.objectsCreated).toBe(0);
  });
});
