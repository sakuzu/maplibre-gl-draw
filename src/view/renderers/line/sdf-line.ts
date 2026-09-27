// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * SDFLineRenderer
 *
 * High-quality line rendering using the HHAA (Half-plane Anti-Aliasing) approach
 *
 * Characteristics:
 * - The CPU only passes geographic coordinates
 * - The Mercator transform, projection, normal computation, and miter/bevel joins all run
 *   on the GPU
 * - A coordinate texture plus instancing draws multiple lines in one draw call
 * - Offsets are computed in screen space, so the line width is always uniform
 *
 * The renderer class binds the parts together: the types (line-types.ts), the vertex data
 * (line-geometry.ts), the GLSL sources (line-shader.ts), the uniforms (line-uniforms.ts), and
 * the GL resources (line-gl.ts).
 */

import type { Map as MapLibreMap, ProjectionData } from 'maplibre-gl';

import type { PixelRatioInput } from '../../../shared/utils/pixel-ratio.js';
import { resolveContentPixelRatio, resolvePixelRatio } from '../../../shared/utils/pixel-ratio.js';
import type { OffsetUniforms, ShaderData } from '../../shaders/helpers.js';
import { calculateOffsetUniforms, createProgram } from '../../shaders/helpers.js';
import { ProjectionUniformManager } from '../../shaders/projection.js';
import { TerrainContext } from '../../terrain/context.js';
import { NEUTRAL_DRAW_FACTORS, type RetainedDrawFactors } from '../draw-factors.js';
import type { PackedLineItems } from './line-geometry.js';
import {
  buildLineBatchArrays,
  buildPackedLineBatchArrays,
  defaultLineOrigin,
  growFloat32,
  INSTANCE_STRIDE,
  lineStationsOnMercatorPlane,
  maxInstanceSegmentMercator,
  normalizeOrigin,
  resolveLineStations,
  STATION_VERTICES,
  toLineInstanceColor,
  writeLineCoordTexels,
  writeLineInstances,
} from './line-geometry.js';
import {
  createRetainedLineBatch,
  deleteRetainedLineBatch,
  ImmediateCoordTexture,
  patchRetainedCoordTexels,
  releaseInstanceAttribs,
  setupInstanceAttribs,
  setupQuadAttribs,
} from './line-gl.js';
import { buildLineVertexSource, LINE_FRAGMENT_SOURCE } from './line-shader.js';
import type {
  LineBatchItem,
  LineBatchShape,
  RetainedLineBatch,
  RetainedLineBuildOptions,
  SDFStrokeOptions,
  SDFStrokeStyle,
} from './line-types.js';
import { LineUniforms } from './line-uniforms.js';

export type {
  Color,
  LineStyle,
  SDFStrokeOptions,
  SDFStrokeStyle,
  WidthUnit,
} from './line-types.js';

/**
 * SDFLineRenderer
 *
 * Line rendering with the HHAA approach
 */
export class SDFLineRenderer {
  private gl: WebGL2RenderingContext;
  private program: WebGLProgram | null = null;
  private variantName = '';

  // Buffers for instancing
  private quadVAO: WebGLVertexArrayObject | null = null;
  private quadVBO: WebGLBuffer | null = null;

  // GPU resources reused in immediate mode
  private immCoordTexture: ImmediateCoordTexture;
  /** MAX_TEXTURE_SIZE of the context (read once, 0 = not read yet) */
  private maxTextureSize = 0;
  /**
   * Scratch arrays of the immediate draw of one line (grown, never shrunk)
   *
   * A frame of the immediate path draws every line in view one by one, and allocating two
   * arrays per line puts the garbage collector under pressure on large data.
   */
  private scratchCoords: Float32Array<ArrayBuffer> = new Float32Array(0);
  private scratchInstances: Float32Array<ArrayBuffer> = new Float32Array(0);
  private immInstanceBuffer: WebGLBuffer | null = null;

  // State tracking within a frame
  // isDrawing: a flag for skipping the recomputation of the projection uniforms and the
  // viewport setup
  // Note: the program and the VAO may be changed by other renderers, so they are always rebound
  private isDrawing = false;
  private frameCount = 0;

  // The renderer-specific uniforms and the record of the values written last
  private uniforms: LineUniforms;

