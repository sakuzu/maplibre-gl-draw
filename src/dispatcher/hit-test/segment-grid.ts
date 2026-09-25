// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Distance queries of hit testing through the segment grid index
 *
 * The grid itself (shared/math/segment-grid.ts) is a plain index over a coordinate array.
 * The distances here are measured in the local frame of hit testing (local-frame.ts).
 */

import {
  cellIndex,
  getSegmentGrid,
  nextGeneration,
  SEGMENT_INDEX_THRESHOLD,
  type SegmentGrid,
} from '../../shared/math/segment-grid.js';
import type { Coordinate } from '../../store/types.js';
import { localPointToPolylineDistance, localPointToSegmentDistance } from './local-frame.js';

// The grid is defined in shared/ (the snapping providers use it too); re-exported here for
// the existing imports
export type { SegmentGrid } from '../../shared/math/segment-grid.js';
export {
  buildSegmentGrid,
  getSegmentGrid,
  querySegmentIndicesInBBox,
  SEGMENT_INDEX_THRESHOLD,
} from '../../shared/math/segment-grid.js';

/**
 * Finds the shortest distance within the tolerance through the index
 *
 * The distance is measured in the local frame of hit testing (local-frame.ts): degrees of
 * longitude, with latitude differences divided by latScale. A latScale of 1 is plain degree
 * space.
 *
 * @param latScale latitudeScale of the click latitude
 * @returns The distance if within the tolerance, null if outside
 */
export function queryDistanceWithin(
  grid: SegmentGrid,
  coords: Coordinate[],
  point: Coordinate,
  tolerance: number,
  latScale = 1,
): number | null {
  if (grid.segmentCount === 0) return null;

  const [px, py] = point;
  // A latitude difference within the tolerance is at most tolerance * latScale
  const queryMinX = px - tolerance;
  const queryMinY = py - tolerance * latScale;
  const queryMaxX = px + tolerance;
  const queryMaxY = py + tolerance * latScale;

  // If the tolerance box does not intersect the bbox, there is no candidate
  if (
    queryMaxX < grid.minX ||
    queryMinX > grid.maxX ||
    queryMaxY < grid.minY ||
    queryMinY > grid.maxY
  ) {
    return null;
  }

  const col0 = cellIndex(queryMinX - grid.minX, grid.cellW, grid.cols);
  const col1 = cellIndex(queryMaxX - grid.minX, grid.cellW, grid.cols);
  const row0 = cellIndex(queryMinY - grid.minY, grid.cellH, grid.rows);
  const row1 = cellIndex(queryMaxY - grid.minY, grid.cellH, grid.rows);

  const stamp = nextGeneration(grid);
  let minDistance = Number.POSITIVE_INFINITY;

  for (let row = row0; row <= row1; row++) {
    const rowOffset = row * grid.cols;
    for (let col = col0; col <= col1; col++) {
      const cell = grid.cells[rowOffset + col];
      if (!cell) continue;

      for (const i of cell) {
        // A segment is registered in several cells, so compute it only once per query
        if (grid.visited[i] === stamp) continue;
        grid.visited[i] = stamp;

        const distance = localPointToSegmentDistance(point, coords[i], coords[i + 1], latScale);
        if (distance < minDistance) minDistance = distance;
      }
    }
  }

  return minDistance <= tolerance ? minDistance : null;
}

/**
 * The shortest distance to a polyline (or a ring) within the tolerance
 *
 * When the vertex count is below the threshold it scans everything, and at or above it
 * uses the index. Both go through localPointToSegmentDistance, so the distance values match
 * exactly.
 *
 * @param latScale latitudeScale of the click latitude (1 is plain degree space)
 * @returns The distance if within the tolerance, null if outside
 */
export function polylineDistanceWithin(
  coords: Coordinate[],
  point: Coordinate,
  tolerance: number,
  latScale = 1,
): number | null {
  if (coords.length < SEGMENT_INDEX_THRESHOLD) {
    const distance = localPointToPolylineDistance(point, coords, latScale);
    return distance <= tolerance ? distance : null;
  }

  return queryDistanceWithin(getSegmentGrid(coords), coords, point, tolerance, latScale);
}
