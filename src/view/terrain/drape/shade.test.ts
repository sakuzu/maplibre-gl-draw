// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Verification of how the edge of a partial rectangle of the DEM is handled
 *
 * MapLibre reads the DEM one level coarser than the render tile (deltaZoom = 1),
 * so a render tile reads only a part of a DEM tile. Even between adjacent render
 * tiles of the same level, there are edges where the parent DEM tile differs
 * (the seam between odd and even x at z16).
 *
 * There are two promises to keep at such an edge.
 *
 * - The elevation agrees exactly on both sides (the border texels of a DEM are
 *   copies of the first columns of the neighboring DEM, so the same point gets
 *   the same value)
 * - The gradient of the shading lines up on both sides as well. The samples of
 *   the gradient must not run past the last texel of the DEM texture: reading
 *   outside the range freezes the sample at the clamp, the gradient shrinks, and
 *   only that band fails to get the shading and floats brightly (a 1 to 2 pixel
 *   cream-colored streak along the tile boundary)
 *
 * Here both are pinned down on a model that mirrors the same rules as the GLSL.
 * What the model mirrors is `_getDEMTileMatrix` and `DEMData.backfillBorder` of
 * MapLibre 6.11.1 (a border of two texels, pixels centred on their cells, see
 * `upstream-terrain.ts`), and `drape_get_elevation` / `terrainShade` of
 * drape/shared.ts.
 */

import { describe, expect, it } from 'vitest';
import { DEM_BORDER_TEXELS, demLastTexel, demTexelCoord } from '../upstream-terrain.js';
import { TILE_EXTENT } from './mesh.js';
import { drapeShadeWindow } from './shared.js';

/** The size of the DEM (in texels). The texture with the border added becomes dim + 4 */
const DIM = 256;

/**
 * The elevation of the world (decided by the serial number of the DEM node)
 *
 * Texture column i (0..dim+3) of DEM tile X is the node with serial number
 * X * dim + i - 2. Columns dim + 2 and dim + 3 point at the same nodes as
 * columns 2 and 3 of the neighboring tile, and columns 0 and 1 at the same nodes
 * as columns dim and dim + 1 of the neighboring tile. The `backfillBorder` of
 * MapLibre performs exactly that copy, so a DEM with its border filled in is this
 * expression itself.
 */
type Field = (node: number) => number;

/** A render tile (z is the render zoom. The DEM is one level coarser) */
interface RenderTile {
  readonly z: number;
  readonly x: number;
}

/** The partial rectangle of the DEM read by this render tile (only the x direction is seen) */
function demWindow(tile: RenderTile): { parent: number; dz: number; dx: number } {
  const dz = 1;
  const parent = tile.x >> dz;
  return { parent, dz, dx: tile.x - (parent << dz) };
}

/** Tile coordinates -> coord (texel space). The same as _getDEMTileMatrix of MapLibre */
function coordOf(tile: RenderTile, posX: number): number {
  const { dz, dx } = demWindow(tile);
  return demTexelCoord((posX + dx * TILE_EXTENT) / (TILE_EXTENT << dz), DIM);
}

/** The advance of coord per 1 of tile coordinates */
function coordPerUnit(tile: RenderTile): number {
  const { dz } = demWindow(tile);
  return DIM / (TILE_EXTENT << dz);
}

/** Elevation of one texture column (border included; outside the range clamps to the end) */
function texel(tile: RenderTile, field: Field, index: number): number {
  const { parent } = demWindow(tile);
  const clamped = Math.min(Math.max(index, 0), demLastTexel(DIM));
  return field(parent * DIM + clamped - DEM_BORDER_TEXELS);
}

/** Bilinear sampling of the elevation (the same expression as drape_get_elevation in GLSL) */
function elevationAt(tile: RenderTile, field: Field, posX: number): number {
  const coord = coordOf(tile, posX);
  const c = Math.floor(coord);
  const f = coord - c;
  const tl = texel(tile, field, c);
  const tr = texel(tile, field, c + 1);
  return tl + (tr - tl) * f;
}

/**
 * The east-west gradient of the shading (the same expression as terrainShade in
 * GLSL). It is returned per meter
 */
function eastGradient(tile: RenderTile, field: Field, posX: number, meters: number): number {
  const texelWidth = TILE_EXTENT / DIM;
  const window = drapeShadeWindow(coordOf(tile, posX), coordPerUnit(tile), texelWidth, DIM);
  const e1 = elevationAt(tile, field, posX + window.forward);
  const e0 = elevationAt(tile, field, posX - window.back);
  const span = (Math.max(window.forward + window.back, 1e-4) / TILE_EXTENT) * meters;
  return (e1 - e0) / span;
}

/** The central difference over the full width (what the window gives when nothing is cut) */
function eastGradientFull(tile: RenderTile, field: Field, posX: number, meters: number): number {
  const texelWidth = TILE_EXTENT / DIM;
  const e1 = elevationAt(tile, field, posX + texelWidth);
  const e0 = elevationAt(tile, field, posX - texelWidth);
  const span = ((2 * texelWidth) / TILE_EXTENT) * meters;
  return (e1 - e0) / span;
}

