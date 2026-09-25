// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { contains, intersects, pointInPolygon, within } from './predicates.js';
import type { MultiPolygonCoordinates, PolygonCoordinates, Ring } from './types.js';

/** Rectangular ring */
function rect(minX: number, minY: number, maxX: number, maxY: number): Ring {
  return [
    [minX, minY],
    [maxX, minY],
    [maxX, maxY],
    [minX, maxY],
    [minX, minY],
  ];
}

/** Polygon coordinates of a rectangle */
function rectPolygon(minX: number, minY: number, maxX: number, maxY: number): PolygonCoordinates {
  return [rect(minX, minY, maxX, maxY)];
}

describe('pointInPolygon', () => {
  const withHole: PolygonCoordinates = [rect(0, 0, 10, 10), rect(3, 3, 6, 6)];

  it('returns true inside the outer ring', () => {
    expect(pointInPolygon([1, 1], withHole)).toBe(true);
  });

  it('returns false inside a hole', () => {
    expect(pointInPolygon([4.5, 4.5], withHole)).toBe(false);
  });

  it('returns false outside', () => {
    expect(pointInPolygon([20, 20], withHole)).toBe(false);
  });

  it('returns true for a MultiPolygon when any part contains the point', () => {
    const multi: MultiPolygonCoordinates = [rectPolygon(0, 0, 1, 1), rectPolygon(5, 5, 6, 6)];
    expect(pointInPolygon([5.5, 5.5], multi)).toBe(true);
    expect(pointInPolygon([3, 3], multi)).toBe(false);
  });

  it('returns false for empty coordinates', () => {
    expect(pointInPolygon([0, 0], [])).toBe(false);
  });

  it('does not double count on a scan line passing through the latitude of a vertex', () => {
    // A point at the same latitude as a vertex of the triangle
    const triangle: PolygonCoordinates = [
      [
        [0, 0],
        [4, 0],
        [2, 4],
        [0, 0],
      ],
    ];
    expect(pointInPolygon([2, 0.001], triangle)).toBe(true);
    expect(pointInPolygon([-1, 0.001], triangle)).toBe(false);
  });
});

describe('intersects', () => {
  it('returns true when they overlap', () => {
    expect(intersects(rectPolygon(0, 0, 2, 2), rectPolygon(1, 1, 3, 3))).toBe(true);
  });

  it('returns false when the bboxes are apart', () => {
    expect(intersects(rectPolygon(0, 0, 1, 1), rectPolygon(50, 50, 51, 51))).toBe(false);
  });

  it('also returns false when the bboxes overlap but the polygons do not', () => {
    const diagonalA: PolygonCoordinates = [
      [
        [0, 0],
        [1, 0],
        [0, 1],
        [0, 0],
      ],
    ];
    const diagonalB: PolygonCoordinates = [
      [
        [1, 1],
        [1, 0.6],
        [0.6, 1],
        [1, 1],
      ],
    ];
    expect(intersects(diagonalA, diagonalB)).toBe(false);
  });

  it('returns false for edge-only contact because it has no area', () => {
    expect(intersects(rectPolygon(0, 0, 1, 1), rectPolygon(1, 0, 2, 1))).toBe(false);
  });

  it('does not overlap a polygon that fits inside a hole', () => {
    const withHole: PolygonCoordinates = [rect(0, 0, 10, 10), rect(3, 3, 6, 6)];
    expect(intersects(withHole, rectPolygon(4, 4, 5, 5))).toBe(false);
  });

  it('returns false for empty coordinates', () => {
    expect(intersects([], rectPolygon(0, 0, 1, 1))).toBe(false);
  });
});

describe('contains / within', () => {
  it('returns true when it contains the other', () => {
    expect(contains(rectPolygon(0, 0, 10, 10), rectPolygon(2, 2, 3, 3))).toBe(true);
    expect(within(rectPolygon(2, 2, 3, 3), rectPolygon(0, 0, 10, 10))).toBe(true);
  });

  it('returns false when the other sticks out', () => {
    expect(contains(rectPolygon(0, 0, 10, 10), rectPolygon(9, 9, 11, 11))).toBe(false);
  });

  it('returns false early when the bbox does not contain the other', () => {
    expect(contains(rectPolygon(0, 0, 1, 1), rectPolygon(50, 50, 51, 51))).toBe(false);
  });

  it('makes identical polygons contain each other', () => {
    expect(contains(rectPolygon(0, 0, 1, 1), rectPolygon(0, 0, 1, 1))).toBe(true);
    expect(within(rectPolygon(0, 0, 1, 1), rectPolygon(0, 0, 1, 1))).toBe(true);
  });

  it('does not contain a polygon that overlaps a hole', () => {
    const withHole: PolygonCoordinates = [rect(0, 0, 10, 10), rect(3, 3, 6, 6)];
    expect(contains(withHole, rectPolygon(4, 4, 5, 5))).toBe(false);
  });

  it('also counts as containment when the other fits split across all parts of a MultiPolygon', () => {
    const outer: MultiPolygonCoordinates = [rectPolygon(0, 0, 2, 2), rectPolygon(5, 5, 7, 7)];
    const inner: MultiPolygonCoordinates = [
      rectPolygon(0.5, 0.5, 1, 1),
      rectPolygon(5.5, 5.5, 6, 6),
    ];
    expect(contains(outer, inner)).toBe(true);
  });

  it('does not contain a side that has no area', () => {
    expect(contains(rectPolygon(0, 0, 10, 10), [])).toBe(false);
  });
});
