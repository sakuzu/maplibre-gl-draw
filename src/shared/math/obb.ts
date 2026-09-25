// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * OBB (Oriented Bounding Box)
 *
 * Computation and hit testing of a bounding box that includes rotation.
 */

import type { Coordinate } from '../types/model.js';

/**
 * Definition of an OBB
 */
export interface OBB {
  /** The center [lng, lat] */
  center: Coordinate;
  /** Half the width, in degrees */
  halfWidth: number;
  /** Half the height, in degrees */
  halfHeight: number;
  /** The rotation angle, in radians */
  rotation: number;
}

/**
 * Creates an OBB
 *
 * @param centerLng Center longitude
 * @param centerLat Center latitude
 * @param width Width (degrees)
 * @param height Height (degrees)
 * @param rotationDeg Rotation angle (degrees, counter-clockwise)
 * @returns OBB
 */
export function createOBB(
  centerLng: number,
  centerLat: number,
  width: number,
  height: number,
  rotationDeg: number,
): OBB {
  return {
    center: [centerLng, centerLat],
    halfWidth: width / 2,
    halfHeight: height / 2,
    rotation: (rotationDeg * Math.PI) / 180,
  };
}

/**
 * Tests whether a point is inside an OBB
 *
 * @param obb OBB
 * @param point The point to test [lng, lat]
 * @returns true when it is inside the OBB
 */
export function pointInOBB(obb: OBB, point: Coordinate): boolean {
  // Convert the point into the local coordinate system of the OBB
  const dx = point[0] - obb.center[0];
  const dy = point[1] - obb.center[1];

  // Apply the inverse rotation
  const cos = Math.cos(-obb.rotation);
  const sin = Math.sin(-obb.rotation);
  const localX = dx * cos - dy * sin;
  const localY = dx * sin + dy * cos;

  // AABB test in the local coordinate system
  return Math.abs(localX) <= obb.halfWidth && Math.abs(localY) <= obb.halfHeight;
}

/**
 * Computes the distance from a point to an OBB
 *
 * @param obb OBB
 * @param point Point [lng, lat]
 * @returns Distance (degrees). 0 when inside the OBB
 */
export function distanceToOBB(obb: OBB, point: Coordinate): number {
  // Convert the point into the local coordinate system of the OBB
  const dx = point[0] - obb.center[0];
  const dy = point[1] - obb.center[1];

  // Apply the inverse rotation
  const cos = Math.cos(-obb.rotation);
  const sin = Math.sin(-obb.rotation);
  const localX = dx * cos - dy * sin;
  const localY = dx * sin + dy * cos;

  // 0 when inside the OBB
  if (Math.abs(localX) <= obb.halfWidth && Math.abs(localY) <= obb.halfHeight) {
    return 0;
  }

  // Compute the closest point
  const clampedX = Math.max(-obb.halfWidth, Math.min(obb.halfWidth, localX));
  const clampedY = Math.max(-obb.halfHeight, Math.min(obb.halfHeight, localY));

  // Compute the distance
  const distX = localX - clampedX;
  const distY = localY - clampedY;
  return Math.sqrt(distX * distX + distY * distY);
}

/**
 * Gets the 4 vertices of an OBB
 *
 * @param obb OBB
 * @returns Array of the 4 vertices [topLeft, topRight, bottomRight, bottomLeft]
 */
export function getOBBCorners(obb: OBB): Coordinate[] {
  const cos = Math.cos(obb.rotation);
  const sin = Math.sin(obb.rotation);

  // The 4 vertices in the local coordinate system
  const corners = [
    [-obb.halfWidth, -obb.halfHeight], // top-left
    [obb.halfWidth, -obb.halfHeight], // top-right
    [obb.halfWidth, obb.halfHeight], // bottom-right
    [-obb.halfWidth, obb.halfHeight], // bottom-left
  ];

  // Apply the rotation and convert into global coordinates
  return corners.map(([x, y]) => {
    const rx = x * cos - y * sin;
    const ry = x * sin + y * cos;
    return [obb.center[0] + rx, obb.center[1] + ry] as Coordinate;
  });
}

/**
 * Gets the AABB (Axis-Aligned Bounding Box) of an OBB
 *
 * @param obb OBB
 * @returns AABB { minX, minY, maxX, maxY }
 */
export function getOBBAABB(obb: OBB): { minX: number; minY: number; maxX: number; maxY: number } {
  const corners = getOBBCorners(obb);

  const lngs = corners.map((c) => c[0]);
  const lats = corners.map((c) => c[1]);

  return {
    minX: Math.min(...lngs),
    minY: Math.min(...lats),
    maxX: Math.max(...lngs),
    maxY: Math.max(...lats),
  };
}
