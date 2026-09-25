// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Robustness suite (the device that decides whether to adopt GEOS)
 *
 * This is the robustness side of the decision device in section 13 of the design
 * document. Instead of real data (administrative boundaries, meshes), it generates
 * synthetic data deterministically that reproduces their characteristics (exclaves,
 * holes, jagged outlines with thousands of vertices, blocks that share edges) and
 * pathological inputs (self-intersections, slivers, duplicated vertices, nearly
 * collinear points, extreme differences in magnitude), and verifies that the
 * boolean operations and the buffer throw no exception and return topologically
 * valid results.
 *
 * The random numbers come from an in-house fixed-seed implementation; Math.random
 * is not used. Every run takes the same input and produces the same result.
 */

import { describe, expect, it } from 'vitest';
import { difference, intersection, normalizeArea, union, unionAll } from './boolean.js';
import { buffer } from './buffer.js';
import { toMultiPolygonCoordinates } from './coords.js';
import { sphericalArea } from './measure.js';
import { isRingClockwise, signedRingArea } from './simplify.js';
import type {
  AreaCoordinates,
  Coordinate,
  MultiPolygonCoordinates,
  PolygonCoordinates,
  Ring,
} from './types.js';

// ---------------------------------------------------------------------------
// Deterministic pseudo random numbers
// ---------------------------------------------------------------------------

/**
 * Fixed-seed pseudo random generator (mulberry32)
 *
 * It consists only of 32-bit integer arithmetic, so it returns the same sequence
 * regardless of the environment.
 *
 * @param seed The seed
 * @returns A function that returns a value from 0 inclusive to 1 exclusive
 */
function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Synthetic data equivalent to administrative boundaries
// ---------------------------------------------------------------------------

/**
 * Builds a jagged outline ring
 *
 * The angle increases monotonically and only the radius is perturbed, so however
 * many vertices are added it stays a simple polygon without self-intersection. It
 * reproduces only the "many vertices with finely bent edges" property of real
 * coastlines and administrative boundaries.
 *
 * @param center The center
 * @param baseRadius The base radius (degrees)
 * @param vertexCount The number of vertices
 * @param roughness The ratio of the radius perturbation (from 0 to below 1)
 * @param random The pseudo random generator
 * @returns A closed ring
 */
function jaggedRing(
  center: Coordinate,
  baseRadius: number,
  vertexCount: number,
  roughness: number,
  random: () => number,
): Ring {
  const ring: Ring = [];
  for (let i = 0; i < vertexCount; i++) {
    const angle = (i / vertexCount) * Math.PI * 2;
    const radius = baseRadius * (1 + (random() - 0.5) * roughness);
    ring.push([center[0] + radius * Math.cos(angle), center[1] + radius * Math.sin(angle) * 0.8]);
  }
  ring.push(ring[0]);
  return ring;
}

/**
 * An administrative boundary equivalent with a hole (a Lake Biwa shape)
 *
 * It has one inner ring for the lake inside its outer ring.
 */
function lakeDistrict(): PolygonCoordinates {
  const random = createRandom(1001);
  const outer = jaggedRing([139.6, 35.4], 0.4, 900, 0.25, random);
  const lake = jaggedRing([139.65, 35.44], 0.08, 240, 0.3, random);
  return [outer, lake];
}

/**
 * An administrative boundary equivalent with exclaves (multiple parts)
 *
 * It consists of the main body and 2 small exclaves set apart from it.
 */
function exclaveDistrict(): MultiPolygonCoordinates {
  const random = createRandom(2002);
  return [
    [jaggedRing([140.4, 35.4], 0.3, 600, 0.2, random)],
    [jaggedRing([141.1, 35.7], 0.05, 120, 0.3, random)],
    [jaggedRing([141.2, 35.1], 0.04, 90, 0.35, random)],
  ];
}

