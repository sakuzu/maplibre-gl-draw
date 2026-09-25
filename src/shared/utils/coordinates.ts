// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Coordinate traversal utilities
 *
 * The coordinates of a Feature have a different array nesting depth per type
 * (Point has 1 level, LineString has 2, Polygon / MultiLineString have 3, and
 * MultiPolygon has 4). Moving, resizing, rotating and computing the bounding box apply the
 * same processing to every coordinate at any depth, so the depth-independent recursive
 * traversal is collected here.
 */

import type { Coordinate, FeatureCoordinates, FeatureType } from '../types/model.js';

/**
 * The Multi family of feature types
 */
export const MULTI_FEATURE_TYPES = ['MultiPoint', 'MultiLineString', 'MultiPolygon'] as const;

const MULTI_FEATURE_TYPE_SET: ReadonlySet<string> = new Set(MULTI_FEATURE_TYPES);

/**
 * Tests whether it is one of the Multi family of feature types
 */
export function isMultiFeatureType(type: FeatureType): boolean {
  return MULTI_FEATURE_TYPE_SET.has(type as string);
}

/**
 * Tests whether a value is a single coordinate `[lng, lat]`
 */
export function isCoordinate(value: unknown): value is Coordinate {
  return Array.isArray(value) && value.length === 2 && typeof value[0] === 'number';
}

/**
 * Returns new coordinates with a transform function applied to every coordinate (the nesting
 * depth is preserved)
 *
 * The coordinate mapping of moving, resizing and rotating shares this function.
 * It can traverse the 4-level nesting of a Multi geometry as is.
 */
export function mapCoordinatesDeep<T extends FeatureCoordinates>(
  coords: T,
  transform: (coord: Coordinate) => Coordinate,
): T {
  if (isCoordinate(coords)) {
    return transform(coords) as T;
  }
  if (Array.isArray(coords)) {
    return (coords as FeatureCoordinates[]).map((child) =>
      mapCoordinatesDeep(child, transform),
    ) as T;
  }
  return coords;
}

/**
 * Enumerates every coordinate in order
 *
 * Used in the union computation of the bounding box and of hit testing.
 */
export function forEachCoordinateDeep(
  coords: FeatureCoordinates,
  visit: (coord: Coordinate) => void,
): void {
  if (isCoordinate(coords)) {
    visit(coords);
    return;
  }
  if (Array.isArray(coords)) {
    for (const child of coords as FeatureCoordinates[]) {
      forEachCoordinateDeep(child, visit);
    }
  }
}

/**
 * Gets every coordinate as a flat array
 */
export function flattenCoordinatesDeep(coords: FeatureCoordinates): Coordinate[] {
  const result: Coordinate[] = [];
  forEachCoordinateDeep(coords, (coord) => {
    result.push(coord);
  });
  return result;
}

/**
 * Whether the feature type supports vertex editing (vertex handles / midpoint handles)
 *
 * LineString / Polygon and the Multi types are supported. Point / Circle / Freehand /
 * Image / custom features do not show vertex handles; they are edited with move, resize
 * and rotate only.
 *
 * Handle rendering, hit testing, click-based vertex selection and the visibility control
 * of the selection UI all share this predicate, which prevents per-path discrepancies
 * such as "visible but not grabbable" or "grabbable but not selectable".
 */
export function supportsVertexEditing(type: FeatureType): boolean {
  return type === 'LineString' || type === 'Polygon' || isMultiFeatureType(type);
}
