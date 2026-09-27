// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Selection UI module
 *
 * Visual feedback for the selection state (BoundingBox / custom calculators / Renderer).
 * The files are split per feature, and this index is a barrel that re-exports their public
 * symbols.
 */

export {
  computeBoundingBox,
  computeCombinedBoundingBox,
  hasZeroArea,
  rotateBoundingBox,
} from './bounding-box.js';
export type { SelectionExtensionRegistry } from './extension-registry.js';
export {
  createSelectionExtensionRegistry,
  DEFAULT_POINT_FRAME_SIZE,
  resolvePointFrameExtentWith,
} from './extension-registry.js';
export { SelectionUIRenderer } from './renderer.js';
export type {
  AdditionalHandleInfo,
  AdditionalResizeHandlesCalculator,
  BoundingBoxCoords,
  CustomBoundingBoxCalculator,
  PointFrameExtent,
  PointFrameExtentProvider,
  ResizeStrategy,
  TypeResizeCalculator,
} from './types.js';
