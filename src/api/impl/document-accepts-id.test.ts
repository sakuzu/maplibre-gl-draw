// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A load into a Store that takes ids of its own form only (`Store.acceptsId`): a feature, a
 * group or a layer whose id the Store does not take gets a new id, as one whose id is taken
 * does, and the references to it name the new one
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { MemoryStore } from '../../store/memory.js';
import { createResourceDeps } from '../../test-utils.js';
import type { DocumentResource } from '../document.js';
import { createDocument } from './document.js';

let store: MemoryStore;
let doc: DocumentResource;

beforeEach(() => {
  store = new MemoryStore();
  // The ids the instance makes (`id-1`, `id-2`...) are the only ones it takes
  Object.assign(store, { acceptsId: (id: string) => id.startsWith('id-') });
  store.createLayer({
    id: 'id-layer',
    name: 'l1',
    visible: true,
    locked: false,
    opacity: 1,
    items: [],
    styleRule: undefined,
    metadata: undefined,
  });
  doc = createDocument(createResourceDeps(store));
});

describe('a load into a Store that takes ids of its own form', () => {
  it('gives the features of GeoJSON whose ids it does not take new ids', async () => {
    const result = await doc.load({
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          id: 'road-1',
          geometry: { type: 'Point', coordinates: [1, 1] },
          properties: {},
        },
        {
          type: 'Feature',
          id: 42,
          geometry: { type: 'Point', coordinates: [2, 2] },
          properties: {},
        },
        { type: 'Feature', geometry: { type: 'Point', coordinates: [3, 3] }, properties: {} },
      ],
    });
    const ids = result?.featureIds ?? [];
    expect(ids).toHaveLength(3);
    for (const id of ids) {
      expect(id.startsWith('id-')).toBe(true);
      expect(store.getFeature(id)).toBeDefined();
    }
  });

  it('gives the layers, groups and features of a document new ids, and its references with them', async () => {
    const result = await doc.load({
      version: '2.0.0',
      created: '2026-01-01T00:00:00.000Z',
      modified: '2026-01-01T00:00:00.000Z',
      layers: [
        {
          id: 'L',
          name: 'L',
          visible: true,
          locked: false,
          opacity: 1,
          items: ['G'],
          styleRule: undefined,
          metadata: undefined,
        },
      ],
      layerOrder: ['L'],
      groups: [
        { id: 'G', layerId: 'L', name: 'G', visible: true, locked: false, featureIds: ['F'] },
      ],
      features: [
        {
          id: 'F',
          type: 'Point',
          geometry: { type: 'Point', coordinates: [1, 1] },
          layerId: 'L',
          groupId: 'G',
          properties: {},
          style: {},
          visible: true,
          locked: false,
        },
      ],
    });
    const [featureId] = result?.featureIds ?? [];
    expect(featureId?.startsWith('id-')).toBe(true);
    const feature = store.getFeature(featureId as string);
    expect(feature?.layerId.startsWith('id-')).toBe(true);
    expect(feature?.groupId?.startsWith('id-')).toBe(true);
    expect(store.getGroup(feature?.groupId as string)?.layerId).toBe(feature?.layerId);
    expect(store.getLayerOrder()).toContain(feature?.layerId);
    expect(store.getLayer('L')).toBeUndefined();
  });
});
