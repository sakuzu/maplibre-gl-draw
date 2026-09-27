// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Create: the public functions that build polygons from distances in meters
 */

import type { Geometry, MultiPolygon, Point, Polygon, Position } from 'geojson';
import { unionAll } from './boolean.js';
import { buffer as bufferCoordinates } from './buffer.js';
import { generateCirclePolygon } from './circle.js';
import { invalidInput, withOperation } from './errors.js';
import { geometryOf, positionOf, toAreaGeometry, toPosition } from './geojson.js';
import type { GeometryInput, MultiPolygonCoordinates } from './types.js';

/**
 * Returns a polygon that approximates the geodesic circle of a radius in meters around a
 * center.
 *
 * @param center The center, a position `[lng, lat]` in degrees or a Point
 * @param radiusMeters The radius in meters, 0 or more. Every vertex lies at this great-circle
 *   distance from the center
 * @param options `segments`, the number of vertices (64 by default, rounded down and clamped
 *   to 3-1024)
 * @returns The Polygon, its ring starting due north of the center and running
 *   counter-clockwise, with the first position repeated at the end
 * @throws {@link GeometryError} (`invalid-input`) when the center is not a position or a
 *   Point or is not finite, and when the radius is negative or not finite
 */
export function circle(
  center: Position | Point,
  radiusMeters: number,
  options?: { segments?: number },
): Polygon {
  const ring = generateCirclePolygon(positionOf(center, 'circle'), radiusMeters, options?.segments);
  if (ring.length === 0) {
    throw invalidInput('circle', 'the center or the radius is not a finite number');
  }
  return { type: 'Polygon', coordinates: [ring.map(toPosition).reverse()] };
}

/** The buffer of a geometry as MultiPolygon coordinates, each member of a collection alone */
function bufferOf(
  geometry: Geometry,
  distanceMeters: number,
  segments: number | undefined,
): MultiPolygonCoordinates {
  if (geometry.type === 'GeometryCollection') {
    return unionAll(
      geometry.geometries.map((member) =>
        bufferOf(geometryOf(member, 'buffer'), distanceMeters, segments),
      ),
    );
  }
  return bufferCoordinates(geometry as GeometryInput, distanceMeters, { segments }) ?? [];
}

/**
 * Returns the area within a distance in meters of a geometry, or a polygon shrunk by it when
 * the distance is negative.
 *
 * @param geometry The geometry, or a feature whose geometry it is; coordinates in degrees. The
 *   members of a GeometryCollection are buffered one by one and the results merged
 * @param distanceMeters The distance in meters. A negative distance shrinks a polygon and
 *   leaves nothing of a point or a line
 * @param options `segments`, the number of segments of each circle (64 by default, rounded
 *   down and clamped to 3-1024)
 * @returns A Polygon, or a MultiPolygon when the area falls apart. null when nothing remains,
 *   and when a vertex is so close to a pole or an edge so long in longitude (over 180 degrees)
 *   that the area cannot be drawn in longitude and latitude
 * @throws {@link GeometryError} (`invalid-input`) when the input is not a geometry or a
 *   feature with one and when the distance is not a finite number, and (`engine-failure`)
 *   when merging the parts fails
 *
 * @example
 * ```ts
 * import { buffer } from '@sakuzu/maplibre-gl-draw/geometry';
 *
 * // The area within 100 m of a road
 * const corridor = buffer(
 *   { type: 'LineString', coordinates: [[139.76, 35.68], [139.77, 35.69]] },
 *   100,
 * );
 * ```
 */
export function buffer(
  geometry: Geometry | { readonly geometry: Geometry },
  distanceMeters: number,
  options?: { segments?: number },
): Polygon | MultiPolygon | null {
  const input = geometryOf(geometry, 'buffer');
  if (!Number.isFinite(distanceMeters)) {
    throw invalidInput('buffer', 'the distance is not a finite number');
  }
  return withOperation('buffer', () =>
    toAreaGeometry(bufferOf(input, distanceMeters, options?.segments)),
  );
}
