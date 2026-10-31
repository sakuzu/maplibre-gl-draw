// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Sizes in pixels as lengths on the ground
 *
 * What is drawn on the map with a size in pixels has that size turned into a length on the
 * ground and laid around the feature, on the plane tangent to the sphere the map is drawn on
 * (maplibre's sphere, of `EARTH_RADIUS_METERS`), so that it tilts and turns with the map.
 * There are two kinds of size, with a scale each:
 *
 * - A size of the current view (the margin of the selection frame, the distance of the rotate
 *   handle, the move of an arrow key): the meters a CSS pixel spans at the feature in the frame
 *   drawn last (`metersPerPixelInFrame` of `screen-scale.ts`). It follows the projection of the map: the scale
 *   of Web Mercator at the latitude of the feature, the scale of the globe at the center of the
 *   view, and the mix of the two while the map goes from one to the other.
 * - A size kept with a zoom (an image placed at a zoom): the meters a pixel spans on Web
 *   Mercator at that zoom and at the latitude of the feature ({@link metersPerPixelAtZoom}),
 *   once, whatever the view.
 *
 * This plane is the plane of the drawing. The edits that move, rotate and scale features
 * compute on the WGS 84 ellipsoid (`geometry/enu-transforms.ts`) and do not use it.
 */

import { EARTH_RADIUS_METERS, pixelsToMeters } from '../../geometry/units.js';
import type { Coordinate } from '../types/model.js';
import { DEFAULT_TILE_SIZE } from './constants.js';

/** The latitude limit of Web Mercator (degrees), past which no scale is finite */
const MAX_MERCATOR_LATITUDE = 85.0511287798066;

const RADIANS_PER_DEGREE = Math.PI / 180;
const DEGREES_PER_RADIAN = 180 / Math.PI;

/** The cosine of a latitude held within the latitudes Web Mercator draws */
function cosLatitude(latitude: number): number {
  const lat = Math.max(-MAX_MERCATOR_LATITUDE, Math.min(MAX_MERCATOR_LATITUDE, latitude));
  return Math.cos(lat * RADIANS_PER_DEGREE);
}

/**
 * The width of the world in pixels at a zoom
 *
 * @param zoom - The zoom
 * @param tileSize - The size of a tile in pixels (maplibre's is 512)
 */
export function worldSizeAtZoom(zoom: number, tileSize: number = DEFAULT_TILE_SIZE): number {
  return tileSize * 2 ** zoom;
}

/**
 * The meters a pixel spans on Web Mercator at a zoom and a latitude: the scale of a size kept with
 * a zoom
 *
 * @param latitude - The latitude in degrees
 * @param zoom - The zoom the size was given at
 * @param tileSize - The size of a tile in pixels (maplibre's is 512)
 */
export function metersPerPixelAtZoom(
  latitude: number,
  zoom: number,
  tileSize: number = DEFAULT_TILE_SIZE,
): number {
  // The zoom of /geometry counts tiles of DEFAULT_TILE_SIZE pixels
  return pixelsToMeters(DEFAULT_TILE_SIZE / tileSize, zoom, latitude);
}

/**
 * The degrees of longitude and of latitude of a pixel east and a pixel north on Web Mercator at a
 * zoom and a latitude: {@link metersPerPixelAtZoom} laid on the tangent plane
 * ({@link degreesPerMeterAt}), where the size of the sphere cancels out
 *
 * @returns `[longitude, latitude]` in degrees per pixel
 */
export function degreesPerPixelAtZoom(
  latitude: number,
  zoom: number,
  tileSize: number = DEFAULT_TILE_SIZE,
): [number, number] {
  const lng = 360 / worldSizeAtZoom(zoom, tileSize);
  return [lng, lng * cosLatitude(latitude)];
}

/**
 * The degrees of longitude and of latitude of a meter east and a meter north on the plane
 * tangent to the sphere at a latitude
 *
 * @param latitude - The latitude in degrees
 * @returns `[longitude, latitude]` in degrees per meter
 */
export function degreesPerMeterAt(latitude: number): [number, number] {
  const north = DEGREES_PER_RADIAN / EARTH_RADIUS_METERS;
  return [north / cosLatitude(latitude), north];
}

/**
 * The position at a distance east and north of another, on the plane tangent to the sphere there
 *
 * @param origin - The position, `[lng, lat]` in degrees
 * @param eastMeters - The distance east, in meters
 * @param northMeters - The distance north, in meters
 */
export function offsetOnTangentPlane(
  origin: readonly [number, number] | Coordinate,
  eastMeters: number,
  northMeters: number,
): Coordinate {
  const [lngPerMeter, latPerMeter] = degreesPerMeterAt(origin[1]);
  return [origin[0] + eastMeters * lngPerMeter, origin[1] + northMeters * latPerMeter];
}

/**
 * The distances east and north from a position to another, on the plane tangent to the sphere at
 * the first (the inverse of {@link offsetOnTangentPlane})
 *
 * @returns `[east, north]` in meters
 */
export function metersOnTangentPlane(
  origin: readonly [number, number] | Coordinate,
  position: readonly [number, number] | Coordinate,
): [number, number] {
  const [lngPerMeter, latPerMeter] = degreesPerMeterAt(origin[1]);
  return [(position[0] - origin[0]) / lngPerMeter, (position[1] - origin[1]) / latPerMeter];
}