/**
 * Tiling of blocks that share edges
 *
 * The boundary coordinates of adjacent tiles are generated from the same
 * expression, so the situation matches the "blocks whose shared edges match
 * exactly" found in real data.
 *
 * @param columns The number of columns
 * @param rows The number of rows
 * @param origin The coordinate of the lower left corner
 * @param cell The length of one side (degrees)
 * @returns An array of tiles
 */
function tiles(
  columns: number,
  rows: number,
  origin: Coordinate,
  cell: number,
): PolygonCoordinates[] {
  const result: PolygonCoordinates[] = [];
  for (let column = 0; column < columns; column++) {
    for (let row = 0; row < rows; row++) {
      const minLng = origin[0] + column * cell;
      const minLat = origin[1] + row * cell;
      const maxLng = origin[0] + (column + 1) * cell;
      const maxLat = origin[1] + (row + 1) * cell;
      result.push([
        [
          [minLng, minLat],
          [maxLng, minLat],
          [maxLng, maxLat],
          [minLng, maxLat],
          [minLng, minLat],
        ],
      ]);
    }
  }
  return result;
}

/** Polygon coordinates of a rectangle */
function rectPolygon(
  minLng: number,
  minLat: number,
  maxLng: number,
  maxLat: number,
): PolygonCoordinates {
  return [
    [
      [minLng, minLat],
      [maxLng, minLat],
      [maxLng, maxLat],
      [minLng, maxLat],
      [minLng, minLat],
    ],
  ];
}

// ---------------------------------------------------------------------------
// Pathological inputs
// ---------------------------------------------------------------------------

/**
 * Bowtie (a quadrilateral that self-intersects at one place)
 */
function bowtie(): PolygonCoordinates {
  return [
    [
      [139.0, 35.0],
      [139.2, 35.2],
      [139.2, 35.0],
      [139.0, 35.2],
      [139.0, 35.0],
    ],
  ];
}

/**
 * Figure eight (a self-intersecting ring sampled from a lemniscate)
 *
 * It crosses once at the origin and splits into 2 lobes.
 */
function figureEight(vertexCount = 128): PolygonCoordinates {
  const ring: Ring = [];
  const scale = 0.2;
  for (let i = 0; i < vertexCount; i++) {
    const t = (i / vertexCount) * Math.PI * 2;
    const denominator = 1 + Math.sin(t) * Math.sin(t);
    ring.push([
      139.0 + (scale * Math.cos(t)) / denominator,
      35.0 + (scale * Math.sin(t) * Math.cos(t)) / denominator,
    ]);
  }
  ring.push(ring[0]);
  return [ring];
}

/**
 * Sliver (a triangle that is extremely narrow; its area is almost zero)
 */
function sliver(): PolygonCoordinates {
  return [
    [
      [139.0, 35.0],
      [139.2, 35.0 + 1e-11],
      [139.4, 35.0],
      [139.0, 35.0],
    ],
  ];
}

/**
 * Duplicated vertices (a rectangle in which each vertex appears 3 times)
 */
function duplicatedVertices(): PolygonCoordinates {
  const corners: Coordinate[] = [
    [139.0, 35.0],
    [139.2, 35.0],
    [139.2, 35.2],
    [139.0, 35.2],
  ];
  const ring: Ring = [];
  for (const corner of corners) {
    ring.push(corner, corner, corner);
  }
  ring.push(corners[0]);
  return [ring];
}

/**
 * A nearly collinear vertex sequence (the top edge is split into 300 and swung up
 * and down by only 1e-12 degrees)
 */
function nearlyCollinear(): PolygonCoordinates {
  const random = createRandom(3003);
  const ring: Ring = [[139.0, 35.0]];
  const steps = 300;
  for (let i = 0; i <= steps; i++) {
    const lng = 139.0 + (i / steps) * 0.2;
    ring.push([lng, 35.1 + (random() - 0.5) * 2e-12]);
  }
  ring.push([139.2, 35.0]);
  ring.push([139.0, 35.0]);
  return [ring];
}

