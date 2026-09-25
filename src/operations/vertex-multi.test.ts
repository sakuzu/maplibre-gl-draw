// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for vertex operations on Multi geometries
 *
 * The Multi variants point to a vertex by a part number + a ring number + a vertex
 * index. These tests verify that "the parts are independent of each other" (editing
 * one part does not affect the coordinates or the indices of the other parts) and
 * that the tests for the minimum vertex count and for a closed ring are done per
 * part (per part and ring for a MultiPolygon).
 */

import { describe, expect, it } from 'vitest';
import type { Coordinate, Feature, FeatureType, VertexRef } from '../store/types.js';
import type { VertexState } from './vertex.js';
import {
  addVertex,
  computeVertexMove,
  deleteVertex,
  sortVertexRefsForDeletion,
  startVertexMove,
} from './vertex.js';

// --- Helpers ---

function makeFeature(type: FeatureType, coordinates: Feature['coordinates']): Feature {
  return {
    id: `${type}-1`,
    type,
    coordinates,
    layerId: 'layer-1',
    properties: {},
    locked: false,
    visible: true,
  };
}

/** A MultiLineString with 2 lines (part 0 has 3 points, part 1 has 2 points) */
function makeMultiLineString(): Feature {
  return makeFeature('MultiLineString', [
    [
      [0, 0],
      [10, 0],
      [20, 0],
    ],
    [
      [0, 10],
      [10, 10],
    ],
  ] as Coordinate[][]);
}

/** A MultiPolygon whose part 0 is a square with a hole and whose part 1 is a separate
 * triangle */
function makeMultiPolygon(): Feature {
  return makeFeature('MultiPolygon', [
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
  ] as Coordinate[][][]);
}

/** A MultiPoint with 3 coordinates */
function makeMultiPoint(): Feature {
  return makeFeature('MultiPoint', [
    [0, 0],
    [10, 10],
    [20, 20],
  ] as Coordinate[]);
}

const START = { lng: 0, lat: 0 };

/** Gets the result of a movement through startVertexMove (verified in the same order
 * as the real path) */
function moveVertices(
  feature: Feature,
  refs: VertexRef[],
  delta: { lng: number; lat: number },
): Feature['coordinates'] {
  const state = startVertexMove(feature, refs, START);
  expect(state).not.toBeNull();
  return computeVertexMove(state as VertexState, delta, feature);
}

/**
 * Applies the deletion of several vertices in the same procedure as the caller (the
 * Selection API / a keyboard shortcut).
 * They are sorted with sortVertexRefsForDeletion and then deleteVertex is applied one
 * at a time.
 */
function deleteVertices(
  feature: Feature,
  refs: VertexRef[],
): { coordinates: Feature['coordinates']; deletedCount: number } {
  let coordinates: Feature['coordinates'] = JSON.parse(JSON.stringify(feature.coordinates));
  let deletedCount = 0;

  for (const ref of sortVertexRefsForDeletion(refs)) {
    const result = deleteVertex({ ...feature, coordinates }, ref);
    if (result !== null) {
      coordinates = result;
      deletedCount++;
    }
  }

  return { coordinates, deletedCount };
}

// --- sortVertexRefsForDeletion ---

describe('sortVertexRefsForDeletion', () => {
  it('sorts in descending lexicographic order of (part, ring, index)', () => {
    const refs: VertexRef[] = [
      { part: 0, ring: 0, index: 1 },
      { part: 1, ring: 1, index: 0 },
      { part: 0, ring: 1, index: 2 },
      { part: 1, ring: 0, index: 5 },
      { part: 0, ring: 0, index: 3 },
    ];

    expect(sortVertexRefsForDeletion(refs)).toEqual([
      { part: 1, ring: 1, index: 0 },
      { part: 1, ring: 0, index: 5 },
      { part: 0, ring: 1, index: 2 },
      { part: 0, ring: 0, index: 3 },
      { part: 0, ring: 0, index: 1 },
    ]);
  });

  it('sorts an omitted part as part 0', () => {
    const refs: VertexRef[] = [
      { ring: 0, index: 1 },
      { part: 2, ring: 0, index: 0 },
      { ring: 0, index: 4 },
    ];

    expect(sortVertexRefsForDeletion(refs)).toEqual([
      { part: 2, ring: 0, index: 0 },
      { ring: 0, index: 4 },
      { ring: 0, index: 1 },
    ]);
  });

  it('does not destroy the input array', () => {
    const refs: VertexRef[] = [
      { ring: 0, index: 1 },
      { ring: 0, index: 4 },
    ];
    sortVertexRefsForDeletion(refs);
    expect(refs).toEqual([
      { ring: 0, index: 1 },
      { ring: 0, index: 4 },
    ]);
  });
});

