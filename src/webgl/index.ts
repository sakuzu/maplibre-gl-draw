// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Building blocks for people who write their own shaders: GLSL snippets, the projection
 * uniforms, the quad shader and the rules the shared renderers follow for dashes and terrain.
 * This entry is the second layer of the public API and may change in a minor release.
 * `RenderContext` already passes the shared renderers to a renderer, so most overlays do not
 * need this entry.
 *
 * @module webgl
 */

// biome-ignore-all assist/source/organizeImports: the exports are grouped by section

// Shaders and projection
export { DEFAULT_TILE_SIZE } from '../shared/math/constants.js';
export {
  calculateLngLatOffset,
  createProgram,
  OFFSET_MODE_GLSL,
} from '../view/shaders/helpers.js';
export { ProjectionUniformManager } from '../view/shaders/projection.js';

// Blending and billboards
export { applyDrawBlendState } from '../view/layer/blend.js';
export { drawBillboardsWithoutDepth } from '../view/renderers/point/billboard-depth.js';

// Quads
export type { QuadDrapeGlyphs } from '../view/terrain/drape/quad.js';
export type { QuadVertices } from '../view/shaders/quad.js';
export { computeQuadVertices, drawQuadSurfaceOnTerrain, QuadShader } from '../view/shaders/quad.js';
export { QUAD_GLYPH_STRIDE } from '../view/terrain/drape/quad-glyphs.js';

// Lines
export type { SDFStrokeOptions, SDFStrokeStyle } from '../view/renderers/line/sdf-line.js';
export type { WidthUnit } from '../view/renderers/stroke.js';
export {
  getStrokeDashPattern as dashPattern,
  splitIntoDashes,
} from '../view/renderers/line/dash.js';

// Terrain
export { terrainTessellationStep } from '../view/terrain/polygon.js';
export { densifyPath } from '../view/terrain/tessellation.js';

// Hit testing
export { PointHitTestStrategy } from '../dispatcher/hit-test/strategies/point.js';

// Supporting types
export type { BlendCapableGL } from '../view/layer/blend.js';
export type { DashSegment } from '../view/renderers/line/dash.js';
export type { ProjectionUniformLocations } from '../view/shaders/projection.js';
export type {
  DrapeQuadCorners,
  QuadDrapeColor,
  QuadDrapeFill,
  QuadDrapeSurface,
} from '../view/terrain/drape/quad.js';
export type { TerrainContext, TerrainRenderState } from '../view/terrain/context.js';
export type {
  MercatorRect,
  TessellationStep,
  TessellationTiling,
} from '../view/terrain/tessellation.js';
