// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Performance suite (the device that decides whether to adopt GEOS)
 *
 * This is the performance side of the decision device in section 13 of the design
 * document. It measures the scale criterion, "10,000 items in a dataset", with
 * the fusion of a mesh, the intersection of a mesh with a polygon, and the buffer
 * of a line with a high vertex count.
 *
 * The purpose is to record measured values, and the thresholds are set at 3 times
 * the design values to absorb CI variation. Measured values are written to the
 * console. The item count and the preservation of area are verified as well, so
 * that a result that is merely fast but broken does not pass.
 *
 * The data is generated deterministically (no random numbers), so every run takes
 * the same input and produces the same result.
 */

import { describe, expect, it } from 'vitest';
import { intersection, unionAll } from './boolean.js';
import { buffer } from './buffer.js';
import { toMultiPolygonCoordinates } from './coords.js';
import { signedRingArea } from './simplify.js';
import type {
  AreaCoordinates,
  Coordinate,
  MultiPolygonCoordinates,
  PolygonCoordinates,
} from './types.js';

// ---------------------------------------------------------------------------
// Thresholds (3 times the design values)
// ---------------------------------------------------------------------------

/** Fusion of 10,000 mesh cells. Design value 3 seconds */
const UNION_ALL_LIMIT_MS = 9_000;

/** Intersection of 10,000 mesh cells with 1 polygon. Design value 5 seconds */
const INTERSECTION_LIMIT_MS = 15_000;

/** Buffer of a line with 1,000 vertices. Design value 1 second */
const BUFFER_LIMIT_MS = 3_000;

/** Timeout for each test */
const TEST_TIMEOUT_MS = 30_000;

/** Number of columns and rows in the mesh (100 x 100 = 10,000 items) */
const MESH_SIDE = 100;

/** Length of one side of a mesh cell (degrees) */
const MESH_CELL = 0.001;

/** Coordinate of the lower left corner of the mesh */
const MESH_ORIGIN: Coordinate = [139.0, 35.0];

// ---------------------------------------------------------------------------
// Data generation and helpers
// ---------------------------------------------------------------------------

/**
 * Builds a mesh on a square grid
 *
 * The boundary coordinates of adjacent cells are generated from the same
 * expression, so shared edges match exactly.
 */
function createMesh(): PolygonCoordinates[] {
  const cells: PolygonCoordinates[] = [];
  for (let column = 0; column < MESH_SIDE; column++) {
    for (let row = 0; row < MESH_SIDE; row++) {
      const minLng = MESH_ORIGIN[0] + column * MESH_CELL;
      const minLat = MESH_ORIGIN[1] + row * MESH_CELL;
      const maxLng = MESH_ORIGIN[0] + (column + 1) * MESH_CELL;
      const maxLat = MESH_ORIGIN[1] + (row + 1) * MESH_CELL;
      cells.push([
        [
          [minLng, minLat],
          [maxLng, minLat],
          [maxLng, maxLat],
          [minLng, maxLat],
          [minLng, minLat],
        ],
      ]);
    }
  }
  return cells;
}

/**
 * A complex polygon with several hundred vertices (a petal-shaped outline)
 *
 * Its position and size make it fit entirely inside the mesh.
 */
function createComplexPolygon(vertexCount: number): PolygonCoordinates {
  const centerLng = MESH_ORIGIN[0] + (MESH_SIDE * MESH_CELL) / 2;
  const centerLat = MESH_ORIGIN[1] + (MESH_SIDE * MESH_CELL) / 2;
  const ring: Coordinate[] = [];
  for (let i = 0; i < vertexCount; i++) {
    const angle = (i / vertexCount) * Math.PI * 2;
    const radius = 0.03 + 0.008 * Math.sin(angle * 9);
    ring.push([centerLng + radius * Math.cos(angle), centerLat + radius * Math.sin(angle)]);
  }
  ring.push(ring[0]);
  return [ring];
}

/**
 * A deterministic polyline (the vertex count is given)
 */
function createLine(vertexCount: number): Coordinate[] {
  const line: Coordinate[] = [];
  for (let i = 0; i < vertexCount; i++) {
    line.push([139.7 + i * 0.0002, 35.68 + Math.sin(i / 11) * 0.0004]);
  }
  return line;
}

