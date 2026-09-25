// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import {
  clip,
  difference,
  differenceAll,
  intersection,
  intersectionAll,
  normalizeArea,
  union,
  unionAll,
} from './boolean.js';
import { sphericalArea } from './measure.js';
import type { MultiPolygonCoordinates, PolygonCoordinates, Ring } from './types.js';

/** Builds a rectangular ring (counter-clockwise) */
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

/** Total number of vertices in MultiPolygon coordinates */
function ringCount(multiPolygon: MultiPolygonCoordinates): number {
  return multiPolygon.reduce((total, polygon) => total + polygon.length, 0);
}

describe('union', () => {
  it('turns two overlapping rectangles into a single polygon', () => {
    const result = union(rectPolygon(0, 0, 2, 2), rectPolygon(1, 1, 3, 3));
    expect(result).toHaveLength(1);
    expect(ringCount(result)).toBe(1);
  });

  it('turns two separated rectangles into a MultiPolygon', () => {
    const result = union(rectPolygon(0, 0, 1, 1), rectPolygon(5, 5, 6, 6));
    expect(result).toHaveLength(2);
  });

  it('fuses two rectangles sharing only an edge into a single polygon', () => {
    const result = union(rectPolygon(0, 0, 1, 1), rectPolygon(1, 0, 2, 1));
    expect(result).toHaveLength(1);
    expect(ringCount(result)).toBe(1);
  });

  it('accepts MultiPolygon coordinates as input', () => {
    const multi: MultiPolygonCoordinates = [rectPolygon(0, 0, 1, 1), rectPolygon(5, 5, 6, 6)];
    const result = union(multi, rectPolygon(0.5, 0.5, 1.5, 1.5));
    expect(result).toHaveLength(2);
  });

  it('normalizes and returns the other side as it is for an empty input', () => {
    const result = union([], rectPolygon(0, 0, 1, 1));
    expect(result).toHaveLength(1);
  });
});

describe('difference', () => {
  it('makes a hole when the inner rectangle is cut out', () => {
    const result = difference(rectPolygon(0, 0, 10, 10), rectPolygon(3, 3, 6, 6));
    expect(result).toHaveLength(1);
    expect(result[0]).toHaveLength(2);
  });

  it('becomes empty when fully covered', () => {
    const result = difference(rectPolygon(1, 1, 2, 2), rectPolygon(0, 0, 10, 10));
    expect(result).toEqual([]);
  });

  it('returns the original polygon when the subtrahend is empty', () => {
    const result = difference(rectPolygon(0, 0, 1, 1), []);
    expect(result).toHaveLength(1);
  });

  it('returns empty when the minuend is empty', () => {
    expect(difference([], rectPolygon(0, 0, 1, 1))).toEqual([]);
  });

  it('does not break down when subtracting further from a polygon with a hole', () => {
    const withHole: PolygonCoordinates = [rect(0, 0, 10, 10), rect(3, 3, 6, 6)];
    const result = difference(withHole, rectPolygon(-1, 4, 11, 5));
    expect(result.length).toBeGreaterThan(0);
  });
});

describe('intersection', () => {
  it('keeps only the overlapping part', () => {
    const result = intersection(rectPolygon(0, 0, 2, 2), rectPolygon(1, 1, 3, 3));
    expect(result).toHaveLength(1);
    const area = sphericalArea(result);
    const expected = sphericalArea(rectPolygon(1, 1, 2, 2));
    expect(area / expected).toBeCloseTo(1, 6);
  });

  it('becomes empty when they do not overlap', () => {
    expect(intersection(rectPolygon(0, 0, 1, 1), rectPolygon(5, 5, 6, 6))).toEqual([]);
  });

  it('becomes empty for edge-only contact because it has no area', () => {
    expect(intersection(rectPolygon(0, 0, 1, 1), rectPolygon(1, 0, 2, 1))).toEqual([]);
  });

  it('makes the intersection with the inside of a hole empty', () => {
    const withHole: PolygonCoordinates = [rect(0, 0, 10, 10), rect(3, 3, 6, 6)];
    expect(intersection(withHole, rectPolygon(4, 4, 5, 5))).toEqual([]);
  });
});

describe('clip', () => {
  it('keeps only the inside of the clipping region', () => {
    const result = clip(rectPolygon(0, 0, 4, 4), rectPolygon(1, 1, 2, 2));
    expect(result).toHaveLength(1);
    expect(sphericalArea(result) / sphericalArea(rectPolygon(1, 1, 2, 2))).toBeCloseTo(1, 6);
  });
});

