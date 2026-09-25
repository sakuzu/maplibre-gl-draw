// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it } from 'vitest';
import { generateCirclePolygon } from '../../geometry/index.js';
import type { Coordinate, Feature } from '../types.js';
import { getBoundingBox, RBushSpatialIndex } from './spatial-index.js';

/**
 * Feature helpers for the tests
 */
function createPoint(id: string, coord: Coordinate, layerId = 'layer1'): Feature {
  return {
    id,
    type: 'Point',
    coordinates: coord,
    layerId,
    properties: {},
    locked: false,
    visible: true,
  };
}

function createLineString(id: string, coords: Coordinate[], layerId = 'layer1'): Feature {
  return {
    id,
    type: 'LineString',
    coordinates: coords,
    layerId,
    properties: {},
    locked: false,
    visible: true,
  };
}

function createPolygon(id: string, rings: Coordinate[][], layerId = 'layer1'): Feature {
  return {
    id,
    type: 'Polygon',
    coordinates: rings,
    layerId,
    properties: {},
    locked: false,
    visible: true,
  };
}

function createCircle(
  id: string,
  coord: Coordinate,
  radiusMeters: number,
  layerId = 'layer1',
): Feature {
  return {
    id,
    type: 'Circle',
    coordinates: coord,
    layerId,
    properties: { radiusMeters },
    locked: false,
    visible: true,
  };
}

