// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Verification of the lengths along the paths of the analytic drape
 *
 * A dashed line on the drape lays its pattern out edge by edge, from where each edge starts
 * along its path. The pattern runs on across the vertices only when those starts add up the
 * edges before them, and a coarse tile stays in step with the fine tiles next to it only when
 * its rounded vertices keep the starts of the vertices they came from.
 */

import { describe, expect, it } from 'vitest';
import type { Coordinate } from '../../../store/types.js';
import { buildDrapeGeometry, drapePathStarts, drapeQuantizedGeometry } from './geometry.js';

/** The length of the edge from vertex `i` to vertex `j` of a path (Mercator units) */
function edgeLength(xy: Float64Array, i: number, j: number): number {
  return Math.hypot(xy[j * 2] - xy[i * 2], xy[j * 2 + 1] - xy[i * 2 + 1]);
}

describe('drapePathStarts', () => {
  it('adds up the edges of an open path from its first vertex', () => {
    const path: Coordinate[] = [
      [0, 0],
      [1, 0],
      [1, 1],
      [3, 1],
    ];
    const geometry = buildDrapeGeometry([path], false).paths[0];
    const starts = drapePathStarts(geometry);

    expect(starts).toHaveLength(4);
    expect(starts[0]).toBe(0);
    expect(starts[1]).toBeCloseTo(edgeLength(geometry.xy, 0, 1), 15);
    expect(starts[2]).toBeCloseTo(starts[1] + edgeLength(geometry.xy, 1, 2), 15);
    expect(starts[3]).toBeCloseTo(starts[2] + edgeLength(geometry.xy, 2, 3), 15);
  });

  it('starts the closing edge of a ring at its last vertex', () => {
    const ring: Coordinate[] = [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ];
    const geometry = buildDrapeGeometry([ring], true).paths[0];
    const starts = drapePathStarts(geometry);

    // Four edges, the last one back to the first vertex, start at the four vertices
    expect(geometry.edgeCount).toBe(4);
    expect(starts).toHaveLength(4);
    expect(starts[3]).toBeCloseTo(
      edgeLength(geometry.xy, 0, 1) + edgeLength(geometry.xy, 1, 2) + edgeLength(geometry.xy, 2, 3),
      15,
    );
  });

  it('is worked out once per path', () => {
    const geometry = buildDrapeGeometry(
      [
        [
          [0, 0],
          [1, 1],
        ],
      ],
      false,
    ).paths[0];
    expect(drapePathStarts(geometry)).toBe(drapePathStarts(geometry));
  });

  it('gives the rounded vertices of a coarse tile the starts of the vertices they came from', () => {
    // A wavy line whose small wiggles the rounding merges away
    const path: Coordinate[] = [];
    for (let i = 0; i <= 200; i++) path.push([i * 0.01, (i % 2) * 0.001]);
    const original = buildDrapeGeometry([path], false);
    const quantized = drapeQuantizedGeometry(original, 12);
    const coarse = quantized.paths[0];

    expect(coarse.xy.length).toBeLessThan(original.paths[0].xy.length);
    const origin = coarse.origin;
    expect(origin?.path).toBe(original.paths[0]);
    const starts = drapePathStarts(coarse);
    const originalStarts = drapePathStarts(original.paths[0]);
    for (let i = 0; i < starts.length; i++) {
      expect(starts[i]).toBe(originalStarts[origin?.vertices[i] ?? -1]);
    }
    // The pattern goes on from the same place it would on a fine tile
    expect(starts[0]).toBe(0);
    expect(starts[starts.length - 1]).toBeGreaterThan(0);
  });
});
