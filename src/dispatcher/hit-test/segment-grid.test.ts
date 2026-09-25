// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for the segment grid index
 *
 * They check that the distance obtained through the index matches the full scan
 * (pointToPolylineDistance) exactly, that the bbox query misses nothing, that degenerate
 * cases do not break it, and that the cache works.
 */

import { describe, expect, it } from 'vitest';
import { pointToPolylineDistance } from '../../shared/math/index.js';
import type { BoundingBox, Coordinate } from '../../store/types.js';
import {
  buildSegmentGrid,
  getSegmentGrid,
  polylineDistanceWithin,
  queryDistanceWithin,
  querySegmentIndicesInBBox,
  SEGMENT_INDEX_THRESHOLD,
} from './segment-grid.js';

/** A seeded pseudo random number generator (Math.random is not used, so that the tests
 * stay deterministic) */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Builds a polyline with a random walk */
function randomPolyline(count: number, seed: number): Coordinate[] {
  const random = mulberry32(seed);
  const coords: Coordinate[] = [];
  let x = 0;
  let y = 0;
  for (let i = 0; i < count; i++) {
    x += random() * 2 - 1;
    y += random() * 2 - 1;
    coords.push([x, y]);
  }
  return coords;
}

/** The "distance within the tolerance" obtained by a full scan */
function bruteForce(coords: Coordinate[], point: Coordinate, tolerance: number): number | null {
  const distance = pointToPolylineDistance(point, coords);
  return distance <= tolerance ? distance : null;
}

describe('queryDistanceWithin', () => {
  it('matches the full scan on a polyline with 2,000 vertices', () => {
    const coords = randomPolyline(2000, 12345);
    const grid = buildSegmentGrid(coords);
    const random = mulberry32(999);

    let withinCount = 0;
    let outsideCount = 0;

    for (let i = 0; i < 100; i++) {
      // Scatter the points from near the polyline to far away from it
      const base = coords[Math.floor(random() * coords.length)];
      const point: Coordinate = [base[0] + (random() * 6 - 3), base[1] + (random() * 6 - 3)];
      const tolerance = 0.5;

      const expected = bruteForce(coords, point, tolerance);
      const actual = queryDistanceWithin(grid, coords, point, tolerance);

      expect(actual).toBe(expected);
      if (expected === null) {
        outsideCount++;
      } else {
        withinCount++;
      }
    }

    // It has to include both the cases within the tolerance and the ones outside it
    expect(withinCount).toBeGreaterThan(0);
    expect(outsideCount).toBeGreaterThan(0);
  });

  it('matches the full scan for different tolerances too', () => {
    const coords = randomPolyline(2048, 777);
    const grid = buildSegmentGrid(coords);
    const random = mulberry32(31);

    for (const tolerance of [0, 0.01, 1, 100]) {
      for (let i = 0; i < 25; i++) {
        const point: Coordinate = [random() * 60 - 30, random() * 60 - 30];
        expect(queryDistanceWithin(grid, coords, point, tolerance)).toBe(
          bruteForce(coords, point, tolerance),
        );
      }
    }
  });

  it('returns the same result on repeated queries of one index (visit stamps cleaned up)', () => {
    const coords = randomPolyline(1500, 42);
    const grid = buildSegmentGrid(coords);
    const point: Coordinate = [coords[10][0] + 0.1, coords[10][1]];

    const first = queryDistanceWithin(grid, coords, point, 1);
    for (let i = 0; i < 10; i++) {
      expect(queryDistanceWithin(grid, coords, point, 1)).toBe(first);
    }
  });

  it('returns null for a query outside the bbox', () => {
    const coords = randomPolyline(1200, 5);
    const grid = buildSegmentGrid(coords);

    expect(queryDistanceWithin(grid, coords, [10000, 10000], 1)).toBeNull();
    expect(queryDistanceWithin(grid, coords, [-10000, 0], 1)).toBeNull();
  });
});

