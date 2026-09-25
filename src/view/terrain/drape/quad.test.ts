// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { meshRowRange, quadMercatorCorners, solveQuadUV } from './quad.js';

/** The bilinear map (the same formula as the shader) */
function bilinear(quad: ArrayLike<number>, u: number, v: number): [number, number] {
  const wa = (1 - u) * (1 - v);
  const wb = u * (1 - v);
  const wc = u * v;
  const wd = (1 - u) * v;
  return [
    wa * quad[0] + wb * quad[2] + wc * quad[4] + wd * quad[6],
    wa * quad[1] + wb * quad[3] + wc * quad[5] + wd * quad[7],
  ];
}

describe('quadMercatorCorners', () => {
  it('maps the four corners to Mercator as top-left, top-right, bottom-right, bottom-left', () => {
    const merc = quadMercatorCorners({
      topLeft: [-180, 0],
      topRight: [0, 0],
      bottomRight: [0, -85.051129],
      bottomLeft: [-180, -85.051129],
    });
    // Longitude -180 -> x = 0, longitude 0 -> x = 0.5
    expect(merc[0]).toBeCloseTo(0, 12);
    expect(merc[2]).toBeCloseTo(0.5, 12);
    // Latitude 0 -> y = 0.5, latitude -85.051129 -> y = 1
    expect(merc[1]).toBeCloseTo(0.5, 12);
    expect(merc[5]).toBeCloseTo(1, 6);
    expect(merc[6]).toBeCloseTo(0, 12);
  });
});

describe('solveQuadUV', () => {
  // An unrotated rectangle (an exact parallelogram on the Mercator plane)
  const rect = [0.2, 0.2, 0.6, 0.2, 0.6, 0.5, 0.2, 0.5];

  it('returns the four corners to (0,0) (1,0) (1,1) (0,1)', () => {
    const corners: Array<[number, number]> = [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ];
    for (let i = 0; i < 4; i++) {
      const point = bilinear(rect, corners[i][0], corners[i][1]);
      const uv = solveQuadUV(point[0], point[1], rect);
      expect(uv).not.toBeNull();
      expect(uv?.[0]).toBeCloseTo(corners[i][0], 10);
      expect(uv?.[1]).toBeCloseTo(corners[i][1], 10);
    }
  });

  it('round-trips for interior points', () => {
    for (const [u, v] of [
      [0.25, 0.75],
      [0.5, 0.5],
      [0.9, 0.1],
    ]) {
      const point = bilinear(rect, u, v);
      const uv = solveQuadUV(point[0], point[1], rect);
      expect(uv?.[0]).toBeCloseTo(u, 10);
      expect(uv?.[1]).toBeCloseTo(v, 10);
    }
  });

  it('round-trips for a rotated rectangle as well', () => {
    const angle = 0.7;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const half = [
      [-0.1, -0.05],
      [0.1, -0.05],
      [0.1, 0.05],
      [-0.1, 0.05],
    ];
    const rotated = new Float64Array(8);
    for (let i = 0; i < 4; i++) {
      rotated[i * 2] = 0.4 + half[i][0] * cos - half[i][1] * sin;
      rotated[i * 2 + 1] = 0.4 + half[i][0] * sin + half[i][1] * cos;
    }
    for (const [u, v] of [
      [0.2, 0.3],
      [0.8, 0.9],
    ]) {
      const point = bilinear(rotated, u, v);
      const uv = solveQuadUV(point[0], point[1], rotated);
      expect(uv?.[0]).toBeCloseTo(u, 8);
      expect(uv?.[1]).toBeCloseTo(v, 8);
    }
  });

  it('round-trips for a general quad that is not a parallelogram as well', () => {
    // A trapezoid (k2 is not 0, so the quadratic branch is taken)
    const trapezoid = [0.1, 0.1, 0.9, 0.2, 0.7, 0.8, 0.3, 0.6];
    for (const [u, v] of [
      [0.15, 0.35],
      [0.5, 0.5],
      [0.85, 0.95],
    ]) {
      const point = bilinear(trapezoid, u, v);
      const uv = solveQuadUV(point[0], point[1], trapezoid);
      expect(uv?.[0]).toBeCloseTo(u, 8);
      expect(uv?.[1]).toBeCloseTo(v, 8);
    }
  });

  it('gives a (u, v) outside 0..1 for an outside point', () => {
    const uv = solveQuadUV(0.05, 0.05, rect);
    expect(uv).not.toBeNull();
    expect(
      Math.max(Math.abs((uv?.[0] ?? 0) - 0.5), Math.abs((uv?.[1] ?? 0) - 0.5)),
    ).toBeGreaterThan(0.5);
  });

  it('cannot solve a quad with zero area', () => {
    expect(solveQuadUV(0.5, 0.5, [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5])).toBeNull();
  });
});

describe('meshRowRange', () => {
  it('returns only the rows that are covered', () => {
    expect(meshRowRange(0.25, 0.5, 128)).toEqual({ start: 32, count: 32 });
  });

  it('returns all rows for the whole tile', () => {
    expect(meshRowRange(0, 1, 8)).toEqual({ start: 0, count: 8 });
  });

  it('is capped at the edges even when it sticks out of the tile', () => {
    expect(meshRowRange(-3, 4, 8)).toEqual({ start: 0, count: 8 });
  });

  it('returns null when it does not cover the tile', () => {
    expect(meshRowRange(1.2, 1.8, 8)).toBeNull();
    expect(meshRowRange(-2, -1.5, 8)).toBeNull();
  });

  it('returns one row even for a thin range that fits in a single row', () => {
    expect(meshRowRange(0.5, 0.5001, 8)).toEqual({ start: 4, count: 1 });
  });
});
