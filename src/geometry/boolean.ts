// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Boolean operations
 *
 * The body is polygon-clipping. The input accepts either Polygon coordinates or
 * MultiPolygon coordinates, and the result is always returned as MultiPolygon
 * coordinates. Because these are topological operations that use no metric of
 * distance or area, they close correctly on the lng/lat plane as it is.
 */

import polygonClipping from 'polygon-clipping';
import { usableAreaParts } from './coords.js';
import { type GeometryOperation, toGeometryError } from './errors.js';
import type { AreaCoordinates, MultiPolygonCoordinates } from './types.js';

/**
 * Shapes the input into a form that can be passed to polygon-clipping
 *
 * A ring that cannot bound an area (fewer than 3 points, or a coordinate that is not a
 * finite number) is dropped, and a part whose outer ring is dropped is removed with its
 * holes. polygon-clipping itself throws an internal error on NaN and silently drops
 * Infinity, so this is the boundary that keeps such input from reaching it.
 */
function sanitize(coordinates: AreaCoordinates): MultiPolygonCoordinates {
  return usableAreaParts(coordinates);
}

/**
 * The step of the grid onto which the coordinates are placed on a retry (degrees)
 *
 * 1e-9 degrees is roughly 0.1mm at the equator, and the displacement caused by the
 * rounding is half of that, so it does not show up in the measurements of a feature
 * (the same step as NODE_QUANTUM in split.ts). On the other hand it is 5 digits larger
 * than the smallest step of double precision (about 1.4e-14 degrees in the 140-degree
 * longitude range), so a discrepancy arising from cancellation is absorbed for certain.
 */
const SNAP_QUANTUM = 1e-9;

/**
 * Returns a copy with the coordinates placed onto the grid
 */
function snap(parts: MultiPolygonCoordinates): MultiPolygonCoordinates {
  return parts.map((polygon) =>
    polygon.map((ring) =>
      ring.map(
        ([x, y]) =>
          [
            Math.round(x / SNAP_QUANTUM) * SNAP_QUANTUM,
            Math.round(y / SNAP_QUANTUM) * SNAP_QUANTUM,
          ] as [number, number],
      ),
    ),
  );
}

/** The operations of polygon-clipping, by name */
const OPERATIONS: Record<
  GeometryOperation,
  (first: MultiPolygonCoordinates, ...rest: MultiPolygonCoordinates[]) => MultiPolygonCoordinates
> = {
  union: polygonClipping.union,
  difference: polygonClipping.difference,
  intersection: polygonClipping.intersection,
};

/**
 * Calls polygon-clipping and, only when it fails, rounds the coordinates and retries
 * once
 *
 * Vertices that adjacent polygons hold on the same edge can differ by the smallest step
 * of double precision when they are produced by separate operations. polygon-clipping
 * regards this difference as identical in its comparisons while treating the points as
 * distinct in value, so it fails to close the output ring and throws an exception.
 * Placing the coordinates back onto the grid makes the shifted vertices take the same
 * value, and the same operation then succeeds.
 *
 * The rounding is applied only to the input that failed. If every input were rounded in
 * advance, there are inputs in which edges that were barely separated by the jitter
 * would overlap completely and become unsolvable instead (the buffer of a nearly
 * collinear line is a real example). The rule of the rounding is deterministic, so even
 * when the retry is entered the result is determined by the input alone.
 *
 * When the retry fails too, the error leaves as a GeometryError with a reason code
 * instead of the internal message of polygon-clipping.
 */
function run(
  operation: GeometryOperation,
  parts: MultiPolygonCoordinates[],
): MultiPolygonCoordinates {
  const clipper = OPERATIONS[operation];
  const [first, ...rest] = parts;
  try {
    return clipper(first, ...rest);
  } catch {
    const [snapped, ...snappedRest] = parts.map(snap);
    try {
      return clipper(snapped, ...snappedRest);
    } catch (error) {
      throw toGeometryError(error, operation);
    }
  }
}

