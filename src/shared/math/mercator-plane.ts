// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The plane of Web Mercator, as a coordinate of the drawing
 *
 * The plane is maplibre's world coordinate (0 to 1 across the world) with y pointing north.
 * Longitude is linear and not wrapped. Latitude is clamped to the Web Mercator limit
 * (±85.051129 degrees), beyond which the map draws nothing and the projection reaches infinity at
 * the poles. The drawing cuts the edges it lays on the globe in it (`globe-subdivision.ts`); the
 * edits that move, rotate and scale features are not computed in it (`geometry/enu-transforms.ts`).
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
