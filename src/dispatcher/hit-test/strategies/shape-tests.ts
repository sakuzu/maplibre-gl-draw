// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The precise tests of the built-in types, on shapes read in place
 *
 * The one implementation of the hits of the points, the lines, the polygons, their `Multi` and
 * the circles: how far from a point a click hits it, where a line ends, how the holes of a
 * polygon let a click through. A strategy tests a feature by reading its coordinates as a shape
 * (`shapeOfCoordinates`); a row held as columns is tested by reading its column as a shape, so
 * the two never answer differently. Distances are measured in the local frame of hit testing
 * (local-frame.ts).
 */

import { haversineDistanceMeters, metersToLng } from '../../../shared/math/index.js';
import {
  type HitShape,
  type PositionRun,
  shapeOfCoordinates,
} from '../../../shared/math/position-runs.js';
import { coordinatesOf } from '../../../shared/utils/coordinates.js';
import { getCircleRadius } from '../../../shared/utils/property.js';
import type { Coordinate, Feature } from '../../../store/types.js';
import { latitudeScale, localDistanceXY, localPointToRunDistance } from '../local-frame.js';
import { runDistanceWithin } from '../segment-grid.js';

/**
 * The precise test of a type on its shape
 *
 * @internal
 */
export interface ShapeHitTest {
  /** Whether the shape is hit within the tolerance (degrees of longitude at the click) */
  testShape(shape: HitShape, coordinate: Coordinate, toleranceLngLat: number): boolean;
  /** The distance from the click (degrees of longitude at the click, meters for a circle) */
  distanceShape(shape: HitShape, coordinate: Coordinate): number;
  /** The distance when the shape is hit within the tolerance, null otherwise */
  testDistanceShape?(
    shape: HitShape,
    coordinate: Coordinate,
    toleranceLngLat: number,
  ): number | null;
}

/**
 * The shape of a feature, read in place from its coordinates (with its radius for a Circle)
 *
 * @internal
 */
export function shapeOfFeature(feature: Feature): HitShape {
  const shape = shapeOfCoordinates(feature.geometry.type, coordinatesOf(feature));
  if (feature.type !== 'Circle') return shape;
  return { parts: shape.parts, radiusMeters: getCircleRadius(feature) };
}

/** The runs of the first part of a shape (none for an empty shape) */
function firstPart(shape: HitShape): readonly PositionRun[] {
  return shape.parts[0] ?? [];
}

/**
 * Points: hit within the tolerance of a position (a Point is one, a MultiPoint any of its)
 *
 * @internal
 */
export const pointsShapeTest: ShapeHitTest = {
  testShape(shape, coordinate, tolerance) {
    const latScale = latitudeScale(coordinate[1]);
    for (const run of firstPart(shape)) {
      for (let i = 0; i < run.length; i++) {
        const distance = localDistanceXY(
          coordinate[0],
          coordinate[1],
          run.x(i),
          run.y(i),
          latScale,
        );
        if (distance <= tolerance) return true;
      }
    }
    return false;
  },
  distanceShape(shape, coordinate) {
    const latScale = latitudeScale(coordinate[1]);
    let min = Number.POSITIVE_INFINITY;
    for (const run of firstPart(shape)) {
      for (let i = 0; i < run.length; i++) {
        min = Math.min(
          min,
          localDistanceXY(coordinate[0], coordinate[1], run.x(i), run.y(i), latScale),
        );
      }
    }
    return min;
  },
};

/**
 * Lines: hit within the tolerance of a segment, the ends included (a run of fewer than two
 * positions has no segment); a MultiLineString is hit on any of its lines
 *
 * @internal
 */
export const linesShapeTest: Required<ShapeHitTest> = {
  testShape(shape, coordinate, tolerance) {
    return linesShapeTest.testDistanceShape(shape, coordinate, tolerance) !== null;
  },
  distanceShape(shape, coordinate) {
    const latScale = latitudeScale(coordinate[1]);
    let min = Number.POSITIVE_INFINITY;
    for (const run of firstPart(shape)) {
      if (run.length === 0) continue;
      min = Math.min(min, localPointToRunDistance(coordinate, run, latScale));
    }
    return min;
  },
  testDistanceShape(shape, coordinate, tolerance) {
    const latScale = latitudeScale(coordinate[1]);
    let min = Number.POSITIVE_INFINITY;
    for (const run of firstPart(shape)) {
      if (run.length === 0) continue;
      const distance = runDistanceWithin(run, coordinate, tolerance, latScale);
      if (distance !== null && distance < min) min = distance;
    }
    return min <= tolerance ? min : null;
  },
};

/**
 * Polygons: hit inside (the outer ring, not a hole) or within the tolerance of an edge; a
 * MultiPolygon is hit on any of its polygons
 *
 * @internal
 */
