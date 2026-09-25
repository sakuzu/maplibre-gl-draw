// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { getPointAtAngle } from './angle.js';
import { circleBoundingBox, generateCirclePolygon } from './circle.js';
import { destinationPoint, haversineDistanceMeters, initialBearingDegrees } from './distance.js';
import type { Coordinate } from './types.js';

describe('haversineDistanceMeters', () => {
  it('returns 0 for the same point', () => {
    expect(haversineDistanceMeters([139.7, 35.6], [139.7, 35.6])).toBe(0);
  });

  it('makes 1 degree on the equator about 111.19 km', () => {
    expect(haversineDistanceMeters([0, 0], [1, 0])).toBeCloseTo(111194.93, 0);
  });

  it('is symmetric', () => {
    const a: Coordinate = [139.7, 35.6];
    const b: Coordinate = [140.1, 36.2];
    expect(haversineDistanceMeters(a, b)).toBeCloseTo(haversineDistanceMeters(b, a), 9);
  });
});

describe('initialBearingDegrees', () => {
  it('gives 90 degrees for due east', () => {
    expect(initialBearingDegrees([0, 0], [0.001, 0])).toBeCloseTo(90, 6);
  });

  it('gives 0 degrees for due north', () => {
    expect(initialBearingDegrees([0, 0], [0, 0.001])).toBeCloseTo(0, 6);
  });

  it('gives 270 degrees for due west', () => {
    expect(initialBearingDegrees([0, 0], [-0.001, 0])).toBeCloseTo(270, 6);
  });

  it('gives 180 degrees for due south', () => {
    expect(initialBearingDegrees([0, 0], [0, -0.001])).toBeCloseTo(180, 6);
  });

  it('returns 0 for the same point', () => {
    expect(initialBearingDegrees([139.7, 35.6], [139.7, 35.6])).toBe(0);
  });

  it('still gives 90 and 270 degrees for the east-west direction at high latitudes', () => {
    expect(initialBearingDegrees([0, 60], [0.001, 60])).toBeCloseTo(90, 3);
    expect(initialBearingDegrees([0, 60], [-0.001, 60])).toBeCloseTo(270, 3);
  });
});

describe('consistency between getPointAtAngle and the bearing', () => {
  it('makes the geodesic distance to the generated point equal to the given distance', () => {
    const center: Coordinate = [139.7, 35.6];
    for (const angle of [0, 45, 90, 135, 180, 225, 270, 315]) {
      const point = getPointAtAngle(center, 1000, angle);
      expect(haversineDistanceMeters(center, point)).toBeCloseTo(1000, 0);
    }
  });

  it('brings the bearing of the generated point back to the given angle', () => {
    const center: Coordinate = [0, 60];
    for (const angle of [0, 45, 90, 180, 270]) {
      const point = getPointAtAngle(center, 500, angle);
      const bearing = initialBearingDegrees(center, point);
      // Check that the difference normalized to -180..180 is close to 0
      expect(((bearing - angle + 540) % 360) - 180).toBeCloseTo(0, 1);
    }
  });
});

describe('generateCirclePolygon', () => {
  it('returns a closed ring with segments + 1 points', () => {
    const ring = generateCirclePolygon([139.7, 35.6], 1000, 16);
    expect(ring).toHaveLength(17);
    expect(ring[0]).toEqual(ring[16]);
  });

  it('puts every vertex at the same distance from the center', () => {
    const center: Coordinate = [0, 60];
    for (const point of generateCirclePolygon(center, 1000, 32)) {
      expect(haversineDistanceMeters(center, point)).toBeCloseTo(1000, 0);
    }
  });
});

