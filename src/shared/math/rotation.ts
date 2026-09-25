// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Spherical rotation utilities (ECEF coordinate system)
 *
 * Provides rotation computation in the ECEF coordinate system, accounting for the WGS84
 * ellipsoid.
 *
 * Implemented with standard geodetic computation: Rodrigues' rotation formula and the ECEF
 * conversion on the WGS84 ellipsoid (the inverse conversion uses Bowring's method).
 */

import type { Coordinate } from '../types/model.js';
import { getMetersPerPixel, toDegrees, toRadians } from './distance.js';

/**
 * WGS84 ellipsoid parameters
 */
const WGS84_SEMI_MAJOR_AXIS = 6378137.0; // Equatorial radius (meters)
const WGS84_ECCENTRICITY_SQUARED = 6.69437999014e-3; // Square of the first eccentricity

/**
 * ECEF coordinate (3D Cartesian coordinate)
 */
interface ECEFCoordinate {
  x: number;
  y: number;
  z: number;
}

/**
 * Converts a WGS84 coordinate into an ECEF coordinate (accounting for the ellipsoid)
 *
 * @param coord WGS84 coordinate [lng, lat]
 * @returns ECEF coordinate {x, y, z} (in meters)
 */
export function wgs84ToECEF(coord: Coordinate): ECEFCoordinate {
  const lat = toRadians(coord[1]);
  const lng = toRadians(coord[0]);

  // Prime vertical radius of curvature
  const N = WGS84_SEMI_MAJOR_AXIS / Math.sqrt(1 - WGS84_ECCENTRICITY_SQUARED * Math.sin(lat) ** 2);

  return {
    x: N * Math.cos(lat) * Math.cos(lng),
    y: N * Math.cos(lat) * Math.sin(lng),
    z: N * (1 - WGS84_ECCENTRICITY_SQUARED) * Math.sin(lat),
  };
}

/**
 * Converts an ECEF coordinate into a WGS84 coordinate (iterative computation by Bowring's
 * method)
 *
 * @param x ECEF X coordinate (meters)
 * @param y ECEF Y coordinate (meters)
 * @param z ECEF Z coordinate (meters)
 * @returns WGS84 coordinate [lng, lat]
 */
export function ecefToWGS84(x: number, y: number, z: number): Coordinate {
  // The longitude can be computed directly
  const lng = Math.atan2(y, x);

  // Iterative computation of the latitude (Bowring's method)
  const p = Math.sqrt(x * x + y * y);
  const e2 = WGS84_ECCENTRICITY_SQUARED;
  const a = WGS84_SEMI_MAJOR_AXIS;

  // Initial value
  let lat = Math.atan2(z, p * (1 - e2));

  // Iterative computation (usually converges in 2-3 rounds)
  for (let i = 0; i < 5; i++) {
    const sinLat = Math.sin(lat);
    const N = a / Math.sqrt(1 - e2 * sinLat * sinLat);
    const newLat = Math.atan2(z + e2 * N * sinLat, p);

    if (Math.abs(newLat - lat) < 1e-12) {
      break;
    }
    lat = newLat;
  }

  return [toDegrees(lng), toDegrees(lat)];
}

/**
 * Rotates a single coordinate about the center point as the axis (ECEF coordinate system,
 * Rodrigues' formula)
 *
 * @param coord The coordinate to rotate [lng, lat]
 * @param center Center point of the rotation [lng, lat]
 * @param angleDegrees Rotation angle (degrees, counter-clockwise)
 * @returns The coordinate after rotation [lng, lat]
 */
export function rotateCoordinateOnSphere(
  coord: Coordinate,
  center: Coordinate,
  angleDegrees: number,
): Coordinate {
  const angleRad = toRadians(angleDegrees);

  // Rotation axis: the normal vector from the center point to the center of the Earth
  // (ECEF coordinate system)
  const centerLatRad = toRadians(center[1]);
  const centerLngRad = toRadians(center[0]);

  const axisX = Math.cos(centerLatRad) * Math.cos(centerLngRad);
  const axisY = Math.cos(centerLatRad) * Math.sin(centerLngRad);
  const axisZ = Math.sin(centerLatRad);

  // Convert the WGS84 coordinate into ECEF (3D Cartesian coordinates)
  const latRad = toRadians(coord[1]);
  const lngRad = toRadians(coord[0]);

  const vx = Math.cos(latRad) * Math.cos(lngRad);
  const vy = Math.cos(latRad) * Math.sin(lngRad);
  const vz = Math.sin(latRad);

  // Rodrigues' rotation formula
  // v_rotated = v*cos(θ) + (k×v)*sin(θ) + k*(k·v)*(1-cos(θ))

  // Cross product k×v
  const crossX = axisY * vz - axisZ * vy;
  const crossY = axisZ * vx - axisX * vz;
  const crossZ = axisX * vy - axisY * vx;

  // Dot product k·v
  const dotProduct = axisX * vx + axisY * vy + axisZ * vz;

  // Apply the rotation
  const cosAngle = Math.cos(angleRad);
  const sinAngle = Math.sin(angleRad);
  const oneMinusCos = 1 - cosAngle;

  const rotatedX = vx * cosAngle + crossX * sinAngle + axisX * dotProduct * oneMinusCos;
  const rotatedY = vy * cosAngle + crossY * sinAngle + axisY * dotProduct * oneMinusCos;
  const rotatedZ = vz * cosAngle + crossZ * sinAngle + axisZ * dotProduct * oneMinusCos;

  // Inverse conversion from ECEF into a WGS84 coordinate (unit sphere approximation)
  const newLat = toDegrees(Math.asin(rotatedZ));
  const newLng = toDegrees(Math.atan2(rotatedY, rotatedX));

  return [newLng, newLat];
}

/**
 * Rotates multiple coordinates about the center point as the axis (ECEF coordinate system,
 * Rodrigues' formula)
 *
 * @param coords Array of coordinates to rotate
 * @param center Center point of the rotation [lng, lat]
 * @param angleDegrees Rotation angle (degrees, counter-clockwise)
 * @returns Array of coordinates after rotation
 */
export function rotateCoordinatesOnSphere(
  coords: readonly Coordinate[],
  center: Coordinate,
  angleDegrees: number,
): Coordinate[] {
  return coords.map((coord) => rotateCoordinateOnSphere(coord, center, angleDegrees));
}

/**
 * Kilometers per degree of latitude
 */
const KILOMETERS_PER_DEGREE_LATITUDE = 111.32;

/**
 * Converts kilometers into degrees (with a latitude correction)
 *
 * @param km Distance (kilometers)
 * @param latitude Reference latitude
 * @returns Degrees
 */
export function kmToDegrees(km: number, latitude: number): number {
  // Distance of 1 degree of latitude
  const latDegrees = km / KILOMETERS_PER_DEGREE_LATITUDE;

  // The distance of 1 degree of longitude varies with the latitude
  const lngDegrees = km / (KILOMETERS_PER_DEGREE_LATITUDE * Math.cos(toRadians(latitude)));

  // Use the larger one to be safe
  return Math.max(latDegrees, lngDegrees);
}

/**
 * Converts pixels into degrees (with a latitude correction)
 *
 * @param pixels Number of pixels
 * @param latitude Reference latitude
 * @param zoom Zoom level
 * @param tileSize Tile size (default 512)
 * @returns Degrees
 */
export function pixelsToDegrees(
  pixels: number,
  latitude: number,
  zoom: number,
  tileSize = 512,
): { lngDegrees: number; latDegrees: number } {
  // Meters per pixel
  const metersPerPixel = getMetersPerPixel(latitude, zoom, tileSize);

  // Convert meters into kilometers
  const km = (pixels * metersPerPixel) / 1000;

  // Convert kilometers into degrees (it differs between longitude and latitude)
  const latDegrees = km / KILOMETERS_PER_DEGREE_LATITUDE;
  const lngDegrees = km / (KILOMETERS_PER_DEGREE_LATITUDE * Math.cos(toRadians(latitude)));

  return { lngDegrees, latDegrees };
}

/**
 * Computes the vertices of a quad with a rotation applied (uses spherical rotation)
 *
 * @param centerLng Center longitude
 * @param centerLat Center latitude
 * @param halfWidthDeg Half width (degrees) - in the longitude direction
 * @param halfHeightDeg Half height (degrees) - in the latitude direction
 * @param rotationDeg Rotation angle (degrees, counter-clockwise)
 * @returns The 4 vertices of the quad [topLeft, topRight, bottomLeft, bottomRight]
 */
export function computeRotatedQuadCorners(
  centerLng: number,
  centerLat: number,
  halfWidthDeg: number,
  halfHeightDeg: number,
  rotationDeg: number,
): { topLeft: Coordinate; topRight: Coordinate; bottomLeft: Coordinate; bottomRight: Coordinate } {
  const center: Coordinate = [centerLng, centerLat];

  // Local coordinates before rotation (positions relative to the center, in degrees)
  // Geographic coordinate system: north is positive (up), south is negative (down)
  const corners: Coordinate[] = [
    [centerLng - halfWidthDeg, centerLat + halfHeightDeg], // top-left (northwest)
    [centerLng + halfWidthDeg, centerLat + halfHeightDeg], // top-right (northeast)
    [centerLng - halfWidthDeg, centerLat - halfHeightDeg], // bottom-left (southwest)
    [centerLng + halfWidthDeg, centerLat - halfHeightDeg], // bottom-right (southeast)
  ];

  if (rotationDeg === 0) {
    return {
      topLeft: corners[0],
      topRight: corners[1],
      bottomLeft: corners[2],
      bottomRight: corners[3],
    };
  }

  // Apply the spherical rotation
  const rotatedCorners = rotateCoordinatesOnSphere(corners, center, rotationDeg);

  return {
    topLeft: rotatedCorners[0],
    topRight: rotatedCorners[1],
    bottomLeft: rotatedCorners[2],
    bottomRight: rotatedCorners[3],
  };
}
