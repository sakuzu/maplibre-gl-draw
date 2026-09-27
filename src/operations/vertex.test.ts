// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import type { FeatureCoordinates } from '../shared/types/model.js';
import { coordinatesOf, geometryFromCoordinates } from '../shared/utils/coordinates.js';
import type { Coordinate, Feature } from '../store/types.js';
import { addVertex, computeVertexMove, deleteVertex, startVertexMove } from './vertex.js';

// --- Helpers ---

function makePoint(coord: Coordinate): Feature {
  return {
    id: 'point-1',
    type: 'Point',
    geometry: { type: 'Point', coordinates: coord },
    layerId: 'layer-1',
    groupId: undefined,
    properties: {},
    locked: false,
    visible: true,
    style: {},
  };
}

function makeLineString(coords: Coordinate[]): Feature {
  return {
    id: 'line-1',
    type: 'LineString',
    geometry: { type: 'LineString', coordinates: coords },
    layerId: 'layer-1',
    groupId: undefined,
    properties: {},
    locked: false,
    visible: true,
    style: {},
  };
}

function makePolygon(...rings: Coordinate[][]): Feature {
  return {
    id: 'polygon-1',
    type: 'Polygon',
    geometry: { type: 'Polygon', coordinates: rings },
    layerId: 'layer-1',
    groupId: undefined,
    properties: {},
    locked: false,
    visible: true,
    style: {},
  };
}

/** A polygon with one 10x10 hole inside a 20x20 outer ring */
function makePolygonWithHole(): Feature {
  return makePolygon(
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
  );
}

// --- computeVertexMove ---