describe('RBushSpatialIndex', () => {
  let index: RBushSpatialIndex;

  beforeEach(() => {
    index = new RBushSpatialIndex();
  });

  describe('insert', () => {
    it('adds a Point and can find it', () => {
      const point = createPoint('m1', [139.7, 35.6]);
      index.insert(point);

      const results = index.findNear([139.7, 35.6], 0.01);
      expect(results).toContain('m1');
    });

    it('adds multiple features and can find them', () => {
      index.insert(createPoint('m1', [139.7, 35.6]));
      index.insert(createPoint('m2', [139.8, 35.7]));
      index.insert(createPoint('m3', [140.0, 36.0]));

      const results = index.findNear([139.75, 35.65], 0.1);
      expect(results).toContain('m1');
      expect(results).toContain('m2');
      expect(results).not.toContain('m3');
    });

    it('adds a LineString and can find it', () => {
      const line = createLineString('l1', [
        [139.0, 35.0],
        [140.0, 36.0],
      ]);
      index.insert(line);

      const results = index.findInBounds({
        minX: 139.4,
        minY: 35.4,
        maxX: 139.6,
        maxY: 35.6,
      });
      expect(results).toContain('l1');
    });

    it('adds a Polygon and can find it', () => {
      const polygon = createPolygon('p1', [
        [
          [0, 0],
          [10, 0],
          [10, 10],
          [0, 10],
          [0, 0],
        ],
      ]);
      index.insert(polygon);

      const results = index.findInBounds({
        minX: 4,
        minY: 4,
        maxX: 6,
        maxY: 6,
      });
      expect(results).toContain('p1');
    });
  });

  describe('remove', () => {
    it('is no longer found once the feature is removed', () => {
      const point = createPoint('m1', [139.7, 35.6]);
      index.insert(point);

      index.remove('m1');

      const results = index.findNear([139.7, 35.6], 0.01);
      expect(results).not.toContain('m1');
    });

    it('does not throw when removing an ID that does not exist', () => {
      expect(() => index.remove('nonexistent')).not.toThrow();
    });

    it('can remove only one of several features', () => {
      index.insert(createPoint('m1', [139.7, 35.6]));
      index.insert(createPoint('m2', [139.7, 35.6]));

      index.remove('m1');

      const results = index.findNear([139.7, 35.6], 0.01);
      expect(results).not.toContain('m1');
      expect(results).toContain('m2');
    });
  });

  describe('update', () => {
    it('can find the feature at its new position after updating its position', () => {
      index.insert(createPoint('m1', [139.7, 35.6]));

      index.update('m1', createPoint('m1', [140.0, 36.0]));

      const oldResults = index.findNear([139.7, 35.6], 0.01);
      expect(oldResults).not.toContain('m1');

      const newResults = index.findNear([140.0, 36.0], 0.01);
      expect(newResults).toContain('m1');
    });

    it('inserts a new item when updating an ID that does not exist', () => {
      index.update('m1', createPoint('m1', [139.7, 35.6]));

      const results = index.findNear([139.7, 35.6], 0.01);
      expect(results).toContain('m1');
    });
  });

  describe('findNear', () => {
    it('returns only the features within the tolerance', () => {
      index.insert(createPoint('near', [10.0, 20.0]));
      index.insert(createPoint('far', [50.0, 60.0]));

      const results = index.findNear([10.0, 20.0], 1.0);
      expect(results).toContain('near');
      expect(results).not.toContain('far');
    });

    it('returns an empty array when searching an empty index', () => {
      const results = index.findNear([139.7, 35.6], 1.0);
      expect(results).toEqual([]);
    });
  });

  describe('findInBounds', () => {
    it('returns the features inside the bounding box', () => {
      index.insert(createPoint('inside', [5, 5]));
      index.insert(createPoint('outside', [20, 20]));

      const results = index.findInBounds({
        minX: 0,
        minY: 0,
        maxX: 10,
        maxY: 10,
      });
      expect(results).toContain('inside');
      expect(results).not.toContain('outside');
    });

    it('also includes the features on the boundary', () => {
      index.insert(createPoint('edge', [10, 10]));

      const results = index.findInBounds({
        minX: 10,
        minY: 10,
        maxX: 20,
        maxY: 20,
      });
      expect(results).toContain('edge');
    });

    it('returns an empty array when searching an empty index', () => {
      const results = index.findInBounds({
        minX: 0,
        minY: 0,
        maxX: 10,
        maxY: 10,
      });
      expect(results).toEqual([]);
    });

    it('returns an empty array for a region where no feature exists', () => {
      index.insert(createPoint('m1', [100, 50]));

      const results = index.findInBounds({
        minX: 0,
        minY: 0,
        maxX: 10,
        maxY: 10,
      });
      expect(results).toEqual([]);
    });

    it('is found when the LineString intersects the BBox', () => {
      const line = createLineString('l1', [
        [0, 0],
        [20, 20],
      ]);
      index.insert(line);

      // The BBox of the LineString is 0,0~20,20, so it intersects 5,5~15,15
      const results = index.findInBounds({
        minX: 5,
        minY: 5,
        maxX: 15,
        maxY: 15,
      });
      expect(results).toContain('l1');
    });
  });

  describe('clear', () => {
    it('removes all the features', () => {
      index.insert(createPoint('m1', [1, 1]));
      index.insert(createPoint('m2', [2, 2]));
      index.insert(createPoint('m3', [3, 3]));

      index.clear();

      const results = index.findInBounds({
        minX: -180,
        minY: -90,
        maxX: 180,
        maxY: 90,
      });
      expect(results).toEqual([]);
    });
  });

  describe('setCustomBoundingBoxCalculator', () => {
    it('uses the custom calculation function', () => {
      const customFeature: Feature = {
        id: 'custom1',
        type: 'Marker',
        coordinates: [10, 20] as Coordinate,
        layerId: 'layer1',
        properties: {},
        locked: false,
        visible: true,
      };

      index.setCustomBoundingBoxCalculator('Marker', () => ({
        minX: 5,
        minY: 15,
        maxX: 15,
        maxY: 25,
      }));

      index.insert(customFeature);

      const results = index.findInBounds({
        minX: 6,
        minY: 16,
        maxX: 14,
        maxY: 24,
      });
      expect(results).toContain('custom1');
    });
  });
});

