// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for splitting by a line
 *
 * They look at the semantics of intersections (collinear, end-point contact,
 * degenerate) and at the topology of the result of cutting a polygon with a line.
 * With the preservation of area (the total area does not change before and after
 * the split) as the axis, they check holes, MultiPolygon, multiple crossings and
 * lines that do not pass through. The synthetic data is built deterministically
 * with a fixed-seed pseudo random generator, as in robustness.test.ts.
 */

import { describe, expect, it } from 'vitest';
import { sphericalArea } from './measure.js';
import { pointInPolygon } from './predicates.js';
import { isRingClockwise } from './simplify.js';
import { segmentIntersection, splitArea } from './split.js';
import type {
  AreaCoordinates,
  Coordinate,
  MultiPolygonCoordinates,
  PolygonCoordinates,
  Ring,
} from './types.js';

/** Axis-aligned rectangular ring */
function square(minX: number, minY: number, maxX: number, maxY: number): Ring {
  return [
    [minX, minY],
    [maxX, minY],
    [maxX, maxY],
    [minX, maxY],
    [minX, minY],
  ];
}

/** Total area (square meters) */
function totalArea(parts: MultiPolygonCoordinates[]): number {
  return parts.reduce((sum, part) => sum + sphericalArea(part), 0);
}

/**
 * Confirms that the area is preserved before and after the split
 *
 * It is checked as a relative error. The spherical area is a discrete sum over
 * edges, so when cutting adds vertices the measure itself moves in its lowest
 * digits (section 13 of the design document). A loss of topology does not happen
 * at that digit, so a deviation beyond 10^-5 means a polygon was dropped.
 */
function expectAreaPreserved(parts: MultiPolygonCoordinates[], area: AreaCoordinates): void {
  const expected = sphericalArea(area);
  expect(Math.abs(totalArea(parts) - expected) / expected).toBeLessThan(1e-5);
}

/** Total number of rings contained in a part */
function ringCount(part: MultiPolygonCoordinates): number {
  return part.reduce((sum, polygon) => sum + polygon.length, 0);
}

/** Index of the part containing that point (-1 if there is none) */
function partContaining(parts: MultiPolygonCoordinates[], point: Coordinate): number {
  return parts.findIndex((part) => pointInPolygon(point, part));
}

/** Fixed-seed pseudo random generator (mulberry32) */
function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A jagged outline ring (the angle increases monotonically, so it does not self-intersect)
 */
function jaggedRing(vertexCount: number, random: () => number): Ring {
  const ring: Ring = [];
  for (let i = 0; i < vertexCount; i++) {
    const angle = (i / vertexCount) * Math.PI * 2;
    const radius = 5 * (1 + (random() - 0.5) * 0.4);
    ring.push([139 + radius * Math.cos(angle), 35 + radius * Math.sin(angle)]);
  }
  ring.push(ring[0]);
  return ring;
}

describe('segmentIntersection', () => {
  it('returns the intersection of 2 crossing segments', () => {
    const point = segmentIntersection([0, 0], [10, 10], [0, 10], [10, 0]);
    expect(point).toEqual([5, 5]);
  });

  it('returns null for segments that do not cross (including when they cross on their extensions)', () => {
    expect(segmentIntersection([0, 0], [1, 1], [5, 0], [5, 10])).toBeNull();
    expect(segmentIntersection([0, 0], [1, 0], [2, -1], [2, 1])).toBeNull();
  });

  it('returns null for parallel segments', () => {
    expect(segmentIntersection([0, 0], [10, 0], [0, 1], [10, 1])).toBeNull();
  });

  it('returns null for collinear overlapping segments (because they cannot be expressed as one point)', () => {
    expect(segmentIntersection([0, 0], [10, 0], [5, 0], [15, 0])).toBeNull();
  });

  it('returns contact between end points as an intersection', () => {
    expect(segmentIntersection([0, 0], [5, 5], [5, 5], [10, 0])).toEqual([5, 5]);
  });

  it('returns a T contact, where an end point lies inside the other segment, as an intersection', () => {
    expect(segmentIntersection([0, 0], [10, 0], [5, 0], [5, 5])).toEqual([5, 0]);
  });

  it('returns null for a segment of length 0', () => {
    expect(segmentIntersection([5, 5], [5, 5], [0, 0], [10, 10])).toBeNull();
    expect(segmentIntersection([0, 0], [10, 10], [5, 5], [5, 5])).toBeNull();
  });
});

