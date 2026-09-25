// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The subdivision of the geometry on the globe
 *
 * On the globe the vertex shaders project each vertex onto the sphere, and the GPU joins two
 * vertices with a straight line in space: a chord through the sphere, not the path maplibre
 * draws its own layers along (the straight line of the Mercator plane carried onto the sphere,
 * `shared/math/globe-subdivision.ts`). So the geometry is cut finely on the Mercator plane
 * before it is projected, as maplibre cuts its own:
 *
 * - Fills and their outlines are cut on the CPU, through the same subdivision as the terrain
 *   (`terrain/tessellation.ts`), with the cell of maplibre's fill granularity. The terrain
 *   takes precedence: while it gives a step, the globe adds nothing
 * - Lines are cut on the GPU, by the stations of the line shader (`resolveLineStations`),
 *   with the cell of maplibre's line granularity; the stations move along the Mercator plane
 * - The other paths drawn on the CPU (the dashes, the selection outlines) are cut with the
 *   line cell
 *
 * On a flat map nothing here is used and the geometry is exactly what it was.
 */

import {
  densifyOnMercatorPlane,
  type GlobeSubdivisionKind,
  globeSubdivisionGrid,
} from '../shared/math/globe-subdivision.js';
import type { Coordinate } from '../store/types.js';
import type { GlobeGrids, TerrainContext } from './terrain/context.js';
import { getTerrainTessellationStep, tessellatePolygonFill } from './terrain/polygon.js';
import { mercatorX, mercatorY, type TessellationStep } from './terrain/tessellation.js';

/**
 * The most points the globe adds to one fill or one path
 *
 * At the coarsest zoom a cell is 1/128 of the world for fills, so even a fill as large as the
 * world is cut into about 16,000 cells. The limit only guards against a runaway; the fill
 * subdivision coarsens the cell rather than stopping halfway when it is reached.
 */
export const GLOBE_MAX_SUBDIVISION_POINTS = 65_536;

/**
 * Records the cells the globe asks for in this frame
 *
 * The globe is drawn while maplibre's projection transition is above 0 (it falls to 0 as a
 * globe map zooms in past its switch to Mercator). The generation advances when the globe
 * starts or stops being drawn and when a cell changes, which happens only when the zoom
 * crosses an integer.
 *
 * @param context The terrain state of the draw instance
 * @param transition `projectionTransition` of the frame's projection data (0 = Mercator)
 * @param zoom The zoom of the camera
 */
export function updateGlobeSubdivision(
  context: TerrainContext,
  transition: number,
  zoom: number,
): void {
  const next: GlobeGrids | null =
    transition > 0
      ? { fill: globeSubdivisionGrid(zoom, 'fill'), line: globeSubdivisionGrid(zoom, 'line') }
      : null;
  const previous = context.globeGrids;
  if (previous?.fill === next?.fill && previous?.line === next?.line) return;
  context.globeGrids = next;
  context.globeGeneration++;
}

/**
 * The cell of the globe for a kind of geometry, in Mercator world units (0 on a flat map)
 */
export function globeGridOf(context: TerrainContext, kind: GlobeSubdivisionKind): number {
  return context.globeGrids?.[kind] ?? 0;
}

/**
 * The subdivision step of the globe (null on a flat map)
 */
export function getGlobeTessellationStep(
  context: TerrainContext,
  kind: GlobeSubdivisionKind,
): TessellationStep | null {
  const grid = globeGridOf(context, kind);
  if (!(grid > 0)) return null;
  return { grid, maxPoints: GLOBE_MAX_SUBDIVISION_POINTS, region: null };
}

/**
 * The subdivision step of the surface in this frame: the terrain's when the terrain is drawn,
 * the globe's otherwise, and null on a flat map without terrain
 *
 * @param context The terrain state of the draw instance
 * @param kind Which cell of the globe applies (the terrain has one step for everything)
 */
export function getSurfaceTessellationStep(
  context: TerrainContext,
  kind: GlobeSubdivisionKind,
): TessellationStep | null {
  return getTerrainTessellationStep(context) ?? getGlobeTessellationStep(context, kind);
}

/**
 * Subdivides the fill of one feature with the step of the surface
 *
 * The terrain's step goes to `tessellatePolygonFill` as before. With the globe's, a fill that
 * lies inside one cell is left as it is: nothing in it crosses a cell, and most features of a
 * large dataset are that small at the zooms the globe is seen at.
 */
export function tessellateSurfaceFill(
  context: TerrainContext,
  featureId: string | undefined,
  partIndex: number,
  flatCoords: number[],
  indices: number[],
  step: TessellationStep,
): { flatCoords: number[]; indices: number[]; step: TessellationStep } {
  if (!getTerrainTessellationStep(context) && withinOneCell(flatCoords, step.grid)) {
    return { flatCoords, indices, step };
  }
  return tessellatePolygonFill(context, featureId, partIndex, flatCoords, indices, step);
}

/**
 * Whether the bounding box of a flat coordinate array lies inside one cell of the grid
 */
function withinOneCell(flatCoords: readonly number[], grid: number): boolean {
  if (flatCoords.length < 2) return true;
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
  return (
    Math.floor(mercatorX(minLng) / grid) === Math.floor(mercatorX(maxLng) / grid) &&
    Math.floor(mercatorY(maxLat) / grid) === Math.floor(mercatorY(minLat) / grid)
  );
}

/**
 * Cuts a path drawn on the CPU along the Mercator plane with the line cell of the globe
 *
 * The path itself is returned on a flat map, and when no edge is longer than a cell.
 */
export function densifyPathForGlobe(context: TerrainContext, path: Coordinate[]): Coordinate[] {
  const grid = globeGridOf(context, 'line');
  if (!(grid > 0)) return path;
  return densifyOnMercatorPlane(path, grid, GLOBE_MAX_SUBDIVISION_POINTS);
}
