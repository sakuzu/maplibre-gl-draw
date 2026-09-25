// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Bounding box
 *
 * Lightweight tests used as the preliminary check of the predicates. Crossing the
 * ±180 degree meridian is not handled.
 */

import { flattenAreaCoordinates, isFiniteCoordinate } from './coords.js';
import type { AreaCoordinates, BBox, Coordinate } from './types.js';

/**
 * Computes the bounding box of a coordinate sequence.
 *
 * A coordinate whose longitude or latitude is not a finite number is skipped. Crossing the
 * ±180 degree meridian is not handled: the box spans the plain minimum and maximum
 * longitudes.
 *
 * @param coordinates Positions `[lng, lat]` in degrees
 * @returns `[minLng, minLat, maxLng, maxLat]` in degrees. `null` when there is not a single
 *   finite coordinate (an empty array included)
 *
 * @example
 * ```ts
 * import { coordinatesBBox } from '@sakuzu/maplibre-gl-draw/geometry';
 *
 * coordinatesBBox([[139.7, 35.6], [139.8, 35.7]]); // [139.7, 35.6, 139.8, 35.7]
 * coordinatesBBox([]); // null
 * ```
 */
export function coordinatesBBox(coordinates: Coordinate[]): BBox | null {
  let found = false;
  let minLng = Number.POSITIVE_INFINITY;
  let minLat = Number.POSITIVE_INFINITY;
  let maxLng = Number.NEGATIVE_INFINITY;
  let maxLat = Number.NEGATIVE_INFINITY;

  for (const coordinate of coordinates) {
    if (!isFiniteCoordinate(coordinate)) continue;
    found = true;
    const [lng, lat] = coordinate;
    if (lng < minLng) minLng = lng;
    if (lat < minLat) minLat = lat;
    if (lng > maxLng) maxLng = lng;
    if (lat > maxLat) maxLat = lat;
  }

  return found ? [minLng, minLat, maxLng, maxLat] : null;
}

/**
 * Computes the bounding box of Polygon or MultiPolygon coordinates.
 *
 * Every position of every ring, holes included, is taken into account; a position that is
 * not finite is skipped.
 *
 * @param coordinates Polygon or MultiPolygon coordinates in degrees
 * @returns `[minLng, minLat, maxLng, maxLat]` in degrees. `null` when there is not a single
 *   finite coordinate
 */
export function boundingBox(coordinates: AreaCoordinates): BBox | null {
  return coordinatesBBox(flattenAreaCoordinates(coordinates));
}

/**
 * Determines whether two bounding boxes overlap, touching included.
 *
 * @param a A box `[minLng, minLat, maxLng, maxLat]`
 * @param b A box `[minLng, minLat, maxLng, maxLat]`
 * @returns `true` when the boxes share at least one point, an edge or a corner included
 */
export function bboxIntersects(a: BBox, b: BBox): boolean {
  return !(a[2] < b[0] || b[2] < a[0] || a[3] < b[1] || b[3] < a[1]);
}

/**
 * Determines whether one bounding box contains another, coincident boundaries included.
 *
 * @param outer The containing box `[minLng, minLat, maxLng, maxLat]`
 * @param inner The contained box `[minLng, minLat, maxLng, maxLat]`
 * @returns `true` when every point of `inner` lies in `outer`. A box contains itself
 */
export function bboxContains(outer: BBox, inner: BBox): boolean {
  return (
    outer[0] <= inner[0] && outer[1] <= inner[1] && outer[2] >= inner[2] && outer[3] >= inner[3]
  );
}
