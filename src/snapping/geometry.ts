// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Distance computation for snapping
 *
 * The tolerance is held in pixels. The conversion between pixels and degrees depends
 * on the latitude and the zoom (in Mercator, 1 pixel in the longitude direction is
 * constant regardless of the latitude, but in the latitude direction it shrinks by
 * cos(lat)). Distances are therefore also converted into pixels before being
 * compared.
 */

import { DEFAULT_TILE_SIZE, pixelsToDegreesLat, pixelsToDegreesLng } from '../shared/math/index.js';
import type { Coordinate } from '../store/types.js';

/**
 * Degrees per pixel
 *
 * @internal
 */
export interface DegreesPerPixel {
  /** In the longitude direction */
  lng: number;
  /** In the latitude direction */
  lat: number;
}

/**
 * Computes the degrees per pixel from the latitude of the cursor position and the
 * zoom
 *
 * @internal
 */
export function degreesPerPixel(
  latitude: number,
  zoom: number,
  tileSize: number = DEFAULT_TILE_SIZE,
): DegreesPerPixel {
  return {
    lng: pixelsToDegreesLng(1, latitude, zoom, tileSize),
    lat: pixelsToDegreesLat(1, latitude, zoom, tileSize),
  };
}

/**
 * Computes the distance between 2 points in pixels
 *
 * @internal
 */
export function distanceInPixels(a: Coordinate, b: Coordinate, perPixel: DegreesPerPixel): number {
  const dx = (a[0] - b[0]) / perPixel.lng;
  const dy = (a[1] - b[1]) / perPixel.lat;
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * Computes the point on a segment closest to the cursor
 *
 * The projection is done in pixel space (staying in degree space would distort the
 * longitude direction at high latitudes). The returned value never goes beyond the
 * end points of the segment.
 *
 * @internal
 */
export function nearestPointOnSegment(
  point: Coordinate,
  start: Coordinate,
  end: Coordinate,
  perPixel: DegreesPerPixel,
): Coordinate {
  const px = point[0] / perPixel.lng;
  const py = point[1] / perPixel.lat;
  const ax = start[0] / perPixel.lng;
  const ay = start[1] / perPixel.lat;
  const bx = end[0] / perPixel.lng;
  const by = end[1] / perPixel.lat;

  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;

  // A segment of length 0 is its start point itself
  if (lengthSquared === 0) {
    return [start[0], start[1]];
  }

  let t = ((px - ax) * dx + (py - ay) * dy) / lengthSquared;
  t = Math.max(0, Math.min(1, t));

  return [start[0] + t * (end[0] - start[0]), start[1] + t * (end[1] - start[1])];
}