// --- MultiLineString ---

describe('vertex operations on a MultiLineString', () => {
  it('moves only the vertices of the given part', () => {
    const feature = makeMultiLineString();
    const result = moveVertices(feature, [{ part: 1, ring: 0, index: 0 }], {
      lng: 3,
      lat: -2,
    }) as Coordinate[][];

    // Only the first vertex of part 1 moves
    expect(result[1]).toEqual([
      [3, 8],
      [10, 10],
    ]);
    // Part 0 is unchanged
    expect(result[0]).toEqual([
      [0, 0],
      [10, 0],
      [20, 0],
    ]);
  });

  it('can move several vertices across parts at once', () => {
    const feature = makeMultiLineString();
    const result = moveVertices(
      feature,
      [
        { part: 0, ring: 0, index: 2 },
        { part: 1, ring: 0, index: 1 },
      ],
      { lng: 1, lat: 1 },
    ) as Coordinate[][];

    expect(result[0]).toEqual([
      [0, 0],
      [10, 0],
      [21, 1],
    ]);
    expect(result[1]).toEqual([
      [0, 10],
      [11, 11],
    ]);
  });

  it('treats a reference with the part number omitted as part 0', () => {
    const feature = makeMultiLineString();
    const result = moveVertices(feature, [{ ring: 0, index: 0 }], {
      lng: 5,
      lat: 5,
    }) as Coordinate[][];

    expect(result[0][0]).toEqual([5, 5]);
    expect(result[1][0]).toEqual([0, 10]);
  });

  it('makes startVertexMove refuse an out-of-range part or a ring other than 0', () => {
    const feature = makeMultiLineString();
    expect(startVertexMove(feature, [{ part: 2, ring: 0, index: 0 }], START)).toBeNull();
    expect(startVertexMove(feature, [{ part: 0, ring: 1, index: 0 }], START)).toBeNull();
    expect(startVertexMove(feature, [{ part: 0, ring: 0, index: 3 }], START)).toBeNull();
  });

  it('adds a vertex to the given part (the indices of the other parts do not shift)', () => {
    const feature = makeMultiLineString();
    const result = addVertex(feature, { part: 0, ring: 0, index: 0 }, [5, 5]) as Coordinate[][];

    expect(result[0]).toEqual([
      [0, 0],
      [5, 5],
      [10, 0],
      [20, 0],
    ]);
    expect(result[1]).toEqual([
      [0, 10],
      [10, 10],
    ]);
  });

  it('does not change the coordinates when adding to an out-of-range part', () => {
    const feature = makeMultiLineString();
    expect(addVertex(feature, { part: 5, ring: 0, index: 0 }, [5, 5])).toEqual(feature.coordinates);
    expect(addVertex(feature, { part: 0, ring: 1, index: 0 }, [5, 5])).toEqual(feature.coordinates);
  });

  it('deletes a vertex of the given part (the other parts are unchanged)', () => {
    const feature = makeMultiLineString();
    const result = deleteVertex(feature, { part: 0, ring: 0, index: 1 }) as Coordinate[][];

    expect(result[0]).toEqual([
      [0, 0],
      [20, 0],
    ]);
    expect(result[1]).toEqual([
      [0, 10],
      [10, 10],
    ]);
  });

  it('refuses to delete from a part at the minimum vertex count (2 points), while the other parts can be deleted from', () => {
    const feature = makeMultiLineString();
    // Part 1 has only 2 points, so nothing can be deleted from it
    expect(deleteVertex(feature, { part: 1, ring: 0, index: 0 })).toBeNull();
    // Part 0 has 3 points, so a vertex can be deleted from it
    expect(deleteVertex(feature, { part: 0, ring: 0, index: 0 })).not.toBeNull();
  });

  it('returns null when deleting from an out-of-range part or from a ring other than 0', () => {
    const feature = makeMultiLineString();
    expect(deleteVertex(feature, { part: 2, ring: 0, index: 0 })).toBeNull();
    expect(deleteVertex(feature, { part: -1, ring: 0, index: 0 })).toBeNull();
    expect(deleteVertex(feature, { part: 0, ring: 1, index: 0 })).toBeNull();
  });
});

// --- MultiPolygon ---

