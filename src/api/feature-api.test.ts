// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for the Feature API
 *
 * Verifies that addFeature/updateFeature/deleteFeature update the Store, and that the spatial
 * index derived from the Store follows every one of them.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { coordinatesOf } from '../shared/utils/coordinates.js';
import { MemoryStore } from '../store/memory.js';
import { StoreSpatialIndex } from '../store/spatial/store-spatial-index.js';
import type { Feature } from '../store/types.js';
import { createFeatureApi, type FeatureApi } from './feature-api.js';

let store: MemoryStore;
let spatial: StoreSpatialIndex;
let api: FeatureApi;
let idSeq: number;

beforeEach(() => {
  store = new MemoryStore();
  store.createLayer({ id: 'l1', name: 'l1', visible: true, locked: false, opacity: 1, order: [] });
  spatial = new StoreSpatialIndex(store);
  idSeq = 0;
  api = createFeatureApi({
    store,
    generateFeatureId: () => `gen-${++idSeq}`,
    getActiveLayerId: () => 'l1',
  });
});

describe('FeatureApi.addFeature', () => {
  it('adds with an explicit id and reflects it in the store and the spatial index', () => {
    const id = api.addFeature({
      id: 'f1',
      type: 'Point',
      geometry: { type: 'Point', coordinates: [0, 0] },
    });
    expect(id).toBe('f1');
    expect(store.getFeature('f1')).toBeDefined();
    expect(spatial.findNear([0, 0], 0)).toEqual(['f1']);
  });

  it('uses generateFeatureId when id is omitted and activeLayerId when layerId is omitted', () => {
    const id = api.addFeature({ type: 'Point', geometry: { type: 'Point', coordinates: [1, 2] } });
    expect(id).toBe('gen-1');
    expect(store.getFeature('gen-1')?.layerId).toBe('l1');
  });

  it('returns null and leaves the spatial index empty while read-only', () => {
    store.setReadOnly(true);
    expect(
      api.addFeature({ id: 'f1', type: 'Point', geometry: { type: 'Point', coordinates: [0, 0] } }),
    ).toBeNull();
    expect(store.getFeature('f1')).toBeUndefined();
    expect(spatial.findNear([0, 0], 1)).toEqual([]);
  });
});

describe('FeatureApi.updateFeature', () => {
  it('moves the entry of the spatial index when the coordinates change', () => {
    api.addFeature({ id: 'f1', type: 'Point', geometry: { type: 'Point', coordinates: [0, 0] } });

    api.updateFeature('f1', { geometry: { type: 'Point', coordinates: [5, 5] } });

    expect(coordinatesOf(store.getFeature('f1'))).toEqual([5, 5]);
    expect(spatial.findNear([0, 0], 0.1)).toEqual([]);
    expect(spatial.findNear([5, 5], 0.1)).toEqual(['f1']);
  });

  it('re-measures a custom type whose extent depends on the style', () => {
    // The bbox computation of a registered type can look at the style, so an update of the
    // style re-measures it like an update of the coordinates
    spatial.setCustomBoundingBoxCalculator('Point', (feature) => {
      const [lng, lat] = coordinatesOf(feature) as [number, number];
      const r = (feature.style as { markerIcon?: string } | undefined)?.markerIcon ? 1 : 0;
      return { minX: lng - r, minY: lat - r, maxX: lng + r, maxY: lat + r };
    });
    api.addFeature({ id: 'f1', type: 'Point', geometry: { type: 'Point', coordinates: [0, 0] } });
    expect(spatial.findNear([0.5, 0.5], 0)).toEqual([]);

    api.updateFeature('f1', { style: { markerIcon: 'hospital' } as Feature['style'] });

    expect(spatial.findNear([0.5, 0.5], 0)).toEqual(['f1']);
  });

  it('throws for a feature that does not exist, changing nothing', () => {
    expect(() =>
      api.updateFeature('missing', { geometry: { type: 'Point', coordinates: [1, 1] } }),
    ).toThrow(/not found/);
    expect(spatial.findNear([1, 1], 0)).toEqual([]);
  });

  it('returns false instead of throwing while read-only', () => {
    api.addFeature({ id: 'f1', type: 'Point', geometry: { type: 'Point', coordinates: [0, 0] } });
    store.setReadOnly(true);
    expect(api.updateFeature('f1', { geometry: { type: 'Point', coordinates: [5, 5] } })).toBe(
      false,
    );
    expect(coordinatesOf(store.getFeature('f1'))).toEqual([0, 0]);
  });

  it('returns false for a locked feature and true once applied', () => {
    api.addFeature({
      id: 'f1',
      type: 'Point',
      geometry: { type: 'Point', coordinates: [0, 0] },
      locked: true,
    });
    expect(api.updateFeature('f1', { geometry: { type: 'Point', coordinates: [5, 5] } })).toBe(
      false,
    );
    expect(api.updateFeature('f1', { locked: false })).toBe(true);
    expect(api.updateFeature('f1', { geometry: { type: 'Point', coordinates: [5, 5] } })).toBe(
      true,
    );
    expect(coordinatesOf(store.getFeature('f1'))).toEqual([5, 5]);
  });
});