describe('getBoundingBox', () => {
  it('the bounding box of a Point is the coordinate itself', () => {
    const point = createPoint('m1', [139.7, 35.6]);
    const bbox = getBoundingBox(point);

    expect(bbox.minX).toBe(139.7);
    expect(bbox.minY).toBe(35.6);
    expect(bbox.maxX).toBe(139.7);
    expect(bbox.maxY).toBe(35.6);
  });

  it('the bounding box of a LineString is the range of its coordinates', () => {
    const line = createLineString('l1', [
      [10, 20],
      [30, 40],
      [15, 50],
    ]);
    const bbox = getBoundingBox(line);

    expect(bbox.minX).toBe(10);
    expect(bbox.minY).toBe(20);
    expect(bbox.maxX).toBe(30);
    expect(bbox.maxY).toBe(50);
  });

  it('the bounding box of a Polygon is the range of all its vertices', () => {
    const polygon = createPolygon('p1', [
      [
        [0, 0],
        [10, 0],
        [10, 10],
        [0, 10],
        [0, 0],
      ],
    ]);
    const bbox = getBoundingBox(polygon);

    expect(bbox.minX).toBe(0);
    expect(bbox.minY).toBe(0);
    expect(bbox.maxX).toBe(10);
    expect(bbox.maxY).toBe(10);
  });

  it('a Polygon with a hole also takes the inner ring coordinates into account', () => {
    const polygon = createPolygon('p1', [
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
    ]);
    const bbox = getBoundingBox(polygon);

    // The range of the outer ring is used
    expect(bbox.minX).toBe(0);
    expect(bbox.minY).toBe(0);
    expect(bbox.maxX).toBe(20);
    expect(bbox.maxY).toBe(20);
  });

  it('the bounding box of a Circle reflects its radius', () => {
    const circle = createCircle('c1', [139.7, 35.6], 1000);
    const bbox = getBoundingBox(circle);

    // It expands by the number of degrees corresponding to a radius of 1000 m
    expect(bbox.minX).toBeLessThan(139.7);
    expect(bbox.minY).toBeLessThan(35.6);
    expect(bbox.maxX).toBeGreaterThan(139.7);
    expect(bbox.maxY).toBeGreaterThan(35.6);
  });

  it.each([
    [[10, 60] as Coordinate, 100_000],
    [[10, 60] as Coordinate, 1_000_000],
    [[-120, -75] as Coordinate, 500_000],
  ])(
    'the bounding box of a Circle contains the drawn circle (center %j, radius %d m)',
    (center, radiusMeters) => {
      const bbox = getBoundingBox(createCircle('c1', center, radiusMeters));
      const epsilon = 1e-9;
      for (const [lng, lat] of generateCirclePolygon(center, radiusMeters, 1024)) {
        expect(lng).toBeGreaterThanOrEqual(bbox.minX - epsilon);
        expect(lng).toBeLessThanOrEqual(bbox.maxX + epsilon);
        expect(lat).toBeGreaterThanOrEqual(bbox.minY - epsilon);
        expect(lat).toBeLessThanOrEqual(bbox.maxY + epsilon);
      }
    },
  );

  it('a Circle with radius 0 has the same bounding box as a point', () => {
    const circle = createCircle('c1', [139.7, 35.6], 0);
    const bbox = getBoundingBox(circle);

    expect(bbox.minX).toBe(139.7);
    expect(bbox.minY).toBe(35.6);
    expect(bbox.maxX).toBe(139.7);
    expect(bbox.maxY).toBe(35.6);
  });

  it('the bounding box of a Freehand is the range of its coordinates', () => {
    const freehand: Feature = {
      id: 'f1',
      type: 'Freehand',
      coordinates: [
        [5, 10],
        [15, 25],
        [10, 5],
      ] as Coordinate[],
      layerId: 'layer1',
      properties: {},
      locked: false,
      visible: true,
    };
    const bbox = getBoundingBox(freehand);

    expect(bbox.minX).toBe(5);
    expect(bbox.minY).toBe(5);
    expect(bbox.maxX).toBe(15);
    expect(bbox.maxY).toBe(25);
  });

  it('a MultiPoint returns the union bounding box of all its parts', () => {
    const multiPoint: Feature = {
      id: 'mp1',
      type: 'MultiPoint',
      coordinates: [
        [10, 20],
        [30, 5],
        [-5, 40],
      ] as Coordinate[],
      layerId: 'layer1',
      properties: {},
      locked: false,
      visible: true,
    };
    const bbox = getBoundingBox(multiPoint);

    expect(bbox.minX).toBe(-5);
    expect(bbox.minY).toBe(5);
    expect(bbox.maxX).toBe(30);
    expect(bbox.maxY).toBe(40);
  });

  it('a MultiLineString returns the union bounding box of all its parts', () => {
    const multiLine: Feature = {
      id: 'ml1',
      type: 'MultiLineString',
      coordinates: [
        [
          [0, 0],
          [10, 10],
        ],
        [
          [100, -20],
          [110, -10],
        ],
      ] as Coordinate[][],
      layerId: 'layer1',
      properties: {},
      locked: false,
      visible: true,
    };
    const bbox = getBoundingBox(multiLine);

    expect(bbox.minX).toBe(0);
    expect(bbox.minY).toBe(-20);
    expect(bbox.maxX).toBe(110);
    expect(bbox.maxY).toBe(10);
  });

  it('a MultiPolygon returns the union bounding box of all parts, exclaves and inner rings', () => {
    const multiPolygon: Feature = {
      id: 'mpoly1',
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
            [120, 100],
            [120, 130],
            [100, 130],
            [100, 100],
          ],
        ],
      ] as Coordinate[][][],
      layerId: 'layer1',
      properties: {},
      locked: false,
      visible: true,
    };
    const bbox = getBoundingBox(multiPolygon);

    expect(bbox.minX).toBe(0);
    expect(bbox.minY).toBe(0);
    expect(bbox.maxX).toBe(120);
    expect(bbox.maxY).toBe(130);
  });

  it('an empty LineString returns the bounding box at the origin', () => {
    const line = createLineString('l1', []);
    const bbox = getBoundingBox(line);

    expect(bbox).toEqual({ minX: 0, minY: 0, maxX: 0, maxY: 0 });
  });

  it('a custom type without a calculator is measured by the extent of its coordinates', () => {
    const base = { layerId: 'layer1', properties: {}, locked: false, visible: true };
    const single: Feature = {
      ...base,
      id: 'u1',
      type: 'Unknown',
      coordinates: [10, 20] as Coordinate,
    };
    expect(getBoundingBox(single)).toEqual({ minX: 10, minY: 20, maxX: 10, maxY: 20 });

    const line: Feature = {
      ...base,
      id: 'u2',
      type: 'Route',
      coordinates: [
        [1, 2],
        [5, -3],
        [3, 4],
      ] as Coordinate[],
    };
    expect(getBoundingBox(line)).toEqual({ minX: 1, minY: -3, maxX: 5, maxY: 4 });
  });

  it('a custom type with unreadable coordinates returns the bounding box at the origin', () => {
    const odd = {
      id: 'u3',
      type: 'Unknown',
      coordinates: 'x',
      layerId: 'layer1',
      properties: {},
      locked: false,
      visible: true,
    } as unknown as Feature;
    expect(getBoundingBox(odd)).toEqual({ minX: 0, minY: 0, maxX: 0, maxY: 0 });
  });
});

