// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Degenerate and out-of-scope input at the entry of the public functions
 *
 * Each case is a value that used to come back broken (an array holding undefined, a
 * polygon collapsed to its end points, a band around the whole world, a negative area) or
 * that reached polygon-clipping and made it throw its internal error. The functions now
 * normalize the arguments at their entry or report the input as out of scope.
 */

import { describe, expect, it } from 'vitest';
import { coordinatesBBox } from './bbox.js';
import { difference, intersection, normalizeArea, union, unionAll } from './boolean.js';
import { buffer } from './buffer.js';
import { generateCirclePolygon } from './circle.js';
import { isMultiPolygonCoordinates, toMultiPolygonCoordinates } from './coords.js';
import { sphericalArea } from './measure.js';
import { simplify } from './simplify.js';
import type { AreaCoordinates, Coordinate, MultiPolygonCoordinates, Ring } from './types.js';

function rect(minX: number, minY: number, maxX: number, maxY: number): Ring {
  return [
    [minX, minY],
    [maxX, minY],
    [maxX, maxY],
    [minX, maxY],
    [minX, minY],
  ];
}

function allFinite(parts: MultiPolygonCoordinates): boolean {
  return parts.every((polygon) =>
    polygon.every((ring) => ring.every(([x, y]) => Number.isFinite(x) && Number.isFinite(y))),
  );
}

describe('generateCirclePolygon: the number of segments is normalized', () => {
  it('makes a triangle for segments 0 instead of a ring holding undefined', () => {
    const ring = generateCirclePolygon([139, 35], 100, 0);
    expect(ring).toHaveLength(4);
    expect(ring.every((position) => Array.isArray(position))).toBe(true);
  });

  it('uses the default 64 for NaN', () => {
    expect(generateCirclePolygon([139, 35], 100, Number.NaN)).toHaveLength(65);
  });

  it('caps Infinity at 1024 instead of looping forever', () => {
    expect(generateCirclePolygon([139, 35], 100, Number.POSITIVE_INFINITY)).toHaveLength(1025);
  });

  it('rounds a fractional count down', () => {
    expect(generateCirclePolygon([139, 35], 100, 8.9)).toHaveLength(9);
  });

  it('returns an empty ring for a center or a radius that is not usable', () => {
    expect(generateCirclePolygon([Number.NaN, 35], 100)).toEqual([]);
    expect(generateCirclePolygon([139, 35], Number.NaN)).toEqual([]);
    expect(generateCirclePolygon([139, 35], Number.POSITIVE_INFINITY)).toEqual([]);
    expect(generateCirclePolygon([139, 35], -1)).toEqual([]);
  });
});

describe('buffer: the entry checks', () => {
  const line = {
    type: 'LineString' as const,
    coordinates: [
      [139, 35],
      [139.01, 35],
    ] as Coordinate[],
  };

  it('uses the default segments for NaN instead of returning an empty result', () => {
    const result = buffer(line, 100, { segments: Number.NaN });
    expect(result).not.toBeNull();
    expect(result?.length).toBe(1);
  });

  it('finishes for segments Infinity (capped)', () => {
    const result = buffer({ type: 'Point', coordinates: [139, 35] }, 100, {
      segments: Number.POSITIVE_INFINITY,
    });
    expect(result?.[0][0]).toHaveLength(1025);
  });

  it('returns null for a buffer that reaches a pole', () => {
    expect(buffer({ type: 'Point', coordinates: [0, 90] }, 100)).toBeNull();
    expect(buffer({ type: 'Point', coordinates: [0, 89.9999] }, 100)).toBeNull();
    expect(buffer({ type: 'Point', coordinates: [0, -89.5] }, 100_000)).toBeNull();
  });

  it('returns null for an edge spanning more than 180 degrees of longitude', () => {
    const across = {
      type: 'LineString' as const,
      coordinates: [
        [179.9, 0],
        [-179.9, 0],
      ] as Coordinate[],
    };
    expect(buffer(across, 1000)).toBeNull();
  });

  it('returns null for a coordinate that is not finite', () => {
    const broken = {
      type: 'LineString' as const,
      coordinates: [
        [139, 35],
        [Number.NaN, 35],
      ] as Coordinate[],
    };
    expect(buffer(broken, 100)).toBeNull();
  });

  it('keeps every output coordinate finite and inside the latitude range near a pole', () => {
    const result = buffer({ type: 'Point', coordinates: [10, 85] }, 10_000);
    expect(result).not.toBeNull();
    const parts = result as MultiPolygonCoordinates;
    expect(allFinite(parts)).toBe(true);
    for (const [, lat] of parts[0][0]) expect(Math.abs(lat)).toBeLessThan(90);
  });
});

