// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Deciding the step of the terrain subdivision of polygons
 *
 * There are two things to protect here.
 *
 * 1. The fill never produces "only part of it fine and the rest flat". A mixture breaks
 *    through the terrain in a wedge shape
 * 2. For a batch with thousands of features, the step is decided by the total amount. A
 *    per-feature upper bound is no brake
 */

import { describe, expect, it } from 'vitest';
import type { Coordinate } from '../../store/types.js';
import { releaseTerrainContext, TerrainContext } from './context.js';
import type { RenderableTerrainTile } from './detect.js';
import { TERRAIN_MAX_BATCH_SUBDIVISION_CELLS, TERRAIN_MAX_COARSEN_STEPS } from './metrics.js';
import {
  batchTessellationFactor,
  boundingCells,
  polygonTessellationStep,
  ringBoundingCells,
  tessellatePolygonFill,
  tessellateRings,
} from './polygon.js';
import {
  type MercatorRect,
  mercatorX,
  mercatorY,
  subdivideTriangles,
  type TessellationStep,
} from './tessellation.js';
import { buildTessellationTiling } from './tiling.js';

/** The step corresponding to the node spacing at zoom 12 with meshSize 128 */
const base: TessellationStep = { grid: 1 / (2 ** 12 * 128), maxPoints: 120000 };

describe('batchTessellationFactor', () => {
  it('does not coarsen within the budget', () => {
    expect(batchTessellationFactor(0)).toBe(1);
    expect(batchTessellationFactor(TERRAIN_MAX_BATCH_SUBDIVISION_CELLS)).toBe(1);
  });

  it('coarsens by a power of 2 once the budget is exceeded', () => {
    // At four times the total amount, doubling the side of the step makes the cell count 1/4
    expect(batchTessellationFactor(TERRAIN_MAX_BATCH_SUBDIVISION_CELLS * 4)).toBe(2);
    expect(batchTessellationFactor(TERRAIN_MAX_BATCH_SUBDIVISION_CELLS * 16)).toBe(4);
  });

  it('caps the coarsening (it does not stray too far from the base step)', () => {
    const huge = TERRAIN_MAX_BATCH_SUBDIVISION_CELLS * 10 ** 12;
    expect(batchTessellationFactor(huge)).toBe(2 ** TERRAIN_MAX_COARSEN_STEPS);
  });

  it('keeps the total amount after coarsening within the budget', () => {
    const total = TERRAIN_MAX_BATCH_SUBDIVISION_CELLS * 17;
    const factor = batchTessellationFactor(total);
    expect(total / factor ** 2).toBeLessThanOrEqual(TERRAIN_MAX_BATCH_SUBDIVISION_CELLS);
  });
});

describe('cell count estimation', () => {
  it('gives the same answer for a flat coordinate array and for rings', () => {
    const ring: [number, number][] = [
      [0, 0],
      [0.05, 0],
      [0.05, 0.05],
      [0, 0.05],
    ];
    const flat = ring.flat();
    expect(ringBoundingCells(ring, base.grid)).toBeCloseTo(boundingCells(flat, base.grid), 6);
  });

  it('returns 0 when the step is 0 (the path without terrain passes straight through)', () => {
    expect(boundingCells([0, 0, 1, 1], 0)).toBe(0);
    expect(ringBoundingCells([[0, 0]], 0)).toBe(0);
  });
});

describe('tessellatePolygonFill', () => {
  const context = new TerrainContext();

  /** A square 0.05 degrees on a side (2 triangles) */
  const square = [0, 0, 0.05, 0, 0.05, 0.05, 0, 0.05];
  const squareIndices = [0, 1, 2, 0, 2, 3];

  it('uses the step as is when it can be subdivided fully', () => {
    try {
      const result = tessellatePolygonFill(context, undefined, 0, square, squareIndices, base);
      expect(result.step.grid).toBe(polygonTessellationStep(base, square).grid);
      expect(result.indices.length).toBeGreaterThan(squareIndices.length);
    } finally {
      releaseTerrainContext(context);
    }
  });

  it('coarsens and subdivides again for a step that does not fit (no flat triangles left)', () => {
    try {
      // With a budget of 500 points, a step of 1e-9 does not come close to fitting
      const tight: TessellationStep = { grid: 1e-9, maxPoints: 500 };
      expect(subdivideTriangles(square, squareIndices, tight).overflowed).toBe(true);

      const result = tessellatePolygonFill(context, undefined, 0, square, squareIndices, tight);
      // The step used is coarser than the one requested
      expect(result.step.grid).toBeGreaterThan(tight.grid);
      // Subdividing again with that step does not break down
      expect(subdivideTriangles(square, squareIndices, result.step).overflowed).toBe(false);
    } finally {
      releaseTerrainContext(context);
    }
  });

  it('puts the outline on the same grid as the fill when subdivided with the returned step', () => {
    try {
      const tight: TessellationStep = { grid: 1e-9, maxPoints: 500 };
      const result = tessellatePolygonFill(context, undefined, 0, square, squareIndices, tight);
      // The step the fill actually used differs from the raw step that was requested. If the
      // outline used the raw step the two would lie on different grids and the edge of the
      // fill and the outline would drift apart, so the caller must always use this step
      expect(result.step.grid).not.toBe(tight.grid);
      // Being a power of 2, the coarse grid is a subset of the fine grid
      const ratio = result.step.grid / tight.grid;
      expect(Number.isInteger(Math.log2(ratio))).toBe(true);
    } finally {
      releaseTerrainContext(context);
    }
  });

  it('returns the same step even on a cache hit', () => {
    try {
      const tight: TessellationStep = { grid: 1e-9, maxPoints: 500 };
      const first = tessellatePolygonFill(context, 'f1', 0, square, squareIndices, tight);
      const second = tessellatePolygonFill(context, 'f1', 0, square, squareIndices, tight);
      // The second time it is returned from the cache, but unless the step is remembered only
      // the outline ends up on a different grid
      expect(second.step.grid).toBe(first.step.grid);
      expect(second.indices).toBe(first.indices);
    } finally {
      releaseTerrainContext(context);
    }
  });
});