  // Projection uniform management (shared)
  private projectionUniformManager: ProjectionUniformManager;

  // Stores the offset uniforms
  private offsetUniforms: OffsetUniforms | null = null;

  /** The injected rendering ratio (read from window each time when not injected) */
  private pixelRatio: PixelRatioInput | undefined;
  /** The terrain state of the draw instance this renderer belongs to */
  private readonly terrain: TerrainContext;

  constructor(
    _map: MapLibreMap,
    gl: WebGL2RenderingContext,
    pixelRatio?: PixelRatioInput,
    terrain: TerrainContext = new TerrainContext(),
  ) {
    this.gl = gl;
    this.pixelRatio = pixelRatio;
    this.terrain = terrain;
    this.uniforms = new LineUniforms(gl);
    this.immCoordTexture = new ImmediateCoordTexture(gl);
    this.projectionUniformManager = new ProjectionUniformManager(gl, {
      surface: true,
    }).useTerrainState(terrain);
    this.initBuffers();
  }

  /**
   * Initializes the fixed quad vertex buffer
   */
  private initBuffers(): void {
    const gl = this.gl;

    this.quadVAO = gl.createVertexArray();
    gl.bindVertexArray(this.quadVAO);

    this.quadVBO = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadVBO);
    gl.bufferData(gl.ARRAY_BUFFER, STATION_VERTICES, gl.STATIC_DRAW);

    setupQuadAttribs(gl);

    gl.bindVertexArray(null);

