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

/** The latitude limit of Web Mercator in degrees, past which its scale is not finite */
const MAX_MERCATOR_LATITUDE = 85.0511287798066;

/** The width of a tile of maplibre in pixels, which its zoom counts from */
const TILE_SIZE = 512;

/**
 * Converts a size in pixels at a zoom into a length on the ground at a latitude.
 *
 * It is the scale of Web Mercator on the sphere of {@link EARTH_RADIUS_METERS} at the zoom of
 * maplibre (the world is 512 pixels wide at zoom 0): a pixel spans the circumference times the
 * cosine of the latitude, over the width of the world in pixels at the zoom. Use it for a size
 * given in pixels at a zoom of its own, such as the zoom a shape was made at, so that the shape
 * keeps its size on the ground whatever the view; {@link metersToDegrees} then lays the length
 * at the latitude. The latitude is held within the latitudes Web Mercator draws (±85.0511
 * degrees).
 *
 * It does not depend on the view. A size of the current view, which keeps its pixels as the map
 * zooms and tilts (a margin, a handle out of a box), takes the meters of a pixel of the view drawn
 * last instead: `ScreenContext.metersPerPixel(position)` of the context of an extension.
 *
 * @param pixels The size in pixels
 * @param zoom The zoom at which the size is given
 * @param latitude The latitude in degrees
 * @returns The length in meters
 */
export function pixelsToMeters(pixels: number, zoom: number, latitude: number): number {
  const lat = Math.max(-MAX_MERCATOR_LATITUDE, Math.min(MAX_MERCATOR_LATITUDE, latitude));
  const metersAround = 2 * Math.PI * EARTH_RADIUS_METERS * Math.cos(toRadians(lat));
  return (pixels * metersAround) / (TILE_SIZE * 2 ** zoom);
}
