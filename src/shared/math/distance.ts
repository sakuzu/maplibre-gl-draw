// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Distance computation utilities
 */

import type { Coordinate } from '../types/model.js';

// The actual angle conversion and geodesic distance live in the geometry module (single
// implementation)
export { haversineDistanceMeters } from '../../geometry/distance.js';
export { toDegrees, toRadians } from '../../geometry/units.js';

/**
 * Distance between two points (a simple version that returns a distance in degrees from
 * coordinates in degrees)
 *
 * For approximate computation at small scales. Use haversineDistanceMeters when an accurate
 * distance is required.
 */
export function euclideanDistance(coord1: Coordinate, coord2: Coordinate): number {
  const [lng1, lat1] = coord1;
  const [lng2, lat2] = coord2;
  const dLng = lng2 - lng1;
  const dLat = lat2 - lat1;
  return Math.sqrt(dLng * dLng + dLat * dLat);
}

/**
 * Computes the midpoint of two points
 */
export function midpoint(coord1: Coordinate, coord2: Coordinate): Coordinate {
  return [(coord1[0] + coord2[0]) / 2, (coord1[1] + coord2[1]) / 2];
}

/**
 * Computes the shortest distance from a point to a segment
 */
export function pointToSegmentDistance(
  point: Coordinate,
  segmentStart: Coordinate,
  segmentEnd: Coordinate,
): number {
  const [px, py] = point;
  const [ax, ay] = segmentStart;
  const [bx, by] = segmentEnd;

  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;

  if (lengthSquared === 0) {
    // When the segment is a point
    return euclideanDistance(point, segmentStart);
  }

  // Compute the parameter t (the position of the closest point on the segment)
  let t = ((px - ax) * dx + (py - ay) * dy) / lengthSquared;
  t = Math.max(0, Math.min(1, t));

  // Coordinate of the closest point
  const closestPoint: Coordinate = [ax + t * dx, ay + t * dy];
  return euclideanDistance(point, closestPoint);
}

/**
 * Computes the shortest distance from a point to a polyline (a sequence of segments)
 */
export function pointToPolylineDistance(point: Coordinate, line: Coordinate[]): number {
  let minDistance = Number.POSITIVE_INFINITY;

  for (let i = 0; i < line.length - 1; i++) {
    const distance = pointToSegmentDistance(point, line[i], line[i + 1]);
    minDistance = Math.min(minDistance, distance);
  }

  return minDistance;
}