/**
 * Area on the longitude-latitude plane (square degrees; inner rings are subtracted)
 *
 * To verify the preservation of area, use the planar measure that polygon-clipping
 * actually computes on.
 */
function planarArea(coordinates: AreaCoordinates): number {
  let total = 0;
  for (const part of toMultiPolygonCoordinates(coordinates)) {
    for (let index = 0; index < part.length; index++) {
      const area = Math.abs(signedRingArea(part[index]));
      total += index === 0 ? area : -area;
    }
  }
  return total;
}

/** Measures the elapsed time and returns it together with the result */
function measure<T>(label: string, run: () => T): { value: T; elapsedMs: number } {
  const started = performance.now();
  const value = run();
  const elapsedMs = performance.now() - started;
  console.log(`[performance] ${label}: ${elapsedMs.toFixed(0)} ms`);
  return { value, elapsedMs };
}

// ---------------------------------------------------------------------------
// Measurement
// ---------------------------------------------------------------------------

describe('performance: a scale of 10,000 items', () => {
  it(
    'unionAll of 10,000 mesh cells becomes a single polygon within the threshold',
    () => {
      const cells = createMesh();
      expect(cells).toHaveLength(MESH_SIDE * MESH_SIDE);

      const { value: merged, elapsedMs } = measure(`unionAll (${cells.length} mesh cells)`, () =>
        unionAll(cells),
      );

      // No gaps and no holes appear, leaving a rectangle with only one outer ring
      expect(merged).toHaveLength(1);
      expect(merged[0]).toHaveLength(1);

      const total = cells.reduce((sum, cell) => sum + planarArea(cell), 0);
      const mergedArea = planarArea(merged);
      expect(mergedArea).toBeLessThanOrEqual(total * (1 + 1e-9));
      expect(mergedArea).toBeGreaterThanOrEqual(total * (1 - 1e-9));

      expect(elapsedMs).toBeLessThan(UNION_ALL_LIMIT_MS);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'the intersection of 10,000 mesh cells with a complex polygon preserves the area within the threshold',
    () => {
      const cells = createMesh();
      const polygon = createComplexPolygon(300);
      expect(polygon[0]).toHaveLength(301);

      const { value: result, elapsedMs } = measure(
        `intersection (${cells.length} cells x ${polygon[0].length} vertices)`,
        () => {
          let hits = 0;
          let area = 0;
          for (const cell of cells) {
            const clipped = intersection(cell, polygon);
            if (clipped.length > 0) {
              hits++;
              area += planarArea(clipped);
            }
          }
          return { hits, area };
        },
      );

      // The complex polygon fits entirely inside the mesh, so the total intersection
      // area matches the area of the complex polygon itself
      const expected = planarArea(polygon);
      expect(result.hits).toBeGreaterThan(0);
      expect(result.hits).toBeLessThan(cells.length);
      expect(result.area).toBeLessThanOrEqual(expected * (1 + 1e-9));
      expect(result.area).toBeGreaterThanOrEqual(expected * (1 - 1e-9));

      console.log(`[performance] number of intersected cells: ${result.hits} / ${cells.length}`);
      expect(elapsedMs).toBeLessThan(INTERSECTION_LIMIT_MS);
    },
    TEST_TIMEOUT_MS,
  );
});

describe('performance: buffer', () => {
  it(
    'the buffer of a line with 1,000 vertices returns a polygon within the threshold',
    () => {
      const line = createLine(1000);
      expect(line).toHaveLength(1000);

      const { value: result, elapsedMs } = measure('buffer (a line with 1,000 vertices)', () =>
        buffer({ type: 'LineString', coordinates: line }, 50),
      );

      expect(result).not.toBeNull();
      const value = result as MultiPolygonCoordinates;
      expect(value).toHaveLength(1);
      expect(planarArea(value)).toBeGreaterThan(0);

      expect(elapsedMs).toBeLessThan(BUFFER_LIMIT_MS);
    },
    TEST_TIMEOUT_MS,
  );
});
