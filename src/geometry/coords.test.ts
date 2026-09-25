// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { bboxContains, bboxIntersects, boundingBox, coordinatesBBox } from './bbox.js';
import {
  closeRing,
  flattenAreaCoordinates,
  isMultiPolygonCoordinates,
  isRingClosed,
  toMultiPolygonCoordinates,
} from './coords.js';
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

describe('isMultiPolygonCoordinates', () => {
  it('returns false for Polygon coordinates', () => {
    expect(isMultiPolygonCoordinates([rect(0, 0, 1, 1)])).toBe(false);
  });

  it('returns true for MultiPolygon coordinates', () => {
    expect(isMultiPolygonCoordinates([[rect(0, 0, 1, 1)]])).toBe(true);
  });

  it('returns false for an empty array', () => {
    expect(isMultiPolygonCoordinates([])).toBe(false);
  });
});

describe('toMultiPolygonCoordinates', () => {
  it('turns Polygon coordinates into a single-part MultiPolygon', () => {
    const polygon: PolygonCoordinates = [rect(0, 0, 1, 1)];
    expect(toMultiPolygonCoordinates(polygon)).toEqual([polygon]);
  });

  it('returns MultiPolygon coordinates as they are', () => {
    const multi: MultiPolygonCoordinates = [[rect(0, 0, 1, 1)]];
    expect(toMultiPolygonCoordinates(multi)).toBe(multi);
  });

  it('returns an empty array for an empty array', () => {
    expect(toMultiPolygonCoordinates([])).toEqual([]);
  });
});

describe('isRingClosed / closeRing', () => {
  it('detects a closed ring', () => {
    expect(isRingClosed(rect(0, 0, 1, 1))).toBe(true);
    expect(
      isRingClosed([
        [0, 0],
        [1, 0],
        [1, 1],
      ]),
    ).toBe(false);
  });

  it('returns a closed ring as it is', () => {
    const ring = rect(0, 0, 1, 1);
    expect(closeRing(ring)).toBe(ring);
  });

  it('appends the first coordinate to the end of an open ring', () => {
    const result = closeRing([
      [0, 0],
      [1, 0],
      [1, 1],
    ]);
    expect(result).toHaveLength(4);
    expect(result[3]).toEqual([0, 0]);
  });
});

describe('flattenAreaCoordinates', () => {
  it('lines up the coordinates of every ring', () => {
    const withHole: PolygonCoordinates = [rect(0, 0, 10, 10), rect(3, 3, 6, 6)];
    expect(flattenAreaCoordinates(withHole)).toHaveLength(10);
  });
});

describe('coordinatesBBox / boundingBox', () => {
  it('returns the extent of a coordinate sequence', () => {
    expect(
      coordinatesBBox([
        [1, 2],
        [-3, 8],
        [5, 0],
      ]),
    ).toEqual([-3, 0, 5, 8]);
  });

  it('returns null for an empty coordinate sequence', () => {
    expect(coordinatesBBox([])).toBeNull();
    expect(boundingBox([])).toBeNull();
  });

  it('covers every part of a MultiPolygon', () => {
    const multi: MultiPolygonCoordinates = [[rect(0, 0, 1, 1)], [rect(5, 5, 6, 6)]];
    expect(boundingBox(multi)).toEqual([0, 0, 6, 6]);
  });
});

describe('bboxIntersects / bboxContains', () => {
  it('detects an overlap', () => {
    expect(bboxIntersects([0, 0, 2, 2], [1, 1, 3, 3])).toBe(true);
    expect(bboxIntersects([0, 0, 1, 1], [5, 5, 6, 6])).toBe(false);
  });

  it('treats touching as an overlap', () => {
    expect(bboxIntersects([0, 0, 1, 1], [1, 0, 2, 1])).toBe(true);
  });

  it('detects containment', () => {
    expect(bboxContains([0, 0, 10, 10], [1, 1, 2, 2])).toBe(true);
    expect(bboxContains([0, 0, 10, 10], [1, 1, 11, 2])).toBe(false);
  });

  it('treats matching boundaries as containment', () => {
    expect(bboxContains([0, 0, 1, 1], [0, 0, 1, 1])).toBe(true);
  });
});
