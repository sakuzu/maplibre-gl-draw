// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Geometry module
 *
 * A collection of pure functions independent of the rendering and editing machinery.
 * It does not depend on maplibre, the DOM, wasm, the Store or events, and its only
 * runtime dependency is polygon-clipping. The same input produces the same output
 * regardless of the environment, and determinism is guaranteed by the version of the
 * package.
 *
 * As a limitation, crossing the ±180 degree meridian and the vicinity of the poles are
 * out of scope.
 */

// Coordinate generation from a bearing
export { getPointAtAngle } from './angle.js';
// Bounding box
export { bboxContains, bboxIntersects, boundingBox, coordinatesBBox } from './bbox.js';
// Boolean operations
export {
  clip,
  difference,
  differenceAll,
  intersection,
  intersectionAll,
  normalizeArea,
  union,
  unionAll,
} from './boolean.js';
// Buffer
export type { BufferOptions } from './buffer.js';
export { buffer, DEFAULT_BUFFER_SEGMENTS } from './buffer.js';
// Geodesic circle
export { generateCirclePolygon } from './circle.js';
// Discrimination and normalization of coordinate shapes
export {
  closeRing,
  flattenAreaCoordinates,
  isMultiPolygonCoordinates,
  isRingClosed,
  toMultiPolygonCoordinates,
} from './coords.js';
// Geodesic distance and bearing
export { destinationPoint, haversineDistanceMeters, initialBearingDegrees } from './distance.js';
// Errors
export type { GeometryErrorCode, GeometryOperation } from './errors.js';
export { GeometryError } from './errors.js';
// Measurement
export { centroid, geodesicLength, pointOnSurface, sphericalArea } from './measure.js';
// Predicates
export { contains, intersects, pointInPolygon, within } from './predicates.js';
// Shaping
export {
  isRingClockwise,
  normalizeMultiPolygonOrientation,
  normalizePolygonOrientation,
  normalizeRingOrientation,
  signedRingArea,
  simplify,
} from './simplify.js';
// Splitting by a line
export { segmentIntersection, splitArea } from './split.js';
// Types
export type {
  AreaCoordinates,
  BBox,
  Coordinate,
  GeometryInput,
  LineStringGeometry,
  MultiLineStringGeometry,
  MultiPointGeometry,
  MultiPolygonCoordinates,
  MultiPolygonGeometry,
  PointGeometry,
  PolygonCoordinates,
  PolygonGeometry,
  Ring,
} from './types.js';
// Unit conversion and geodetic constants
export { EARTH_RADIUS_METERS, toDegrees, toRadians } from './units.js';
