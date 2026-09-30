// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import type { Coordinate, Feature } from '../../../store/types.js';
import { latitudeScale } from '../local-frame.js';
import { SEGMENT_INDEX_THRESHOLD } from '../segment-grid.js';
import type { HitTestStrategy } from './base.js';
import { CircleHitTestStrategy } from './circle.js';
import { ImageHitTestStrategy } from './image.js';
import { LineHitTestStrategy } from './line.js';
import { MultiLineStringHitTestStrategy, MultiPolygonHitTestStrategy } from './multi.js';
import { PointHitTestStrategy } from './point.js';
import { PolygonHitTestStrategy } from './polygon.js';

/**
 * A helper that creates a Feature for the tests
 */
function createFeature(overrides: Partial<Feature> & Pick<Feature, 'type' | 'geometry'>): Feature {
  return {
    id: 'test-feature',
    layerId: 'test-layer',
    groupId: undefined,
    properties: {},
    locked: false,
    visible: true,
    style: {},
    ...overrides,
  };
}

/**
 * Checks the invariant of testDistance
 *
 * testDistance !== null <=> test === true, and when it is not null the value matches
 * distance.
 */
function expectTestDistanceInvariant(
  strategy: HitTestStrategy,
  feature: Feature,
  coordinate: Coordinate,
  toleranceLngLat: number,
): number | null {
  const result = strategy.testDistance?.(feature, coordinate, toleranceLngLat) ?? null;
  expect(result !== null).toBe(strategy.test(feature, coordinate, toleranceLngLat));
  if (result !== null) {
    expect(result).toBe(strategy.distance(feature, coordinate));
  }
  return result;
}

