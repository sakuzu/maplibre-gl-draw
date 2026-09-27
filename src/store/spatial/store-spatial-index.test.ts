// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for StoreSpatialIndex (the spatial index derived from the Store)
 */

import { describe, expect, it } from 'vitest';
import { MemoryStore } from '../memory.js';
import type { Store } from '../store.js';
import type { Feature, StoreChange } from '../types.js';
import { StoreSpatialIndex } from './store-spatial-index.js';

function point(id: string, lng: number, lat: number): Feature {
  return {
    id,
    type: 'Point',
    geometry: { type: 'Point', coordinates: [lng, lat] },
    layerId: 'l',
    groupId: undefined,
    properties: {},
    locked: false,
    visible: true,
    style: {},
  };
}

function memoryStore(): MemoryStore {
  const store = new MemoryStore();
  store.createLayer({
    id: 'l',
    name: 'l',
    visible: true,
    locked: false,
    opacity: 1,
    items: [],
    styleRule: undefined,
    metadata: undefined,
  });
  return store;
}

/**
 * A Store that is not MemoryStore: it holds the features in a Map and announces every
 * change through subscribe, the way a replaced Store applies a change from elsewhere
 */
function stubStore() {
  const features = new Map<string, Feature>();
  const listeners = new Set<(changes: StoreChange) => void>();
  const emit = (changes: StoreChange) => {
    for (const listener of listeners) listener(changes);
  };
  const store = {
    getFeature: (id: string) => features.get(id),
    listFeatures: () => [...features.values()],
    subscribe: (listener: (changes: StoreChange) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  } as unknown as Store;
  return {
    store,
    features,
    listenerCount: () => listeners.size,
    remoteCreate(feature: Feature) {
      features.set(feature.id, feature);
      emit({ source: 'remote', features: { created: [feature] } });
    },
    remoteUpdate(feature: Feature, isIntermediate?: boolean) {
      const previous = features.get(feature.id) as Feature;
      features.set(feature.id, feature);
      emit({
        source: 'remote',
        features: { updated: [{ id: feature.id, feature, previous, isIntermediate }] },
      });
    },
    remoteDelete(id: string) {
      const previous = features.get(id) as Feature;
      features.delete(id);
      emit({ source: 'remote', features: { deleted: [previous] } });
    },
  };
}

describe('StoreSpatialIndex', () => {
  it('indexes the features the Store already holds', () => {
    const store = memoryStore();
    store.createFeature(point('a', 1, 1));
    const index = new StoreSpatialIndex(store);
    expect(index.findNear([1, 1], 0)).toEqual(['a']);
  });

  it('follows create, update and delete of the Store', () => {
    const store = memoryStore();
    const index = new StoreSpatialIndex(store);

    store.createFeature(point('a', 1, 1));
    expect(index.findNear([1, 1], 0)).toEqual(['a']);

    store.updateFeature('a', { geometry: { type: 'Point', coordinates: [2, 2] } });
    expect(index.findNear([1, 1], 0)).toEqual([]);
    expect(index.findNear([2, 2], 0)).toEqual(['a']);

    store.deleteFeature('a');
    expect(index.findNear([2, 2], 0)).toEqual([]);
  });

  it('follows the intermediate updates of a drag', () => {
    const store = memoryStore();
    const index = new StoreSpatialIndex(store);
    store.createFeature(point('a', 1, 1));

    store.updateFeature(
      'a',
      { geometry: { type: 'Point', coordinates: [3, 3] } },
      { isIntermediate: true },
    );

    expect(index.findNear([3, 3], 0)).toEqual(['a']);
  });

  it('reads the final state of a transaction whatever the order of its entries', () => {
    const store = memoryStore();
    const index = new StoreSpatialIndex(store);
    store.transact(() => {
      store.createFeature(point('a', 1, 1));
      store.updateFeature('a', { geometry: { type: 'Point', coordinates: [4, 4] } });
      store.createFeature(point('b', 5, 5));
      store.deleteFeature('b');
    });
    expect(index.findInBounds({ minX: 0, minY: 0, maxX: 6, maxY: 6 })).toEqual(['a']);
    expect(index.findNear([4, 4], 0)).toEqual(['a']);
  });

  it('drops the features of a deleted layer', () => {
    const store = memoryStore();
    const index = new StoreSpatialIndex(store);
    store.createLayer({
      id: 'm',
      name: 'm',
      visible: true,
      locked: false,
      opacity: 1,
      items: [],
      styleRule: undefined,
      metadata: undefined,
    });
    store.createFeature({ ...point('a', 1, 1), layerId: 'm' });

    store.deleteLayer('m');

    expect(index.findNear([1, 1], 0)).toEqual([]);
  });

  it('holds nothing the read-only Store refused', () => {
    const store = memoryStore();
    const index = new StoreSpatialIndex(store);
    store.setReadOnly(true);
    store.createFeature(point('a', 1, 1));
    expect(index.findNear([1, 1], 1)).toEqual([]);
  });

  it('follows the changes from elsewhere of a Store that is not MemoryStore', () => {
    const remote = stubStore();
    const index = new StoreSpatialIndex(remote.store);

    remote.remoteCreate(point('r', 1, 1));
    expect(index.findNear([1, 1], 0)).toEqual(['r']);

    remote.remoteUpdate(point('r', 2, 2), true);
    expect(index.findNear([2, 2], 0)).toEqual(['r']);

    remote.remoteUpdate(point('r', 3, 3));
    expect(index.findNear([3, 3], 0)).toEqual(['r']);

    remote.remoteDelete('r');
    expect(index.findNear([3, 3], 0)).toEqual([]);
  });

  it('measures a registered custom type with its calculator, also for existing features', () => {
    const store = memoryStore();
    store.createFeature({ ...point('c', 0, 0), type: 'Custom' as Feature['type'] });
    const index = new StoreSpatialIndex(store);

    index.setCustomBoundingBoxCalculator('Custom', () => ({
      minX: -1,
      minY: -1,
      maxX: 1,
      maxY: 1,
    }));

    expect(index.findNear([0.5, 0.5], 0)).toEqual(['c']);
  });

  it('has no writes, so a feature enters it only through the Store', () => {
    const index = new StoreSpatialIndex(memoryStore());
    for (const write of ['insert', 'update', 'remove', 'clear']) {
      expect(write in index).toBe(false);
    }
  });

  it('stops following the Store on destroy', () => {
    const remote = stubStore();
    const index = new StoreSpatialIndex(remote.store);
    expect(remote.listenerCount()).toBe(1);
    index.destroy();
    expect(remote.listenerCount()).toBe(0);
  });
});