describe('basics of splitArea', () => {
  const area: PolygonCoordinates = [square(0, 0, 10, 10)];

  it('splits into 2 with a crossing line and preserves the total area', () => {
    const parts = splitArea(area, [
      [-1, 5],
      [11, 5],
    ]);

    expect(parts).toHaveLength(2);
    expectAreaPreserved(parts, area);

    const lower = partContaining(parts, [5, 2]);
    const upper = partContaining(parts, [5, 8]);
    expect(lower).toBeGreaterThanOrEqual(0);
    expect(upper).toBeGreaterThanOrEqual(0);
    expect(lower).not.toBe(upper);
  });

  it('also splits with a bent line, and the boundary follows the line', () => {
    const parts = splitArea(area, [
      [-1, 2],
      [5, 8],
      [11, 2],
    ]);

    expect(parts).toHaveLength(2);
    expectAreaPreserved(parts, area);
    // Directly above the vertex of the polyline is the upper side, directly below the lower side
    expect(partContaining(parts, [5, 9])).not.toBe(partContaining(parts, [5, 1]));
  });

  it('aligns the outer rings of the result counter-clockwise', () => {
    const parts = splitArea(area, [
      [-1, 5],
      [11, 5],
    ]);

    for (const part of parts) {
      for (const polygon of part) {
        expect(isRingClockwise(polygon[0])).toBe(false);
      }
    }
  });

  it('does not split with a line that does not touch the polygon', () => {
    const parts = splitArea(area, [
      [20, 0],
      [20, 10],
    ]);

    expect(parts).toHaveLength(1);
    expectAreaPreserved(parts, area);
  });

  it('does not split with a line that stops inside the polygon', () => {
    const parts = splitArea(area, [
      [-1, 5],
      [5, 5],
    ]);

    expect(parts).toHaveLength(1);
    expectAreaPreserved(parts, area);
  });

  it('does not split with a line that lies only inside the polygon', () => {
    const parts = splitArea(area, [
      [2, 5],
      [8, 5],
    ]);

    expect(parts).toHaveLength(1);
  });

  it('does not split with a line that only touches an edge', () => {
    const parts = splitArea(area, [
      [-1, 10],
      [11, 10],
    ]);

    expect(parts).toHaveLength(1);
    expectAreaPreserved(parts, area);
  });

  it('does not split with a line of fewer than 2 points', () => {
    expect(splitArea(area, [])).toHaveLength(1);
    expect(splitArea(area, [[5, 5]])).toHaveLength(1);
  });

  it('returns an empty array for an input that has no area', () => {
    expect(
      splitArea(
        [
          [
            [0, 0],
            [1, 1],
            [0, 0],
          ],
        ],
        [
          [-1, 0],
          [2, 0],
        ],
      ),
    ).toEqual([]);
  });
});

describe('splitArea and holes', () => {
  /** A square with a hole at its center */
  const donut: PolygonCoordinates = [square(0, 0, 10, 10), square(4, 4, 6, 6)];

  it('splits into 2 with a line through the hole, and the area of the hole does not come back', () => {
    const parts = splitArea(donut, [
      [-1, 5],
      [11, 5],
    ]);

    expect(parts).toHaveLength(2);
    expectAreaPreserved(parts, donut);
    // The inside of the hole belongs to no part
    expect(partContaining(parts, [5, 4.5])).toBe(-1);
  });

  it('leaves one side still holding the hole when cut with a line that does not touch the hole', () => {
    const parts = splitArea(donut, [
      [-1, 9],
      [11, 9],
    ]);

    expect(parts).toHaveLength(2);
    expectAreaPreserved(parts, donut);

    const withHole = parts.filter((part) => ringCount(part) === 2);
    expect(withHole).toHaveLength(1);
    // The side that inherited the hole does not contain the inside of the hole
    expect(pointInPolygon([5, 5], withHole[0])).toBe(false);
    expect(pointInPolygon([1, 1], withHole[0])).toBe(true);
  });

  it('does not split with a line that passes only through the hole', () => {
    const parts = splitArea(donut, [
      [4.2, 5],
      [5.8, 5],
    ]);

    expect(parts).toHaveLength(1);
    expectAreaPreserved(parts, donut);
  });
});

