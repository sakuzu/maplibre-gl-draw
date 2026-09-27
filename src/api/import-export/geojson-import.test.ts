// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests of the GeoJSON import: every feature is validated before anything is written, and an
 * invalid one is skipped with a reason instead of reaching the store
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { coordinatesOf } from '../../shared/utils/coordinates.js';
import type { AutoNameGenerator } from '../../shared/utils/name-generator.js';
import { MemoryStore } from '../../store/memory.js';
import type { Feature } from '../../store/types.js';
import { loadGeoJSON } from './geojson-import.js';

function feature(geometry: unknown, properties: Record<string, unknown> = {}): unknown {
  return { type: 'Feature', geometry, properties };
}

function featureCollection(...features: unknown[]): GeoJSON.FeatureCollection<GeoJSON.Geometry> {
  return { type: 'FeatureCollection', features } as GeoJSON.FeatureCollection<GeoJSON.Geometry>;
}

const VALID_POINT = feature({ type: 'Point', coordinates: [139.7, 35.6] });
const SQUARE = [
  [0, 0],
  [1, 0],
  [1, 1],
  [0, 1],
  [0, 0],
];

/** Signed planar area of a closed ring (positive = counterclockwise) */
function signedArea(ring: readonly (readonly number[])[]): number {
  let sum = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    sum += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  }
  return sum / 2;
}

