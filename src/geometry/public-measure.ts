// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Measure: the public functions that measure distances, bearings, lengths and areas
 *
 * Every distance is taken along great circles on the sphere of EARTH_RADIUS_METERS, the
 * same as the internal haversine and direct-problem functions.
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
import { closeRing, usableAreaParts } from './coords.js';
import { destinationPoint, haversineDistanceMeters, initialBearingDegrees } from './distance.js';
import { invalidInput, withOperation } from './errors.js';
import { areaOf, lineOf, linesOf, positionOf, toPoint, toPosition } from './geojson.js';
import {
  geodesicLength,
  centroid as planarCentroid,
  pointOnSurface as planarPointOnSurface,
  sphericalArea,
} from './measure.js';
import type { Coordinate } from './types.js';
import { toDegrees, toRadians } from './units.js';

/**
 * Returns the great-circle distance in meters between two points.
 *
 * @param from The first point, a position `[lng, lat]` in degrees or a Point
 * @param to The second point, a position `[lng, lat]` in degrees or a Point
 * @returns The distance in meters on the sphere of {@link EARTH_RADIUS_METERS}. NaN when a
 *   coordinate is not finite
 * @throws {@link GeometryError} (`invalid-input`) when an argument is not a position or a
 *   Point
 *
 * @example
 * ```ts
 * import { distance } from '@sakuzu/maplibre-gl-draw/geometry';
 *
 * distance([139.767, 35.681], [135.495, 34.702]); // about 403,139 m
 * ```
 */
export function distance(from: Position | Point, to: Position | Point): number {
  return haversineDistanceMeters(positionOf(from, 'distance'), positionOf(to, 'distance'));
}

/**
 * Returns the initial bearing in degrees of the great circle from one point to another.
 *
 * @param from The start, a position `[lng, lat]` in degrees or a Point
 * @param to The end, a position `[lng, lat]` in degrees or a Point
 * @returns The bearing at the start in degrees, clockwise from north, in [0, 360). 0 when the
 *   points are identical
 * @throws {@link GeometryError} (`invalid-input`) when an argument is not a position or a
 *   Point
 */
export function bearing(from: Position | Point, to: Position | Point): number {
  return initialBearingDegrees(positionOf(from, 'bearing'), positionOf(to, 'bearing'));
}

/**
 * Returns the point reached from an origin after a distance in meters along a great circle
 * that starts at a bearing in degrees.
 *
 * @param origin The start, a position `[lng, lat]` in degrees or a Point
 * @param distanceMeters The distance in meters; a negative value goes the opposite way
 * @param bearingDegrees The initial bearing in degrees, clockwise from north
 * @returns The position `[lng, lat]` in degrees. The longitude continues from the origin
 *   and is not wrapped into [-180, 180]
 * @throws {@link GeometryError} (`invalid-input`) when the origin is not a position or a
 *   Point
 */
export function destination(
  origin: Position | Point,
  distanceMeters: number,
  bearingDegrees: number,
): Position {
  return toPosition(
    destinationPoint(positionOf(origin, 'destination'), distanceMeters, bearingDegrees),
  );
}

/**
 * Returns the point halfway between two points along the great circle that joins them.
 *
 * @param from The first point, a position `[lng, lat]` in degrees or a Point
 * @param to The second point, a position `[lng, lat]` in degrees or a Point
 * @returns The position `[lng, lat]` in degrees, at the same distance in meters from both
 *   points. The longitude continues from `from`
 * @throws {@link GeometryError} (`invalid-input`) when an argument is not a position or a
 *   Point
 */
export function midpoint(from: Position | Point, to: Position | Point): Position {
  const [lng1, lat1] = positionOf(from, 'midpoint');
  const [lng2, lat2] = positionOf(to, 'midpoint');
  const phi1 = toRadians(lat1);
  const phi2 = toRadians(lat2);
  const dLambda = toRadians(lng2 - lng1);
  const bx = Math.cos(phi2) * Math.cos(dLambda);
  const by = Math.cos(phi2) * Math.sin(dLambda);
  const phi = Math.atan2(
    Math.sin(phi1) + Math.sin(phi2),
    Math.sqrt((Math.cos(phi1) + bx) ** 2 + by ** 2),
  );
  const lambda = Math.atan2(by, Math.cos(phi1) + bx);
  return [lng1 + toDegrees(lambda), toDegrees(phi)];
}

/**
 * Returns the point at a distance in meters along a line, measured from its start.
 *
 * @param line The LineString, or a feature whose geometry is one; coordinates in degrees
 * @param distanceMeters The distance from the start in meters. 0 or less gives the start,
 *   and a distance longer than the line gives its end
 * @returns The position `[lng, lat]` in degrees
 * @throws {@link GeometryError} (`invalid-input`) when the line is not a LineString or has no
 *   position, and when the distance is not a finite number
 */