describe('degenerate cases of queryDistanceWithin', () => {
  it('matches the full scan even when every vertex has the same coordinate', () => {
    const coords: Coordinate[] = Array.from({ length: 1500 }, () => [3, 4] as Coordinate);
    const grid = buildSegmentGrid(coords);

    expect(queryDistanceWithin(grid, coords, [3, 4], 0)).toBe(0);
    expect(queryDistanceWithin(grid, coords, [3, 4.5], 1)).toBe(bruteForce(coords, [3, 4.5], 1));
    expect(queryDistanceWithin(grid, coords, [3, 10], 1)).toBeNull();
  });

  it('matches the full scan even on a perfectly vertical line', () => {
    const coords: Coordinate[] = Array.from(
      { length: 1500 },
      (_, i) => [5, i * 0.01] as Coordinate,
    );
    const grid = buildSegmentGrid(coords);

    for (const point of [
      [5, 7] as Coordinate,
      [5.2, 3] as Coordinate,
      [4.5, 3] as Coordinate,
      [5, -1] as Coordinate,
    ]) {
      expect(queryDistanceWithin(grid, coords, point, 0.5)).toBe(bruteForce(coords, point, 0.5));
    }
  });

  it('matches the full scan even on a perfectly horizontal line', () => {
    const coords: Coordinate[] = Array.from(
      { length: 1500 },
      (_, i) => [i * 0.01, -2] as Coordinate,
    );
    const grid = buildSegmentGrid(coords);

    for (const point of [
      [7, -2] as Coordinate,
      [3, -1.8] as Coordinate,
      [3, -5] as Coordinate,
      [-1, -2] as Coordinate,
    ]) {
      expect(queryDistanceWithin(grid, coords, point, 0.5)).toBe(bruteForce(coords, point, 0.5));
    }
  });

  it('matches the full scan even when segments of length 0 are mixed in', () => {
    const source = randomPolyline(1000, 2024);
    const coords: Coordinate[] = [];
    for (const coord of source) {
      // Put the same coordinate in twice to make a segment of length 0
      coords.push(coord, [coord[0], coord[1]]);
    }
    const grid = buildSegmentGrid(coords);
    const random = mulberry32(8);

    for (let i = 0; i < 30; i++) {
      const base = coords[Math.floor(random() * coords.length)];
      const point: Coordinate = [base[0] + (random() * 2 - 1), base[1] + (random() * 2 - 1)];
      expect(queryDistanceWithin(grid, coords, point, 0.3)).toBe(bruteForce(coords, point, 0.3));
    }
  });

  it('matches the full scan in the tolerance test even with 2 vertices', () => {
    const coords: Coordinate[] = [
      [0, 0],
      [10, 0],
    ];
    const grid = buildSegmentGrid(coords);

    expect(queryDistanceWithin(grid, coords, [5, 0], 0)).toBe(0);
    expect(queryDistanceWithin(grid, coords, [5, 1], 2)).toBe(bruteForce(coords, [5, 1], 2));
    expect(queryDistanceWithin(grid, coords, [5, 3], 2)).toBeNull();
  });

  it('returns null when there is not a single segment', () => {
    expect(queryDistanceWithin(buildSegmentGrid([]), [], [0, 0], 1)).toBeNull();

    const single: Coordinate[] = [[1, 1]];
    expect(queryDistanceWithin(buildSegmentGrid(single), single, [1, 1], 1)).toBeNull();
  });

  it('hits only on the segment itself when tolerance = 0', () => {
    const coords: Coordinate[] = Array.from({ length: 1200 }, (_, i) => [i * 0.5, 0] as Coordinate);
    const grid = buildSegmentGrid(coords);

    expect(queryDistanceWithin(grid, coords, [100, 0], 0)).toBe(0);
    expect(queryDistanceWithin(grid, coords, [100, 0.000001], 0)).toBeNull();
  });
});

/** Finds the indices of the segments that overlap a bbox with a full scan */
function bruteForceIndices(coords: Coordinate[], bbox: BoundingBox): number[] {
  const indices: number[] = [];
  for (let i = 0; i < coords.length - 1; i++) {
    const [ax, ay] = coords[i];
    const [bx, by] = coords[i + 1];
    const minX = Math.min(ax, bx);
    const maxX = Math.max(ax, bx);
    const minY = Math.min(ay, by);
    const maxY = Math.max(ay, by);
    if (minX <= bbox.maxX && maxX >= bbox.minX && minY <= bbox.maxY && maxY >= bbox.minY) {
      indices.push(i);
    }
  }
  return indices;
}

