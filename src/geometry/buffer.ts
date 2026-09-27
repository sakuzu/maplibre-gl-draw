// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Buffer
 *
 * Generated in meters without interposing a map projection. A point becomes a circle; a
 * line becomes the union of the circle of each vertex and the band of each edge (a
 * quadrilateral offset by the distance ±90 degrees from the bearing of the edge); a
 * polygon becomes the union (positive value) or the difference (negative value) of the
 * line buffer of its outer and inner rings and the original polygon.
 *
 * The offsets are points reached along great circles (destinationPoint, the direct problem
 * on the sphere), so the distances hold at any latitude; the edges between the generated
 * points are straight in longitude and latitude. An input out of scope gives null: a
 * coordinate that is not finite, a vertex whose buffer distance reaches a pole (the parts
 * would wrap the pole, which a ring in longitude and latitude cannot express), or an edge
 * that spans more than 180 degrees of longitude (the planar edge then runs the other way
 * round the globe from its bearing).
 */

import { difference, union, unionAll } from './boolean.js';
import { generateCirclePolygon, normalizeCircleSegments } from './circle.js';
import { closeRing, isFiniteCoordinate, toMultiPolygonCoordinates } from './coords.js';
import { destinationPoint, initialBearingDegrees } from './distance.js';
import type {
  AreaCoordinates,
  Coordinate,
  GeometryInput,
  MultiPolygonCoordinates,
  PolygonCoordinates,
} from './types.js';
import { EARTH_RADIUS_METERS, toDegrees } from './units.js';

/** The default number of segments per circle of {@link buffer}: 64. */
export const DEFAULT_BUFFER_SEGMENTS = 64;

/**
 * The options of {@link buffer}.
 */
export interface BufferOptions {
  /**
   * The number of segments of the arc parts (64 by default). Rounded down and clamped to
   * 3-1024; NaN gives the default
   */
  segments?: number;
}

/**
 * The buffer of a point (a geodesic circle)
 */
function circlePolygon(center: Coordinate, radius: number, segments: number): PolygonCoordinates {
  return [generateCirclePolygon(center, radius, segments)];
}

/**
 * Drops the duplicates of identical coordinates (the order is preserved)
 */