export function along(
  line: LineString | { readonly geometry: Geometry },
  distanceMeters: number,
): Position {
  const path = lineOf(line, 'along');
  if (path.length === 0) {
    throw invalidInput('along', 'the line has no position');
  }
  if (!Number.isFinite(distanceMeters)) {
    throw invalidInput('along', 'the distance is not a finite number');
  }
  let remaining = distanceMeters;
  if (remaining <= 0) return toPosition(path[0]);
  for (let i = 0; i < path.length - 1; i++) {
    const start = path[i];
    const end = path[i + 1];
    const section = haversineDistanceMeters(start, end);
    if (remaining < section) {
      return toPosition(destinationPoint(start, remaining, initialBearingDegrees(start, end)));
    }
    remaining -= section;
  }
  return toPosition(path[path.length - 1]);
}

/** A unit vector on the sphere */
type Vector = [number, number, number];

function toVector([lng, lat]: Coordinate): Vector {
  const lambda = toRadians(lng);
  const phi = toRadians(lat);
  return [Math.cos(phi) * Math.cos(lambda), Math.cos(phi) * Math.sin(lambda), Math.sin(phi)];
}

function cross(a: Vector, b: Vector): Vector {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function dot(a: Vector, b: Vector): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function norm(a: Vector): number {
  return Math.hypot(a[0], a[1], a[2]);
}

/** The vectors shorter than this are treated as zero (a degenerate great circle) */
const VECTOR_EPSILON = 1e-15;

/**
 * The position of a unit vector, with the longitude taken nearest to a reference longitude
 */
function toCoordinate(v: Vector, nearLng: number): Coordinate {
  const lat = toDegrees(Math.atan2(v[2], Math.hypot(v[0], v[1])));
  const lng = toDegrees(Math.atan2(v[1], v[0]));
  return [lng + 360 * Math.round((nearLng - lng) / 360), lat];
}

/**
 * The point of the great-circle arc from a to b nearest to p
 *
 * p is projected onto the plane of the great circle through a and b. When the projection
 * falls on the arc between them, it is the nearest point; otherwise the nearer end is.
 */
function nearestOnSegment(p: Coordinate, a: Coordinate, b: Coordinate): Coordinate {
  const va = toVector(a);
  const vb = toVector(b);
  const vp = toVector(p);
  const normal = cross(va, vb);
  const normalLength = norm(normal);
  if (normalLength < VECTOR_EPSILON) return a;
  const n: Vector = [normal[0] / normalLength, normal[1] / normalLength, normal[2] / normalLength];
  const offset = dot(vp, n);
  const projected: Vector = [vp[0] - offset * n[0], vp[1] - offset * n[1], vp[2] - offset * n[2]];
  if (norm(projected) >= VECTOR_EPSILON && dot(cross(va, projected), n) >= 0) {
    if (dot(cross(projected, vb), n) >= 0) {
      const size = norm(projected);
      return toCoordinate([projected[0] / size, projected[1] / size, projected[2] / size], a[0]);
    }
  }
  return haversineDistanceMeters(p, a) <= haversineDistanceMeters(p, b) ? a : b;
}

/**
 * Returns the point of a line nearest to a given point, with its distance in meters and the
 * index of the segment it lies on.
 *
 * @param line The LineString or MultiLineString, or a feature whose geometry is one;
 *   coordinates in degrees. Each segment is taken as a great-circle arc
 * @param point The point, a position `[lng, lat]` in degrees or a Point
 * @returns `position`, the nearest point `[lng, lat]` in degrees; `distanceMeters`, its
 *   distance from `point` in meters; and `segmentIndex`, the segment it lies on, counted from
 *   0 across the lines of a MultiLineString in order (segment `i` of a LineString joins its
 *   positions `i` and `i + 1`)
 * @throws {@link GeometryError} (`invalid-input`) when the line is not a LineString or a
 *   MultiLineString or has no position, and when the point is not a position or a Point
 */
export function nearestPointOnLine(
  line: LineString | MultiLineString | { readonly geometry: Geometry },
  point: Position | Point,
): { position: Position; distanceMeters: number; segmentIndex: number } {
  const lines = linesOf(line, 'nearestPointOnLine');
  const target = positionOf(point, 'nearestPointOnLine');
  let best: { position: Coordinate; distanceMeters: number; segmentIndex: number } | null = null;
  let segmentIndex = 0;
  for (const path of lines) {
    if (path.length === 0) continue;
    const segments = Math.max(1, path.length - 1);
    for (let i = 0; i < segments; i++) {
      const candidate =
        path.length === 1 ? path[0] : nearestOnSegment(target, path[i], path[i + 1]);
      const distanceMeters = haversineDistanceMeters(target, candidate);
      if (best === null || distanceMeters < best.distanceMeters) {
        best = { position: candidate, distanceMeters, segmentIndex };
      }
      segmentIndex++;
    }
  }
  if (best === null) {
    throw invalidInput('nearestPointOnLine', 'the line has no position');
  }
  return { ...best, position: toPosition(best.position) };
}

/**
 * Returns the length in meters of a line.
 *
 * @param line The LineString or MultiLineString, or a feature whose geometry is one;
 *   coordinates in degrees
 * @returns The sum of the great-circle distances of the segments, in meters. 0 for a line
 *   with fewer than 2 positions
 * @throws {@link GeometryError} (`invalid-input`) when the input is not a LineString or a
 *   MultiLineString
 */
export function length(
  line: LineString | MultiLineString | { readonly geometry: Geometry },
): number {
  let total = 0;
  for (const path of linesOf(line, 'length')) total += geodesicLength(path);
  return total;
}

/**
 * Returns the area in square meters of a polygon on the sphere.
 *
 * @param polygon The Polygon or MultiPolygon, or a feature whose geometry is one; coordinates
 *   in degrees. Self-intersections are resolved and ring orientation does not matter
 * @returns The area in square meters, holes subtracted. 0 when nothing with an area remains
 * @throws {@link GeometryError} (`invalid-input`) when the input is not a Polygon or a
 *   MultiPolygon, and (`engine-failure`) when resolving its self-intersections fails
 *
 * @example
 * ```ts
 * import { area } from '@sakuzu/maplibre-gl-draw/geometry';
 *
 * // A 1 x 1 degree square on the equator
 * area({ type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]] });
 * // about 1.236e10 m²
 * ```
 */
export function area(polygon: Polygon | MultiPolygon | { readonly geometry: Geometry }): number {
  const coordinates = areaOf(polygon, 'area');
  return withOperation('area', () => sphericalArea(coordinates));
}

/**
 * Returns the length in meters of the boundary of a polygon, the rings of its holes included.
 *
 * @param polygon The Polygon or MultiPolygon, or a feature whose geometry is one; coordinates
 *   in degrees. An open ring is measured as if closed; a ring with fewer than 3 positions or a
 *   position that is not finite is left out
 * @returns The sum of the great-circle lengths of every ring, in meters
 * @throws {@link GeometryError} (`invalid-input`) when the input is not a Polygon or a
 *   MultiPolygon
 */
export function perimeter(
  polygon: Polygon | MultiPolygon | { readonly geometry: Geometry },
): number {
  let total = 0;
  for (const part of usableAreaParts(areaOf(polygon, 'perimeter'))) {
    for (const ring of part) total += geodesicLength(closeRing(ring));
  }
  return total;
}

/**
 * Returns the centroid of a polygon, weighted by area.
 *
 * @param polygon The Polygon or MultiPolygon, or a feature whose geometry is one; coordinates
 *   in degrees. Holes are subtracted and the parts are weighted by their areas on the lng/lat
 *   plane
 * @returns The centroid as a Point, in degrees; it can fall outside a concave polygon (see
 *   {@link pointOnSurface}). The mean of the positions when the area is 0. null when there is
 *   no position
 * @throws {@link GeometryError} (`invalid-input`) when the input is not a Polygon or a
 *   MultiPolygon
 */
export function centroid(
  polygon: Polygon | MultiPolygon | { readonly geometry: Geometry },
): Point | null {
  const result = planarCentroid(areaOf(polygon, 'centroid'));
  return result === null ? null : toPoint(result);
}

/**
 * Returns a point that always lies inside a polygon, such as the anchor of a label.
 *
 * @param polygon The Polygon or MultiPolygon, or a feature whose geometry is one; coordinates
 *   in degrees
 * @returns The {@link centroid} when it lies inside, otherwise the middle of the widest
 *   section of the polygon along the parallel of the centroid, as a Point in degrees. null
 *   when there is no position
 * @throws {@link GeometryError} (`invalid-input`) when the input is not a Polygon or a
 *   MultiPolygon
 */
export function pointOnSurface(
  polygon: Polygon | MultiPolygon | { readonly geometry: Geometry },
): Point | null {
  const result = planarPointOnSurface(areaOf(polygon, 'pointOnSurface'));
  return result === null ? null : toPoint(result);
}
