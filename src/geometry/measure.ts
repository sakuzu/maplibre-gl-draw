// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Measurement
 *
 * The length is the sum of haversine distances, and the area is based on the spherical
 * excess of a spherical polygon. The centroid and the representative point are computed
 * on the lng/lat plane, assuming shapes of the scale of an edit.
 */

import { boundingBox } from './bbox.js';
import { normalizeArea } from './boolean.js';
import { toMultiPolygonCoordinates } from './coords.js';
import { haversineDistanceMeters } from './distance.js';
import { pointInPolygon } from './predicates.js';
import type { AreaCoordinates, Coordinate, Ring } from './types.js';
import { EARTH_RADIUS_METERS, toRadians } from './units.js';

/**
 * Returns the geodesic length of a path in meters.
 *
 * The sum of the {@link haversineDistanceMeters} of each section. For the perimeter of a
 * polygon pass its closed ring.
 *
 * @param path The vertices `[lng, lat]` in degrees
 * @returns The length in meters. 0 for fewer than 2 positions. NaN when a position is not
 *   finite
 *
 * @example
 * ```ts
 * import { geodesicLength } from '@sakuzu/maplibre-gl-draw/geometry';
 *
 * geodesicLength([[0, 0], [1, 0], [1, 1]]); // about 222,390 m
 * ```
 */
export function geodesicLength(path: Coordinate[]): number {
  let total = 0;
  for (let i = 0; i < path.length - 1; i++) {
    total += haversineDistanceMeters(path[i], path[i + 1]);
  }
  return total;
}

/**
 * The spherical area of a ring (signed, square meters)
 */
function sphericalRingArea(ring: Ring): number {
  if (ring.length < 3) {
    return 0;
  }

  let total = 0;
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const lower = ring[i];
    const middle = ring[(i + 1) % n];
    const upper = ring[(i + 2) % n];
    total += (toRadians(upper[0]) - toRadians(lower[0])) * Math.sin(toRadians(middle[1]));
  }

  return (total * EARTH_RADIUS_METERS * EARTH_RADIUS_METERS) / 2;
}

/**
 * Returns the area of a polygon on the sphere in square meters.
 *
 * The input is normalized with {@link normalizeArea} first, so self-intersections are
 * resolved, a hole outside its outer ring is dropped, a hole larger than its outer ring
 * empties the part, and rings that cannot bound an area are dropped. The holes of the
 * normalized form lie inside their outer ring, so subtracting them never makes the result
 * negative. For a MultiPolygon the sum of each part is returned. Ring orientation does not
 * matter. The area is based on the spherical excess on a sphere of radius
 * {@link EARTH_RADIUS_METERS}.
 *
 * @param polygon Polygon or MultiPolygon coordinates in degrees
 * @returns The area in square meters. 0 when nothing with an area remains
 * @throws {@link GeometryError} when the boolean operation engine fails even after the
 *   retry on the 1e-9 degree grid
 *
 * @example
 * ```ts
 * import { sphericalArea } from '@sakuzu/maplibre-gl-draw/geometry';
 *
 * // A 1 x 1 degree square on the equator
 * sphericalArea([[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]]); // about 1.236e10 m²
 * ```
 */
export function sphericalArea(polygon: AreaCoordinates): number {
  let total = 0;
  for (const part of normalizeArea(polygon)) {
    for (let i = 0; i < part.length; i++) {
      const ringArea = Math.abs(sphericalRingArea(part[i]));
      total += i === 0 ? ringArea : -ringArea;
    }
  }
  return total;
}

/**
 * Returns the centroid of a ring (weighted by area) and its signed area
 */
function ringCentroid(ring: Ring): { centroid: Coordinate; area: number } | null {
  if (ring.length < 3) {
    return null;
  }

  let cx = 0;
  let cy = 0;
  let doubleArea = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const cross = ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
    doubleArea += cross;
    cx += (ring[j][0] + ring[i][0]) * cross;
    cy += (ring[j][1] + ring[i][1]) * cross;
  }

  if (doubleArea === 0) {
    return null;
  }

  const area = doubleArea / 2;
  return { centroid: [cx / (6 * area), cy / (6 * area)], area };
}

/**
 * The mean coordinate of all the vertices (the fallback for a shape whose area is 0)
 */