// ---------------------------------------------------------------------------
// PointHitTestStrategy
// ---------------------------------------------------------------------------
describe('PointHitTestStrategy', () => {
  const strategy = new PointHitTestStrategy();

  const point = createFeature({
    type: 'Point',
    geometry: { type: 'Point', coordinates: [10, 20] as Coordinate },
  });

  it('has geometryType Point', () => {
    expect(strategy.geometryType).toBe('Point');
  });

  it('hits a point within the tolerance', () => {
    // A distance of 3 (simply a nearby point, without using a 3-4-5 triangle)
    const coord: Coordinate = [11, 20];
    expect(strategy.test(point, coord, 2)).toBe(true);
  });

  it('misses a point outside the tolerance', () => {
    const coord: Coordinate = [15, 20];
    expect(strategy.test(point, coord, 2)).toBe(false);
  });

  // Distances are in degrees of longitude at the click latitude: a latitude difference is
  // divided by cos φ (it is that much longer on screen)
  const localFive = Math.hypot(3, 4 / latitudeScale(24));

  it('hits exactly on the boundary of the tolerance', () => {
    const coord: Coordinate = [13, 24];
    expect(strategy.test(point, coord, localFive)).toBe(true);
    expect(strategy.test(point, coord, localFive * 0.999)).toBe(false);
  });

  it('returns the correct distance from distance', () => {
    const coord: Coordinate = [13, 24];
    expect(strategy.distance(point, coord)).toBeCloseTo(localFive, 10);
  });

  it('gives a distance of 0 for the same coordinate', () => {
    expect(strategy.distance(point, [10, 20])).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// LineHitTestStrategy
// ---------------------------------------------------------------------------
describe('LineHitTestStrategy', () => {
  const strategy = new LineHitTestStrategy();

  const line = createFeature({
    type: 'LineString',
    geometry: {
      type: 'LineString',
      coordinates: [
        [0, 0],
        [10, 0],
        [10, 10],
      ] as Coordinate[],
    },
  });

  it('has geometryType LineString', () => {
    expect(strategy.geometryType).toBe('LineString');
  });

  it('hits a point near a segment', () => {
    // (5, 1) -> a distance of 1 from the horizontal segment [0,0]-[10,0]
    const coord: Coordinate = [5, 1];
    expect(strategy.test(line, coord, 2)).toBe(true);
  });

  it('misses a point far from the segments', () => {
    const coord: Coordinate = [5, 10];
    expect(strategy.test(line, coord, 2)).toBe(false);
  });

  it('hits a point on a segment', () => {
    const coord: Coordinate = [5, 0];
    expect(strategy.test(line, coord, 1)).toBe(true);
  });

  it('hits near a vertical segment as well', () => {
    // (11, 5) -> a distance of 1 from the vertical segment [10,0]-[10,10]
    const coord: Coordinate = [11, 5];
    expect(strategy.test(line, coord, 2)).toBe(true);
  });

  it('returns the distance to the nearest segment from distance', () => {
    // 3 degrees of latitude from [0,0]-[10,0], in degrees of longitude at latitude 3
    const coord: Coordinate = [5, 3];
    expect(strategy.distance(line, coord)).toBeCloseTo(3 / latitudeScale(3), 10);
  });

  it('gives a distance of 0 for a point on a segment', () => {
    const coord: Coordinate = [10, 5];
    expect(strategy.distance(line, coord)).toBeCloseTo(0, 10);
  });

  describe('testDistance', () => {
    // A polyline whose vertex count is at or above the threshold (the index path)
    const denseCoords: Coordinate[] = Array.from(
      { length: SEGMENT_INDEX_THRESHOLD * 2 },
      (_, i) => [i * 0.001, Math.sin(i * 0.01)] as Coordinate,
    );
    const denseLine = createFeature({
      type: 'LineString',
      geometry: { type: 'LineString', coordinates: denseCoords },
    });

    it('holds the invariant below the threshold too', () => {
      for (const coord of [
        [5, 1] as Coordinate,
        [5, 10] as Coordinate,
        [5, 0] as Coordinate,
        [11, 5] as Coordinate,
        [100, 100] as Coordinate,
      ]) {
        expectTestDistanceInvariant(strategy, line, coord, 2);
      }
    });

    it('holds the invariant at or above the threshold (the index path) too', () => {
      for (const coord of [
        [0.5, 0] as Coordinate,
        [1, 0.5] as Coordinate,
        [1.5, -0.9] as Coordinate,
        [-50, -50] as Coordinate,
      ]) {
        expectTestDistanceInvariant(strategy, denseLine, coord, 0.05);
      }
    });

    it('matches the full scan exactly in distance at or above the threshold too', () => {
      const coord: Coordinate = [1, 0.5];
      expect(strategy.testDistance(denseLine, coord, 1)).toBe(strategy.distance(denseLine, coord));
    });
  });
});

// ---------------------------------------------------------------------------
// PolygonHitTestStrategy
// ---------------------------------------------------------------------------
describe('PolygonHitTestStrategy', () => {
  const strategy = new PolygonHitTestStrategy();

  // A simple square polygon (only the outer ring)
  const square = createFeature({
    type: 'Polygon',
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          [0, 0],
          [10, 0],
          [10, 10],
          [0, 10],
          [0, 0],
        ],
      ] as Coordinate[][],
    },
  });

  it('has geometryType Polygon', () => {
    expect(strategy.geometryType).toBe('Polygon');
  });

  it('hits a point inside the polygon', () => {
    const coord: Coordinate = [5, 5];
    expect(strategy.test(square, coord, 0)).toBe(true);
  });

  it('misses a distant point outside the polygon', () => {
    const coord: Coordinate = [20, 20];
    expect(strategy.test(square, coord, 1)).toBe(false);
  });

  it('hits an outside point near an edge of the polygon when it is within the tolerance', () => {
    // (11, 5) -> a distance of 1 from the right edge [10,0]-[10,10]
    const coord: Coordinate = [11, 5];
    expect(strategy.test(square, coord, 2)).toBe(true);
  });

  it('misses near an edge of the polygon when it is outside the tolerance', () => {
    const coord: Coordinate = [13, 5];
    expect(strategy.test(square, coord, 2)).toBe(false);
  });

  it('gives a distance of 0 for a point inside', () => {
    const coord: Coordinate = [5, 5];
    expect(strategy.distance(square, coord)).toBe(0);
  });

  it('gives the distance to an edge for a point outside', () => {
    const coord: Coordinate = [13, 5];
    expect(strategy.distance(square, coord)).toBeCloseTo(3, 10);
  });

  describe('a polygon with a hole', () => {
    const polygonWithHole = createFeature({
      type: 'Polygon',
      geometry: {
        type: 'Polygon',
        coordinates: [
          // The outer ring
          [
            [0, 0],
            [20, 0],
            [20, 20],
            [0, 20],
            [0, 0],
          ],
          // The hole
          [
            [5, 5],
            [15, 5],
            [15, 15],
            [5, 15],
            [5, 5],
          ],
        ] as Coordinate[][],
      },
    });

    it('does not treat a point inside the hole as being inside the polygon', () => {
      const coord: Coordinate = [10, 10];
      // It is inside the hole, so pointInPolygon is false
      // Note that if the distance to an edge is 0 or less, it could still hit through the
      // tolerance
      expect(strategy.test(polygonWithHole, coord, 0)).toBe(false);
    });

    it('hits in the area between the outer ring and the hole', () => {
      const coord: Coordinate = [2, 2];
      expect(strategy.test(polygonWithHole, coord, 0)).toBe(true);
    });
  });

  describe('testDistance', () => {
    // A circular ring whose vertex count is at or above the threshold (the index path)
    const denseRing: Coordinate[] = Array.from({ length: SEGMENT_INDEX_THRESHOLD * 2 }, (_, i) => {
      const angle = (i / (SEGMENT_INDEX_THRESHOLD * 2 - 1)) * Math.PI * 2;
      return [Math.cos(angle) * 10, Math.sin(angle) * 10] as Coordinate;
    });
    const densePolygon = createFeature({
      type: 'Polygon',
      geometry: { type: 'Polygon', coordinates: [denseRing] },
    });

    // A polygon with an outer ring of 0..20 and a hole of 5..15
    const holed = createFeature({
      type: 'Polygon',
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [0, 0],
            [20, 0],
            [20, 20],
            [0, 20],
            [0, 0],
          ],
          [
            [5, 5],
            [15, 5],
            [15, 15],
            [5, 15],
            [5, 5],
          ],
        ] as Coordinate[][],
      },
    });

    it('returns 0 inside', () => {
      expect(strategy.testDistance(square, [5, 5], 0)).toBe(0);
    });

    it('matches distance outside near an edge', () => {
      const coord: Coordinate = [11, 5];
      expect(strategy.testDistance(square, coord, 2)).toBe(strategy.distance(square, coord));
    });

    it('returns null far away', () => {
      expect(strategy.testDistance(square, [20, 20], 1)).toBeNull();
    });

    it('returns null when the rings are empty', () => {
      const empty = createFeature({
        type: 'Polygon',
        geometry: { type: 'Polygon', coordinates: [] as Coordinate[][] },
      });
      expect(strategy.testDistance(empty, [0, 0], 1)).toBeNull();
    });

    it('holds the invariant on a polygon with a hole too', () => {
      for (const coord of [
        [2, 2] as Coordinate,
        [10, 10] as Coordinate,
        [5.5, 10] as Coordinate,
        [30, 30] as Coordinate,
      ]) {
        expectTestDistanceInvariant(strategy, holed, coord, 1);
      }
    });

    it('holds the invariant on a huge ring (the index path) too', () => {
      for (const coord of [
        [0, 0] as Coordinate,
        [10.05, 0] as Coordinate,
        [10.5, 0] as Coordinate,
        [1000, 1000] as Coordinate,
      ]) {
        expectTestDistanceInvariant(strategy, densePolygon, coord, 0.2);
      }
    });
  });
});

