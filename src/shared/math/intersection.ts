// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Rectangle Intersection
 *
 * Intersection testing algorithms for box selection.
 * Provides intersection tests between the various geometries and an axis-aligned rectangle
 * (AABB).
 */

import type { BoundingBox, Coordinate } from '../types/model.js';

/**
 * Tests whether a point is inside a rectangle
 */
export function pointInRectangle(point: Coordinate, rect: BoundingBox): boolean {
  return (
    point[0] >= rect.minX && point[0] <= rect.maxX && point[1] >= rect.minY && point[1] <= rect.maxY
  );
}

/**
 * Intersection test between two segments
 *
 * Uses the CCW (Counter-Clockwise) algorithm.
 */
export function segmentIntersectsSegment(
  a1: Coordinate,
  a2: Coordinate,
  b1: Coordinate,
  b2: Coordinate,
): boolean {
  // CCW test function
  const ccw = (p1: Coordinate, p2: Coordinate, p3: Coordinate): number => {
    return (p2[0] - p1[0]) * (p3[1] - p1[1]) - (p2[1] - p1[1]) * (p3[0] - p1[0]);
  };

  const d1 = ccw(a1, a2, b1);
  const d2 = ccw(a1, a2, b2);
  const d3 = ccw(b1, b2, a1);
  const d4 = ccw(b1, b2, a2);

  // Condition under which the segments intersect
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) {
    return true;
  }

  // When an endpoint lies on the other segment
  const onSegment = (p: Coordinate, q: Coordinate, r: Coordinate): boolean => {
    return (
      q[0] <= Math.max(p[0], r[0]) &&
      q[0] >= Math.min(p[0], r[0]) &&
      q[1] <= Math.max(p[1], r[1]) &&
      q[1] >= Math.min(p[1], r[1])
    );
  };

  if (d1 === 0 && onSegment(a1, b1, a2)) return true;
  if (d2 === 0 && onSegment(a1, b2, a2)) return true;
  if (d3 === 0 && onSegment(b1, a1, b2)) return true;
  if (d4 === 0 && onSegment(b1, a2, b2)) return true;

  return false;
}

/**
 * Tests whether a segment intersects a rectangle
 */
export function segmentIntersectsRectangle(
  p1: Coordinate,
  p2: Coordinate,
  rect: BoundingBox,
): boolean {
  // When either endpoint is inside the rectangle
  if (pointInRectangle(p1, rect) || pointInRectangle(p2, rect)) {
    return true;
  }

  // Intersection test against the 4 edges of the rectangle
  const corners: Coordinate[] = [
    [rect.minX, rect.minY],
    [rect.maxX, rect.minY],
    [rect.maxX, rect.maxY],
    [rect.minX, rect.maxY],
  ];

  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    if (segmentIntersectsSegment(p1, p2, corners[i], corners[j])) {
      return true;
    }
  }

  return false;
}

/**
 * Intersection test between a rectangle and a LineString
 *
 * Returns true when any vertex of the LineString is inside the rectangle, or when any of its
 * edges intersects the rectangle.
 */
export function rectangleIntersectsLineString(
  rect: BoundingBox,
  lineString: Coordinate[],
): boolean {
  if (lineString.length === 0) return false;

  // When any vertex is inside the rectangle
  for (const coord of lineString) {
    if (pointInRectangle(coord, rect)) {
      return true;
    }
  }

  // When any edge intersects the rectangle
  for (let i = 0; i < lineString.length - 1; i++) {
    if (segmentIntersectsRectangle(lineString[i], lineString[i + 1], rect)) {
      return true;
    }
  }

  return false;
}

/**
 * Tests whether a point is inside a polygon (Ray Casting algorithm)
 */
function pointInPolygon(point: Coordinate, ring: Coordinate[]): boolean {
  let inside = false;
  const x = point[0];
  const y = point[1];

  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];

    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }

  return inside;
}

/**
 * Intersection test between a rectangle and a Polygon
 *
 * Returns true when any of the following conditions holds:
 * 1. Any vertex of the polygon is inside the rectangle
 * 2. Any vertex of the rectangle is inside the polygon
 * 3. Any edge of the polygon intersects the rectangle
 */
