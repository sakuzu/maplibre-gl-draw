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
export { DEFAULT_TILE_SIZE } from '../shared/math/index.js';
export {
  calculateLngLatOffset,
  createProgram,
  OFFSET_MODE_GLSL,
  ProjectionUniformManager,
} from '../view/index.js';

// Blending and billboards
export { applyDrawBlendState, drawBillboardsWithoutDepth } from '../view/index.js';

// Quads
export type { QuadDrapeGlyphs, QuadVertices } from '../view/index.js';
export {
  computeQuadVertices,
  drawQuadSurfaceOnTerrain,
  QUAD_GLYPH_STRIDE,
  QuadShader,
} from '../view/index.js';

// Lines
export type { SDFStrokeOptions, SDFStrokeStyle, WidthUnit } from '../view/index.js';
export { getStrokeDashPattern as dashPattern, splitIntoDashes } from '../view/index.js';

// Terrain
export { densifyPath, terrainTessellationStep } from '../view/index.js';

// Hit testing
export { PointHitTestStrategy } from '../dispatcher/index.js';

// Supporting types
export type {
  BlendCapableGL,
  DashSegment,
  DrapeQuadCorners,
  MercatorRect,
  ProjectionUniformLocations,
  QuadDrapeColor,
  QuadDrapeFill,
  QuadDrapeSurface,
  TerrainContext,
  TerrainRenderState,
  TessellationStep,
  TessellationTiling,
} from '../view/index.js';