export const polygonsShapeTest: Required<ShapeHitTest> = {
  testShape(shape, coordinate, tolerance) {
    for (const rings of shape.parts) {
      if (testRings(rings, coordinate, tolerance)) return true;
    }
    return false;
  },
  distanceShape(shape, coordinate) {
    let min = Number.POSITIVE_INFINITY;
    for (const rings of shape.parts) min = Math.min(min, distanceToRings(rings, coordinate));
    return min;
  },
  testDistanceShape(shape, coordinate, tolerance) {
    let min = Number.POSITIVE_INFINITY;
    for (const rings of shape.parts) {
      const distance = testDistanceRings(rings, coordinate, tolerance);
      if (distance !== null && distance < min) min = distance;
    }
    return min <= tolerance ? min : null;
  },
};

/**
 * Whether the rings of a polygon are hit
 *
 * @internal
 */
export function testRings(
  rings: readonly PositionRun[],
  coordinate: Coordinate,
  tolerance: number,
): boolean {
  if (rings.length === 0) return false;
  if (insideRings(coordinate, rings)) return true;
  return edgeDistance(coordinate, rings) <= tolerance;
}

/**
 * The distance to the rings of a polygon (0 inside)
 *
 * @internal
 */
export function distanceToRings(rings: readonly PositionRun[], coordinate: Coordinate): number {
  if (rings.length === 0) return Number.POSITIVE_INFINITY;
  if (insideRings(coordinate, rings)) return 0;
  return edgeDistance(coordinate, rings);
}

/**
 * The distance to the rings of a polygon when it is hit (0 inside), null otherwise
 *
 * @internal
 */
export function testDistanceRings(
  rings: readonly PositionRun[],
  coordinate: Coordinate,
  tolerance: number,
): number | null {
  if (rings.length === 0) return null;
  // The inside needs the crossings of every ring, so it stays a full scan
  if (insideRings(coordinate, rings)) return 0;
  const latScale = latitudeScale(coordinate[1]);
  let min = Number.POSITIVE_INFINITY;
  for (const ring of rings) {
    const distance = runDistanceWithin(ring, coordinate, tolerance, latScale);
    if (distance !== null && distance < min) min = distance;
  }
  return min <= tolerance ? min : null;
}

/** Whether a point is inside the outer ring and in no hole */
function insideRings(point: Coordinate, rings: readonly PositionRun[]): boolean {
  const [x, y] = point;
  if (!insideRing(x, y, rings[0])) return false;
  for (let i = 1; i < rings.length; i++) {
    if (insideRing(x, y, rings[i])) return false;
  }
  return true;
}

/** Whether a point is inside a ring (ray casting) */
function insideRing(x: number, y: number, ring: PositionRun): boolean {
  let inside = false;
  const n = ring.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = ring.x(i);
    const yi = ring.y(i);
    const xj = ring.x(j);
    const yj = ring.y(j);
    const crosses = yi > y !== yj > y;
    if (crosses && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** The shortest distance from a point to the edges of rings */
function edgeDistance(point: Coordinate, rings: readonly PositionRun[]): number {
  const latScale = latitudeScale(point[1]);
  let min = Number.POSITIVE_INFINITY;
  for (const ring of rings) min = Math.min(min, localPointToRunDistance(point, ring, latScale));
  return min;
}

/**
 * Circles: hit within the radius from the center (`radiusMeters` of the shape), with the
 * tolerance in meters and at least 10 meters
 *
 * @internal
 */
export const circleShapeTest: ShapeHitTest = {
  testShape(shape, coordinate, toleranceLngLat) {
    const center = centerOf(shape);
    const radiusMeters = shape.radiusMeters;
    if (!center || radiusMeters === undefined || radiusMeters <= 0) return false;
    const distanceMeters = haversineDistanceMeters(coordinate, center);
    // The tolerance is a longitude difference: in meters at the latitude of the center
    const toleranceMeters =
      Math.abs(metersToLng(1, center[1])) > 0
        ? (toleranceLngLat / metersToLng(1, center[1])) * 1
        : 0;
    const effectiveTolerance = Math.max(toleranceMeters, 10);
    return distanceMeters <= radiusMeters + effectiveTolerance;
  },
  distanceShape(shape, coordinate) {
    const center = centerOf(shape);
    const radiusMeters = shape.radiusMeters;
    if (!center || radiusMeters === undefined || radiusMeters <= 0) {
      return Number.POSITIVE_INFINITY;
    }
    // The distance from the boundary of the circle, inside or outside
    return Math.abs(haversineDistanceMeters(coordinate, center) - radiusMeters);
  },
};

/** The center of a circle: the one position of its shape */
function centerOf(shape: HitShape): Coordinate | null {
  const run = firstPart(shape)[0];
  return run && run.length > 0 ? [run.x(0), run.y(0)] : null;
}
