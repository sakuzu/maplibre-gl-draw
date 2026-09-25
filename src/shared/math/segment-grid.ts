// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Segment grid index
 *
 * A static uniform grid index over a coordinate array (one polyline, or one ring).
 * On geometries with a hundred thousand vertices it reduces hit testing, which would
 * otherwise scan every segment (O(N)), to computing only the candidate segments in the
 * cells that overlap the tolerance box.
 *
 * This module is for internal use within the package and is not exposed in the public API.
 * Hit testing (dispatcher/hit-test/segment-grid.ts measures distances through it) and the
 * bbox-limited enumeration of the snapping providers and the tracing both use it, so it sits
 * in shared/.
 *
 * Assumption: coordinate arrays are never rewritten in place (updating coordinates in the
 * Store follows the immutable update convention of replacing the array with a new one,
 * both in the memory implementation of core and in external store implementations).
 * Therefore the index stays valid as long as the array reference is the same, and when the
 * coordinates change the key of the WeakMap changes, so the index is naturally rebuilt and
 * the old index is reclaimed by the GC.
 * For that reason there is no invalidation logic.
 */

import type { BoundingBox, Coordinate } from '../types/model.js';

/**
 * Vertex count threshold above which the index is built
 *
 * Below it a full scan is faster (the cost of building the index outweighs the gain).
 */
export const SEGMENT_INDEX_THRESHOLD = 1024;

/** Lower bound of the cell width and height (guards against division by zero when the
 * bbox is degenerate) */
const CELL_EPS = 1e-12;

/**
 * Segment grid index
 */
export interface SegmentGrid {
  /** The bbox covered by the index */
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
  /** Column count and row count */
  readonly cols: number;
  readonly rows: number;
  /** Cell width and height (at least CELL_EPS) */
  readonly cellW: number;
  readonly cellH: number;
  /** The segment start indices of each cell. An empty cell is undefined */
  readonly cells: (number[] | undefined)[];
  /** Segment count (= coords.length - 1, never negative) */
  readonly segmentCount: number;
  /** Visit stamps (they avoid computing the same segment twice within one query) */
  readonly visited: Uint32Array;
  /** Generation counter of the visit stamps */
  generation: number;
}

/** Module-level index cache (the key is the reference of the coordinate array) */
const gridCache = new WeakMap<Coordinate[], SegmentGrid>();

/**
 * Builds the segment grid index
 */
export function buildSegmentGrid(coords: Coordinate[]): SegmentGrid {
  const segmentCount = Math.max(coords.length - 1, 0);

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  // Put only the vertices that make up a segment into the bbox (a trailing isolated point
  // is ignored)
  const vertexCount = segmentCount === 0 ? 0 : segmentCount + 1;
  for (let i = 0; i < vertexCount; i++) {
    const [x, y] = coords[i];
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }

  const cols = segmentCount === 0 ? 1 : Math.ceil(Math.sqrt(segmentCount));
  const rows = cols;
  const cellW = Math.max((maxX - minX) / cols, CELL_EPS);
  const cellH = Math.max((maxY - minY) / rows, CELL_EPS);

  const grid: SegmentGrid = {
    minX,
    minY,
    maxX,
    maxY,
    cols,
    rows,
    cellW,
    cellH,
    cells: new Array<number[] | undefined>(cols * rows),
    segmentCount,
    visited: new Uint32Array(segmentCount),
    generation: 0,
  };

  // Register each segment in every cell its bbox overlaps
  for (let i = 0; i < segmentCount; i++) {
    const [ax, ay] = coords[i];
    const [bx, by] = coords[i + 1];
    const col0 = cellIndex(Math.min(ax, bx) - grid.minX, grid.cellW, cols);
    const col1 = cellIndex(Math.max(ax, bx) - grid.minX, grid.cellW, cols);
    const row0 = cellIndex(Math.min(ay, by) - grid.minY, grid.cellH, rows);
    const row1 = cellIndex(Math.max(ay, by) - grid.minY, grid.cellH, rows);

    for (let row = row0; row <= row1; row++) {
      const rowOffset = row * cols;
      for (let col = col0; col <= col1; col++) {
        const cell = grid.cells[rowOffset + col];
        if (cell) {
          cell.push(i);
        } else {
          grid.cells[rowOffset + col] = [i];
        }
      }
    }
  }

  return grid;
}

/**
 * Gets the index for a coordinate array (building and caching it when there is none)
 */
export function getSegmentGrid(coords: Coordinate[]): SegmentGrid {
  const cached = gridCache.get(coords);
  if (cached) return cached;

  const grid = buildSegmentGrid(coords);
  gridCache.set(coords, grid);
  return grid;
}

/**
 * Enumerates, through the index, the indices of the segments that touch a bbox
 *
 * Nothing is missed (every segment whose segment bbox overlaps the query bbox is always
 * included). Since the cells are held as boxes it may return more than necessary, so the
 * strict test is left to the caller. The return value is sorted in ascending order to make
 * the enumeration order deterministic.
 */
export function querySegmentIndicesInBBox(grid: SegmentGrid, bbox: BoundingBox): number[] {
  if (grid.segmentCount === 0) return [];

  // If the query box does not intersect the bbox of the index, there is no candidate
  if (
    bbox.maxX < grid.minX ||
    bbox.minX > grid.maxX ||
    bbox.maxY < grid.minY ||
    bbox.minY > grid.maxY
  ) {
    return [];
  }

  const col0 = cellIndex(bbox.minX - grid.minX, grid.cellW, grid.cols);
  const col1 = cellIndex(bbox.maxX - grid.minX, grid.cellW, grid.cols);
  const row0 = cellIndex(bbox.minY - grid.minY, grid.cellH, grid.rows);
  const row1 = cellIndex(bbox.maxY - grid.minY, grid.cellH, grid.rows);

  const stamp = nextGeneration(grid);
  const indices: number[] = [];

  for (let row = row0; row <= row1; row++) {
    const rowOffset = row * grid.cols;
    for (let col = col0; col <= col1; col++) {
      const cell = grid.cells[rowOffset + col];
      if (!cell) continue;

      for (const i of cell) {
        // A segment is registered in several cells, so pick it up only once per query
        if (grid.visited[i] === stamp) continue;
        grid.visited[i] = stamp;
        indices.push(i);
      }
    }
  }

  indices.sort((a, b) => a - b);
  return indices;
}

/**
 * Finds the cell index from a coordinate offset (clamping it into range)
 *
 * @internal
 */
export function cellIndex(offset: number, cellSize: number, count: number): number {
  const index = Math.floor(offset / cellSize);
  if (index < 0) return 0;
  if (index >= count) return count - 1;
  return index;
}

/**
 * Advances the generation of the visit stamps
 *
 * When the upper limit of the Uint32Array is reached, the stamps are cleared all at once
 * and the counter wraps back around.
 *
 * @internal
 */
export function nextGeneration(grid: SegmentGrid): number {
  if (grid.generation >= 0xffffffff) {
    grid.visited.fill(0);
    grid.generation = 0;
  }
  grid.generation += 1;
  return grid.generation;
}