    // The instance buffer for immediate mode (orphaned and reused on every draw)
    this.immInstanceBuffer = gl.createBuffer();
  }

  /**
   * Called at the start of a frame
   *
   * @internal
   */
  incrementFrame(): void {
    this.frameCount++;
  }

  /**
   * Begins drawing
   *
   * Sets the isDrawing flag to true and sets up the projection uniforms and the viewport.
   * This lets subsequent draw()/drawBatch() calls skip those settings.
   *
   * @param projectionData MapLibre's ProjectionData
   * @param zoom The current zoom level
   *
   * @internal
   */
  beginDraw(projectionData: ProjectionData, zoom: number): void {
    if (!this.program) return;

    const gl = this.gl;

    gl.useProgram(this.program);
    gl.bindVertexArray(this.quadVAO);

    this.setProjectionUniforms(projectionData, zoom);

    // Set the viewport size (the actual framebuffer size)
    this.uniforms.setViewport(gl.drawingBufferWidth, gl.drawingBufferHeight);

    this.isDrawing = true;
  }

  /**
   * Ends drawing
   *
   * Resets the isDrawing flag to false.
   * Calling it at the end of a frame makes the projection uniforms be set up again on the next
   * frame.
   *
   * @internal
   */
  endDraw(): void {
    if (!this.isDrawing) return;

    const gl = this.gl;

    releaseInstanceAttribs(gl);

    this.isDrawing = false;
  }

  /**
   * Gets the cache statistics
   *
   * @internal
   */
  getCacheStats(): { size: number; frameCount: number } {
    return {
      size: 0,
      frameCount: this.frameCount,
    };
  }

  /**
   * Ensures the shader
   */
  ensureShader(shaderData: ShaderData): void {
    if (this.variantName !== shaderData.variantName) {
      if (this.program) {
        this.gl.deleteProgram(this.program);
      }

      this.program = createProgram(
        this.gl,
        buildLineVertexSource(shaderData.vertexShaderPrelude, shaderData.define),
        LINE_FRAGMENT_SOURCE,
      );
      this.variantName = shaderData.variantName;

      // Get the renderer-specific uniform locations (this also discards the record of the
      // values written last, since a recreated program resets its uniforms)
      this.uniforms.bind(this.program);

      // Get the projection-related uniform locations (shared)
      this.projectionUniformManager.getLocations(this.program);
    }
  }

  /**
   * Sets the uniforms for offset mode
   */
  setOffsetUniforms(uniforms: OffsetUniforms): void {
    this.offsetUniforms = uniforms;
  }

  /**
   * Sets the projection uniforms (supporting offset mode and globe mode)
   * @param projectionData MapLibre's ProjectionData
   * @param zoom The current zoom level (used to switch offset mode)
   */
  private setProjectionUniforms(projectionData: ProjectionData, zoom: number): void {
    this.projectionUniformManager.setUniforms(projectionData, zoom, this.offsetUniforms);
  }

  /** The largest side of a coordinate texture this GPU allows (MAX_TEXTURE_SIZE, read once) */
  private textureSizeLimit(): number {
    if (this.maxTextureSize === 0) {
      const max = Number(this.gl.getParameter(this.gl.MAX_TEXTURE_SIZE));
      this.maxTextureSize = Number.isFinite(max) && max > 0 ? max : 4096;
    }
    return this.maxTextureSize;
  }

  /**
   * Executes the draw call (processing shared by draw/drawBatch)
   *
   * The coordinate texture and the instance buffer use the persistent immediate-mode
   * resources. Finish the upload into `immCoordTexture` and the `bufferData` into instanceBuffer
   * before calling it.
   */
  private executeDrawCall(
    instanceCount: number,
    texSize: number,
    shape: LineBatchShape,
    zoom: number,
    projectionData: ProjectionData,
    widthOverride: number,
    stations: number,
    factors: RetainedDrawFactors = NEUTRAL_DRAW_FACTORS,
  ): void {
    const gl = this.gl;

    // The program and the VAO may have been changed by other renderers, so always bind them
    gl.useProgram(this.program);
    gl.bindVertexArray(this.quadVAO);
    // The projection uniforms and the viewport are skipped when beginDraw() already set them
    // (a performance optimization)
    if (!this.isDrawing) {
      this.setProjectionUniforms(projectionData, zoom);
      this.uniforms.setViewport(gl.drawingBufferWidth, gl.drawingBufferHeight);
    }

    // Set up the instance attributes (stride = 48 bytes = 12 floats)
    // vertexAttribPointer records the current ARRAY_BUFFER binding, so it must always be
    // called with the instance buffer bound
    gl.bindBuffer(gl.ARRAY_BUFFER, this.immInstanceBuffer);
    setupInstanceAttribs(gl);

    // Uniforms (color and opacity moved to instance attributes, so they are not here)
    this.uniforms.setLineDraw(
      widthOverride,
      zoom,
      texSize,
      stations,
      lineStationsOnMercatorPlane(this.terrain),
    );
    // Always written (1 when the caller has none) so that no factor of an earlier draw is left
    this.uniforms.setDrawFactors(factors);

    // The coordinate texture (the sampler unit is written by LineUniforms.setLineDraw)
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.immCoordTexture.texture);

    // The dash pattern
    this.uniforms.setDash(shape, resolvePixelRatio(this.pixelRatio));

    // Draw
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 2 * (stations + 1), instanceCount);

    if (!this.isDrawing) {
      releaseInstanceAttribs(gl);
    }
  }

  /**
   * Draws a line
   */
  draw(
    coords: Array<[number, number]>,
    style: SDFStrokeStyle,
    options: SDFStrokeOptions,
    zoom: number,
    projectionData?: ProjectionData,
  ): void {
    if (!this.program || coords.length < 2 || !projectionData) return;

    const gl = this.gl;

    // Get the rendering ratio (to convert CSS pixels into physical pixels)
    //
    // When there is a createdZoom (= the GPU scales with zoom), use the ratio without
    // renderScale applied; for a fixed width drawn with u_width, use the ratio that includes
    // renderScale (the "two ratios" in shared/utils/pixel-ratio.ts).
    const screenDpr = resolvePixelRatio(this.pixelRatio);
    const contentDpr = resolveContentPixelRatio(this.pixelRatio);

    const n = coords.length;

    // The texture size
    const texSize = Math.max(2, Math.ceil(Math.sqrt(n)));

    // Compute the relative coordinates on the CPU side (offset mode: computed at 64-bit
    // precision)
    const centerLngLat: [number, number] = this.offsetUniforms?.centerLngLat ?? [0, 0];

    // The texture data (stores the relative coordinates). Only the first n texels are read,
    // so what the reused array holds past them does not matter
    this.scratchCoords = growFloat32(this.scratchCoords, texSize * texSize * 4);
    const texData = this.scratchCoords.subarray(0, texSize * texSize * 4);
    writeLineCoordTexels(texData, 0, coords, centerLngLat);

    // Upload into the coordinate texture (the persistent texture is reused)
    if (!this.immCoordTexture.upload(texData, texSize, this.textureSizeLimit())) return;

    // The instance data (12 floats per instance: indices(4) + extra(4) + color(4))
    const instanceCount = n - 1;
    this.scratchInstances = growFloat32(this.scratchInstances, instanceCount * INSTANCE_STRIDE);
    const instanceData = this.scratchInstances.subarray(0, instanceCount * INSTANCE_STRIDE);
    const instanceColor = toLineInstanceColor(style.color, style.opacity);

    // Compute on the GPU when createdZoom is specified, otherwise use u_width
    const useGpuScaling = options.createdZoom !== undefined;
    // Convert the line width into physical pixels (CSS pixels * devicePixelRatio)
    const strokeWidth = useGpuScaling ? style.width * contentDpr : 0;
    const createdZoom = options.createdZoom ?? 0;

    const maxSegmentMeters = writeLineInstances(instanceData, 0, 0, coords, {
      closed: options.closed,
      zoom,
      dashPixelRatio: screenDpr,
      // a_extra.y: the original line width (px); u_width is used when it is 0
      strokeWidth,
      createdZoom,
      color: instanceColor,
    });
    // Only the globe reads the length on the Mercator plane
    const maxSegmentMercator = lineStationsOnMercatorPlane(this.terrain)
      ? maxInstanceSegmentMercator(instanceData, instanceCount, zoom, screenDpr)
      : 0;

    // Upload into the instance buffer (orphaned and reused)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.immInstanceBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, instanceData, gl.STREAM_DRAW);

    // widthOverride: the GPU computation (0) when createdZoom is specified, otherwise u_width
    // Convert the line width into physical pixels (CSS pixels * devicePixelRatio)
    const widthOverride = useGpuScaling ? 0 : style.width * screenDpr;

    this.executeDrawCall(
      instanceCount,
      texSize,
      { lineStyle: style.lineStyle, dashArray: style.dashArray },
      zoom,
      projectionData,
      widthOverride,
      resolveLineStations(this.terrain, maxSegmentMeters, instanceCount, maxSegmentMercator),
    );
  }

  /**
   * Draws a closed path
   */
  drawClosed(
    coords: Array<[number, number]>,
    style: SDFStrokeStyle,
    options: Omit<SDFStrokeOptions, 'closed'>,
    zoom: number,
    projectionData?: ProjectionData,
  ): void {
    if (coords.length < 3) return;

    // Remove the duplicate when the first and last points are the same
    let closedCoords = coords;
    const first = coords[0];
    const last = coords[coords.length - 1];
    if (first[0] === last[0] && first[1] === last[1]) {
      closedCoords = coords.slice(0, -1);
    }

    // Draw it as a closed path
    const loopCoords = [...closedCoords, closedCoords[0]];
    this.draw(loopCoords, style, { ...options, closed: true }, zoom, projectionData);
  }

  /**
   * Batch-draws multiple lines (per-instance colors)
   *
   * Color and opacity are passed as instance attributes, so even when the color differs from
   * one line to the next, they can be drawn in one draw call as long as the shape parameters
   * (the dash kind) are the same.
   *
   * @param items The line data (carrying the color, opacity, and width per line)
   * @param shape The per-batch shape parameters, such as the dash kind
   * @param factors The factors used at draw time (the opacity of the layer being drawn; 1x
   *   scale and opacity 1 when omitted)
   *
   * @internal
   */
  drawAll(
    items: LineBatchItem[],
    shape: LineBatchShape,
    zoom: number,
    projectionData: ProjectionData,
    factors: RetainedDrawFactors = NEUTRAL_DRAW_FACTORS,
  ): void {
    if (!this.program || items.length === 0) return;

    const gl = this.gl;

    // Compute the relative coordinates on the CPU side (offset mode: computed at 64-bit
    // precision)
    const centerLngLat: [number, number] = this.offsetUniforms?.centerLngLat ?? [0, 0];

    const arrays = buildLineBatchArrays(items, zoom, centerLngLat, this.pixelRatio);
    if (!arrays) return;

    // Upload into the coordinate texture (the persistent texture is reused)
    if (!this.immCoordTexture.upload(arrays.texData, arrays.texSize, this.textureSizeLimit())) {
      return;
    }

    // Upload into the instance buffer (orphaned and reused)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.immInstanceBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, arrays.instanceData, gl.STREAM_DRAW);

    this.executeDrawCall(
      arrays.instanceCount,
      arrays.texSize,
      shape,
      zoom,
      projectionData,
      0,
      resolveLineStations(
        this.terrain,
        arrays.maxSegmentMeters,
        arrays.instanceCount,
        arrays.maxSegmentMercator,
      ),
      factors,
    );
  }

  /**
   * Builds a retained-mode line batch
   *
   * It creates the coordinate texture, the instance buffer, and the VAO so that on later
   * frames `drawRetainedBatch` can draw with nothing but a bind, the uniforms, and the draw
   * call. The vertex data does not depend on the camera (the projection is done by the
   * uniforms on every frame).
   *
   * @param items The line data (carrying the color, opacity, and width per line)
   * @param shape The per-batch shape parameters, such as the dash kind
   * @param options The origin of the relative coordinates and the zoom for the line-width
   *   computation
   * @returns The built batch, or null when the shader is not initialized or there are not
   *   enough coordinates
   *
   * @internal
   */
  buildRetainedBatch(
    items: LineBatchItem[],
    shape: LineBatchShape,
    options: RetainedLineBuildOptions = {},
  ): RetainedLineBatch | null {
    if (!this.program || items.length === 0) return null;

    // The origin of the relative coordinates is fixed per batch (it must not depend on the
    // camera center)
    const origin = normalizeOrigin(options.origin ?? defaultLineOrigin(items));

    const arrays = buildLineBatchArrays(items, options.distanceZoom ?? 0, origin, this.pixelRatio);
    if (!arrays) return null;

    return createRetainedLineBatch(
      this.gl,
      arrays,
      shape,
      origin,
      options.widthZoom ?? null,
      this.textureSizeLimit(),
    );
  }

  /**
   * Builds a retained-mode line batch from packed lines
   *
   * The same batch as `buildRetainedBatch` builds for the same lines, without an array per line.
   *
   * @returns The built batch, or null when the shader is not initialized or there are not
   *   enough coordinates
   *
   * @internal
   */
  buildRetainedPackedBatch(
    lines: PackedLineItems,
    shape: LineBatchShape,
    options: RetainedLineBuildOptions = {},
  ): RetainedLineBatch | null {
    if (!this.program || lines.count === 0) return null;

    const first = lines.start[0] * lines.stride;
    const origin = normalizeOrigin(
      options.origin ?? [lines.coords[first] ?? 0, lines.coords[first + 1] ?? 0],
    );

    const arrays = buildPackedLineBatchArrays(
      lines,
      options.distanceZoom ?? 0,
      origin,
      this.pixelRatio,
    );
    if (!arrays) return null;

    return createRetainedLineBatch(
      this.gl,
      arrays,
      shape,
      origin,
      options.widthZoom ?? null,
      this.textureSizeLimit(),
    );
  }

  /**
   * Draws a retained-mode line batch
   *
   * It neither creates textures nor calls bufferData. The projection uniforms are recomputed
   * every frame from the origin coordinate of the batch (the vertex data is not rebuilt).
   *
   * @param factors The factors used at draw time (when omitted, 1x scale and opacity 1, the
   *   same as before)
   *
   * @internal
   */
  drawRetainedBatch(
    batch: RetainedLineBatch,
    zoom: number,
    projectionData: ProjectionData,
    factors: RetainedDrawFactors = NEUTRAL_DRAW_FACTORS,
  ): void {
    if (!this.program || batch.instanceCount === 0) return;

    const gl = this.gl;

    gl.useProgram(this.program);
    gl.bindVertexArray(batch.vao);

    // The center of linearization is aligned with the camera center (linearizing around the
    // origin coordinate of the batch turns the residual of the Mercator approximation into a
    // displacement of pixel magnitude at vertices far from the center).
    // The vertices are relative to the origin coordinate, so that difference is passed via
    // u_origin_shift
    const cameraUniforms = this.offsetUniforms;
    if (cameraUniforms) {
      this.projectionUniformManager.setUniforms(projectionData, zoom, cameraUniforms, [
        batch.origin[0] - cameraUniforms.centerLngLat[0],
        batch.origin[1] - cameraUniforms.centerLngLat[1],
      ]);
    } else {
      // Fallback (normally custom-layer has already called setOffsetUniforms each frame)
      this.projectionUniformManager.setUniforms(
        projectionData,
        zoom,
        calculateOffsetUniforms(batch.origin, projectionData.mainMatrix as unknown as Float32Array),
      );
    }

    this.uniforms.setViewport(gl.drawingBufferWidth, gl.drawingBufferHeight);
    const stations = resolveLineStations(
      this.terrain,
      batch.maxSegmentMeters,
      batch.instanceCount,
      batch.maxSegmentMercator,
    );
    this.uniforms.setLineDraw(
      0,
      batch.widthZoom ?? zoom,
      batch.texSize,
      stations,
      lineStationsOnMercatorPlane(this.terrain),
    );
    this.uniforms.setDrawFactors(factors);

    // The coordinate texture (the sampler unit is written by LineUniforms.setLineDraw)
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, batch.texture);

    this.uniforms.setDash(batch.shape, resolvePixelRatio(this.pixelRatio));

    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 2 * (stations + 1), batch.instanceCount);

    gl.bindVertexArray(null);

    // When this interrupted an immediate-mode frame, restore the shared VAO and the projection
    // uniforms (because the subsequent drawAll assumes the state set up by beginDraw)
    if (this.isDrawing) {
      gl.bindVertexArray(this.quadVAO);
      this.setProjectionUniforms(projectionData, zoom);
      // Leave no residual factors either (executeDrawCall rewrites them too, but the restoring
      // side closes the loop)
      this.uniforms.setDrawFactors(NEUTRAL_DRAW_FACTORS);
    }
  }

  /**
   * Partially updates the coordinate texture of a retained batch (applying the diff from a
   * vertex drag)
   *
   * Rebuilding the batch every time a single vertex moves overflows the frame for lines with
   * many vertices. The coordinates live in the texture, so rewriting only the texel of the
   * vertex that moved is enough.
   *
   * The instance array is not touched. The indices (a_indices) are invariant as topology as
   * long as the number of coordinates does not change, and the miter computation follows
   * automatically because the shader reads them back with texelFetch. a_extra.x (the
   * cumulative distance) and a_extra.w (the segment length) are left stale, but those are
   * dash-only values, and a retained-mode line batch is always solid (dashed lines go through
   * immediate mode). Both the line width and the caps are computed from lengths recomputed in
   * screen space, so there is no visual impact. Those values return to correct ones on the
   * next full rebuild (a style change, a change in the number of vertices, and so on).
   *
   * There is also no need to rebuild after the drag is committed. The last patch applied is
   * the committed value as it stands.
   *
   * @param updates The running index within the coordinate texture and the new longitude and
   *   latitude of that vertex
   *
   * @internal
   */
  patchRetainedBatchCoords(
    batch: RetainedLineBatch,
    updates: ReadonlyArray<{ coordIndex: number; lngLat: [number, number] }>,
  ): void {
    patchRetainedCoordTexels(this.gl, batch, updates);
  }

  /**
   * Disposes of a retained-mode line batch
   *
   * @internal
   */
  disposeRetainedBatch(batch: RetainedLineBatch): void {
    deleteRetainedLineBatch(this.gl, batch);
  }

  /**
   * Disposes of the resources
   *
   * @internal
   */
  dispose(): void {
    const gl = this.gl;
    if (this.program) {
      gl.deleteProgram(this.program);
      this.program = null;
    }
    if (this.quadVAO) {
      gl.deleteVertexArray(this.quadVAO);
      this.quadVAO = null;
    }
    if (this.quadVBO) {
      gl.deleteBuffer(this.quadVBO);
      this.quadVBO = null;
    }
    this.immCoordTexture.dispose();
    if (this.immInstanceBuffer) {
      gl.deleteBuffer(this.immInstanceBuffer);
      this.immInstanceBuffer = null;
    }
  }
}
