// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import type { Coordinate } from '../../store/types.js';
import type { CoordinateTransform } from './transform.js';
import {
  applyMarginToBoundingBox,
  clampCoordinate,
  clampLatitude,
  lngLatToMercator,
} from './transform.js';

describe('clampLatitude', () => {
  it('a value within the range is returned as is', () => {
    expect(clampLatitude(0)).toBe(0);
    expect(clampLatitude(45)).toBe(45);
    expect(clampLatitude(-45)).toBe(-45);
  });

  it('a value above 89.9 is clamped to 89.9', () => {
    expect(clampLatitude(90)).toBe(89.9);
    expect(clampLatitude(100)).toBe(89.9);
    expect(clampLatitude(89.95)).toBe(89.9);
  });

  it('a value below -89.9 is clamped to -89.9', () => {
    expect(clampLatitude(-90)).toBe(-89.9);
    expect(clampLatitude(-100)).toBe(-89.9);
    expect(clampLatitude(-89.95)).toBe(-89.9);
  });

  it('exactly +/-90 is clamped', () => {
    expect(clampLatitude(90)).toBe(89.9);
    expect(clampLatitude(-90)).toBe(-89.9);
  });

  it('exactly +/-89.9 is returned as is', () => {
    expect(clampLatitude(89.9)).toBe(89.9);
    expect(clampLatitude(-89.9)).toBe(-89.9);
  });
});

describe('clampCoordinate', () => {
  it('the longitude is kept as is', () => {
    const result = clampCoordinate([180, 0]);
    expect(result[0]).toBe(180);
  });

  it('the latitude is clamped', () => {
    const result = clampCoordinate([100, 95]);
    expect(result[0]).toBe(100);
    expect(result[1]).toBe(89.9);
  });

  it('a coordinate within the range is returned as is', () => {
    const coord: Coordinate = [139.7, 35.7];
    const result = clampCoordinate(coord);
    expect(result).toEqual([139.7, 35.7]);
  });
});

describe('lngLatToMercator', () => {
  it('lng=-180 becomes x=0', () => {
    const result = lngLatToMercator([-180, 0]);
    expect(result[0]).toBeCloseTo(0);
  });

  it('lng=0 becomes x=0.5', () => {
    const result = lngLatToMercator([0, 0]);
    expect(result[0]).toBeCloseTo(0.5);
  });

  it('lng=180 becomes x=1', () => {
    const result = lngLatToMercator([180, 0]);
    expect(result[0]).toBeCloseTo(1);
  });

  it('lat=0 becomes y=0.5', () => {
    const result = lngLatToMercator([0, 0]);
    expect(result[1]).toBeCloseTo(0.5);
  });

  it('a northern latitude becomes y<0.5', () => {
    const result = lngLatToMercator([0, 45]);
    expect(result[1]).toBeLessThan(0.5);
  });

  it('a southern latitude becomes y>0.5', () => {
    const result = lngLatToMercator([0, -45]);
    expect(result[1]).toBeGreaterThan(0.5);
  });
});

