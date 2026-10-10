// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for draw.metadata and draw.document
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { MemoryStore } from '../../store/memory.js';
import { createResourceDeps } from '../../test-utils.js';
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

  it('rejects every failure with a DrawError: a broken embedded image and an unreadable image', async () => {
    const brokenImage = {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          properties: {
            'maplibre-gl-draw:featureType': 'Image',
            'maplibre-gl-draw:imageData': 'data:image/png;base64,not-an-image',
            'maplibre-gl-draw:imageMimeType': 'image/png',
          },
          geometry: { type: 'Point', coordinates: [0, 0] },
        },
      ],
    };
    await expect(doc.load(brokenImage as never)).rejects.toMatchObject({
      name: 'DrawError',
      code: 'invalid-input',
    });
    const notAnImage = new File(['not an image'], 'x.png', { type: 'image/png' });
    await expect(doc.load(notAnImage, { coordinate: [0, 0] })).rejects.toMatchObject({
      name: 'DrawError',
      code: 'unsupported-format',
    });
    await expect(doc.load(notAnImage)).rejects.toMatchObject({
      name: 'DrawError',
      code: 'invalid-input',
    });
    expect(store.listFeatures().map((f) => f.id)).toEqual(['a']);
  });

  it('puts every feature into the layer given to the load, over the one the feature names', async () => {
    store.createLayer({
      id: 'l2',
      name: 'l2',
      visible: true,
      locked: false,
      opacity: 1,
      items: [],
      styleRule: undefined,
      metadata: undefined,
    });
    const named = {
      type: 'FeatureCollection' as const,
      features: [
        {
          type: 'Feature' as const,
          properties: { 'maplibre-gl-draw:layerId': 'l1', 'maplibre-gl-draw:groupId': 'nowhere' },
          geometry: { type: 'Point' as const, coordinates: [3, 4] },
        },
      ],
    };
    const into = await doc.load(named, { layerId: 'l2' });
    expect(store.getFeature(into?.featureIds[0] ?? '')?.layerId).toBe('l2');
    const own = await doc.load(named);
    expect(store.getFeature(own?.featureIds[0] ?? '')?.layerId).toBe('l1');
  });

  it('replaces the features and groups with GeoJSON in one transaction, keeping the layers', async () => {
    store.createFeature({
      id: 'b',
      type: 'Point',
      geometry: { type: 'Point', coordinates: [0, 0] },
      layerId: 'l1',
      groupId: undefined,
      properties: {},
      style: {},
      visible: true,
      locked: false,
    });
    store.createGroup({
      id: 'g',
      layerId: 'l1',
      name: 'g',
      featureIds: ['a', 'b'],
      visible: true,
      locked: false,
    });
    const notifications: Array<string | undefined> = [];
    store.subscribe((change) => notifications.push(change.source));
    // The file reuses the ID of a feature it replaces
    const file = {
      type: 'FeatureCollection' as const,
      features: [
        {
          type: 'Feature' as const,
          id: 'a',
          properties: { 'maplibre-gl-draw:groupId': 'g' },
          geometry: { type: 'Point' as const, coordinates: [5, 6] },
        },
      ],
    };
    const result = await doc.load(file, { mode: 'replace' });
    expect(result).toMatchObject({ format: 'geojson', featureIds: ['a'], replaced: true });
    expect(notifications).toEqual(['load']);
    expect(store.listFeatures().map((f) => [f.id, f.groupId])).toEqual([['a', undefined]]);
    expect(store.getFeature('a')?.geometry).toEqual({ type: 'Point', coordinates: [5, 6] });
    expect(store.listGroups()).toEqual([]);
    expect(store.listLayers().map((l) => l.id)).toEqual(['l1']);
    expect(store.getLayer('l1')?.items).toEqual(['a']);
  });

  it('loads a document of the library in one transaction', async () => {
    const saved = doc.toJSON();
    const notifications: Array<string | undefined> = [];
    store.subscribe((change) => notifications.push(change.source));
    await doc.load(saved);
    expect(notifications).toEqual(['load']);
  });

  it('returns null while read-only', async () => {
    store.setReadOnly(true);
    expect(await doc.load(geojson)).toBeNull();
    expect(store.listFeatures()).toHaveLength(1);
  });
});

