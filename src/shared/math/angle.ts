// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Angle computation utilities
 *
 * Angle computation functions used when rendering circle features and when manipulating the
 * radius handle.
 */

import type { Coordinate } from '../types/model.js';
import { toRadians } from './distance.js';

// The actual generation of a coordinate from a bearing lives in the geometry module (single
// implementation)
export { getPointAtAngle } from '../../geometry/index.js';

/**
 * Computes the angle between two points (the bearing as seen from the center)
 *
 * The planar inverse of {@link getPointAtAngle}: the longitude difference is scaled by cos of
 * the center latitude. It is not the great-circle bearing, so a point placed with
 * destinationPoint (circles, buffers and the radius handle) must take its bearing from
 * initialBearingDegrees in the geometry module instead.
 *
 * @param center Center coordinate
 * @param point Coordinate of the target point
 * @returns Angle (degrees, clockwise with north as 0, 0-360)
 */
export function getAngleFromCenter(center: Coordinate, point: Coordinate): number {
  const [lng1, lat1] = center;
  const [lng2, lat2] = point;

  // Latitude correction
  const latRad = toRadians(lat1);
  const dLng = (lng2 - lng1) * Math.cos(latRad);
  const dLat = lat2 - lat1;

  // Compute the angle with atan2 (clockwise with north as 0 degrees)
  // atan2 takes east as positive, so convert it to be based on north
  let angle = Math.atan2(dLng, dLat) * (180 / Math.PI);

  // Normalize into the range 0-360
  if (angle < 0) {
    angle += 360;
  }

  return angle;
}
