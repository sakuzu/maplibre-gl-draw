// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The plane the transform operations work in
 *
 * Resize and rotate compute in Web Mercator, the plane the map is drawn in, so a transform
 * does on the map what the pointer does on the screen (at any latitude and size, with no
 * local cos φ approximation that changes the shape a little on every rotation). The plane is
 * maplibre's world coordinate (0 to 1 across the world) with y pointing north, so an angle
 * measured in it is counterclockwise like the old lng/lat angle. Longitude is linear and not
 * wrapped. Latitude is clamped to the Web Mercator limit (±85.051129 degrees), beyond which
 * the map draws nothing and the projection reaches infinity at the poles.
 */

import type { Coordinate } from '../types/model.js';

/** The latitude limit of Web Mercator (degrees) */
const MAX_MERCATOR_LATITUDE = 85.0511287798066;

/**
 * Converts a longitude/latitude into the transform plane
 *
 * @param coord [lng, lat]
 * @returns [x, y] in world units (1 = the width of the world), y pointing north
 */
export function toPlane(coord: Coordinate): [number, number] {
  const lat = Math.max(-MAX_MERCATOR_LATITUDE, Math.min(MAX_MERCATOR_LATITUDE, coord[1]));
  const phi = (lat * Math.PI) / 180;
  return [coord[0] / 360, Math.log(Math.tan(Math.PI / 4 + phi / 2)) / (2 * Math.PI)];
}

/**
 * Converts a point of the transform plane back into a longitude/latitude
 *
 * @param x World units east
 * @param y World units north
 * @returns [lng, lat]
 */
export function fromPlane(x: number, y: number): Coordinate {
  const lat = (2 * Math.atan(Math.exp(y * 2 * Math.PI)) - Math.PI / 2) * (180 / Math.PI);
  return [x * 360, lat];
}
