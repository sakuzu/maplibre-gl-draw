// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import {
  isRingClockwise,
  normalizeMultiPolygonOrientation,
  normalizePolygonOrientation,
  normalizeRingOrientation,
  signedRingArea,
  simplify,
} from './simplify.js';
import type { Coordinate, MultiPolygonCoordinates, PolygonCoordinates, Ring } from './types.js';

/** Counter-clockwise rectangular ring */
function rect(minX: number, minY: number, maxX: number, maxY: number): Ring {
  return [
    [minX, minY],
    [maxX, minY],
    [maxX, maxY],
    [minX, maxY],
    [minX, minY],
  ];
}

describe('simplify', () => {
  it('drops intermediate points on a straight line', () => {
    const path: Coordinate[] = [
      [0, 0],
      [1, 0],
      [2, 0],
      [3, 0],
    ];
    expect(simplify(path, 0.001)).toEqual([
      [0, 0],
      [3, 0],
    ]);
  });

  it('keeps a bulge larger than the tolerance', () => {
    const path: Coordinate[] = [
      [0, 0],
      [1, 0.5],
      [2, 0],
    ];
    expect(simplify(path, 0.1)).toHaveLength(3);
  });

  it('drops a bulge smaller than the tolerance', () => {
    const path: Coordinate[] = [
      [0, 0],
      [1, 0.05],
      [2, 0],
    ];
    expect(simplify(path, 0.1)).toHaveLength(2);
  });

  it('always keeps the end points', () => {
    const path: Coordinate[] = [
      [0, 0],
      [1, 0],
      [2, 0],
    ];
    const result = simplify(path, 10);
    expect(result[0]).toEqual([0, 0]);
    expect(result[result.length - 1]).toEqual([2, 0]);
  });

  it('returns a closed ring still closed', () => {
    const ring = rect(0, 0, 10, 10);
    const result = simplify(ring, 0.001);
    expect(result[0]).toEqual(result[result.length - 1]);
    expect(result).toHaveLength(5);
  });

  it('returns the input as it is when the ring would collapse to fewer than 4 points', () => {
    const ring = rect(0, 0, 0.0001, 0.0001);
    expect(simplify(ring, 1)).toEqual(ring);
  });

  it('returns a copy for a tolerance of 0 or for 2 points or fewer', () => {
    const path: Coordinate[] = [
      [0, 0],
      [1, 1],
      [2, 2],
    ];
    expect(simplify(path, 0)).toEqual(path);
    expect(simplify(path, 0)).not.toBe(path);
    expect(simplify([[0, 0]], 1)).toEqual([[0, 0]]);
  });

  it('does not destroy the input', () => {
    const path: Coordinate[] = [
      [0, 0],
      [1, 0],
      [2, 0],
    ];
    simplify(path, 0.001);
    expect(path).toHaveLength(3);
  });
});

describe('signedRingArea / isRingClockwise', () => {
  it('gives a positive value for counter-clockwise', () => {
    expect(signedRingArea(rect(0, 0, 2, 2))).toBeCloseTo(4, 10);
    expect(isRingClockwise(rect(0, 0, 2, 2))).toBe(false);
  });

  it('gives a negative value for clockwise', () => {
    const clockwise: Ring = [...rect(0, 0, 2, 2)].reverse();
    expect(signedRingArea(clockwise)).toBeCloseTo(-4, 10);
    expect(isRingClockwise(clockwise)).toBe(true);
  });

  it('returns 0 for fewer than 3 points', () => {
    expect(
      signedRingArea([
        [0, 0],
        [1, 1],
      ]),
    ).toBe(0);
  });
});

describe('normalizeRingOrientation', () => {
  it('returns the same array when the orientation matches the one requested', () => {
    const ring = rect(0, 0, 2, 2);
    expect(normalizeRingOrientation(ring, false)).toBe(ring);
  });

  it('returns a reversed array when the orientation differs from the one requested', () => {
    const ring = rect(0, 0, 2, 2);
    const result = normalizeRingOrientation(ring, true);
    expect(result).not.toBe(ring);
    expect(isRingClockwise(result)).toBe(true);
  });
});

describe('normalizePolygonOrientation', () => {
  it('makes the outer ring counter-clockwise and inner rings clockwise', () => {
    const polygon: PolygonCoordinates = [[...rect(0, 0, 10, 10)].reverse(), rect(3, 3, 6, 6)];
    const result = normalizePolygonOrientation(polygon);
    expect(isRingClockwise(result[0])).toBe(false);
    expect(isRingClockwise(result[1])).toBe(true);
  });
});

describe('normalizeMultiPolygonOrientation', () => {
  it('aligns the orientation of every part', () => {
    const multiPolygon: MultiPolygonCoordinates = [
      [[...rect(0, 0, 2, 2)].reverse()],
      [rect(5, 5, 7, 7), rect(5.5, 5.5, 6, 6)],
    ];
    const result = normalizeMultiPolygonOrientation(multiPolygon);
    expect(isRingClockwise(result[0][0])).toBe(false);
    expect(isRingClockwise(result[1][0])).toBe(false);
    expect(isRingClockwise(result[1][1])).toBe(true);
  });
});