describe('computeVertexMove', () => {
  describe('LineString', () => {
    it('moves a single vertex', () => {
      const feature = makeLineString([
        [0, 0],
        [10, 10],
        [20, 20],
      ]);
      const state = {
        featureId: feature.id,
        vertices: [{ ring: 0, index: 1 }],
        startLngLat: { lng: 0, lat: 0 },
        initialCoordinates: [
          [0, 0],
          [10, 10],
          [20, 20],
        ] as Coordinate[],
      };

      const result = computeVertexMove(state, { lng: 5, lat: 3 }, feature);
      expect(result).toEqual([
        [0, 0],
        [15, 13],
        [20, 20],
      ]);
    });

    it('moves several vertices at once', () => {
      const feature = makeLineString([
        [0, 0],
        [10, 10],
        [20, 20],
      ]);
      const state = {
        featureId: feature.id,
        vertices: [
          { ring: 0, index: 0 },
          { ring: 0, index: 2 },
        ],
        startLngLat: { lng: 0, lat: 0 },
        initialCoordinates: [
          [0, 0],
          [10, 10],
          [20, 20],
        ] as Coordinate[],
      };

      const result = computeVertexMove(state, { lng: 1, lat: 2 }, feature);
      expect(result).toEqual([
        [1, 2],
        [10, 10],
        [21, 22],
      ]);
    });

    it('ignores an out-of-range index', () => {
      const feature = makeLineString([
        [0, 0],
        [10, 10],
      ]);
      const state = {
        featureId: feature.id,
        vertices: [
          { ring: 0, index: 5 },
          { ring: 0, index: -1 },
        ],
        startLngLat: { lng: 0, lat: 0 },
        initialCoordinates: [
          [0, 0],
          [10, 10],
        ] as Coordinate[],
      };

      const result = computeVertexMove(state, { lng: 3, lat: 3 }, feature);
      expect(result).toEqual([
        [0, 0],
        [10, 10],
      ]);
    });

    it('ignores a reference to a ring other than 0', () => {
      const feature = makeLineString([
        [0, 0],
        [10, 10],
      ]);
      const state = {
        featureId: feature.id,
        vertices: [{ ring: 1, index: 0 }],
        startLngLat: { lng: 0, lat: 0 },
        initialCoordinates: [
          [0, 0],
          [10, 10],
        ] as Coordinate[],
      };

      const result = computeVertexMove(state, { lng: 3, lat: 3 }, feature);
      expect(result).toEqual([
        [0, 0],
        [10, 10],
      ]);
    });
  });

  describe('Polygon (the outer ring)', () => {
    it('moves a vertex', () => {
      const feature = makePolygon([
        [0, 0],
        [10, 0],
        [10, 10],
        [0, 10],
        [0, 0],
      ]);
      const state = {
        featureId: feature.id,
        vertices: [{ ring: 0, index: 1 }],
        startLngLat: { lng: 0, lat: 0 },
        initialCoordinates: [
          [
            [0, 0],
            [10, 0],
            [10, 10],
            [0, 10],
            [0, 0],
          ],
        ] as Coordinate[][],
      };

      const result = computeVertexMove(state, { lng: 2, lat: 3 }, feature) as Coordinate[][];
      expect(result[0][1]).toEqual([12, 3]);
      // The other vertices do not change
      expect(result[0][0]).toEqual([0, 0]);
      expect(result[0][4]).toEqual([0, 0]);
    });

    it('synchronizes the last vertex when the first one is moved', () => {
      const feature = makePolygon([
        [0, 0],
        [10, 0],
        [10, 10],
        [0, 10],
        [0, 0],
      ]);
      const state = {
        featureId: feature.id,
        vertices: [{ ring: 0, index: 0 }],
        startLngLat: { lng: 0, lat: 0 },
        initialCoordinates: [
          [
            [0, 0],
            [10, 0],
            [10, 10],
            [0, 10],
            [0, 0],
          ],
        ] as Coordinate[][],
      };

      const result = computeVertexMove(state, { lng: 5, lat: 5 }, feature) as Coordinate[][];
      expect(result[0][0]).toEqual([5, 5]);
      expect(result[0][4]).toEqual([5, 5]);
    });

    it('synchronizes the first vertex when the last one is moved', () => {
      const feature = makePolygon([
        [0, 0],
        [10, 0],
        [10, 10],
        [0, 10],
        [0, 0],
      ]);
      const state = {
        featureId: feature.id,
        vertices: [{ ring: 0, index: 4 }],
        startLngLat: { lng: 0, lat: 0 },
        initialCoordinates: [
          [
            [0, 0],
            [10, 0],
            [10, 10],
            [0, 10],
            [0, 0],
          ],
        ] as Coordinate[][],
      };

      const result = computeVertexMove(state, { lng: 7, lat: 3 }, feature) as Coordinate[][];
      expect(result[0][4]).toEqual([7, 3]);
      expect(result[0][0]).toEqual([7, 3]);
    });
  });

  describe('Polygon (an inner ring)', () => {
    it('leaves the outer ring unchanged when a vertex of the inner ring is moved', () => {
      const feature = makePolygonWithHole();
      const state = {
        featureId: feature.id,
        vertices: [{ ring: 1, index: 1 }],
        startLngLat: { lng: 0, lat: 0 },
        initialCoordinates: JSON.parse(JSON.stringify(coordinatesOf(feature))) as Coordinate[][],
      };

      const result = computeVertexMove(state, { lng: 1, lat: 2 }, feature) as Coordinate[][];
      expect(result[1][1]).toEqual([16, 7]);
      // The other vertices of the inner ring and the outer ring do not change
      expect(result[1][0]).toEqual([5, 5]);
      expect(result[0]).toEqual([
        [0, 0],
        [20, 0],
        [20, 20],
        [0, 20],
        [0, 0],
      ]);
    });

    it('synchronizes the last vertex of the inner ring when its first one is moved', () => {
      const feature = makePolygonWithHole();
      const state = {
        featureId: feature.id,
        vertices: [{ ring: 1, index: 0 }],
        startLngLat: { lng: 0, lat: 0 },
        initialCoordinates: JSON.parse(JSON.stringify(coordinatesOf(feature))) as Coordinate[][],
      };

      const result = computeVertexMove(state, { lng: 1, lat: 1 }, feature) as Coordinate[][];
      expect(result[1][0]).toEqual([6, 6]);
      expect(result[1][4]).toEqual([6, 6]);
      // The closed outer ring is unaffected
      expect(result[0][0]).toEqual([0, 0]);
      expect(result[0][4]).toEqual([0, 0]);
    });

    it('synchronizes the first vertex of the inner ring when its last one is moved', () => {
      const feature = makePolygonWithHole();
      const state = {
        featureId: feature.id,
        vertices: [{ ring: 1, index: 4 }],
        startLngLat: { lng: 0, lat: 0 },
        initialCoordinates: JSON.parse(JSON.stringify(coordinatesOf(feature))) as Coordinate[][],
      };

      const result = computeVertexMove(state, { lng: -1, lat: -1 }, feature) as Coordinate[][];
      expect(result[1][4]).toEqual([4, 4]);
      expect(result[1][0]).toEqual([4, 4]);
    });

    it('can move vertices of the outer ring and of an inner ring at once', () => {
      const feature = makePolygonWithHole();
      const state = {
        featureId: feature.id,
        vertices: [
          { ring: 0, index: 0 },
          { ring: 1, index: 2 },
        ],
        startLngLat: { lng: 0, lat: 0 },
        initialCoordinates: JSON.parse(JSON.stringify(coordinatesOf(feature))) as Coordinate[][],
      };

      const result = computeVertexMove(state, { lng: 2, lat: 2 }, feature) as Coordinate[][];
      // The first vertex of the outer ring moves and the closing point is synchronized
      expect(result[0][0]).toEqual([2, 2]);
      expect(result[0][4]).toEqual([2, 2]);
      // The vertex of the inner ring moves as well
      expect(result[1][2]).toEqual([17, 17]);
      expect(result[1][0]).toEqual([5, 5]);
    });

    it('ignores an out-of-range ring number', () => {
      const feature = makePolygonWithHole();
      const initial = JSON.parse(JSON.stringify(coordinatesOf(feature))) as Coordinate[][];
      const state = {
        featureId: feature.id,
        vertices: [{ ring: 5, index: 0 }],
        startLngLat: { lng: 0, lat: 0 },
        initialCoordinates: initial,
      };

      const result = computeVertexMove(state, { lng: 3, lat: 3 }, feature) as Coordinate[][];
      expect(result).toEqual(initial);
    });
  });

  describe('Point', () => {
    it('shifts a single coordinate', () => {
      const feature = makePoint([100, 50]);
      const state = {
        featureId: feature.id,
        vertices: [{ ring: 0, index: 0 }],
        startLngLat: { lng: 0, lat: 0 },
        initialCoordinates: [100, 50] as Coordinate,
      };

      const result = computeVertexMove(state, { lng: 3, lat: -2 }, feature);
      expect(result).toEqual([103, 48]);
    });
  });
});

// --- The copy-on-write of computeVertexMove ---

/**
 * computeVertexMove does not copy the coordinates as a whole; it replaces only the
 * levels the moving vertices belong to with new arrays. These tests verify that
 * "the elements that were not moved keep sharing references with
 * initialCoordinates" and that "initialCoordinates is not mutated".
 */