describe('unionAll', () => {
  it('returns empty for an empty array', () => {
    expect(unionAll([])).toEqual([]);
  });

  it('returns the normalized result for a single item', () => {
    expect(unionAll([rectPolygon(0, 0, 1, 1)])).toHaveLength(1);
  });

  it('fuses several adjoining rectangles into one', () => {
    const parts = [
      rectPolygon(0, 0, 1, 1),
      rectPolygon(0.5, 0, 1.5, 1),
      rectPolygon(1, 0, 2, 1),
      rectPolygon(1.5, 0, 2.5, 1),
    ];
    const result = unionAll(parts);
    expect(result).toHaveLength(1);
  });

  it('keeps several separated rectangles as parts', () => {
    const parts = [rectPolygon(0, 0, 1, 1), rectPolygon(5, 5, 6, 6), rectPolygon(9, 9, 10, 10)];
    expect(unionAll(parts)).toHaveLength(3);
  });
});

describe('intersectionAll', () => {
  it('returns empty for an empty array', () => {
    expect(intersectionAll([])).toEqual([]);
  });

  it('returns the part common to all of them', () => {
    const result = intersectionAll([
      rectPolygon(0, 0, 3, 3),
      rectPolygon(1, 1, 4, 4),
      rectPolygon(2, 0, 5, 5),
    ]);
    expect(result).toHaveLength(1);
    expect(sphericalArea(result) / sphericalArea(rectPolygon(2, 1, 3, 3))).toBeCloseTo(1, 6);
  });

  it('becomes empty when even one of them has nothing in common', () => {
    const result = intersectionAll([
      rectPolygon(0, 0, 3, 3),
      rectPolygon(1, 1, 4, 4),
      rectPolygon(8, 8, 9, 9),
    ]);
    expect(result).toEqual([]);
  });
});

describe('differenceAll', () => {
  it('can subtract several polygons at once', () => {
    const result = differenceAll(rectPolygon(0, 0, 10, 10), [
      rectPolygon(1, 1, 2, 2),
      rectPolygon(5, 5, 6, 6),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]).toHaveLength(3);
  });

  it('returns the original polygon when there is nothing to subtract', () => {
    expect(differenceAll(rectPolygon(0, 0, 1, 1), [])).toHaveLength(1);
  });
});

/**
 * Two polygons that disagree by 1 ulp on the same edge
 *
 * This pair was minimized from an areal apportionment (real data) between the
 * Voronoi catchments of 35 evacuation sites in Mobara City and 2,085 polygons of
 * 250 m mesh population. They are the fragments obtained by cutting two adjacent
 * mesh cells with the same catchment, and on the shared vertical edge
 * x=140.359375 the height at which they are cut splits into 35.45840645360606 and
 * 35.458406453606074 (the difference is one step of the double precision
 * resolution).
 */
const ULP_MISMATCH: [PolygonCoordinates, PolygonCoordinates] = [
  [
    [
      [140.35850091381738, 35.460417],
      [140.359375, 35.45840645360606],
      [140.359375, 35.460417],
      [140.35850091381738, 35.460417],
    ],
  ],
  [
    [
      [140.359375, 35.458406453606074],
      [140.3594069339968, 35.458333],
      [140.3625, 35.458333],
      [140.3625, 35.460417],
      [140.359375, 35.460417],
      [140.359375, 35.458406453606074],
    ],
  ],
];

describe('robustness against numeric disagreement', () => {
  it('can take the union of two polygons sharing an edge that differs by 1 ulp', () => {
    const [first, second] = ULP_MISMATCH;
    const result = union(first, second);
    expect(result.length).toBeGreaterThan(0);
    // The fragments are adjacent, so the area is nearly equal to the sum of the two
    const expected = sphericalArea(first) + sphericalArea(second);
    expect(sphericalArea(result) / expected).toBeCloseTo(1, 6);
  });

  it('can merge two polygons sharing an edge that differs by 1 ulp with unionAll', () => {
    const result = unionAll([ULP_MISMATCH[0], ULP_MISMATCH[1]]);
    expect(result.length).toBeGreaterThan(0);
  });
});

describe('normalizeArea', () => {
  it('drops rings that have no area', () => {
    expect(
      normalizeArea([
        [
          [0, 0],
          [1, 1],
        ],
      ]),
    ).toEqual([]);
  });

  it('turns Polygon coordinates into MultiPolygon coordinates', () => {
    const result = normalizeArea(rectPolygon(0, 0, 1, 1));
    expect(result).toHaveLength(1);
    expect(result[0]).toHaveLength(1);
  });
});