describe('destinationPoint: the direct problem on the sphere', () => {
  const cases: Array<[number, number]> = [
    [0, 1_000],
    [35, 100_000],
    [60, 100_000],
    [60, 1_000_000],
    [89.99, 1_000],
    [-60, 100_000],
  ];

  it.each(cases)('keeps the radius within 1 m at latitude %d for %d m', (lat, meters) => {
    const center: Coordinate = [139, lat];
    for (let bearing = 0; bearing < 360; bearing += 7.5) {
      const point = destinationPoint(center, meters, bearing);
      expect(Math.abs(haversineDistanceMeters(center, point) - meters)).toBeLessThan(1);
    }
  });

  it('keeps the circle of 100 km at latitude 60 degrees within 1 m of its radius', () => {
    const center: Coordinate = [10, 60];
    for (const point of generateCirclePolygon(center, 100_000, 256)) {
      expect(Math.abs(haversineDistanceMeters(center, point) - 100_000)).toBeLessThan(1);
    }
  });

  it('returns the given bearing as the initial bearing', () => {
    const center: Coordinate = [139, 60];
    for (const bearing of [10, 45, 90, 135, 200, 270, 330]) {
      const point = destinationPoint(center, 100_000, bearing);
      expect(initialBearingDegrees(center, point)).toBeCloseTo(bearing, 6);
    }
  });

  it('matches known values on the equator and the meridian', () => {
    const degree = haversineDistanceMeters([0, 0], [1, 0]);
    const east = destinationPoint([0, 0], degree, 90);
    expect(east[0]).toBeCloseTo(1, 9);
    expect(east[1]).toBeCloseTo(0, 9);
    const north = destinationPoint([139, 35], degree, 0);
    expect(north[0]).toBeCloseTo(139, 9);
    expect(north[1]).toBeCloseTo(36, 9);
  });

  it('continues the longitude past the antimeridian instead of wrapping it', () => {
    const point = destinationPoint([179.99, 0], 10_000, 90);
    expect(point[0]).toBeGreaterThan(180);
    expect(point[0]).toBeLessThan(180.1);
  });

  it('bends a due-east course toward the equator at a high latitude', () => {
    const point = destinationPoint([0, 60], 100_000, 90);
    expect(point[1]).toBeLessThan(60);
  });
});

describe('circleBoundingBox', () => {
  it('contains every vertex of the circle and touches its extremes', () => {
    for (const lat of [0, 35, 60, -70]) {
      const center: Coordinate = [139, lat];
      const box = circleBoundingBox(center, 200_000);
      expect(box).not.toBeNull();
      const [minLng, minLat, maxLng, maxLat] = box as [number, number, number, number];
      const ring = generateCirclePolygon(center, 200_000, 1024);
      let ringMaxLng = -Infinity;
      for (const [lng, pointLat] of ring) {
        expect(lng).toBeGreaterThanOrEqual(minLng - 1e-9);
        expect(lng).toBeLessThanOrEqual(maxLng + 1e-9);
        expect(pointLat).toBeGreaterThanOrEqual(minLat - 1e-9);
        expect(pointLat).toBeLessThanOrEqual(maxLat + 1e-9);
        ringMaxLng = Math.max(ringMaxLng, lng);
      }
      // A 1024-gon reaches the extreme within a small fraction of the radius
      expect(maxLng - ringMaxLng).toBeLessThan(1e-4);
    }
  });

  it('is wider than the due-east point at a high latitude', () => {
    const center: Coordinate = [0, 60];
    const box = circleBoundingBox(center, 100_000) as [number, number, number, number];
    expect(box[2]).toBeGreaterThan(destinationPoint(center, 100_000, 90)[0]);
  });

  it('spans every longitude for a circle that contains a pole', () => {
    expect(circleBoundingBox([20, 89.5], 100_000)).toEqual([-160, expect.any(Number), 200, 90]);
  });

  it('returns null for an unusable center or radius', () => {
    expect(circleBoundingBox([Number.NaN, 0], 10)).toBeNull();
    expect(circleBoundingBox([0, 0], -1)).toBeNull();
    expect(circleBoundingBox([0, 0], Number.POSITIVE_INFINITY)).toBeNull();
  });
});
