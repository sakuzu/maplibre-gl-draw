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

import type { Geometry } from 'geojson';
import type { Coordinate, FeatureCoordinates, FeatureType } from '../types/model.js';

/** The kind of a GeoJSON geometry that has coordinates */
export type GeometryKind = Exclude<Geometry['type'], 'GeometryCollection'>;

/**
 * The kind of geometry of each built-in feature type
 *
 * A Circle and an Image are held as the Point of their center and their anchor.
 */
const BUILT_IN_GEOMETRY_KINDS: ReadonlyMap<string, GeometryKind> = new Map<string, GeometryKind>([
  ['Point', 'Point'],
  ['Circle', 'Point'],
  ['Image', 'Point'],
  ['LineString', 'LineString'],
  ['Freehand', 'LineString'],
  ['Polygon', 'Polygon'],
  ['MultiPoint', 'MultiPoint'],
  ['MultiLineString', 'MultiLineString'],
  ['MultiPolygon', 'MultiPolygon'],
]);

/**
 * The kind of geometry of a built-in feature type, or undefined for a custom type
 */
export function builtInGeometryKind(type: FeatureType): GeometryKind | undefined {
  return BUILT_IN_GEOMETRY_KINDS.get(type);
}

/** The kind of geometry of coordinates of each nesting depth, for a custom type */
const KINDS_BY_DEPTH: readonly GeometryKind[] = ['Point', 'LineString', 'Polygon', 'MultiPolygon'];

/**
 * The kind of geometry a feature type holds
 *
 * A built-in type has a fixed kind. A custom type is read from its coordinates as they come:
 * a single position is a Point, a list of positions a LineString, a list of lists a Polygon
 * and one level deeper a MultiPolygon.
 */
export function geometryKindOf(type: FeatureType, coordinates: FeatureCoordinates): GeometryKind {
  const builtIn = BUILT_IN_GEOMETRY_KINDS.get(type);
  if (builtIn) return builtIn;
  let depth = 0;
  let value: unknown = coordinates;
  while (Array.isArray(value) && Array.isArray(value[0])) {
    depth++;
    value = value[0];
  }
  return KINDS_BY_DEPTH[Math.min(depth, KINDS_BY_DEPTH.length - 1)];
}

/**
 * The GeoJSON geometry of a feature type with the given coordinates (the kind follows
 * {@link geometryKindOf}; the coordinates are used as they are, not copied)
 */
export function geometryFromCoordinates(
  type: FeatureType,
  coordinates: FeatureCoordinates,
): Geometry {
  return { type: geometryKindOf(type, coordinates), coordinates } as Geometry;
}

/**
 * The coordinates of the geometry of a feature, nested as deep as its kind (an empty array
 * for a GeometryCollection, which has none of its own)
 */
export function coordinatesOf(feature: { readonly geometry: Geometry }): FeatureCoordinates;
export function coordinatesOf(
  feature: { readonly geometry: Geometry } | null | undefined,
): FeatureCoordinates | undefined;
export function coordinatesOf(
  feature: { readonly geometry: Geometry } | null | undefined,
): FeatureCoordinates | undefined {
  if (feature == null) return undefined;
  const { geometry } = feature;
  return geometry.type === 'GeometryCollection' ? [] : (geometry.coordinates as FeatureCoordinates);
}

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
    return transform(coords) as unknown as T;
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