describe('applyMarginToBoundingBox (map plane)', () => {
  const bbox = {
    topLeft: [139.0, 35.5] as [number, number],
    topRight: [139.4, 35.5] as [number, number],
    bottomRight: [139.4, 35.2] as [number, number],
    bottomLeft: [139.0, 35.2] as [number, number],
  };

  /** A transform that imitates project/unproject with terrain (the round trip is not the
   * identity) */
  const terrainTransform = {
    project: (c: [number, number]) => ({ x: c[0] * 1000, y: -c[1] * 1000 }),
    // It re-hits the ground surface only on the way back, so a round trip drifts by 0.05
    // degrees
    unproject: (p: { x: number; y: number }) => ({ lng: p.x / 1000, lat: -p.y / 1000 + 0.05 }),
  };

  it('passing zoom avoids the screen-coordinate round trip (no drift with terrain)', () => {
    const result = applyMarginToBoundingBox(bbox, 4, terrainTransform, 11);

    // If it round-tripped, every latitude would drift by 0.05 degrees. Check that there is no
    // drift
    expect(result.topLeft[1]).toBeGreaterThan(35.5);
    expect(result.topLeft[1]).toBeLessThan(35.51);
    expect(result.bottomLeft[1]).toBeLessThan(35.2);
    expect(result.bottomLeft[1]).toBeGreaterThan(35.19);
  });

  it('the 4 corners widen outward (the center does not move)', () => {
    const result = applyMarginToBoundingBox(bbox, 8, terrainTransform, 11);

    expect(result.topLeft[0]).toBeLessThan(bbox.topLeft[0]);
    expect(result.topRight[0]).toBeGreaterThan(bbox.topRight[0]);
    expect(result.topLeft[1]).toBeGreaterThan(bbox.topLeft[1]);
    expect(result.bottomRight[1]).toBeLessThan(bbox.bottomRight[1]);

    const centerLng = (result.topLeft[0] + result.bottomRight[0]) / 2;
    const centerLat = (result.topLeft[1] + result.bottomRight[1]) / 2;
    expect(centerLng).toBeCloseTo(139.2, 6);
    expect(centerLat).toBeCloseTo(35.35, 6);
  });
});

describe('applyMarginToBoundingBox', () => {
  // project: lng,lat -> x,y (the identity transform)
  // unproject: x,y -> lng,lat (the identity transform)
  const identityTransform: CoordinateTransform = {
    project: (coord: Coordinate) => ({ x: coord[0], y: coord[1] }),
    unproject: (point: { x: number; y: number }) => ({ lng: point.x, lat: point.y }),
  };

  const coords = {
    topLeft: [-10, -10] as Coordinate,
    topRight: [10, -10] as Coordinate,
    bottomRight: [10, 10] as Coordinate,
    bottomLeft: [-10, 10] as Coordinate,
  };

  it('a margin of 0 gives the same coordinates as the original', () => {
    const result = applyMarginToBoundingBox(coords, 0, identityTransform);
    expect(result.topLeft[0]).toBeCloseTo(-10);
    expect(result.topLeft[1]).toBeCloseTo(-10);
    expect(result.bottomRight[0]).toBeCloseTo(10);
    expect(result.bottomRight[1]).toBeCloseTo(10);
  });

  it('a positive margin expands the coordinates outward', () => {
    const margin = 5;
    const result = applyMarginToBoundingBox(coords, margin, identityTransform);

    // The center is (0,0), and each vertex is at a distance of sqrt(200) = 14.14 from it
    // Adding a margin of 5 expands it by a factor of (14.14+5)/14.14 = 1.354
    // topLeft: (-10,-10) -> (-10*1.354, -10*1.354) = (-13.54, -13.54)
    expect(result.topLeft[0]).toBeLessThan(-10);
    expect(result.topLeft[1]).toBeLessThan(-10);
    expect(result.bottomRight[0]).toBeGreaterThan(10);
    expect(result.bottomRight[1]).toBeGreaterThan(10);
  });

  it('all 4 corners are returned', () => {
    const result = applyMarginToBoundingBox(coords, 1, identityTransform);
    expect(result).toHaveProperty('topLeft');
    expect(result).toHaveProperty('topRight');
    expect(result).toHaveProperty('bottomRight');
    expect(result).toHaveProperty('bottomLeft');
  });

  it('a symmetric input gives a symmetric result too', () => {
    const margin = 3;
    const result = applyMarginToBoundingBox(coords, margin, identityTransform);

    // topLeft and bottomRight are symmetric about the center
    expect(result.topLeft[0]).toBeCloseTo(-result.bottomRight[0]);
    expect(result.topLeft[1]).toBeCloseTo(-result.bottomRight[1]);

    // topRight and bottomLeft are also symmetric about the center
    expect(result.topRight[0]).toBeCloseTo(-result.bottomLeft[0]);
    expect(result.topRight[1]).toBeCloseTo(-result.bottomLeft[1]);
  });
});
