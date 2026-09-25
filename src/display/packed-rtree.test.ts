// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for the packed R-tree of the datasets
 *
 * The search is compared with a scan of every bbox, over sizes around the node boundaries.
 */

import { describe, expect, it } from 'vitest';
import { buildPackedRTree, searchPackedRTree } from './packed-rtree.js';

/** A deterministic pseudo-random sequence */
function random(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };
}

/** Random boxes (every tenth row without a geometry) */
function boxes(count: number, seed: number): Float64Array {
  const next = random(seed);
  const out = new Float64Array(count * 4);
  for (let row = 0; row < count; row++) {
    if (row % 10 === 9) {
      out.fill(Number.NaN, row * 4, row * 4 + 4);
      continue;
    }
    const x = next() * 100 - 50;
    const y = next() * 60 - 30;
    const w = next() * (row % 3 === 0 ? 0 : 5);
    const h = next() * (row % 3 === 0 ? 0 : 5);
    out.set([x, y, x + w, y + h], row * 4);
  }
  return out;
}

function scan(bounds: Float64Array, q: number[]): number[] {
  const rows: number[] = [];
  for (let row = 0; row < bounds.length / 4; row++) {
    const b = bounds.subarray(row * 4, row * 4 + 4);
    if (Number.isNaN(b[0])) continue;
    if (b[0] <= q[2] && b[2] >= q[0] && b[1] <= q[3] && b[3] >= q[1]) rows.push(row);
  }
  return rows;
}

describe('the packed R-tree', () => {
  for (const count of [0, 1, 15, 16, 17, 255, 256, 257, 5_000]) {
    it(`finds exactly the intersecting rows (${count} rows)`, () => {
      const bounds = boxes(count, count + 1);
      const tree = buildPackedRTree(bounds);
      const next = random(7);
      for (let i = 0; i < 50; i++) {
        const x = next() * 110 - 55;
        const y = next() * 70 - 35;
        const q = [x, y, x + next() * 20, y + next() * 20];
        const found = searchPackedRTree(tree, q[0], q[1], q[2], q[3]).sort((a, b) => a - b);
        expect(found).toEqual(scan(bounds, q));
      }
    });
  }

  it('an edge that touches counts as intersecting', () => {
    const tree = buildPackedRTree(Float64Array.of(0, 0, 1, 1));
    expect(searchPackedRTree(tree, 1, 1, 2, 2)).toEqual([0]);
    expect(searchPackedRTree(tree, 1.0001, 1, 2, 2)).toEqual([]);
  });

  it('leaves out the rows without a geometry', () => {
    const tree = buildPackedRTree(Float64Array.of(Number.NaN, Number.NaN, Number.NaN, Number.NaN));
    expect(tree.numItems).toBe(0);
    expect(searchPackedRTree(tree, -180, -90, 180, 90)).toEqual([]);
  });
});
