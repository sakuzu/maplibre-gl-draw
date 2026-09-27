// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The injection point for terrain subdivision of polygons
 *
 * Called from the polygon renderers (polygon/sdf-polygon.ts and polygon/batch.ts). When the
 * terrain is disabled, `terrainTessellationStep(context)` returns null and the caller does
 * nothing. Rendering without terrain therefore does not change by a single byte.
 */

import type { Coordinate } from '../../store/types.js';
import type { TerrainContext } from './context.js';
import {
  TERRAIN_MAX_BATCH_SUBDIVISION_CELLS,
  TERRAIN_MAX_COARSEN_STEPS,
  TERRAIN_MAX_SUBDIVISION_POINTS,
  TERRAIN_MAX_TILED_SUBDIVISION_POINTS,
} from './metrics.js';
import { getTerrainRenderState } from './state.js';
import {
  cellsInRegion,
  densifyRings,
  type MercatorRect,
  mercatorX,
  mercatorY,
  rectsIntersect,
  subdivideTriangles,
  type TessellatedFill,
  type TessellationStep,
} from './tessellation.js';
import { tilingSignature } from './tiling.js';

/**
 * Returns the subdivision step of the terrain mesh for the current frame.
 *
 * @param context The terrain state of the draw instance
 * @returns The step, or `null` when the terrain is disabled
 */
export function terrainTessellationStep(context: TerrainContext): TessellationStep | null {
  const terrain = getTerrainRenderState(context);
  if (!terrain.active || !(terrain.stepGrid > 0)) return null;
  const tiling = terrain.tessellationTiling;
  return {
    grid: terrain.stepGrid,
    // When subdividing to match the tile's actual mesh, the amount is capped by the view, so
    // the upper bound is set high (falling back to coarsening midway makes the fill drop out
    // on ridges)
    maxPoints: tiling ? TERRAIN_MAX_TILED_SUBDIVISION_POINTS : TERRAIN_MAX_SUBDIVISION_POINTS,
    region: terrain.tessellationRegion,
    tiling,
  };
}

/**
 * Decides the effective step for a single feature
 *
 * The step is decided by the screen (the zoom), but for a large feature the grid can reach
 * hundreds of thousands of cells. Cutting off once the upper bound is reached produces the
 * distorted result "only the first triangles are fine and the rest stay coarse", and only part
 * of the polygon sits on the terrain. So instead of cutting off, the step is coarsened by a
 * power of 2 and the whole feature is subdivided uniformly. It is a power of 2 so that the
 * coarse grid is a subset of the fine grid (the fill and the outline are subdivided at the
 * same points).
 */
export function polygonTessellationStep(
  base: TessellationStep,
  flatCoords: readonly number[],
): TessellationStep {
  // When subdividing to match the tile's actual mesh, no coarsening is applied. Coarsening
  // would make the step coarser than the tile's mesh, and our own chord would dive below the
  // ridge and be carved away. The amount is capped by the number of tiles, so no brake is
  // needed in the first place.
  if (base.tiling) return base;

  const cells = boundingCells(flatCoords, base.grid, base.region);
  if (!(cells > base.maxPoints)) return base;

  // Coarsened by a power of 2 (the coarse grid still lies on a subset of the terrain mesh
  // nodes)
  const factor = 2 ** Math.ceil(Math.log2(Math.sqrt(cells / base.maxPoints)));
  return coarsen(base, factor);
}

/**
 * The number of grid cells the bounding box covers (an estimate, from a flat coordinate array)
 *
 * Outside the range (region) nothing is subdivided, so that part is not counted.
 */
export function boundingCells(
  flatCoords: readonly number[],
  grid: number,
  region?: MercatorRect | null,
): number {
  if (flatCoords.length < 2 || !(grid > 0)) return 0;

  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < flatCoords.length; i += 2) {
    const x = flatCoords[i];
    const y = flatCoords[i + 1];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return cellsFromBounds(minX, maxX, minY, maxY, grid, region);
}

/**
 * The number of grid cells the bounding box covers (an estimate, from rings)
 *
 * Every feature is scanned in order to estimate the total amount of the batch, so the count is
 * made without building an array for flattening.
 */
export function ringBoundingCells(
  ring: readonly Coordinate[],
  grid: number,
  region?: MercatorRect | null,
): number {
  if (ring.length === 0 || !(grid > 0)) return 0;

  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const [x, y] of ring) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return cellsFromBounds(minX, maxX, minY, maxY, grid, region);
}