/**
 * An extreme difference in the magnitude of coordinate values (a rectangle with
 * edges of 1e-12 degrees at coordinates in the 139 degree range)
 *
 * Near 139 in double precision, 1e-12 is only about 70 times the smallest step
 * (about 1.4e-14), which is the scale where cancellation shows up most easily.
 */
function microScale(offsetLng = 0, offsetLat = 0): PolygonCoordinates {
  const lng = 139.6917 + offsetLng;
  const lat = 35.6895 + offsetLat;
  return rectPolygon(lng, lat, lng + 1e-12, lat + 1e-12);
}

// ---------------------------------------------------------------------------
// Checks for topological validity and the conservation laws of area
// ---------------------------------------------------------------------------

/** Relative tolerance used to compare areas */
const RELATIVE_TOLERANCE = 1e-9;

/** Absolute tolerance used to compare areas (square degrees) */
const ABSOLUTE_TOLERANCE = 1e-18;

/** Upper bound with the tolerance folded in */
function upperBound(value: number): number {
  return value + Math.abs(value) * RELATIVE_TOLERANCE + ABSOLUTE_TOLERANCE;
}

/** Lower bound with the tolerance folded in */
function lowerBound(value: number): number {
  return value - Math.abs(value) * RELATIVE_TOLERANCE - ABSOLUTE_TOLERANCE;
}

/**
 * Checks whether the MultiPolygon coordinates are topologically valid
 *
 * It confirms that the values are finite, that the rings are closed, that no ring
 * without area is left, and that the orientation of an inner ring is the reverse of
 * the outer ring.
 */
function expectValidMultiPolygon(result: MultiPolygonCoordinates): void {
  for (const part of result) {
    expect(part.length).toBeGreaterThan(0);
    const outerClockwise = isRingClockwise(part[0]);

    for (let index = 0; index < part.length; index++) {
      const ring = part[index];
      expect(ring.length).toBeGreaterThanOrEqual(4);

      for (const [lng, lat] of ring) {
        expect(Number.isFinite(lng)).toBe(true);
        expect(Number.isFinite(lat)).toBe(true);
      }

      const first = ring[0];
      const last = ring[ring.length - 1];
      expect(first[0]).toBe(last[0]);
      expect(first[1]).toBe(last[1]);

      expect(signedRingArea(ring)).not.toBe(0);
      if (index > 0) {
        expect(isRingClockwise(ring)).toBe(!outerClockwise);
      }
    }
  }
}

/**
 * Area on the longitude-latitude plane (square degrees; inner rings are subtracted)
 *
 * The conservation laws are checked on the plane that polygon-clipping actually
 * computes on. The spherical area changes slightly when the edges are subdivided
 * finely (it is a discrete sum of spherical excess and picks up the gap between a
 * straight edge and a great circle arc). The result of a boolean operation has more
 * vertices than the input, so the planar area suits the check of the conservation
 * laws better. The spherical area is used to confirm the plausibility of the
 * magnitude (the direction of the change, and that it is positive).
 */
function planarArea(coordinates: AreaCoordinates): number {
  let total = 0;
  for (const part of toMultiPolygonCoordinates(coordinates)) {
    for (let index = 0; index < part.length; index++) {
      const area = Math.abs(signedRingArea(part[index]));
      total += index === 0 ? area : -area;
    }
  }
  return total;
}

/**
 * The planar area after self-intersections have been resolved
 *
 * The area of the input itself is meaningless when it self-intersects, so this
 * value is used as the reference for the conservation laws.
 */
function resolvedArea(coordinates: AreaCoordinates): number {
  return planarArea(normalizeArea(coordinates));
}

/**
 * Checks the conservation laws of area for 2 polygons
 *
 * It confirms that union does not exceed the sum of the areas and does not fall
 * below either input, that intersection does not exceed either input, that
 * difference does not exceed the original area, and in addition that the
 * inclusion-exclusion principle (union + intersection = the sum of the areas,
 * difference + intersection = the original area) holds.
 */