/**
 * A Proxy that counts how many times the coordinate array is read by index
 *
 * The function that performs the traversal is private, so whether a recomputation happened is
 * observed through the number of accesses to the coordinate array.
 */
function countingCoordinates<T extends object>(coords: T): { proxy: T; reads: () => number } {
  let reads = 0;
  const proxy = new Proxy(coords, {
    get(target, prop, receiver) {
      if (typeof prop === 'string' && /^\d+$/.test(prop)) {
        reads++;
      }
      return Reflect.get(target, prop, receiver);
    },
  });
  return { proxy, reads: () => reads };
}

describe('the coordinate AABB cache of getBoundingBox', () => {
  it('skips traversal from the second call on for the same coordinate array reference', () => {
    const { proxy, reads } = countingCoordinates<Coordinate[]>([
      [10, 20],
      [30, 40],
      [15, 50],
    ]);
    const line = createLineString('l1', proxy);

    const first = getBoundingBox(line);
    expect(reads()).toBeGreaterThan(0);
    expect(first).toEqual({ minX: 10, minY: 20, maxX: 30, maxY: 50 });

    const readsAfterFirst = reads();
    const second = getBoundingBox(line);

    expect(reads()).toBe(readsAfterFirst);
    expect(second).toEqual(first);
  });

  it('a Polygon also does not traverse the coordinates from the second call on', () => {
    const { proxy, reads } = countingCoordinates<Coordinate[][]>([
      [
        [0, 0],
        [10, 0],
        [10, 10],
        [0, 10],
        [0, 0],
      ],
    ]);
    const polygon = createPolygon('p1', proxy);

    const first = getBoundingBox(polygon);
    const readsAfterFirst = reads();
    expect(readsAfterFirst).toBeGreaterThan(0);

    const second = getBoundingBox(polygon);

    expect(reads()).toBe(readsAfterFirst);
    expect(second).toEqual(first);
  });

  it('the Multi types also do not traverse the coordinates from the second call on', () => {
    const { proxy, reads } = countingCoordinates<Coordinate[][]>([
      [
        [0, 0],
        [10, 10],
      ],
      [
        [100, -20],
        [110, -10],
      ],
    ]);
    const multiLine: Feature = {
      id: 'ml1',
      type: 'MultiLineString',
      coordinates: proxy,
      layerId: 'layer1',
      properties: {},
      locked: false,
      visible: true,
    };

    const first = getBoundingBox(multiLine);
    const readsAfterFirst = reads();
    expect(readsAfterFirst).toBeGreaterThan(0);
    expect(first).toEqual({ minX: 0, minY: -20, maxX: 110, maxY: 10 });

    const second = getBoundingBox(multiLine);

    expect(reads()).toBe(readsAfterFirst);
    expect(second).toEqual(first);
  });

  it('the cache works for another feature that shares the coordinate array', () => {
    const { proxy, reads } = countingCoordinates<Coordinate[]>([
      [1, 2],
      [3, 4],
    ]);

    const first = getBoundingBox(createLineString('a', proxy));
    const readsAfterFirst = reads();
    const second = getBoundingBox(createLineString('b', proxy));

    expect(reads()).toBe(readsAfterFirst);
    expect(second).toEqual(first);
  });

  it('returns a new object every time, so mutating it does not pollute the cache', () => {
    const line = createLineString('l1', [
      [10, 20],
      [30, 40],
    ]);

    const first = getBoundingBox(line);
    const second = getBoundingBox(line);
    expect(second).not.toBe(first);

    first.minX = -999;
    first.maxY = 999;

    const third = getBoundingBox(line);
    expect(third).toEqual({ minX: 10, minY: 20, maxX: 30, maxY: 40 });
  });

  it('replacing the coordinate array yields a new bounding box', () => {
    const before = getBoundingBox(
      createLineString('l1', [
        [10, 20],
        [30, 40],
      ]),
    );
    expect(before).toEqual({ minX: 10, minY: 20, maxX: 30, maxY: 40 });

    const after = getBoundingBox(
      createLineString('l1', [
        [-5, 0],
        [5, 100],
      ]),
    );
    expect(after).toEqual({ minX: -5, minY: 0, maxX: 5, maxY: 100 });
  });

  it('a Circle reflects a different radius even with the same coordinates (not cached)', () => {
    const coord: Coordinate = [139.7, 35.6];
    const small = getBoundingBox(createCircle('c1', coord, 100));
    const large = getBoundingBox(createCircle('c2', coord, 10000));

    expect(large.maxX).toBeGreaterThan(small.maxX);
    expect(large.maxY).toBeGreaterThan(small.maxY);
  });

  it('update on SpatialIndex replaces it with the bounding box of the new coordinate array', () => {
    const index = new RBushSpatialIndex();
    index.insert(
      createLineString('l1', [
        [0, 0],
        [1, 1],
      ]),
    );

    index.update(
      'l1',
      createLineString('l1', [
        [100, 100],
        [101, 101],
      ]),
    );

    expect(index.findInBounds({ minX: -1, minY: -1, maxX: 2, maxY: 2 })).toEqual([]);
    expect(index.findInBounds({ minX: 99, minY: 99, maxX: 102, maxY: 102 })).toContain('l1');
  });
});
