// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { centroid, geodesicLength, pointOnSurface, sphericalArea } from './measure.js';
import { pointInPolygon } from './predicates.js';
import type { Coordinate, MultiPolygonCoordinates, PolygonCoordinates, Ring } from './types.js';

/** Geodesic length of 1 degree of longitude on the equator (meters) */
const METERS_PER_DEGREE_AT_EQUATOR = 111194.93;

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

describe('geodesicLength', () => {
  it('makes 1 degree on the equator about 111.19 km', () => {
    const length = geodesicLength([
      [0, 0],
      [1, 0],
    ]);
    expect(length).toBeCloseTo(METERS_PER_DEGREE_AT_EQUATOR, 0);
  });

  it('adds up the segments', () => {
    const length = geodesicLength([
      [0, 0],
      [1, 0],
      [2, 0],
    ]);
    expect(length).toBeCloseTo(METERS_PER_DEGREE_AT_EQUATOR * 2, 0);
  });

  it('also makes 1 degree in the latitude direction about 111.19 km', () => {
    const length = geodesicLength([
      [0, 0],
      [0, 1],
    ]);
    expect(length).toBeCloseTo(METERS_PER_DEGREE_AT_EQUATOR, 0);
  });

  it('shortens 1 degree of longitude at high latitudes', () => {
    const length = geodesicLength([
      [0, 60],
      [1, 60],
    ]);
    // cos(60 degrees) = 0.5
    expect(length / METERS_PER_DEGREE_AT_EQUATOR).toBeCloseTo(0.5, 3);
  });

  it('returns 0 for fewer than 2 points', () => {
    expect(geodesicLength([])).toBe(0);
    expect(geodesicLength([[0, 0]])).toBe(0);
  });
});

describe('sphericalArea', () => {
  it('makes a small square on the equator close to the square of its side length', () => {
    const side = 0.001 * METERS_PER_DEGREE_AT_EQUATOR;
    const area = sphericalArea([rect(0, 0, 0.001, 0.001)]);
    expect(Math.abs(area - side * side) / (side * side)).toBeLessThan(0.001);
  });

  it('returns a positive value regardless of the ring orientation', () => {
    const clockwise: Ring = [...rect(0, 0, 0.001, 0.001)].reverse();
    expect(sphericalArea([clockwise])).toBeGreaterThan(0);
  });

  it('subtracts inner rings', () => {
    const withHole: PolygonCoordinates = [rect(0, 0, 1, 1), rect(0.25, 0.25, 0.75, 0.75)];
    const outer = sphericalArea([rect(0, 0, 1, 1)]);
    const inner = sphericalArea([rect(0.25, 0.25, 0.75, 0.75)]);
    expect(sphericalArea(withHole)).toBeCloseTo(outer - inner, 0);
  });

  it('sums up a MultiPolygon', () => {
    const multi: MultiPolygonCoordinates = [[rect(0, 0, 1, 1)], [rect(5, 5, 6, 6)]];
    const total = sphericalArea([rect(0, 0, 1, 1)]) + sphericalArea([rect(5, 5, 6, 6)]);
    expect(sphericalArea(multi)).toBeCloseTo(total, 0);
  });

  it('gives a smaller area at high latitudes even for a rectangle of the same degrees', () => {
    const equator = sphericalArea([rect(0, 0, 1, 1)]);
    const high = sphericalArea([rect(0, 60, 1, 61)]);
    expect(high).toBeLessThan(equator);
  });

  it('returns 0 for coordinates that have no area', () => {
    expect(
      sphericalArea([
        [
          [0, 0],
          [1, 1],
        ],
      ]),
    ).toBe(0);
  });
});

describe('centroid', () => {
  it('puts the centroid of a rectangle at its center', () => {
    const center = centroid([rect(0, 0, 2, 2)]) as Coordinate;
    expect(center[0]).toBeCloseTo(1, 10);
    expect(center[1]).toBeCloseTo(1, 10);
  });

  it('does not depend on the ring orientation', () => {
    const clockwise: Ring = [...rect(0, 0, 2, 2)].reverse();
    const center = centroid([clockwise]) as Coordinate;
    expect(center[0]).toBeCloseTo(1, 10);
    expect(center[1]).toBeCloseTo(1, 10);
  });

  it('lets an inner ring pull the centroid', () => {
    const withHole: PolygonCoordinates = [rect(0, 0, 10, 10), rect(6, 4, 9, 6)];
    const center = centroid(withHole) as Coordinate;
    expect(center[0]).toBeLessThan(5);
    expect(center[1]).toBeCloseTo(5, 10);
  });

  it('combines a MultiPolygon weighted by area', () => {
    const multi: MultiPolygonCoordinates = [[rect(0, 0, 2, 2)], [rect(10, 0, 11, 1)]];
    const center = centroid(multi) as Coordinate;
    // Weighted average with an area ratio of 4:1
    expect(center[0]).toBeCloseTo((1 * 4 + 10.5 * 1) / 5, 10);
  });

  it('returns the average of the vertices for coordinates with zero area', () => {
    const center = centroid([
      [
        [0, 0],
        [2, 0],
      ],
    ]) as Coordinate;
    expect(center).toEqual([1, 0]);
  });

  it('returns null for empty coordinates', () => {
    expect(centroid([])).toBeNull();
  });
});

describe('pointOnSurface', () => {
  it('returns the centroid itself when it lies inside the polygon', () => {
    const point = pointOnSurface([rect(0, 0, 2, 2)]) as Coordinate;
    expect(point).toEqual([1, 1]);
  });

  it('returns a point inside the polygon even when the centroid is outside (C shape)', () => {
    const cShape: PolygonCoordinates = [
      [
        [0, 0],
        [10, 0],
        [10, 3],
        [3, 3],
        [3, 7],
        [10, 7],
        [10, 10],
        [0, 10],
        [0, 0],
      ],
    ];
    const point = pointOnSurface(cShape) as Coordinate;
    expect(pointInPolygon(point, cShape)).toBe(true);
  });

  it('returns a point outside the hole even when the centroid is the center of the hole', () => {
    const withHole: PolygonCoordinates = [rect(0, 0, 10, 10), rect(2, 2, 8, 8)];
    const point = pointOnSurface(withHole) as Coordinate;
    expect(pointInPolygon(point, withHole)).toBe(true);
  });

  it('returns null for empty coordinates', () => {
    expect(pointOnSurface([])).toBeNull();
  });
});
