// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for the path of an edge on the globe: the cell maplibre cuts at a zoom, and the cut
 * along the Mercator plane
 */

import { describe, expect, it } from 'vitest';
import {
  densifyOnMercatorPlane,
  globeSubdivisionGrid,
  mercatorEdgeLength,
  mercatorLerp,
  mercatorMidpoint,
} from './globe-subdivision.js';
import { toPlane } from './mercator-plane.js';

describe('globeSubdivisionGrid', () => {
  it("follows maplibre's granularity for fills (128 at zoom 0, at least 2 per tile)", () => {
    expect(globeSubdivisionGrid(0, 'fill')).toBe(1 / 128);
    expect(globeSubdivisionGrid(3.7, 'fill')).toBe(1 / 128);
    expect(globeSubdivisionGrid(6, 'fill')).toBe(1 / 128);
    expect(globeSubdivisionGrid(7, 'fill')).toBe(1 / 256);
    expect(globeSubdivisionGrid(10.2, 'fill')).toBe(1 / 2048);
  });

  it("follows maplibre's granularity for lines (512 at zoom 0, at least 1 per tile)", () => {
    expect(globeSubdivisionGrid(0, 'line')).toBe(1 / 512);
    expect(globeSubdivisionGrid(9, 'line')).toBe(1 / 512);
    expect(globeSubdivisionGrid(10, 'line')).toBe(1 / 1024);
  });

  it('changes only when the zoom crosses an integer, and reads a broken zoom as 0', () => {
    expect(globeSubdivisionGrid(7.01, 'fill')).toBe(globeSubdivisionGrid(7.99, 'fill'));
    expect(globeSubdivisionGrid(-2, 'line')).toBe(1 / 512);
    expect(globeSubdivisionGrid(Number.NaN, 'line')).toBe(1 / 512);
  });
});

describe('the cut along the Mercator plane', () => {
  it('keeps an edge along a parallel on its parallel', () => {
    const path = densifyOnMercatorPlane(
      [
        [-60, 45],
        [60, 45],
      ],
      1 / 512,
    );
    expect(path.length).toBeGreaterThan(100);
    for (const [, lat] of path) expect(lat).toBeCloseTo(45, 9);
    expect(path[0]).toEqual([-60, 45]);
    expect(path[path.length - 1]).toEqual([60, 45]);
  });

  it('puts every point it adds on the straight line of the Mercator plane', () => {
    const a: [number, number] = [-60, 0];
    const b: [number, number] = [60, 50];
    const path = densifyOnMercatorPlane([a, b], 1 / 64);
    const [ax, ay] = toPlane(a);
    const [bx, by] = toPlane(b);
    for (const point of path) {
      const [x, y] = toPlane(point);
      // The cross product with the edge vanishes on the line
      expect((x - ax) * (by - ay) - (y - ay) * (bx - ax)).toBeCloseTo(0, 12);
    }
    // No piece is longer than the grid
    for (let i = 1; i < path.length; i++) {
      expect(mercatorEdgeLength(path[i - 1], path[i])).toBeLessThanOrEqual(1 / 64 + 1e-12);
    }
  });

  it('returns the path itself when no edge is longer than a cell', () => {
    const path: [number, number][] = [
      [139.7, 35.6],
      [139.71, 35.61],
    ];
    expect(densifyOnMercatorPlane(path, 1 / 512)).toBe(path);
    expect(densifyOnMercatorPlane(path, 0)).toBe(path);
  });

  it('stops adding points at the limit', () => {
    const path = densifyOnMercatorPlane(
      [
        [-170, 0],
        [170, 0],
      ],
      1 / 4096,
      10,
    );
    expect(path).toHaveLength(12);
  });

  it('interpolates the latitude in Mercator y', () => {
    const [lng, lat] = mercatorLerp([-60, 0], [60, 50], 0.5);
    expect(lng).toBeCloseTo(0, 12);
    expect(lat).toBeCloseTo(27.795, 3);
  });
});

describe('mercatorMidpoint', () => {
  it('lies on a slanted edge as drawn, halfway across in longitude', () => {
    expect(mercatorMidpoint([-60, 0], [60, 50])).toEqual(mercatorLerp([-60, 0], [60, 50], 0.5));
  });

  it('keeps the plain average on a parallel and on a meridian', () => {
    expect(mercatorMidpoint([5, 5], [15, 5])).toEqual([10, 5]);
    expect(mercatorMidpoint([0, 0], [0, 80])).toEqual([0, 40]);
  });
});