function dedupeVertices(line: Coordinate[]): Coordinate[] {
  const seen = new Set<string>();
  const result: Coordinate[] = [];
  for (const vertex of line) {
    const key = `${vertex[0]},${vertex[1]}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(vertex);
  }
  return result;
}

/**
 * Generates the parts that make up the buffer of a line
 *
 * Returns the geodesic circle of each vertex and the band of each edge lined up. Taking
 * the union is up to the caller.
 */
function lineBufferParts(line: Coordinate[], radius: number, segments: number): AreaCoordinates[] {
  // Vertices at identical coordinates produce the same circle twice. The end of a
  // closed ring is the typical case; drop them for the robustness of polygon-clipping
  const vertices = dedupeVertices(line);
  const parts: AreaCoordinates[] = [];

  for (const vertex of vertices) {
    parts.push(circlePolygon(vertex, radius, segments));
  }

  for (let i = 0; i < line.length - 1; i++) {
    const start = line[i];
    const end = line[i + 1];
    // An edge of length 0 has no determined bearing. It is covered by the vertex
    // circles alone
    if (start[0] === end[0] && start[1] === end[1]) {
      continue;
    }

    // A quadrilateral offset by the distance ±90 degrees from the direction of the great
    // circle of the edge at each end: the initial bearing at the start and the final bearing
    // (the reverse bearing turned by 180 degrees) at the end
    const startBearing = initialBearingDegrees(start, end);
    const endBearing = initialBearingDegrees(end, start) + 180;
    parts.push([
      closeRing([
        destinationPoint(start, radius, startBearing - 90),
        destinationPoint(end, radius, endBearing - 90),
        destinationPoint(end, radius, endBearing + 90),
        destinationPoint(start, radius, startBearing + 90),
      ]),
    ]);
  }

  return parts;
}

/**
 * Takes out the lines that make up a geometry (each ring in the case of a polygon)
 */
function collectLines(geometry: GeometryInput): Coordinate[][] {
  switch (geometry.type) {
    case 'Point':
      return [[geometry.coordinates]];
    case 'MultiPoint':
      return geometry.coordinates.map((coordinate) => [coordinate]);
    case 'LineString':
      return [geometry.coordinates];
    case 'MultiLineString':
      return geometry.coordinates;
    default:
      return toMultiPolygonCoordinates(geometry.coordinates).flat();
  }
}

/**
 * Determines whether the buffer of the lines at the given radius is out of scope
 *
 * Out of scope are a coordinate that is not finite, a vertex whose circle reaches a pole
 * (the parts would wrap the pole, which a ring in longitude and latitude cannot express) and an edge that spans more
 * than 180 degrees of longitude (its bearing points the other way round the globe from the
 * planar edge, so the band would wrap the whole world).
 */
function isOutOfScope(lines: Coordinate[][], radius: number): boolean {
  const radiusDegrees = toDegrees(radius / EARTH_RADIUS_METERS);
  for (const line of lines) {
    for (let i = 0; i < line.length; i++) {
      const vertex = line[i];
      if (!isFiniteCoordinate(vertex) || Math.abs(vertex[1]) + radiusDegrees >= 90) {
        return true;
      }
      if (i > 0 && Math.abs(vertex[0] - line[i - 1][0]) > 180) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Determines whether the geometry is a polygon-family geometry
 */
function isAreaGeometry(
  geometry: GeometryInput,
): geometry is Extract<GeometryInput, { type: 'Polygon' | 'MultiPolygon' }> {
  return geometry.type === 'Polygon' || geometry.type === 'MultiPolygon';
}

/**
 * Builds the area within a distance in meters of a geometry.
 *
 * The distances are laid out without a map projection, through {@link destinationPoint},
 * the direct problem on the sphere. Every generated vertex lies at the buffer distance from
 * its source vertex at any latitude, up to floating-point rounding; the edges between the
 * generated vertices are straight in longitude and latitude. A point becomes a circle (the
 * same as {@link generateCirclePolygon}); a line becomes the union of a circle at each
 * vertex and a band along each edge, offset ±90 degrees from the great-circle bearing of
 * the edge; a polygon becomes the union (positive distance) or the difference (negative
 * distance) of the original polygon and the band along its rings.
 *
 * | Input | Positive | 0 | Negative |
 * | --- | --- | --- | --- |
 * | Point / MultiPoint | circle | `null` | `null` |
 * | LineString / MultiLineString | band | `null` | `null` |
 * | Polygon / MultiPolygon | expansion | normalized original | contraction |
 *
 * With a negative distance, parts narrower than `2 * |meters|` disappear, and an empty array
 * is returned when the whole polygon disappears. `null` means the operation is not defined
 * for the input: the table above, a distance that is not finite, a coordinate that is not
 * finite, a vertex whose distance reaches a pole (`|lat|` plus the distance in degrees of
 * latitude is 90 or more), and an edge that spans more than 180 degrees of longitude.
 *
 * @param geometry The geometry to buffer, coordinates in degrees
 * @param meters The buffer distance in meters. A negative value shrinks a polygon
 * @param options The number of segments per circle
 * @returns The normalized MultiPolygon coordinates of the area. An empty array when a
 *   shrunk polygon vanishes. `null` when the operation is not defined for the input
 * @throws {@link GeometryError} when the boolean operation engine fails even after the
 *   retry on the 1e-9 degree grid
 */
export function buffer(
  geometry: GeometryInput,
  meters: number,
  options?: BufferOptions,
): MultiPolygonCoordinates | null {
  if (!Number.isFinite(meters)) {
    return null;
  }

  const segments = normalizeCircleSegments(options?.segments, DEFAULT_BUFFER_SEGMENTS);
  const radius = Math.abs(meters);
  const area = isAreaGeometry(geometry);

  // The erosion of a point or a line is not defined
  if (!area && meters <= 0) {
    return null;
  }

  // A zero distance on a polygon is its normalized form, which needs no offset
  if (area && meters === 0) {
    return unionAll([geometry.coordinates]);
  }

  const lines = collectLines(geometry);
  if (isOutOfScope(lines, radius)) {
    return null;
  }

  if (!area) {
    return unionAll(lines.flatMap((line) => lineBufferParts(line, radius, segments)));
  }

  const areaCoordinates: AreaCoordinates = geometry.coordinates;

  // The line buffer of the outer and inner rings (a band of distance |meters| from the
  // boundary)
  const boundary = unionAll(lines.flatMap((ring) => lineBufferParts(ring, radius, segments)));

  return meters > 0 ? union(areaCoordinates, boundary) : difference(areaCoordinates, boundary);
}
