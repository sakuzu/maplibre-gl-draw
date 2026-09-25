// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Verification of the coverage of the terrain mesh
 *
 * The promise to uphold is that "the cells of one tile cover [0, EXTENT] as a closed interval,
 * with not a single row or column left unstretched". Forgetting to stretch the last row or
 * column leaves an uncovered band at the right or bottom edge of the tile, which shows up as a
 * crack along the boundary with the neighboring tile. Two things pin it down here: the sum of
 * the areas of the triangles, and the number of connections per edge.
 *
 * The area comes to "exactly one tile's worth if there is neither overlap nor gap". The number
 * of connections per edge must be such that "an interior edge is always shared by two
 * triangles, and the only edges with just one are on the outer ring of the tile". Forgetting a
 * row or a column necessarily breaks the latter.
 */

import { describe, expect, it } from 'vitest';
import { buildTerrainMeshArrays, TILE_EXTENT } from './mesh.js';

/** Reads a single vertex */
function vertexAt(vertices: Int16Array, index: number): [number, number] {
  return [vertices[index * 2], vertices[index * 2 + 1]];
}

/** The key of an edge (regardless of direction) */
function edgeKey(a: number, b: number): string {
  return a < b ? `${a}-${b}` : `${b}-${a}`;
}

describe('buildTerrainMeshArrays', () => {
  for (const meshSize of [2, 4, 16, 128]) {
    describe(`meshSize = ${meshSize}`, () => {
      const { vertices, indices } = buildTerrainMeshArrays(meshSize);
      const delta = TILE_EXTENT / meshSize;

      it('has (meshSize + 1)^2 vertices, laying out 0 and EXTENT as a closed interval', () => {
        expect(vertices.length).toBe((meshSize + 1) ** 2 * 2);
        expect(vertexAt(vertices, 0)).toEqual([0, 0]);
        expect(vertexAt(vertices, meshSize)).toEqual([TILE_EXTENT, 0]);
        expect(vertexAt(vertices, (meshSize + 1) * meshSize)).toEqual([0, TILE_EXTENT]);
        expect(vertexAt(vertices, (meshSize + 1) ** 2 - 1)).toEqual([TILE_EXTENT, TILE_EXTENT]);
      });

      it('has meshSize^2 cells (two triangles each)', () => {
        expect(indices.length).toBe(meshSize * meshSize * 6);
        for (const index of indices) expect(index).toBeLessThan((meshSize + 1) ** 2);
      });

      it('makes the sum of the triangle areas equal one tile (no gap and no overlap)', () => {
        let area = 0;
        for (let t = 0; t < indices.length; t += 3) {
          const [ax, ay] = vertexAt(vertices, indices[t]);
          const [bx, by] = vertexAt(vertices, indices[t + 1]);
          const [cx, cy] = vertexAt(vertices, indices[t + 2]);
          area += Math.abs((bx - ax) * (cy - ay) - (cx - ax) * (by - ay)) / 2;
        }
        expect(area).toBe(TILE_EXTENT * TILE_EXTENT);
      });

      it('has edges with only one triangle only on the outer ring of the tile', () => {
        const uses = new Map<string, number>();
        for (let t = 0; t < indices.length; t += 3) {
          const a = indices[t];
          const b = indices[t + 1];
          const c = indices[t + 2];
          for (const [p, q] of [
            [a, b],
            [b, c],
            [c, a],
          ]) {
            const key = edgeKey(p, q);
            uses.set(key, (uses.get(key) ?? 0) + 1);
          }
        }

        const boundary: string[] = [];
        for (const [key, count] of uses) {
          expect(count).toBeLessThanOrEqual(2);
          if (count === 1) boundary.push(key);
        }

        // The outer ring has 4 sides x meshSize edges. Every one of them lies on one of the
        // 4 boundary lines
        expect(boundary.length).toBe(meshSize * 4);
        for (const key of boundary) {
          const [a, b] = key.split('-').map(Number);
          const [ax, ay] = vertexAt(vertices, a);
          const [bx, by] = vertexAt(vertices, b);
          const onLine =
            (ax === 0 && bx === 0) ||
            (ax === TILE_EXTENT && bx === TILE_EXTENT) ||
            (ay === 0 && by === 0) ||
            (ay === TILE_EXTENT && by === TILE_EXTENT);
          expect(onLine).toBe(true);
        }
      });

      it('gives the four sides closed intervals of step delta, opposite sides agreeing', () => {
        const along = (pick: (i: number) => [number, number]): number[] =>
          Array.from({ length: meshSize + 1 }, (_, i) => pick(i)).map(([, v]) => v);

        const top = along((i) => vertexAt(vertices, i));
        const bottom = along((i) => vertexAt(vertices, (meshSize + 1) * meshSize + i));
        const left = along((i) => {
          const [x, y] = vertexAt(vertices, i * (meshSize + 1));
          return [y, x];
        });
        const right = along((i) => {
          const [x, y] = vertexAt(vertices, i * (meshSize + 1) + meshSize);
          return [y, x];
        });

        // The top and bottom sides lay out y (= 0 / EXTENT). For the left and right sides x
        // has been extracted
        expect(top).toEqual(Array.from({ length: meshSize + 1 }, () => 0));
        expect(bottom).toEqual(Array.from({ length: meshSize + 1 }, () => TILE_EXTENT));
        expect(left).toEqual(Array.from({ length: meshSize + 1 }, () => 0));
        expect(right).toEqual(Array.from({ length: meshSize + 1 }, () => TILE_EXTENT));

        // The position along a side is the closed interval 0..EXTENT (looping over a
        // half-open interval would lose the last one)
        const positions = Array.from({ length: meshSize + 1 }, (_, i) => vertexAt(vertices, i)[0]);
        expect(positions).toEqual(Array.from({ length: meshSize + 1 }, (_, i) => i * delta));
      });
    });
  }

  it('has adjoining tiles at the same zoom share the boundary vertex row completely', () => {
    // There is one mesh regardless of the tile. The right side of the left tile and the left
    // side of the right tile have the same values for the position along the side (y), laid
    // out in the same order
    const meshSize = 32;
    const { vertices } = buildTerrainMeshArrays(meshSize);
    const rightEdge: Array<[number, number]> = [];
    const leftEdge: Array<[number, number]> = [];
    for (let i = 0; i <= meshSize; i++) {
      rightEdge.push(vertexAt(vertices, i * (meshSize + 1) + meshSize));
      leftEdge.push(vertexAt(vertices, i * (meshSize + 1)));
    }
    expect(rightEdge.map(([x]) => x)).toEqual(rightEdge.map(() => TILE_EXTENT));
    expect(leftEdge.map(([x]) => x)).toEqual(leftEdge.map(() => 0));
    expect(rightEdge.map(([, y]) => y)).toEqual(leftEdge.map(([, y]) => y));
  });
});
