// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for StoreSpatialIndex (the spatial index of the Store, read through the layer over it)
 */

import { describe, expect, it } from 'vitest';
import { createDocumentAccess } from '../../api/impl/document-access.js';
import { rowWrites } from '../../test-utils.js';
import { createStore } from '../built-in/create-store.js';
import type { Store as RowStore } from '../built-in/types.js';
import type { InstanceDocument } from '../document-access.js';
import type { Feature } from '../types.js';
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

/** An Image at the origin: 1,000 pixels at zoom 10, about 0.34 degrees each way */
function image(id: string): Feature {
  return {
    ...point(id, 0, 0),
    type: 'Image',
    properties: {
      'maplibre-gl-draw:imageWidth': 1000,
      'maplibre-gl-draw:imageHeight': 1000,
      'maplibre-gl-draw:createdZoom': 10,
    },
  };
}

function layer(id: string) {
  return {
    id,
    name: id,
    visible: true,
    locked: false,
    opacity: 1,
    styleRule: undefined,
    metadata: undefined,
  };
}

/** A built-in Store with the layer `l` */
function rowStore(): RowStore {
  const store = createStore();
  store.createLayer(layer('l'));
  return store;
}

/** The layer an instance makes over a built-in Store with the layer `l` */
function documentOf(store: RowStore = rowStore()): InstanceDocument {
  return createDocumentAccess(store);
}

/**
 * A Store of the application that spreads a built-in Store, and the writes of a change made
 * outside the instance, written to it directly as rows
 */
function applicationStore() {
  const base = rowStore();
  const store: RowStore = { ...base };
  const writes = rowWrites(store);
  const remote = (fn: () => void) => store.transact(fn, 'remote');
  return {
    store,
    remoteCreate: (feature: Feature) => remote(() => writes.createFeature(feature)),
    remoteUpdate: (feature: Feature) =>
      remote(() => writes.updateFeature(feature.id, { geometry: feature.geometry })),
    /** Replaces the whole document */
    remoteReplace: (next: Feature[]) =>
      remote(() => {
        store.clear();
        store.createLayer(layer('l'));
        for (const feature of next) writes.createFeature(feature);
      }),
    remoteDelete: (id: string) => remote(() => writes.deleteFeature(id)),
  };
}

describe('StoreSpatialIndex', () => {
  it('indexes the features the Store already holds', () => {
    const store = rowStore();
    store.transact(() => rowWrites(store).createFeature(point('a', 1, 1)), 'remote');
    const index = new StoreSpatialIndex(documentOf(store));
    expect(index.findNear([1, 1], 0)).toEqual(['a']);
  });

  it('finds a feature with its new box after a create, an update and a delete', () => {
    const store = documentOf();
    const index = new StoreSpatialIndex(store);

    store.createFeature(point('a', 1, 1));
    expect(index.findNear([1, 1], 0)).toEqual(['a']);

    store.updateFeature('a', { geometry: { type: 'Point', coordinates: [2, 2] } });
    expect(index.findNear([1, 1], 0)).toEqual([]);
    expect(index.findNear([2, 2], 0)).toEqual(['a']);

    store.deleteFeature('a');
    expect(index.findNear([2, 2], 0)).toEqual([]);
  });

  it('finds a feature with its box after the intermediate updates of a drag', () => {
    const store = documentOf();
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
    const store = documentOf();
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
    const store = documentOf();
    const index = new StoreSpatialIndex(store);
    store.createLayer({ ...layer('m'), items: [] });
    store.createFeature({ ...point('a', 1, 1), layerId: 'm' });

    store.deleteLayer('m');

    expect(index.findNear([1, 1], 0)).toEqual([]);
  });

  it('holds nothing the read-only Store refused', () => {
    const store = documentOf();
    const index = new StoreSpatialIndex(store);
    store.setReadOnly(true);
    store.createFeature(point('a', 1, 1));
    expect(index.findNear([1, 1], 1)).toEqual([]);
  });

  it('finds the features with their new boxes after changes written to the Store directly', () => {
    const remote = applicationStore();
    const index = new StoreSpatialIndex(documentOf(remote.store));

    remote.remoteCreate(point('r', 1, 1));
    expect(index.findNear([1, 1], 0)).toEqual(['r']);

    remote.remoteUpdate(point('r', 2, 2));
    expect(index.findNear([2, 2], 0)).toEqual(['r']);

    remote.remoteUpdate(point('r', 3, 3));
    expect(index.findNear([3, 3], 0)).toEqual(['r']);

    remote.remoteDelete('r');
    expect(index.findNear([3, 3], 0)).toEqual([]);
  });

  it('finds what the Store holds when the whole document is replaced', () => {
    const remote = applicationStore();
    remote.remoteCreate(point('old', 1, 1));
    const index = new StoreSpatialIndex(documentOf(remote.store));
    expect(index.findNear([1, 1], 0)).toEqual(['old']);

    remote.remoteReplace([point('a', 2, 2), point('b', 3, 3)]);

    expect(index.findNear([1, 1], 0)).toEqual([]);
    expect(index.findNear([2, 2], 0)).toEqual(['a']);
    expect(index.findNear([3, 3], 0)).toEqual(['b']);
  });

  it('measures a registered custom type with its calculator, also for existing features', () => {
    const store = documentOf();
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
    const index = new StoreSpatialIndex(documentOf());
    for (const write of ['insert', 'update', 'remove', 'clear']) {
      expect(write in index).toBe(false);
    }
  });

  it('takes back the boxes it set on the Store on destroy', () => {
    const store = documentOf();
    store.createFeature(image('img'));
    const index = new StoreSpatialIndex(store);
    // Away from its position, within the box of its size
    expect(index.findNear([0.2, 0.2], 0).length).toBe(1);
    index.destroy();
    expect(index.findNear([0.2, 0.2], 0).length).toBe(0);
  });
});