function expectAreaLaws(a: AreaCoordinates, b: AreaCoordinates): void {
  const areaA = resolvedArea(a);
  const areaB = resolvedArea(b);

  const unionResult = union(a, b);
  const intersectionResult = intersection(a, b);
  const differenceResult = difference(a, b);

  expectValidMultiPolygon(unionResult);
  expectValidMultiPolygon(intersectionResult);
  expectValidMultiPolygon(differenceResult);

  const unionArea = planarArea(unionResult);
  const intersectionArea = planarArea(intersectionResult);
  const differenceArea = planarArea(differenceResult);

  expect(unionArea).toBeLessThanOrEqual(upperBound(areaA + areaB));
  expect(unionArea).toBeGreaterThanOrEqual(lowerBound(Math.max(areaA, areaB)));
  expect(intersectionArea).toBeLessThanOrEqual(upperBound(Math.min(areaA, areaB)));
  expect(differenceArea).toBeLessThanOrEqual(upperBound(areaA));

  expect(unionArea + intersectionArea).toBeLessThanOrEqual(upperBound(areaA + areaB));
  expect(unionArea + intersectionArea).toBeGreaterThanOrEqual(lowerBound(areaA + areaB));
  expect(differenceArea + intersectionArea).toBeLessThanOrEqual(upperBound(areaA));
  expect(differenceArea + intersectionArea).toBeGreaterThanOrEqual(lowerBound(areaA));
}

// ---------------------------------------------------------------------------
// Data equivalent to administrative boundaries
// ---------------------------------------------------------------------------

