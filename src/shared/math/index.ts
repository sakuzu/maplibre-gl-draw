// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Math module
 *
 * A module that brings together geographic coordinate computation and pure geometric
 * computation.
 */

// Angle computation
export { getAngleFromCenter, getPointAtAngle } from './angle.js';
// Circle rendering
export { generateCirclePolygon } from './circle.js';
// Constants
export {
  DASH_PATTERNS,
  DEFAULT_TILE_SIZE,
  EARTH,
  getDashPattern,
  RENDERING_DEFAULTS,
} from './constants.js';

// Distance computation
export {
  euclideanDistance,
  getMetersPerPixel,
  haversineDistanceMeters,
  lngToMeters,
  metersToDegreesLat,
  metersToDegreesLng,
  metersToLat,
  metersToLng,
  midpoint,
  pixelsToDegreesLat,
  pixelsToDegreesLng,
  pointToPolylineDistance,
  pointToSegmentDistance,
  toDegrees,
  toRadians,
} from './distance.js';
// Intersection testing
export type { OBBCorners } from './intersection.js';
export {
  pointInRectangle,
  rectangleIntersectsCircle,
  rectangleIntersectsLineString,
  rectangleIntersectsOBB,
  rectangleIntersectsPolygon,
  segmentIntersectsRectangle,
  segmentIntersectsSegment,
} from './intersection.js';
// OBB
export type { OBB } from './obb.js';
export { createOBB, distanceToOBB, getOBBAABB, getOBBCorners, pointInOBB } from './obb.js';
// Rotation computation
export {
  computeRotatedQuadCorners,
  ecefToWGS84,
  kmToDegrees,
  pixelsToDegrees,
  rotateCoordinateOnSphere,
  rotateCoordinatesOnSphere,
  wgs84ToECEF,
} from './rotation.js';
// Coordinate transformation
export type {
  AnchorProjector,
  CoordinateTransform,
  LngLat,
  MercatorCoord,
  ScreenPoint,
} from './transform.js';
export {
  applyMarginToBoundingBox,
  clampCoordinate,
  clampLatitude,
  createCoordinateTransform,
  getAnchorProjector,
  lngLatToMercator,
  setAnchorProjector,
} from './transform.js';
