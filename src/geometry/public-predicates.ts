// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Test: the public predicates between points, lines and polygons
 *
 * The tests run on the lng/lat plane. A point or a line is contained when it lies inside the
 * polygon or on its boundary; a polygon is contained when no part of it lies outside.
 */

import type { Geometry, MultiPolygon, Point, Polygon, Position } from 'geojson';
import { usableAreaParts } from './coords.js';
import { withOperation } from './errors.js';
import { areaOf, geometryOf, positionOf } from './geojson.js';
import {
  contains as containsArea,
  intersects,
  pointInPolygon as pointInArea,
} from './predicates.js';
import { segmentIntersection } from './split.js';
import type { AreaCoordinates, Coordinate, MultiPolygonCoordinates } from './types.js';

/**
 * Determines whether a point lies inside a polygon, holes taken into account.
 *
 * @param point The point, a position `[lng, lat]` in degrees or a Point
 * @param polygon The Polygon or MultiPolygon, or a feature whose geometry is one; coordinates
 *   in degrees
 * @returns `true` when the point lies inside an outer ring and inside none of its holes. The
 *   result for a point exactly on the boundary is not defined
 * @throws {@link GeometryError} (`invalid-input`) when an argument is not of the expected type
 */
export function pointInPolygon(
  point: Position | Point,
  polygon: Polygon | MultiPolygon | { readonly geometry: Geometry },
): boolean {
  return pointInArea(positionOf(point, 'pointInPolygon'), areaOf(polygon, 'pointInPolygon'));
}

/**
 * Determines whether two polygons share an area.
 *
 * @param a The Polygon or MultiPolygon, or a feature whose geometry is one; coordinates in
 *   degrees
 * @param b The Polygon or MultiPolygon, or a feature whose geometry is one; coordinates in
 *   degrees
 * @returns `true` when the common part has an area. `false` when they only touch along an edge
 *   or at a vertex
 * @throws {@link GeometryError} (`invalid-input`) when an argument is not a Polygon or a
 *   MultiPolygon, and (`engine-failure`) when the boolean operation fails
 */
export function overlaps(
  a: Polygon | MultiPolygon | { readonly geometry: Geometry },
  b: Polygon | MultiPolygon | { readonly geometry: Geometry },
): boolean {
  const left = areaOf(a, 'overlaps');
  const right = areaOf(b, 'overlaps');
  return withOperation('overlaps', () => intersects(left, right));
}

/** The distance in degrees within which a point counts as on the boundary */
const BOUNDARY_EPSILON = 1e-12;

/** The square of the planar distance from a point to a segment */
function squaredSegmentDistance(p: Coordinate, a: Coordinate, b: Coordinate): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const lengthSquared = dx * dx + dy * dy;
  const t =
    lengthSquared === 0
      ? 0
      : Math.min(1, Math.max(0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lengthSquared));
  const x = p[0] - (a[0] + t * dx);
  const y = p[1] - (a[1] + t * dy);
  return x * x + y * y;
}

/** Calls a function with every edge of every ring, the closing edge included */
function forEachEdge(
  parts: MultiPolygonCoordinates,
  visit: (start: Coordinate, end: Coordinate) => boolean | undefined,
): boolean {
  for (const part of parts) {
    for (const ring of part) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        if (visit(ring[j], ring[i]) === true) return true;
      }
    }
  }
  return false;
}

function onBoundary(point: Coordinate, parts: MultiPolygonCoordinates): boolean {
  const limit = BOUNDARY_EPSILON * BOUNDARY_EPSILON;
  return forEachEdge(parts, (a, b) => squaredSegmentDistance(point, a, b) <= limit);
}

function coversPoint(parts: MultiPolygonCoordinates, point: Coordinate): boolean {
  return pointInArea(point, parts) || onBoundary(point, parts);
}

/**
 * Whether a line lies inside the polygon or on its boundary
 *
 * Each segment is cut where it crosses an edge; every vertex and the middle of every piece
 * must be covered.
 */
function coversLine(parts: MultiPolygonCoordinates, line: Coordinate[]): boolean {
  if (line.length === 0) return false;
  if (!line.every((vertex) => coversPoint(parts, vertex))) return false;
  for (let i = 0; i < line.length - 1; i++) {
    const a = line[i];
    const b = line[i + 1];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const alongX = Math.abs(dx) >= Math.abs(dy);
    const cuts = [0, 1];
    forEachEdge(parts, (c, d) => {
      const crossing = segmentIntersection(a, b, c, d);
      if (crossing !== null) {
        cuts.push(alongX ? (crossing[0] - a[0]) / dx : (crossing[1] - a[1]) / dy);
      }
      return undefined;
    });
    cuts.sort((x, y) => x - y);
    for (let k = 0; k < cuts.length - 1; k++) {
      if (cuts[k + 1] - cuts[k] <= BOUNDARY_EPSILON) continue;
      const t = (cuts[k] + cuts[k + 1]) / 2;
      if (!coversPoint(parts, [a[0] + t * dx, a[1] + t * dy])) return false;
    }
  }
  return true;
}

function containsGeometry(outer: AreaCoordinates, inner: Geometry): boolean {
  const parts = usableAreaParts(outer);
  switch (inner.type) {
    case 'Polygon':
    case 'MultiPolygon':
      return containsArea(outer, inner.coordinates as AreaCoordinates);
    case 'Point':
      return coversPoint(parts, inner.coordinates as Coordinate);
    case 'MultiPoint':
      return (
        inner.coordinates.length > 0 &&
        (inner.coordinates as Coordinate[]).every((point) => coversPoint(parts, point))
      );
    case 'LineString':
      return coversLine(parts, inner.coordinates as Coordinate[]);
    case 'MultiLineString':
      return (
        inner.coordinates.length > 0 &&
        (inner.coordinates as Coordinate[][]).every((line) => coversLine(parts, line))
      );
    case 'GeometryCollection':
      return (
        inner.geometries.length > 0 &&
        inner.geometries.every((member) => containsGeometry(outer, geometryOf(member, 'contains')))
      );
  }
}

/**
 * Determines whether a polygon completely contains a geometry.
 *
 * @param outer The containing Polygon or MultiPolygon, or a feature whose geometry is one;
 *   coordinates in degrees
 * @param inner The contained geometry, or a feature whose geometry it is; coordinates in
 *   degrees. It may share the boundary of `outer`
 * @returns `true` when no part of `inner` lies outside `outer`. `false` for a polygon without
 *   an area and for an empty geometry
 * @throws {@link GeometryError} (`invalid-input`) when an argument is not of the expected
 *   type, and (`engine-failure`) when the boolean operation fails
 */
export function contains(
  outer: Polygon | MultiPolygon | { readonly geometry: Geometry },
  inner: Geometry | { readonly geometry: Geometry },
): boolean {
  const area = areaOf(outer, 'contains');
  const geometry = geometryOf(inner, 'contains');
  return withOperation('contains', () => containsGeometry(area, geometry));
}
