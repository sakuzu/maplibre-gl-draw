// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Circle generation
 *
 * Approximates a geodesic circle with a polygon (64 vertices by default). Rendering of the
 * Circle feature and the buffer of a point share this implementation. The vertices come
 * from {@link destinationPoint}, the direct problem on the sphere, so every vertex lies at
 * the radius from the center in haversine distance at any latitude; only the straight
 * edges between the vertices fall inside the circle.
 */

import { isFiniteCoordinate } from './coords.js';
import { destinationPoint } from './distance.js';
import type { BBox, Coordinate } from './types.js';
import { EARTH_RADIUS_METERS, toDegrees } from './units.js';

/** The default number of vertices of a circle */
const DEFAULT_CIRCLE_SEGMENTS = 64;

/** The lower bound of the number of vertices (fewer than a triangle is not a polygon) */
const MIN_CIRCLE_SEGMENTS = 3;

/** The upper bound of the number of vertices */
const MAX_CIRCLE_SEGMENTS = 1024;

/**
 * Normalizes a requested number of vertices of a circle
 *
 * The value is rounded down to an integer and clamped to 3-1024. An omitted value and NaN
 * give the default, so no input makes the generation loop run forever or return a ring
 * without positions.
 *
 * @param segments The requested number of vertices
 * @param fallback The number used when it is omitted or NaN
 */
export function normalizeCircleSegments(
  segments: number | undefined,
  fallback: number = DEFAULT_CIRCLE_SEGMENTS,
): number {
  const requested = segments === undefined || Number.isNaN(segments) ? fallback : segments;
  return Math.min(MAX_CIRCLE_SEGMENTS, Math.max(MIN_CIRCLE_SEGMENTS, Math.floor(requested)));
}

/**
 * Approximates a geodesic circle with a closed ring.
 *
 * The vertices come from {@link destinationPoint}, so each lies at the radius from the
 * center at any latitude, up to floating-point rounding; only the straight edges between
 * them fall slightly inside the circle. The first vertex is due north of the center and the
 * ring runs clockwise. The number of vertices is rounded down and clamped to 3-1024; NaN
 * gives 64. A circle that reaches a pole cannot be expressed as a ring in longitude and
 * latitude and is out of scope.
 *
 * @param center The center `[lng, lat]` in degrees
 * @param radiusMeters The radius in meters. 0 gives a ring of identical positions
 * @param segments The number of vertices (64 by default)
 * @returns The ring, `segments + 1` positions `[lng, lat]` with the first repeated at the
 *   end. An empty array for a center that is not finite and for a radius that is negative
 *   or not finite
 */
export function generateCirclePolygon(
  center: Coordinate,
  radiusMeters: number,
  segments: number = DEFAULT_CIRCLE_SEGMENTS,
): Coordinate[] {
  if (!isFiniteCoordinate(center) || !Number.isFinite(radiusMeters) || radiusMeters < 0) {
    return [];
  }

  const count = normalizeCircleSegments(segments);
  const coords: Coordinate[] = [];

  for (let i = 0; i < count; i++) {
    // Divide evenly from 0 to 360 degrees (clockwise with north as 0 degrees)
    const angleDegrees = (360 / count) * i;
    coords.push(destinationPoint(center, radiusMeters, angleDegrees));
  }

  // Append the first point to make the polygon closed
  coords.push(coords[0]);

  return coords;
}

/**
 * The bounding box of a geodesic circle
 *
 * The north and south extremes lie on the meridian of the center. The east and west extremes
 * are where the circle touches a meridian, at the bearing `acos(tan δ · tan φ)` from the
 * center (δ the angular radius, φ the latitude of the center), which is poleward of due east
 * and west. The box is taken from the points reached at those bearings, so it contains the
 * polygon of {@link generateCirclePolygon} for any number of vertices. A circle that
 * contains a pole spans 360 degrees of longitude from the center and reaches the pole.
 *
 * @param center Center coordinate [lng, lat]
 * @param radiusMeters Radius (meters)
 * @returns [minLng, minLat, maxLng, maxLat]. null for a center that is not finite or a
 *   radius that is negative or not finite
 */
export function circleBoundingBox(center: Coordinate, radiusMeters: number): BBox | null {
  if (!isFiniteCoordinate(center) || !Number.isFinite(radiusMeters) || radiusMeters < 0) {
    return null;
  }
  const [lng, lat] = center;
  const radiusDegrees = toDegrees(radiusMeters / EARTH_RADIUS_METERS);
  const north = lat + radiusDegrees;
  const south = lat - radiusDegrees;
  if (north >= 90 || south <= -90) {
    return [lng - 180, Math.max(-90, south), lng + 180, Math.min(90, north)];
  }

  const tangent = Math.tan(radiusMeters / EARTH_RADIUS_METERS) * Math.tan((lat * Math.PI) / 180);
  const eastBearing = toDegrees(Math.acos(Math.min(1, Math.max(-1, tangent))));
  const east = destinationPoint(center, radiusMeters, eastBearing)[0];
  const west = destinationPoint(center, radiusMeters, 360 - eastBearing)[0];
  return [Math.min(west, lng), south, Math.max(east, lng), north];
}
