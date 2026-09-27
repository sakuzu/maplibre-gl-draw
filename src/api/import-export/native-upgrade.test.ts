// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for the upgrade of native data of an earlier major version
 */

import { describe, expect, it } from 'vitest';
import { MemoryStore } from '../../store/memory.js';
import type { Data } from '../../store/types.js';
import type { Context } from '../context.js';
import { NATIVE_VERSION } from './constants.js';
import { createImportExportAPI } from './index.js';
import { upgradeNativeData } from './native-upgrade.js';

/** Upgrades the data and reads it as data of the current version */
const upgrade = (data: unknown): Data => upgradeNativeData(data) as Data;

/** A layer of version 2 */
function layer2(id: string, order: string[]) {
  return { id, name: id, visible: true, locked: false, opacity: 1, order };
}

/** A feature of version 2 */
function feature2(
  id: string,
  type: string,
  coordinates: unknown,
  properties: Record<string, unknown> = {},
  extra: Record<string, unknown> = {},
) {
  return {
    id,
    type,
    coordinates,
    layerId: 'l1',
    properties,
    locked: false,
    visible: true,
    ...extra,
  };
}

const RING = [
  [0, 0],
  [1, 0],
  [1, 1],
  [0, 0],
];

/** A document of version 2 with every built-in type, a custom type, a group and an image */
function document2() {
  return {
    version: '2.0.0',
    metadata: { title: 'Old' },
    layerOrder: ['l1', 'l2'],
    layers: [
      layer2('l1', ['p', 'c', 'i', 'line', 'fh', 'poly', 'mp', 'arrow', 'g1']),
      layer2('l2', []),
    ],
    groups: [{ id: 'g1', name: 'G', featureIds: ['m1'], locked: false, visible: true }],
    features: [
      feature2('p', 'Point', [1, 2], { createdZoom: 12, name: 'A point' }),
      feature2('c', 'Circle', [3, 4], { radiusMeters: 100, radiusHandleAngle: 45 }),
      feature2('i', 'Image', [5, 6], {
        imageFileId: 'file-1',
        imageWidth: 1,
        imageHeight: 1,
        createdZoom: 10,
        rotation: 30,
        scale: 2,
      }),
      feature2('line', 'LineString', [
        [0, 0],
        [1, 1],
      ]),
      feature2('fh', 'Freehand', [
        [0, 0],
        [1, 1],
        [2, 0],
      ]),
      feature2('poly', 'Polygon', [RING]),
      feature2('mp', 'MultiPolygon', [[RING], [RING]]),
      feature2('arrow', 'Arrow', [
        [0, 0],
        [2, 2],
      ]),
      feature2('m1', 'Point', [7, 8], {}, { groupId: 'g1' }),
    ],
    files: {
      'file-1': {
        id: 'file-1',
        mimeType: 'image/png',
        dataURL:
          'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
      },
    },
  };
}

function createTestContext(): Context {
  const store = new MemoryStore();
  store.createLayer({
    id: 'default-layer',
    name: 'Layer 1',
    visible: true,
    locked: false,
    opacity: 1,
    items: [],
  });
  let idCounter = 0;
  return {
    store,
    generateFeatureId: () => `feature-${++idCounter}`,
    getCurrentLayerId: () => 'default-layer',
    autoNameGenerator: { generateName: () => undefined },
  } as unknown as Context;
}

