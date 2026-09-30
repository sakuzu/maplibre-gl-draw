// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * UI Rendering module
 *
 * Responsible for drawing the selection UI, bounding boxes, handles and tentative state.
 */

// Drawing the box selection
export { BoxSelectionRenderer } from './box-selection.js';
// Hit testing of the handles
export type { HandleHitResult } from './handle-test.js';
export {
  getCursorForHandle,
  hitTestGlobalAuxiliaryHandles,
  hitTestHandles,
} from './handle-test.js';
// Computing and drawing the handles
export type { HandleInfo } from './handles.js';
export {
  computeMidpointHandles,
  computeResizeHandles,
  computeRotateHandle,
  computeVertexHandles,
  SelectionHandlesRenderer,
} from './handles.js';
// Helpers for the selection information
export {
  computeSelectionBoundingBox,
  getSelectedFeatureIds,
  getSelectedFeatures,
} from './helper.js';
// Computing and drawing the selection UI
export type {
  AdditionalHandleInfo,
  AdditionalResizeHandlesCalculator,
  BoundingBoxCoords,
  CustomBoundingBoxCalculator,
  PointFrameExtent,
  PointFrameExtentProvider,
  ResizeStrategy,
  SelectionExtensionRegistry,
  TypeResizeCalculator,
} from './selection-ui/index.js';
export {
  computeBoundingBox,
  computeCombinedBoundingBox,
  createSelectionExtensionRegistry,
  DEFAULT_POINT_FRAME_SIZE,
  rotateBoundingBox,
  SelectionUIRenderer,
} from './selection-ui/index.js';
// Drawing the tentative state
export type { TentativeRendererDeps } from './tentative.js';
export { TentativeRenderer } from './tentative.js';