// ---------------------------------------------------------------------------
// CircleHitTestStrategy
// ---------------------------------------------------------------------------
describe('CircleHitTestStrategy', () => {
  const strategy = new CircleHitTestStrategy();

  // A circle with a radius of 1000 m at the origin on the equator
  const circle = createFeature({
    type: 'Circle',
    geometry: { type: 'Point', coordinates: [0, 0] as Coordinate },
    properties: { 'maplibre-gl-draw:radiusMeters': 1000 },
  });

  it('has geometryType Circle', () => {
    expect(strategy.geometryType).toBe('Circle');
  });

  it('hits the center of the circle', () => {
    const coord: Coordinate = [0, 0];
    expect(strategy.test(circle, coord, 0)).toBe(true);
  });

  it('hits a point within the radius', () => {
    // On the equator 0.005 degrees of longitude is about 556 m < 1000 m
    const coord: Coordinate = [0.005, 0];
    expect(strategy.test(circle, coord, 0)).toBe(true);
  });

  it('misses a point far beyond the radius', () => {
    // On the equator 1 degree of longitude is about 111 km >> 1000 m + tolerance
    const coord: Coordinate = [1, 0];
    expect(strategy.test(circle, coord, 0)).toBe(false);
  });

  it('returns false when radiusMeters is undefined', () => {
    const noRadius = createFeature({
      type: 'Circle',
      geometry: { type: 'Point', coordinates: [0, 0] as Coordinate },
      properties: {},
    });
    expect(strategy.test(noRadius, [0, 0], 0)).toBe(false);
  });

  it('returns false when radiusMeters is 0 or less', () => {
    const zeroRadius = createFeature({
      type: 'Circle',
      geometry: { type: 'Point', coordinates: [0, 0] as Coordinate },
      properties: { 'maplibre-gl-draw:radiusMeters': 0 },
    });
    expect(strategy.test(zeroRadius, [0, 0], 0)).toBe(false);
  });

  it('returns the absolute distance from the boundary of the circle from distance', () => {
    // At the center -> the distance from the boundary is the radius itself (1000 m)
    expect(strategy.distance(circle, [0, 0])).toBeCloseTo(1000, -1);
  });

  it('gives Infinity from distance when radiusMeters is undefined', () => {
    const noRadius = createFeature({
      type: 'Circle',
      geometry: { type: 'Point', coordinates: [0, 0] as Coordinate },
      properties: {},
    });
    expect(strategy.distance(noRadius, [0, 0])).toBe(Number.POSITIVE_INFINITY);
  });
});