/**
 * The fingerprint of the conditions that decide this feature's subdivision
 *
 * It is decided by the tile configuration covering it (which cell has which step), the
 * coarsening factor and the relationship with the range. The elevation is not included,
 * because the shader looks the elevation up every frame, so there is no need to subdivide
 * again when the DEM arrives.
 */
function fillSignature(step: TessellationStep, flatCoords: readonly number[]): string {
  if (flatCoords.length < 2) return 'empty';

  let minLng = Number.POSITIVE_INFINITY;
  let maxLng = Number.NEGATIVE_INFINITY;
  let minLat = Number.POSITIVE_INFINITY;
  let maxLat = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < flatCoords.length; i += 2) {
    const lng = flatCoords[i];
    const lat = flatCoords[i + 1];
    if (lng < minLng) minLng = lng;
    if (lng > maxLng) maxLng = lng;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  }

  return tilingSignature(
    step.tiling ?? null,
    step.region ?? null,
    step.coarsen && step.coarsen > 1 ? step.coarsen : 1,
    step.grid,
    mercatorX(minLng),
    // Mercator y decreases as the latitude increases
    mercatorY(maxLat),
    mercatorX(maxLng),
    mercatorY(minLat),
  );
}

/**
 * Whether the bounding box of a flat coordinate array intersects the range
 */
export function flatCoordsIntersect(flatCoords: readonly number[], region: MercatorRect): boolean {
  if (flatCoords.length < 2) return false;

  let minLng = Number.POSITIVE_INFINITY;
  let maxLng = Number.NEGATIVE_INFINITY;
  let minLat = Number.POSITIVE_INFINITY;
  let maxLat = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < flatCoords.length; i += 2) {
    const lng = flatCoords[i];
    const lat = flatCoords[i + 1];
    if (lng < minLng) minLng = lng;
    if (lng > maxLng) maxLng = lng;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  }
  // Mercator y decreases as the latitude increases
  return rectsIntersect(
    mercatorX(minLng),
    mercatorY(maxLat),
    mercatorX(maxLng),
    mercatorY(minLat),
    region,
  );
}

/**
 * Whether the bounding box of an array of rings intersects the range
 */
export function ringsIntersect(rings: readonly Coordinate[][], region: MercatorRect): boolean {
  let minLng = Number.POSITIVE_INFINITY;
  let maxLng = Number.NEGATIVE_INFINITY;
  let minLat = Number.POSITIVE_INFINITY;
  let maxLat = Number.NEGATIVE_INFINITY;
  for (const ring of rings) {
    for (const [lng, lat] of ring) {
      if (lng < minLng) minLng = lng;
      if (lng > maxLng) maxLng = lng;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
    }
  }
  if (minLng > maxLng) return false;
  return rectsIntersect(
    mercatorX(minLng),
    mercatorY(maxLat),
    mercatorX(maxLng),
    mercatorY(minLat),
    region,
  );
}

/**
 * Converts a longitude/latitude bounding box into a number of Mercator cells (an estimate is
 * enough)
 */
function cellsFromBounds(
  minX: number,
  maxX: number,
  minY: number,
  maxY: number,
  grid: number,
  region?: MercatorRect | null,
): number {
  // Mercator y decreases as the latitude increases, so top and bottom are swapped
  return cellsInRegion(
    mercatorX(minX),
    mercatorY(maxY),
    mercatorX(maxX),
    mercatorY(minY),
    grid,
    region,
  );
}

/**
 * Coarsens the step by a power of 2
 */
function coarsen(step: TessellationStep, factor: number): TessellationStep {
  if (!(factor > 1)) return step;
  if (step.tiling) {
    // When matching the tile's actual mesh, the factor is raised rather than the step
    // (being a power of 2, the subdivision points keep lying on a subset of the nodes)
    return { ...step, coarsen: (step.coarsen ?? 1) * factor };
  }
  return { grid: step.grid * factor, maxPoints: step.maxPoints, region: step.region };
}

/**
 * Decides the coarsening factor applied to the whole batch (a power of 2)
 *
 * A per-feature upper bound cannot hold back a batch with thousands of features (a
 * dataset). The total number of cells is estimated before construction, and if
 * it exceeds the budget the whole batch is coarsened uniformly. Applying a different factor
 * per feature would put neighboring features on different grids and make them disagree at the
 * boundary, so there is one factor per batch.
 *
 * @param totalCells The sum of the bounding box cell counts of all features
 */
