// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Distance computation utilities
 */

import { toRadians } from '../../geometry/index.js';
import type { Coordinate } from '../types/model.js';
import { DEFAULT_TILE_SIZE, EARTH } from './constants.js';

// The actual angle conversion and geodesic distance live in the geometry module (single
// implementation)
export { haversineDistanceMeters, toDegrees, toRadians } from '../../geometry/index.js';

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
 * Conversion from meters to a longitude difference (latitude dependent)
 */
export function metersToLng(meters: number, latitude: number): number {
  const earthRadius = 6371000;
  const latRad = toRadians(latitude);
  return (meters / (earthRadius * Math.cos(latRad))) * (180 / Math.PI);
}

/**
 * Conversion from meters to a latitude difference
 */
export function metersToLat(meters: number): number {
  const earthRadius = 6371000;
  return (meters / earthRadius) * (180 / Math.PI);
}

/**
 * Conversion from a longitude difference to meters
 */
export function lngToMeters(lngDiff: number, latitude: number): number {
  const earthRadius = 6371000;
  const latRad = toRadians(latitude);
  return lngDiff * (Math.PI / 180) * earthRadius * Math.cos(latRad);
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

/**
 * Computes the number of meters per pixel at a zoom level
 *
 * @param latitude - Latitude (degrees)
 * @param zoom - Zoom level
 * @param tileSize - Tile size (default: 512)
 * @returns Number of meters per pixel
 */
export function getMetersPerPixel(
  latitude: number,
  zoom: number,
  tileSize: number = DEFAULT_TILE_SIZE,
): number {
  const latRad = latitude * EARTH.RADIANS_PER_DEGREE;
  return (EARTH.CIRCUMFERENCE_METERS * Math.cos(latRad)) / (tileSize * 2 ** zoom);
}

/**
 * Converts meters to degrees in the longitude direction
 *
 * @param meters - Number of meters
 * @param latitude - Latitude (degrees)
 * @returns Number of degrees in the longitude direction
 */
export function metersToDegreesLng(meters: number, latitude: number): number {
  const latRad = latitude * EARTH.RADIANS_PER_DEGREE;
  return meters / (EARTH.METERS_PER_DEGREE * Math.cos(latRad));
}

/**
 * Converts meters to degrees in the latitude direction
 *
 * @param meters - Number of meters
 * @returns Number of degrees in the latitude direction
 */
export function metersToDegreesLat(meters: number): number {
  return meters / EARTH.METERS_PER_DEGREE;
}

/**
 * Converts pixels to degrees in the longitude direction
 *
 * @param pixels - Number of pixels
 * @param latitude - Latitude (degrees)
 * @param zoom - Zoom level
 * @param tileSize - Tile size (default: 512)
 * @returns Number of degrees in the longitude direction
 */
export function pixelsToDegreesLng(
  pixels: number,
  latitude: number,
  zoom: number,
  tileSize: number = DEFAULT_TILE_SIZE,
): number {
  const latRad = latitude * EARTH.RADIANS_PER_DEGREE;
  const metersPerPixel = (EARTH.CIRCUMFERENCE_METERS * Math.cos(latRad)) / (tileSize * 2 ** zoom);
  const meters = pixels * metersPerPixel;
  return meters / (EARTH.METERS_PER_DEGREE * Math.cos(latRad));
}

/**
 * Converts pixels to degrees in the latitude direction
 *
 * @param pixels - Number of pixels
 * @param latitude - Latitude (degrees) - used for the latitude correction
 * @param zoom - Zoom level
 * @param tileSize - Tile size (default: 512)
 * @returns Number of degrees in the latitude direction
 */
export function pixelsToDegreesLat(
  pixels: number,
  latitude: number,
  zoom: number,
  tileSize: number = DEFAULT_TILE_SIZE,
): number {
  const latRad = latitude * EARTH.RADIANS_PER_DEGREE;
  const metersPerPixel = (EARTH.CIRCUMFERENCE_METERS * Math.cos(latRad)) / (tileSize * 2 ** zoom);
  const meters = pixels * metersPerPixel;
  return meters / EARTH.METERS_PER_DEGREE;
}