// Neighbors of the same level whose parent DEM tiles differ (the seam of odd and even x)
const trailing: RenderTile = { z: 16, x: 58201 };
const leading: RenderTile = { z: 16, x: 58202 };
// Neighbors that share the parent DEM tile (a seam that ends inside the partial rectangle)
const innerLeft: RenderTile = { z: 16, x: 58202 };
const innerRight: RenderTile = { z: 16, x: 58203 };

const TILE_METERS = 611;

describe('the edge of a partial rectangle of the DEM', () => {
  it('the model has the same correspondence as the border copying of MapLibre', () => {
    // Columns dim + 2 and dim + 3 of trailing and columns 2 and 3 of leading are the
    // same nodes (dx = 1 of backfillBorder)
    const field: Field = (node) => node;
    expect(texel(trailing, field, DIM + 2)).toBe(texel(leading, field, 2));
    expect(texel(trailing, field, DIM + 3)).toBe(texel(leading, field, 3));
    // Columns 0 and 1 of leading and columns dim and dim + 1 of trailing are the same
    // nodes too (dx = -1 of backfillBorder)
    expect(texel(leading, field, 0)).toBe(texel(trailing, field, DIM));
    expect(texel(leading, field, 1)).toBe(texel(trailing, field, DIM + 1));
    // The parents are adjacent but different tiles
    expect(demWindow(trailing).parent + 1).toBe(demWindow(leading).parent);
    expect(demWindow(trailing).dx).toBe(1);
    expect(demWindow(leading).dx).toBe(0);
  });

  it('the elevation agrees at a same-level boundary where the parent DEMs differ', () => {
    const field: Field = (node) => Math.sin(node / 37) * 120 + Math.cos(node / 11) * 40;
    // The right edge of one (x = EXTENT) and the left edge of the other (x = 0)
    // are the same point
    expect(elevationAt(trailing, field, TILE_EXTENT)).toBe(elevationAt(leading, field, 0));
  });

  it('the elevation agrees at a boundary that shares the parent DEM as well', () => {
    const field: Field = (node) => Math.sin(node / 23) * 80;
    expect(elevationAt(innerLeft, field, TILE_EXTENT)).toBe(elevationAt(innerRight, field, 0));
  });

  it('gradient lines up at a same-level boundary of different parent DEMs (flat slope)', () => {
    // On a slope of constant gradient, the one-sided difference over the shrunk
    // width and the full central difference agree exactly
    const field: Field = (node) => node * 3.5;
    const a = eastGradient(trailing, field, TILE_EXTENT, TILE_METERS);
    const b = eastGradient(leading, field, 0, TILE_METERS);
    expect(a).toBeCloseTo(b, 9);
  });

  it('the two-texel border leaves room for the full window at a render tile edge', () => {
    // The last DEM pixel a render tile reads is centred half a texel inside its
    // edge, and the border adds two more, so nothing is cut on either side
    const field: Field = (node) => Math.sin(node / 19) * 60;
    for (const [tile, posX] of [
      [trailing, TILE_EXTENT],
      [leading, 0],
      [innerLeft, TILE_EXTENT],
      [innerRight, 0],
    ] as const) {
      expect(eastGradient(tile, field, posX, TILE_METERS)).toBeCloseTo(
        eastGradientFull(tile, field, posX, TILE_METERS),
        9,
      );
    }
  });
});

describe('drapeShadeWindow', () => {
  const perUnit = DIM / (TILE_EXTENT << 1);
  const want = TILE_EXTENT / DIM;

  it('at the last texel of the texture forward becomes 0 and back stays full', () => {
    const window = drapeShadeWindow(demLastTexel(DIM), perUnit, want, DIM);
    expect(window.forward).toBe(0);
    expect(window.back).toBe(want);
  });

  it('at the first pixel both are full (the border texels exist before it)', () => {
    const window = drapeShadeWindow(demTexelCoord(0, DIM), perUnit, want, DIM);
    expect(window.forward).toBe(want);
    expect(window.back).toBe(want);
  });

  it('on the inside both are full', () => {
    const window = drapeShadeWindow(DIM / 2, perUnit, want, DIM);
    expect(window.forward).toBe(want);
    expect(window.back).toBe(want);
  });

  it('just before the end it shrinks by as much as is usable', () => {
    // A position where there is only 0.25 texel left to the last texel
    const window = drapeShadeWindow(demLastTexel(DIM) - 0.25, perUnit, want, DIM);
    expect(window.forward).toBeCloseTo(0.25 / perUnit, 9);
    expect(window.forward).toBeLessThan(want);
  });

  it('does not return a negative width even when the DEM is empty (dim = 1)', () => {
    const window = drapeShadeWindow(9999, 1, want, 1);
    expect(window.forward).toBe(0);
    expect(window.back).toBe(want);
  });
});