export function rectangleIntersectsPolygon(rect: BoundingBox, polygon: Coordinate[][]): boolean {
  if (polygon.length === 0 || polygon[0].length === 0) return false;

  const outerRing = polygon[0];

  // 1. Any vertex of the polygon is inside the rectangle
  for (const coord of outerRing) {
    if (pointInRectangle(coord, rect)) {
      return true;
    }
  }

  // 2. Any vertex of the rectangle is inside the polygon
  const rectCorners: Coordinate[] = [
    [rect.minX, rect.minY],
    [rect.maxX, rect.minY],
    [rect.maxX, rect.maxY],
    [rect.minX, rect.maxY],
  ];

  for (const corner of rectCorners) {
    if (pointInPolygon(corner, outerRing)) {
      return true;
    }
  }

  // 3. Any edge of the polygon intersects the rectangle
  for (let i = 0; i < outerRing.length - 1; i++) {
    if (segmentIntersectsRectangle(outerRing[i], outerRing[i + 1], rect)) {
      return true;
    }
  }

  // The edge that joins the last vertex to the first vertex
  if (
    outerRing.length > 1 &&
    segmentIntersectsRectangle(outerRing[outerRing.length - 1], outerRing[0], rect)
  ) {
    return true;
  }

  return false;
}

/**
 * Intersection test between a rectangle and a Circle
 *
 * Returns true when the center of the circle is inside the rectangle, or when an edge or a
 * vertex of the rectangle intersects the circle.
 *
 * @param rect Selection rectangle (geographic coordinates)
 * @param center Center of the circle (geographic coordinates)
 * @param radiusInDegrees Radius of the circle (in degrees)
 */
export function rectangleIntersectsCircle(
  rect: BoundingBox,
  center: Coordinate,
  radiusInDegrees: number,
): boolean {
  // When the center of the circle is inside the rectangle
  if (pointInRectangle(center, rect)) {
    return true;
  }

  // Compute the closest point of the rectangle
  const closestX = Math.max(rect.minX, Math.min(center[0], rect.maxX));
  const closestY = Math.max(rect.minY, Math.min(center[1], rect.maxY));

  // Compute the distance between the closest point and the center of the circle
  const dx = center[0] - closestX;
  const dy = center[1] - closestY;
  const distanceSquared = dx * dx + dy * dy;

  // They intersect if the distance is at most the radius
  return distanceSquared <= radiusInDegrees * radiusInDegrees;
}

/**
 * Type definition of an OBB (Oriented Bounding Box)
 */
export interface OBBCorners {
  /** The 4 vertices of the OBB (counter-clockwise) */
  corners: Coordinate[];
}

/**
 * Intersection test between an AABB and an OBB (Separating Axis Theorem: SAT)
 *
 * @param rect Axis-aligned bounding box (AABB)
 * @param obb Bounding box that accounts for rotation (OBB)
 */
export function rectangleIntersectsOBB(rect: BoundingBox, obb: OBBCorners): boolean {
  if (obb.corners.length !== 4) return false;

  // Convert the AABB into an array of vertices
  const rectCorners: Coordinate[] = [
    [rect.minX, rect.minY],
    [rect.maxX, rect.minY],
    [rect.maxX, rect.maxY],
    [rect.minX, rect.maxY],
  ];

  // Get the separating axes (the 2 axes of the AABB + the 2 axes of the OBB)
  const axes: Coordinate[] = [
    // Axes of the AABB (always the X axis and the Y axis)
    [1, 0],
    [0, 1],
    // Axes of the OBB (derived from its edges)
    normalize([obb.corners[1][0] - obb.corners[0][0], obb.corners[1][1] - obb.corners[0][1]]),
    normalize([obb.corners[3][0] - obb.corners[0][0], obb.corners[3][1] - obb.corners[0][1]]),
  ];

  // Check for separation along each axis
  for (const axis of axes) {
    const [minA, maxA] = projectPolygon(rectCorners, axis);
    const [minB, maxB] = projectPolygon(obb.corners, axis);

    // When the projections do not overlap, a separating axis has been found
    if (maxA < minB || maxB < minA) {
      return false;
    }
  }

  // When they overlap on every axis, they intersect
  return true;
}

/**
 * Normalizes a vector
 */
function normalize(v: Coordinate): Coordinate {
  const len = Math.sqrt(v[0] * v[0] + v[1] * v[1]);
  if (len === 0) return [1, 0];
  return [v[0] / len, v[1] / len];
}

/**
 * Projects a polygon onto an axis and returns the minimum and maximum values
 */
function projectPolygon(corners: Coordinate[], axis: Coordinate): [number, number] {
  let min = corners[0][0] * axis[0] + corners[0][1] * axis[1];
  let max = min;

  for (let i = 1; i < corners.length; i++) {
    const p = corners[i][0] * axis[0] + corners[i][1] * axis[1];
    if (p < min) min = p;
    if (p > max) max = p;
  }

  return [min, max];
}
