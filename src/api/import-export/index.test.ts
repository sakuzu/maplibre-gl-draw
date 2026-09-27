// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for the Import/Export API
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { normalizeMultiPolygonOrientation } from '../../geometry/simplify.js';
import type { FeatureCoordinates } from '../../shared/types/model.js';
import { coordinatesOf, geometryFromCoordinates } from '../../shared/utils/coordinates.js';
import { MemoryStore } from '../../store/memory.js';
import type { Feature, Group, Layer, StyleRule } from '../../store/types.js';
import type { Context } from '../context.js';
import { NATIVE_VERSION } from './constants.js';
import { createImportExportAPI } from './index.js';

// Test helpers

/** A 1x1 transparent PNG */
const PNG_1X1 =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

function createTestLayer(overrides?: Partial<Layer>): Layer {
  return {
    id: 'default-layer',
    name: 'Layer 1',
    visible: true,
    locked: false,
    opacity: 1.0,
    items: [],
    ...overrides,
  };
}

function createTestFeature(id: string, overrides?: Partial<Feature>): Feature {
  return {
    id,
    type: 'Point',
    geometry: { type: 'Point', coordinates: [139.7, 35.6] as [number, number] },
    layerId: 'default-layer',
    properties: {},
    locked: false,
    visible: true,
    style: {},
    ...overrides,
  };
}

function createTestContext(): Context {
  const store = new MemoryStore();

  // Create the default layer
  store.createLayer(createTestLayer());

  let idCounter = 0;

  return {
    store,
    generateFeatureId: () => {
      idCounter++;
      return `feature-${idCounter}`;
    },
    getCurrentLayerId: () => 'default-layer',
    autoNameGenerator: {
      generateName: () => undefined,
    },
  } as unknown as Context;
}

