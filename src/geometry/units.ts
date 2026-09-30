// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit conversion and geodetic constants
 *
 * The spherical-approximation constants and the angle conversions shared across the
 * whole geometry module.
 */

/**
 * The radius in meters of the sphere on which every function of this entry measures.
 *
 * The value is the mean Earth radius of the IUGG, 6,371,008.8 m. Distances, bearings, areas,
 * circles and buffers all assume this sphere rather than an ellipsoid, so a result differs from
 * an ellipsoidal computation by up to about 0.5%.
 */
export const EARTH_RADIUS_METERS = 6371008.8;

/**
 * Converts an angle in degrees to radians.
 *
 * @param degrees The angle in degrees
 * @returns The angle in radians. NaN and infinities pass through unchanged
 */
export function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

/**
 * Converts an angle in radians to degrees.
 *
 * @param radians The angle in radians
 * @returns The angle in degrees. NaN and infinities pass through unchanged
 */
export function toDegrees(radians: number): number {
  return (radians * 180) / Math.PI;
}

/**
 * Converts a distance at a latitude into degrees of longitude and latitude.
 *
 * On the sphere of {@link EARTH_RADIUS_METERS}: a degree of latitude is always the same
 * length, and a degree of longitude shrinks with the cosine of the latitude. Use it to turn a
 * tolerance in meters into one in degrees. Near the poles the longitude grows without bound.
 *
 * @param meters The distance in meters
 * @param latitude The latitude in degrees at which the distance is taken
 * @returns The distance in degrees of longitude (`lng`) and of latitude (`lat`)
 */
export function metersToDegrees(meters: number, latitude: number): { lng: number; lat: number } {
  const lat = toDegrees(meters / EARTH_RADIUS_METERS);
  return { lng: lat / Math.cos(toRadians(latitude)), lat };
}
