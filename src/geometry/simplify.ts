// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Shaping
 *
 * Simplification by Douglas-Peucker, and the normalization of the ring orientations.
 * The tolerance is given in degrees (a distance on the lng/lat plane).
 */

import { isRingClosed } from './coords.js';
import type { Coordinate, MultiPolygonCoordinates, PolygonCoordinates, Ring } from './types.js';

/**
 * The square of the distance from a point to a segment (square degrees)
 */
function squaredSegmentDistance(point: Coordinate, start: Coordinate, end: Coordinate): number {
  let x = start[0];
  let y = start[1];
  const dx = end[0] - x;
  const dy = end[1] - y;

  if (dx !== 0 || dy !== 0) {
    const t = ((point[0] - x) * dx + (point[1] - y) * dy) / (dx * dx + dy * dy);
    if (t > 1) {
      x = end[0];
      y = end[1];
    } else if (t > 0) {
      x += dx * t;
      y += dy * t;
    }
  }

  const px = point[0] - x;
  const py = point[1] - y;
  return px * px + py * py;
}

/**
 * The recursive body of Douglas-Peucker (marks the indices that are adopted)
 */
function markKeep(
  path: Coordinate[],
  first: number,
  last: number,
  squaredTolerance: number,
  keep: boolean[],
): void {
  let maxSquared = squaredTolerance;
  let index = -1;

  for (let i = first + 1; i < last; i++) {
    const squared = squaredSegmentDistance(path[i], path[first], path[last]);
    if (squared > maxSquared) {
      maxSquared = squared;
      index = i;
    }
  }

  if (index === -1) {
    return;
  }

  keep[index] = true;
  if (index - first > 1) {
    markKeep(path, first, index, squaredTolerance, keep);
  }
  if (last - index > 1) {
    markKeep(path, index, last, squaredTolerance, keep);
  }
}

/**
 * Simplifies a coordinate sequence by the Douglas-Peucker algorithm.
 *
 * The tolerance is a distance on the lng/lat plane in degrees, not in meters: 0.00001
 * degrees is about 1.1 m of latitude, and a degree of longitude shrinks with `cos(lat)`.
 * The endpoints always remain. When the input is a closed ring, it is returned still
 * closed. When the ring would collapse to fewer than 4 points it would lose its area, so
 * the input is returned as it is. A tolerance that is not a positive number (0, a negative value or NaN) simplifies
 * nothing and returns a copy of the input.
 *
 * @param path The vertices `[lng, lat]` in degrees
 * @param toleranceDegrees The largest distance in degrees a dropped vertex may lie from the
 *   simplified line
 * @returns The simplified vertices as a new array. A copy of the input for 2 positions or
 *   fewer, for a tolerance that is not positive, and for a ring that would collapse
 *
 * @example
 * ```ts
 * import { simplify } from '@sakuzu/maplibre-gl-draw/geometry';
 *
 * simplify([[0, 0], [1, 0.00001], [2, 0], [3, 1]], 0.001); // [[0, 0], [2, 0], [3, 1]]
 * ```
 */
export function simplify(path: Coordinate[], toleranceDegrees: number): Coordinate[] {
  if (path.length <= 2 || !(toleranceDegrees > 0)) {
    return [...path];
  }

  const keep = new Array<boolean>(path.length).fill(false);
  keep[0] = true;
  keep[path.length - 1] = true;
  markKeep(path, 0, path.length - 1, toleranceDegrees * toleranceDegrees, keep);

  const result = path.filter((_, index) => keep[index]);
  if (isRingClosed(path) && result.length < 4) {
    return [...path];
  }
  return result;
}

/**
 * Returns the signed planar area of a ring in square degrees; counter-clockwise is
 * positive.
 *
 * The shoelace formula on the lng/lat plane, meant for orientation tests. For an area in
 * square meters use {@link sphericalArea}. The ring may be open or closed.
 *
 * @param ring The ring `[lng, lat][]` in degrees
 * @returns The signed area in square degrees. 0 for fewer than 3 positions
 */
export function signedRingArea(ring: Ring): number {
  if (ring.length < 3) {
    return 0;
  }

  let total = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    total += (ring[j][0] + ring[i][0]) * (ring[j][1] - ring[i][1]);
  }
  return -total / 2;
}

/**
 * Determines whether a ring runs clockwise on the lng/lat plane.
 *
 * @param ring The ring `[lng, lat][]` in degrees
 * @returns `true` when it is clockwise. `false` when it is counter-clockwise and for a
 *   degenerate ring whose area is 0
 */
export function isRingClockwise(ring: Ring): boolean {
  return signedRingArea(ring) < 0;
}

/**
 * Returns a ring in the given orientation.
 *
 * A degenerate ring with area 0 counts as counter-clockwise.
 *
 * @param ring The ring `[lng, lat][]` in degrees
 * @param clockwise `true` for clockwise and `false` for counter-clockwise
 * @returns The input itself when it already has the orientation, otherwise a new reversed
 *   array
 */
export function normalizeRingOrientation(ring: Ring, clockwise: boolean): Ring {
  return isRingClockwise(ring) === clockwise ? ring : [...ring].reverse();
}

/**
 * Orients the rings of a Polygon as GeoJSON (RFC 7946) recommends: the outer ring
 * counter-clockwise and the holes clockwise.
 *
 * Only the orientation changes; self-intersections and degenerate rings are left as they
 * are (use {@link normalizeArea} for those).
 *
 * @param polygon Polygon coordinates in degrees
 * @returns New Polygon coordinates; rings already in the orientation are reused
 */
export function normalizePolygonOrientation(polygon: PolygonCoordinates): PolygonCoordinates {
  return polygon.map((ring, index) => normalizeRingOrientation(ring, index > 0));
}

/**
 * Orients the rings of every part of a MultiPolygon as
 * {@link normalizePolygonOrientation} does.
 *
 * @param multiPolygon MultiPolygon coordinates in degrees
 * @returns New MultiPolygon coordinates; rings already in the orientation are reused
 */
export function normalizeMultiPolygonOrientation(
  multiPolygon: MultiPolygonCoordinates,
): MultiPolygonCoordinates {
  return multiPolygon.map(normalizePolygonOrientation);
}