describe('the copy-on-write of computeVertexMove', () => {
  const START = { lng: 0, lat: 0 };

  function makeFeature(type: Feature['type'], coordinates: FeatureCoordinates): Feature {
    return {
      id: `${type}-cow`,
      type,
      geometry: geometryFromCoordinates(type, coordinates),
      layerId: 'layer-1',
      groupId: undefined,
      properties: {},
      locked: false,
      visible: true,
      style: {},
    };
  }

  /** The coordinate sequence of a LineString with many vertices */
  function makeLongLine(count: number): Coordinate[] {
    return Array.from({ length: count }, (_, i) => [i, i] as Coordinate);
  }

  /** Part 0 is a square with a hole and part 1 is a separate triangle */
  function makeMultiPolygonCoords(): Coordinate[][][] {
    return [
      [
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
  }

  it('LineString: only the moved vertices become new arrays, and the other vertices share references', () => {
    const initial = makeLongLine(1000);
    const feature = makeLineString(initial);
    const snapshot = structuredClone(initial);
    const state = {
      featureId: feature.id,
      vertices: [{ ring: 0, index: 500 }],
      startLngLat: START,
      initialCoordinates: initial,
    };

    const result = computeVertexMove(state, { lng: 3, lat: -1 }, feature) as Coordinate[];

    // The top-level array is always new
    expect(result).not.toBe(initial);
    // A moved vertex is a new pair array
    expect(result[500]).not.toBe(initial[500]);
    expect(result[500]).toEqual([503, 499]);
    // A vertex that was not moved shares its reference
    for (const index of [0, 1, 499, 501, 999]) {
      expect(result[index]).toBe(initial[index]);
    }
    // initialCoordinates is not mutated
    expect(initial).toEqual(snapshot);
  });

  it('Polygon: keeps the closed ring synchronized while the untouched rings share references', () => {
    const feature = makePolygonWithHole();
    const initial = coordinatesOf(feature) as Coordinate[][];
    const snapshot = structuredClone(initial);
    const state = {
      featureId: feature.id,
      vertices: [{ ring: 0, index: 0 }],
      startLngLat: START,
      initialCoordinates: initial,
    };

    const result = computeVertexMove(state, { lng: 2, lat: 3 }, feature) as Coordinate[][];

    // Moving the first vertex makes the closing point follow (the current semantics)
    expect(result[0][0]).toEqual([2, 3]);
    expect(result[0][4]).toEqual([2, 3]);
    expect(result).not.toBe(initial);
    expect(result[0]).not.toBe(initial[0]);
    // The vertices that did not move within the same ring, and the untouched inner
    // ring, share references
    expect(result[0][1]).toBe(initial[0][1]);
    expect(result[1]).toBe(initial[1]);
    expect(initial).toEqual(snapshot);
  });

  it('MultiLineString: only the target part becomes new, and the other parts share references', () => {
    const initial = [
      [
        [0, 0],
        [10, 0],
        [20, 0],
      ],
      [
        [0, 10],
        [10, 10],
      ],
    ] as Coordinate[][];
    const feature = makeFeature('MultiLineString', initial);
    const snapshot = structuredClone(initial);
    const state = {
      featureId: feature.id,
      vertices: [{ part: 1, ring: 0, index: 1 }],
      startLngLat: START,
      initialCoordinates: initial,
    };

    const result = computeVertexMove(state, { lng: 5, lat: 5 }, feature) as Coordinate[][];

    expect(result).not.toBe(initial);
    expect(result[0]).toBe(initial[0]);
    expect(result[1]).not.toBe(initial[1]);
    expect(result[1][0]).toBe(initial[1][0]);
    expect(result[1][1]).toEqual([15, 15]);
    expect(initial).toEqual(snapshot);
  });

  it('MultiPolygon: only the target ring of the target part becomes new', () => {
    const initial = makeMultiPolygonCoords();
    const feature = makeFeature('MultiPolygon', initial);
    const snapshot = structuredClone(initial);
    const state = {
      featureId: feature.id,
      vertices: [{ part: 0, ring: 1, index: 1 }],
      startLngLat: START,
      initialCoordinates: initial,
    };

    const result = computeVertexMove(state, { lng: 1, lat: 2 }, feature) as Coordinate[][][];

    expect(result).not.toBe(initial);
    // The untouched part shares its reference
    expect(result[1]).toBe(initial[1]);
    // The target part is a new array of rings, but the untouched outer ring shares its
    // reference
    expect(result[0]).not.toBe(initial[0]);
    expect(result[0][0]).toBe(initial[0][0]);
    expect(result[0][1]).not.toBe(initial[0][1]);
    expect(result[0][1][1]).toEqual([16, 7]);
    expect(result[0][1][0]).toBe(initial[0][1][0]);
    expect(initial).toEqual(snapshot);
  });

  it('MultiPoint: only the moved part becomes a new pair array', () => {
    const initial = [
      [0, 0],
      [10, 10],
      [20, 20],
    ] as Coordinate[];
    const feature = makeFeature('MultiPoint', initial);
    const snapshot = structuredClone(initial);
    const state = {
      featureId: feature.id,
      vertices: [{ part: 1, ring: 0, index: 0 }],
      startLngLat: START,
      initialCoordinates: initial,
    };

    const result = computeVertexMove(state, { lng: 1, lat: -1 }, feature) as Coordinate[];

    expect(result).not.toBe(initial);
    expect(result[0]).toBe(initial[0]);
    expect(result[1]).toEqual([11, 9]);
    expect(result[2]).toBe(initial[2]);
    expect(initial).toEqual(snapshot);
  });

  it('makes both of two consecutive movements absolute positions relative to initialCoordinates', () => {
    const initial = [
      [0, 0],
      [10, 10],
      [20, 20],
    ] as Coordinate[];
    const feature = makeLineString(initial);
    const state = {
      featureId: feature.id,
      vertices: [{ ring: 0, index: 1 }],
      startLngLat: START,
      initialCoordinates: initial,
    };

    const first = computeVertexMove(state, { lng: 1, lat: 1 }, feature) as Coordinate[];
    expect(first[1]).toEqual([11, 11]);

    // Even when the second movement arrives after the first result was written back to
    // the Store, it does not accumulate
    const second = computeVertexMove(
      state,
      { lng: 3, lat: -2 },
      { ...feature, geometry: geometryFromCoordinates(feature.type, first) },
    ) as Coordinate[];
    expect(second[1]).toEqual([13, 8]);

    // Neither the first result nor initialCoordinates is broken
    expect(first[1]).toEqual([11, 11]);
    expect(initial).toEqual([
      [0, 0],
      [10, 10],
      [20, 20],
    ]);
  });

  it('does not mutate the closing point of initialCoordinates even on consecutive movements of a closed ring', () => {
    const feature = makePolygonWithHole();
    const initial = coordinatesOf(feature) as Coordinate[][];
    const snapshot = structuredClone(initial);
    const state = {
      featureId: feature.id,
      vertices: [{ ring: 1, index: 4 }],
      startLngLat: START,
      initialCoordinates: initial,
    };

    const first = computeVertexMove(state, { lng: -1, lat: -1 }, feature) as Coordinate[][];
    expect(first[1][4]).toEqual([4, 4]);
    expect(first[1][0]).toEqual([4, 4]);

    const second = computeVertexMove(
      state,
      { lng: 2, lat: 2 },
      { ...feature, geometry: geometryFromCoordinates(feature.type, first) },
    ) as Coordinate[][];
    expect(second[1][4]).toEqual([7, 7]);
    expect(second[1][0]).toEqual([7, 7]);
    expect(first[1][4]).toEqual([4, 4]);
    expect(initial).toEqual(snapshot);
  });
});

// --- addVertex ---

describe('addVertex', () => {
  describe('LineString', () => {
    it('inserts at the beginning (at index 0, as the equivalent of afterIndex = -1)', () => {
      const feature = makeLineString([
        [0, 0],
        [10, 10],
      ]);
      // afterIndex=-1 -> splice(0, 0, newCoord) -> inserted at the beginning
      // Implementation: splice(afterIndex + 1, 0, newCoord)
      const result = addVertex(feature, { ring: 0, index: -1 }, [5, 5]) as Coordinate[];
      expect(result).toEqual([
        [5, 5],
        [0, 0],
        [10, 10],
      ]);
    });

    it('inserts in the middle', () => {
      const feature = makeLineString([
        [0, 0],
        [10, 10],
        [20, 20],
      ]);
      const result = addVertex(feature, { ring: 0, index: 0 }, [5, 5]) as Coordinate[];
      expect(result).toEqual([
        [0, 0],
        [5, 5],
        [10, 10],
        [20, 20],
      ]);
    });

    it('inserts at the end', () => {
      const feature = makeLineString([
        [0, 0],
        [10, 10],
      ]);
      const result = addVertex(feature, { ring: 0, index: 1 }, [20, 20]) as Coordinate[];
      expect(result).toEqual([
        [0, 0],
        [10, 10],
        [20, 20],
      ]);
    });

    it('does not add when a ring other than 0 is given', () => {
      const feature = makeLineString([
        [0, 0],
        [10, 10],
      ]);
      const result = addVertex(feature, { ring: 1, index: 0 }, [5, 5]) as Coordinate[];
      expect(result).toEqual([
        [0, 0],
        [10, 10],
      ]);
    });
  });

  describe('Polygon', () => {
    it('inserts into the outer ring', () => {
      const feature = makePolygon([
        [0, 0],
        [10, 0],
        [10, 10],
        [0, 0],
      ]);
      const result = addVertex(feature, { ring: 0, index: 1 }, [10, 5]) as Coordinate[][];
      expect(result[0]).toEqual([
        [0, 0],
        [10, 0],
        [10, 5],
        [10, 10],
        [0, 0],
      ]);
    });

    it('inserts into an inner ring (the outer ring does not change)', () => {
      const feature = makePolygonWithHole();
      const result = addVertex(feature, { ring: 1, index: 1 }, [15, 10]) as Coordinate[][];
      expect(result[1]).toEqual([
        [5, 5],
        [15, 5],
        [15, 10],
        [15, 15],
        [5, 15],
        [5, 5],
      ]);
      // The inner ring stays closed
      expect(result[1][0]).toEqual(result[1][result[1].length - 1]);
      expect(result[0]).toEqual([
        [0, 0],
        [20, 0],
        [20, 20],
        [0, 20],
        [0, 0],
      ]);
    });

    it('does not add for an out-of-range ring number', () => {
      const feature = makePolygonWithHole();
      const result = addVertex(feature, { ring: 3, index: 0 }, [1, 1]) as Coordinate[][];
      expect(result).toEqual(coordinatesOf(feature));
    });
  });

  describe('the other types', () => {
    it('returns the coordinates as they are', () => {
      const feature: Feature = {
        id: 'circle-1',
        type: 'Circle',
        geometry: { type: 'Point', coordinates: [5, 5] as Coordinate },
        layerId: 'layer-1',
        groupId: undefined,
        properties: {},
        locked: false,
        visible: true,
        style: {},
      };
      const result = addVertex(feature, { ring: 0, index: 0 }, [10, 10]);
      expect(result).toEqual([5, 5]);
    });
  });
});

// --- deleteVertex ---

describe('deleteVertex', () => {
  describe('LineString', () => {
    it('deletes an intermediate vertex', () => {
      const feature = makeLineString([
        [0, 0],
        [10, 10],
        [20, 20],
      ]);
      const result = deleteVertex(feature, { ring: 0, index: 1 }) as Coordinate[];
      expect(result).toEqual([
        [0, 0],
        [20, 20],
      ]);
    });

    it('deletes the first vertex', () => {
      const feature = makeLineString([
        [0, 0],
        [10, 10],
        [20, 20],
      ]);
      const result = deleteVertex(feature, { ring: 0, index: 0 }) as Coordinate[];
      expect(result).toEqual([
        [10, 10],
        [20, 20],
      ]);
    });

    it('deletes the last vertex', () => {
      const feature = makeLineString([
        [0, 0],
        [10, 10],
        [20, 20],
      ]);
      const result = deleteVertex(feature, { ring: 0, index: 2 }) as Coordinate[];
      expect(result).toEqual([
        [0, 0],
        [10, 10],
      ]);
    });

    it('returns null when there are only 2 points', () => {
      const feature = makeLineString([
        [0, 0],
        [10, 10],
      ]);
      expect(deleteVertex(feature, { ring: 0, index: 0 })).toBeNull();
    });

    it('returns null when a ring other than 0 is given', () => {
      const feature = makeLineString([
        [0, 0],
        [10, 10],
        [20, 20],
      ]);
      expect(deleteVertex(feature, { ring: 1, index: 1 })).toBeNull();
    });
  });

  describe('Polygon (a closed ring)', () => {
    it('deletes a vertex', () => {
      const feature = makePolygon([
        [0, 0],
        [10, 0],
        [10, 10],
        [0, 10],
        [0, 0],
      ]);
      const result = deleteVertex(feature, { ring: 0, index: 2 }) as Coordinate[][];
      expect(result[0]).toEqual([
        [0, 0],
        [10, 0],
        [0, 10],
        [0, 0],
      ]);
    });

    it('returns null at or below the minimum vertex count (4 points: a closed ring)', () => {
      const feature = makePolygon([
        [0, 0],
        [10, 0],
        [10, 10],
        [0, 0],
      ]);
      expect(deleteVertex(feature, { ring: 0, index: 1 })).toBeNull();
    });

    it('synchronizes the last vertex when the first one is deleted', () => {
      const feature = makePolygon([
        [0, 0],
        [10, 0],
        [10, 10],
        [0, 10],
        [0, 0],
      ]);
      const result = deleteVertex(feature, { ring: 0, index: 0 }) as Coordinate[][];
      // After the deletion: [10,0], [10,10], [0,10], [0,0] -> the last point is
      // synchronized to the first one
      expect(result[0][result[0].length - 1]).toEqual(result[0][0]);
    });

    it('refuses to delete the closing point (the duplicated index at the end), so the ring is not broken', () => {
      const feature = makePolygon([
        [0, 0],
        [10, 0],
        [10, 10],
        [0, 10],
        [0, 0],
      ]);
      // index=4 (the closing point at the end = a copy of the first one) is not an
      // independent vertex, so it cannot be deleted
      expect(deleteVertex(feature, { ring: 0, index: 4 })).toBeNull();
    });

    it('keeps the ring closed even when the last real vertex is deleted', () => {
      const feature = makePolygon([
        [0, 0],
        [10, 0],
        [10, 10],
        [0, 10],
        [0, 0],
      ]);
      // Delete index=3 ([0,10])
      const result = deleteVertex(feature, { ring: 0, index: 3 }) as Coordinate[][];
      expect(result[0]).toEqual([
        [0, 0],
        [10, 0],
        [10, 10],
        [0, 0],
      ]);
      expect(result[0][0]).toEqual(result[0][result[0].length - 1]);
    });
  });

  describe('Polygon (an inner ring)', () => {
    it('deletes a vertex of an inner ring (the outer ring does not change)', () => {
      const feature = makePolygonWithHole();
      const result = deleteVertex(feature, { ring: 1, index: 2 }) as Coordinate[][];
      expect(result[1]).toEqual([
        [5, 5],
        [15, 5],
        [5, 15],
        [5, 5],
      ]);
      expect(result[1][0]).toEqual(result[1][result[1].length - 1]);
      expect(result[0]).toEqual([
        [0, 0],
        [20, 0],
        [20, 20],
        [0, 20],
        [0, 0],
      ]);
    });

    it('rebuilds the inner ring and keeps it closed when its first vertex is deleted', () => {
      const feature = makePolygonWithHole();
      const result = deleteVertex(feature, { ring: 1, index: 0 }) as Coordinate[][];
      expect(result[1]).toEqual([
        [15, 5],
        [15, 15],
        [5, 15],
        [15, 5],
      ]);
      expect(result[1][0]).toEqual(result[1][result[1].length - 1]);
    });

    it('refuses to delete the closing point of an inner ring', () => {
      const feature = makePolygonWithHole();
      expect(deleteVertex(feature, { ring: 1, index: 4 })).toBeNull();
    });

    it('returns null when the inner ring is at the minimum vertex count (the outer ring is unaffected)', () => {
      const feature = makePolygon(
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
          [5, 5],
        ],
      );
      expect(deleteVertex(feature, { ring: 1, index: 1 })).toBeNull();
      // The outer ring is above the minimum vertex count, so a vertex can be deleted
      expect(deleteVertex(feature, { ring: 0, index: 1 })).not.toBeNull();
    });

    it('returns null for an out-of-range ring number', () => {
      const feature = makePolygonWithHole();
      expect(deleteVertex(feature, { ring: 2, index: 0 })).toBeNull();
      expect(deleteVertex(feature, { ring: -1, index: 0 })).toBeNull();
    });
  });

  describe('Point', () => {
    it('returns null (a vertex cannot be deleted)', () => {
      const feature = makePoint([5, 5]);
      expect(deleteVertex(feature, { ring: 0, index: 0 })).toBeNull();
    });
  });
});

// --- The copy-on-write of addVertex / deleteVertex ---

describe('the copy-on-write of addVertex / deleteVertex', () => {
  function makeFeature(type: Feature['type'], coordinates: FeatureCoordinates): Feature {
    return {
      id: `${type}-cow`,
      type,
      geometry: geometryFromCoordinates(type, coordinates),
      layerId: 'layer-1',
      groupId: undefined,
      properties: {},
      locked: false,
      visible: true,
      style: {},
    };
  }

  /** The coordinate sequence of a LineString with many vertices */
  function makeLongLine(count: number): Coordinate[] {
    return Array.from({ length: count }, (_, i) => [i, i] as Coordinate);
  }

  /** Part 0 is a square with a hole and part 1 is a separate triangle */
  function makeMultiPolygonCoords(): Coordinate[][][] {
    return [
      [
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
  }

  describe('addVertex', () => {
    it('LineString: the other vertices share references after an insertion, and the input is not mutated', () => {
      const initial = makeLongLine(100);
      const feature = makeLineString(initial);
      const snapshot = structuredClone(initial);

      const result = addVertex(feature, { ring: 0, index: 49 }, [1.5, 1.5]) as Coordinate[];

      expect(result).not.toBe(initial);
      expect(result).toHaveLength(101);
      expect(result[50]).toEqual([1.5, 1.5]);
      // The existing coordinate pairs share references, including the ones before and
      // after the insertion point
      expect(result[0]).toBe(initial[0]);
      expect(result[49]).toBe(initial[49]);
      expect(result[51]).toBe(initial[50]);
      expect(result[100]).toBe(initial[99]);
      expect(initial).toHaveLength(100);
      expect(initial).toEqual(snapshot);
    });

    it('Polygon: only the target ring becomes new, and the untouched inner ring shares its reference', () => {
      const feature = makePolygonWithHole();
      const initial = coordinatesOf(feature) as Coordinate[][];
      const snapshot = structuredClone(initial);

      const result = addVertex(feature, { ring: 0, index: 0 }, [10, 0]) as Coordinate[][];

      expect(result).not.toBe(initial);
      expect(result[0]).not.toBe(initial[0]);
      expect(result[0][1]).toEqual([10, 0]);
      expect(result[0][0]).toBe(initial[0][0]);
      expect(result[0][2]).toBe(initial[0][1]);
      expect(result[1]).toBe(initial[1]);
      expect(initial).toEqual(snapshot);
    });

    it('MultiLineString: only the target part becomes new, and the other parts share references', () => {
      const initial = [
        [
          [0, 0],
          [10, 0],
        ],
        [
          [0, 10],
          [10, 10],
        ],
      ] as Coordinate[][];
      const feature = makeFeature('MultiLineString', initial);
      const snapshot = structuredClone(initial);

      const result = addVertex(feature, { part: 1, ring: 0, index: 0 }, [5, 10]) as Coordinate[][];

      expect(result).not.toBe(initial);
      expect(result[0]).toBe(initial[0]);
      expect(result[1]).not.toBe(initial[1]);
      expect(result[1][1]).toEqual([5, 10]);
      expect(result[1][0]).toBe(initial[1][0]);
      expect(result[1][2]).toBe(initial[1][1]);
      expect(initial).toEqual(snapshot);
    });

    it('MultiPolygon: only the target ring of the target part becomes new', () => {
      const initial = makeMultiPolygonCoords();
      const feature = makeFeature('MultiPolygon', initial);
      const snapshot = structuredClone(initial);

      const result = addVertex(
        feature,
        { part: 0, ring: 1, index: 0 },
        [10, 5],
      ) as Coordinate[][][];

      expect(result).not.toBe(initial);
      expect(result[1]).toBe(initial[1]);
      expect(result[0]).not.toBe(initial[0]);
      expect(result[0][0]).toBe(initial[0][0]);
      expect(result[0][1]).not.toBe(initial[0][1]);
      expect(result[0][1][1]).toEqual([10, 5]);
      expect(result[0][1][0]).toBe(initial[0][1][0]);
      expect(initial).toEqual(snapshot);
    });

    it('returns a new top-level array even on a branch that does not change the coordinates', () => {
      const initial = [
        [0, 0],
        [10, 10],
      ] as Coordinate[];
      const feature = makeLineString(initial);

      // The branch that adds nothing for a ring other than 0
      const result = addVertex(feature, { ring: 1, index: 0 }, [5, 5]) as Coordinate[];

      expect(result).not.toBe(initial);
      expect(result).toEqual(initial);
      expect(result[0]).toBe(initial[0]);
    });

    it('MultiPolygon: returns a new top-level array even for an out-of-range ring', () => {
      const initial = makeMultiPolygonCoords();
      const feature = makeFeature('MultiPolygon', initial);

      const result = addVertex(feature, { part: 1, ring: 5, index: 0 }, [5, 5]) as Coordinate[][][];

      expect(result).not.toBe(initial);
      expect(result[0]).toBe(initial[0]);
      expect(result[1]).toBe(initial[1]);
    });
  });

  describe('deleteVertex', () => {
    it('LineString: the other vertices share references after a deletion, and the input is not mutated', () => {
      const initial = makeLongLine(100);
      const feature = makeLineString(initial);
      const snapshot = structuredClone(initial);

      const result = deleteVertex(feature, { ring: 0, index: 50 }) as Coordinate[];

      expect(result).not.toBe(initial);
      expect(result).toHaveLength(99);
      expect(result[49]).toBe(initial[49]);
      expect(result[50]).toBe(initial[51]);
      expect(initial).toHaveLength(100);
      expect(initial).toEqual(snapshot);
    });

    it('Polygon: only the target ring becomes new, and the untouched inner ring shares its reference', () => {
      const feature = makePolygonWithHole();
      const initial = coordinatesOf(feature) as Coordinate[][];
      const snapshot = structuredClone(initial);

      const result = deleteVertex(feature, { ring: 0, index: 1 }) as Coordinate[][];

      expect(result).not.toBe(initial);
      expect(result[0]).not.toBe(initial[0]);
      expect(result[0]).toHaveLength(4);
      expect(result[0][1]).toBe(initial[0][2]);
      expect(result[1]).toBe(initial[1]);
      expect(initial).toEqual(snapshot);
    });

    it('Polygon: does not mutate the coordinate pairs of the input even when the closing point is synchronized after the first vertex is deleted', () => {
      const feature = makePolygonWithHole();
      const initial = coordinatesOf(feature) as Coordinate[][];
      const snapshot = structuredClone(initial);

      const result = deleteVertex(feature, { ring: 0, index: 0 }) as Coordinate[][];

      // The closing point is synchronized to the new first vertex [20, 0]
      expect(result[0][0]).toEqual([20, 0]);
      expect(result[0][result[0].length - 1]).toEqual([20, 0]);
      // The closing point is a new pair array (it does not share with the first one)
      expect(result[0][result[0].length - 1]).not.toBe(result[0][0]);
      expect(initial).toEqual(snapshot);
    });

    it('MultiLineString: only the target part becomes new, and the other parts share references', () => {
      const initial = [
        [
          [0, 0],
          [10, 0],
          [20, 0],
        ],
        [
          [0, 10],
          [10, 10],
          [20, 10],
        ],
      ] as Coordinate[][];
      const feature = makeFeature('MultiLineString', initial);
      const snapshot = structuredClone(initial);

      const result = deleteVertex(feature, { part: 1, ring: 0, index: 1 }) as Coordinate[][];

      expect(result).not.toBe(initial);
      expect(result[0]).toBe(initial[0]);
      expect(result[1]).not.toBe(initial[1]);
      expect(result[1]).toHaveLength(2);
      expect(result[1][0]).toBe(initial[1][0]);
      expect(result[1][1]).toBe(initial[1][2]);
      expect(initial).toEqual(snapshot);
    });

    it('MultiPolygon: only the target ring of the target part becomes new', () => {
      const initial = makeMultiPolygonCoords();
      const feature = makeFeature('MultiPolygon', initial);
      const snapshot = structuredClone(initial);

      const result = deleteVertex(feature, { part: 0, ring: 1, index: 1 }) as Coordinate[][][];

      expect(result).not.toBe(initial);
      expect(result[1]).toBe(initial[1]);
      expect(result[0]).not.toBe(initial[0]);
      expect(result[0][0]).toBe(initial[0][0]);
      expect(result[0][1]).not.toBe(initial[0][1]);
      expect(result[0][1]).toHaveLength(4);
      expect(result[0][1][1]).toBe(initial[0][1][2]);
      expect(initial).toEqual(snapshot);
    });

    it('MultiPoint: removes only the target part, and the other parts share references', () => {
      const initial = [
        [0, 0],
        [10, 10],
        [20, 20],
      ] as Coordinate[];
      const feature = makeFeature('MultiPoint', initial);
      const snapshot = structuredClone(initial);

      const result = deleteVertex(feature, { part: 1, ring: 0, index: 0 }) as Coordinate[];

      expect(result).not.toBe(initial);
      expect(result).toHaveLength(2);
      expect(result[0]).toBe(initial[0]);
      expect(result[1]).toBe(initial[2]);
      expect(initial).toEqual(snapshot);
    });

    it('returns null without touching the input for a reference that cannot be deleted', () => {
      const initial = makeMultiPolygonCoords();
      const feature = makeFeature('MultiPolygon', initial);
      const snapshot = structuredClone(initial);

      // The triangle of part 1 is at the minimum vertex count, so nothing can be deleted
      // from it
      expect(deleteVertex(feature, { part: 1, ring: 0, index: 0 })).toBeNull();
      expect(deleteVertex(feature, { part: 5, ring: 0, index: 0 })).toBeNull();
      expect(initial).toEqual(snapshot);
    });

    it('mutates neither the previous result nor the input on consecutive deletions', () => {
      const initial = makeLongLine(10);
      const feature = makeLineString(initial);

      const first = deleteVertex(feature, { ring: 0, index: 0 }) as Coordinate[];
      const second = deleteVertex(
        { ...feature, geometry: geometryFromCoordinates(feature.type, first) },
        {
          ring: 0,
          index: 0,
        },
      ) as Coordinate[];

      expect(first).toHaveLength(9);
      expect(first[0]).toEqual([1, 1]);
      expect(second).toHaveLength(8);
      expect(second[0]).toEqual([2, 2]);
      expect(initial).toHaveLength(10);
      expect(initial[0]).toEqual([0, 0]);
    });
  });
});

// --- startVertexMove ---

describe('startVertexMove', () => {
  const lngLat = { lng: 1, lat: 2 };

  describe('LineString', () => {
    it('returns a VertexState for a valid index', () => {
      const feature = makeLineString([
        [0, 0],
        [10, 10],
        [20, 20],
      ]);
      const result = startVertexMove(
        feature,
        [
          { ring: 0, index: 0 },
          { ring: 0, index: 2 },
        ],
        lngLat,
      );
      expect(result).not.toBeNull();
      expect(result!.featureId).toBe('line-1');
      expect(result!.vertices).toEqual([
        { ring: 0, index: 0 },
        { ring: 0, index: 2 },
      ]);
      expect(result!.startLngLat).toEqual(lngLat);
      expect(result!.initialCoordinates).toEqual(coordinatesOf(feature));
    });

    it('returns null for an invalid index', () => {
      const feature = makeLineString([
        [0, 0],
        [10, 10],
      ]);
      expect(startVertexMove(feature, [{ ring: 0, index: 5 }], lngLat)).toBeNull();
    });

    it('returns null for a negative index', () => {
      const feature = makeLineString([
        [0, 0],
        [10, 10],
      ]);
      expect(startVertexMove(feature, [{ ring: 0, index: -1 }], lngLat)).toBeNull();
    });

    it('returns null for a ring other than 0', () => {
      const feature = makeLineString([
        [0, 0],
        [10, 10],
      ]);
      expect(startVertexMove(feature, [{ ring: 1, index: 0 }], lngLat)).toBeNull();
    });
  });

  it('returns null for an empty vertices', () => {
    const feature = makeLineString([
      [0, 0],
      [10, 10],
    ]);
    expect(startVertexMove(feature, [], lngLat)).toBeNull();
  });

  describe('Point', () => {
    it('makes only ring 0 / index 0 valid', () => {
      const feature = makePoint([5, 5]);
      const result = startVertexMove(feature, [{ ring: 0, index: 0 }], lngLat);
      expect(result).not.toBeNull();
      expect(result!.featureId).toBe('point-1');
    });

    it('returns null for an index other than 0', () => {
      const feature = makePoint([5, 5]);
      expect(startVertexMove(feature, [{ ring: 0, index: 1 }], lngLat)).toBeNull();
    });

    it('returns null for several indices', () => {
      const feature = makePoint([5, 5]);
      expect(
        startVertexMove(
          feature,
          [
            { ring: 0, index: 0 },
            { ring: 0, index: 1 },
          ],
          lngLat,
        ),
      ).toBeNull();
    });
  });

  describe('Polygon', () => {
    it('returns a VertexState for a valid index', () => {
      const feature = makePolygon([
        [0, 0],
        [10, 0],
        [10, 10],
        [0, 0],
      ]);
      const result = startVertexMove(feature, [{ ring: 0, index: 1 }], lngLat);
      expect(result).not.toBeNull();
      expect(result!.vertices).toEqual([{ ring: 0, index: 1 }]);
    });

    it('accepts a vertex reference of an inner ring', () => {
      const feature = makePolygonWithHole();
      const result = startVertexMove(feature, [{ ring: 1, index: 3 }], lngLat);
      expect(result).not.toBeNull();
      expect(result!.vertices).toEqual([{ ring: 1, index: 3 }]);
    });

    it('returns null for an out-of-range index of an inner ring', () => {
      const feature = makePolygonWithHole();
      expect(startVertexMove(feature, [{ ring: 1, index: 10 }], lngLat)).toBeNull();
    });

    it('returns null for an out-of-range ring number', () => {
      const feature = makePolygonWithHole();
      expect(startVertexMove(feature, [{ ring: 2, index: 0 }], lngLat)).toBeNull();
    });

    it('returns null for an out-of-range index', () => {
      const feature = makePolygon([
        [0, 0],
        [10, 0],
        [10, 10],
        [0, 0],
      ]);
      expect(startVertexMove(feature, [{ ring: 0, index: 10 }], lngLat)).toBeNull();
    });

    it('returns null for an empty ring', () => {
      const feature: Feature = {
        id: 'polygon-empty',
        type: 'Polygon',
        geometry: { type: 'Polygon', coordinates: [] },
        layerId: 'layer-1',
        groupId: undefined,
        properties: {},
        locked: false,
        visible: true,
        style: {},
      };
      expect(startVertexMove(feature, [{ ring: 0, index: 0 }], lngLat)).toBeNull();
    });
  });

  describe('unsupported types', () => {
    it('returns null', () => {
      const feature: Feature = {
        id: 'circle-1',
        type: 'Circle',
        geometry: { type: 'Point', coordinates: [5, 5] as Coordinate },
        layerId: 'layer-1',
        groupId: undefined,
        properties: {},
        locked: false,
        visible: true,
        style: {},
      };
      expect(startVertexMove(feature, [{ ring: 0, index: 0 }], lngLat)).toBeNull();
    });
  });

  it('makes initialCoordinates a reference to the original coordinates (it does not copy them)', () => {
    const coords: Coordinate[] = [
      [0, 0],
      [10, 10],
    ];
    const feature = makeLineString(coords);
    const result = startVertexMove(feature, [{ ring: 0, index: 0 }], lngLat);
    expect(result).not.toBeNull();
    // Coordinates follow the convention of immutable updates, so a reference is enough
    // for the snapshot at the start
    expect(result!.initialCoordinates).toBe(coordinatesOf(feature));
  });

  it('makes vertices a copy of the original array', () => {
    const feature = makeLineString([
      [0, 0],
      [10, 10],
    ]);
    const refs = [{ ring: 0, index: 0 }];
    const result = startVertexMove(feature, refs, lngLat);
    refs.push({ ring: 0, index: 999 });
    expect(result!.vertices).toEqual([{ ring: 0, index: 0 }]);
  });

  it('copies each element of vertices as well', () => {
    const feature = makeLineString([
      [0, 0],
      [10, 10],
    ]);
    const refs = [{ ring: 0, index: 0 }];
    const result = startVertexMove(feature, refs, lngLat);
    refs[0].index = 1;
    expect(result!.vertices).toEqual([{ ring: 0, index: 0 }]);
  });
});
