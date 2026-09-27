// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Write your own shaders that draw the way the library does.
 *
 * Use it only when a custom feature type or an overlay needs a shader of its own. The
 * {@link maplibre-gl-draw!RenderContext | RenderContext} a renderer receives already carries
 * the shared renderers of lines, areas and point markers, and most renderers need nothing
 * more. This entry holds the GLSL of the projection, the uniforms that go with it, the quad
 * shader, and the rules the shared renderers follow for dashes and terrain. The parts that draw
 * on the terrain take the render context of the draw call (or its `terrain`). Unlike the main
 * entry, it may change in a minor release.
 *
 * ```ts
 * import {
 *   createProgram, OFFSET_MODE_GLSL, ProjectionUniformManager,
 * } from '@sakuzu/maplibre-gl-draw/webgl';
 *
 * let program: WebGLProgram | null = null;
 * let uniforms: ProjectionUniformManager | null = null;
 * draw.extensions.overlays.add({
 *   name: 'my-shader',
 *   onAdd: () => {},
 *   draw(ctx) {
 *     if (!program) {
 *       const vertex = vertexSource(ctx.shader.vertexShaderPrelude, OFFSET_MODE_GLSL);
 *       program = createProgram(ctx.gl, vertex, fragmentSource);
 *       uniforms = new ProjectionUniformManager(ctx.gl);
 *       uniforms.getLocations(program);
 *     }
 *     ctx.gl.useProgram(program);
 *     uniforms?.setTerrain(ctx);
 *     uniforms?.setUniforms(ctx.projection, ctx.zoom, ctx.offset);
 *     // bind the buffers of your shape and draw it
 *   },
 *   onRemove: (_map, gl) => gl.deleteProgram(program),
 * });
 * ```
 *
 * Read next: the guide
 * [custom feature types](https://sakuzu.github.io/maplibre-gl-draw/guides/custom-types). The
 * parts used most are {@link createProgram}, {@link OFFSET_MODE_GLSL} and
 * {@link ProjectionUniformManager}.
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
export type { Coordinate } from '../shared/types/model.js';
export type { BlendCapableGL } from '../view/layer/blend.js';
export type { DashSegment } from '../view/renderers/line/dash.js';
export type { ProjectionUniformLocations } from '../view/shaders/projection.js';
export type {
  DrapeQuadCorners,
  QuadDrapeColor,
  QuadDrapeFill,
  QuadDrapeSurface,
} from '../view/terrain/drape/quad.js';
export type {
  MercatorRect,
  TessellationStep,
  TessellationTiling,
} from '../view/terrain/tessellation.js';