describe('robustness: data equivalent to administrative boundaries', () => {
  it('makes operations between a polygon with a hole and an overlapping polygon satisfy the conservation laws', () => {
    const district = lakeDistrict();
    const overlap = rectPolygon(139.5, 35.3, 139.9, 35.6);
    expectAreaLaws(district, overlap);
  });

  it('keeps the hole in the result', () => {
    const district = lakeDistrict();
    // Cutting at a position that does not touch the lake leaves the inner ring of the lake
    const result = difference(district, rectPolygon(139.2, 35.0, 139.35, 35.2));
    expectValidMultiPolygon(result);
    const holeCount = result.reduce((total, part) => total + part.length - 1, 0);
    expect(holeCount).toBe(1);
  });

  it('makes the intersection with the inside of a hole empty', () => {
    const district = lakeDistrict();
    const insideLake = rectPolygon(139.648, 35.438, 139.652, 35.442);
    expect(intersection(district, insideLake)).toEqual([]);
  });

  it('makes operations on exclaves (multiple parts) keep the part structure', () => {
    const district = exclaveDistrict();
    expect(normalizeArea(district)).toHaveLength(3);
    expectAreaLaws(district, rectPolygon(140.2, 35.2, 140.6, 35.6));

    // Subtracting a polygon that covers only the main body leaves the 2 exclaves
    const result = difference(district, rectPolygon(140.0, 35.0, 140.8, 35.8));
    expectValidMultiPolygon(result);
    expect(result).toHaveLength(2);
  });

  it('makes unionAll of the exclaves and the main body not fuse the parts', () => {
    const district = exclaveDistrict();
    const result = unionAll(district.map((part) => part));
    expectValidMultiPolygon(result);
    expect(result).toHaveLength(3);
  });

  it('makes operations between jagged outlines with thousands of vertices satisfy the conservation laws', () => {
    const random = createRandom(4004);
    const left = [jaggedRing([139.0, 35.0], 0.3, 2000, 0.3, random)];
    const right = [jaggedRing([139.15, 35.05], 0.3, 2000, 0.3, random)];

    expect(left[0]).toHaveLength(2001);
    expectAreaLaws(left, right);
  });

  it('makes operations between a jagged outline and a polygon with a hole satisfy the conservation laws', () => {
    const random = createRandom(5005);
    const jagged = [jaggedRing([139.62, 35.42], 0.35, 1200, 0.35, random)];
    expectAreaLaws(lakeDistrict(), jagged);
  });

  it('produces neither a hole nor a sliver gap in unionAll of blocks that share edges', () => {
    const parts = tiles(30, 30, [139.7013, 35.4021], 0.00317);
    const result = unionAll(parts);

    expectValidMultiPolygon(result);
    expect(result).toHaveLength(1);
    // There is not a single inner ring (no gap has appeared)
    expect(result[0]).toHaveLength(1);

    const total = parts.reduce((sum, part) => sum + planarArea(part), 0);
    expect(planarArea(result)).toBeLessThanOrEqual(upperBound(total));
    expect(planarArea(result)).toBeGreaterThanOrEqual(lowerBound(total));
  });

  it('makes unionAll of the blocks with an inner block removed produce exactly 1 hole', () => {
    const parts = tiles(9, 9, [139.7013, 35.4021], 0.00317);
    // Remove the central tile (the center of 9x9 is index 40)
    const removed = parts[40];
    const remaining = parts.filter((_, index) => index !== 40);
    const result = unionAll(remaining);

    expectValidMultiPolygon(result);
    expect(result).toHaveLength(1);
    expect(result[0]).toHaveLength(2);

    const total = remaining.reduce((sum, part) => sum + planarArea(part), 0);
    expect(planarArea(result)).toBeLessThanOrEqual(upperBound(total));
    expect(planarArea(result)).toBeGreaterThanOrEqual(lowerBound(total));
    expect(sphericalArea(removed)).toBeGreaterThan(0);
  });

  it('makes the intersection of the blocks with an administrative boundary equivalent preserve the area', () => {
    // The blocks cover the administrative boundary completely (139.1-140.1, 35.0-36.0)
    const parts = tiles(10, 10, [139.1, 35.0], 0.1);
    const district = lakeDistrict();

    let total = 0;
    for (const part of parts) {
      const result = intersection(part, district);
      expectValidMultiPolygon(result);
      total += planarArea(result);
    }

    // Because they cover it completely, the total intersection area matches the area of the boundary
    const expected = resolvedArea(district);
    expect(total).toBeLessThanOrEqual(upperBound(expected));
    expect(total).toBeGreaterThanOrEqual(lowerBound(expected));
  });
});

// ---------------------------------------------------------------------------
// Pathological inputs
// ---------------------------------------------------------------------------

