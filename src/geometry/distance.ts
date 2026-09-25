// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Geodesic distance and bearing
 *
 * The haversine family under a spherical approximation. This is the body of the
 * geodesic computation shared by circle rendering, buffer generation and measurement.
 */

import type { Coordinate } from './types.js';
import { EARTH_RADIUS_METERS, toDegrees, toRadians } from './units.js';

/**
 * Returns the great-circle distance between two positions in meters.
 *
 * The haversine formula on a sphere of radius {@link EARTH_RADIUS_METERS}; the error
 * against the ellipsoid is up to about 0.5%. Crossing the ±180 degree meridian is taken
 * the short way round. Non-finite coordinates give NaN.
 *
 * @param coord1 A position `[lng, lat]` in degrees
 * @param coord2 A position `[lng, lat]` in degrees
 * @returns The distance in meters. 0 for identical positions
 *
 * @example
 * ```ts
 * import { haversineDistanceMeters } from '@sakuzu/maplibre-gl-draw/geometry';
 *
 * // Tokyo Station to Osaka Station
 * haversineDistanceMeters([139.767, 35.681], [135.495, 34.702]); // about 403,139 m
 * ```
 */
export function haversineDistanceMeters(coord1: Coordinate, coord2: Coordinate): number {
  const R = EARTH_RADIUS_METERS;
  const [lng1, lat1] = coord1;
  const [lng2, lat2] = coord2;

  const dLat = toRadians(lat2 - lat1);
  const dLng = toRadians(lng2 - lng1);

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(dLng / 2) * Math.sin(dLng / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/**
 * Returns the initial bearing of the great circle from one position to another.
 *
 * The same spherical approximation as {@link haversineDistanceMeters}. The bearing along a
 * great circle changes on the way, so this is the direction at the start only.
 *
 * @param from The start `[lng, lat]` in degrees
 * @param to The end `[lng, lat]` in degrees
 * @returns The bearing in degrees, clockwise with north as 0, in the range [0, 360). 0 when
 *   the two positions are identical
 *
 * @example
 * ```ts
 * import { initialBearingDegrees } from '@sakuzu/maplibre-gl-draw/geometry';
 *
 * initialBearingDegrees([0, 0], [1, 0]); // 90 (due east)
 * initialBearingDegrees([0, 0], [0, 1]); // 0 (due north)
 * ```
 */
export function initialBearingDegrees(from: Coordinate, to: Coordinate): number {
  const [lng1, lat1] = from;
  const [lng2, lat2] = to;

  const phi1 = toRadians(lat1);
  const phi2 = toRadians(lat2);
  const dLambda = toRadians(lng2 - lng1);

  const y = Math.sin(dLambda) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLambda);

  if (y === 0 && x === 0) {
    return 0;
  }

  const bearing = toDegrees(Math.atan2(y, x));
  return (bearing + 360) % 360;
}

/**
 * Returns the position reached from an origin along a great circle, given a distance and
 * an initial bearing (the direct problem on the sphere).
 *
 * The inverse of {@link haversineDistanceMeters} and {@link initialBearingDegrees} under the
 * same spherical approximation: the haversine distance from the origin to the result is
 * `distanceMeters` and the initial bearing is `bearingDegrees`, up to floating-point
 * rounding, at any latitude and distance.
 *
 * The longitude of the result continues from the origin (origin longitude + a change within
 * ±180 degrees) and is not wrapped into [-180, 180], so a circle drawn near the antimeridian
 * stays one continuous ring. A great circle through a pole comes back on the far meridian
 * (origin longitude ± 180 degrees).
 *
 * Circles ({@link generateCirclePolygon}) and buffers ({@link buffer}) place their vertices
 * with it. No input is rejected; non-finite arguments give non-finite coordinates.
 *
 * @param origin The start `[lng, lat]` in degrees
 * @param distanceMeters The distance along the great circle in meters. A negative value
 *   goes the opposite way
 * @param bearingDegrees The initial bearing in degrees, clockwise with north as 0
 * @returns The position reached, `[lng, lat]` in degrees
 *
 * @example
 * ```ts
 * import { destinationPoint } from '@sakuzu/maplibre-gl-draw/geometry';
 *
 * // 1 km due east of Tokyo Station
 * destinationPoint([139.767, 35.681], 1000, 90); // [139.77807..., 35.68099...]
 * ```
 */
export function destinationPoint(
  origin: Coordinate,
  distanceMeters: number,
  bearingDegrees: number,
): Coordinate {
  const [lng, lat] = origin;
  const delta = distanceMeters / EARTH_RADIUS_METERS;
  const theta = toRadians(bearingDegrees);
  const phi1 = toRadians(lat);

  const sinPhi1 = Math.sin(phi1);
  const cosPhi1 = Math.cos(phi1);
  const sinDelta = Math.sin(delta);
  const cosDelta = Math.cos(delta);

  const sinPhi2 = Math.min(
    1,
    Math.max(-1, sinPhi1 * cosDelta + cosPhi1 * sinDelta * Math.cos(theta)),
  );
  const phi2 = Math.asin(sinPhi2);
  const dLambda = Math.atan2(Math.sin(theta) * sinDelta * cosPhi1, cosDelta - sinPhi1 * sinPhi2);

  return [lng + toDegrees(dLambda), toDegrees(phi2)];
}