// ---------------------------------------------------------------------------
// ImageHitTestStrategy
// ---------------------------------------------------------------------------
describe('ImageHitTestStrategy', () => {
  const strategy = new ImageHitTestStrategy();

  // A 100x100 pixel image on the equator (without rotation)
  const image = createFeature({
    type: 'Image',
    geometry: { type: 'Point', coordinates: [0, 0] as Coordinate },
    properties: {
      'maplibre-gl-draw:imageFileId': 'test-image',
      'maplibre-gl-draw:imageWidth': 100,
      'maplibre-gl-draw:imageHeight': 100,
      'maplibre-gl-draw:createdZoom': 14,
      'maplibre-gl-draw:scale': 1,
    },
  });

  it('has geometryType Image', () => {
    expect(strategy.geometryType).toBe('Image');
  });

  it('hits the center of the image', () => {
    const coord: Coordinate = [0, 0];
    expect(strategy.test(image, coord, 0)).toBe(true);
  });

  it('misses a point far enough from the image', () => {
    // A point 10 degrees away is certainly outside the image
    const coord: Coordinate = [10, 10];
    expect(strategy.test(image, coord, 0)).toBe(false);
  });

  it('returns false for a type other than Image', () => {
    const notImage = createFeature({
      type: 'Point',
      geometry: { type: 'Point', coordinates: [0, 0] as Coordinate },
    });
    expect(strategy.test(notImage, [0, 0], 0)).toBe(false);
  });

  it('returns false when there is no imageFileId', () => {
    const noFile = createFeature({
      type: 'Image',
      geometry: { type: 'Point', coordinates: [0, 0] as Coordinate },
      properties: {},
    });
    expect(strategy.test(noFile, [0, 0], 0)).toBe(false);
  });

  it('returns Infinity from distance for a type other than Image', () => {
    const notImage = createFeature({
      type: 'Point',
      geometry: { type: 'Point', coordinates: [0, 0] as Coordinate },
    });
    expect(strategy.distance(notImage, [0, 0])).toBe(Infinity);
  });

  it('returns a value close to 0 from distance at the center of the image', () => {
    expect(strategy.distance(image, [0, 0])).toBeCloseTo(0, 5);
  });

  it('returns a large value from distance at a distant point', () => {
    expect(strategy.distance(image, [10, 10])).toBeGreaterThan(0);
  });

  it('can change the tile size with setTileSize', () => {
    const s = new ImageHitTestStrategy(256);
    s.setTileSize(512);
    // Check that it runs without an error
    expect(s.test(image, [0, 0], 0)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// testDistance of the Multi geometries
// ---------------------------------------------------------------------------
describe('testDistance of the Multi geometries', () => {
  it('returns the minimum over the parts for MultiLineString', () => {
    const strategy = new MultiLineStringHitTestStrategy();
    const multiLine = createFeature({
      type: 'MultiLineString',
      geometry: {
        type: 'MultiLineString',
        coordinates: [
          [
            [0, 0],
            [10, 0],
          ],
          [
            [0, 5],
            [10, 5],
          ],
        ] as Coordinate[][],
      },
    });

    // 1 from the second one and 4 from the first one -> the minimum is 1 (in degrees of
    // longitude at latitude 4)
    expect(strategy.testDistance(multiLine, [5, 4], 2)).toBeCloseTo(1 / latitudeScale(4), 10);
    expectTestDistanceInvariant(strategy, multiLine, [5, 4], 2);
    // Far from both parts
    expect(strategy.testDistance(multiLine, [5, 20], 2)).toBeNull();
  });

  it('holds the invariant for MultiLineString on a part at or above the threshold too', () => {
    const strategy = new MultiLineStringHitTestStrategy();
    const densePart: Coordinate[] = Array.from(
      { length: SEGMENT_INDEX_THRESHOLD * 2 },
      (_, i) => [i * 0.01, 0] as Coordinate,
    );
    const multiLine = createFeature({
      type: 'MultiLineString',
      geometry: {
        type: 'MultiLineString',
        coordinates: [
          densePart,
          [
            [0, 100],
            [10, 100],
          ],
        ] as Coordinate[][],
      },
    });

    for (const coord of [[5, 0.05] as Coordinate, [5, 3] as Coordinate, [5, 99.9] as Coordinate]) {
      expectTestDistanceInvariant(strategy, multiLine, coord, 0.2);
    }
  });

  it('returns the minimum over the parts for MultiPolygon, and 0 inside', () => {
    const strategy = new MultiPolygonHitTestStrategy();
    const multiPolygon = createFeature({
      type: 'MultiPolygon',
      geometry: {
        type: 'MultiPolygon',
        coordinates: [
          [
            [
              [0, 0],
              [10, 0],
              [10, 10],
              [0, 10],
              [0, 0],
            ],
          ],
          [
            [
              [20, 0],
              [30, 0],
              [30, 10],
              [20, 10],
              [20, 0],
            ],
          ],
        ] as Coordinate[][][],
      },
    });

    // Inside the first part
    expect(strategy.testDistance(multiPolygon, [5, 5], 0)).toBe(0);
    // 1 from an edge of the second part (9 from the first one)
    expect(strategy.testDistance(multiPolygon, [19, 5], 2)).toBeCloseTo(1, 10);
    expectTestDistanceInvariant(strategy, multiPolygon, [19, 5], 2);
    // Far from both parts
    expect(strategy.testDistance(multiPolygon, [15, 5], 2)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// HitTestStrategyRegistry
// ---------------------------------------------------------------------------
describe('HitTestStrategyRegistry', () => {
  // Check the imports from base.ts through index.ts
  it('has the correct geometryType on every strategy', () => {
    expect(new PointHitTestStrategy().geometryType).toBe('Point');
    expect(new LineHitTestStrategy().geometryType).toBe('LineString');
    expect(new PolygonHitTestStrategy().geometryType).toBe('Polygon');
    expect(new CircleHitTestStrategy().geometryType).toBe('Circle');
    expect(new ImageHitTestStrategy().geometryType).toBe('Image');
  });
});
