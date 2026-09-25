// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for buildEarcutInput
 *
 * Verifies that the earcut input (the flattened coordinate sequence + holeIndices) is
 * built correctly from an array of rings ([0] is the outer ring, [1..] are the inner
 * rings).
 */

import earcut from 'earcut';
import { describe, expect, it } from 'vitest';
import type { Coordinate } from '../../../store/types.js';
import { buildEarcutInput } from './earcut-input.js';

/** Builds a closed rectangular ring */
function square(x: number, y: number, size: number): Coordinate[] {
  return [
    [x, y],
    [x + size, y],
    [x + size, y + size],
    [x, y + size],
    [x, y], // closing point
  ];
}

/** The number of triangles (the number of indices earcut returns / 3) */
function triangleCount(rings: Coordinate[][]): number {
  const { flatCoords, holeIndices } = buildEarcutInput(rings);
  return earcut(flatCoords, holeIndices).length / 3;
}

describe('buildEarcutInput', () => {
  it('leaves holeIndices empty for an outer ring only, vertices exclude the closing point', () => {
    const outer = square(0, 0, 10);
    const { flatCoords, holeIndices, rings } = buildEarcutInput([outer]);

    // 4 vertices with the closing point removed = 8 elements
    expect(flatCoords.length).toBe(8);
    expect(holeIndices).toEqual([]);
    expect(rings.length).toBe(1);
    expect(rings[0].length).toBe(4);
  });

  it('handles a ring without a closing point as is', () => {
    const outer: Coordinate[] = [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
    ];
    const { flatCoords, holeIndices, rings } = buildEarcutInput([outer]);

    expect(flatCoords.length).toBe(8);
    expect(holeIndices).toEqual([]);
    expect(rings[0].length).toBe(4);
  });

  it('makes holeIndices the start vertex index of the inner ring for a single hole', () => {
    const outer = square(0, 0, 10);
    const hole = square(3, 3, 4);
    const { flatCoords, holeIndices, rings } = buildEarcutInput([outer, hole]);

    // outer ring 4 vertices + inner ring 4 vertices = 8 vertices = 16 elements
    expect(flatCoords.length).toBe(16);
    // the inner ring starts at the 4th vertex
    expect(holeIndices).toEqual([4]);
    expect(rings.length).toBe(2);
    expect(rings[1].length).toBe(4);
  });

  it('accumulates holeIndices per inner ring for two holes', () => {
    const outer = square(0, 0, 20);
    const hole1 = square(2, 2, 3);
    const hole2: Coordinate[] = [
      [12, 12],
      [16, 12],
      [16, 16],
      [12, 16],
      [14, 14],
      [12, 12], // closing point
    ];
    const { flatCoords, holeIndices, rings } = buildEarcutInput([outer, hole1, hole2]);

    // outer ring 4 + inner ring 4 + inner ring 5 = 13 vertices = 26 elements
    expect(flatCoords.length).toBe(26);
    expect(holeIndices).toEqual([4, 8]);
    expect(rings.length).toBe(3);
    expect(rings[2].length).toBe(5);
  });

  it('concatenates the outer and inner rings in ring order in the flattened coordinates', () => {
    const outer = square(0, 0, 10);
    const hole = square(3, 3, 4);
    const { flatCoords, holeIndices } = buildEarcutInput([outer, hole]);

    // the head of the outer ring
    expect(flatCoords.slice(0, 2)).toEqual([0, 0]);
    // the head of the inner ring is at the position of holeIndices[0]
    const holeStart = holeIndices[0] * 2;
    expect(flatCoords.slice(holeStart, holeStart + 2)).toEqual([3, 3]);
  });

  it('increases the total triangle count over the outer-ring-only case when holes exist', () => {
    const outer = square(0, 0, 10);
    const hole = square(3, 3, 4);

    const withoutHole = triangleCount([outer]);
    const withOneHole = triangleCount([outer, hole]);
    const withTwoHoles = triangleCount([square(0, 0, 20), square(2, 2, 3), square(12, 12, 4)]);

    // a plain rectangle is 2 triangles
    expect(withoutHole).toBe(2);
    // opening a hole increases the number of triangles
    expect(withOneHole).toBeGreaterThan(withoutHole);
    expect(withTwoHoles).toBeGreaterThan(withOneHole);
  });

  it('ignores an inner ring with fewer than 3 vertices because it has no area', () => {
    const outer = square(0, 0, 10);
    const degenerate: Coordinate[] = [
      [3, 3],
      [4, 4],
      [3, 3], // 2 vertices once the closing point is removed
    ];
    const { flatCoords, holeIndices, rings } = buildEarcutInput([outer, degenerate]);

    expect(flatCoords.length).toBe(8);
    expect(holeIndices).toEqual([]);
    expect(rings.length).toBe(1);
  });

  it('returns an empty input when the outer ring has fewer than 3 vertices', () => {
    const { flatCoords, holeIndices, rings } = buildEarcutInput([
      [
        [0, 0],
        [1, 1],
      ],
    ]);

    expect(flatCoords).toEqual([]);
    expect(holeIndices).toEqual([]);
    expect(rings).toEqual([]);
  });

  it('returns an empty input when there is not a single ring', () => {
    const { flatCoords, holeIndices, rings } = buildEarcutInput([]);

    expect(flatCoords).toEqual([]);
    expect(holeIndices).toEqual([]);
    expect(rings).toEqual([]);
  });

  it('does not destroy the input array of rings', () => {
    const outer = square(0, 0, 10);
    const hole = square(3, 3, 4);
    const rings = [outer, hole];
    buildEarcutInput(rings);

    expect(rings.length).toBe(2);
    expect(outer.length).toBe(5);
    expect(hole.length).toBe(5);
  });
});
