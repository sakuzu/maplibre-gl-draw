// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests the distance functions of the built-in point shapes and the outlines sampled from them.
 */

import { describe, expect, it } from 'vitest';
import {
  POINT_SDF_GLSL,
  POINT_SHAPE_CODE,
  pointShapeSdf,
  STAR_INNER_RATIO,
  samplePointShapeRings,
} from './point-sdf.js';

const R = 10;

function polar(radius: number, degreesFromUp: number): [number, number] {
  const a = Math.PI / 2 + (degreesFromUp * Math.PI) / 180;
  return [Math.cos(a) * radius, Math.sin(a) * radius];
}

describe('pointShapeSdf', () => {
  it('keeps the circle and the square as before (Euclidean and Chebyshev distance)', () => {
    expect(pointShapeSdf('circle', 3, 4, R)).toBeCloseTo(-5);
    expect(pointShapeSdf('square', 3, -7, R)).toBeCloseTo(-3);
    expect(pointShapeSdf('square', 12, 0, R)).toBeCloseTo(2);
  });

  it('puts the vertices of the triangle on the circumcircle with one pointing up', () => {
    for (const deg of [0, 120, 240]) {
      const [x, y] = polar(R, deg);
      expect(pointShapeSdf('triangle', x, y, R)).toBeCloseTo(0, 6);
    }
    // The inradius of an equilateral triangle is half its circumradius
    expect(pointShapeSdf('triangle', 0, 0, R)).toBeCloseTo(-R / 2, 6);
    // Straight down reaches the base at half the radius; up reaches the apex at the full radius
    expect(pointShapeSdf('triangle', 0, -R / 2, R)).toBeCloseTo(0, 6);
    expect(pointShapeSdf('triangle', 0, R * 0.9, R)).toBeLessThan(0);
    expect(pointShapeSdf('triangle', 0, -R * 0.9, R)).toBeCloseTo(0.4 * R, 6);
  });

  it('puts the tips of the star on the circumcircle and the inner vertices inside', () => {
    for (let i = 0; i < 5; i++) {
      const [tx, ty] = polar(R, i * 72);
      expect(pointShapeSdf('star', tx, ty, R)).toBeCloseTo(0, 6);
      const [ix, iy] = polar(R * STAR_INNER_RATIO, i * 72 + 36);
      expect(pointShapeSdf('star', ix, iy, R)).toBeCloseTo(0, 6);
    }
    // The nearest edge from the center is an inner vertex
    expect(pointShapeSdf('star', 0, 0, R)).toBeCloseTo(-R * STAR_INNER_RATIO, 6);
    // Between two tips, outside the inner vertex, is outside the star
    const [ox, oy] = polar(R * 0.8, 36);
    expect(pointShapeSdf('star', ox, oy, R)).toBeGreaterThan(0);
  });

  it('is positive outside every shape and never exceeds the circumcircle', () => {
    for (const shape of ['circle', 'square', 'triangle', 'star'] as const) {
      for (let deg = 0; deg < 360; deg += 7) {
        const [x, y] = polar(R * 1.5, deg);
        expect(pointShapeSdf(shape, x, y, R)).toBeGreaterThan(0);
        if (shape !== 'square') {
          const [cx, cy] = polar(R * 1.0001, deg);
          expect(pointShapeSdf(shape, cx, cy, R)).toBeGreaterThanOrEqual(0);
        }
      }
    }
  });
});

describe('POINT_SDF_GLSL', () => {
  it('dispatches on the shape codes 0 to 3', () => {
    expect(POINT_SHAPE_CODE).toEqual({ circle: 0, square: 1, triangle: 2, star: 3 });
    expect(POINT_SDF_GLSL).toContain('float pointShapeSdf(vec2 p, float r, float shape)');
    expect(POINT_SDF_GLSL).toContain(String(STAR_INNER_RATIO));
  });
});

describe('samplePointShapeRings', () => {
  it('samples the triangle at its three vertices', () => {
    const rings = samplePointShapeRings('triangle', R, 0);
    expect(rings.outer).toHaveLength(3);
    expect(rings.outer[0][0]).toBeCloseTo(0, 6);
    expect(rings.outer[0][1]).toBeCloseTo(R, 6);
    expect(rings.inner).toEqual(rings.outer);
  });

  it('puts the outer ring on the edge and the inner ring at the stroke depth', () => {
    for (const shape of ['triangle', 'star'] as const) {
      const rings = samplePointShapeRings(shape, R, 1.5);
      expect(rings.inner).toHaveLength(rings.outer.length);
      for (const [x, y] of rings.outer) expect(pointShapeSdf(shape, x, y, R)).toBeCloseTo(0, 6);
      for (const [x, y] of rings.inner) expect(pointShapeSdf(shape, x, y, R)).toBeCloseTo(-1.5, 6);
    }
  });

  it('shrinks the inner triangle by twice the stroke along the vertex rays', () => {
    const rings = samplePointShapeRings('triangle', R, 2);
    expect(Math.hypot(...rings.inner[0])).toBeCloseTo(R - 4, 6);
  });

  it('collapses the inner ring to the center when the stroke fills the shape', () => {
    const rings = samplePointShapeRings('triangle', R, R);
    for (const [x, y] of rings.inner) expect(Math.hypot(x, y)).toBe(0);
  });
});