describe('document.loadMany', () => {
  const point = (id: string, coordinates: number[]) => ({
    type: 'FeatureCollection' as const,
    features: [
      {
        type: 'Feature' as const,
        id,
        properties: {},
        geometry: { type: 'Point' as const, coordinates },
      },
    ],
  });

  it('writes a document of the library and two GeoJSON files in one notification', async () => {
    const saved = doc.toJSON();
    const notifications: Array<string | undefined> = [];
    store.subscribe((change) => notifications.push(change.source));
    const results = await doc.loadMany([
      { source: saved },
      { source: JSON.stringify(point('p', [3, 4])) },
      { source: point('q', [5, 6]), options: { layerId: 'l1' } },
    ]);
    expect(notifications).toEqual(['load']);
    expect(results?.map((result) => result.format)).toEqual(['native', 'geojson', 'geojson']);
    expect(store.listFeatures().map((feature) => feature.id)).toEqual(['a', 'p', 'q']);
  });

  it('writes nothing when one item cannot be read, and rejects with its DrawError', async () => {
    const notifications: unknown[] = [];
    store.subscribe((change) => notifications.push(change));
    const failure = doc.loadMany([{ source: point('p', [3, 4]) }, { source: 'not json' }]);
    await expect(failure).rejects.toBeInstanceOf(DrawError);
    await expect(failure).rejects.toMatchObject({ code: 'unsupported-format' });
    expect(notifications).toEqual([]);
    expect(store.listFeatures()).toHaveLength(1);
  });

  it('creates a layer per item and a group of one item in the transaction of the load', async () => {
    const notifications: Array<string | undefined> = [];
    store.subscribe((change) => notifications.push(change.source));
    const results = await doc.loadMany([
      { source: point('p', [3, 4]), options: { layer: { name: 'first' } } },
      {
        source: {
          type: 'FeatureCollection',
          features: [
            {
              type: 'Feature',
              id: 'q',
              properties: { 'maplibre-gl-draw:layerId': 'l1' },
              geometry: { type: 'Point', coordinates: [5, 6] },
            },
            {
              type: 'Feature',
              id: 'r',
              properties: {},
              geometry: { type: 'Point', coordinates: [7, 8] },
            },
          ],
        },
        options: { layer: { name: 'second' }, group: { name: 'folder' } },
      },
    ]);
    expect(notifications).toEqual(['load']);
    const [first, second] = results ?? [];
    expect(first).toMatchObject({ featureIds: ['p'], layerId: expect.any(String) });
    expect(first?.groupId).toBeUndefined();
    expect(second).toMatchObject({ featureIds: ['q', 'r'], layerId: expect.any(String) });
    const firstLayer = store.getLayer(first?.layerId ?? '');
    const secondLayer = store.getLayer(second?.layerId ?? '');
    expect(firstLayer).toMatchObject({ name: 'first', items: ['p'] });
    expect(store.getFeature('p')?.layerId).toBe(firstLayer?.id);
    // The group stands in the new layer where its features landed
    const group = store.getGroup(second?.groupId ?? '');
    expect(group).toMatchObject({
      name: 'folder',
      layerId: secondLayer?.id,
      featureIds: ['q', 'r'],
    });
    expect(secondLayer).toMatchObject({ name: 'second', items: [group?.id] });
    expect(store.getFeature('q')).toMatchObject({ layerId: secondLayer?.id, groupId: group?.id });
    expect(store.getLayerOrder()).toEqual(['l1', firstLayer?.id, secondLayer?.id]);
  });

  it('lets an item name with layerId the layer an earlier item creates', async () => {
    const notifications: Array<string | undefined> = [];
    store.subscribe((change) => notifications.push(change.source));
    const results = await doc.loadMany([
      { source: point('p', [3, 4]), options: { layer: { id: 'L', name: 'new' } } },
      { source: point('q', [5, 6]), options: { layerId: 'L', group: { name: 'folder' } } },
    ]);
    expect(notifications).toEqual(['load']);
    const group = store.getGroup(results?.[1]?.groupId ?? '');
    expect(group).toMatchObject({ name: 'folder', layerId: 'L', featureIds: ['q'] });
    expect(store.getFeature('q')).toMatchObject({ layerId: 'L', groupId: group?.id });
    expect(store.getLayer('L')?.items).toEqual(['p', group?.id]);
    // A layer no item creates is still not found, and nothing is written
    await expect(
      doc.loadMany([
        { source: point('r', [1, 1]), options: { layerId: 'M' } },
        { source: point('s', [1, 1]), options: { layer: { id: 'M' } } },
      ]),
    ).rejects.toMatchObject({ code: 'not-found' });
    expect(store.getLayer('M')).toBeUndefined();
  });

  it('refuses layer with layerId, and layer or group with a document of the library', async () => {
    const saved = doc.toJSON();
    const refused = [
      doc.load(point('p', [3, 4]), { layer: {}, layerId: 'l1' }),
      doc.load(saved, { layer: {} }),
      doc.load(saved, { group: {} }),
      doc.load(point('p', [3, 4]), { group: { featureIds: [] } as never }),
      doc.loadMany([
        { source: point('p', [3, 4]), options: { layer: { id: 'same' } } },
        { source: point('q', [3, 4]), options: { group: { id: 'same' } } },
      ]),
    ];
    for (const load of refused.slice(0, 4)) {
      await expect(load).rejects.toMatchObject({ code: 'invalid-input' });
    }
    await expect(refused[4]).rejects.toMatchObject({ code: 'already-exists' });
    expect(store.listLayers().map((layer) => layer.id)).toEqual(['l1']);
    expect(store.listFeatures().map((feature) => feature.id)).toEqual(['a']);
  });

  it('returns null while read-only, and refuses items that are not objects with a source', async () => {
    await expect(doc.loadMany([1] as never)).rejects.toMatchObject({ code: 'invalid-input' });
    await expect(doc.loadMany({} as never)).rejects.toMatchObject({ code: 'invalid-input' });
    store.setReadOnly(true);
    expect(await doc.loadMany([{ source: point('p', [3, 4]) }])).toBeNull();
    expect(store.listFeatures()).toHaveLength(1);
  });
});

