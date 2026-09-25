// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Subdivision step per terrain tile (the index)
 *
 * MapLibre's terrain is "a polyline surface stretched over a fixed grid per tile". The grid
 * spacing is the tile's Mercator width / terrain.meshSize, and in a pitched view coarser-zoom
 * tiles are used the farther away the view is, so it varies from place to place.
 *
 * Unless our own subdivision matches that grid exactly, the fill drops out whichever way it
 * deviates.
 *
 * - When our step is finer than the tile's actual mesh, in concave terrain (valley floors)
 *   MapLibre's coarse chord crosses above the true terrain while our own nodes drop all the
 *   way to the DEM value, so the polygon sinks below the chord and is carved away by depth
 *   (dendritic dropouts)
 * - When it is coarser, in convex terrain (ridges) our own chord dives below the ridge and is
 *   carved away
 *
 * It is not "finer is safer" but "only an exact match is safe".
 *
 * The index is held in cells whose side length is that of the finest tile. A coarse tile spans
 * several cells, but the finest tile's side length is an integer multiple of a coarse tile's
 * mesh spacing, so a cell boundary always lies on one of that tile's mesh lines. In other
 * words, cutting at cell boundaries only adds nodes; it never creates a seam (a T-junction).
 */

import type { RenderableTerrainTile } from './detect.js';
import type { MercatorRect, TessellationTiling } from './tessellation.js';

/** Upper bound on the number of cells in the index (no index is built for a wider view) */
const MAX_TILING_CELLS = 4096;

/**
 * Builds the index of subdivision steps from the terrain tiles being drawn
 *
 * @param tiles The terrain tiles MapLibre is drawing
 * @param meshSize The number of subdivisions of one tile (terrain.meshSize; 128 by default)
 * @param region The range that may be subdivided (the index covers all of it)
 */
export function buildTessellationTiling(
  tiles: readonly RenderableTerrainTile[],
  meshSize: number,
  region: MercatorRect | null,
): TessellationTiling | null {
  if (tiles.length === 0 || !(meshSize > 0)) return null;

  let maxZoom = 0;
  for (const tile of tiles) {
    if (tile.z > maxZoom) maxZoom = tile.z;
  }
  const cell = 1 / 2 ** maxZoom;
  if (!(cell > 0)) return null;

  // The index covers all of "the range that may be subdivided". A cell with no tile gets a
  // step of 0, and that area is emitted as is without being subdivided (outside the range the
  // elevation is clamped to the edge value, so there is no point in subdividing).
  //
  // The index must not be trimmed to the bounding box of the tiles. Doing so drops the part of
  // the range that falls outside the index, and the fill of that ground disappears entirely
  // (hit while implementing this).
  let minX: number;
  let minY: number;
  let maxX: number;
  let maxY: number;
  if (region) {
    minX = region.x0;
    minY = region.y0;
    maxX = region.x1;
    maxY = region.y1;
  } else {
    minX = Number.POSITIVE_INFINITY;
    minY = Number.POSITIVE_INFINITY;
    maxX = Number.NEGATIVE_INFINITY;
    maxY = Number.NEGATIVE_INFINITY;
    for (const tile of tiles) {
      const size = 1 / 2 ** tile.z;
      const x0 = tile.x * size;
      const y0 = tile.y * size;
      if (x0 < minX) minX = x0;
      if (y0 < minY) minY = y0;
      if (x0 + size > maxX) maxX = x0 + size;
      if (y0 + size > maxY) maxY = y0 + size;
    }
  }
  if (!(maxX > minX) || !(maxY > minY)) return null;

  const x0 = Math.floor(minX / cell) * cell;
  const y0 = Math.floor(minY / cell) * cell;
  const cols = Math.ceil((maxX - x0) / cell);
  const rows = Math.ceil((maxY - y0) / cell);
  if (cols <= 0 || rows <= 0) return null;
  // When there are too many cells (an unexpectedly wide spread) no index is built. Without an
  // index the subdivision falls back to a single step as before (a picture is still produced)
  if (cols * rows > MAX_TILING_CELLS) return null;

  const grids = new Float64Array(cols * rows);
  // Coarse tiles are placed first and finer tiles overwrite them (same as how the atlas is
  // baked)
  const ordered = [...tiles].sort((a, b) => a.z - b.z);
  for (const tile of ordered) {
    const size = 1 / 2 ** tile.z;
    const grid = size / meshSize;
    const tx0 = tile.x * size;
    const ty0 = tile.y * size;
    const ix0 = Math.max(0, Math.floor((tx0 - x0) / cell));
    const iy0 = Math.max(0, Math.floor((ty0 - y0) / cell));
    const ix1 = Math.min(cols - 1, Math.ceil((tx0 + size - x0) / cell) - 1);
    const iy1 = Math.min(rows - 1, Math.ceil((ty0 + size - y0) / cell) - 1);
    for (let iy = iy0; iy <= iy1; iy++) {
      for (let ix = ix0; ix <= ix1; ix++) {
        grids[iy * cols + ix] = grid;
      }
    }
  }

  return {
    rect: { x0, y0, x1: x0 + cols * cell, y1: y0 + rows * cell },
    cell,
    cols,
    rows,
    grids,
  };
}

