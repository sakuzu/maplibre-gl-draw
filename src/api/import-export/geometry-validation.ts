// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Validation of feature coordinates at the import boundary
 *
 * Both imports (the native format and GeoJSON) check coordinates with the same rules before
 * anything is written, so that malformed geometry never reaches the store, the spatial index
 * or the renderers. The rules follow docs/reference/data-format.md.
 */

import type { Coordinate } from '../../store/types.js';

/**
 * The nesting depth of the coordinates of each built-in feature type
 * (0 = a single position, 1 = a sequence of positions, and so on).
 * Custom types are accepted at any depth as long as the nesting is regular.
 */
export const COORDINATE_DEPTH: Readonly<Record<string, number>> = {
  Point: 0,
  Image: 0,
  Circle: 0,
  LineString: 1,
  Freehand: 1,
  MultiPoint: 1,
  Polygon: 2,
  MultiLineString: 2,
  MultiPolygon: 3,
};

/** Whether the value is a position of two finite numbers */
function isPosition(value: unknown): value is Coordinate {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    typeof value[0] === 'number' &&
    Number.isFinite(value[0]) &&
    typeof value[1] === 'number' &&
    Number.isFinite(value[1])
  );
}

/**
 * Returns the nesting depth of well-formed coordinates, or -1 when they are malformed
 * (a non-finite number, an empty array or irregular nesting)
 */
function coordinateDepth(value: unknown): number {
  if (isPosition(value)) return 0;
  if (!Array.isArray(value) || value.length === 0) return -1;
  const depth = coordinateDepth(value[0]);
  if (depth < 0) return -1;
  for (let i = 1; i < value.length; i++) {
    if (coordinateDepth(value[i]) !== depth) return -1;
  }
  return depth + 1;
}

/** Why a line (a sequence of positions of depth 1) is unusable, or null */
function lineProblem(line: Coordinate[]): string | null {
  return line.length < 2 ? 'a line with fewer than two positions' : null;
}

/** Why a ring (a sequence of positions of depth 1) is unusable, or null */
function ringProblem(ring: Coordinate[]): string | null {
  if (ring.length < 4) return 'a ring with fewer than four positions';
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) {
    return 'a ring whose first and last positions differ';
  }
  return null;
}

function firstProblem<T>(parts: T[], check: (part: T) => string | null): string | null {
  for (const part of parts) {
    const problem = check(part);
    if (problem) return problem;
  }
  return null;
}

/** Why a polygon (a list of rings) is unusable, or null */
function polygonProblem(rings: Coordinate[][]): string | null {
  return firstProblem(rings, ringProblem);
}

/**
 * Returns why the coordinates cannot be used for a feature of the type, or null when they
 * can
 *
 * Every position must be two finite numbers, and no array may be empty. A built-in type
 * must have its nesting depth, a line has at least two positions, and a ring at least four
 * with the first and the last equal. A custom type may use any regular depth.
 *
 * @param type - the feature type
 * @param coordinates - the coordinates to check
 * @returns a short phrase that reads after "has" (for example "malformed coordinates"), or
 *   null
 */
export function describeCoordinateProblem(type: string, coordinates: unknown): string | null {
  const depth = coordinateDepth(coordinates);
  if (depth < 0) return 'malformed coordinates';
  const expected = COORDINATE_DEPTH[type];
  if (expected !== undefined && depth !== expected) {
    return `coordinates that do not match the type ${type}`;
  }

  switch (type) {
    case 'LineString':
    case 'Freehand':
      return lineProblem(coordinates as Coordinate[]);
    case 'MultiLineString':
      return firstProblem(coordinates as Coordinate[][], lineProblem);
    case 'Polygon':
      return polygonProblem(coordinates as Coordinate[][]);
    case 'MultiPolygon':
      return firstProblem(coordinates as Coordinate[][][], polygonProblem);
    default:
      return null;
  }
}
