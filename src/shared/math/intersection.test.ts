// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import type { BoundingBox, Coordinate } from '../../store/types.js';
import {
  pointInRectangle,
  rectangleIntersectsCircle,
  rectangleIntersectsLineString,
  rectangleIntersectsOBB,
  rectangleIntersectsPolygon,
  segmentIntersectsRectangle,
  segmentIntersectsSegment,
} from './intersection.js';

const rect: BoundingBox = { minX: 0, minY: 0, maxX: 10, maxY: 10 };

describe('pointInRectangle', () => {
  it('a point inside the rectangle returns true', () => {
    expect(pointInRectangle([5, 5], rect)).toBe(true);
  });

  it('a point outside the rectangle returns false', () => {
    expect(pointInRectangle([15, 5], rect)).toBe(false);
    expect(pointInRectangle([-1, 5], rect)).toBe(false);
    expect(pointInRectangle([5, -1], rect)).toBe(false);
    expect(pointInRectangle([5, 11], rect)).toBe(false);
  });

  it('a point on an edge returns true', () => {
    expect(pointInRectangle([0, 5], rect)).toBe(true);
    expect(pointInRectangle([10, 5], rect)).toBe(true);
    expect(pointInRectangle([5, 0], rect)).toBe(true);
    expect(pointInRectangle([5, 10], rect)).toBe(true);
  });

  it('a point on a corner returns true', () => {
    expect(pointInRectangle([0, 0], rect)).toBe(true);
    expect(pointInRectangle([10, 0], rect)).toBe(true);
    expect(pointInRectangle([10, 10], rect)).toBe(true);
    expect(pointInRectangle([0, 10], rect)).toBe(true);
  });
});

describe('segmentIntersectsSegment', () => {
  it('segments crossing in an X shape return true', () => {
    expect(segmentIntersectsSegment([0, 0], [10, 10], [0, 10], [10, 0])).toBe(true);
  });

  it('parallel segments return false', () => {
    expect(segmentIntersectsSegment([0, 0], [10, 0], [0, 1], [10, 1])).toBe(false);
  });

  it('collinear segments that overlap return true', () => {
    expect(segmentIntersectsSegment([0, 0], [5, 0], [3, 0], [8, 0])).toBe(true);
  });

  it('collinear segments that do not overlap return false', () => {
    expect(segmentIntersectsSegment([0, 0], [2, 0], [3, 0], [5, 0])).toBe(false);
  });

  it('a T-shaped contact returns true', () => {
    expect(segmentIntersectsSegment([0, 0], [10, 0], [5, -5], [5, 0])).toBe(true);
  });

  it('segments whose endpoints touch return true', () => {
    expect(segmentIntersectsSegment([0, 0], [5, 5], [5, 5], [10, 0])).toBe(true);
  });

  it('segments that do not intersect return false', () => {
    expect(segmentIntersectsSegment([0, 0], [1, 1], [2, 0], [3, 1])).toBe(false);
  });
});

describe('segmentIntersectsRectangle', () => {
  it('a segment that fits inside the rectangle returns true', () => {
    expect(segmentIntersectsRectangle([2, 2], [8, 8], rect)).toBe(true);
  });

  it('a segment that crosses the rectangle returns true', () => {
    expect(segmentIntersectsRectangle([-5, 5], [15, 5], rect)).toBe(true);
  });

  it('a segment outside the rectangle returns false', () => {
    expect(segmentIntersectsRectangle([11, 11], [15, 15], rect)).toBe(false);
  });

  it('a segment that touches a corner returns true', () => {
    expect(segmentIntersectsRectangle([-5, -5], [0, 0], rect)).toBe(true);
  });

  it('a segment whose endpoint lies on an edge returns true', () => {
    expect(segmentIntersectsRectangle([5, 0], [15, -5], rect)).toBe(true);
  });
});

describe('rectangleIntersectsLineString', () => {
  it('an empty LineString returns false', () => {
    expect(rectangleIntersectsLineString(rect, [])).toBe(false);
  });

  it('a LineString with a vertex inside the rectangle returns true', () => {
    expect(
      rectangleIntersectsLineString(rect, [
        [5, 5],
        [15, 15],
      ]),
    ).toBe(true);
  });

  it('a LineString whose edge intersects the rectangle returns true', () => {
    expect(
      rectangleIntersectsLineString(rect, [
        [-5, 5],
        [15, 5],
      ]),
    ).toBe(true);
  });

  it('a LineString entirely outside the rectangle returns false', () => {
    expect(
      rectangleIntersectsLineString(rect, [
        [11, 11],
        [15, 15],
      ]),
    ).toBe(false);
  });

  it('a LineString that fits entirely inside the rectangle returns true', () => {
    expect(
      rectangleIntersectsLineString(rect, [
        [2, 2],
        [5, 5],
        [8, 8],
      ]),
    ).toBe(true);
  });
});

