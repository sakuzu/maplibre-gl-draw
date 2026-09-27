// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Coordinate generation from a bearing
 *
 * Computes a point from a center, a distance and a bearing on the lng/lat plane. The
 * snapping guides rely on it. Circles and buffers use the geodesic direct problem
 * (destinationPoint in distance.ts) instead.
 *
 * It is not the geodesic direct problem. The distance is laid out on the lng/lat plane
 * scaled at the latitude of the center (an equirectangular approximation: the longitude
 * displacement is divided by cos of the center latitude), so the point drifts from the true
 * geodesic position as the distance and the latitude grow. Measured with the haversine
 * distance back to the center, the radius error at latitude 60 degrees is about ±0.05% for
 * 10 km, ±0.5% (±530 m) for 100 km and -5.6% to +4.9% for 1000 km, and it diverges near
 * the poles (-20% to +14% for 1 km at latitude 89.99 degrees). Along a bearing of 90 or 270
 * degrees the point stays on the parallel of the center, which the snapping guides rely on.
 */

import type { Coordinate } from './types.js';
import { EARTH_RADIUS_METERS, toRadians } from './units.js';

/**
 * Returns the position at a distance and bearing from a center, laid out on the lng/lat
 * plane.
 *
 * This is a planar approximation, not the geodesic direct problem: the longitude
 * displacement is divided by `cos(lat)` of the center, so a bearing of 90 or 270 degrees
 * stays exactly on the parallel of the center. The haversine distance from the center to
 * the result differs from `radiusMeters` by about ±0.2% at latitude 35 degrees for 100 km
 * and ±0.5% at latitude 60 degrees for 100 km, and the error diverges near the poles. It is
 * exact enough at the scale of an edit; where the distance must hold, use
 * {@link destinationPoint}.
 *
 * The longitude of the result is not wrapped into [-180, 180]. No input is rejected: a
 * center at latitude ±90 degrees gives a non-finite longitude, and non-finite arguments
 * give non-finite coordinates.
 *
 * @param center The center `[lng, lat]` in degrees
 * @param radiusMeters The distance from the center in meters
 * @param angleDegrees The bearing in degrees, clockwise with north as 0
 * @returns The position `[lng, lat]` in degrees
 */
export function getPointAtAngle(
  center: Coordinate,
  radiusMeters: number,
  angleDegrees: number,
): Coordinate {
  const earthRadius = EARTH_RADIUS_METERS;
  const [lng, lat] = center;

  // Convert the angle to radians (clockwise with north as 0)
  const angleRad = toRadians(angleDegrees);

  // Compute the latitude displacement (northward is positive)
  const dLat = (radiusMeters / earthRadius) * Math.cos(angleRad) * (180 / Math.PI);

  // Compute the longitude displacement (with the correction for latitude)
  const latRad = toRadians(lat);
  const dLng =
    ((radiusMeters / earthRadius) * Math.sin(angleRad) * (180 / Math.PI)) / Math.cos(latRad);

  return [lng + dLng, lat + dLat];
}