describe('loadGeoJSON', () => {
  let store: MemoryStore;
  let deps: Parameters<typeof loadGeoJSON>[1];

  beforeEach(() => {
    store = new MemoryStore();
    store.createLayer({
      id: 'default-layer',
      name: 'Layer 1',
      visible: true,
      locked: false,
      opacity: 1,
      items: [],
    });
    let counter = 0;
    deps = {
      store,
      autoNameGenerator: { generateName: () => undefined } as unknown as AutoNameGenerator,
      generateFeatureId: () => `feature-${++counter}`,
      getCurrentLayerId: () => 'default-layer',
    };
  });

  describe('invalid geometry is skipped with a reason', () => {
    const invalid: [string, unknown][] = [
      ['an empty Point', { type: 'Point', coordinates: [] }],
      ['a Point with NaN', { type: 'Point', coordinates: [Number.NaN, 0] }],
      ['a Point with null', { type: 'Point', coordinates: [null, 0] }],
      ['a Point with one number', { type: 'Point', coordinates: [1] }],
      ['an empty LineString', { type: 'LineString', coordinates: [] }],
      ['a LineString with one position', { type: 'LineString', coordinates: [[0, 0]] }],
      [
        'an unclosed Polygon of two positions',
        {
          type: 'Polygon',
          coordinates: [
            [
              [0, 0],
              [1, 1],
            ],
          ],
        },
      ],
      [
        'a Polygon whose ring is not closed',
        {
          type: 'Polygon',
          coordinates: [
            [
              [0, 0],
              [1, 0],
              [1, 1],
              [0, 1],
            ],
          ],
        },
      ],
      ['a Polygon without rings', { type: 'Polygon', coordinates: [] }],
      ['missing coordinates', { type: 'Point' }],
      ['coordinates of strings', { type: 'LineString', coordinates: ['a', 'b'] }],
      ['an empty MultiPoint', { type: 'MultiPoint', coordinates: [] }],
      [
        'a MultiLineString with a one-position part',
        { type: 'MultiLineString', coordinates: [[[0, 0]]] },
      ],
      [
        'a MultiPolygon with an unclosed part',
        { type: 'MultiPolygon', coordinates: [[SQUARE.slice(0, 4)]] },
      ],
      [
        'a GeometryCollection with an invalid member',
        {
          type: 'GeometryCollection',
          geometries: [
            { type: 'Point', coordinates: [0, 0] },
            { type: 'LineString', coordinates: [] },
          ],
        },
      ],
      ['an unsupported geometry type', { type: 'Circle', coordinates: [0, 0] }],
      ['a null geometry', null],
    ];

    for (const [name, geometry] of invalid) {
      it(`skips ${name} and imports the valid features around it`, async () => {
        const result = await loadGeoJSON(
          featureCollection(VALID_POINT, feature(geometry), VALID_POINT),
          deps,
        );

        expect(result.featureIds).toHaveLength(2);
        expect(result.skipped).toHaveLength(1);
        expect(result.skipped[0].index).toBe(1);
        expect(result.skipped[0].reason).toEqual(expect.any(String));
        expect(result.skipped[0].reason).not.toBe('');
        expect(store.getAllFeatures()).toHaveLength(2);
      });
    }

    it('skips a feature entry that is not an object', async () => {
      const result = await loadGeoJSON(featureCollection(null, VALID_POINT), deps);

      expect(result.featureIds).toHaveLength(1);
      expect(result.skipped).toEqual([{ index: 0, reason: expect.any(String) }]);
    });

    it('reports an empty skipped list when every feature is valid', async () => {
      const result = await loadGeoJSON(featureCollection(VALID_POINT), deps);

      expect(result.skipped).toEqual([]);
    });
  });

  describe('the featureType marker', () => {
    it('does not turn a LineString into a Polygon with one-level coordinates', async () => {
      const result = await loadGeoJSON(
        featureCollection(
          VALID_POINT,
          feature(
            {
              type: 'LineString',
              coordinates: [
                [0, 0],
                [1, 1],
              ],
            },
            { 'maplibre-gl-draw:featureType': 'polygon' },
          ),
        ),
        deps,
      );

      const stored = result.featureIds.map((id) => store.getFeature(id) as Feature);
      expect(stored.map((f) => f.type)).toEqual(['Point', 'LineString']);
    });

    it('does not make an Image out of a LineString', async () => {
      const result = await loadGeoJSON(
        featureCollection(
          feature(
            {
              type: 'LineString',
              coordinates: [
                [0, 0],
                [1, 1],
              ],
            },
            { 'maplibre-gl-draw:featureType': 'Image' },
          ),
        ),
        deps,
      );

      expect(store.getFeature(result.featureIds[0])?.type).toBe('LineString');
    });

    it('restores the built-in types whose geometry matches', async () => {
      const result = await loadGeoJSON(
        featureCollection(
          feature(
            { type: 'Point', coordinates: [0, 0] },
            { 'maplibre-gl-draw:featureType': 'Circle' },
          ),
          feature(
            {
              type: 'LineString',
              coordinates: [
                [0, 0],
                [1, 1],
              ],
            },
            { 'maplibre-gl-draw:featureType': 'Freehand' },
          ),
        ),
        deps,
      );

      expect(result.featureIds.map((id) => store.getFeature(id)?.type)).toEqual([
        'Circle',
        'Freehand',
      ]);
    });

    it('reads the marker as the exact type name', async () => {
      // The export writes the name as it is; another spelling names another (custom) type
      const result = await loadGeoJSON(
        featureCollection(
          feature(
            { type: 'Point', coordinates: [0, 0] },
            { 'maplibre-gl-draw:featureType': 'circle' },
          ),
        ),
        deps,
      );

      expect(store.getFeature(result.featureIds[0])?.type).toBe('circle');
    });

    it('ignores a marker that is not a string', async () => {
      const result = await loadGeoJSON(
        featureCollection(
          feature({ type: 'Point', coordinates: [0, 0] }, { 'maplibre-gl-draw:featureType': 42 }),
        ),
        deps,
      );

      expect(store.getFeature(result.featureIds[0])?.type).toBe('Point');
    });
  });

  describe('normalization', () => {
    it('drops the elevation and the extra elements of a position', async () => {
      const result = await loadGeoJSON(
        featureCollection(feature({ type: 'Point', coordinates: [1, 2, 30] })),
        deps,
      );

      expect(coordinatesOf(store.getFeature(result.featureIds[0]))).toEqual([1, 2]);
    });

    it('keeps the ring orientation as given', async () => {
      // RFC 7946 asks parsers not to reject rings against the right-hand rule, and nothing
      // in the library depends on the orientation, so a round trip stays exact
      const clockwiseOuter = [
        [0, 0],
        [0, 10],
        [10, 10],
        [10, 0],
        [0, 0],
      ];
      const counterclockwiseHole = [
        [2, 2],
        [4, 2],
        [4, 4],
        [2, 4],
        [2, 2],
      ];
      const result = await loadGeoJSON(
        featureCollection(
          feature({ type: 'Polygon', coordinates: [clockwiseOuter, counterclockwiseHole] }),
        ),
        deps,
      );

      const polygon = coordinatesOf(store.getFeature(result.featureIds[0])) as number[][][];
      expect(signedArea(polygon[0])).toBeLessThan(0);
      expect(signedArea(polygon[1])).toBeGreaterThan(0);
    });

    it('does not rewrite the input object', async () => {
      const ring = [
        [0, 0],
        [0, 1],
        [1, 1],
        [1, 0],
        [0, 0],
      ];
      const source = featureCollection(feature({ type: 'Polygon', coordinates: [ring] }));
      const before = JSON.stringify(source);

      await loadGeoJSON(source, deps);

      expect(JSON.stringify(source)).toBe(before);
    });
  });

  it('writes nothing when the load throws', async () => {
    // Every id the generator hands out is taken, so resolving the second feature's id throws
    // after the first one has been resolved
    store.createFeature({
      id: 'taken',
      type: 'Point',
      geometry: { type: 'Point', coordinates: [0, 0] },
      layerId: 'default-layer',
      properties: {},
      visible: true,
      locked: false,
      style: {},
    });
    deps.generateFeatureId = () => 'taken';

    await expect(
      loadGeoJSON(
        featureCollection(
          feature({ type: 'Point', coordinates: [1, 1] }, { 'maplibre-gl-draw:id': 'fresh' }),
          VALID_POINT,
        ),
        deps,
      ),
    ).rejects.toThrow();
    expect(store.getAllFeatures().map((f) => f.id)).toEqual(['taken']);
  });

  it('stores only well-formed coordinates for every accepted feature', async () => {
    const result = await loadGeoJSON(
      featureCollection(
        feature({ type: 'Polygon', coordinates: [SQUARE] }),
        feature({ type: 'MultiPoint', coordinates: [[0, 0]] }),
        feature({ type: 'Point', coordinates: [Number.POSITIVE_INFINITY, 0] }),
      ),
      deps,
    );

    expect(result.featureIds).toHaveLength(2);
    expect(result.skipped.map((s) => s.index)).toEqual([2]);
  });
});