describe('createImportExportAPI', () => {
  let context: Context;

  beforeEach(() => {
    context = createTestContext();
  });

  describe('export("native")', () => {
    it('returns a valid structure even for an empty store', () => {
      const api = createImportExportAPI(context);
      const result = api.export('native');

      expect(result.format).toBe('native');
      expect(result.mimeType).toBe('application/json');
      expect(result.fileName).toMatch(/\.maplibre-gl-draw\.json$/);

      const data = JSON.parse(result.data);
      expect(data.version).toBe(NATIVE_VERSION);
      expect(data.features).toEqual([]);
      expect(data.layers).toBeInstanceOf(Array);
    });

    it('includes every feature the store has', () => {
      const api = createImportExportAPI(context);
      const f1 = createTestFeature('f1');
      const f2 = createTestFeature('f2', {
        geometry: { type: 'Point', coordinates: [140, 36] as [number, number] },
      });
      context.store.createFeature(f1);
      context.store.createFeature(f2);

      const result = api.export('native');
      const data = JSON.parse(result.data);

      expect(data.features).toHaveLength(2);
      const ids = data.features.map((f: Feature) => f.id);
      expect(ids).toContain('f1');
      expect(ids).toContain('f2');
    });

    it('can be filtered with the featureIds option', () => {
      const api = createImportExportAPI(context);
      context.store.createFeature(createTestFeature('f1'));
      context.store.createFeature(createTestFeature('f2'));
      context.store.createFeature(createTestFeature('f3'));

      const result = api.export('native', { featureIds: ['f1', 'f3'] });
      const data = JSON.parse(result.data);

      expect(data.features).toHaveLength(2);
      const ids = data.features.map((f: Feature) => f.id);
      expect(ids).toContain('f1');
      expect(ids).toContain('f3');
      expect(ids).not.toContain('f2');
    });

    it('can be filtered with the layerIds option', () => {
      const api = createImportExportAPI(context);
      context.store.createLayer(createTestLayer({ id: 'layer-2', name: 'Layer 2' }));
      context.store.createFeature(createTestFeature('f1', { layerId: 'default-layer' }));
      context.store.createFeature(createTestFeature('f2', { layerId: 'layer-2' }));
      context.store.createFeature(createTestFeature('f3', { layerId: 'default-layer' }));

      const result = api.export('native', { layerIds: ['layer-2'] });
      const data = JSON.parse(result.data);

      expect(data.features).toHaveLength(1);
      expect(data.features[0].id).toBe('f2');
    });
  });

  describe('export("geojson")', () => {
    it('returns a GeoJSON FeatureCollection', () => {
      const api = createImportExportAPI(context);
      const result = api.export('geojson');

      expect(result.format).toBe('geojson');
      expect(result.mimeType).toBe('application/geo+json');
      expect(result.fileName).toMatch(/\.geojson$/);

      const data = JSON.parse(result.data);
      expect(data.type).toBe('FeatureCollection');
      expect(data.features).toBeInstanceOf(Array);
    });

    it('exports a Point as a Point geometry', () => {
      const api = createImportExportAPI(context);
      context.store.createFeature(
        createTestFeature('m1', {
          type: 'Point',
          geometry: { type: 'Point', coordinates: [139.7, 35.6] },
          properties: { name: 'Test Point' },
        }),
      );

      const result = api.export('geojson');
      const data = JSON.parse(result.data);

      expect(data.features).toHaveLength(1);
      const geoFeature = data.features[0];
      expect(geoFeature.geometry.type).toBe('Point');
      expect(geoFeature.geometry.coordinates).toEqual([139.7, 35.6]);
      expect(geoFeature.properties['maplibre-gl-draw:id']).toBe('m1');
      expect(geoFeature.properties.name).toBe('Test Point');
    });

    it('exports a LineString as a LineString geometry', () => {
      const api = createImportExportAPI(context);
      const coords: [number, number][] = [
        [139.7, 35.6],
        [139.8, 35.7],
      ];
      context.store.createFeature(
        createTestFeature('l1', {
          type: 'LineString',
          geometry: { type: 'LineString', coordinates: coords },
        }),
      );

      const result = api.export('geojson');
      const data = JSON.parse(result.data);

      expect(data.features).toHaveLength(1);
      expect(data.features[0].geometry.type).toBe('LineString');
      expect(data.features[0].geometry.coordinates).toEqual(coords);
    });

    it('exports a Polygon as a Polygon geometry', () => {
      const api = createImportExportAPI(context);
      const coords: [number, number][][] = [
        [
          [139.7, 35.6],
          [139.8, 35.6],
          [139.8, 35.7],
          [139.7, 35.7],
          [139.7, 35.6],
        ],
      ];
      context.store.createFeature(
        createTestFeature('p1', {
          type: 'Polygon',
          geometry: { type: 'Polygon', coordinates: coords },
        }),
      );

      const result = api.export('geojson');
      const data = JSON.parse(result.data);

      expect(data.features).toHaveLength(1);
      expect(data.features[0].geometry.type).toBe('Polygon');
      expect(data.features[0].geometry.coordinates).toEqual(coords);
    });

    it('writes name and description as plain keys and prefixes the metadata', () => {
      const api = createImportExportAPI(context);
      context.store.createFeature(
        createTestFeature('m1', {
          properties: { name: 'MyPoint', description: 'A test', customProp: 'value' },
          style: { pointColor: '#ff0000' },
        }),
      );

      const result = api.export('geojson');
      const data = JSON.parse(result.data);
      const props = data.features[0].properties;

      // The name and the description are the plain keys other GIS tools read
      expect(props.name).toBe('MyPoint');
      expect(props.description).toBe('A test');
      expect(props['maplibre-gl-draw:name']).toBeUndefined();
      expect(props['maplibre-gl-draw:description']).toBeUndefined();
      // User-defined properties do not get the prefix
      expect(props.customProp).toBe('value');
      // The metadata gets the prefix as well
      expect(props['maplibre-gl-draw:id']).toBe('m1');
      expect(props['maplibre-gl-draw:layerId']).toBe('default-layer');
      expect(props['maplibre-gl-draw:style']).toEqual({ pointColor: '#ff0000' });
    });

    it('writes the properties an extension keeps as plain keys and reads them back', async () => {
      const api = createImportExportAPI(context);
      const properties = { caption: 'Gate', boxWidth: 120, boxHeight: 40 };
      context.store.createFeature(createTestFeature('t1', { properties }));

      const doc = JSON.parse(api.export('geojson').data);
      const props = doc.features[0].properties;
      expect(props).toMatchObject(properties);
      expect(Object.keys(props).filter((key) => key.includes('box'))).toEqual([
        'boxWidth',
        'boxHeight',
      ]);

      const other = createTestContext();
      await createImportExportAPI(other).load(doc);
      expect(other.store.getFeature('t1')?.properties).toEqual(properties);
    });
  });

  describe('load (native format)', () => {
    it('loads native data and replaces the existing features', async () => {
      const api = createImportExportAPI(context);

      // Add an existing feature
      context.store.createFeature(createTestFeature('existing-1'));

      const nativeData = {
        version: NATIVE_VERSION,
        features: [
          createTestFeature('imported-1'),
          createTestFeature('imported-2', {
            geometry: { type: 'Point', coordinates: [140, 36] as [number, number] },
          }),
        ],
        layers: [createTestLayer()],
        layerOrder: ['default-layer'],
      };

      const result = await api.load(nativeData);

      expect(result.format).toBe('native');
      expect(result.featureIds).toEqual(['imported-1', 'imported-2']);
      expect(result.replaced).toBe(true);

      // The existing feature has been deleted
      expect(context.store.getFeature('existing-1')).toBeUndefined();
      // The imported feature is present
      expect(context.store.getFeature('imported-1')).toBeDefined();
      expect(context.store.getFeature('imported-2')).toBeDefined();
    });

    it('creates the layers and groups from the data', async () => {
      const api = createImportExportAPI(context);

      const group: Group = {
        id: 'group-1',
        layerId: 'default-layer',
        name: 'Test Group',
        featureIds: ['f1', 'f2'],
        locked: false,
        visible: true,
      };

      const nativeData = {
        version: NATIVE_VERSION,
        features: [
          createTestFeature('f1', { groupId: 'group-1' }),
          createTestFeature('f2', { groupId: 'group-1' }),
        ],
        layers: [
          createTestLayer({ id: 'default-layer', name: 'Layer 1' }),
          createTestLayer({ id: 'custom-layer', name: 'Custom Layer' }),
        ],
        layerOrder: ['default-layer', 'custom-layer'],
        groups: [group],
      };

      const result = await api.load(nativeData);

      expect(result.format).toBe('native');
      expect(context.store.getLayer('custom-layer')).toBeDefined();
      expect(context.store.getGroup('group-1')).toBeDefined();
      expect(context.store.getGroup('group-1')?.featureIds).toEqual(['f1', 'f2']);
    });

    it('returns format="native" and featureIds', async () => {
      const api = createImportExportAPI(context);

      const nativeData = {
        version: NATIVE_VERSION,
        features: [createTestFeature('a'), createTestFeature('b')],
        layers: [createTestLayer()],
        layerOrder: ['default-layer'],
      };

      const result = await api.load(nativeData);

      expect(result.format).toBe('native');
      expect(result.featureIds).toEqual(['a', 'b']);
    });
  });

  describe('load (GeoJSON)', () => {
    it('loads a GeoJSON FeatureCollection and adds the features', async () => {
      const api = createImportExportAPI(context);

      // The existing feature
      context.store.createFeature(createTestFeature('existing-1'));

      const geojson = {
        type: 'FeatureCollection' as const,
        features: [
          {
            type: 'Feature' as const,
            geometry: { type: 'Point' as const, coordinates: [139.7, 35.6] },
            properties: {},
          },
        ],
      };

      const result = await api.load(geojson);

      expect(result.format).toBe('geojson');
      expect(result.replaced).toBe(false);
      expect(result.featureIds).toHaveLength(1);

      // The existing feature remains
      expect(context.store.getFeature('existing-1')).toBeDefined();
      // The new feature has been added as well
      const newFeature = context.store.getFeature(result.featureIds[0]);
      expect(newFeature).toBeDefined();
      expect(newFeature?.type).toBe('Point');
    });

    it('flattens a MultiPoint into individual Points with flattenMulti:true', async () => {
      const api = createImportExportAPI(context);

      const geojson = {
        type: 'FeatureCollection' as const,
        features: [
          {
            type: 'Feature' as const,
            geometry: {
              type: 'MultiPoint' as const,
              coordinates: [
                [139.7, 35.6],
                [139.8, 35.7],
                [139.9, 35.8],
              ],
            },
            properties: {},
          },
        ],
      };

      const result = await api.load(geojson, { flattenMulti: true });

      expect(result.format).toBe('geojson');
      expect(result.featureIds).toHaveLength(3);

      // Each feature is of type Point and has its own coordinates
      for (const fid of result.featureIds) {
        const feature = context.store.getFeature(fid);
        expect(feature).toBeDefined();
        expect(feature?.type).toBe('Point');
      }
    });

    it('returns format="geojson" and featureIds', async () => {
      const api = createImportExportAPI(context);

      const geojson = {
        type: 'FeatureCollection' as const,
        features: [
          {
            type: 'Feature' as const,
            geometry: { type: 'Point' as const, coordinates: [0, 0] },
            properties: {},
          },
          {
            type: 'Feature' as const,
            geometry: {
              type: 'LineString' as const,
              coordinates: [
                [0, 0],
                [1, 1],
              ],
            },
            properties: {},
          },
        ],
      };

      const result = await api.load(geojson);

      expect(result.format).toBe('geojson');
      expect(result.featureIds).toHaveLength(2);

      const f1 = context.store.getFeature(result.featureIds[0]);
      const f2 = context.store.getFeature(result.featureIds[1]);
      expect(f1?.type).toBe('Point');
      expect(f2?.type).toBe('LineString');
    });

    it('preserves visible/locked/groupId across a GeoJSON round trip', async () => {
      const api = createImportExportAPI(context);
      const group: Group = {
        id: 'g1',
        layerId: 'default-layer',
        name: 'Group',
        featureIds: [],
        locked: false,
        visible: true,
      };
      context.store.createGroup(group);
      context.store.createFeature(
        createTestFeature('m1', { visible: false, locked: true, groupId: 'g1' }),
      );

      const exported = api.export('geojson');
      const geojson = JSON.parse(exported.data);

      // Import into another store to verify the round trip (the group is resolved against
      // the target store, so it has to exist there)
      const context2 = createTestContext();
      context2.store.createGroup({ ...group, featureIds: [] });
      const api2 = createImportExportAPI(context2);
      const result = await api2.load(geojson);

      const imported = context2.store.getFeature(result.featureIds[0]);
      expect(imported?.visible).toBe(false);
      expect(imported?.locked).toBe(true);
      expect(imported?.groupId).toBe('g1');
    });
  });

  describe('load (invalid)', () => {
    it('throws an error for an unsupported format', async () => {
      const api = createImportExportAPI(context);

      await expect(api.load({ foo: 'bar' })).rejects.toThrow('Unsupported data format');
    });

    it('throws an error for null', async () => {
      const api = createImportExportAPI(context);

      await expect(api.load(null)).rejects.toThrow('Unsupported data format');
    });

    it('throws an error for a primitive value', async () => {
      const api = createImportExportAPI(context);

      await expect(api.load('hello')).rejects.toThrow('Unsupported data format');
    });
  });

  describe('load (GeoJSON Multi / GeometryCollection)', () => {
    const multiPointCoords = [
      [139.7, 35.6],
      [139.8, 35.7],
    ];
    const multiLineCoords = [
      [
        [0, 0],
        [1, 1],
      ],
      [
        [10, 10],
        [11, 11],
      ],
    ];
    // Two separate parts. The first one has an inner ring (a hole)
    const multiPolygonCoords = [
      [
        [
          [0, 0],
          [10, 0],
          [10, 10],
          [0, 10],
          [0, 0],
        ],
        [
          [2, 2],
          [8, 2],
          [8, 8],
          [2, 8],
          [2, 2],
        ],
      ],
      [
        [
          [100, 100],
          [110, 100],
          [110, 110],
          [100, 100],
        ],
      ],
    ];

    function featureCollection(geometry: unknown, properties: Record<string, unknown> = {}) {
      return {
        type: 'FeatureCollection' as const,
        features: [
          {
            type: 'Feature' as const,
            geometry,
            properties,
          },
        ],
      } as unknown as GeoJSON.FeatureCollection<GeoJSON.Geometry>;
    }

    it('normalizes a three-element position (with elevation) to two on import', async () => {
      const api = createImportExportAPI(context);

      const cases = [
        { type: 'Point', coordinates: [139.7, 35.6, 12.3], expected: [139.7, 35.6] },
        {
          type: 'LineString',
          coordinates: [
            [0, 0, 1],
            [1, 1, 2],
          ],
          expected: [
            [0, 0],
            [1, 1],
          ],
        },
        {
          type: 'MultiLineString',
          coordinates: [
            [
              [0, 0, 9.41],
              [1, 1, 9.5],
            ],
            [
              [10, 10, 3],
              [11, 11, 4],
            ],
          ],
          expected: [
            [
              [0, 0],
              [1, 1],
            ],
            [
              [10, 10],
              [11, 11],
            ],
          ],
        },
        {
          type: 'Polygon',
          coordinates: [
            [
              [0, 0, 1],
              [10, 0, 1],
              [10, 10, 1],
              [0, 0, 1],
            ],
          ],
          expected: [
            [
              [0, 0],
              [10, 0],
              [10, 10],
              [0, 0],
            ],
          ],
        },
      ] as const;

      for (const { type, coordinates, expected } of cases) {
        const result = await api.load(featureCollection({ type, coordinates }));

        expect(result.featureIds).toHaveLength(1);
        const feature = context.store.getFeature(result.featureIds[0]);
        expect(coordinatesOf(feature)).toEqual(expected);
      }
    });

    it('keeps MultiPoint / MultiLineString / MultiPolygon as a single feature', async () => {
      const api = createImportExportAPI(context);

      for (const [type, coordinates] of [
        ['MultiPoint', multiPointCoords],
        ['MultiLineString', multiLineCoords],
        ['MultiPolygon', multiPolygonCoords],
      ] as const) {
        const result = await api.load(featureCollection({ type, coordinates }));

        expect(result.featureIds).toHaveLength(1);
        const feature = context.store.getFeature(result.featureIds[0]);
        expect(feature?.type).toBe(type);
        expect(coordinatesOf(feature)).toEqual(coordinates);
      }
    });

    it('handles a multi-part MultiPolygon as one feature without copying properties', async () => {
      const api = createImportExportAPI(context);

      const result = await api.load(
        featureCollection(
          { type: 'MultiPolygon', coordinates: multiPolygonCoords },
          { population: 12345 },
        ),
      );

      expect(result.featureIds).toHaveLength(1);
      const feature = context.store.getFeature(result.featureIds[0]);
      expect(feature?.properties.population).toBe(12345);
    });

    it('keeps the three Multi types lossless across a GeoJSON round trip', async () => {
      const api = createImportExportAPI(context);

      const source = {
        type: 'FeatureCollection' as const,
        features: [
          {
            type: 'Feature' as const,
            geometry: { type: 'MultiPoint', coordinates: multiPointCoords },
            properties: {},
          },
          {
            type: 'Feature' as const,
            geometry: { type: 'MultiLineString', coordinates: multiLineCoords },
            properties: {},
          },
          {
            type: 'Feature' as const,
            geometry: { type: 'MultiPolygon', coordinates: multiPolygonCoords },
            properties: {},
          },
        ],
      } as unknown as GeoJSON.FeatureCollection<GeoJSON.Geometry>;

      await api.load(source);
      const exported = JSON.parse(api.export('geojson').data);

      expect(exported.features).toHaveLength(3);
      expect(exported.features.map((f: GeoJSON.Feature) => f.geometry.type)).toEqual([
        'MultiPoint',
        'MultiLineString',
        'MultiPolygon',
      ]);
      expect(exported.features[0].geometry.coordinates).toEqual(multiPointCoords);
      expect(exported.features[1].geometry.coordinates).toEqual(multiLineCoords);
      // The rings follow the right-hand rule on export (the hole of the source is
      // counter-clockwise and comes out clockwise)
      expect(exported.features[2].geometry.coordinates).toEqual(
        normalizeMultiPolygonOrientation(multiPolygonCoords as [number, number][][][]),
      );
    });

    it('expands into individual features as before with flattenMulti:true', async () => {
      const api = createImportExportAPI(context);

      const result = await api.load(
        featureCollection({ type: 'MultiPolygon', coordinates: multiPolygonCoords }),
        { flattenMulti: true },
      );

      expect(result.featureIds).toHaveLength(2);
      for (const fid of result.featureIds) {
        expect(context.store.getFeature(fid)?.type).toBe('Polygon');
      }
    });

    it('folds a GeometryCollection of one sub-geometry kind into a single Multi', async () => {
      const api = createImportExportAPI(context);

      const result = await api.load(
        featureCollection({
          type: 'GeometryCollection',
          geometries: [
            { type: 'Polygon', coordinates: multiPolygonCoords[0] },
            { type: 'Polygon', coordinates: multiPolygonCoords[1] },
            {
              type: 'Polygon',
              coordinates: [
                [
                  [200, 0],
                  [210, 0],
                  [210, 10],
                  [200, 0],
                ],
              ],
            },
          ],
        }),
      );

      expect(result.featureIds).toHaveLength(1);
      const feature = context.store.getFeature(result.featureIds[0]);
      expect(feature?.type).toBe('MultiPolygon');
      expect((coordinatesOf(feature!) as unknown[]).length).toBe(3);
    });

    it('folds a mixed GeometryCollection into at most three features, one per type', async () => {
      const api = createImportExportAPI(context);

      const result = await api.load(
        featureCollection(
          {
            type: 'GeometryCollection',
            geometries: [
              { type: 'Point', coordinates: multiPointCoords[0] },
              { type: 'Point', coordinates: multiPointCoords[1] },
              { type: 'Polygon', coordinates: multiPolygonCoords[0] },
              { type: 'Polygon', coordinates: multiPolygonCoords[1] },
              {
                type: 'Polygon',
                coordinates: [
                  [
                    [200, 0],
                    [210, 0],
                    [210, 10],
                    [200, 0],
                  ],
                ],
              },
            ],
          },
          { category: 'mixed' },
        ),
      );

      // Point 2 + Polygon 3 → MultiPoint 1 + MultiPolygon 1
      expect(result.featureIds).toHaveLength(2);
      const features = result.featureIds.map((id) => context.store.getFeature(id));
      expect(features.map((f) => f?.type)).toEqual(['MultiPoint', 'MultiPolygon']);
      expect(coordinatesOf(features[0])).toEqual(multiPointCoords);
      expect((coordinatesOf(features[1]!) as unknown[]).length).toBe(3);
      // The properties are copied for each folded feature
      for (const feature of features) {
        expect(feature?.properties.category).toBe('mixed');
      }
    });

    it('assigns a new id when folding a GeometryCollection', async () => {
      const api = createImportExportAPI(context);

      const result = await api.load(
        featureCollection(
          {
            type: 'GeometryCollection',
            geometries: [
              { type: 'Point', coordinates: multiPointCoords[0] },
              { type: 'LineString', coordinates: multiLineCoords[0] },
            ],
          },
          { 'maplibre-gl-draw:id': 'original-id' },
        ),
      );

      expect(result.featureIds).toHaveLength(2);
      expect(result.featureIds).not.toContain('original-id');
    });

    it('keeps the Multi types across a native format round trip as well', async () => {
      const api = createImportExportAPI(context);

      await api.load(featureCollection({ type: 'MultiPolygon', coordinates: multiPolygonCoords }));
      const nativeData = JSON.parse(api.export('native').data);
      expect(nativeData.version).toBe(NATIVE_VERSION);

      // The coordinates match even when read back into another context
      const otherContext = createTestContext();
      const otherApi = createImportExportAPI(otherContext);
      const loaded = await otherApi.load(nativeData);

      expect(loaded.featureIds).toHaveLength(1);
      const feature = otherContext.store.getFeature(loaded.featureIds[0]);
      expect(feature?.type).toBe('MultiPolygon');
      expect(coordinatesOf(feature)).toEqual(multiPolygonCoords);
    });
  });

  describe('load (GeoJSON simplestyle fallback)', () => {
    // Builds a one-feature FeatureCollection with only the properties swapped in
    function featureCollection(
      geometry: GeoJSON.Geometry,
      properties: Record<string, unknown>,
    ): GeoJSON.FeatureCollection {
      return {
        type: 'FeatureCollection',
        features: [{ type: 'Feature', geometry, properties }],
      };
    }

    const point: GeoJSON.Point = { type: 'Point', coordinates: [139.7, 35.6] };
    const line: GeoJSON.LineString = {
      type: 'LineString',
      coordinates: [
        [139.7, 35.6],
        [139.8, 35.7],
      ],
    };
    const polygon: GeoJSON.Polygon = {
      type: 'Polygon',
      coordinates: [
        [
          [139.7, 35.6],
          [139.8, 35.6],
          [139.8, 35.7],
          [139.7, 35.6],
        ],
      ],
    };

    it('copies stroke / stroke-width / stroke-opacity of a line into style', async () => {
      const api = createImportExportAPI(context);
      const result = await api.load(
        featureCollection(line, { stroke: '#ff0000', 'stroke-width': 3, 'stroke-opacity': 0.5 }),
      );

      const feature = context.store.getFeature(result.featureIds[0]);
      expect(feature?.style).toEqual({
        strokeColor: '#ff0000',
        strokeWidth: 3,
        strokeOpacity: 0.5,
      });
    });

    it('copies fill / fill-opacity of a polygon into style', async () => {
      const api = createImportExportAPI(context);
      const result = await api.load(
        featureCollection(polygon, { fill: '#00ff00', 'fill-opacity': 0.25 }),
      );

      const feature = context.store.getFeature(result.featureIds[0]);
      expect(feature?.style).toEqual({ fillColor: '#00ff00', fillOpacity: 0.25 });
    });

    it('copies marker-color of a point into pointColor', async () => {
      const api = createImportExportAPI(context);
      const result = await api.load(featureCollection(point, { 'marker-color': '#0000ff' }));

      const feature = context.store.getFeature(result.featureIds[0]);
      expect(feature?.style).toEqual({ pointColor: '#0000ff' });
    });

    it('does not use simplestyle when the round-trip style key exists (no merge)', async () => {
      const api = createImportExportAPI(context);
      const result = await api.load(
        featureCollection(line, {
          'maplibre-gl-draw:style': { strokeColor: '#111111' },
          stroke: '#ff0000',
          'stroke-width': 3,
        }),
      );

      const feature = context.store.getFeature(result.featureIds[0]);
      expect(feature?.style).toEqual({ strokeColor: '#111111' });
    });

    it('ignores keys whose type does not match and copies only the valid ones', async () => {
      const api = createImportExportAPI(context);
      const result = await api.load(
        featureCollection(line, { stroke: 123, 'stroke-width': '3', 'stroke-opacity': 0.5 }),
      );

      const feature = context.store.getFeature(result.featureIds[0]);
      expect(feature?.style).toEqual({ strokeOpacity: 0.5 });
    });

    it('leaves the style empty when every key is invalid', async () => {
      const api = createImportExportAPI(context);
      const result = await api.load(
        featureCollection(line, { stroke: 123, 'stroke-width': '3', 'fill-opacity': Number.NaN }),
      );

      const feature = context.store.getFeature(result.featureIds[0]);
      expect(feature?.style).toEqual({});
    });

    it('leaves the style empty for GeoJSON without simplestyle', async () => {
      const api = createImportExportAPI(context);
      const result = await api.load(featureCollection(point, { name: 'A' }));

      const feature = context.store.getFeature(result.featureIds[0]);
      expect(feature?.style).toEqual({});
    });

    it('keeps the simplestyle keys in properties after copying (non-destructive)', async () => {
      const api = createImportExportAPI(context);
      const result = await api.load(
        featureCollection(polygon, { fill: '#00ff00', 'fill-opacity': 0.25, name: 'A' }),
      );

      const feature = context.store.getFeature(result.featureIds[0]);
      expect(feature?.properties.fill).toBe('#00ff00');
      expect(feature?.properties['fill-opacity']).toBe(0.25);
      expect(feature?.properties.name).toBe('A');
    });
  });

  describe('layer style rule (styleRule)', () => {
    const rule: StyleRule = {
      kind: 'graduated',
      property: 'pop',
      breaks: [10, 20],
      colors: ['#000001', '#000002', '#000003'],
      other: '#888888',
    };

    it('is included in the native format export', () => {
      const api = createImportExportAPI(context);
      context.store.updateLayer('default-layer', { styleRule: rule });

      const data = JSON.parse(api.export('native').data);
      const layer = data.layers.find((l: Layer) => l.id === 'default-layer');

      expect(layer.styleRule).toEqual(rule);
    });

    it('is preserved across a native format round trip', async () => {
      const api = createImportExportAPI(context);
      context.store.updateLayer('default-layer', { styleRule: rule });
      context.store.createLayer(
        createTestLayer({
          id: 'layer-2',
          name: 'Layer 2',
          styleRule: { kind: 'single', color: '#ff0000' },
        }),
      );
      context.store.createFeature(createTestFeature('f1'));

      const nativeData = JSON.parse(api.export('native').data);

      const otherContext = createTestContext();
      const otherApi = createImportExportAPI(otherContext);
      await otherApi.load(nativeData);

      expect(otherContext.store.getLayer('default-layer')?.styleRule).toEqual(rule);
      expect(otherContext.store.getLayer('layer-2')?.styleRule).toEqual({
        kind: 'single',
        color: '#ff0000',
      });
    });

    it('reads a layer without styleRule', async () => {
      const api = createImportExportAPI(context);

      await api.load({
        version: NATIVE_VERSION,
        layers: [createTestLayer({ id: 'default-layer' })],
        layerOrder: ['default-layer'],
        features: [createTestFeature('f1')],
      });

      expect(context.store.getLayer('default-layer')?.styleRule).toBeUndefined();
    });

    it('is not written to the GeoJSON export (GeoJSON has no concept of layers)', () => {
      const api = createImportExportAPI(context);
      context.store.updateLayer('default-layer', { styleRule: rule });
      context.store.createFeature(createTestFeature('f1'));

      const data = JSON.parse(api.export('geojson').data);

      expect(data.layers).toBeUndefined();
      expect(JSON.stringify(data)).not.toContain('styleRule');
    });
  });

  describe('getSuggestedFileName', () => {
    it('returns the default file name', () => {
      const api = createImportExportAPI(context);
      const fileName = api.getSuggestedFileName();

      expect(fileName).toMatch(/^drawing_\d{4}-\d{2}-\d{2}_\d{6}\.maplibre-gl-draw\.json$/);
    });

    it('uses the title from the metadata', () => {
      const api = createImportExportAPI(context);
      context.store.setMetadata({ title: 'My Map' });

      const fileName = api.getSuggestedFileName();
      expect(fileName).toMatch(/^My Map_\d{4}-\d{2}-\d{2}_\d{6}\.maplibre-gl-draw\.json$/);
    });
  });
  describe('round trip of custom types and nested properties', () => {
    // A custom type with a sequence of points (Ribbon here). It is written
    // out to GeoJSON as a LineString geometry, and its type makes the round trip through
    // the featureType marker.
    it('makes a Ribbon round trip as a LineString geometry plus a type marker', async () => {
      const api = createImportExportAPI(context);
      const coordinates = [
        [139.7, 35.6],
        [139.705, 35.605],
        [139.71, 35.61],
      ] as unknown as FeatureCoordinates;
      context.store.createFeature(
        createTestFeature('ribbon-1', {
          type: 'Ribbon',
          geometry: geometryFromCoordinates('Ribbon', coordinates),
          properties: { name: 'Ribbon 1', shape: 'curved', capStart: 'round' },
        }),
      );

      const exported = api.export('geojson');
      const doc = JSON.parse(exported.data as string);
      const out = doc.features[0];
      expect(out.geometry.type).toBe('LineString');
      expect(out.geometry.coordinates).toEqual(coordinates);
      expect(out.properties['maplibre-gl-draw:featureType']).toBe('Ribbon');

      const context2 = createTestContext();
      const api2 = createImportExportAPI(context2);
      const result = await api2.load(doc);
      const restored = context2.store.getFeature(result.featureIds[0]);
      expect(restored?.type).toBe('Ribbon');
      expect(coordinatesOf(restored)).toEqual(coordinates);
      expect(restored?.properties.shape).toBe('curved');
      expect(restored?.properties.capStart).toBe('round');
    });

    it('keeps a plain polyline as a LineString with no type marker on the round trip', async () => {
      const api = createImportExportAPI(context);
      context.store.createFeature(
        createTestFeature('line-1', {
          type: 'LineString',
          geometry: {
            type: 'LineString',
            coordinates: [
              [139.7, 35.6],
              [139.71, 35.61],
            ],
          },
        }),
      );
      const doc = JSON.parse(api.export('geojson').data as string);
      expect(doc.features[0].properties['maplibre-gl-draw:featureType']).toBe(undefined);

      const context2 = createTestContext();
      const restored = await createImportExportAPI(context2)
        .load(doc)
        .then((r) => context2.store.getFeature(r.featureIds[0]));
      expect(restored?.type).toBe('LineString');
    });

    it('makes a nested property round trip losslessly through GeoJSON export then import', async () => {
      const api = createImportExportAPI(context);
      const links = [
        {
          id: 'k1',
          from: [139.75, 35.65],
          to: { featureId: 'other', at: { kind: 'uv', uv: [0.5, 0.5] } },
        },
      ];
      context.store.createFeature(createTestFeature('owner-1', { properties: { links } }));

      const exported = api.export('geojson');
      const doc = JSON.parse(exported.data as string);

      // It is written out untouched as a key without the prefix
      const ownerOut = doc.features.find(
        (f: { properties: Record<string, unknown> }) => f.properties.links,
      );
      expect(ownerOut.properties.links).toEqual(links);

      // Importing into a new store restores properties as they were
      const context2 = createTestContext();
      const api2 = createImportExportAPI(context2);
      const result = await api2.load(doc);
      const features = result.featureIds.map((id: string) => context2.store.getFeature(id));
      const ownerIn = features.find((f) => f?.properties.links);
      expect(ownerIn?.properties.links).toEqual(links);
    });
  });
  describe('load (native format) validates before replacing', () => {
    const invalidCases: Array<[string, Record<string, unknown>]> = [
      ['a layer without order', { layers: [{ id: 'x' }] }],
      [
        'a feature with malformed coordinates',
        {
          features: [
            createTestFeature('n1', {
              geometry: { type: 'Point', coordinates: [0] as unknown as [number, number] },
            }),
          ],
        },
      ],
      [
        'a feature whose coordinates do not match its type',
        {
          features: [
            createTestFeature('n1', {
              type: 'Polygon',
              geometry: {
                type: 'Polygon',
                coordinates: [
                  [0, 0],
                  [1, 1],
                ],
              } as unknown as Feature['geometry'],
            }),
          ],
        },
      ],
      [
        'a feature with a non-finite coordinate',
        {
          features: [
            createTestFeature('n1', { geometry: { type: 'Point', coordinates: [Number.NaN, 0] } }),
          ],
        },
      ],
      [
        'a feature in a missing layer',
        { features: [createTestFeature('n1', { layerId: 'nope' })] },
      ],
      [
        'a feature in a missing group',
        { features: [createTestFeature('n1', { groupId: 'nope' })] },
      ],
      [
        'a feature without properties',
        {
          features: [
            createTestFeature('n1', {
              properties: undefined as unknown as Record<string, unknown>,
            }),
          ],
        },
      ],
      [
        'a group whose id collides with a feature',
        {
          groups: [{ id: 'n1', name: 'G', featureIds: [], locked: false, visible: true }],
          features: [createTestFeature('n1')],
        },
      ],
      [
        'a file with an external URL',
        {
          files: {
            file1: { id: 'file1', mimeType: 'image/png', dataURL: 'https://example.com/a.png' },
          },
        },
      ],
    ];

    for (const [label, overrides] of invalidCases) {
      it(`keeps the existing data when the data has ${label}`, async () => {
        const api = createImportExportAPI(context);
        context.store.createFeature(createTestFeature('existing-1'));

        await expect(
          api.load({
            version: NATIVE_VERSION,
            layers: [createTestLayer()],
            layerOrder: ['default-layer'],
            features: [createTestFeature('n0')],
            ...overrides,
          }),
        ).rejects.toThrow('Invalid native data');

        expect(context.store.getAllFeatures().map((f) => f.id)).toEqual(['existing-1']);
        expect(context.store.getLayer('default-layer')?.items).toEqual(['existing-1']);
      });
    }

    it('can load the same data with an embedded image twice', async () => {
      const api = createImportExportAPI(context);
      const data = {
        version: NATIVE_VERSION,
        layers: [createTestLayer()],
        layerOrder: ['default-layer'],
        features: [
          createTestFeature('img-1', {
            type: 'Image',
            properties: { 'maplibre-gl-draw:imageFileId': 'file-1' },
          }),
        ],
        files: { 'file-1': { id: 'file-1', mimeType: 'image/png', dataURL: PNG_1X1 } },
      };

      await api.load(data);
      await api.load(data);

      expect(context.store.getAllFiles().map((f) => f.id)).toEqual(['file-1']);
      expect(context.store.getFeature('img-1')).toBeDefined();
    });
  });

  describe('load (GeoJSON) resolves ids against the store', () => {
    it('loads its own export back into the same store with new ids', async () => {
      const api = createImportExportAPI(context);
      context.store.createFeature(createTestFeature('f0'));
      context.store.createFeature(
        createTestFeature('f1', { geometry: { type: 'Point', coordinates: [140, 36] } }),
      );

      const doc = JSON.parse(api.export('geojson').data);
      const result = await api.load(doc);

      expect(result.featureIds).toHaveLength(2);
      expect(result.featureIds).not.toContain('f0');
      expect(result.featureIds).not.toContain('f1');
      expect(context.store.getAllFeatures()).toHaveLength(4);
      expect(coordinatesOf(context.store.getFeature(result.featureIds[1]))).toEqual([140, 36]);
    });

    it('re-ids a feature whose id repeats within the file', async () => {
      const api = createImportExportAPI(context);
      const point = {
        type: 'Feature' as const,
        geometry: { type: 'Point' as const, coordinates: [0, 0] },
        properties: { 'maplibre-gl-draw:id': 'dup' },
      };

      const result = await api.load({ type: 'FeatureCollection', features: [point, point] });

      expect(result.featureIds[0]).toBe('dup');
      expect(result.featureIds[1]).not.toBe('dup');
      expect(context.store.getAllFeatures()).toHaveLength(2);
    });

    it('normalizes a numeric id into a string', async () => {
      const api = createImportExportAPI(context);
      const result = await api.load({
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [0, 0] },
            properties: { 'maplibre-gl-draw:id': 42 },
          },
        ],
      });

      expect(result.featureIds).toEqual(['42']);
      expect(context.store.getFeature('42')?.id).toBe('42');
    });

    it('places a feature of a layer the store does not have in the current layer', async () => {
      const api = createImportExportAPI(context);
      const result = await api.load({
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [0, 0] },
            properties: {
              'maplibre-gl-draw:layerId': 'other-layer',
              'maplibre-gl-draw:groupId': 'other-group',
            },
          },
        ],
      });

      const feature = context.store.getFeature(result.featureIds[0]);
      expect(feature?.layerId).toBe('default-layer');
      expect(feature?.groupId).toBeUndefined();
      expect(context.store.getLayer('default-layer')?.items).toEqual(result.featureIds);
    });
  });

  describe('load (GeoJSON) embedded images', () => {
    function imageFeature(imageData: string, mimeType = 'image/png') {
      return {
        type: 'FeatureCollection' as const,
        features: [
          {
            type: 'Feature' as const,
            geometry: { type: 'Point' as const, coordinates: [0, 0] },
            properties: {
              'maplibre-gl-draw:featureType': 'Image',
              'maplibre-gl-draw:imageData': imageData,
              'maplibre-gl-draw:imageMimeType': mimeType,
            },
          },
        ],
      };
    }

    it('accepts an embedded PNG data URL', async () => {
      const api = createImportExportAPI(context);
      const result = await api.load(imageFeature(PNG_1X1));

      const feature = context.store.getFeature(result.featureIds[0]);
      const file = context.store.getFile(
        feature?.properties['maplibre-gl-draw:imageFileId'] as string,
      );
      expect(file?.dataURL).toBe(PNG_1X1);
    });

    it('rejects an external image URL before writing anything', async () => {
      const api = createImportExportAPI(context);

      await expect(api.load(imageFeature('https://example.com/pixel.png'))).rejects.toThrow(
        'Invalid GeoJSON',
      );
      expect(context.store.getAllFeatures()).toHaveLength(0);
      expect(context.store.getAllFiles()).toHaveLength(0);
    });

    it('rejects an SVG data URL', async () => {
      const api = createImportExportAPI(context);

      await expect(
        api.load(imageFeature('data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=', 'image/svg+xml')),
      ).rejects.toThrow('Invalid GeoJSON');
    });
  });

  describe('properties named __proto__', () => {
    const source = JSON.parse(
      '{"type":"FeatureCollection","features":[{"type":"Feature",' +
        '"geometry":{"type":"Point","coordinates":[0,0]},' +
        '"properties":{"__proto__":{"name":"evil"},"kind":"a"}}]}',
    );

    it('keeps __proto__ as an ordinary own key on import', async () => {
      const api = createImportExportAPI(context);
      const result = await api.load(source);

      const properties = context.store.getFeature(result.featureIds[0])?.properties ?? {};
      expect(Object.getPrototypeOf(properties)).toBe(Object.prototype);
      expect(Object.keys(properties).sort()).toEqual(['__proto__', 'kind']);
      expect(properties.name).toBeUndefined();
    });

    it('writes __proto__ out on export so that it survives a round trip', async () => {
      const api = createImportExportAPI(context);
      await api.load(source);

      const exported = JSON.parse(api.export('geojson').data);
      const properties = exported.features[0].properties;
      expect(Object.getOwnPropertyDescriptor(properties, '__proto__')?.value).toEqual({
        name: 'evil',
      });
    });
  });
  describe('GeoJSON export follows RFC 7946', () => {
    const clockwiseSquare: [number, number][] = [
      [0, 0],
      [0, 1],
      [1, 1],
      [1, 0],
      [0, 0],
    ];
    const counterClockwiseHole: [number, number][] = [
      [0.2, 0.2],
      [0.8, 0.2],
      [0.8, 0.8],
      [0.2, 0.8],
      [0.2, 0.2],
    ];

    it('writes the outer ring counter-clockwise and the holes clockwise', () => {
      const api = createImportExportAPI(context);
      context.store.createFeature(
        createTestFeature('p1', {
          type: 'Polygon',
          geometry: { type: 'Polygon', coordinates: [clockwiseSquare, counterClockwiseHole] },
        }),
      );

      const [outer, hole] = JSON.parse(api.export('geojson').data).features[0].geometry.coordinates;

      expect(outer).toEqual([...clockwiseSquare].reverse());
      expect(hole).toEqual([...counterClockwiseHole].reverse());
      // The stored feature keeps the orientation it was drawn in
      expect(coordinatesOf(context.store.getFeature('p1'))).toEqual([
        clockwiseSquare,
        counterClockwiseHole,
      ]);
    });

    it('orients every part of a MultiPolygon', () => {
      const api = createImportExportAPI(context);
      const shifted = clockwiseSquare.map(([x, y]) => [x + 5, y] as [number, number]);
      context.store.createFeature(
        createTestFeature('mp', {
          type: 'MultiPolygon',
          geometry: { type: 'MultiPolygon', coordinates: [[clockwiseSquare], [shifted]] },
        }),
      );

      const parts = JSON.parse(api.export('geojson').data).features[0].geometry.coordinates;

      expect(parts).toEqual([[[...clockwiseSquare].reverse()], [[...shifted].reverse()]]);
    });

    it('rounds every position to 7 decimal places', () => {
      const api = createImportExportAPI(context);
      context.store.createFeature(
        createTestFeature('m1', {
          geometry: { type: 'Point', coordinates: [139.123456789012, -35.000000049] },
        }),
      );
      context.store.createFeature(
        createTestFeature('l1', {
          type: 'LineString',
          geometry: {
            type: 'LineString',
            coordinates: [
              [0.1 + 0.2, 1e-9],
              [1, 2],
            ],
          },
        }),
      );

      const features = JSON.parse(api.export('geojson').data).features;

      expect(features[0].geometry.coordinates).toEqual([139.1234568, -35]);
      expect(features[1].geometry.coordinates[0]).toEqual([0.3, 0]);
    });

    it('gives the FeatureCollection a bbox of every exported position', () => {
      const api = createImportExportAPI(context);
      context.store.createFeature(
        createTestFeature('m1', { geometry: { type: 'Point', coordinates: [139.7, 35.6] } }),
      );
      context.store.createFeature(
        createTestFeature('l1', {
          type: 'LineString',
          geometry: {
            type: 'LineString',
            coordinates: [
              [139.5, 35.9],
              [140, 35.2],
            ],
          },
        }),
      );

      const data = JSON.parse(api.export('geojson').data);

      expect(data.bbox).toEqual([139.5, 35.2, 140, 35.9]);
    });

    it('writes no bbox for an empty FeatureCollection', () => {
      const api = createImportExportAPI(context);

      expect(JSON.parse(api.export('geojson').data).bbox).toBeUndefined();
    });

    it('writes the type name as it is so that an inner capital survives the round trip', async () => {
      const api = createImportExportAPI(context);
      context.store.createFeature(createTestFeature('t1', { type: 'TextBox' }));

      const doc = JSON.parse(api.export('geojson').data);
      expect(doc.features[0].properties['maplibre-gl-draw:featureType']).toBe('TextBox');

      const context2 = createTestContext();
      const result = await createImportExportAPI(context2).load(doc);
      expect(context2.store.getFeature(result.featureIds[0])?.type).toBe('TextBox');
    });

    it('still reads the lower-cased marker of an earlier export', async () => {
      const api = createImportExportAPI(context);
      const result = await api.load({
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [0, 0] },
            properties: { 'maplibre-gl-draw:featureType': 'Circle', radiusMeters: 10 },
          },
        ],
      });

      const circle = context.store.getFeature(result.featureIds[0]);
      expect(circle?.type).toBe('Circle');
      // The radius was written without the prefix then
      expect(circle?.properties).toEqual({ 'maplibre-gl-draw:radiusMeters': 10 });
    });
  });

  describe('GeoJSON export brings the longitudes into [-180, 180]', () => {
    it('brings a line drawn across the antimeridian back without cutting it', () => {
      const api = createImportExportAPI(context);
      context.store.createFeature(
        createTestFeature('l1', {
          type: 'LineString',
          geometry: {
            type: 'LineString',
            coordinates: [
              [170, 10],
              [180, 10],
              [190.5, 12],
            ],
          },
        }),
      );
      context.store.createFeature(
        createTestFeature('m1', { geometry: { type: 'Point', coordinates: [-181.25, 5] } }),
      );

      const data = JSON.parse(api.export('geojson').data);

      // The edge from 180 to 190.5 comes back as 180 to -169.5, in one LineString
      expect(data.features[0].geometry).toEqual({
        type: 'LineString',
        coordinates: [
          [170, 10],
          [180, 10],
          [-169.5, 12],
        ],
      });
      expect(data.features[1].geometry.coordinates).toEqual([178.75, 5]);
      expect(data.bbox).toEqual([-169.5, 5, 180, 12]);
      // The stored features keep their continuous longitudes
      expect(coordinatesOf(context.store.getFeature('l1'))).toEqual([
        [170, 10],
        [180, 10],
        [190.5, 12],
      ]);
    });

    it('orients a polygon across the antimeridian on its continuous ring', () => {
      const api = createImportExportAPI(context);
      // Clockwise as drawn, from 179 to 181
      const clockwise: [number, number][] = [
        [179, 0],
        [179, 1],
        [181, 1],
        [181, 0],
        [179, 0],
      ];
      context.store.createFeature(
        createTestFeature('p1', {
          type: 'Polygon',
          geometry: { type: 'Polygon', coordinates: [clockwise] },
        }),
      );

      const [ring] = JSON.parse(api.export('geojson').data).features[0].geometry.coordinates;

      expect(ring).toEqual([
        [179, 0],
        [-179, 0],
        [-179, 1],
        [179, 1],
        [179, 0],
      ]);
    });

    it('makes the round trip through the export and the load', async () => {
      const api = createImportExportAPI(context);
      context.store.createFeature(
        createTestFeature('l1', {
          type: 'LineString',
          geometry: {
            type: 'LineString',
            coordinates: [
              [175, 0],
              [185, 0],
            ],
          },
        }),
      );
      const first = JSON.parse(api.export('geojson').data);

      const context2 = createTestContext();
      const api2 = createImportExportAPI(context2);
      const result = await api2.load(first);
      expect(coordinatesOf(context2.store.getFeature(result.featureIds[0]))).toEqual([
        [175, 0],
        [-175, 0],
      ]);

      const second = JSON.parse(api2.export('geojson').data);
      expect(second.features[0].geometry).toEqual(first.features[0].geometry);
    });

    it('leaves 180 and -180 as they are', () => {
      const api = createImportExportAPI(context);
      context.store.createFeature(
        createTestFeature('l1', {
          type: 'LineString',
          geometry: {
            type: 'LineString',
            coordinates: [
              [-180, 0],
              [180, 0],
            ],
          },
        }),
      );

      const [line] = JSON.parse(api.export('geojson').data).features;

      expect(line.geometry.coordinates).toEqual([
        [-180, 0],
        [180, 0],
      ]);
    });
  });

  describe('GeoJSON import of the name, the description and the id', () => {
    function point(properties: Record<string, unknown>, id?: string | number) {
      return {
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            ...(id === undefined ? {} : { id }),
            geometry: { type: 'Point', coordinates: [0, 0] },
            properties,
          },
        ],
      };
    }

    it('reads the name and the description from the plain keys only', async () => {
      const api = createImportExportAPI(context);
      const result = await api.load(
        point({ 'maplibre-gl-draw:name': 'Prefixed', description: 'Plain' }),
      );

      const properties = context.store.getFeature(result.featureIds[0])?.properties;
      expect(properties).toEqual({ description: 'Plain' });
    });

    it('uses the standard Feature id when the prefixed id is absent', async () => {
      const api = createImportExportAPI(context);

      const stringId = await api.load(point({}, 'road-12'));
      const numberId = await api.load(point({}, 42));

      expect(stringId.featureIds).toEqual(['road-12']);
      expect(numberId.featureIds).toEqual(['42']);
    });

    it('prefers the prefixed id over the standard id', async () => {
      const api = createImportExportAPI(context);

      const result = await api.load(point({ 'maplibre-gl-draw:id': 'prefixed' }, 'standard'));

      expect(result.featureIds).toEqual(['prefixed']);
    });

    it('round-trips a store through GeoJSON with the name, the type and the id', async () => {
      const api = createImportExportAPI(context);
      context.store.createFeature(
        createTestFeature('n1', { properties: { name: 'Station', description: 'North exit' } }),
      );

      const doc = JSON.parse(api.export('geojson').data);
      const context2 = createTestContext();
      const result = await createImportExportAPI(context2).load(doc);

      expect(result.featureIds).toEqual(['n1']);
      expect(context2.store.getFeature('n1')?.properties).toEqual({
        name: 'Station',
        description: 'North exit',
      });
    });
  });

  describe('imported styles are validated', () => {
    const broken = {
      fillColor: 123,
      strokeColor: null,
      pointColor: 'red',
      fillOpacity: 5,
      strokeOpacity: 0.5,
      strokeWidth: 2,
      lineStyle: 'wavy',
      pointRadius: -1,
      pointShape: 'hexagon',
      customKey: 'kept for an extension',
    };
    const usable = {
      strokeOpacity: 0.5,
      strokeWidth: 2,
      customKey: 'kept for an extension',
    };

    it('keeps the style keys it does not define as they are, for an extension', async () => {
      // An extension gives features style keys of its own and checks their values when it
      // reads them; the import neither checks nor drops them
      const api = createImportExportAPI(context);
      const style = { labelPlacement: 'diagonal', pointIcon: 7, pointIconDirection: 45 };
      context.store.createFeature(
        createTestFeature('e1', { style: style as unknown as Feature['style'] }),
      );

      for (const format of ['geojson', 'native'] as const) {
        const other = createTestContext();
        await createImportExportAPI(other).load(JSON.parse(api.export(format).data));
        expect(other.store.getFeature('e1')?.style).toEqual(style);
      }
    });

    it('drops the style keys of the wrong type or form from GeoJSON', async () => {
      const api = createImportExportAPI(context);
      const result = await api.load({
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [0, 0] },
            properties: { 'maplibre-gl-draw:style': broken },
          },
        ],
      });

      expect(context.store.getFeature(result.featureIds[0])?.style).toEqual(usable);
    });

    it('accepts #rgb and #rrggbb colors', async () => {
      const api = createImportExportAPI(context);
      const style = { fillColor: '#abc', strokeColor: '#A0B1C2' };
      const result = await api.load({
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [0, 0] },
            properties: { 'maplibre-gl-draw:style': style },
          },
        ],
      });

      expect(context.store.getFeature(result.featureIds[0])?.style).toEqual(style);
    });

    it('ignores a simplestyle color that is not a hex color', async () => {
      const api = createImportExportAPI(context);
      const result = await api.load({
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [0, 0] },
            properties: { 'marker-color': 'red', stroke: 'rgb(1,2,3)', 'stroke-width': 3 },
          },
        ],
      });

      expect(context.store.getFeature(result.featureIds[0])?.style).toEqual({ strokeWidth: 3 });
    });

    it('drops the broken style keys of a native feature instead of rejecting the file', async () => {
      const api = createImportExportAPI(context);
      await api.load({
        version: NATIVE_VERSION,
        layers: [createTestLayer()],
        layerOrder: ['default-layer'],
        features: [createTestFeature('n1', { style: broken as unknown as Feature['style'] })],
      });

      expect(context.store.getFeature('n1')?.style).toEqual(usable);
    });

    it('drops a point shape the built-in renderers do not draw', async () => {
      const api = createImportExportAPI(context);
      const load = async (pointShape: unknown) => {
        const result = await api.load({
          type: 'FeatureCollection',
          features: [
            {
              type: 'Feature',
              geometry: { type: 'Point', coordinates: [0, 0] },
              properties: { 'maplibre-gl-draw:style': { pointShape, pointRadius: 4 } },
            },
          ],
        });
        return context.store.getFeature(result.featureIds[0])?.style;
      };

      expect(await load('icon')).toEqual({ pointRadius: 4 });
      expect(await load(3)).toEqual({ pointRadius: 4 });
      expect(await load('star')).toEqual({ pointShape: 'star', pointRadius: 4 });
    });

    it('round-trips the point shape of a feature through GeoJSON and the native format', async () => {
      const api = createImportExportAPI(context);
      context.store.createFeature(
        createTestFeature('p1', {
          type: 'Point',
          geometry: { type: 'Point', coordinates: [1, 2] },
          style: { pointShape: 'triangle', pointColor: '#00ff00' },
        }),
      );
      const expected = { pointShape: 'triangle', pointColor: '#00ff00' };

      for (const format of ['geojson', 'native'] as const) {
        const other = createTestContext();
        await createImportExportAPI(other).load(JSON.parse(api.export(format).data));
        expect(other.store.getFeature('p1')?.style).toEqual(expected);
      }
    });
  });

  describe('the stacking order in the native format', () => {
    function nativeData(overrides: Record<string, unknown> = {}) {
      return {
        version: NATIVE_VERSION,
        layers: [createTestLayer(), createTestLayer({ id: 'layer-2', name: 'Layer 2' })],
        layerOrder: ['layer-2', 'dataset-a', 'default-layer', 'sep:roads'],
        features: [createTestFeature('incoming')],
        ...overrides,
      };
    }

    it('writes the whole stacking order, entries that are not layers included', () => {
      const api = createImportExportAPI(context);
      context.store.createLayer(createTestLayer({ id: 'layer-2', name: 'Layer 2' }));
      context.store.setLayerOrder(['layer-2', 'dataset-a', 'default-layer', 'sep:roads']);

      const data = JSON.parse(api.export('native').data);

      expect(data.layerOrder).toEqual(['layer-2', 'dataset-a', 'default-layer', 'sep:roads']);
    });

    it('keeps the stacking order across a save and a load', async () => {
      const api = createImportExportAPI(context);
      context.store.createLayer(createTestLayer({ id: 'layer-2', name: 'Layer 2' }));
      context.store.setLayerOrder(['layer-2', 'dataset-a', 'default-layer', 'sep:roads']);

      const other = createTestContext();
      await createImportExportAPI(other).load(JSON.parse(api.export('native').data));

      expect(other.store.getLayerOrder()).toEqual([
        'layer-2',
        'dataset-a',
        'default-layer',
        'sep:roads',
      ]);
    });

    it('replaces the whole stacking order, leaving no entry of the previous document', async () => {
      const api = createImportExportAPI(context);
      context.store.createLayer(createTestLayer({ id: 'old-layer', name: 'Old' }));
      context.store.setLayerOrder(['old-dataset', 'default-layer', 'old-layer', 'sep:old']);

      await api.load(nativeData());

      expect(context.store.getLayerOrder()).toEqual([
        'layer-2',
        'dataset-a',
        'default-layer',
        'sep:roads',
      ]);
    });

    it('puts the kept default layer at the back when the data does not list it', async () => {
      const api = createImportExportAPI(context);
      context.store.setLayerOrder(['old-dataset', 'default-layer']);

      await api.load(
        nativeData({
          layers: [createTestLayer({ id: 'layer-2', name: 'Layer 2' })],
          layerOrder: ['layer-2', 'dataset-a'],
          features: [createTestFeature('incoming', { layerId: 'layer-2' })],
        }),
      );

      expect(context.store.getLayerOrder()).toEqual(['default-layer', 'layer-2', 'dataset-a']);
    });

    const invalidOrders: Array<[string, unknown]> = [
      ['no stacking order', undefined],
      ['a stacking order that is not an array', 'layer-2'],
      ['a stacking order with an entry that is not a string', ['layer-2', 3, 'default-layer']],
      ['a stacking order with an empty entry', ['layer-2', '', 'default-layer']],
      ['a stacking order with a repeated entry', ['layer-2', 'default-layer', 'layer-2']],
      ['a stacking order that leaves out a layer of the data', ['default-layer']],
    ];

    for (const [label, layerOrder] of invalidOrders) {
      it(`rejects ${label} and keeps the existing data`, async () => {
        const api = createImportExportAPI(context);
        context.store.createFeature(createTestFeature('existing'));
        context.store.setLayerOrder(['default-layer', 'kept-entry']);

        await expect(api.load(nativeData({ layerOrder }))).rejects.toThrow('Invalid native data');

        expect(context.store.getFeature('existing')).toBeDefined();
        expect(context.store.getLayerOrder()).toEqual(['default-layer', 'kept-entry']);
      });
    }
  });

  describe('the version of native data', () => {
    function nativeData(version: string) {
      return {
        version,
        layers: [createTestLayer()],
        layerOrder: ['default-layer'],
        features: [createTestFeature('incoming')],
      };
    }

    beforeEach(() => {
      context.store.createFeature(createTestFeature('existing'));
    });

    it('rejects another major version and keeps the existing data', async () => {
      const api = createImportExportAPI(context);

      await expect(api.load(nativeData('3.0.0'))).rejects.toThrow(/version 3\.0\.0/);
      await expect(api.load(nativeData('1.2.0'))).rejects.toThrow(/version 1\.2\.0/);
      expect(context.store.getFeature('existing')).toBeDefined();
      expect(context.store.getFeature('incoming')).toBeUndefined();
    });

    it('rejects a version that is not a semantic version', async () => {
      const api = createImportExportAPI(context);

      await expect(api.load(nativeData('latest'))).rejects.toThrow(/semantic version/);
      expect(context.store.getFeature('existing')).toBeDefined();
    });

    it('reads a newer minor version with a warning', async () => {
      const api = createImportExportAPI(context);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

      try {
        await api.load(nativeData('2.9.0'));
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('2.9.0'));
      } finally {
        warn.mockRestore();
      }
      expect(context.store.getFeature('incoming')).toBeDefined();
    });

    it('reads the current version without a warning', async () => {
      const api = createImportExportAPI(context);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

      try {
        await api.load(nativeData(NATIVE_VERSION));
        expect(warn).not.toHaveBeenCalled();
      } finally {
        warn.mockRestore();
      }
      expect(context.store.getFeature('incoming')).toBeDefined();
    });
  });
});