describe('vertex operations on a MultiPolygon', () => {
  it('moves only the vertices of the inner ring of the given part', () => {
    const feature = makeMultiPolygon();
    const result = moveVertices(feature, [{ part: 0, ring: 1, index: 1 }], {
      lng: 1,
      lat: 2,
    }) as Coordinate[][][];

    expect(result[0][1]).toEqual([
      [5, 5],
      [16, 7],
      [15, 15],
      [5, 15],
      [5, 5],
    ]);
    // The outer ring of the same part is unchanged
    expect(result[0][0]).toEqual([
      [0, 0],
      [20, 0],
      [20, 20],
      [0, 20],
      [0, 0],
    ]);
    // The other part is unchanged as well
    expect(result[1][0]).toEqual([
      [100, 100],
      [110, 100],
      [110, 110],
      [100, 100],
    ]);
  });

  it('keeps each part closed (moving the first vertex makes the last one follow)', () => {
    const feature = makeMultiPolygon();
    const result = moveVertices(feature, [{ part: 1, ring: 0, index: 0 }], {
      lng: 5,
      lat: 5,
    }) as Coordinate[][][];

    expect(result[1][0]).toEqual([
      [105, 105],
      [110, 100],
      [110, 110],
      [105, 105],
    ]);
    expect(result[1][0][0]).toEqual(result[1][0][result[1][0].length - 1]);
    // The closed ring of the other part is unaffected
    expect(result[0][0][0]).toEqual(result[0][0][result[0][0].length - 1]);
    expect(result[0][0][0]).toEqual([0, 0]);
  });

  it('closes only the inner ring again when the first vertex of the inner ring is moved', () => {
    const feature = makeMultiPolygon();
    const result = moveVertices(feature, [{ part: 0, ring: 1, index: 0 }], {
      lng: -1,
      lat: -1,
    }) as Coordinate[][][];

    expect(result[0][1][0]).toEqual([4, 4]);
    expect(result[0][1][result[0][1].length - 1]).toEqual([4, 4]);
    expect(result[0][0][0]).toEqual([0, 0]);
  });

  it('adds a vertex to the given part and the given ring', () => {
    const feature = makeMultiPolygon();
    const result = addVertex(
      feature,
      { part: 1, ring: 0, index: 0 },
      [105, 95],
    ) as Coordinate[][][];

    expect(result[1][0]).toEqual([
      [100, 100],
      [105, 95],
      [110, 100],
      [110, 110],
      [100, 100],
    ]);
    // The other part is unchanged
    expect(result[0][0]).toHaveLength(5);
  });

  it('does not change the coordinates when adding to an out-of-range part or ring', () => {
    const feature = makeMultiPolygon();
    expect(addVertex(feature, { part: 2, ring: 0, index: 0 }, [0, 0])).toEqual(feature.coordinates);
    expect(addVertex(feature, { part: 1, ring: 1, index: 0 }, [0, 0])).toEqual(feature.coordinates);
  });

  it('keeps the ring closed even when a vertex of the inner ring of the given part is deleted', () => {
    const feature = makeMultiPolygon();
    const result = deleteVertex(feature, { part: 0, ring: 1, index: 0 }) as Coordinate[][][];

    expect(result[0][1]).toEqual([
      [15, 5],
      [15, 15],
      [5, 15],
      [15, 5],
    ]);
    expect(result[0][1][0]).toEqual(result[0][1][result[0][1].length - 1]);
    // The outer ring and the other part are unchanged
    expect(result[0][0]).toHaveLength(5);
    expect(result[1][0]).toHaveLength(4);
  });

  it('tests the minimum vertex count per part and ring', () => {
    const feature = makeMultiPolygon();
    // Part 1 is a closed triangle (4 points = the minimum), so nothing can be deleted
    // from it
    expect(deleteVertex(feature, { part: 1, ring: 0, index: 0 })).toBeNull();
    // The outer ring of part 0 has 5 points, so a vertex can be deleted from it
    expect(deleteVertex(feature, { part: 0, ring: 0, index: 1 })).not.toBeNull();
  });

  it('refuses to delete the closing point (the last vertex)', () => {
    const feature = makeMultiPolygon();
    expect(deleteVertex(feature, { part: 0, ring: 0, index: 4 })).toBeNull();
  });

  it('returns null when deleting an out-of-range part or ring', () => {
    const feature = makeMultiPolygon();
    expect(deleteVertex(feature, { part: 2, ring: 0, index: 0 })).toBeNull();
    expect(deleteVertex(feature, { part: 0, ring: 2, index: 0 })).toBeNull();
  });

  it('makes startVertexMove refuse an out-of-range part, ring or index', () => {
    const feature = makeMultiPolygon();
    expect(startVertexMove(feature, [{ part: 2, ring: 0, index: 0 }], START)).toBeNull();
    expect(startVertexMove(feature, [{ part: 1, ring: 1, index: 0 }], START)).toBeNull();
    expect(startVertexMove(feature, [{ part: 0, ring: 1, index: 5 }], START)).toBeNull();
  });
});

