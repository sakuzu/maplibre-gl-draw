// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Closed-ring tests for deleteVertex on a Polygon
 *
 * The last vertex of a closed ring ([..., first]) is the closing point and not an
 * independent vertex, so deleting it breaks the ring. The UI does not show a handle
 * for the closing point, but the public API deleteVertices accepts any vertex
 * reference, so these tests verify that an invalid reference is refused safely.
 * An inner ring (a hole) follows the same rule as the outer ring.
 */

import { describe, expect, it } from 'vitest';
import type { Coordinate, Feature } from '../store/types.js';
import { deleteVertex } from './vertex.js';

function closedPolygon(): Feature {
  return {
    id: 'poly',
    type: 'Polygon',
    coordinates: [
      [
        [0, 0], // A (index 0)
        [1, 0], // B
        [1, 1], // C
        [0, 1], // D
        [0, 0], // The closing point (a copy of A, index 4)
      ],
    ],
    layerId: 'l1',
    properties: {},
    locked: false,
    visible: true,
  };
}

/** A polygon with one hole inside its outer ring */
function polygonWithHole(): Feature {
  return {
    id: 'poly-hole',
    type: 'Polygon',
    coordinates: [
      [
        [0, 0],
        [10, 0],
        [10, 10],
        [0, 10],
        [0, 0],
      ],
      [
        [2, 2], // a (index 0)
        [8, 2], // b
        [8, 8], // c
        [2, 8], // d
        [2, 2], // The closing point (a copy of a, index 4)
      ],
    ],
    layerId: 'l1',
    properties: {},
    locked: false,
    visible: true,
  };
}

describe('deleteVertex Polygon', () => {
  it('rebuilds the ring correctly and keeps it closed when the first vertex is deleted', () => {
    const result = deleteVertex(closedPolygon(), { ring: 0, index: 0 }) as Coordinate[][];
    const ring = result[0];
    // A disappears and it becomes a closed triangle of B, C and D
    expect(ring).toEqual([
      [1, 0],
      [1, 1],
      [0, 1],
      [1, 0],
    ]);
    // It stays closed (first == last)
    expect(ring[0]).toEqual(ring[ring.length - 1]);
  });

  it('keeps the ring closed even when an intermediate vertex is deleted', () => {
    const result = deleteVertex(closedPolygon(), { ring: 0, index: 1 }) as Coordinate[][];
    const ring = result[0];
    expect(ring).toEqual([
      [0, 0],
      [1, 1],
      [0, 1],
      [0, 0],
    ]);
    expect(ring[0]).toEqual(ring[ring.length - 1]);
  });

  it('refuses to delete the closing point (the duplicated index at the end), so the ring is not broken', () => {
    expect(deleteVertex(closedPolygon(), { ring: 0, index: 4 })).toBeNull();
  });

  it('refuses to delete an out-of-range index', () => {
    expect(deleteVertex(closedPolygon(), { ring: 0, index: 99 })).toBeNull();
    expect(deleteVertex(closedPolygon(), { ring: 0, index: -1 })).toBeNull();
  });

  it('refuses to delete an out-of-range ring', () => {
    expect(deleteVertex(closedPolygon(), { ring: 1, index: 0 })).toBeNull();
    expect(deleteVertex(closedPolygon(), { ring: -1, index: 0 })).toBeNull();
  });

  it('does not delete at or below the minimum vertex count (a closed quadrilateral = 4 points)', () => {
    const triangle: Feature = {
      id: 'tri',
      type: 'Polygon',
      coordinates: [
        [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 0],
        ],
      ],
      layerId: 'l1',
      properties: {},
      locked: false,
      visible: true,
    };
    expect(deleteVertex(triangle, { ring: 0, index: 1 })).toBeNull();
  });
});

describe('deleteVertex on an inner ring of a Polygon', () => {
  it('rebuilds the inner ring and keeps it closed when its first vertex is deleted', () => {
    const result = deleteVertex(polygonWithHole(), { ring: 1, index: 0 }) as Coordinate[][];
    const hole = result[1];
    expect(hole).toEqual([
      [8, 2],
      [8, 8],
      [2, 8],
      [8, 2],
    ]);
    expect(hole[0]).toEqual(hole[hole.length - 1]);
  });

  it('keeps the inner ring closed and the outer ring unchanged when an intermediate vertex of the inner ring is deleted', () => {
    const result = deleteVertex(polygonWithHole(), { ring: 1, index: 1 }) as Coordinate[][];
    expect(result[1]).toEqual([
      [2, 2],
      [8, 8],
      [2, 8],
      [2, 2],
    ]);
    expect(result[1][0]).toEqual(result[1][result[1].length - 1]);
    expect(result[0]).toEqual((polygonWithHole().coordinates as Coordinate[][])[0]);
  });

  it('refuses to delete the closing point of the inner ring', () => {
    expect(deleteVertex(polygonWithHole(), { ring: 1, index: 4 })).toBeNull();
  });

  it('refuses to delete an out-of-range index of the inner ring', () => {
    expect(deleteVertex(polygonWithHole(), { ring: 1, index: 99 })).toBeNull();
  });
});
