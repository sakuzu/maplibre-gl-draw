// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import type { Coordinate } from '../../store/types.js';
import { generateCirclePolygon } from './circle.js';
import { haversineDistanceMeters } from './distance.js';

describe('generateCirclePolygon', () => {
  const center: Coordinate = [139.6917, 35.6895];
  const radius = 1000; // 1km

  it('returns 65 points with the default 64 segments (a closed polygon)', () => {
    const coords = generateCirclePolygon(center, radius);
    expect(coords).toHaveLength(65);
  });

  it('the first point and the last point agree (a closed polygon)', () => {
    const coords = generateCirclePolygon(center, radius);
    expect(coords[0][0]).toBe(coords[coords.length - 1][0]);
    expect(coords[0][1]).toBe(coords[coords.length - 1][1]);
  });

  it('every point is roughly equidistant from the center', () => {
    const coords = generateCirclePolygon(center, radius);
    // The last point is a copy of the first point, so exclude it
    const points = coords.slice(0, -1);

    for (const point of points) {
      const dist = haversineDistanceMeters(center, point);
      // Allow an error within 1%
      expect(dist).toBeCloseTo(radius, -1);
      expect(Math.abs(dist - radius) / radius).toBeLessThan(0.01);
    }
  });

  it('4 segments make a diamond shape', () => {
    const coords = generateCirclePolygon(center, radius, 4);
    expect(coords).toHaveLength(5); // 4 points + 1 closing point

    // 0 degrees = north, 90 degrees = east, 180 degrees = south, 270 degrees = west
    const [north, east, south, west] = coords;

    // North: roughly the same longitude, larger latitude
    expect(north[0]).toBeCloseTo(center[0], 4);
    expect(north[1]).toBeGreaterThan(center[1]);

    // East: larger longitude, roughly the same latitude
    expect(east[0]).toBeGreaterThan(center[0]);
    expect(east[1]).toBeCloseTo(center[1], 4);

    // South: roughly the same longitude, smaller latitude
    expect(south[0]).toBeCloseTo(center[0], 4);
    expect(south[1]).toBeLessThan(center[1]);

    // West: smaller longitude, roughly the same latitude
    expect(west[0]).toBeLessThan(center[0]);
    expect(west[1]).toBeCloseTo(center[1], 4);
  });

  it('the number of segments can be specified', () => {
    const coords = generateCirclePolygon(center, radius, 8);
    expect(coords).toHaveLength(9); // 8 points + 1 closing point
  });
});
