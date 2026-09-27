// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Utilities module
 *
 * Shared utility functions and helpers.
 */

// Color conversion
export { getContrastColor, interpolateHexColor } from './color.js';
// Coordinate traversal
export {
  flattenCoordinatesDeep,
  forEachCoordinateDeep,
  isCoordinate,
  isMultiFeatureType,
  MULTI_FEATURE_TYPES,
  mapCoordinatesDeep,
} from './coordinates.js';
// Event emitter
export type {
  EventEmitter,
  EventListener,
  EventMap,
  FeaturesChangePayload,
  GeometryAppliedPayload,
  GeometryOperationName,
  LoadErrorPayload,
} from './event-emitter.js';
export { EventEmitterImpl } from './event-emitter.js';
// Image processing
export { isImageFile, type ProcessedImage, processImageFile } from './image.js';
// Map utilities
export { getTileSize } from './map.js';
// Automatic name generation
export {
  type AutoNameConfig,
  AutoNameGenerator,
  type AutoNameType,
  normalizeAutoNameConfig,
} from './name-generator.js';
// Resolution of the rendering pixel ratio
export {
  createPixelRatioSource,
  type PixelRatioInput,
  type PixelRatioProvider,
  type PixelRatioSource,
  resolveContentPixelRatio,
  resolvePixelRatio,
} from './pixel-ratio.js';
// Property manipulation
export {
  getCircleRadius,
  getCreatedZoom,
  getFeatureDescription,
  getFeatureName,
  getImageProperties,
  getRadiusHandleAngle,
  getRotation,
  getScale,
  setCreatedZoom,
  setFeatureDescription,
  setFeatureName,
  setRotation,
  setScale,
} from './property.js';
// Comparison of vertex references
export { getVertexPart, hasVertexRef, isSameVertexRef } from './vertex-ref.js';