describe('simplify: a tolerance that is not a positive number', () => {
  const path: Coordinate[] = [
    [0, 0],
    [1, 0.5],
    [2, 0],
    [3, 0.5],
  ];

  it('returns a copy for NaN instead of collapsing to the end points', () => {
    expect(simplify(path, Number.NaN)).toEqual(path);
  });

  it('returns a copy for a negative value', () => {
    expect(simplify(path, -1)).toEqual(path);
  });
});

describe('coordinatesBBox: non-finite coordinates', () => {
  it('skips a coordinate that is not finite', () => {
    expect(
      coordinatesBBox([
        [0, 0],
        [Number.NaN, 5],
        [2, 3],
        [Number.POSITIVE_INFINITY, 1],
      ]),
    ).toEqual([0, 0, 2, 3]);
  });

  it('returns null when no coordinate is finite', () => {
    expect(coordinatesBBox([[Number.NaN, Number.NaN]])).toBeNull();
  });
});

describe('polygon-clipping boundary: input it cannot take', () => {
  // polygon-clipping 0.15.7 throws "Unable to pop() right SweepEvent" on NaN and silently
  // drops Infinity. The rings holding them are dropped before the call instead.
  const square = rect(0, 0, 1, 1);
  const withNaN: Ring = [
    [0.5, 0.5],
    [2, Number.NaN],
    [2, 2],
    [0.5, 0.5],
  ];
  const withInfinity: Ring = [
    [0.5, 0.5],
    [Number.POSITIVE_INFINITY, 0.5],
    [2, 2],
    [0.5, 0.5],
  ];

  it('makes union with a NaN ring throw nothing and keep the valid input', () => {
    expect(() => union([square], [withNaN])).not.toThrow();
    expect(sphericalArea(union([square], [withNaN]))).toBeCloseTo(sphericalArea([square]), 0);
  });

  it('drops a ring holding Infinity the same way', () => {
    expect(union([square], [withInfinity])).toEqual(normalizeArea([square]));
    expect(intersection([square], [withInfinity])).toEqual([]);
    expect(difference([square], [withInfinity])).toEqual(normalizeArea([square]));
  });

  it('drops a whole part whose outer ring is unusable instead of promoting its hole', () => {
    const hole = rect(0.2, 0.2, 0.4, 0.4);
    expect(normalizeArea([withNaN, hole])).toEqual([]);
    expect(unionAll([[withNaN, hole], [square]])).toEqual(normalizeArea([square]));
  });
});

describe('sphericalArea: rings that are not a valid polygon', () => {
  const outer = rect(0, 0, 1, 1);
  const outerArea = sphericalArea([outer]);

  it('ignores a hole that lies outside its outer ring', () => {
    const farHole = rect(5, 5, 6, 6);
    expect(sphericalArea([outer, farHole])).toBeCloseTo(outerArea, -2);
    expect(outerArea).toBeGreaterThan(1.2e10);
  });

  it('never becomes negative for a hole larger than its outer ring', () => {
    expect(sphericalArea([outer, rect(-1, -1, 2, 2)])).toBe(0);
  });
});

describe('isMultiPolygonCoordinates: an empty first part', () => {
  const multi = [[], [rect(0, 0, 1, 1)]] as unknown as AreaCoordinates;

  it('recognizes a MultiPolygon whose first part is empty', () => {
    expect(isMultiPolygonCoordinates(multi)).toBe(true);
    expect(toMultiPolygonCoordinates(multi)).toBe(multi);
  });

  it('recognizes a MultiPolygon whose first ring is empty', () => {
    expect(isMultiPolygonCoordinates([[[]], [rect(0, 0, 1, 1)]] as AreaCoordinates)).toBe(true);
  });

  it('still treats Polygon coordinates as a Polygon', () => {
    expect(isMultiPolygonCoordinates([rect(0, 0, 1, 1)])).toBe(false);
    expect(isMultiPolygonCoordinates([[], rect(0, 0, 1, 1)] as AreaCoordinates)).toBe(false);
  });

  it('measures the area of the non-empty part', () => {
    expect(sphericalArea(multi)).toBeCloseTo(sphericalArea([rect(0, 0, 1, 1)]), -2);
  });
});
