// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GeoJSON input and output of the public functions
 *
 * The public functions take GeoJSON geometries, or anything that carries one in a `geometry`
 * field (GeoJSON features, the features of the drawing), and return GeoJSON geometries;
 * the computations underneath work on coordinate arrays. These helpers take the coordinates
 * out of an input, reject an input whose shape a function cannot take with a GeometryError
 * (`invalid-input`), and wrap the computed coordinates back into a geometry.
 */

import type {
  Geometry,
  LineString,
  MultiLineString,
  MultiPolygon,
  Point,
  Polygon,
  Position,
} from 'geojson';
import { invalidInput } from './errors.js';
import type { AreaCoordinates, Coordinate, MultiPolygonCoordinates } from './types.js';

/** A point as taken by the public functions */
export type PointInput = Position | Point;

/** A polygon as taken by the public functions */
export type AreaInput = Polygon | MultiPolygon | { readonly geometry: Geometry };

/** A line as taken by the public functions */
export type LineInput = LineString | MultiLineString | { readonly geometry: Geometry };

/** The geometry types that carry `coordinates` */
const COORDINATE_TYPES = new Set([
  'Point',
  'MultiPoint',
  'LineString',
  'MultiLineString',
  'Polygon',
  'MultiPolygon',
]);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Whether a value is an array whose first two elements are numbers */
function isPosition(value: unknown): value is Coordinate {
  return (
    Array.isArray(value) &&
    value.length >= 2 &&
    typeof value[0] === 'number' &&
    typeof value[1] === 'number'
  );
}

/**
 * Returns the geometry of a geometry, or of anything that carries one in a `geometry` field
 * (a GeoJSON feature, a feature of the drawing)
 *
 * A value whose `geometry` member is a geometry is read as a feature first, whatever its own
 * `type` says: a feature of the drawing names its feature type there (`'Polygon'`,
 * `'Circle'`, `'Freehand'` and so on), which is not the type of a geometry it is.
 *
 * @throws GeometryError (`invalid-input`) for a value that is neither, and for a feature
 *   without a geometry
 */
export function geometryOf(
  input: Geometry | { readonly geometry: Geometry },
  operation: string,
): Geometry {
  const value: unknown = input;
  if (!isObject(value)) {
    throw invalidInput(operation, 'the input is not a geometry or a feature');
  }
  if ('geometry' in value || value.type === 'Feature') {
    const geometry = value.geometry;
    if (isObject(geometry) && isGeometryType(geometry.type)) {
      return geometryOf(geometry as unknown as Geometry, operation);
    }
    if (!isGeometry(value)) {
      throw invalidInput(operation, 'the feature has no geometry');
    }
  }
  if (value.type === 'GeometryCollection' && !Array.isArray(value.geometries)) {
    throw invalidInput(operation, 'the geometry collection has no geometries');
  }
  if (!isGeometry(value)) {
    throw invalidInput(operation, 'the input is not a geometry or a feature');
  }
  return value as unknown as Geometry;
}

/** Whether an object has the type of a geometry and the member that type carries */
function isGeometry(value: Record<string, unknown>): boolean {
  if (!isGeometryType(value.type)) return false;
  if (value.type === 'GeometryCollection') return Array.isArray(value.geometries);
  return Array.isArray(value.coordinates);
}

/** Whether a value names a GeoJSON geometry type */
function isGeometryType(type: unknown): boolean {
  return typeof type === 'string' && (COORDINATE_TYPES.has(type) || type === 'GeometryCollection');
}

/**
 * Returns the coordinates of a point given as a position or a Point
 *
 * @throws GeometryError (`invalid-input`) for anything else
 */
export function positionOf(input: PointInput, operation: string): Coordinate {
  if (isPosition(input)) return input;
  if (isObject(input) && input.type === 'Point' && isPosition(input.coordinates)) {
    return input.coordinates;
  }
  throw invalidInput(operation, 'the input is not a position or a Point');
}

/**
 * Returns the geometry of a Polygon or a MultiPolygon, given as it is or in a feature
 *
 * @throws GeometryError (`invalid-input`) for any other geometry
 */
export function areaGeometryOf(input: AreaInput, operation: string): Polygon | MultiPolygon {
  const geometry = geometryOf(input, operation);
  if (geometry.type !== 'Polygon' && geometry.type !== 'MultiPolygon') {
    throw invalidInput(operation, 'the input is not a Polygon or a MultiPolygon');
  }
  return geometry;
}

/**
 * Returns the coordinates of a Polygon or a MultiPolygon, given as it is or in a feature
 *
 * @throws GeometryError (`invalid-input`) for any other geometry
 */
export function areaOf(input: AreaInput, operation: string): AreaCoordinates {
  return areaGeometryOf(input, operation).coordinates as AreaCoordinates;
}

/**
 * Returns the coordinates of each polygon in an array
 *
 * @throws GeometryError (`invalid-input`) for a value that is not an array, and for an
 *   element that is not a Polygon or a MultiPolygon
 */
export function areasOf(inputs: readonly AreaInput[], operation: string): AreaCoordinates[] {
  if (!Array.isArray(inputs)) {
    throw invalidInput(operation, 'the input is not an array of polygons');
  }
  return inputs.map((input) => areaOf(input, operation));
}

/**
 * Returns the coordinates of a LineString, given as it is or in a feature
 *
 * @throws GeometryError (`invalid-input`) for any other geometry
 */
export function lineOf(
  input: LineString | { readonly geometry: Geometry },
  operation: string,
): Coordinate[] {
  const geometry = geometryOf(input, operation);
  if (geometry.type !== 'LineString') {
    throw invalidInput(operation, 'the input is not a LineString');
  }
  return geometry.coordinates as Coordinate[];
}

/**
 * Returns the lines of a LineString or a MultiLineString, given as it is or in a feature
 *
 * @throws GeometryError (`invalid-input`) for any other geometry
 */
export function linesOf(input: LineInput, operation: string): Coordinate[][] {
  const geometry = geometryOf(input, operation);
  if (geometry.type === 'LineString') return [geometry.coordinates as Coordinate[]];
  if (geometry.type === 'MultiLineString') return geometry.coordinates as Coordinate[][];
  throw invalidInput(operation, 'the input is not a LineString or a MultiLineString');
}

/** Every position of a geometry, the members of a collection included */
export function positionsOf(geometry: Geometry): Coordinate[] {
  switch (geometry.type) {
    case 'Point':
      return [geometry.coordinates as Coordinate];
    case 'MultiPoint':
    case 'LineString':
      return geometry.coordinates as Coordinate[];
    case 'MultiLineString':
    case 'Polygon':
      return (geometry.coordinates as Coordinate[][]).flat();
    case 'MultiPolygon':
      return (geometry.coordinates as Coordinate[][][]).flat(2);
    case 'GeometryCollection':
      return geometry.geometries.flatMap(positionsOf);
  }
}

/** A copy of a position, as returned by the public functions */
export function toPosition(coordinate: Coordinate): Position {
  return [coordinate[0], coordinate[1]];
}

/** A Point geometry at a position */
export function toPoint(coordinate: Coordinate): Point {
  return { type: 'Point', coordinates: toPosition(coordinate) };
}

/**
 * Wraps MultiPolygon coordinates into a geometry: a Polygon for one part, a MultiPolygon for
 * several, and null for none
 */
export function toAreaGeometry(
  coordinates: MultiPolygonCoordinates,
): Polygon | MultiPolygon | null {
  if (coordinates.length === 0) return null;
  if (coordinates.length === 1) return { type: 'Polygon', coordinates: coordinates[0] };
  return { type: 'MultiPolygon', coordinates };
}
