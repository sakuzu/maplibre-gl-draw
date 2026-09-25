// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import {
  buildQuadGrid,
  computeQuadGridSize,
  QUAD_GRID_MAX_CELLS,
  QUAD_GRID_MAX_DIVISIONS,
} from './quad-grid.js';

/** An axis-aligned rectangle in Mercator coordinates */
function rect(x0: number, y0: number, x1: number, y1: number): number[] {
  return [x0, y0, x1, y0, x1, y1, x0, y1];
}

describe('computeQuadGridSize', () => {
  it('does not subdivide when the terrain step is unavailable', () => {
    expect(computeQuadGridSize(rect(0, 0, 0.1, 0.1), 0)).toEqual({ nx: 1, ny: 1, coarsening: 1 });
  });

  it('splits at half the step of the terrain mesh nodes', () => {
    // Edge length 0.01, node spacing 0.001 -> target step 0.0005 -> 20 divisions
    const size = computeQuadGridSize(rect(0, 0, 0.01, 0.01), 0.001);
    expect(size.nx).toBe(20);
    expect(size.ny).toBe(20);
    // It is finer than the nodes, so the coarseness stays at 1
    expect(size.coarsening).toBe(1);
  });

  it('splits at the step itself when the globe asks for its cell', () => {
    // A quad 0.4 x 0.1 of the world at the fill cell of the globe (1/128): one piece per cell
    const size = computeQuadGridSize(rect(0.3, 0.3, 0.7, 0.4), 1 / 128, 1);
    expect(size.nx).toBe(Math.ceil(0.4 * 128));
    expect(size.ny).toBe(Math.ceil(0.1 * 128));
  });

  it('does not split a quad smaller than the nodes', () => {
    const size = computeQuadGridSize(rect(0, 0, 0.0002, 0.0002), 0.001);
    expect(size.nx).toBe(1);
    expect(size.ny).toBe(1);
  });

  it('has an upper limit on the number of divisions per side', () => {
    const size = computeQuadGridSize(rect(0, 0, 0.5, 0.0002), 1e-6);
    expect(size.nx).toBe(QUAD_GRID_MAX_DIVISIONS);
  });

  it('respects the cell count limit and returns the coarsening factor', () => {
    const size = computeQuadGridSize(rect(0, 0, 0.5, 0.5), 1e-6);
    expect(size.nx * size.ny).toBeLessThanOrEqual(QUAD_GRID_MAX_CELLS);
    // The actual step (0.5 / nx) is much coarser than the node spacing 1e-6
    expect(size.coarsening).toBeCloseTo(0.5 / size.nx / 1e-6, 6);
    expect(size.coarsening).toBeGreaterThan(1);
  });
});

describe('buildQuadGrid', () => {
  it('returns the four corners back to the original four corners', () => {
    // A small rectangle near the equator (Mercator y = 0.5 is latitude 0)
    const quad = rect(0.5, 0.5, 0.52, 0.52);
    const grid = buildQuadGrid(quad, 4, 4);
    expect(grid.vertexCount).toBe(25);
    expect(grid.indices.length).toBe(4 * 4 * 6);

    const lngOf = (x: number): number => x * 360 - 180;
    // Top-left
    expect(grid.lngLat[0]).toBeCloseTo(lngOf(0.5), 10);
    // Top-right (the last of row 0)
    expect(grid.lngLat[4 * 2]).toBeCloseTo(lngOf(0.52), 10);
    // Bottom-left (the head of the last row)
    expect(grid.lngLat[20 * 2]).toBeCloseTo(lngOf(0.5), 10);
  });

  it('spans 0..1 evenly with the texture coordinates', () => {
    const grid = buildQuadGrid(rect(0.5, 0.5, 0.6, 0.6), 2, 2);
    expect(Array.from(grid.texCoords.slice(0, 6))).toEqual([0, 0, 0.5, 0, 1, 0]);
    // The last row
    expect(Array.from(grid.texCoords.slice(12, 18))).toEqual([0, 1, 0.5, 1, 1, 1]);
  });

  it('keeps the Mercator non-linearity in the latitude direction for interpolated vertices', () => {
    // The midpoint of a rectangle stretched far to the north lies north of the simple
    // average of the latitudes
    const grid = buildQuadGrid(rect(0.5, 0.2, 0.6, 0.4), 1, 2);
    const latTop = grid.lngLat[1];
    const latMiddle = grid.lngLat[2 * 2 + 1];
    const latBottom = grid.lngLat[4 * 2 + 1];
    expect(latMiddle).toBeLessThan(latTop);
    expect(latMiddle).toBeGreaterThan(latBottom);
    expect(latMiddle).not.toBeCloseTo((latTop + latBottom) / 2, 3);
  });

  it('keeps the indices within the range of the vertex count', () => {
    const grid = buildQuadGrid(rect(0.5, 0.5, 0.6, 0.6), 3, 5);
    for (const index of grid.indices) {
      expect(index).toBeLessThan(grid.vertexCount);
    }
  });
});
