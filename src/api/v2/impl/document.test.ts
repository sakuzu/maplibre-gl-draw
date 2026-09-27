// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for draw.metadata and draw.document
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { MemoryStore } from '../../../store/memory.js';
import { createResourceDeps } from '../../../test-utils.js';
import type { DocumentResource } from '../document.js';
import { DrawError } from '../errors.js';
import type { MetadataResource } from '../metadata.js';
import { createDocument } from './document.js';
import { createMetadata } from './metadata.js';

let store: MemoryStore;
let metadata: MetadataResource;
let doc: DocumentResource;

beforeEach(() => {
  store = new MemoryStore();
  store.createLayer({
    id: 'l1',
    name: 'l1',
    visible: true,
    locked: false,
    opacity: 1,
    items: [],
    styleRule: undefined,
    metadata: undefined,
  });
  store.createFeature({
    id: 'a',
    type: 'Point',
    geometry: { type: 'Point', coordinates: [1, 2] },
    layerId: 'l1',
    groupId: undefined,
    properties: { name: 'A', 'maplibre-gl-draw:createdZoom': 10 },
    style: {},
    visible: true,
    locked: false,
  });
  const deps = createResourceDeps(store);
  metadata = createMetadata(deps);
  doc = createDocument(deps);
});

describe('draw.metadata', () => {
  it('changes the fields given and returns the metadata', () => {
    expect(metadata.update({ title: 'Map' })).toEqual({ title: 'Map' });
    expect(metadata.update({ description: 'About' })).toEqual({
      title: 'Map',
      description: 'About',
    });
    expect(metadata.get()).toEqual({ title: 'Map', description: 'About' });
  });

  it('throws invalid-input for a field of the wrong type, and refuses read-only', () => {
    expect(() => metadata.update({ title: 3 } as never)).toThrow(DrawError);
    store.setReadOnly(true);
    expect(metadata.update({ title: 'x' })).toBeNull();
    expect(metadata.get()).toEqual({});
  });
});

describe('draw.document', () => {
  const geojson = {
    type: 'FeatureCollection' as const,
    features: [
      {
        type: 'Feature' as const,
        properties: { name: 'B' },
        geometry: { type: 'Point' as const, coordinates: [3, 4] },
      },
    ],
  };

  it('writes the document of the library and GeoJSON', () => {
    const json = doc.toJSON();
    expect(json.features.map((f) => f.id)).toEqual(['a']);
    expect(json.layerOrder).toEqual(['l1']);
    const collection = doc.toGeoJSON();
    expect(collection.features[0].properties).toMatchObject({
      name: 'A',
      'maplibre-gl-draw:createdZoom': 10,
    });
  });

  it('adds GeoJSON by default and replaces with a document of the library', async () => {
    const added = await doc.load(geojson);
    expect(added?.format).toBe('geojson');
    expect(added?.replaced).toBe(false);
    expect(store.listFeatures()).toHaveLength(2);

    const saved = doc.toJSON();
    store.deleteFeature('a');
    const replaced = await doc.load(JSON.stringify(saved));
    expect(replaced).toMatchObject({ format: 'native', replaced: true });
    expect(store.listFeatures()).toHaveLength(2);
  });

  it('reads a feature, a geometry and a Blob, and replaces with GeoJSON when asked', async () => {
    await doc.load(geojson.features[0]);
    await doc.load({ type: 'Point', coordinates: [5, 6] });
    await doc.load(new Blob([JSON.stringify(geojson)], { type: 'application/json' }));
    expect(store.listFeatures()).toHaveLength(4);
    const result = await doc.load(geojson, { mode: 'replace' });
    expect(result?.replaced).toBe(true);
    expect(store.listFeatures()).toHaveLength(1);
  });

  it('rejects with the codes of the contract, changing nothing', async () => {
    await expect(doc.load('not json')).rejects.toMatchObject({ code: 'unsupported-format' });
    await expect(doc.load({ hello: 1 } as never)).rejects.toMatchObject({
      code: 'unsupported-format',
    });
    const broken = {
      version: '3.0.0',
      layerOrder: [],
      features: [
        {
          id: 'x',
          type: 'Point',
          geometry: { type: 'Point', coordinates: [0, 0] },
          layerId: 'nowhere',
        },
      ],
    };
    await expect(doc.load(broken as never)).rejects.toMatchObject({ code: 'invalid-input' });
    await expect(doc.load(geojson, { layerId: 'x' })).rejects.toMatchObject({ code: 'not-found' });
    expect(store.listFeatures().map((f) => f.id)).toEqual(['a']);
  });

  it('returns null while read-only', async () => {
    store.setReadOnly(true);
    expect(await doc.load(geojson)).toBeNull();
    expect(store.listFeatures()).toHaveLength(1);
  });
});
