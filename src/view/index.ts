// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * View module
 *
 * The rendering layer of the Flux architecture.
 * It watches the Store state and renders it with WebGL.
 *
 * Only the symbols that src/index.ts publishes are listed here (see "The public
 * surface" in CONTRIBUTING.md). Internal code imports from the defining file.
 */

export type {
  CompanionHit,
  CompanionHitContext,
  FeatureCompanionHitResult,
  FeatureCompanionProvider,
  FeatureCompanionRegistry,
} from './feature-companion.js';
export { createFeatureCompanionRegistry } from './feature-companion.js';
export type { BlendCapableGL } from './layer/blend.js';
export { applyDrawBlendState } from './layer/blend.js';
export type { RenderSlot } from './layer/slots.js';
export type { DashSegment } from './renderers/line/dash.js';
export { getStrokeDashPattern, splitIntoDashes } from './renderers/line/dash.js';
export type {
  SDFLineRenderer,
  SDFStrokeOptions,
  SDFStrokeStyle,
} from './renderers/line/sdf-line.js';
export { drawBillboardsWithoutDepth } from './renderers/point/billboard-depth.js';
export type { PointShape, PointShapeRenderer, PointStyle } from './renderers/point/point-shape.js';
export type { FillShaderManager } from './renderers/polygon/fill.js';
export type { Color, LineStyle, StrokeStyle, WidthUnit } from './renderers/stroke.js';
export type { OffsetUniforms, ShaderData } from './shaders/helpers.js';
export {
  calculateLngLatOffset,
  calculateOffsetUniforms,
  createProgram,
  getProjectionTransitionUniform,
  OFFSET_MODE_GLSL,
} from './shaders/helpers.js';
export type { ProjectionUniformLocations } from './shaders/projection.js';
export { ProjectionUniformManager } from './shaders/projection.js';
export type { QuadVertices } from './shaders/quad.js';
export { computeQuadVertices, drawQuadSurfaceOnTerrain, QuadShader } from './shaders/quad.js';
export type { LegendEntry, StyleRuleChannel } from './style-rule.js';
export {
  applyRuleColor,
  deriveLegend,
  evaluateStyleRule,
  getStyleRuleChannel,
  resolveFeatureStyle,
  resolveRuleColor,
} from './style-rule.js';
export { anchorElevationMeters, getAnchorElevationGeneration } from './terrain/anchor.js';
export type { TerrainContext, TerrainDrapeDebug, TerrainRenderState } from './terrain/context.js';
export type {
  DrapeQuadCorners,
  QuadDrapeColor,
  QuadDrapeFill,
  QuadDrapeGlyphs,
  QuadDrapeSurface,
} from './terrain/drape/quad.js';
export { QUAD_GLYPH_STRIDE } from './terrain/drape/quad-glyphs.js';
export { metersToMercatorScale } from './terrain/metrics.js';
export { anchorGhostOpacity } from './terrain/occlusion.js';
export { terrainTessellationStep } from './terrain/polygon.js';
export type { MercatorRect, TessellationStep, TessellationTiling } from './terrain/tessellation.js';
export { densifyPath } from './terrain/tessellation.js';
export type {
  AuxiliaryHandle,
  AuxiliaryHandleContext,
  AuxiliaryHandleHit,
  AuxiliaryHandleProvider,
  AuxiliaryHandleRegistry,
} from './ui/auxiliary-handles.js';
export type { HandleInfo } from './ui/handles.js';
export { getSelectedFeatureIds } from './ui/helper.js';
export type { SelectionScope } from './ui/selection-scope.js';
export { computeBoundingBox, hasZeroArea } from './ui/selection-ui/bounding-box.js';
export type { SelectionExtensionRegistry } from './ui/selection-ui/extension-registry.js';
export {
  createSelectionExtensionRegistry,
  DEFAULT_POINT_FRAME_SIZE,
} from './ui/selection-ui/extension-registry.js';
export type {
  AdditionalHandleInfo,
  AdditionalResizeHandlesCalculator,
  BoundingBoxCoords,
  CustomBoundingBoxCalculator,
  CustomResizeCalculator,
  PointFrameExtent,
  PointFrameExtentProvider,
  ResizeStrategy,
} from './ui/selection-ui/types.js';
export { DEFAULT_VIEWPORT_EXPANSION_FACTOR, getExpandedViewportBounds } from './viewport.js';