describe('robustness: pathological inputs', () => {
  it('resolves a bowtie self-intersection into 2 polygons', () => {
    const result = normalizeArea(bowtie());
    expectValidMultiPolygon(result);
    expect(result).toHaveLength(2);
  });

  it('resolves a figure-eight self-intersection into 2 lobes', () => {
    const result = normalizeArea(figureEight());
    expectValidMultiPolygon(result);
    expect(result).toHaveLength(2);
    // The 2 lobes have the same size
    const areas = result.map((part) => sphericalArea([part])).sort((a, b) => a - b);
    expect(areas[0] / areas[1]).toBeCloseTo(1, 6);
  });

  it('makes operations with a self-intersecting polygon satisfy the conservation laws', () => {
    expectAreaLaws(bowtie(), rectPolygon(139.1, 34.9, 139.3, 35.1));
    expectAreaLaws(figureEight(), rectPolygon(138.95, 34.95, 139.25, 35.05));
    expectAreaLaws(bowtie(), figureEight());
  });

  it('makes a sliver throw no exception and not increase the area', () => {
    const thin = sliver();
    const cover = rectPolygon(138.9, 34.9, 139.5, 35.1);

    const merged = union(thin, cover);
    expectValidMultiPolygon(merged);
    expect(planarArea(merged)).toBeLessThanOrEqual(upperBound(planarArea(cover)));

    const clipped = intersection(thin, cover);
    expectValidMultiPolygon(clipped);
    expect(planarArea(clipped)).toBeLessThanOrEqual(upperBound(resolvedArea(thin)));

    expectValidMultiPolygon(difference(cover, thin));
  });

  it('makes operations between slivers throw no exception', () => {
    const first = sliver();
    const second: PolygonCoordinates = [
      [
        [139.1, 35.0 - 1e-11],
        [139.3, 35.0],
        [139.5, 35.0 - 1e-11],
        [139.1, 35.0 - 1e-11],
      ],
    ];
    expect(() => union(first, second)).not.toThrow();
    expect(() => intersection(first, second)).not.toThrow();
    expect(() => difference(first, second)).not.toThrow();
    expect(() => unionAll([first, second, sliver()])).not.toThrow();
  });

  it('turns a polygon with duplicated vertices into a single polygon with the correct area', () => {
    const result = normalizeArea(duplicatedVertices());
    expectValidMultiPolygon(result);
    expect(result).toHaveLength(1);

    const expected = planarArea(rectPolygon(139.0, 35.0, 139.2, 35.2));
    expect(planarArea(result)).toBeLessThanOrEqual(upperBound(expected));
    expect(planarArea(result)).toBeGreaterThanOrEqual(lowerBound(expected));

    expectAreaLaws(duplicatedVertices(), rectPolygon(139.1, 35.1, 139.3, 35.3));
  });

  it('makes a nearly collinear vertex sequence throw no exception and satisfy the conservation laws', () => {
    const almostFlat = nearlyCollinear();
    expectValidMultiPolygon(normalizeArea(almostFlat));
    expectAreaLaws(almostFlat, rectPolygon(139.05, 35.02, 139.15, 35.2));
    expectAreaLaws(almostFlat, nearlyCollinear());
  });

  it('makes a polygon with an extreme difference in magnitude (1e-12 degrees) throw no exception', () => {
    const tiny = microScale();
    const shifted = microScale(5e-13, 5e-13);
    const huge = rectPolygon(139.0, 35.0, 140.0, 36.0);

    expect(() => union(tiny, shifted)).not.toThrow();
    expect(() => intersection(tiny, shifted)).not.toThrow();
    expect(() => difference(tiny, shifted)).not.toThrow();

    expectValidMultiPolygon(union(tiny, shifted));
    expectValidMultiPolygon(intersection(tiny, shifted));

    // The area does not grow even in an operation between a huge polygon and a tiny one
    const merged = union(huge, tiny);
    expectValidMultiPolygon(merged);
    expect(planarArea(merged)).toBeLessThanOrEqual(upperBound(planarArea(huge)));

    const carved = difference(huge, tiny);
    expectValidMultiPolygon(carved);
    expect(planarArea(carved)).toBeLessThanOrEqual(upperBound(planarArea(huge)));
  });

  it('throws no exception even when the pathological inputs are put through unionAll together', () => {
    const inputs: AreaCoordinates[] = [
      bowtie(),
      figureEight(),
      sliver(),
      duplicatedVertices(),
      nearlyCollinear(),
      microScale(),
      microScale(5e-13, 5e-13),
      lakeDistrict(),
      exclaveDistrict(),
    ];

    let result: MultiPolygonCoordinates = [];
    expect(() => {
      result = unionAll(inputs);
    }).not.toThrow();

    expectValidMultiPolygon(result);
    const total = inputs.reduce((sum, input) => sum + resolvedArea(input), 0);
    expect(planarArea(result)).toBeLessThanOrEqual(upperBound(total));
  });

  it('makes an input without area not break the result', () => {
    const degenerate: AreaCoordinates = [
      [
        [139.0, 35.0],
        [139.1, 35.1],
      ],
    ];
    const valid = rectPolygon(139.0, 35.0, 139.2, 35.2);

    expect(normalizeArea(degenerate)).toEqual([]);
    expect(union(degenerate, valid)).toHaveLength(1);
    expect(difference(degenerate, valid)).toEqual([]);
    expect(intersection(degenerate, valid)).toEqual([]);
    expect(unionAll([degenerate, valid, degenerate])).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Cascaded union (the remedy for the case where a bulk union of many inputs fails)
// ---------------------------------------------------------------------------

describe('robustness: fusion of many inputs', () => {
  /**
   * Polylines for which the buffer generates many circles and bands internally
   *
   * The 3 sets below are combinations where passing the generated parts to the
   * union of polygon-clipping all at once fails because the output ring cannot be
   * closed (known failure cases found by searching). They are avoided by the
   * binary-tree folding of unionAll.
   */
  const failingCases: Array<{ seed: number; vertexCount: number; meters: number }> = [
    { seed: 1286, vertexCount: 160, meters: 500 },
    { seed: 2727, vertexCount: 100, meters: 500 },
    { seed: 2458, vertexCount: 120, meters: 100 },
  ];

  /** A deterministic polyline (a random walk) */
  function randomWalk(seed: number, vertexCount: number): Coordinate[] {
    const random = createRandom(seed);
    const line: Coordinate[] = [];
    let lng = 139.7;
    let lat = 35.68;
    for (let i = 0; i < vertexCount; i++) {
      lng += (random() - 0.5) * 0.002;
      lat += (random() - 0.5) * 0.002;
      line.push([lng, lat]);
    }
    return line;
  }

  for (const { seed, vertexCount, meters } of failingCases) {
    it(`solves even a set of parts for which a bulk union fails, by folding (seed=${seed})`, () => {
      const line = randomWalk(seed, vertexCount);
      let result: MultiPolygonCoordinates | null = null;

      expect(() => {
        result = buffer({ type: 'LineString', coordinates: line }, meters);
      }).not.toThrow();

      expect(result).not.toBeNull();
      const value = result as unknown as MultiPolygonCoordinates;
      expectValidMultiPolygon(value);
      expect(value.length).toBeGreaterThan(0);
      expect(sphericalArea(value)).toBeGreaterThan(0);
    });
  }

  it('makes unionAll of many circles and bands throw no exception and become a single polygon', () => {
    const random = createRandom(6006);
    const centers: Coordinate[] = [];
    for (let i = 0; i < 400; i++) {
      const angle = i * 2.39996;
      const radius = 0.004 * Math.sqrt(i) * (0.8 + random() * 0.4);
      centers.push([139.7 + radius * Math.cos(angle), 35.68 + radius * Math.sin(angle)]);
    }

    const parts = centers.map(
      (center) => buffer({ type: 'Point', coordinates: center }, 900) as MultiPolygonCoordinates,
    );

    let result: MultiPolygonCoordinates = [];
    expect(() => {
      result = unionAll(parts);
    }).not.toThrow();

    expectValidMultiPolygon(result);
    expect(result).toHaveLength(1);
    const total = parts.reduce((sum, part) => sum + planarArea(part), 0);
    expect(planarArea(result)).toBeLessThanOrEqual(upperBound(total));
  });

  it('makes the result of the folding identical on every run (determinism)', () => {
    const parts = tiles(12, 12, [139.7013, 35.4021], 0.00317);
    const first = unionAll(parts);
    const second = unionAll(parts);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });
});

// ---------------------------------------------------------------------------
// Buffer
// ---------------------------------------------------------------------------

describe('robustness: buffer', () => {
  it('makes the buffer of a self-intersecting line return a polygon without an exception', () => {
    const ring = figureEight(200)[0];
    const result = buffer({ type: 'LineString', coordinates: ring }, 600);

    expect(result).not.toBeNull();
    const value = result as MultiPolygonCoordinates;
    expectValidMultiPolygon(value);
    expect(value).toHaveLength(1);
    expect(sphericalArea(value)).toBeGreaterThan(0);
  });

  it('turns the buffer of a closed ring into an annular polygon (with a hole)', () => {
    const random = createRandom(7007);
    const ring = jaggedRing([139.7, 35.68], 0.05, 300, 0.1, random);
    const result = buffer({ type: 'LineString', coordinates: ring }, 200);

    expect(result).not.toBeNull();
    const value = result as MultiPolygonCoordinates;
    expectValidMultiPolygon(value);
    expect(value).toHaveLength(1);
    // It has an outer ring and an inner ring (the inside of the ring is left as a hole)
    expect(value[0]).toHaveLength(2);
  });

  it('makes the buffer of a line with thousands of vertices return a polygon without an exception', () => {
    const random = createRandom(8008);
    const line: Coordinate[] = [];
    let lng = 139.4;
    let lat = 35.5;
    for (let i = 0; i < 2000; i++) {
      lng += 0.0002 + (random() - 0.5) * 0.0002;
      lat += (random() - 0.5) * 0.0004;
      line.push([lng, lat]);
    }

    let result: MultiPolygonCoordinates | null = null;
    expect(() => {
      result = buffer({ type: 'LineString', coordinates: line }, 120, { segments: 16 });
    }).not.toThrow();

    expect(result).not.toBeNull();
    const value = result as unknown as MultiPolygonCoordinates;
    expectValidMultiPolygon(value);
    expect(sphericalArea(value)).toBeGreaterThan(0);
  });

  it('makes the buffer of pathological inputs throw no exception', () => {
    const inputs: Coordinate[][] = [
      // A line made only of duplicated vertices
      [
        [139.0, 35.0],
        [139.0, 35.0],
        [139.0, 35.0],
      ],
      // Nearly collinear
      nearlyCollinear()[0],
      // Sliver
      sliver()[0],
      // Extreme difference in magnitude
      microScale()[0],
    ];

    for (const line of inputs) {
      const result = buffer({ type: 'LineString', coordinates: line }, 50);
      expect(result).not.toBeNull();
      const value = result as MultiPolygonCoordinates;
      expectValidMultiPolygon(value);
      expect(sphericalArea(value)).toBeGreaterThan(0);
    }
  });

  it('makes a positive buffer of a polygon with a hole increase the area and keep the inner ring', () => {
    const district = lakeDistrict();
    const before = resolvedArea(district);
    const result = buffer({ type: 'Polygon', coordinates: district }, 300, { segments: 12 });

    expect(result).not.toBeNull();
    const value = result as MultiPolygonCoordinates;
    expectValidMultiPolygon(value);
    expect(planarArea(value)).toBeGreaterThan(before);
    expect(sphericalArea(value)).toBeGreaterThan(0);
    // The lake is not filled in by an expansion of 300 m
    expect(value[0].length).toBeGreaterThanOrEqual(2);
  });

  it('makes a negative buffer of a polygon with a hole decrease the area', () => {
    const district = lakeDistrict();
    const before = resolvedArea(district);

    let result: MultiPolygonCoordinates | null = null;
    expect(() => {
      result = buffer({ type: 'Polygon', coordinates: district }, -300, { segments: 12 });
    }).not.toThrow();

    expect(result).not.toBeNull();
    const value = result as unknown as MultiPolygonCoordinates;
    expectValidMultiPolygon(value);
    expect(planarArea(value)).toBeLessThan(before);
    expect(sphericalArea(value)).toBeGreaterThan(0);
  });

  it('makes the buffer of a polygon with exclaves keep the parts', () => {
    const district = exclaveDistrict();
    const result = buffer({ type: 'MultiPolygon', coordinates: district }, 500, { segments: 12 });

    expect(result).not.toBeNull();
    const value = result as MultiPolygonCoordinates;
    expectValidMultiPolygon(value);
    expect(value).toHaveLength(3);
    expect(planarArea(value)).toBeGreaterThan(resolvedArea(district));
    expect(sphericalArea(value)).toBeGreaterThan(0);
  });
});