describe('FeatureApi.getAllFeatures / getVisibleFeatures', () => {
  it('lists every feature in display order, hidden ones included', () => {
    api.addFeature({ id: 'f1', type: 'Point', geometry: { type: 'Point', coordinates: [0, 0] } });
    api.addFeature({
      id: 'f2',
      type: 'Point',
      geometry: { type: 'Point', coordinates: [1, 1] },
      visible: false,
    });
    api.addFeature({ id: 'f3', type: 'Point', geometry: { type: 'Point', coordinates: [2, 2] } });

    expect(api.getAllFeatures().map((f) => f.id)).toEqual(['f1', 'f2', 'f3']);
    expect(api.getVisibleFeatures().map((f) => f.id)).toEqual(['f1', 'f3']);
  });

  it('lists the features of a hidden layer in getAllFeatures only', () => {
    api.addFeature({ id: 'f1', type: 'Point', geometry: { type: 'Point', coordinates: [0, 0] } });
    store.updateLayer('l1', { visible: false });

    expect(api.getAllFeatures().map((f) => f.id)).toEqual(['f1']);
    expect(api.getVisibleFeatures()).toEqual([]);
  });
});

describe('FeatureApi.deleteFeature / deleteAllFeatures', () => {
  it('deletes from the store and the spatial index with deleteFeature', () => {
    api.addFeature({ id: 'f1', type: 'Point', geometry: { type: 'Point', coordinates: [0, 0] } });
    api.deleteFeature('f1');
    expect(store.getFeature('f1')).toBeUndefined();
    expect(spatial.findNear([0, 0], 0)).toEqual([]);
  });

  it('keeps the entry of a feature the read-only Store keeps', () => {
    api.addFeature({ id: 'f1', type: 'Point', geometry: { type: 'Point', coordinates: [0, 0] } });
    store.setReadOnly(true);
    expect(api.deleteFeature('f1')).toBe(false);
    expect(store.getFeature('f1')).toBeDefined();
    expect(spatial.findNear([0, 0], 0)).toEqual(['f1']);
  });

  it('deletes every feature with deleteAllFeatures', () => {
    api.addFeature({ id: 'f1', type: 'Point', geometry: { type: 'Point', coordinates: [0, 0] } });
    api.addFeature({
      id: 'f2',
      type: 'Point',
      geometry: { type: 'Point', coordinates: [1, 1] },
      visible: false,
    });
    expect(api.deleteAllFeatures()).toBe(true);
    expect(store.getAllFeatures()).toHaveLength(0);
    expect(spatial.findInBounds({ minX: -1, minY: -1, maxX: 2, maxY: 2 })).toEqual([]);
  });
});
