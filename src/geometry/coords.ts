// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Discrimination and normalization of coordinate shapes
 *
 * Shared helpers for the operations that accept both Polygon coordinates and
 * MultiPolygon coordinates.
 */

import type { AreaCoordinates, Coordinate, MultiPolygonCoordinates, Ring } from './types.js';

/**
 * Determines whether polygon coordinates are MultiPolygon coordinates rather than Polygon
 * coordinates.
 *
 * Polygon coordinates are Ring[] and MultiPolygon coordinates are Ring[][]. The first
 * non-empty element at the second level is a position of a ring for a Polygon and a ring
 * for a MultiPolygon, so the two are told apart by whether that element starts with an
 * array. Empty rings and empty parts are skipped, so a MultiPolygon whose first part is
 * empty is still recognized. Coordinates with no position at all are treated as a Polygon.
 *
 * @param coordinates Polygon or MultiPolygon coordinates
 * @returns `true` for MultiPolygon coordinates (a type guard). `false` for Polygon
 *   coordinates and for coordinates with no position
 *
 * @example
 * ```ts
 * import { isMultiPolygonCoordinates } from '@sakuzu/maplibre-gl-draw/geometry';
 *
 * const ring: [number, number][] = [[0, 0], [1, 0], [1, 1], [0, 0]];
 * isMultiPolygonCoordinates([ring]); // false (Polygon)
 * isMultiPolygonCoordinates([[ring]]); // true (MultiPolygon)
 * ```
 */
export function isMultiPolygonCoordinates(
  coordinates: AreaCoordinates,
): coordinates is MultiPolygonCoordinates {
  for (const element of coordinates as unknown[]) {
    if (!Array.isArray(element)) continue;
    for (const item of element as unknown[]) {
      if (Array.isArray(item) && item.length > 0) return Array.isArray(item[0]);
    }
  }
  return false;
}

/**
 * Determines whether a value is a coordinate whose longitude and latitude are finite
 * numbers
 */
export function isFiniteCoordinate(value: unknown): value is Coordinate {
  return (
    Array.isArray(value) &&
    value.length >= 2 &&
    typeof value[0] === 'number' &&
    typeof value[1] === 'number' &&
    Number.isFinite(value[0]) &&
    Number.isFinite(value[1])
  );
}

/**
 * Determines whether a ring can bound an area: at least 3 positions, every one finite
 *
 * A ring that fails this has no area. The functions that take polygons drop such a ring the
 * same way, and drop a whole part whose outer ring fails (its holes then have nothing to be
 * holes of).
 */
export function isUsableRing(ring: Ring): boolean {
  return Array.isArray(ring) && ring.length >= 3 && ring.every(isFiniteCoordinate);
}

/**
 * Keeps only the parts and rings that can bound an area (see {@link isUsableRing})
 *
 * Returns MultiPolygon coordinates. The arrays of the rings that are kept are not copied.
 */
export function usableAreaParts(coordinates: AreaCoordinates): MultiPolygonCoordinates {
  const result: MultiPolygonCoordinates = [];
  for (const polygon of toMultiPolygonCoordinates(coordinates)) {
    if (!Array.isArray(polygon) || polygon.length === 0 || !isUsableRing(polygon[0])) continue;
    result.push(polygon.filter(isUsableRing));
  }
  return result;
}

/**
 * Returns Polygon or MultiPolygon coordinates as MultiPolygon coordinates.
 *
 * The input array is not copied: MultiPolygon coordinates are returned as they are, and
 * Polygon coordinates are wrapped as a single part. Nothing is validated or normalized; use
 * {@link normalizeArea} for that.
 *
 * @param coordinates Polygon or MultiPolygon coordinates
 * @returns MultiPolygon coordinates. An empty array for an empty input
 */
export function toMultiPolygonCoordinates(coordinates: AreaCoordinates): MultiPolygonCoordinates {
  if (coordinates.length === 0) {
    return [];
  }
  if (isMultiPolygonCoordinates(coordinates)) {
    return coordinates;
  }
  return [coordinates];
}

/**
 * Determines whether a ring is closed, that is whether its first and last positions are
 * equal.
 *
 * The comparison is exact (`===` on longitude and latitude).
 *
 * @param ring A coordinate sequence
 * @returns `true` when the first and last positions are equal. `false` for fewer than 2
 *   positions
 */
export function isRingClosed(ring: Ring): boolean {
  if (ring.length < 2) {
    return false;
  }
  const first = ring[0];
  const last = ring[ring.length - 1];
  return first[0] === last[0] && first[1] === last[1];
}

/**
 * Closes a ring by appending its first position at the end when needed.
 *
 * @param ring A coordinate sequence
 * @returns A new closed array. The input itself when it is already closed or empty
 *
 * @example
 * ```ts
 * import { closeRing } from '@sakuzu/maplibre-gl-draw/geometry';
 *
 * closeRing([[0, 0], [1, 0], [1, 1]]); // [[0, 0], [1, 0], [1, 1], [0, 0]]
 * ```
 */
export function closeRing(ring: Ring): Ring {
  if (ring.length === 0 || isRingClosed(ring)) {
    return ring;
  }
  return [...ring, ring[0]];
}

/**
 * Returns every position of Polygon or MultiPolygon coordinates as one flat array.
 *
 * Positions are listed part by part and ring by ring, holes included, closing positions
 * included. Nothing is validated.
 *
 * @param coordinates Polygon or MultiPolygon coordinates
 * @returns A new array of the positions (the position arrays themselves are not copied).
 *   An empty array for an empty input
 */
export function flattenAreaCoordinates(coordinates: AreaCoordinates): Coordinate[] {
  const result: Coordinate[] = [];
  for (const polygon of toMultiPolygonCoordinates(coordinates)) {
    for (const ring of polygon) {
      for (const coordinate of ring) {
        result.push(coordinate);
      }
    }
  }
  return result;
}
