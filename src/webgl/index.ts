// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Write your own shaders that draw the way the library does.
 *
 * Use it only when a custom feature type or an overlay needs a shader of its own. The
 * {@link maplibre-gl-draw!RenderContext | RenderContext} a renderer receives already carries
 * the shared renderers of lines, areas and point markers, and most renderers need nothing
 * more. This entry holds the values of the GPU of the view a render context draws
 * ({@link viewUniforms}, {@link offsetUniformsAt}), the GLSL of the projection, the uniforms
 * that go with it, the quad shader, and the rules the shared renderers follow for dashes and
 * terrain. Marks drawn without depth fade where the terrain hides them
 * ({@link TERRAIN_OCCLUSION_GLSL}), and what is drawn with the rows being dragged moves as they do
 * ({@link ROW_STATE_GLSL}), as the library draws its points. The parts that draw on the terrain
 * take the render context of the draw call (or its `terrain`). Unlike the main entry, it may
 * change in a minor release.
 *
 * ```ts
 * import {
 *   OFFSET_MODE_GLSL, ProjectionUniformManager, viewUniforms,
 * } from '@sakuzu/maplibre-gl-draw/webgl';
 *
 * draw.extensions.plugins.add({
 *   name: 'my-shader',
 *   onAdd(ctx) {
 *     ctx.webgl.addOverlay({
 *       gpuShare: 0.01,
 *       prepare(gpu) {
 *         const { gl } = gpu;
 *         let program: WebGLProgram | null = null;
 *         const uniforms = new ProjectionUniformManager(gl);
 *         return (context) => {
 *           const view = viewUniforms(context);
 *           if (!program) {
 *             const vertex = vertexSource(view.shader.vertexShaderPrelude, OFFSET_MODE_GLSL);
 *             program = gpu.program(vertex, fragmentSource);
 *             uniforms.getLocations(program);
 *           }
 *           gl.useProgram(program);
 *           uniforms.setTerrain(context);
 *           uniforms.setUniforms(view.projection, view.offset);
 *           // bind the buffers of your shape and draw it
 *         };
 *       },
 *     });
 *   },
 * });
 * ```
 *
 * What `gpu` makes is recorded under the name of the plugin, refused past the limit of the
 * instance, and given back with the plugin: nothing here has a counterpart to release it.
 *
 * Read next: the guide
 * [custom feature types](https://sakuzu.github.io/maplibre-gl-draw/guides/custom-types). The
 * parts used most are {@link Gpu}, {@link viewUniforms}, {@link OFFSET_MODE_GLSL} and
 * {@link ProjectionUniformManager}.
 *
 * @module webgl
 */

// biome-ignore-all assist/source/organizeImports: the exports are grouped by section

// What a plugin draws with, and what it holds on the GPU
export type {
  FeatureRenderer,
  Gpu,
  GpuContext,
  GpuDefinition,
  GpuRowBuffer,
  GpuRowBufferFactory,
  OverlayContext,
  ProgramCompile,
  Webgl,
} from '../api/extension/webgl.js';

// The rows of a layer or a dataset read without making features
export type { LayerTableView, RowRef } from '../api/extension/webgl.js';

// Shaders and projection
export { DEFAULT_TILE_SIZE } from '../shared/math/constants.js';
export type { OffsetUniforms, ShaderData } from '../view/shaders/helpers.js';
export { calculateLngLatOffset, OFFSET_MODE_GLSL } from '../view/shaders/helpers.js';
export { ProjectionUniformManager } from '../view/shaders/projection.js';
export type { ViewUniforms } from '../view/shaders/view-uniforms.js';
export { offsetUniformsAt, viewUniforms } from '../view/shaders/view-uniforms.js';

// The origin of what is kept on the GPU
export {
  rebasedRetainedOrigin,
  RETAINED_ORIGIN_TOLERANCE_PX,
  retainedOriginErrorPx,
} from '../view/shaders/retained-origin.js';

// Blending and billboards
export { applyDrawBlendState } from '../view/layer/blend.js';
export { drawBillboardsWithoutDepth } from '../view/renderers/point/billboard-depth.js';

// Quads
export type { QuadDrapeContent } from '../view/terrain/drape/quad.js';
export type { QuadVertices } from '../view/shaders/quad.js';
export {
  computeQuadVertices,
  drawQuadOnTerrain,
  QuadImageContent,
  QuadShader,
} from '../view/shaders/quad.js';
export { QUAD_DRAPE_TEXTURE_UNITS } from '../view/terrain/drape/quad.js';

// Lines
export type { SDFStrokeOptions, SDFStrokeStyle } from '../view/renderers/line/sdf-line.js';
export type { WidthUnit } from '../view/renderers/stroke.js';
export {
  getStrokeDashPattern as dashPattern,
  splitIntoDashes,
} from '../view/renderers/line/dash.js';

// Terrain
export { TERRAIN_OCCLUSION_GLSL, TerrainOcclusionUniforms } from '../view/terrain/occlusion.js';
export { terrainTessellationStep } from '../view/terrain/polygon.js';
export { densifyPath } from '../view/terrain/tessellation.js';

// Rows being dragged
export type { DraggedRows } from '../feature-table/dragged-rows.js';
export type { RowStateBinding, RowStateTexture } from '../view/renderers/row-state.js';
export {
  createRowStateTexture,
  ROW_STATE_GLSL,
  ROW_STATE_TEXTURE_UNIT,
  RowStateUniforms,
  rowStateBindingOf,
  rowStateMovedViews,
  rowStateOf,
  uploadRowState,
} from '../view/renderers/row-state.js';

// Hit testing
export { PointHitTestStrategy } from '../dispatcher/hit-test/strategies/point.js';

// Supporting types
// The box of the library (`[minLng, minLat, maxLng, maxLat]` in degrees here), by its name of
// this entry
export type { BBox as BoundingBox } from '../geometry/types.js';
export type { Coordinate } from '../shared/types/model.js';
export type { BlendCapableGL } from '../view/layer/blend.js';
export type { DashSegment } from '../view/renderers/line/dash.js';
export type { ProjectionUniformLocations } from '../view/shaders/projection.js';
export type { DrapeQuadCorners } from '../view/terrain/drape/quad.js';
export type {
  MercatorRect,
  TessellationStep,
  TessellationTiling,
} from '../view/terrain/tessellation.js';
