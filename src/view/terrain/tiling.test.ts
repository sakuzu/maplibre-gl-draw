// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The index of subdivision steps per terrain tile
 */

import { describe, expect, it } from 'vitest';
import type { RenderableTerrainTile } from './detect.js';
import { buildTessellationTiling, tilingSignature } from './tiling.js';

/** Tile (x, y) at zoom z. tileID is not used in computing the index, so empty is enough */
const tile = (z: number, x: number, y: number): RenderableTerrainTile =>
  ({ z, x, y, tileID: null }) as unknown as RenderableTerrainTile;

describe('buildTessellationTiling', () => {
  it('does not build an index when there are no tiles', () => {
    expect(buildTessellationTiling([], 128, null)).toBeNull();
  });

  it('makes the step the tile actual mesh spacing (tile width / subdivisions)', () => {
    const tiling = buildTessellationTiling([tile(10, 512, 512)], 128, null);

    expect(tiling).not.toBeNull();
    // Tile width at zoom 10 = 1/1024, subdivided into 128
    expect(tiling?.grids[0]).toBeCloseTo(1 / 1024 / 128, 12);
  });

  it('varies the step per cell when coarse and fine tiles are mixed', () => {
    // One zoom 11 tile (fine) and one zoom 10 tile (coarse) covering the area next to it
    const tiling = buildTessellationTiling([tile(11, 1024, 1024), tile(10, 513, 512)], 128, null);

    expect(tiling).not.toBeNull();
    const grids = new Set(Array.from(tiling?.grids ?? []));
    expect(grids.has(1 / 2048 / 128)).toBe(true);
    expect(grids.has(1 / 1024 / 128)).toBe(true);
  });

  it('covers the whole range with the index (missing part of it erases that fill)', () => {
    const region = { x0: 0.5, y0: 0.5, x1: 0.5 + 1 / 512, y1: 0.5 + 1 / 512 };
    const tiling = buildTessellationTiling([tile(10, 512, 512)], 128, region);

    expect(tiling).not.toBeNull();
    expect(tiling?.rect.x0).toBeLessThanOrEqual(region.x0);
    expect(tiling?.rect.y0).toBeLessThanOrEqual(region.y0);
    expect(tiling?.rect.x1).toBeGreaterThanOrEqual(region.x1);
    expect(tiling?.rect.y1).toBeGreaterThanOrEqual(region.y1);
  });

  it('gives a cell with no tile a step of 0 (that area is not subdivided)', () => {
    // The range is four tiles wide, but there is only one tile
    const region = { x0: 0.5, y0: 0.5, x1: 0.5 + 2 / 1024, y1: 0.5 + 2 / 1024 };
    const tiling = buildTessellationTiling([tile(10, 512, 512)], 128, region);

    expect(tiling).not.toBeNull();
    expect(Array.from(tiling?.grids ?? []).some((g) => g === 0)).toBe(true);
  });
});

describe('tilingSignature', () => {
  const meshSize = 128;
  const region = { x0: 0.5, y0: 0.5, x1: 0.5 + 1 / 512, y1: 0.5 + 1 / 512 };
  /** The set of zoom z tiles covering the range */
  const tilesFor = (z: number): RenderableTerrainTile[] => {
    const out: RenderableTerrainTile[] = [];
    const scale = 2 ** z;
    for (let x = Math.floor(region.x0 * scale); x <= Math.floor(region.x1 * scale); x++) {
      for (let y = Math.floor(region.y0 * scale); y <= Math.floor(region.y1 * scale); y++) {
        out.push(tile(z, x, y));
      }
    }
    return out;
  };
  const keyFor = (z: number): string =>
    tilingSignature(
      buildTessellationTiling(tilesFor(z), meshSize, region),
      region,
      1,
      1 / (2 ** z * meshSize),
      region.x0,
      region.y0,
      region.x1,
      region.y1,
    );

  it('changes the fingerprint when the zoom changes by one level', () => {
    // The case where all the tiles in the view move by one level together. Back when this was
    // written as the "difference" from the finest tile, these two produced the same
    // fingerprint and chunks with the old step stayed forever
    expect(keyFor(13)).not.toBe(keyFor(14));
    expect(keyFor(14)).not.toBe(keyFor(15));
  });

  it('changes the fingerprint on a zoom change even for a small area inside one cell', () => {
    // This was the regression itself. When the area fits inside a single index cell there is
    // only one per-cell value, and since it was written as the "difference from the finest"
    // tile, neither the value nor the count changed when the zooms moved together (= stale
    // forever)
    const small = { x0: 0.500001, y0: 0.500001, x1: 0.500002, y1: 0.500002 };
    const keySmall = (z: number): string =>
      tilingSignature(
        buildTessellationTiling(tilesFor(z), meshSize, region),
        region,
        1,
        1 / (2 ** z * meshSize),
        small.x0,
        small.y0,
        small.x1,
        small.y1,
      );

    expect(keySmall(14)).not.toBe(keySmall(15));
    expect(keySmall(15)).not.toBe(keySmall(16));
  });

  it('gives the same fingerprint for the same configuration', () => {
    expect(keyFor(14)).toBe(keyFor(14));
  });

  it('shows a difference in the step in the fingerprint even without an index', () => {
    const a = tilingSignature(null, region, 1, 1 / (2 ** 14 * meshSize), 0.5, 0.5, 0.6, 0.6);
    const b = tilingSignature(null, region, 1, 1 / (2 ** 15 * meshSize), 0.5, 0.5, 0.6, 0.6);

    expect(a).not.toBe(b);
  });

  it('changes the fingerprint when the coarsening factor changes', () => {
    const grid = 1 / (2 ** 14 * meshSize);
    const tiling = buildTessellationTiling(tilesFor(14), meshSize, region);
    const a = tilingSignature(tiling, region, 1, grid, region.x0, region.y0, region.x1, region.y1);
    const b = tilingSignature(tiling, region, 2, grid, region.x0, region.y0, region.x1, region.y1);

    expect(a).not.toBe(b);
  });
});