// --- MultiPoint ---

describe('vertex operations on a MultiPoint', () => {
  it('moves only the coordinate of the given part', () => {
    const feature = makeMultiPoint();
    const result = moveVertices(feature, [{ part: 1, ring: 0, index: 0 }], {
      lng: 5,
      lat: -5,
    }) as Coordinate[];

    expect(result).toEqual([
      [0, 0],
      [15, 5],
      [20, 20],
    ]);
  });

  it('can move several parts at once', () => {
    const feature = makeMultiPoint();
    const result = moveVertices(
      feature,
      [
        { part: 0, ring: 0, index: 0 },
        { part: 2, ring: 0, index: 0 },
      ],
      { lng: 1, lat: 1 },
    ) as Coordinate[];

    expect(result).toEqual([
      [1, 1],
      [10, 10],
      [21, 21],
    ]);
  });

  it('makes startVertexMove refuse a reference whose ring / index is not 0', () => {
    const feature = makeMultiPoint();
    expect(startVertexMove(feature, [{ part: 0, ring: 1, index: 0 }], START)).toBeNull();
    expect(startVertexMove(feature, [{ part: 0, ring: 0, index: 1 }], START)).toBeNull();
    expect(startVertexMove(feature, [{ part: 3, ring: 0, index: 0 }], START)).toBeNull();
  });

  it('makes deleting a vertex remove the part', () => {
    const feature = makeMultiPoint();
    const result = deleteVertex(feature, { part: 1, ring: 0, index: 0 }) as Coordinate[];

    expect(result).toEqual([
      [0, 0],
      [20, 20],
    ]);
  });

  it('refuses to delete the last remaining part', () => {
    const feature = makeFeature('MultiPoint', [[0, 0]] as Coordinate[]);
    expect(deleteVertex(feature, { part: 0, ring: 0, index: 0 })).toBeNull();
  });

  it('returns null when deleting an out-of-range part, ring or index', () => {
    const feature = makeMultiPoint();
    expect(deleteVertex(feature, { part: 3, ring: 0, index: 0 })).toBeNull();
    expect(deleteVertex(feature, { part: 0, ring: 1, index: 0 })).toBeNull();
    expect(deleteVertex(feature, { part: 0, ring: 0, index: 1 })).toBeNull();
  });

  it('has no vertex addition from a midpoint (the coordinates do not change)', () => {
    const feature = makeMultiPoint();
    expect(addVertex(feature, { part: 0, ring: 0, index: 0 }, [5, 5])).toEqual(feature.coordinates);
  });
});

// --- Invariants of the single types ---

