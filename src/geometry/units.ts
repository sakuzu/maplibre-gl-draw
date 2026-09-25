// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit conversion and geodetic constants
 *
 * The spherical-approximation constants and the angle conversions shared across the
 * whole geometry module.
 */

/**
 * The radius of the sphere every geodesic function of this module uses, in meters.
 *
 * The value is the mean Earth radius, 6,371,000 m. Distances, bearings, areas, circles and
 * buffers all assume this sphere rather than an ellipsoid, so a result differs from an
 * ellipsoidal computation by up to about 0.5%.
 */
export const EARTH_RADIUS_METERS = 6371000;

/**
 * Converts an angle in degrees to radians.
 *
 * @param degrees The angle in degrees
 * @returns The angle in radians. NaN and infinities pass through unchanged
 *
 * @example
 * ```ts
 * import { toRadians } from '@sakuzu/maplibre-gl-draw/geometry';
 *
 * toRadians(180); // Math.PI
 * ```
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