/**
 * Resolves self-intersections and normalizes the orientations (the normalized form of
 * polygon-clipping)
 */
function normalize(coordinates: MultiPolygonCoordinates): MultiPolygonCoordinates {
  if (coordinates.length === 0) {
    return [];
  }
  return run('union', [coordinates]);
}

/**
 * Converts Polygon or MultiPolygon coordinates into normalized MultiPolygon coordinates.
 *
 * Resolves self-intersections (a figure-eight becomes two parts), unifies the ring
 * orientations (outer rings counter-clockwise, holes clockwise) and removes the rings that
 * have no area. Rings with fewer than 3 positions or with a position that is not finite are
 * dropped first, and a part whose outer ring is dropped is dropped with its holes.
 *
 * @param coordinates Polygon or MultiPolygon coordinates in degrees
 * @returns The normalized MultiPolygon coordinates, each ring closed. An empty array means
 *   the input has no area
 * @throws {@link GeometryError} when the boolean operation engine fails even after the
 *   retry on the 1e-9 degree grid
 */
export function normalizeArea(coordinates: AreaCoordinates): MultiPolygonCoordinates {
  return normalize(sanitize(coordinates));
}

/**
 * Returns the union of two polygons.
 *
 * The operation is topological and runs on the lng/lat plane as it is. Rings that cannot
 * bound an area are dropped first (see {@link normalizeArea}), so an input with no area
 * leaves the other input normalized.
 *
 * @param a Polygon or MultiPolygon coordinates in degrees
 * @param b Polygon or MultiPolygon coordinates in degrees
 * @returns The normalized MultiPolygon coordinates of the union. Disjoint inputs become
 *   several parts. An empty array when neither input has an area
 * @throws {@link GeometryError} when the boolean operation engine fails even after the
 *   retry on the 1e-9 degree grid
 */
export function union(a: AreaCoordinates, b: AreaCoordinates): MultiPolygonCoordinates {
  const left = sanitize(a);
  const right = sanitize(b);
  if (left.length === 0) {
    return normalize(right);
  }
  if (right.length === 0) {
    return normalize(left);
  }
  return run('union', [left, right]);
}

/**
 * Returns the part of one polygon that lies outside another.
 *
 * Removing a region inside `a` produces a hole (an inner ring).
 *
 * @param a The Polygon or MultiPolygon coordinates to subtract from, in degrees
 * @param b The Polygon or MultiPolygon coordinates to subtract, in degrees
 * @returns The normalized MultiPolygon coordinates of `a` with `b` removed. An empty array
 *   when `a` has no area or `b` covers it. `a` normalized when `b` has no area
 * @throws {@link GeometryError} when the boolean operation engine fails even after the
 *   retry on the 1e-9 degree grid
 */
export function difference(a: AreaCoordinates, b: AreaCoordinates): MultiPolygonCoordinates {
  const left = sanitize(a);
  const right = sanitize(b);
  if (left.length === 0) {
    return [];
  }
  if (right.length === 0) {
    return normalize(left);
  }
  return run('difference', [left, right]);
}

/**
 * Returns the common part of two polygons.
 *
 * @param a Polygon or MultiPolygon coordinates in degrees
 * @param b Polygon or MultiPolygon coordinates in degrees
 * @returns The normalized MultiPolygon coordinates of the common part. An empty array when
 *   the inputs do not overlap, when only their boundaries touch, and when either has no
 *   area
 * @throws {@link GeometryError} when the boolean operation engine fails even after the
 *   retry on the 1e-9 degree grid
 */
export function intersection(a: AreaCoordinates, b: AreaCoordinates): MultiPolygonCoordinates {
  const left = sanitize(a);
  const right = sanitize(b);
  if (left.length === 0 || right.length === 0) {
    return [];
  }
  return run('intersection', [left, right]);
}