describe('upgradeNativeData', () => {
  it('brings data of version 2 to the version this library writes', () => {
    const data = upgrade(document2());

    expect(data.version).toBe('3.0.0');
    expect(NATIVE_VERSION).toBe('3.0.0');
    expect(data.metadata).toEqual({ title: 'Old' });
    expect(data.layerOrder).toEqual(['l1', 'l2']);
  });

  it('turns the coordinates of each type into the geometry of its kind', () => {
    const { features } = upgrade(document2());
    const geometryOf = (id: string) => features.find((f) => f.id === id)?.geometry;

    expect(geometryOf('p')).toEqual({ type: 'Point', coordinates: [1, 2] });
    expect(geometryOf('c')).toEqual({ type: 'Point', coordinates: [3, 4] });
    expect(geometryOf('i')).toEqual({ type: 'Point', coordinates: [5, 6] });
    expect(geometryOf('line')).toEqual({
      type: 'LineString',
      coordinates: [
        [0, 0],
        [1, 1],
      ],
    });
    expect(geometryOf('fh')?.type).toBe('LineString');
    expect(geometryOf('poly')).toEqual({ type: 'Polygon', coordinates: [RING] });
    expect(geometryOf('mp')).toEqual({ type: 'MultiPolygon', coordinates: [[RING], [RING]] });
    // A custom type takes the kind of the nesting of its coordinates
    expect(geometryOf('arrow')?.type).toBe('LineString');
    for (const feature of features) expect(feature).not.toHaveProperty('coordinates');
  });

  it('puts the values of the library under the prefix and leaves the attributes alone', () => {
    const { features } = upgrade(document2());
    const propertiesOf = (id: string) => features.find((f) => f.id === id)?.properties;

    expect(propertiesOf('p')).toEqual({
      'maplibre-gl-draw:createdZoom': 12,
      name: 'A point',
    });
    expect(propertiesOf('c')).toEqual({
      'maplibre-gl-draw:radiusMeters': 100,
      'maplibre-gl-draw:radiusHandleAngle': 45,
    });
    expect(propertiesOf('i')).toEqual({
      'maplibre-gl-draw:imageFileId': 'file-1',
      'maplibre-gl-draw:imageWidth': 1,
      'maplibre-gl-draw:imageHeight': 1,
      'maplibre-gl-draw:createdZoom': 10,
      'maplibre-gl-draw:rotation': 30,
      'maplibre-gl-draw:scale': 2,
    });
  });

  it('keeps a prefixed value that is already there over the plain one', () => {
    const data = document2();
    data.features[0].properties = {
      createdZoom: 3,
      'maplibre-gl-draw:createdZoom': 12,
    };

    const { features } = upgrade(data);

    expect(features[0].properties).toEqual({
      createdZoom: 3,
      'maplibre-gl-draw:createdZoom': 12,
    });
  });

  it('renames the order of a layer to items', () => {
    const { layers } = upgrade(document2());

    expect(layers?.[0].items).toEqual(['p', 'c', 'i', 'line', 'fh', 'poly', 'mp', 'arrow', 'g1']);
    expect(layers?.[1].items).toEqual([]);
    expect(layers?.[0]).not.toHaveProperty('order');
  });

  it('gives a group the layer that lists it, else the layer of its first member', () => {
    const data = document2();
    data.layers[0].order = data.layers[0].order.filter((id) => id !== 'g1');
    data.groups.push(
      { id: 'g2', name: 'G2', featureIds: [], locked: false, visible: true },
      { id: 'g3', name: 'G3', featureIds: ['m1'], locked: false, visible: true },
    );
    data.layers[1].order = ['g2'];

    const { groups } = upgrade(data);

    expect(groups?.map((g) => [g.id, g.layerId])).toEqual([
      ['g1', 'l1'],
      ['g2', 'l2'],
      ['g3', 'l1'],
    ]);
  });

  it('returns data of the current version as it is', () => {
    const data = { version: NATIVE_VERSION, layerOrder: [], features: [] };

    expect(upgradeNativeData(data)).toBe(data);
  });

  it('leaves data of a version without an upgrade as it is', () => {
    const one = { ...document2(), version: '1.2.0' };
    const later = { ...document2(), version: '4.0.0' };

    expect(upgradeNativeData(one)).toBe(one);
    expect(upgradeNativeData(later)).toBe(later);
  });
});

describe('loading native data of version 2', () => {
  it('loads it into the model of the current version', async () => {
    const context = createTestContext();
    const api = createImportExportAPI(context);

    const result = await api.load(document2());

    const { store } = context;
    expect(result.format).toBe('native');
    expect(store.getFeature('c')).toMatchObject({
      type: 'Circle',
      geometry: { type: 'Point', coordinates: [3, 4] },
      properties: {
        'maplibre-gl-draw:radiusMeters': 100,
        'maplibre-gl-draw:radiusHandleAngle': 45,
      },
      style: {},
    });
    expect(store.getLayer('l1')?.items).toEqual([
      'p',
      'c',
      'i',
      'line',
      'fh',
      'poly',
      'mp',
      'arrow',
      'g1',
    ]);
    expect(store.getGroup('g1')?.layerId).toBe('l1');
    expect(store.getFeature('m1')?.groupId).toBe('g1');
    expect(store.getFile('file-1')).toBeDefined();
  });

  it('exports it again in the current version', async () => {
    const context = createTestContext();
    const api = createImportExportAPI(context);
    await api.load(document2());

    const exported = JSON.parse(api.export('native').data);

    expect(exported.version).toBe(NATIVE_VERSION);
    const point = exported.features.find((f: { id: string }) => f.id === 'p');
    expect(point.geometry).toEqual({ type: 'Point', coordinates: [1, 2] });
    expect(point.properties).toEqual({ 'maplibre-gl-draw:createdZoom': 12, name: 'A point' });
    expect(exported.layers[0]).not.toHaveProperty('order');
    expect(exported.groups[0].layerId).toBe('l1');
    // The exported data loads again as it is
    const again = createTestContext();
    await createImportExportAPI(again).load(exported);
    expect(again.store.getFeature('p')?.geometry).toEqual({ type: 'Point', coordinates: [1, 2] });
  });

  it('rejects data of version 2 with coordinates that do not match the type', async () => {
    const context = createTestContext();
    const api = createImportExportAPI(context);
    const data = document2();
    data.features[5] = feature2('poly', 'Polygon', [
      [0, 0],
      [1, 1],
    ]);

    await expect(api.load(data)).rejects.toThrow('Invalid native data');
  });

  it('still rejects data of version 1', async () => {
    const context = createTestContext();
    const api = createImportExportAPI(context);

    await expect(api.load({ ...document2(), version: '1.0.0' })).rejects.toThrow(/version 1\.0\.0/);
  });
});
