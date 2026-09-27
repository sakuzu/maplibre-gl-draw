// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Repair: the public functions that tidy polygons and reduce vertices
 */

import type { Feature, LineString, MultiPolygon, Polygon, Position } from 'geojson';
import { coordinatesBBox } from './bbox.js';
import { normalizeArea } from './boolean.js';
import { invalidInput, withOperation } from './errors.js';
import { areaGeometryOf, areaOf, geometryOf, positionsOf, toAreaGeometry } from './geojson.js';
import {
  normalizeMultiPolygonOrientation,
  normalizePolygonOrientation,
  simplify as simplifyPath,
} from './simplify.js';
import type { Coordinate, MultiPolygonCoordinates, PolygonCoordinates } from './types.js';
import { metersToDegrees, toRadians } from './units.js';

/**
 * Returns a polygon with its self-intersections resolved, its rings oriented and its rings
 * without an area removed.
 *
 * @param polygon The Polygon or MultiPolygon, or a feature whose geometry is one; coordinates
 *   in degrees. A ring with fewer than 3 positions or a position that is not finite is dropped
 * @returns A Polygon, or a MultiPolygon when the result falls apart (a figure eight becomes two
 *   parts), with outer rings counter-clockwise and holes clockwise. null when nothing with an
 *   area remains
 * @throws {@link GeometryError} (`invalid-input`) when the input is not a Polygon or a
 *   MultiPolygon, and (`engine-failure`) when the boolean operation fails
 */
export function makeValid(
  polygon: Polygon | MultiPolygon | Feature,
): Polygon | MultiPolygon | null {
  const coordinates = areaOf(polygon, 'makeValid');
  return withOperation('makeValid', () => toAreaGeometry(normalizeArea(coordinates)));
}

/**
 * Returns a polygon with its rings oriented as RFC 7946 recommends: outer rings
 * counter-clockwise and holes clockwise.
 *
 * @param polygon The Polygon or MultiPolygon, or a feature whose geometry is one; coordinates
 *   in degrees. Only the orientation changes; self-intersections are left as they are (see
 *   {@link makeValid})
 * @returns A geometry of the same type as the input
 * @throws {@link GeometryError} (`invalid-input`) when the input is not a Polygon or a
 *   MultiPolygon
 */
export function rewind(polygon: Polygon | Feature<Polygon>): Polygon;
export function rewind(polygon: MultiPolygon | Feature<MultiPolygon>): MultiPolygon;
export function rewind(polygon: Polygon | MultiPolygon | Feature): Polygon | MultiPolygon;
export function rewind(polygon: Polygon | MultiPolygon | Feature): Polygon | MultiPolygon {
  const geometry = areaGeometryOf(polygon, 'rewind');
  if (geometry.type === 'Polygon') {
    return {
      type: 'Polygon',
      coordinates: normalizePolygonOrientation(geometry.coordinates as PolygonCoordinates),
    };
  }
  return {
    type: 'MultiPolygon',
    coordinates: normalizeMultiPolygonOrientation(geometry.coordinates as MultiPolygonCoordinates),
  };
}

/**
 * Simplifies a path with a tolerance in meters: the path is scaled to a local plane in which
 * a degree of longitude is `cos(latitude)` degrees of latitude, and the tolerance is taken in
 * degrees of latitude
 */
function simplifyInMeters(
  path: Position[],
  toleranceDegrees: number,
  lngScale: number,
): Position[] {
  const scaled = path.map((position): Coordinate => [position[0] * lngScale, position[1]]);
  const indexOf = new Map<Coordinate, number>();
  scaled.forEach((position, index) => {
    indexOf.set(position, index);
  });
  return simplifyPath(scaled, toleranceDegrees).map((position) => [
    ...path[indexOf.get(position) ?? 0],
  ]);
}

/**
 * Reduces the vertices of a line or a polygon with the Douglas-Peucker algorithm and a
 * tolerance in meters.
 *
 * @param geometry The LineString, Polygon or MultiPolygon, or a feature whose geometry is one;
 *   coordinates in degrees
 * @param toleranceMeters The largest distance in meters a removed vertex may lie from the
 *   simplified line, measured on a plane at the latitude of the center of the bounding box. 0
 *   or less removes nothing
 * @returns A geometry of the same type. The ends of a line always remain, and a ring that
 *   would keep fewer than 4 positions is kept as it is. The result may intersect itself (see
 *   {@link makeValid})
 * @throws {@link GeometryError} (`invalid-input`) when the input is not a LineString, a
 *   Polygon or a MultiPolygon, and when the tolerance is not a finite number
 *
 * @example
 * ```ts
 * import { simplify } from '@sakuzu/maplibre-gl-draw/geometry';
 *
 * // The middle vertex lies about 1 m off the line, within the 5 m tolerance
 * simplify({ type: 'LineString', coordinates: [[0, 0], [0.001, 0.00001], [0.002, 0]] }, 5);
 * // { type: 'LineString', coordinates: [[0, 0], [0.002, 0]] }
 * ```
 */
export function simplify(
  geometry: LineString | Feature<LineString>,
  toleranceMeters: number,
): LineString;
export function simplify(geometry: Polygon | Feature<Polygon>, toleranceMeters: number): Polygon;
export function simplify(
  geometry: MultiPolygon | Feature<MultiPolygon>,
  toleranceMeters: number,
): MultiPolygon;
export function simplify(
  geometry: LineString | Polygon | MultiPolygon | Feature,
  toleranceMeters: number,
): LineString | Polygon | MultiPolygon;
export function simplify(
  geometry: LineString | Polygon | MultiPolygon | Feature,
  toleranceMeters: number,
): LineString | Polygon | MultiPolygon {
  const input = geometryOf(geometry, 'simplify');
  if (input.type !== 'LineString' && input.type !== 'Polygon' && input.type !== 'MultiPolygon') {
    throw invalidInput('simplify', 'the input is not a LineString, a Polygon or a MultiPolygon');
  }
  if (!Number.isFinite(toleranceMeters)) {
    throw invalidInput('simplify', 'the tolerance is not a finite number');
  }
  const box = coordinatesBBox(positionsOf(input));
  const latitude = box === null ? 0 : (box[1] + box[3]) / 2;
  const toleranceDegrees = metersToDegrees(toleranceMeters, latitude).lat;
  const lngScale = Math.cos(toRadians(latitude));
  const path = (positions: Position[]) => simplifyInMeters(positions, toleranceDegrees, lngScale);
  switch (input.type) {
    case 'LineString':
      return { type: 'LineString', coordinates: path(input.coordinates) };
    case 'Polygon':
      return { type: 'Polygon', coordinates: input.coordinates.map(path) };
    case 'MultiPolygon':
      return {
        type: 'MultiPolygon',
        coordinates: input.coordinates.map((polygon) => polygon.map(path)),
      };
  }
}