describe('querySegmentIndicesInBBox', () => {
  it('includes every result of the full scan, in ascending order and without duplicates', () => {
    const coords = randomPolyline(3000, 20260811);
    const grid = buildSegmentGrid(coords);
    const random = mulberry32(555);

    let hits = 0;

    for (let i = 0; i < 100; i++) {
      const base = coords[Math.floor(random() * coords.length)];
      const halfX = 0.05 + random() * 0.5;
      const halfY = 0.05 + random() * 0.5;
      const cx = base[0] + (random() * 2 - 1);
      const cy = base[1] + (random() * 2 - 1);
      const bbox: BoundingBox = {
        minX: cx - halfX,
        minY: cy - halfY,
        maxX: cx + halfX,
        maxY: cy + halfY,
      };

      const actual = querySegmentIndicesInBBox(grid, bbox);
      const expected = bruteForceIndices(coords, bbox);

      // Nothing is missed (returning more than necessary is allowed)
      const returned = new Set(actual);
      for (const index of expected) {
        expect(returned.has(index)).toBe(true);
      }

      // Ascending order and no duplicates
      expect([...actual].sort((a, b) => a - b)).toEqual(actual);
      expect(returned.size).toBe(actual.length);

      if (expected.length > 0) hits++;
    }

    expect(hits).toBeGreaterThan(0);
  });

  it('returns nothing for a query that does not intersect the bbox of the index', () => {
    const coords = randomPolyline(1200, 5);
    const grid = buildSegmentGrid(coords);

    expect(
      querySegmentIndicesInBBox(grid, { minX: 1000, minY: 1000, maxX: 1001, maxY: 1001 }),
    ).toEqual([]);
    expect(
      querySegmentIndicesInBBox(grid, { minX: -1001, minY: -1, maxX: -1000, maxY: 1 }),
    ).toEqual([]);
  });

  it('returns every segment for a query that covers the whole index', () => {
    const coords = randomPolyline(1500, 6);
    const grid = buildSegmentGrid(coords);

    const all = querySegmentIndicesInBBox(grid, {
      minX: grid.minX,
      minY: grid.minY,
      maxX: grid.maxX,
      maxY: grid.maxY,
    });

    expect(all.length).toBe(grid.segmentCount);
    expect(all[0]).toBe(0);
    expect(all[all.length - 1]).toBe(grid.segmentCount - 1);
  });

  it('returns the same result when queried repeatedly (cleanup of the visit stamps)', () => {
    const coords = randomPolyline(1500, 42);
    const grid = buildSegmentGrid(coords);
    const bbox: BoundingBox = {
      minX: coords[10][0] - 0.3,
      minY: coords[10][1] - 0.3,
      maxX: coords[10][0] + 0.3,
      maxY: coords[10][1] + 0.3,
    };

    const first = querySegmentIndicesInBBox(grid, bbox);
    expect(first.length).toBeGreaterThan(0);
    for (let i = 0; i < 10; i++) {
      expect(querySegmentIndicesInBBox(grid, bbox)).toEqual(first);
    }
  });

  it('returns nothing when there is not a single segment', () => {
    const single: Coordinate[] = [[1, 1]];
    const bbox: BoundingBox = { minX: 0, minY: 0, maxX: 2, maxY: 2 };

    expect(querySegmentIndicesInBBox(buildSegmentGrid([]), bbox)).toEqual([]);
    expect(querySegmentIndicesInBBox(buildSegmentGrid(single), bbox)).toEqual([]);
  });

  it('misses nothing even on a degenerate polyline (vertical, or all the same coordinate)', () => {
    const vertical: Coordinate[] = Array.from({ length: 1500 }, (_, i) => [5, i * 0.01]);
    const same: Coordinate[] = Array.from({ length: 1500 }, () => [3, 4]);

    for (const coords of [vertical, same]) {
      const grid = buildSegmentGrid(coords);
      const bbox: BoundingBox = {
        minX: coords[0][0] - 0.5,
        minY: coords[0][1] - 0.5,
        maxX: coords[0][0] + 0.5,
        maxY: coords[0][1] + 0.5,
      };
      const returned = new Set(querySegmentIndicesInBBox(grid, bbox));
      for (const index of bruteForceIndices(coords, bbox)) {
        expect(returned.has(index)).toBe(true);
      }
    }
  });
});

describe('the cache of getSegmentGrid', () => {
  it('does not rebuild the index for the same array reference', () => {
    const coords = randomPolyline(1200, 61);

    const first = getSegmentGrid(coords);
    const second = getSegmentGrid(coords);

    expect(second).toBe(first);
  });

  it('another array with the same contents gets another index (a replacement rebuilds it)', () => {
    const coords = randomPolyline(1200, 61);
    const replaced = coords.map((c) => [c[0], c[1]] as Coordinate);

    expect(getSegmentGrid(replaced)).not.toBe(getSegmentGrid(coords));
  });
});

describe('polylineDistanceWithin', () => {
  it('scans fully below the threshold and indexes above, both matching the full scan', () => {
    const small = randomPolyline(SEGMENT_INDEX_THRESHOLD - 1, 3);
    const large = randomPolyline(SEGMENT_INDEX_THRESHOLD * 2, 3);
    const random = mulberry32(101);

    for (const coords of [small, large]) {
      for (let i = 0; i < 30; i++) {
        const base = coords[Math.floor(random() * coords.length)];
        const point: Coordinate = [base[0] + (random() * 4 - 2), base[1] + (random() * 4 - 2)];
        expect(polylineDistanceWithin(coords, point, 0.4)).toBe(bruteForce(coords, point, 0.4));
      }
    }
  });
});
