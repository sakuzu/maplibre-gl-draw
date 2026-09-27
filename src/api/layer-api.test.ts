// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for the Layer API
 *
 * Verifies the addLayer / deleteLayer / activeLayer operations, and that the features in a
 * layer leave the spatial index derived from the Store when the layer is deleted.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { AutoNameGenerator } from '../shared/utils/name-generator.js';
import { MemoryStore } from '../store/memory.js';
import { StoreSpatialIndex } from '../store/spatial/store-spatial-index.js';
import type { Feature } from '../store/types.js';
import { createLayerApi, type LayerApi } from './layer-api.js';

function feature(id: string, layerId: string): Feature {
  return {
    id,
    type: 'Point',
    geometry: { type: 'Point', coordinates: [0, 0] },
    layerId,
    properties: {},
    locked: false,
    visible: true,
    style: {},
  };
}

let store: MemoryStore;
let spatial: StoreSpatialIndex;
let api: LayerApi;
let activeLayerId: string;
let idSeq: number;

beforeEach(() => {
  store = new MemoryStore();
  store.createLayer({ id: 'l1', name: 'l1', visible: true, locked: false, opacity: 1, items: [] });
  spatial = new StoreSpatialIndex(store);
  activeLayerId = 'l1';
  idSeq = 0;
  api = createLayerApi({
    store,
    generateFeatureId: () => `lyr-${++idSeq}`,
    autoNameGenerator: { generateLayerName: () => '自動レイヤー' } as unknown as AutoNameGenerator,
    getActiveLayerId: () => activeLayerId,
    setActiveLayerId: (id: string) => {
      activeLayerId = id;
    },
  });
});

/** Adds a layer to the writable store (addLayer returns null only while read-only) */
function addWritableLayer(name: string): string {
  const id = api.addLayer(name);
  if (id === null) throw new Error('addLayer was refused');
  return id;
}

describe('LayerApi.addLayer', () => {
  it('adds a layer with a given name', () => {
    const id = api.addLayer('マイレイヤー');
    expect(id).toBe('lyr-1');
    expect(store.getLayer('lyr-1')?.name).toBe('マイレイヤー');
  });

  it('uses autoNameGenerator when the name is omitted', () => {
    const id = api.addLayer();
    expect(id).not.toBeNull();
    expect(store.getLayer(id as string)?.name).toBe('自動レイヤー');
  });

  it('names the layer with the configured word alone when automatic naming is off', () => {
    const offApi = createLayerApi({
      store,
      generateFeatureId: () => `off-${++idSeq}`,
      autoNameGenerator: new AutoNameGenerator(store, {
        enabled: false,
        typeNames: { Layer: 'Ebene' },
      }),
      getActiveLayerId: () => activeLayerId,
      setActiveLayerId: () => undefined,
    });
    const id = offApi.addLayer();
    expect(store.getLayer(id as string)?.name).toBe('Ebene');
  });

  it('returns null and adds nothing while read-only', () => {
    store.setReadOnly(true);
    expect(api.addLayer('refused')).toBeNull();
    expect(store.getAllLayers().map((l) => l.id)).toEqual(['l1']);
  });
});

describe('LayerApi.deleteLayer', () => {
  it('removes the features in the layer from the spatial index', () => {
    const id = addWritableLayer('対象');
    store.createFeature(feature('f1', id));
    store.createFeature(feature('f2', id));

    expect(spatial.findNear([0, 0], 0).sort()).toEqual(['f1', 'f2']);

    api.deleteLayer(id);

    expect(store.getLayer(id)).toBeUndefined();
    expect(spatial.findNear([0, 0], 0)).toEqual([]);
  });
});

describe('LayerApi active layer / order', () => {
  it('keeps setActiveLayer / getActiveLayer in sync', () => {
    const id = addWritableLayer('a');
    api.setActiveLayer(id);
    expect(api.getActiveLayer()).toBe(id);
  });

  it('delegates setLayerOrder / getLayerOrder to the store', () => {
    const id = addWritableLayer('a');
    api.setLayerOrder([id, 'l1']);
    expect(api.getLayerOrder()).toEqual([id, 'l1']);
  });
});
