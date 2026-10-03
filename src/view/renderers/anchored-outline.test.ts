// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests of the strip of an outline laid around an anchor: the corners, the miters and the
 * distances the dashes are measured with
 */

import { describe, expect, it } from 'vitest';
import { buildOutlineStrip } from './anchored-outline.js';

/** The vertices of a strip as [x, y, signed distance, distance] */
function verticesOf(data: Float32Array): number[][] {
  const vertices: number[][] = [];
  for (let i = 0; i < data.length; i += 4) vertices.push(Array.from(data.slice(i, i + 4)));
  return vertices;
}

const SQUARE = [
  { x: -10, y: -10 },
  { x: 10, y: -10 },
  { x: 10, y: 10 },
  { x: -10, y: 10 },
];

describe('buildOutlineStrip', () => {
  it('gives two vertices per corner and the first corner again at the end', () => {
    const vertices = verticesOf(buildOutlineStrip(SQUARE, 2, 1));
    expect(vertices).toHaveLength(10);
    expect(vertices[8].slice(0, 3)).toEqual(vertices[0].slice(0, 3));
    expect(vertices[9].slice(0, 3)).toEqual(vertices[1].slice(0, 3));
  });

  it('moves a square corner along its diagonal by the half width and the coverage band', () => {
    // Half of 2 px plus the pixel of the coverage band, along the miter of a right angle
    const reach = 2 * Math.SQRT2;
    const [outer, inner] = verticesOf(buildOutlineStrip(SQUARE, 2, 1));
    const offsets = [outer, inner].map(([x, y]) => [x + 10, y + 10]);
    expect(Math.hypot(offsets[0][0], offsets[0][1])).toBeCloseTo(reach, 5);
    expect(Math.hypot(offsets[1][0], offsets[1][1])).toBeCloseTo(reach, 5);
    // The two sides lie on opposite sides of the corner
    expect(offsets[0][0] * offsets[1][0]).toBeLessThan(0);
    // The signed distance across the line is ± the half width and the band
    expect([outer[2], inner[2]]).toEqual([2, -2]);
  });

  it('places the corners in device pixels', () => {
    const [vertex] = verticesOf(buildOutlineStrip(SQUARE, 4, 2));
    // The corner at (-20, -20) device px, moved by (2 + 1) * sqrt(2) along the diagonal
    expect(Math.abs(vertex[0] + 20)).toBeCloseTo(3, 5);
    expect(Math.abs(vertex[1] + 20)).toBeCloseTo(3, 5);
  });

  it('measures the distance along the outline in CSS px', () => {
    const vertices = verticesOf(buildOutlineStrip(SQUARE, 2, 2));
    expect(vertices.filter((_, i) => i % 2 === 0).map((v) => v[3])).toEqual([0, 20, 40, 60, 80]);
  });

  it('bevels a corner sharper than the miter limit', () => {
    // A spike: the miter of its tip would be far longer than four half widths
    const spike = [
      { x: 0, y: 0 },
      { x: 100, y: 1 },
      { x: 0, y: 2 },
    ];
    const [, tip] = [0, 2].map((i) => verticesOf(buildOutlineStrip(spike, 2, 1))[i]);
    expect(Math.hypot(tip[0] - 100, tip[1] - 1)).toBeLessThanOrEqual(2 + 1e-6);
  });

  it('skips repeated corners and gives nothing for fewer than two', () => {
    const repeated = [SQUARE[0], SQUARE[0], SQUARE[1], SQUARE[2], SQUARE[3]];
    expect(buildOutlineStrip(repeated, 2, 1)).toEqual(buildOutlineStrip(SQUARE, 2, 1));
    expect(buildOutlineStrip([SQUARE[0], SQUARE[0]], 2, 1)).toHaveLength(0);
  });
});