describe('rectangleIntersectsPolygon', () => {
  it('an empty polygon returns false', () => {
    expect(rectangleIntersectsPolygon(rect, [])).toBe(false);
    expect(rectangleIntersectsPolygon(rect, [[]])).toBe(false);
  });

  it('returns true when a polygon vertex is inside the rectangle', () => {
    const polygon: Coordinate[][] = [
      [
        [5, 5],
        [15, 5],
        [15, 15],
        [5, 15],
        [5, 5],
      ],
    ];
    expect(rectangleIntersectsPolygon(rect, polygon)).toBe(true);
  });

  it('returns true when a corner of the rectangle is inside the polygon', () => {
    const polygon: Coordinate[][] = [
      [
        [-5, -5],
        [15, -5],
        [15, 15],
        [-5, 15],
        [-5, -5],
      ],
    ];
    expect(rectangleIntersectsPolygon(rect, polygon)).toBe(true);
  });

  it('returns true when the edges intersect', () => {
    const polygon: Coordinate[][] = [
      [
        [-5, 5],
        [5, 15],
        [15, 5],
        [5, -5],
        [-5, 5],
      ],
    ];
    expect(rectangleIntersectsPolygon(rect, polygon)).toBe(true);
  });

  it('a polygon that fits entirely inside the rectangle returns true', () => {
    const polygon: Coordinate[][] = [
      [
        [2, 2],
        [8, 2],
        [8, 8],
        [2, 8],
        [2, 2],
      ],
    ];
    expect(rectangleIntersectsPolygon(rect, polygon)).toBe(true);
  });

  it('a polygon entirely outside the rectangle returns false', () => {
    const polygon: Coordinate[][] = [
      [
        [20, 20],
        [30, 20],
        [30, 30],
        [20, 30],
        [20, 20],
      ],
    ];
    expect(rectangleIntersectsPolygon(rect, polygon)).toBe(false);
  });

  it('returns true when the polygon completely contains the rectangle', () => {
    const polygon: Coordinate[][] = [
      [
        [-10, -10],
        [20, -10],
        [20, 20],
        [-10, 20],
        [-10, -10],
      ],
    ];
    expect(rectangleIntersectsPolygon(rect, polygon)).toBe(true);
  });
});

describe('rectangleIntersectsCircle', () => {
  it('returns true when the center of the circle is inside the rectangle', () => {
    expect(rectangleIntersectsCircle(rect, [5, 5], 1)).toBe(true);
  });

  it('returns true when the center of the circle is outside the rectangle but they overlap', () => {
    expect(rectangleIntersectsCircle(rect, [12, 5], 3)).toBe(true);
  });

  it('returns false when they do not overlap', () => {
    expect(rectangleIntersectsCircle(rect, [20, 20], 1)).toBe(false);
  });

  it('returns true when it touches an edge', () => {
    expect(rectangleIntersectsCircle(rect, [15, 5], 5)).toBe(true);
  });

  it('returns true when the radius is 0 and it is inside the rectangle', () => {
    expect(rectangleIntersectsCircle(rect, [5, 5], 0)).toBe(true);
  });

  it('returns false when the radius is 0 and it is outside the rectangle', () => {
    expect(rectangleIntersectsCircle(rect, [15, 15], 0)).toBe(false);
  });
});

describe('rectangleIntersectsOBB', () => {
  it('an overlapping OBB returns true', () => {
    const obb = {
      corners: [
        [2, 2],
        [8, 2],
        [8, 8],
        [2, 8],
      ] as Coordinate[],
    };
    expect(rectangleIntersectsOBB(rect, obb)).toBe(true);
  });

  it('a non-overlapping OBB returns false', () => {
    const obb = {
      corners: [
        [20, 20],
        [30, 20],
        [30, 30],
        [20, 30],
      ] as Coordinate[],
    };
    expect(rectangleIntersectsOBB(rect, obb)).toBe(false);
  });

  it('returns true when it intersects an OBB rotated 45 degrees', () => {
    // A square centered at (5,5) and rotated 45 degrees
    const s = Math.SQRT2 * 3;
    const obb = {
      corners: [
        [5, 5 + s],
        [5 + s, 5],
        [5, 5 - s],
        [5 - s, 5],
      ] as Coordinate[],
    };
    expect(rectangleIntersectsOBB(rect, obb)).toBe(true);
  });

  it('returns false when there are not 4 vertices', () => {
    const obb = {
      corners: [
        [2, 2],
        [8, 2],
        [8, 8],
      ] as Coordinate[],
    };
    expect(rectangleIntersectsOBB(rect, obb)).toBe(false);
  });
});
