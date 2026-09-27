// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Geometry calculations that need no map.
 *
 * Measure lengths and areas, build circles and buffers, combine polygons, test whether a
 * point lies in a polygon, and tidy shapes. They also work in code that does not use the
 * drawing engine (workers, servers, tests).
 *
 * ```ts
 * import { area, buffer, union } from '@sakuzu/maplibre-gl-draw/geometry';
 *
 * const parks = draw.document
 *   .toGeoJSON()
 *   .features.filter((f) => f.properties?.kind === 'park');
 * const merged = union(parks);                  // Polygon | MultiPolygon | null
 * const zone = merged && buffer(merged, 300);   // the area within 300 m
 * if (zone) console.log(area(zone) / 1e6, 'km²');
 * ```
 *
 * The functions take GeoJSON geometries, or GeoJSON features whose geometry they use, and
 * return GeoJSON geometries. Lengths, distances, radii and tolerances are in meters, areas in
 * square meters, and bearings and coordinates in degrees. An input whose shape a function
 * cannot take throws a {@link GeometryError}; a computation whose result is empty returns null.
 * Crossing the ±180 degree meridian and the vicinity of the poles are out of scope.
 *
 * Read next: the guide
 * [snapping and geometry](https://sakuzu.github.io/maplibre-gl-draw/guides/snapping-geometry),
 * which also shows the operations that change the drawing (`draw.features.union` and the
 * rest). The functions used most are {@link area}, {@link length}, {@link buffer} and
 * {@link union}.
 *
 * @module geometry
 */

// biome-ignore-all assist/source/organizeImports: the exports are grouped by section

// Measure
export {
  along,
  area,
  bearing,
  centroid,
  destination,
  distance,
  length,
  midpoint,
  nearestPointOnLine,
  perimeter,
  pointOnSurface,
} from './public-measure.js';

// Create
export { buffer, circle } from './public-create.js';

// Combine
export { difference, intersection, split, union } from './public-combine.js';

// Test
export { bboxContains, bboxIntersects } from './bbox.js';
export { contains, overlaps, pointInPolygon } from './public-predicates.js';

// Repair
export { makeValid, rewind, simplify } from './public-repair.js';

// Bounds and units
export { bbox } from './public-bounds.js';
export { metersToDegrees } from './units.js';

// Types and errors
export type { GeometryErrorCode } from './errors.js';
export { GeometryError } from './errors.js';
export type { BBox } from './types.js';
export { EARTH_RADIUS_METERS } from './units.js';