function verticesMean(polygon: AreaCoordinates): Coordinate | null {
  let sumLng = 0;
  let sumLat = 0;
  let count = 0;
  for (const part of toMultiPolygonCoordinates(polygon)) {
    for (const ring of part) {
      for (const [lng, lat] of ring) {
        sumLng += lng;
        sumLat += lat;
        count++;
      }
    }
  }
  return count === 0 ? null : [sumLng / count, sumLat / count];
}

/**
 * Returns the area-weighted centroid of a polygon.
 *
 * The area of the holes is subtracted, and the parts of a MultiPolygon are combined with
 * their areas as the weights. The computation is on the lng/lat plane, an approximation
 * meant for shapes of the scale of an edit. The centroid of a concave shape can fall
 * outside it; use {@link pointOnSurface} for a point that is always inside.
 *
 * @param polygon Polygon or MultiPolygon coordinates in degrees
 * @returns The centroid `[lng, lat]` in degrees. The mean of all the vertices when the area
 *   is 0. `null` when there is not a single position
 */
export function centroid(polygon: AreaCoordinates): Coordinate | null {
  let sumLng = 0;
  let sumLat = 0;
  let sumArea = 0;

  for (const part of toMultiPolygonCoordinates(polygon)) {
    for (let i = 0; i < part.length; i++) {
      const result = ringCentroid(part[i]);
      if (result === null) {
        continue;
      }
      // Give the outer ring a positive weight and the inner rings a negative one
      const weight = i === 0 ? Math.abs(result.area) : -Math.abs(result.area);
      sumLng += result.centroid[0] * weight;
      sumLat += result.centroid[1] * weight;
      sumArea += weight;
    }
  }

  if (sumArea === 0) {
    return verticesMean(polygon);
  }
  return [sumLng / sumArea, sumLat / sumArea];
}

/**
 * Returns, in ascending order, the longitudes of the intersections of the horizontal
 * scanline at the given latitude with each ring
 */
function scanlineCrossings(polygon: AreaCoordinates, lat: number): number[] {
  const crossings: number[] = [];
  for (const part of toMultiPolygonCoordinates(polygon)) {
    for (const ring of part) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i];
        const [xj, yj] = ring[j];
        // Counting on a half-open interval avoids double-counting a vertex
        if (yi > lat !== yj > lat) {
          crossings.push(xi + ((lat - yi) / (yj - yi)) * (xj - xi));
        }
      }
    }
  }
  return crossings.sort((a, b) => a - b);
}

/**
 * Returns a representative point that lies inside a polygon, such as a label anchor.
 *
 * If the {@link centroid} is inside the polygon, it is returned. If it is outside (a
 * concave shape, or a centroid in a hole), a horizontal scanline is drawn at the latitude of
 * the centroid and the midpoint of the longest interior section is returned. For a
 * degenerate shape the scanline does not cross, the center of the bounding box is returned.
 *
 * @param polygon Polygon or MultiPolygon coordinates in degrees
 * @returns The point `[lng, lat]` in degrees. `null` when there is not a single position
 *
 * @example
 * ```ts
 * import { centroid, pointOnSurface } from '@sakuzu/maplibre-gl-draw/geometry';
 *
 * // A U shape: the centroid falls in the gap between the arms
 * const u: [number, number][][] = [
 *   [[0, 0], [3, 0], [3, 3], [2, 3], [2, 1], [1, 1], [1, 3], [0, 3], [0, 0]],
 * ];
 * centroid(u); // [1.5, 1.357...] (outside)
 * pointOnSurface(u); // [0.5, 1.357...] (inside the left arm)
 * ```
 */
export function pointOnSurface(polygon: AreaCoordinates): Coordinate | null {
  const center = centroid(polygon);
  if (center === null) {
    return null;
  }
  if (pointInPolygon(center, polygon)) {
    return center;
  }

  const lat = center[1];
  const crossings = scanlineCrossings(polygon, lat);

  let bestStart = Number.NaN;
  let bestWidth = -1;
  // By the even-odd rule, the intervals formed by pairing the intersections two at a
  // time in ascending order are the interior
  for (let i = 0; i + 1 < crossings.length; i += 2) {
    const width = crossings[i + 1] - crossings[i];
    if (width > bestWidth) {
      bestWidth = width;
      bestStart = crossings[i];
    }
  }

  if (bestWidth < 0) {
    // A degenerate shape in which the scanline does not pass through the interior.
    // Fall back to the center of the bbox
    const box = boundingBox(polygon);
    return box === null ? center : [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2];
  }

  return [bestStart + bestWidth / 2, lat];
}
