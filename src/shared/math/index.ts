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
  haversineDistanceMeters,
  midpoint,
  pointToPolylineDistance,
  pointToSegmentDistance,
  toDegrees,
  toRadians,
} from './distance.js';
// Sizes in pixels as lengths on the ground
export {
  degreesPerMeterAt,
  degreesPerPixelAtZoom,
  metersOnTangentPlane,
  metersPerPixelAtZoom,
  offsetOnTangentPlane,
  worldSizeAtZoom,
} from './ground-scale.js';
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
  rotateCoordinateOnSphere,
  rotateCoordinatesOnSphere,
  wgs84ToECEF,
} from './rotation.js';
// The scale of a size of the current view
export type { ScreenScaleFrame, ScreenScaleUniforms } from './screen-scale.js';
export { metersPerPixelInFrame, screenScaleUniformsOf } from './screen-scale.js';
// Coordinate transformation
export type {
  AnchorProjector,
  CoordinateTransform,
  LngLat,
  MercatorCoord,
  ScreenPoint,
  ViewProjector,
} from './transform.js';
export {
  applyMarginToBoundingBox,
  clampCoordinate,
  clampLatitude,
  createCoordinateTransform,
  expandQuad,
  getAnchorProjector,
  getViewProjector,
  lngLatToMercator,
  screenScaleFrameOf,
  setAnchorProjector,
  setScreenScaleFrame,
  setViewProjector,
} from './transform.js';