describe('splitArea and MultiPolygon', () => {
  const islands: MultiPolygonCoordinates = [[square(0, 0, 10, 10)], [square(20, 0, 30, 10)]];

  it('returns the uncut part as a separate part as well when only one side is cut', () => {
    const parts = splitArea(islands, [
      [-1, 5],
      [11, 5],
    ]);

    expect(parts).toHaveLength(3);
    expectAreaPreserved(parts, islands);
    expect(partContaining(parts, [5, 2])).toBeGreaterThanOrEqual(0);
    expect(partContaining(parts, [5, 8])).toBeGreaterThanOrEqual(0);
    expect(partContaining(parts, [25, 5])).toBeGreaterThanOrEqual(0);
  });

  it('splits into 4 with a line that goes through both', () => {
    const parts = splitArea(islands, [
      [-1, 5],
      [31, 5],
    ]);

    expect(parts).toHaveLength(4);
    expectAreaPreserved(parts, islands);
  });

  it('does not split with a line that reaches neither of them', () => {
    const parts = splitArea(islands, [
      [15, -1],
      [15, 11],
    ]);

    expect(parts).toHaveLength(1);
    expectAreaPreserved(parts, islands);
  });
});

describe('splitArea and multiple crossings', () => {
  const area: PolygonCoordinates = [square(0, 0, 10, 10)];

  it('splits into 3 with a line that goes around outside and crosses twice', () => {
    const parts = splitArea(area, [
      [-1, 3],
      [11, 3],
      [11, 7],
      [-1, 7],
    ]);

    expect(parts).toHaveLength(3);
    expectAreaPreserved(parts, area);
    const bands = [
      partContaining(parts, [5, 1]),
      partContaining(parts, [5, 5]),
      partContaining(parts, [5, 9]),
    ];
    expect(new Set(bands).size).toBe(3);
    expect(bands).not.toContain(-1);
  });

  it('still splits into 2 with a U-shaped line that enters and leaves through the same edge', () => {
    const parts = splitArea(area, [
      [2, -1],
      [2, 5],
      [8, 5],
      [8, -1],
    ]);

    expect(parts).toHaveLength(2);
    expectAreaPreserved(parts, area);
    // The inside and the outside of the U become separate parts
    expect(partContaining(parts, [5, 2])).not.toBe(partContaining(parts, [5, 8]));
  });

  it('cuts out the inside of the loop with a self-intersecting line that closes inside the polygon', () => {
    // Cross the polygon, then make a loop and come back
    const parts = splitArea(area, [
      [-1, 5],
      [5, 5],
      [5, 2],
      [2, 2],
      [2, 8],
      [11, 8],
    ]);

    expect(parts.length).toBeGreaterThanOrEqual(3);
    expectAreaPreserved(parts, area);
  });
});

describe('synthetic data for splitArea', () => {
  it('preserves the area even when crossing a jagged polygon with many vertices', () => {
    const random = createRandom(20260801);
    const area: PolygonCoordinates = [jaggedRing(600, random)];

    const parts = splitArea(area, [
      [130, 35],
      [148, 35],
    ]);

    expect(parts.length).toBeGreaterThanOrEqual(2);
    expectAreaPreserved(parts, area);
  });

  it('does not throw when cutting a jagged polygon with a polyline, and the parts have area', () => {
    const random = createRandom(7);
    const area: PolygonCoordinates = [jaggedRing(300, random)];

    const parts = splitArea(area, [
      [130, 30],
      [139, 35.5],
      [148, 30],
    ]);

    expect(parts.length).toBeGreaterThanOrEqual(2);
    for (const part of parts) {
      expect(sphericalArea(part)).toBeGreaterThan(0);
    }
    expectAreaPreserved(parts, area);
  });
});