export function batchTessellationFactor(totalCells: number): number {
  if (!(totalCells > TERRAIN_MAX_BATCH_SUBDIVISION_CELLS)) return 1;
  const steps = Math.ceil(Math.log2(Math.sqrt(totalCells / TERRAIN_MAX_BATCH_SUBDIVISION_CELLS)));
  return 2 ** Math.min(steps, TERRAIN_MAX_COARSEN_STEPS);
}

/**
 * Subdivides the fill of a single feature and returns the step actually used
 *
 * When the step was too fine to finish subdividing (the vertex budget ran out, or a single
 * triangle sweeps too many cells), emitting it as is produces a mixture where "part of it
 * follows the terrain while the rest are flat triangles breaking through the terrain". This is
 * what is behind the wedge-shaped breakage sticking out of the terrain, so it is coarsened and
 * subdivided again. Subdividing the outline with the returned step as well guarantees that the
 * fill and the outline lie on the same grid.
 *
 * @returns The subdivision result and the step that produced it
 */
export function tessellatePolygonFill(
  context: TerrainContext,
  featureId: string | undefined,
  partIndex: number,
  flatCoords: number[],
  indices: number[],
  base: TessellationStep,
): { flatCoords: number[]; indices: number[]; step: TessellationStep } {
  // Features outside the range are left alone. Since it is already decided that they will not
  // be subdivided, even building the vertex pool (registering every coordinate into a Map) is
  // expensive. With 8,172 administrative boundaries and 1.1 million vertices in total, this
  // early exit decides most of the construction time (measured: 3.9 s -> 0.5 s).
  if (base.region && !flatCoordsIntersect(flatCoords, base.region)) {
    return { flatCoords, indices, step: base };
  }

  // The subdivision cache belongs to the draw instance whose context is passed. Back when it
  // was shared globally, triangles subdivided with a different step were returned whenever
  // the generation happened to coincide with another instance's.
  const fillCache = context.fillCache;
  // The fingerprint of the conditions that decide this feature's subdivision (the covering
  // tile configuration, the coarsening and the relationship with the range). As long as the
  // conditions are the same it can be reused even when the range moves or a chunk is re-baked
  const signature = fillSignature(base, flatCoords);

  if (featureId) {
    const cached = fillCache.get(featureId, partIndex, signature, indices);
    if (cached) {
      return {
        flatCoords: cached.flatCoords,
        indices: cached.indices,
        step: {
          grid: cached.grid,
          maxPoints: base.maxPoints,
          region: base.region,
          tiling: cached.grid === base.grid ? base.tiling : null,
        },
      };
    }
  }

  let step = polygonTessellationStep(base, flatCoords);
  let result: TessellatedFill = subdivideTriangles(flatCoords, indices, step);
  let coarsened = 0;
  while (result.overflowed && coarsened < TERRAIN_MAX_COARSEN_STEPS) {
    // The required factor is derived from the amount of the overflow, rounded up to a power
    // of 2 and applied in one go (trying factor 2 at a time would mean redoing it up to the
    // upper bound every time for a huge feature)
    const wanted = Math.max(2, 2 ** Math.ceil(Math.log2(result.overflowFactor)));
    const remaining = 2 ** (TERRAIN_MAX_COARSEN_STEPS - coarsened);
    const factor = Math.min(wanted, remaining);
    coarsened += Math.round(Math.log2(factor));
    step = coarsen(step, factor);
    result = subdivideTriangles(flatCoords, indices, step);
  }

  if (featureId) {
    fillCache.set(
      featureId,
      partIndex,
      signature,
      indices,
      result.flatCoords,
      result.indices,
      step.grid,
    );
  }
  return { flatCoords: result.flatCoords, indices: result.indices, step };
}

/**
 * Subdivides the rings of the outline
 *
 * It uses the same grid as the fill, so the edge of the fill and the vertices of the outline
 * still agree after subdivision.
 */
export function tessellateRings(rings: Coordinate[][], step: TessellationStep): Coordinate[][] {
  // Outside the range nothing is subdivided (the same test as the fill; if the two disagree
  // they drift apart)
  if (step.region && !ringsIntersect(rings, step.region)) return rings;
  // The coarsening applied to the fill is applied to the outline too. Forgetting it would
  // subdivide only the outline on the finest grid and make the number of points jump (both
  // construction and rendering get heavier)
  const coarsen = step.coarsen && step.coarsen > 1 ? step.coarsen : 1;
  return densifyRings(rings, coarsen > 1 ? { ...step, grid: step.grid * coarsen } : step);
}