describe('only part 0 is valid for a single geometry', () => {
  it('LineString: a movement with part > 0 is ignored', () => {
    const feature = makeFeature('LineString', [
      [0, 0],
      [10, 10],
    ] as Coordinate[]);
    const state: VertexState = {
      featureId: feature.id,
      vertexIndices: [{ part: 1, ring: 0, index: 0 }],
      startLngLat: START,
      initialCoordinates: feature.coordinates,
    };

    expect(computeVertexMove(state, { lng: 5, lat: 5 }, feature)).toEqual([
      [0, 0],
      [10, 10],
    ]);
  });

  it('Polygon: a movement with part > 0 is ignored', () => {
    const feature = makeFeature('Polygon', [
      [
        [0, 0],
        [10, 0],
        [10, 10],
        [0, 0],
      ],
    ] as Coordinate[][]);
    const state: VertexState = {
      featureId: feature.id,
      vertexIndices: [{ part: 1, ring: 0, index: 1 }],
      startLngLat: START,
      initialCoordinates: feature.coordinates,
    };

    expect(computeVertexMove(state, { lng: 5, lat: 5 }, feature)).toEqual(feature.coordinates);
  });

  it('returns null for a deletion with part > 0', () => {
    const line = makeFeature('LineString', [
      [0, 0],
      [10, 10],
      [20, 20],
    ] as Coordinate[]);
    const polygon = makeFeature('Polygon', [
      [
        [0, 0],
        [10, 0],
        [10, 10],
        [0, 10],
        [0, 0],
      ],
    ] as Coordinate[][]);

    expect(deleteVertex(line, { part: 1, ring: 0, index: 1 })).toBeNull();
    expect(deleteVertex(polygon, { part: 1, ring: 0, index: 1 })).toBeNull();
    // With part omitted or 0 it can be deleted as before
    expect(deleteVertex(line, { ring: 0, index: 1 })).not.toBeNull();
    expect(deleteVertex(polygon, { part: 0, ring: 0, index: 1 })).not.toBeNull();
  });

  it('does not change the coordinates for an addition with part > 0', () => {
    const line = makeFeature('LineString', [
      [0, 0],
      [10, 10],
    ] as Coordinate[]);
    expect(addVertex(line, { part: 1, ring: 0, index: 0 }, [5, 5])).toEqual(line.coordinates);
  });

  it('makes startVertexMove refuse part > 0', () => {
    const point = makeFeature('Point', [0, 0] as Coordinate);
    const line = makeFeature('LineString', [
      [0, 0],
      [10, 10],
    ] as Coordinate[]);
    const polygon = makeFeature('Polygon', [
      [
        [0, 0],
        [10, 0],
        [10, 10],
        [0, 0],
      ],
    ] as Coordinate[][]);

    expect(startVertexMove(point, [{ part: 1, ring: 0, index: 0 }], START)).toBeNull();
    expect(startVertexMove(line, [{ part: 1, ring: 0, index: 0 }], START)).toBeNull();
    expect(startVertexMove(polygon, [{ part: 1, ring: 0, index: 0 }], START)).toBeNull();

    // With part omitted or 0 it is valid as before
    expect(startVertexMove(point, [{ ring: 0, index: 0 }], START)).not.toBeNull();
    expect(startVertexMove(line, [{ part: 0, ring: 0, index: 0 }], START)).not.toBeNull();
    expect(startVertexMove(polygon, [{ ring: 0, index: 0 }], START)).not.toBeNull();
  });
});

// --- Consecutive deletion of several vertices (the order of application) ---

describe('consecutive deletion of several vertices', () => {
  it('deletes from a MultiPoint in descending order of part, so the remaining parts do not shift', () => {
    const feature = makeFeature('MultiPoint', [
      [0, 0],
      [10, 10],
      [20, 20],
      [30, 30],
    ] as Coordinate[]);

    const { coordinates, deletedCount } = deleteVertices(feature, [
      { part: 0, ring: 0, index: 0 },
      { part: 2, ring: 0, index: 0 },
    ]);

    expect(deletedCount).toBe(2);
    expect(coordinates).toEqual([
      [10, 10],
      [30, 30],
    ]);
  });

  it('deletes within one part of a MultiLineString in descending order of index', () => {
    const feature = makeFeature('MultiLineString', [
      [
        [0, 0],
        [10, 0],
        [20, 0],
        [30, 0],
      ],
      [
        [0, 10],
        [10, 10],
        [20, 10],
      ],
    ] as Coordinate[][]);

    const { coordinates, deletedCount } = deleteVertices(feature, [
      { part: 0, ring: 0, index: 1 },
      { part: 0, ring: 0, index: 2 },
      { part: 1, ring: 0, index: 1 },
    ]);

    expect(deletedCount).toBe(3);
    expect(coordinates).toEqual([
      [
        [0, 0],
        [30, 0],
      ],
      [
        [0, 10],
        [20, 10],
      ],
    ]);
  });

  it('tests a MultiPolygon per part and ring, so only the ones that cannot be deleted are left', () => {
    const feature = makeMultiPolygon();

    const { coordinates, deletedCount } = deleteVertices(feature, [
      // The outer ring of part 0 (5 points) can be deleted from
      { part: 0, ring: 0, index: 1 },
      // The inner ring of part 0 (5 points) can also be deleted from
      { part: 0, ring: 1, index: 1 },
      // Part 1 is a closed triangle (4 points = the minimum), so nothing can be
      // deleted from it
      { part: 1, ring: 0, index: 1 },
    ]);

    expect(deletedCount).toBe(2);
    const parts = coordinates as Coordinate[][][];
    expect(parts[0][0]).toEqual([
      [0, 0],
      [20, 20],
      [0, 20],
      [0, 0],
    ]);
    expect(parts[0][1]).toEqual([
      [5, 5],
      [15, 15],
      [5, 15],
      [5, 5],
    ]);
    expect(parts[1][0]).toEqual([
      [100, 100],
      [110, 100],
      [110, 110],
      [100, 100],
    ]);
  });
});
