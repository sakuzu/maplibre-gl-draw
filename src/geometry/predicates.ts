// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Predicates
 *
 * A test between polygons returns false early with the preliminary check on the bbox
 * before proceeding to the topological test by polygon-clipping. Every test is
 * area-based, so a touch that shares only the boundary is not regarded as an
 * intersection.
 */

import { bboxContains, bboxIntersects, boundingBox } from './bbox.js';
import { difference, intersection, normalizeArea } from './boolean.js';
import { toMultiPolygonCoordinates } from './coords.js';
import type { AreaCoordinates, Coordinate, Ring } from './types.js';

/**
 * Whether a point is inside a ring (ray casting; the treatment on the boundary is
 * undefined)
 */
function pointInRing(point: Coordinate, ring: Ring): boolean {
  const [x, y] = point;
  let inside = false;

  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];

    // Whether the scanline y crosses the edge (counted on a half-open interval, which
    // avoids double-counting a vertex)
    if (yi > y !== yj > y) {
      const t = (y - yi) / (yj - yi);
      if (x < xi + t * (xj - xi)) {
        inside = !inside;
      }
    }
  }

  return inside;
}

/**
 * Determines whether a point is inside a polygon, holes taken into account.
 *
 * The test is ray casting on the lng/lat plane; the result for a point exactly on the
 * boundary is undefined. Ring orientation does not matter. No boolean operation is run, so
 * it never throws.
 *
 * @param point The position `[lng, lat]` in degrees
 * @param polygon Polygon or MultiPolygon coordinates in degrees
 * @returns `true` when the point is inside an outer ring and inside none of its holes (in
 *   any part of a MultiPolygon). `false` for empty coordinates
 */
export function pointInPolygon(point: Coordinate, polygon: AreaCoordinates): boolean {
  for (const part of toMultiPolygonCoordinates(polygon)) {
    if (part.length === 0 || !pointInRing(point, part[0])) {
      continue;
    }
    let inHole = false;
    for (let i = 1; i < part.length; i++) {
      if (pointInRing(point, part[i])) {
        inHole = true;
        break;
      }
    }
    if (!inHole) {
      return true;
    }
  }
  return false;
}

/**
 * Determines whether two polygons overlap with a positive area.
 *
 * A touch that shares only the boundary has no area, so it gives `false`. The bounding boxes
 * are compared first, and the boolean operation runs only when they overlap.
 *
 * @param a Polygon or MultiPolygon coordinates in degrees
 * @param b Polygon or MultiPolygon coordinates in degrees
 * @returns `true` when the common part has an area. `false` when either input has no
 *   finite position
 * @throws {@link GeometryError} when the boolean operation engine fails even after the
 *   retry on the 1e-9 degree grid
 */
export function intersects(a: AreaCoordinates, b: AreaCoordinates): boolean {
  const boxA = boundingBox(a);
  const boxB = boundingBox(b);
  if (boxA === null || boxB === null || !bboxIntersects(boxA, boxB)) {
    return false;
  }
  return intersection(a, b).length > 0;
}

/**
 * Determines whether one polygon completely contains another.
 *
 * Sharing the boundary is allowed. The bounding boxes are compared first.
 *
 * @param outer The containing Polygon or MultiPolygon coordinates, in degrees
 * @param inner The contained Polygon or MultiPolygon coordinates, in degrees
 * @returns `true` when no part of `inner` lies outside `outer`. `false` when `inner` has no
 *   area
 * @throws {@link GeometryError} when the boolean operation engine fails even after the
 *   retry on the 1e-9 degree grid
 */
export function contains(outer: AreaCoordinates, inner: AreaCoordinates): boolean {
  const boxOuter = boundingBox(outer);
  const boxInner = boundingBox(inner);
  if (boxOuter === null || boxInner === null || !bboxContains(boxOuter, boxInner)) {
    return false;
  }
  // When inner has no area, it is not subject to the test
  if (normalizeArea(inner).length === 0) {
    return false;
  }
  return difference(inner, outer).length === 0;
}

/**
 * Determines whether one polygon lies completely inside another; {@link contains} with its
 * arguments swapped.
 *
 * @param inner The contained Polygon or MultiPolygon coordinates, in degrees
 * @param outer The containing Polygon or MultiPolygon coordinates, in degrees
 * @returns `true` when no part of `inner` lies outside `outer`. `false` when `inner` has no
 *   area
 * @throws {@link GeometryError} when the boolean operation engine fails even after the
 *   retry on the 1e-9 degree grid
 */
export function within(inner: AreaCoordinates, outer: AreaCoordinates): boolean {
  return contains(outer, inner);
}