/**
 * Keeps only the part of a subject polygon that lies inside a clip region.
 *
 * Between polygons it is the same operation as {@link intersection}; it differs only in
 * that the meaning of the arguments (the subject and the region) is fixed.
 *
 * @param subject The Polygon or MultiPolygon coordinates to clip, in degrees
 * @param clipRegion The Polygon or MultiPolygon coordinates of the region, in degrees
 * @returns The normalized MultiPolygon coordinates that remain inside the region. An empty
 *   array when nothing remains or either input has no area
 * @throws {@link GeometryError} when the boolean operation engine fails even after the
 *   retry on the 1e-9 degree grid
 */
export function clip(
  subject: AreaCoordinates,
  clipRegion: AreaCoordinates,
): MultiPolygonCoordinates {
  return intersection(subject, clipRegion);
}

/**
 * Returns the union of every polygon in an array.
 *
 * Passing many inputs to the engine at once can make it fail to close the output ring, so
 * they are folded in the shape of a binary tree (cascaded union). The union is associative
 * and the order of the folding is fixed, so the result is deterministic. Elements with no
 * area are skipped.
 *
 * @param geometries Polygon or MultiPolygon coordinates in degrees
 * @returns The normalized MultiPolygon coordinates of the union. An empty array for an
 *   empty array and when no element has an area
 * @throws {@link GeometryError} when the boolean operation engine fails even after the
 *   retry on the 1e-9 degree grid
 */
export function unionAll(geometries: AreaCoordinates[]): MultiPolygonCoordinates {
  const parts = geometries.map(sanitize).filter((part) => part.length > 0);
  if (parts.length === 0) {
    return [];
  }
  if (parts.length === 1) {
    return run('union', [parts[0]]);
  }

  let level = parts;
  while (level.length > 1) {
    const next: MultiPolygonCoordinates[] = [];
    for (let i = 0; i < level.length; i += 2) {
      // The odd one out is carried up to the next level as it is
      next.push(i + 1 < level.length ? run('union', [level[i], level[i + 1]]) : level[i]);
    }
    level = next;
  }
  return level[0];
}

/**
 * Returns the part common to every polygon in an array.
 *
 * The intersection shrinks monotonically, so the elements are folded in order from the
 * head and the fold stops as soon as it becomes empty.
 *
 * @param geometries Polygon or MultiPolygon coordinates in degrees
 * @returns The normalized MultiPolygon coordinates common to all of them. An empty array for
 *   an empty array and when even one element has no area
 * @throws {@link GeometryError} when the boolean operation engine fails even after the
 *   retry on the 1e-9 degree grid
 */
export function intersectionAll(geometries: AreaCoordinates[]): MultiPolygonCoordinates {
  if (geometries.length === 0) {
    return [];
  }
  const parts = geometries.map(sanitize);
  if (parts.some((part) => part.length === 0)) {
    return [];
  }

  let result = normalize(parts[0]);
  for (let i = 1; i < parts.length; i++) {
    if (result.length === 0) {
      return [];
    }
    result = run('intersection', [result, parts[i]]);
  }
  return result;
}

/**
 * Returns a subject polygon with every polygon in an array removed.
 *
 * @param subject The Polygon or MultiPolygon coordinates to subtract from, in degrees
 * @param geometries The Polygon or MultiPolygon coordinates to subtract, in degrees.
 *   Elements with no area are skipped
 * @returns The normalized MultiPolygon coordinates of the difference. An empty array when
 *   the subject has no area or is covered. The subject normalized when nothing is
 *   subtracted
 * @throws {@link GeometryError} when the boolean operation engine fails even after the
 *   retry on the 1e-9 degree grid
 */
export function differenceAll(
  subject: AreaCoordinates,
  geometries: AreaCoordinates[],
): MultiPolygonCoordinates {
  const left = sanitize(subject);
  if (left.length === 0) {
    return [];
  }
  const parts = geometries.map(sanitize).filter((part) => part.length > 0);
  if (parts.length === 0) {
    return normalize(left);
  }
  return run('difference', [left, ...parts]);
}
