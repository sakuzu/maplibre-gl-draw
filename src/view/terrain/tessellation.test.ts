// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import type { Coordinate } from '../../store/types.js';
import {
  atlasCoverage,
  cellsInRegion,
  containsRect,
  densifyPath,
  densifyRings,
  expandRect,
  intersectRect,
  type MercatorRect,
  subdivideTriangles,
} from './tessellation.js';

// The step of the Mercator lattice. Equivalent to the node interval of zoom 12, meshSize 128
const step = { grid: 1 / (2 ** 12 * 128), maxPoints: 200000 };

/** The total area of the triangles */
function totalArea(flatCoords: readonly number[], indices: readonly number[]): number {
  let sum = 0;
  for (let i = 0; i + 2 < indices.length; i += 3) {
    const ax = flatCoords[indices[i] * 2];
    const ay = flatCoords[indices[i] * 2 + 1];
    const bx = flatCoords[indices[i + 1] * 2];
    const by = flatCoords[indices[i + 1] * 2 + 1];
    const cx = flatCoords[indices[i + 2] * 2];
    const cy = flatCoords[indices[i + 2] * 2 + 1];
    sum += Math.abs((bx - ax) * (cy - ay) - (cx - ax) * (by - ay)) / 2;
  }
  return sum;
}

/** Count how many times each edge appears (undirected edges, ignoring vertex number order) */
function edgeCounts(indices: readonly number[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (let i = 0; i + 2 < indices.length; i += 3) {
    const tri = [indices[i], indices[i + 1], indices[i + 2]];
    for (let e = 0; e < 3; e++) {
      const a = tri[e];
      const b = tri[(e + 1) % 3];
      const key = a < b ? `${a}-${b}` : `${b}-${a}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return counts;
}

describe('densifyPath', () => {
  it('does nothing when the step is 0', () => {
    const path: Coordinate[] = [
      [0, 0],
      [1, 1],
    ];
    expect(densifyPath(path, { grid: 0, maxPoints: 100 })).toBe(path);
  });

  it('always keeps the original vertices', () => {
    const path: Coordinate[] = [
      [0, 0],
      [0.05, 0],
      [0.05, 0.05],
    ];
    const dense = densifyPath(path, step);
    expect(dense[0]).toEqual([0, 0]);
    expect(dense[dense.length - 1]).toEqual([0.05, 0.05]);
    for (const original of path) {
      expect(dense.some((p) => p[0] === original[0] && p[1] === original[1])).toBe(true);
    }
  });

  it('inserts split points into an edge that crosses lattice lines', () => {
    const dense = densifyPath(
      [
        [0, 0],
        [0.05, 0],
      ],
      step,
    );
    // As many points are inserted as the number of crossings of the Mercator lattice (both
    // ends + the intersections)
    expect(dense.length).toBeGreaterThan(50);
    expect(dense[0]).toEqual([0, 0]);
    expect(dense[dense.length - 1]).toEqual([0.05, 0]);
  });

  it('puts the split points on the original edge (straightness is not broken)', () => {
    const dense = densifyPath(
      [
        [0, 0],
        [0.05, 0.05],
      ],
      step,
    );
    // Since it is a straight line in Mercator space, it is not exactly straight in longitude
    // and latitude. Check that the points lie on the Mercator straight line joining the two
    // original points.
    const my = (lat: number): number =>
      (1 -
        Math.log(Math.tan((lat * Math.PI) / 180) + 1 / Math.cos((lat * Math.PI) / 180)) / Math.PI) /
      2;
    const y0 = my(0);
    const y1 = my(0.05);
    for (const [x, y] of dense) {
      const t = x / 0.05;
      expect(Math.abs(my(y) - (y0 + (y1 - y0) * t))).toBeLessThan(1e-12);
    }
  });

  it('does not create points beyond the upper limit', () => {
    const dense = densifyPath(
      [
        [0, 0],
        [10, 0],
      ],
      { grid: step.grid / 8, maxPoints: 50 },
    );
    expect(dense.length).toBeLessThanOrEqual(52);
  });
});

describe('densifyRings', () => {
  it('splits the edge that goes back as well, without creating a closing point', () => {
    const ring: Coordinate[] = [
      [0, 0],
      [0.05, 0],
      [0.05, 0.05],
      [0, 0.05],
    ];
    const [dense] = densifyRings([ring], step);
    expect(dense[0]).toEqual([0, 0]);
    expect(dense[dense.length - 1]).not.toEqual([0, 0]);
    // Each of the 4 edges is split by the lattice (no closing point is added)
    expect(dense.length).toBeGreaterThan(4 * 50);
  });
});

describe('subdivideTriangles', () => {
  const square = [0, 0, 0.05, 0, 0.05, 0.05, 0, 0.05];
  const squareIndices = [0, 1, 2, 0, 2, 3];

  it('does not add triangles when the step is 0', () => {
    const result = subdivideTriangles(square, squareIndices, { grid: 0, maxPoints: 100 });
    expect(result.indices).toEqual(squareIndices);
    expect(result.flatCoords).toEqual(square);
  });

  it('preserves the area', () => {
    const before = totalArea(square, squareIndices);
    const after = subdivideTriangles(square, squareIndices, step);
    expect(totalArea(after.flatCoords, after.indices)).toBeCloseTo(before, 9);
  });

  it('becomes as fine as the number of lattice cells', () => {
    const after = subdivideTriangles(square, squareIndices, step);
    // Splitting a 0.05 degree square at the zoom 12 node interval gives thousands of cells
    expect(after.indices.length / 3).toBeGreaterThan(2000);
  });

  it('produces no cracks (an unshared interior edge, if any, leaves a negligible gap)', () => {
    const after = subdivideTriangles(square, squareIndices, step);
    const counts = edgeCounts(after.indices);

    // An edge appears only 1 time (the outer ring) or 2 times (the interior). 3 or more
    // means the split is inconsistent
    for (const count of counts.values()) {
      expect(count).toBeLessThanOrEqual(2);
    }

    const at = (i: number): [number, number] => [
      after.flatCoords[i * 2],
      after.flatCoords[i * 2 + 1],
    ];
    const onSquareEdge = (p: [number, number]): boolean =>
      Math.abs(p[0]) < 1e-12 ||
      Math.abs(p[0] - 0.05) < 1e-12 ||
      Math.abs(p[1]) < 1e-12 ||
      Math.abs(p[1] - 0.05) < 1e-12;

    // Unshared edges that do not lie on the outer ring (= candidates for an interior crack)
    const interior: Array<[[number, number], [number, number]]> = [];
    for (const [key, count] of counts) {
      if (count !== 1) continue;
      const [a, b] = key.split('-').map(Number);
      const pa = at(a);
      const pb = at(b);
      if (onSquareEdge(pa) && onSquareEdge(pb)) continue;
      interior.push([pa, pb]);
    }

    // There must be very few of them (only those that come from rounding)
    expect(interior.length / counts.size).toBeLessThan(0.005);

    // Every candidate must have a partner at almost the same position.
    // = The neighbouring triangle has the same edge, but differs in the last few bits.
    // If the width of the gap is below this tolerance (1e-8 degrees = 1 mm on the ground)
    // it does not affect rendering.
    const near = (p: [number, number], q: [number, number]): boolean =>
      Math.abs(p[0] - q[0]) < 1e-8 && Math.abs(p[1] - q[1]) < 1e-8;
    for (const [pa, pb] of interior) {
      const partner = interior.some(
        ([qa, qb]) =>
          (near(pa, qa) && near(pb, qb) && !(pa === qa && pb === qb)) ||
          (near(pa, qb) && near(pb, qa)),
      );
      expect(partner).toBe(true);
    }
  });

  it('makes two triangles that share a diagonal edge use the same split points', () => {
    const after = subdivideTriangles(square, squareIndices, step);
    const counts = edgeCounts(after.indices);
    // The points on the diagonal (0,0)-(0.05,0.05) are shared by the two triangles, so
    // there is an edge that appears twice as an interior edge
    expect([...counts.values()].some((count) => count === 2)).toBe(true);
  });

  it('stops splitting once the upper limit is reached (the vertex count does not run away)', () => {
    const after = subdivideTriangles(square, squareIndices, {
      grid: 1e-9,
      maxPoints: 500,
    });
    expect(after.flatCoords.length / 2).toBeLessThan(4000);
  });
});

describe('reporting that it could not split through', () => {
  const square = [0, 0, 0.05, 0, 0.05, 0.05, 0, 0.05];
  const squareIndices = [0, 1, 2, 0, 2, 3];

  it('does not raise overflowed when it splits through normally', () => {
    const after = subdivideTriangles(square, squareIndices, step);
    expect(after.overflowed).toBe(false);
  });

  it('raises overflowed when the vertex budget runs out', () => {
    // The step is too fine to fit within the budget. The remaining triangles are emitted as
    // they were (flat triangles that do not follow the terrain), so the caller must be told
    const after = subdivideTriangles(square, squareIndices, {
      grid: 1e-9,
      maxPoints: 500,
    });
    expect(after.overflowed).toBe(true);
  });

  it('raises overflowed when one triangle covers too many cells as well', () => {
    // The budget is ample, but the cell count exceeds the per-triangle upper limit (65536).
    // This triangle is emitted as it is without being split, so this is a breakdown too
    const after = subdivideTriangles(square, squareIndices, {
      grid: 1e-7,
      maxPoints: 10 ** 9,
    });
    expect(after.overflowed).toBe(true);
  });

  it('is not a breakdown when terrain is disabled (grid 0)', () => {
    const after = subdivideTriangles(square, squareIndices, { grid: 0, maxPoints: 100 });
    expect(after.overflowed).toBe(false);
  });
});

describe('the tessellation area', () => {
  const square = [0, 0, 0.05, 0, 0.05, 0.05, 0, 0.05];
  const squareIndices = [0, 1, 2, 0, 2, 3];
  /** An area that fully contains the square above (in Mercator) */
  const inside: MercatorRect = { x0: 0.4, y0: 0.4, x1: 0.6, y1: 0.6 };
  /** An area far away from the square above */
  const elsewhere: MercatorRect = { x0: 0.1, y0: 0.1, x1: 0.2, y1: 0.2 };

  it('does not split triangles outside the area (splitting would not change elevation)', () => {
    const after = subdivideTriangles(square, squareIndices, { ...step, region: elsewhere });

    // The winding order is normalised (pushOriented, the premise of back-face culling), so
    // we check that they are the same as a set of triangles
    expect(after.indices).toEqual([0, 1, 2, 0, 2, 3]);
    expect(after.flatCoords).toEqual(square);
    // It simply was not split; this is not a breakdown
    expect(after.overflowed).toBe(false);
  });

  it('splits triangles inside the area just as before', () => {
    const after = subdivideTriangles(square, squareIndices, { ...step, region: inside });
    const plain = subdivideTriangles(square, squareIndices, step);

    expect(after.indices).toEqual(plain.indices);
    expect(after.flatCoords).toEqual(plain.flatCoords);
  });

  it('does not insert split points into edges outside the area', () => {
    const path: Coordinate[] = [
      [0, 0],
      [0.05, 0.05],
    ];
    expect(densifyPath(path, { ...step, region: elsewhere })).toEqual(path);
    expect(densifyPath(path, { ...step, region: inside }).length).toBeGreaterThan(2);
  });

  it('counts only what is inside the area in the cell estimate', () => {
    const all = cellsInRegion(0.5, 0.5, 0.6, 0.6, 0.01, null);
    const half = cellsInRegion(0.5, 0.5, 0.6, 0.6, 0.01, { x0: 0.5, y0: 0.5, x1: 0.55, y1: 0.6 });

    expect(all).toBeCloseTo(100, 6);
    expect(half).toBeCloseTo(50, 6);
    expect(cellsInRegion(0.5, 0.5, 0.6, 0.6, 0.01, elsewhere)).toBe(0);
  });

  it('containment and intersection of rectangles', () => {
    expect(containsRect(inside, { x0: 0.45, y0: 0.45, x1: 0.5, y1: 0.5 })).toBe(true);
    expect(containsRect(inside, { x0: 0.3, y0: 0.45, x1: 0.5, y1: 0.5 })).toBe(false);
    expect(intersectRect(inside, elsewhere)).toBeNull();
    expect(intersectRect(inside, { x0: 0.5, y0: 0.5, x1: 0.7, y1: 0.7 })).toEqual({
      x0: 0.5,
      y0: 0.5,
      x1: 0.6,
      y1: 0.6,
    });
  });

  it('can convert the atlas uniform representation into a rectangle', () => {
    expect(atlasCoverage([0.25, 0.5, 1 / 0.125, 1 / 0.25])).toEqual({
      x0: 0.25,
      y0: 0.5,
      x1: 0.375,
      y1: 0.75,
    });
  });

  it('expands the margin outwards as a ratio of the side lengths', () => {
    expect(expandRect({ x0: 0, y0: 0, x1: 1, y1: 2 }, 0.5)).toEqual({
      x0: -0.5,
      y0: -1,
      x1: 1.5,
      y1: 3,
    });
  });
});

describe('reporting the amount that overflowed', () => {
  const square = [0, 0, 0.05, 0, 0.05, 0.05, 0, 0.05];
  const squareIndices = [0, 1, 2, 0, 2, 3];

  it('the factor is 1 when it splits through', () => {
    expect(subdivideTriangles(square, squareIndices, step).overflowFactor).toBe(1);
  });

  it('returns the needed factor when there are too many cells (in one go, not by doubling)', () => {
    const after = subdivideTriangles(square, squareIndices, { grid: 1e-7, maxPoints: 10 ** 9 });

    expect(after.overflowed).toBe(true);
    // Coarsening by that factor makes it split through
    const retry = subdivideTriangles(square, squareIndices, {
      grid: 1e-7 * 2 ** Math.ceil(Math.log2(after.overflowFactor)),
      maxPoints: 10 ** 9,
    });
    expect(retry.overflowed).toBe(false);
  });
});

describe('pushOriented (the premise of back-face culling)', () => {
  it('normalises the winding order to a positive Mercator cross product', async () => {
    const { pushOriented } = await import('./tessellation.js');
    const xs = [0, 10, 0];
    const ys = [0, 0, 10];
    const pool = { x: (i: number) => xs[i], y: (i: number) => ys[i] } as unknown as Parameters<
      typeof pushOriented
    >[1];
    // (0,2,1): negative cross product -> kept as it is (negative is GL's front face; the
    // sign determined on real hardware)
    const out1: number[] = [];
    pushOriented(out1, pool, 0, 2, 1);
    expect(out1).toEqual([0, 2, 1]);
    // (0,1,2): positive cross product -> flipped, ending up with the same orientation
    const out2: number[] = [];
    pushOriented(out2, pool, 0, 1, 2);
    expect(out2).toEqual([0, 2, 1]);
  });
});