/**
 * Fingerprint of the tile configuration covering a given rectangle
 *
 * This is the key for deciding "whether the subdivision of that range is still correct". With
 * the same fingerprint there is no need to subdivide again; with a different one there is. It
 * includes the following three things.
 *
 * - The base step (which changes when the zoom changes) and the step of each index cell that
 *   overlaps the rectangle (the tile zoom configuration itself). Both are written as absolute
 *   values
 * - The coarsening factor (the power of 2 applied to the step)
 * - Whether the rectangle sticks out of the range that may be subdivided (the part that sticks
 *   out is not subdivided, so once the range moves and "ground that has not been subdivided
 *   yet" comes in, it has to be subdivided again)
 *
 * Moving the camera changes the zoom of the tiles used for the distance. Even when the
 * geometry is correct, a polygon left "subdivided with the step of the old configuration"
 * makes the old chord disagree with the new mesh, producing spotty breakthroughs and seams on
 * ridges and in valleys. This is what is behind the observation that it looks clean right
 * after a reload but falls apart once you pan or zoom to the spot.
 */
export function tilingSignature(
  tiling: TessellationTiling | null,
  region: MercatorRect | null,
  coarsen: number,
  baseGrid: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): string {
  // The step is 1/(2^z * meshSize), so its log2 is always an integer. It is written as an
  // absolute value.
  //
  // This must not be written as "the difference from the finest tile in the view". Moving the
  // zoom by one level moves both the tile's z and the finest z together, so the difference
  // stays the same and it is judged "unchanged" even though the step actually changed by a
  // factor of 2. A chunk left with the old step is never subdivided again, and streaky
  // breakthroughs remain on ridges and in valleys.
  const exponent = (grid: number): string => (grid > 0 ? String(Math.round(Math.log2(grid))) : '-');

  // The step itself is part of the key too (so that a zoom change is caught even on the path
  // without an index)
  const parts: string[] = [`${exponent(baseGrid)}:${coarsen}`];
  if (!tiling) return parts.join('|');

  const inside =
    !region || (x0 >= region.x0 && x1 <= region.x1 && y0 >= region.y0 && y1 <= region.y1);
  parts.push(inside ? 'i' : 'o');
  if (!inside && region) {
    // Something straddling the range also depends on the range itself (the cut changes)
    parts.push(`${region.x0},${region.y0},${region.x1},${region.y1}`);
  }

  const ix0 = Math.max(0, Math.floor((x0 - tiling.rect.x0) / tiling.cell));
  const ix1 = Math.min(tiling.cols - 1, Math.floor((x1 - tiling.rect.x0) / tiling.cell));
  const iy0 = Math.max(0, Math.floor((y0 - tiling.rect.y0) / tiling.cell));
  const iy1 = Math.min(tiling.rows - 1, Math.floor((y1 - tiling.rect.y0) / tiling.cell));
  if (ix1 < ix0 || iy1 < iy0) return parts.join('|');

  // The step of each cell. The origin of the index is rounded to the finest tile's boundary,
  // so the same ground always falls into the same cell (the indices do not shift when the
  // range moves)
  for (let iy = iy0; iy <= iy1; iy++) {
    for (let ix = ix0; ix <= ix1; ix++) {
      parts.push(exponent(tiling.grids[iy * tiling.cols + ix]));
    }
  }
  return parts.join('|');
}