describe('the range of the subdivision', () => {
  /** A range roughly covering the area of Japan (Mercator) */
  const near: MercatorRect = { x0: 0.886, y0: 0.39, x1: 0.89, y1: 0.396 };
  const far: MercatorRect = { x0: 0.1, y0: 0.1, x1: 0.2, y1: 0.2 };
  /** A small square near Tokyo */
  const square = [139.5, 35.6, 139.51, 35.6, 139.51, 35.61, 139.5, 35.61];
  const squareIndices = [0, 1, 2, 0, 2, 3];

  it('returns the array as is for a feature outside the range (exiting before subdividing)', () => {
    const context = new TerrainContext();
    try {
      const result = tessellatePolygonFill(context, 'f1', 0, square, squareIndices, {
        ...base,
        region: far,
      });

      // The same array comes back as is = no vertex pool was built either
      expect(result.flatCoords).toBe(square);
      expect(result.indices).toBe(squareIndices);
    } finally {
      releaseTerrainContext(context);
    }
  });

  it('subdivides a feature inside the range as before', () => {
    const context = new TerrainContext();
    try {
      const result = tessellatePolygonFill(context, undefined, 0, square, squareIndices, {
        ...base,
        region: near,
      });

      expect(result.flatCoords.length).toBeGreaterThan(square.length);
    } finally {
      releaseTerrainContext(context);
    }
  });

  it('exits for the outline with the same test as the fill (a disagreement drifts apart)', () => {
    const rings: Coordinate[][] = [
      [
        [139.5, 35.6],
        [139.51, 35.6],
        [139.51, 35.61],
        [139.5, 35.61],
      ],
    ];

    expect(tessellateRings(rings, { ...base, region: far })).toBe(rings);
    expect(tessellateRings(rings, { ...base, region: near })[0].length).toBeGreaterThan(4);
  });

  it('counts only what is inside the range when estimating cells', () => {
    expect(boundingCells(square, base.grid, far)).toBe(0);
    expect(boundingCells(square, base.grid, near)).toBeGreaterThan(0);
    expect(
      ringBoundingCells(
        [
          [139.5, 35.6],
          [139.51, 35.61],
        ],
        base.grid,
        far,
      ),
    ).toBe(0);
  });
});

describe('reuse of the subdivision', () => {
  /** A small square near Tokyo */
  const square = [139.5, 35.6, 139.51, 35.6, 139.51, 35.61, 139.5, 35.61];
  const squareIndices = [0, 1, 2, 0, 2, 3];
  const meshSize = 128;
  const region: MercatorRect = {
    x0: mercatorX(139.4),
    y0: mercatorY(35.8),
    x1: mercatorX(139.7),
    y1: mercatorY(35.5),
  };
  const tileAt = (z: number, x: number, y: number): RenderableTerrainTile =>
    ({ z, x, y, tileID: null }) as unknown as RenderableTerrainTile;
  /** The set of zoom z tiles covering this range */
  const tilesFor = (z: number): RenderableTerrainTile[] => {
    const out: RenderableTerrainTile[] = [];
    const scale = 2 ** z;
    for (let x = Math.floor(region.x0 * scale); x <= Math.floor(region.x1 * scale); x++) {
      for (let y = Math.floor(region.y0 * scale); y <= Math.floor(region.y1 * scale); y++) {
        out.push(tileAt(z, x, y));
      }
    }
    return out;
  };
  const stepFor = (z: number, over = region): TessellationStep => ({
    grid: 1 / (2 ** 14 * meshSize),
    maxPoints: 800_000,
    region: over,
    tiling: buildTessellationTiling(tilesFor(z), meshSize, over),
  });

  const run = (context: TerrainContext, step: TessellationStep) =>
    tessellatePolygonFill(context, 'f-reuse', 0, square, squareIndices, step);

  it('does not subdivide again for the same tile configuration (it reuses the result)', () => {
    const context = new TerrainContext();
    try {
      const step = stepFor(14);
      const first = run(context, step);
      const second = run(context, step);

      // The same array comes back as is = it was not subdivided again
      expect(second.flatCoords).toBe(first.flatCoords);
      expect(second.indices).toBe(first.indices);
    } finally {
      releaseTerrainContext(context);
    }
  });

  it('reuses the result when the range moves if the covering tiles are the same', () => {
    const context = new TerrainContext();
    try {
      const first = run(context, stepFor(14));
      const moved: MercatorRect = {
        x0: region.x0 - 0.0002,
        y0: region.y0 - 0.0002,
        x1: region.x1 - 0.0002,
        y1: region.y1 - 0.0002,
      };
      const second = run(context, stepFor(14, moved));

      expect(second.flatCoords).toBe(first.flatCoords);
    } finally {
      releaseTerrainContext(context);
    }
  });

  it('subdivides again when the zoom of the covering tiles changes', () => {
    const context = new TerrainContext();
    try {
      const first = run(context, stepFor(14));
      const second = run(context, stepFor(13));

      expect(second.flatCoords).not.toBe(first.flatCoords);
      // The tiles are coarser, so there are fewer subdivision points
      expect(second.flatCoords.length).toBeLessThan(first.flatCoords.length);
    } finally {
      releaseTerrainContext(context);
    }
  });
});