describe('document.loadMany store contents', () => {
  /** A 10 by 10 PNG header, enough for the embedded image check (it is not scaled down) */
  const smallPng = (() => {
    const bytes = Buffer.alloc(24);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
    bytes.writeUInt32BE(13, 8);
    bytes.write('IHDR', 12, 'latin1');
    bytes.writeUInt32BE(10, 16);
    bytes.writeUInt32BE(10, 20);
    return `data:image/png;base64,${bytes.toString('base64')}`;
  })();

  const native = {
    version: '2.0.0',
    layers: [
      {
        id: 'n1',
        name: 'native',
        visible: true,
        locked: false,
        opacity: 1,
        items: ['g1', 'img'],
      },
    ],
    layerOrder: ['n1'],
    groups: [
      { id: 'g1', name: 'group', visible: true, locked: false, layerId: 'n1', featureIds: ['m'] },
    ],
    features: [
      {
        id: 'm',
        type: 'Point',
        geometry: { type: 'Point', coordinates: [1, 1] },
        layerId: 'n1',
        groupId: 'g1',
        properties: { name: 'M' },
        style: {},
        visible: true,
        locked: false,
      },
      {
        id: 'img',
        type: 'Image',
        geometry: { type: 'Point', coordinates: [2, 2] },
        layerId: 'n1',
        properties: { 'maplibre-gl-draw:imageFileId': 'f1' },
        style: {},
        visible: true,
        locked: false,
      },
    ],
    files: { f1: { id: 'f1', mimeType: 'image/png', dataURL: smallPng } },
  };

  const geojson = {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        id: 'm',
        properties: {},
        geometry: { type: 'Point', coordinates: [3, 3] },
      },
      {
        type: 'Feature',
        id: 7,
        properties: { 'maplibre-gl-draw:groupId': 'g1', 'maplibre-gl-draw:layerId': 'n1' },
        geometry: { type: 'Point', coordinates: [4, 4] },
      },
      {
        type: 'Feature',
        properties: { kind: 'multi' },
        geometry: {
          type: 'MultiPoint',
          coordinates: [
            [5, 5],
            [6, 6],
          ],
        },
      },
      {
        type: 'Feature',
        properties: {},
        geometry: {
          type: 'GeometryCollection',
          geometries: [
            { type: 'Point', coordinates: [7, 7] },
            {
              type: 'LineString',
              coordinates: [
                [0, 0],
                [1, 1],
              ],
            },
          ],
        },
      },
      { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [] } },
      {
        type: 'Feature',
        properties: {
          'maplibre-gl-draw:featureType': 'Image',
          'maplibre-gl-draw:imageData': smallPng,
          'maplibre-gl-draw:imageMimeType': 'image/png',
          'maplibre-gl-draw:imageFileId': 'old',
        },
        geometry: { type: 'Point', coordinates: [8, 8] },
      },
    ],
  };

  it('writes the same features, groups, layers and files as before', async () => {
    const source = geojson as never;
    const first = await doc.load(native as never);
    const results = await doc.loadMany([
      { source },
      { source, options: { flattenMulti: true, layer: { name: 'new' } } },
      { source, options: { layerId: 'n1', group: { name: 'folder' } } },
    ]);
    // The generated ids are written as their order of appearance, so that the contents compare
    // whatever the order in which the ids were taken
    const generated = new Map<string, string>();
    const contents = JSON.stringify(
      {
        results: [first, ...(results ?? [])],
        layers: store.listLayers(),
        layerOrder: store.getLayerOrder(),
        groups: store.listGroups(),
        features: store.listFeatures(),
        files: store.listFiles(),
      },
      (_key, value: unknown) => {
        if (typeof value !== 'string' || !/^(id-\d+|[0-9A-HJKMNP-TV-Z]{26})$/.test(value)) {
          return value;
        }
        if (!generated.has(value)) generated.set(value, `#${generated.size + 1}`);
        return generated.get(value);
      },
      1,
    );
    expect(contents).toMatchInlineSnapshot(`
      "{
       "results": [
        {
         "format": "native",
         "featureIds": [
          "m",
          "img"
         ],
         "replaced": true
        },
        {
         "format": "geojson",
         "featureIds": [
          "#1",
          "7",
          "#2",
          "#3",
          "#4",
          "#5"
         ],
         "replaced": false,
         "skipped": [
          {
           "index": 4,
           "reason": "the Point has malformed coordinates"
          }
         ]
        },
        {
         "format": "geojson",
         "featureIds": [
          "#6",
          "#7",
          "#8",
          "#9",
          "#10",
          "#11",
          "#12"
         ],
         "replaced": false,
         "skipped": [
          {
           "index": 4,
           "reason": "the Point has malformed coordinates"
          }
         ],
         "layerId": "#13"
        },
        {
         "format": "geojson",
         "featureIds": [
          "#14",
          "#15",
          "#16",
          "#17",
          "#18",
          "#19"
         ],
         "replaced": false,
         "skipped": [
          {
           "index": 4,
           "reason": "the Point has malformed coordinates"
          }
         ],
         "groupId": "#20"
        }
       ],
       "layers": [
        {
         "id": "n1",
         "name": "native",
         "visible": true,
         "locked": false,
         "opacity": 1,
         "items": [
          "g1",
          "img",
          "#1",
          "#2",
          "#3",
          "#4",
          "#5",
          "#20"
         ]
        },
        {
         "id": "#13",
         "name": "new",
         "visible": true,
         "locked": false,
         "opacity": 1,
         "items": [
          "#6",
          "#7",
          "#8",
          "#9",
          "#10",
          "#11",
          "#12"
         ]
        }
       ],
       "layerOrder": [
        "n1",
        "#13"
       ],
       "groups": [
        {
         "id": "g1",
         "name": "group",
         "visible": true,
         "locked": false,
         "layerId": "n1",
         "featureIds": [
          "m",
          "7"
         ]
        },
        {
         "id": "#20",
         "name": "folder",
         "visible": true,
         "locked": false,
         "layerId": "n1",
         "featureIds": [
          "#14",
          "#15",
          "#16",
          "#17",
          "#18",
          "#19"
         ]
        }
       ],
       "features": [
        {
         "id": "m",
         "type": "Point",
         "geometry": {
          "type": "Point",
          "coordinates": [
           1,
           1
          ]
         },
         "layerId": "n1",
         "groupId": "g1",
         "properties": {
          "name": "M"
         },
         "style": {},
         "visible": true,
         "locked": false
        },
        {
         "id": "img",
         "type": "Image",
         "geometry": {
          "type": "Point",
          "coordinates": [
           2,
           2
          ]
         },
         "layerId": "n1",
         "properties": {
          "maplibre-gl-draw:imageFileId": "f1"
         },
         "style": {},
         "visible": true,
         "locked": false
        },
        {
         "id": "#1",
         "layerId": "n1",
         "properties": {
          "name": "Point 1"
         },
         "style": {},
         "locked": false,
         "visible": true,
         "type": "Point",
         "geometry": {
          "type": "Point",
          "coordinates": [
           3,
           3
          ]
         }
        },
        {
         "id": "7",
         "layerId": "n1",
         "groupId": "g1",
         "properties": {
          "name": "Point 2"
         },
         "style": {},
         "locked": false,
         "visible": true,
         "type": "Point",
         "geometry": {
          "type": "Point",
          "coordinates": [
           4,
           4
          ]
         }
        },
        {
         "id": "#2",
         "layerId": "n1",
         "properties": {
          "kind": "multi",
          "name": "MultiPoint 1"
         },
         "style": {},
         "locked": false,
         "visible": true,
         "type": "MultiPoint",
         "geometry": {
          "type": "MultiPoint",
          "coordinates": [
           [
            5,
            5
           ],
           [
            6,
            6
           ]
          ]
         }
        },
        {
         "id": "#3",
         "layerId": "n1",
         "properties": {
          "name": "MultiPoint 2"
         },
         "style": {},
         "locked": false,
         "visible": true,
         "type": "MultiPoint",
         "geometry": {
          "type": "MultiPoint",
          "coordinates": [
           [
            7,
            7
           ]
          ]
         }
        },
        {
         "id": "#4",
         "layerId": "n1",
         "properties": {
          "name": "MultiLineString 1"
         },
         "style": {},
         "locked": false,
         "visible": true,
         "type": "MultiLineString",
         "geometry": {
          "type": "MultiLineString",
          "coordinates": [
           [
            [
             0,
             0
            ],
            [
             1,
             1
            ]
           ]
          ]
         }
        },
        {
         "id": "#5",
         "layerId": "n1",
         "properties": {
          "maplibre-gl-draw:imageFileId": "#21",
          "name": "Image 1"
         },
         "style": {},
         "locked": false,
         "visible": true,
         "type": "Image",
         "geometry": {
          "type": "Point",
          "coordinates": [
           8,
           8
          ]
         }
        },
        {
         "id": "#6",
         "layerId": "#13",
         "properties": {
          "name": "Point 3"
         },
         "style": {},
         "locked": false,
         "visible": true,
         "type": "Point",
         "geometry": {
          "type": "Point",
          "coordinates": [
           3,
           3
          ]
         }
        },
        {
         "id": "#7",
         "layerId": "#13",
         "properties": {
          "name": "Point 4"
         },
         "style": {},
         "locked": false,
         "visible": true,
         "type": "Point",
         "geometry": {
          "type": "Point",
          "coordinates": [
           4,
           4
          ]
         }
        },
        {
         "id": "#8",
         "layerId": "#13",
         "properties": {
          "kind": "multi",
          "name": "Point 5"
         },
         "style": {},
         "locked": false,
         "visible": true,
         "type": "Point",
         "geometry": {
          "type": "Point",
          "coordinates": [
           5,
           5
          ]
         }
        },
        {
         "id": "#9",
         "layerId": "#13",
         "properties": {
          "kind": "multi",
          "name": "Point 6"
         },
         "style": {},
         "locked": false,
         "visible": true,
         "type": "Point",
         "geometry": {
          "type": "Point",
          "coordinates": [
           6,
           6
          ]
         }
        },
        {
         "id": "#10",
         "layerId": "#13",
         "properties": {
          "name": "MultiPoint 3"
         },
         "style": {},
         "locked": false,
         "visible": true,
         "type": "MultiPoint",
         "geometry": {
          "type": "MultiPoint",
          "coordinates": [
           [
            7,
            7
           ]
          ]
         }
        },
        {
         "id": "#11",
         "layerId": "#13",
         "properties": {
          "name": "MultiLineString 2"
         },
         "style": {},
         "locked": false,
         "visible": true,
         "type": "MultiLineString",
         "geometry": {
          "type": "MultiLineString",
          "coordinates": [
           [
            [
             0,
             0
            ],
            [
             1,
             1
            ]
           ]
          ]
         }
        },
        {
         "id": "#12",
         "layerId": "#13",
         "properties": {
          "maplibre-gl-draw:imageFileId": "#22",
          "name": "Image 2"
         },
         "style": {},
         "locked": false,
         "visible": true,
         "type": "Image",
         "geometry": {
          "type": "Point",
          "coordinates": [
           8,
           8
          ]
         }
        },
        {
         "id": "#14",
         "layerId": "n1",
         "properties": {
          "name": "Point 7"
         },
         "style": {},
         "locked": false,
         "visible": true,
         "type": "Point",
         "geometry": {
          "type": "Point",
          "coordinates": [
           3,
           3
          ]
         },
         "groupId": "#20"
        },
        {
         "id": "#15",
         "layerId": "n1",
         "properties": {
          "name": "Point 8"
         },
         "style": {},
         "locked": false,
         "visible": true,
         "type": "Point",
         "geometry": {
          "type": "Point",
          "coordinates": [
           4,
           4
          ]
         },
         "groupId": "#20"
        },
        {
         "id": "#16",
         "layerId": "n1",
         "properties": {
          "kind": "multi",
          "name": "MultiPoint 4"
         },
         "style": {},
         "locked": false,
         "visible": true,
         "type": "MultiPoint",
         "geometry": {
          "type": "MultiPoint",
          "coordinates": [
           [
            5,
            5
           ],
           [
            6,
            6
           ]
          ]
         },
         "groupId": "#20"
        },
        {
         "id": "#17",
         "layerId": "n1",
         "properties": {
          "name": "MultiPoint 5"
         },
         "style": {},
         "locked": false,
         "visible": true,
         "type": "MultiPoint",
         "geometry": {
          "type": "MultiPoint",
          "coordinates": [
           [
            7,
            7
           ]
          ]
         },
         "groupId": "#20"
        },
        {
         "id": "#18",
         "layerId": "n1",
         "properties": {
          "name": "MultiLineString 3"
         },
         "style": {},
         "locked": false,
         "visible": true,
         "type": "MultiLineString",
         "geometry": {
          "type": "MultiLineString",
          "coordinates": [
           [
            [
             0,
             0
            ],
            [
             1,
             1
            ]
           ]
          ]
         },
         "groupId": "#20"
        },
        {
         "id": "#19",
         "layerId": "n1",
         "properties": {
          "maplibre-gl-draw:imageFileId": "#23",
          "name": "Image 3"
         },
         "style": {},
         "locked": false,
         "visible": true,
         "type": "Image",
         "geometry": {
          "type": "Point",
          "coordinates": [
           8,
           8
          ]
         },
         "groupId": "#20"
        }
       ],
       "files": [
        {
         "id": "f1",
         "mimeType": "image/png",
         "dataURL": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAoAAAAK"
        },
        {
         "id": "#21",
         "mimeType": "image/png",
         "dataURL": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAoAAAAK"
        },
        {
         "id": "#22",
         "mimeType": "image/png",
         "dataURL": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAoAAAAK"
        },
        {
         "id": "#23",
         "mimeType": "image/png",
         "dataURL": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAoAAAAK"
        }
       ]
      }"
    `);
  });
});
