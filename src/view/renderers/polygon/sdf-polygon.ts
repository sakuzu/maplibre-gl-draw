// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * SDFPolygonRenderer
 *
 * A renderer that draws the fill and stroke of a polygon in a single draw call.
 * - fill: filled with a triangulation (earcut)
 * - stroke: high quality line rendering with the HHAA (Half-plane Anti-Aliasing) method
 *
 * Batching is possible while preserving the z-order.
 */

import earcut from 'earcut';
import type { ProjectionData } from 'maplibre-gl';
import { RENDERING_DEFAULTS } from '../../../shared/math/index.js';
import type { PixelRatioInput } from '../../../shared/utils/pixel-ratio.js';
import { resolveContentPixelRatio, resolvePixelRatio } from '../../../shared/utils/pixel-ratio.js';
import type { Coordinate } from '../../../store/types.js';
import { EarcutCache } from '../../cache/earcut.js';
import { getSurfaceTessellationStep, tessellateSurfaceFill } from '../../globe-subdivision.js';
import { getRenderFrame } from '../../shaders/frame.js';
import type { OffsetUniforms, ShaderData } from '../../shaders/helpers.js';
import {
  calculateLngLatOffset,
  calculateOffsetUniforms,
  createProgram,
  getProjectionTransitionUniform,
  OFFSET_MODE_GLSL,
} from '../../shaders/helpers.js';
import { ProjectionUniformManager } from '../../shaders/projection.js';
import {
  TERRAIN_SHADE_FRAGMENT_GLSL,
  TERRAIN_SHADE_VERTEX_GLSL,
} from '../../shaders/terrain-shade.js';
import { TerrainContext } from '../../terrain/context.js';
import { TERRAIN_MAX_TILED_COARSEN } from '../../terrain/metrics.js';
import {
  batchTessellationFactor,
  polygonTessellationStep,
  ringBoundingCells,
  tessellateRings,
} from '../../terrain/polygon.js';
import { reportTerrainCoarsening } from '../../terrain/state.js';
import type { TessellationStep } from '../../terrain/tessellation.js';
import { NEUTRAL_DRAW_FACTORS, type RetainedDrawFactors } from '../draw-factors.js';
import type { PolygonRendererScope } from './batch.js';
import { buildEarcutInput } from './earcut-input.js';
import { drawFillWithTerrainCull } from './terrain-cull.js';
import type { PolygonTriangulator } from './triangulator.js';

/** The color type */
export type Color = [number, number, number, number];

/** The polygon style */
export interface SDFPolygonStyle {
  fillColor: Color;
  fillOpacity: number;
  strokeColor: Color;
  /**
   * The pixel width of the outline (relative to createdZoom)
   *
   * Positive value: scales with the zoom as `strokeWidth * 2^(zoom - createdZoom)`.
   * Negative value: a fixed width of `-strokeWidth` pixels (createdZoom and the zoom at
   *   draw time are ignored). This is a convention for drawing features that have no
   *   createdZoom mixed into the same batch as features with a variable width (which
   *   preserves the z-order).
   * 0: the outline is not drawn.
   */
  strokeWidth: number;
  strokeOpacity: number;
}

/**
 * Polygon data for a batch
 *
 * @internal
 */
export interface SDFPolygonBatchData {
  coordinates: Coordinate[][]; // array of rings ([0] is the outer ring, [1..] are inner rings)
  style: SDFPolygonStyle;
  createdZoom: number;
  featureId?: string;
  /** The part number used for caching (a part of a MultiPolygon; omitted = 0 for a
   * single polygon) */
  partIndex?: number;
}

/** Floats per vertex: pos(2) + color(4) + type(1) + prev(2) + next(2) + side(1) + extra(3) */
const VERTEX_STRIDE = 15;

/** The vertex array and index array of a batch */
interface PolygonGeometry {
  vertexData: Float32Array;
  indexData: Uint32Array;
}

/**
 * Per-polygon intermediate data accumulated in the dataset pass
 */
interface PolygonRecord {
  /** The flattened coordinates of the fill (null when it is not filled) */
  fillCoords: number[] | null;
  /** The triangulation indices of the fill (null when it is not filled) */
  fillIndices: number[] | null;
  /** The rings on which the outline is drawn (null when it is not drawn) */
  strokeRings: Array<Array<[number, number]>> | null;
  style: SDFPolygonStyle;
  createdZoom: number;
}

/**
 * A retained-mode polygon batch (GPU resources)
 *
 * It shares no resources with the shared vertex buffer and shared VAO of immediate mode.
 */
export interface RetainedPolygonBatch {
  /** The VAO with the attributes already set up (dedicated to this batch) */
  readonly vao: WebGLVertexArrayObject;
  /** The vertex buffer (dedicated to this batch) */
  readonly vertexBuffer: WebGLBuffer;
  /** The index buffer (dedicated to this batch) */
  readonly indexBuffer: WebGLBuffer;
  /** The number of indices */
  readonly indexCount: number;
  /** The origin of the relative coordinates (already rounded to Float32) */
  readonly origin: [number, number];
  /**
   * The fixed zoom used to compute the line width of the outline
   *
   * When it is null, the zoom at draw time is passed to u_zoom.
   */
  readonly widthZoom: number | null;
}

/**
 * The options for building a retained-mode polygon batch
 */
export interface RetainedPolygonBuildOptions {
  /** The origin of the relative coordinates (the first coordinate of the first polygon
   * when omitted) */
  origin?: [number, number];
  /** The fixed zoom used to compute the line width of the outline (the zoom at draw time
   * when omitted) */
  widthZoom?: number;
  /**
   * The supplier of triangulations (earcut is called on the spot when omitted)
   *
   * A polygon whose triangulation is not ready is built with the fill omitted (the
   * outline is still drawn).
   */
  triangulator?: PolygonTriangulator;
}

/**
 * Rounds the origin of the relative coordinates to Float32
 */
function normalizeOrigin(origin: [number, number]): [number, number] {
  return [Math.fround(origin[0]), Math.fround(origin[1])];
}

/**
 * The default origin of a polygon batch (the first coordinate of the outer ring of the
 * first polygon)
 */
function defaultPolygonOrigin(polygons: SDFPolygonBatchData[]): [number, number] {
  const first = polygons[0]?.coordinates[0]?.[0];
  return first ? [first[0], first[1]] : [0, 0];
}

/**
 * SDFPolygonRenderer
 *
 * @internal
 */
export class SDFPolygonRenderer {
  private gl: WebGL2RenderingContext;
  private program: WebGLProgram | null = null;
  private variantName = '';

  // Projection uniform management
  private projectionUniformManager: ProjectionUniformManager;

  // Uniform locations (renderer specific)
  private viewportLoc: WebGLUniformLocation | null = null;
  private zoomLoc: WebGLUniformLocation | null = null;
  private miterLimitLoc: WebGLUniformLocation | null = null;
  private sizeScaleLoc: WebGLUniformLocation | null = null;
  private opacityLoc: WebGLUniformLocation | null = null;

  // A record of the renderer specific uniforms written last (for memoization within a frame)
  //
  // Retained mode passes through here once per chunk, but neither the viewport nor the
  // miter limit changes within a frame. Writes of the same value are skipped, and they
  // are rewritten once the frame changes (see shaders/frame.ts).
  private memoFrame = -1;
  private memoViewportWidth = Number.NaN;
  private memoViewportHeight = Number.NaN;
  private memoZoom = Number.NaN;
  private memoMiterLimit = Number.NaN;
  private memoFactorsFrame = -1;
  private memoSizeScale = Number.NaN;
  private memoOpacity = Number.NaN;

  // Stores the offset uniforms
  private offsetUniforms: OffsetUniforms | null = null;

  // Buffers
  private vertexBuffer: WebGLBuffer | null = null;
  private indexBuffer: WebGLBuffer | null = null;
  private vao: WebGLVertexArrayObject | null = null;

  /** The injected pixel ratio (when not injected it is read from window each time) */
  private pixelRatio: PixelRatioInput | undefined;
  /** The terrain state of the draw instance */
  private readonly terrain: TerrainContext;
  /** Triangulation results of the draw instance, keyed by feature id */
  private readonly earcutCache: EarcutCache;

  constructor(
    gl: WebGL2RenderingContext,
    pixelRatio?: PixelRatioInput,
    scope: PolygonRendererScope = {},
  ) {
    this.gl = gl;
    this.pixelRatio = pixelRatio;
    this.terrain = scope.terrain ?? new TerrainContext();
    this.earcutCache = scope.earcut ?? new EarcutCache();
    this.projectionUniformManager = new ProjectionUniformManager(gl, {
      surface: true,
      terrain: this.terrain,
    });
    this.vertexBuffer = gl.createBuffer();
    this.indexBuffer = gl.createBuffer();
    this.vao = gl.createVertexArray();
  }

  /**
   * Ensures the shader (recreating it when necessary)
   */
  ensureShader(shaderData: ShaderData): void {
    if (this.variantName !== shaderData.variantName) {
      if (this.program) {
        this.gl.deleteProgram(this.program);
      }

      this.program = this.createShaderProgram(shaderData.vertexShaderPrelude, shaderData.define);
      this.variantName = shaderData.variantName;

      // Get the projection uniform locations
      this.projectionUniformManager.getLocations(this.program);

      // Get the renderer specific uniform locations
      this.viewportLoc = this.gl.getUniformLocation(this.program, 'u_viewport');
      this.zoomLoc = this.gl.getUniformLocation(this.program, 'u_zoom');
      this.miterLimitLoc = this.gl.getUniformLocation(this.program, 'u_miterLimit');
      this.sizeScaleLoc = this.gl.getUniformLocation(this.program, 'u_size_scale');
      this.opacityLoc = this.gl.getUniformLocation(this.program, 'u_opacity');

      // A recreated program also resets its uniforms to their initial values, so the
      // record is discarded
      this.resetUniformMemo();

      // Set up the VAO
      this.setupVAO();
    }
  }

  /**
   * Sets the uniforms for offset mode
   */
  setOffsetUniforms(uniforms: OffsetUniforms): void {
    this.offsetUniforms = uniforms;
  }

  /**
   * Discards the record of the values written last
   */
  private resetUniformMemo(): void {
    this.memoFrame = -1;
    this.memoViewportWidth = Number.NaN;
    this.memoViewportHeight = Number.NaN;
    this.memoZoom = Number.NaN;
    this.memoMiterLimit = Number.NaN;
    this.memoFactorsFrame = -1;
    this.memoSizeScale = Number.NaN;
    this.memoOpacity = Number.NaN;
  }

  /**
   * Writes the viewport, zoom and miter limit (shared by immediate mode and retained mode)
   *
   * If the value is the same it is not rewritten. Once the frame changes the whole set is
   * rewritten.
   */
  private setShapeUniforms(viewport: [number, number], zoomValue: number): void {
    const gl = this.gl;
    const frame = getRenderFrame();
    const staleFrame = this.memoFrame !== frame;

    if (
      this.viewportLoc &&
      (staleFrame ||
        this.memoViewportWidth !== viewport[0] ||
        this.memoViewportHeight !== viewport[1])
    ) {
      gl.uniform2f(this.viewportLoc, viewport[0], viewport[1]);
      this.memoViewportWidth = viewport[0];
      this.memoViewportHeight = viewport[1];
    }
    if (this.zoomLoc && (staleFrame || this.memoZoom !== zoomValue)) {
      gl.uniform1f(this.zoomLoc, zoomValue);
      this.memoZoom = zoomValue;
    }
    if (
      this.miterLimitLoc &&
      (staleFrame || this.memoMiterLimit !== RENDERING_DEFAULTS.MITER_LIMIT)
    ) {
      gl.uniform1f(this.miterLimitLoc, RENDERING_DEFAULTS.MITER_LIMIT);
      this.memoMiterLimit = RENDERING_DEFAULTS.MITER_LIMIT;
    }

    this.memoFrame = frame;
  }

  /**
   * Creates the shader program
   */
  private createShaderProgram(prelude: string, define: string): WebGLProgram {
    const projTransitionUniform = getProjectionTransitionUniform(prelude);
    // Vertex shader
    // a_type: 0=fill, 1=stroke
    // fill: uses only a_pos and a_color
    // stroke: uses a_pos, a_color, a_prev, a_next, a_side and a_extra
    const vertexSource = `#version 300 es
${prelude}
${define}
${projTransitionUniform}${OFFSET_MODE_GLSL}${TERRAIN_SHADE_VERTEX_GLSL}

layout(location = 0) in vec2 a_pos;       // current position (relative, 64-bit on CPU)
layout(location = 1) in vec4 a_color;     // color (RGBA)
layout(location = 2) in float a_type;     // 0=fill, 1=stroke
layout(location = 3) in vec2 a_prev;      // previous vertex (relative coords, for stroke)
layout(location = 4) in vec2 a_next;      // next vertex (relative coords, for stroke)
layout(location = 5) in float a_side;     // left or right (for stroke: 1=left, -1=right)
layout(location = 6) in vec3 a_extra;     // x=t(0-1), y=strokeWidth, z=createdZoom

uniform vec2 u_viewport;
uniform float u_zoom;
uniform float u_miterLimit;
uniform float u_size_scale;   // the size factor at draw time (default 1)

out vec4 v_color;
out float v_type;
out float v_dist;         // the SDF distance (for stroke)
out float v_halfWidth;    // the half width of the line (for stroke)

void main() {
    // The shading sample position is passed in both the fill and the outline branch (so
    // that no undefined varying is left; only the fill fragment actually reads it)
    emitShadeOffset(a_pos);

    if (a_type < 0.5) {
        // Fill: high precision version (uses relative coords computed at 64-bit precision on CPU)
        gl_Position = project_position_to_clipspace_from_offset(a_pos, u_projection_matrix);
        v_color = a_color;
        v_type = 0.0;
        v_dist = 0.0;
        v_halfWidth = 0.0;
    } else {
        // Stroke: line rendering with the HHAA method (high precision version)
        // Compute the clip coordinates (uses the relative coords already computed on the CPU side)
        vec4 clipPos = project_position_to_clipspace_from_offset(a_pos, u_projection_matrix);
        vec4 clipPrev = project_position_to_clipspace_from_offset(a_prev, u_projection_matrix);
        vec4 clipNext = project_position_to_clipspace_from_offset(a_next, u_projection_matrix);

        // NDC coordinates
        vec2 ndcPos = clipPos.xy / clipPos.w;
        vec2 ndcPrev = clipPrev.xy / clipPrev.w;
        vec2 ndcNext = clipNext.xy / clipNext.w;

        // Screen coordinates
        vec2 screenPos = (ndcPos * 0.5 + 0.5) * u_viewport;
        vec2 screenPrev = (ndcPrev * 0.5 + 0.5) * u_viewport;
        vec2 screenNext = (ndcNext * 0.5 + 0.5) * u_viewport;

        // Direction vectors
        vec2 dirPrev = normalize(screenPos - screenPrev);
        vec2 dirNext = normalize(screenNext - screenPos);

        // Normals (the left side is positive)
        vec2 normalPrev = vec2(-dirPrev.y, dirPrev.x);
        vec2 normalNext = vec2(-dirNext.y, dirNext.x);

        // Miter normal
        vec2 miterNormal = normalize(normalPrev + normalNext);

        // Miter scale
        float cosHalfAngle = dot(miterNormal, normalPrev);
        float miterScale = 1.0 / max(cosHalfAngle, 0.1);
        miterScale = min(miterScale, u_miterLimit);

        // Line width computation that takes createdZoom into account
        // strokeWidth < 0 means "a fixed width of -strokeWidth pixels (zoom independent)".
        // It is a convention for drawing features that have no createdZoom mixed into the
        // same batch (= the same u_zoom) as features with a variable width.
        float strokeWidth = a_extra.y;
        float createdZoom = a_extra.z;
        // u_size_scale is the size factor at draw time (default 1). It is multiplied
        // outside the branch so that it takes effect whichever branch the data goes through.
        float lineWidth = (strokeWidth >= 0.0
            ? strokeWidth * pow(2.0, u_zoom - createdZoom)
            : -strokeWidth) * u_size_scale;
        float halfWidth = lineWidth / 2.0;

        // Expand by 1 pixel for HHAA
        float expandedHalfWidth = halfWidth + 1.0;

        // Screen space offset
        vec2 screenOffset = miterNormal * a_side * expandedHalfWidth * miterScale;
        vec2 finalScreenPos = screenPos + screenOffset;

        // Back to NDC
        vec2 finalNdc = (finalScreenPos / u_viewport) * 2.0 - 1.0;
        gl_Position = vec4(finalNdc * clipPos.w, clipPos.z, clipPos.w);

        v_color = a_color;
        v_type = 1.0;
        v_dist = a_side * expandedHalfWidth;
        v_halfWidth = halfWidth;
    }
}`;

    // Fragment shader
    const fragmentSource = `#version 300 es
precision highp float;

in vec4 v_color;
in float v_type;
in float v_dist;
in float v_halfWidth;

uniform float u_opacity;      // the opacity factor at draw time (default 1)

out vec4 fragColor;
${TERRAIN_SHADE_FRAGMENT_GLSL}
void main() {
    // Blending is non-premultiplied, so the factor is applied to the alpha only
    if (v_type < 0.5) {
        // Fill: output with the same terrain shading as the ground applied to the brightness
        // (1.0 when there is no terrain). It is not applied to the outline (lines, points,
        // labels and handles are by convention unshaded)
        fragColor = vec4(v_color.rgb * terrainFillShade(), v_color.a * u_opacity);
    } else {
        // Stroke: anti-aliasing with the HHAA method
        float d = abs(v_dist) - v_halfWidth;
        float alpha = 1.0 - smoothstep(-1.0, 1.0, d);

        if (alpha < 0.01) discard;

        fragColor = vec4(v_color.rgb, v_color.a * alpha * u_opacity);
    }
}`;

    return createProgram(this.gl, vertexSource, fragmentSource);
  }

  /**
   * Sets up the VAO
   */
  private setupVAO(): void {
    const gl = this.gl;

    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);

    this.setupVertexAttribs();

    // The ELEMENT_ARRAY_BUFFER binding is part of the VAO state
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);

    gl.bindVertexArray(null);
  }

  /**
   * Sets up the vertex attributes (called while the vertex buffer is bound to ARRAY_BUFFER)
   *
   * The same layout is used by immediate mode and retained mode.
   */
  private setupVertexAttribs(): void {
    const gl = this.gl;

    // stride: pos(2) + color(4) + type(1) + prev(2) + next(2) + side(1) + extra(3) = 15 floats = 60 bytes
    const stride = 60;

    // a_pos: location 0
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, stride, 0);

    // a_color: location 1
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, stride, 8);

    // a_type: location 2
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 1, gl.FLOAT, false, stride, 24);

    // a_prev: location 3
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 2, gl.FLOAT, false, stride, 28);

    // a_next: location 4
    gl.enableVertexAttribArray(4);
    gl.vertexAttribPointer(4, 2, gl.FLOAT, false, stride, 36);

    // a_side: location 5
    gl.enableVertexAttribArray(5);
    gl.vertexAttribPointer(5, 1, gl.FLOAT, false, stride, 44);

    // a_extra: location 6
    gl.enableVertexAttribArray(6);
    gl.vertexAttribPointer(6, 3, gl.FLOAT, false, stride, 48);
  }

  /**
   * Sets the projection uniforms (supporting offset mode + globe mode)
   * @param projectionData MapLibre's ProjectionData
   * @param zoom The current zoom level (used for switching offset mode)
   */
  private setProjectionUniforms(projectionData: ProjectionData, zoom: number): void {
    this.projectionUniformManager.setUniforms(projectionData, zoom, this.offsetUniforms);
  }

  /**
   * Batch-draws multiple polygons
   *
   * Draws the fill and stroke of each polygon in a single draw call.
   * The z-order is preserved by the order of the array.
   *
   * @param factors The factors used at draw time (the opacity of the layer being drawn; scale 1
   *   and opacity 1 when omitted)
   * @returns The number of indices drawn (for debugging)
   */
  drawBatch(
    polygons: SDFPolygonBatchData[],
    projectionData: ProjectionData,
    zoom: number,
    viewport: [number, number],
    factors: RetainedDrawFactors = NEUTRAL_DRAW_FACTORS,
  ): number {
    if (!this.program || polygons.length === 0) return 0;

    const gl = this.gl;

    // Compute relative coordinates on the CPU side (offset mode: computed at 64-bit precision)
    const centerLngLat: [number, number] = this.offsetUniforms?.centerLngLat ?? [0, 0];

    const { vertexData, indexData } = this.buildGeometry(polygons, centerLngLat, true);

    if (indexData.length === 0) return 0;

    // Transfer the data to the buffer
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, vertexData, gl.DYNAMIC_DRAW);

    // Draw
    gl.useProgram(this.program);
    this.setProjectionUniforms(projectionData, zoom);
    this.setShapeUniforms(viewport, zoom);
    // Always written (1 when the caller has none) so that no factor of an earlier draw is left
    this.setDrawFactors(factors);

    gl.bindVertexArray(this.vao);
    // The ELEMENT_ARRAY_BUFFER binding is VAO state, so the transfer is done after
    // binding the VAO
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indexData, gl.DYNAMIC_DRAW);
    drawFillWithTerrainCull(gl, this.terrain, () => {
      gl.drawElements(gl.TRIANGLES, indexData.length, gl.UNSIGNED_INT, 0);
    });
    gl.bindVertexArray(null);

    return indexData.length;
  }

  /**
   * Writes the factors used at draw time
   *
   * Uniforms are residual state per program, so they are always reset to 1 even on paths
   * that do not use the factors (immediate mode, the retained drawing of the Store). If
   * the value already written is the same, it is not rewritten.
   */
  private setDrawFactors(factors: RetainedDrawFactors): void {
    const gl = this.gl;
    const frame = getRenderFrame();
    const staleFrame = this.memoFactorsFrame !== frame;

    if (this.sizeScaleLoc && (staleFrame || this.memoSizeScale !== factors.scale)) {
      gl.uniform1f(this.sizeScaleLoc, factors.scale);
      this.memoSizeScale = factors.scale;
    }
    if (this.opacityLoc && (staleFrame || this.memoOpacity !== factors.opacity)) {
      gl.uniform1f(this.opacityLoc, factors.opacity);
      this.memoOpacity = factors.opacity;
    }
    this.memoFactorsFrame = frame;
  }

  /**
   * Builds a retained-mode polygon batch
   *
   * earcut and the construction of the vertex array are finished here, so that in
   * subsequent frames drawing takes only the bind + uniforms + draw call of
   * `drawRetained`. The vertex data does not depend on the camera (the projection is done
   * with per-frame uniforms).
   *
   * The earcut result is not put into the shared cache (the build happens only once, and
   * the cache used by the drawing of the Store must not be polluted with the features
   * of datasets). However, when options.triangulator is passed, both the caching and the
   * time slicing of the triangulation become its responsibility
   * (display/triangulation.ts).
   *
   * @returns The built batch. null when the shader is not initialized or there are no
   *   vertices
   */
  buildRetained(
    polygons: SDFPolygonBatchData[],
    options: RetainedPolygonBuildOptions = {},
  ): RetainedPolygonBatch | null {
    if (!this.program || polygons.length === 0) return null;

    const gl = this.gl;

    // The origin of the relative coordinates is fixed per batch (it is not made to depend
    // on the camera center)
    const origin = normalizeOrigin(options.origin ?? defaultPolygonOrigin(polygons));

    const { vertexData, indexData } = this.buildGeometry(
      polygons,
      origin,
      false,
      options.triangulator,
    );
    if (indexData.length === 0) return null;

    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);

    const vertexBuffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, vertexData, gl.STATIC_DRAW);

    this.setupVertexAttribs();

    // The ELEMENT_ARRAY_BUFFER binding is part of the VAO state
    const indexBuffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indexData, gl.STATIC_DRAW);

    gl.bindVertexArray(null);

    return {
      vao,
      vertexBuffer,
      indexBuffer,
      indexCount: indexData.length,
      origin,
      widthZoom: options.widthZoom ?? null,
    };
  }

  /**
   * Draws a retained-mode polygon batch
   *
   * Neither earcut nor bufferData is performed. The projection uniforms are recomputed
   * each frame from the origin of the batch (the vertex data is not rebuilt).
   *
   * @param factors The factors used at draw time (when omitted, scale 1 and opacity 1, as
   *   before)
   */
  drawRetained(
    batch: RetainedPolygonBatch,
    zoom: number,
    projectionData: ProjectionData,
    viewport: [number, number],
    factors: RetainedDrawFactors = NEUTRAL_DRAW_FACTORS,
  ): void {
    if (!this.program || batch.indexCount === 0) return;

    const gl = this.gl;

    gl.useProgram(this.program);

    // The center of the linearization is aligned to the camera center (if it were
    // linearized around the origin of the batch, the residual of the Mercator
    // approximation would become a displacement of several pixels at vertices far from
    // the center). The vertices are relative to the origin, so that difference is passed
    // via u_origin_shift
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

    this.setShapeUniforms(viewport, batch.widthZoom ?? zoom);
    this.setDrawFactors(factors);

    gl.bindVertexArray(batch.vao);
    drawFillWithTerrainCull(gl, this.terrain, () => {
      gl.drawElements(gl.TRIANGLES, batch.indexCount, gl.UNSIGNED_INT, 0);
    });
    gl.bindVertexArray(null);
  }

  /**
   * Disposes of a retained-mode polygon batch
   */
  disposeRetained(batch: RetainedPolygonBatch): void {
    const gl = this.gl;
    gl.deleteVertexArray(batch.vao);
    gl.deleteBuffer(batch.vertexBuffer);
    gl.deleteBuffer(batch.indexBuffer);
  }

  /**
   * Decides the subdivision step used for this batch (null on a flat map without terrain)
   *
   * The step is the terrain's, or on the globe the cell of its fills (`globe-subdivision.ts`).
   *
   * A batch whose total cell count exceeds the budget drops every feature uniformly onto
   * a coarser grid. The per-feature cap (TERRAIN_MAX_SUBDIVISION_POINTS) is insurance
   * against "one huge polygon" and does not help against "thousands of small polygons".
   * With 8,172 administrative boundaries, even at a few hundred cells each (far below the
   * cap) the total reached 1.7 million cells, and a single build took 34 seconds
   * (measured).
   */
  private batchTerrainStep(polygons: SDFPolygonBatchData[]): TessellationStep | null {
    const base = getSurfaceTessellationStep(this.terrain, 'fill');
    if (!base) return null;

    let totalCells = 0;
    for (const polygon of polygons) {
      // Only the outer ring is looked at (an inner ring is inside the outer ring, so it
      // does not change the total)
      const outer = polygon.coordinates[0];
      if (outer) totalCells += ringBoundingCells(outer, base.grid, base.region);
    }

    const factor = batchTessellationFactor(totalCells);
    // A coarsely subdivided polygon sinks into the depth easily. This is reported so that
    // the bias can be matched
    reportTerrainCoarsening(this.terrain, factor);
    if (factor <= 1) return base;

    // While subdividing in alignment with the actual tile mesh, the coarsening is kept to
    // a few steps of powers of 2 (it keeps riding on a subset of the mesh nodes, so
    // valley floors do not sink)
    if (base.tiling) {
      return { ...base, coarsen: Math.min(factor, TERRAIN_MAX_TILED_COARSEN) };
    }
    return { grid: base.grid * factor, maxPoints: base.maxPoints, region: base.region };
  }

  /**
   * Builds the vertex array and index array of the batch (shared by immediate mode and
   * retained mode)
   *
   * The indices are laid out in the order "fill of polygon 0 -> outline of polygon 0 ->
   * fill of polygon 1 -> ...", so the z-order is preserved even with a single
   * drawElements.
   *
   * @param centerLngLat The origin of the relative coordinates
   * @param useEarcutCache Whether to put the triangulation result into the draw instance's cache
   * @param triangulator The supplier of triangulations (earcut is called on the spot when
   *   omitted)
   */
  private buildGeometry(
    polygons: SDFPolygonBatchData[],
    centerLngLat: [number, number],
    useEarcutCache: boolean,
    triangulator?: PolygonTriangulator,
  ): PolygonGeometry {
    // Pass 1: collect the triangulations and the rings, and count the required array lengths
    const records: PolygonRecord[] = [];
    let totalVertices = 0;
    let totalIndices = 0;

    // Subdivide on a grid only while terrain is active or the globe is drawn (on a flat map
    // without terrain it passes through as null). The total cell count of the whole batch is
    // estimated first, and if it exceeds the budget everything is coarsened uniformly. A
    // per-feature cap alone cannot stop a batch with thousands of features (a
    // dataset). The factor is made single for the whole batch (if it varied per feature,
    // adjacent features would ride on different grids and disagree at their shared boundary).
    const terrainStep = this.batchTerrainStep(polygons);

    for (const polygon of polygons) {
      const style = polygon.style;

      // Flatten all rings to build the earcut input (inner rings are treated as holes)
      const { flatCoords, holeIndices, rings } = buildEarcutInput(polygon.coordinates);
      if (rings.length === 0) continue;

      // The step actually used for this feature. It is received from the result of
      // subdividing the fill and the same value is used for the outline as well. If the
      // fill were coarsened because the budget ran out while the outline stayed fine, the
      // two would ride on different grids and diverge in a wedge shape.
      let polygonStep: TessellationStep | null = null;

      // 1. Fill
      let fillCoords: number[] | null = null;
      let fillIndices: number[] | null = null;
      if (style.fillOpacity > 0) {
        const indices = this.triangulate(
          polygon,
          flatCoords,
          holeIndices,
          useEarcutCache,
          triangulator,
        );
        if (indices && indices.length > 0) {
          // Subdivision points are placed inside the triangles too. Subdividing only the
          // edges still lets the center of a triangle pierce the terrain
          if (terrainStep) {
            const tessellated = tessellateSurfaceFill(
              this.terrain,
              polygon.featureId,
              polygon.partIndex ?? 0,
              flatCoords,
              indices,
              terrainStep,
            );
            polygonStep = tessellated.step;
            fillCoords = tessellated.flatCoords;
            fillIndices = tessellated.indices;
          } else {
            fillCoords = flatCoords;
            fillIndices = indices;
          }
          totalVertices += fillCoords.length / 2;
          totalIndices += fillIndices.length;
        }
      }

      // 2. Stroke (the outer ring and each inner ring are drawn as their own closed path)
      // A width of 0 means "no outline". A negative width is the fixed-width convention,
      // so it is included among the things to draw.
      let strokeRings: Array<Array<[number, number]>> | null = null;
      if (style.strokeOpacity > 0 && style.strokeWidth !== 0) {
        // When no fill was built (a polygon without a fill) the step cannot be received,
        // so only in that case it is derived from the size of the feature
        const ringStep =
          polygonStep ?? (terrainStep ? polygonTessellationStep(terrainStep, flatCoords) : null);
        const strokeSource = ringStep ? tessellateRings(rings, ringStep) : rings;
        const usable = strokeSource.filter((ring) => ring.length >= 3);
        if (usable.length > 0) {
          strokeRings = usable;
          for (const ring of usable) {
            // 4 vertices and 6 indices per segment
            totalVertices += ring.length * 4;
            totalIndices += ring.length * 6;
          }
        }
      }

      if (!fillIndices && !strokeRings) continue;

      records.push({
        fillCoords,
        fillIndices,
        strokeRings,
        style,
        createdZoom: polygon.createdZoom,
      });
    }

    // Pass 2: write directly into the typed arrays
    const vertexData = new Float32Array(totalVertices * VERTEX_STRIDE);
    const indexData = new Uint32Array(totalIndices);
    // Convert CSS pixels into physical pixels
    //
    // The ratio is chosen by the sign of the width (the "two ratios" of
    // shared/utils/pixel-ratio.ts).
    // Negative value = a width fixed in screen pixels, so the ratio that multiplies
    // renderScale is used.
    // Positive value = a width that the shader scales by 2^(u_zoom - createdZoom), so the
    // ratio that does not multiply renderScale is used (multiplying it would apply the
    // shrinking twice).
    const screenDpr = resolvePixelRatio(this.pixelRatio);
    const contentDpr = resolveContentPixelRatio(this.pixelRatio);
    let base = 0;
    let indexOffset = 0;

    for (const record of records) {
      const style = record.style;

      // 1. Fill: each point of the rings becomes a vertex as is, and the earcut indices
      // are shifted
      if (record.fillCoords && record.fillIndices) {
        const fillColor: [number, number, number, number] = [
          style.fillColor[0],
          style.fillColor[1],
          style.fillColor[2],
          style.fillColor[3] * style.fillOpacity,
        ];
        const pointCount = record.fillCoords.length / 2;

        for (let i = 0; i < pointCount; i++) {
          // Compute the offset from the center at 64-bit precision
          const offset = calculateLngLatOffset(
            [record.fillCoords[i * 2], record.fillCoords[i * 2 + 1]],
            centerLngLat,
          );
          const at = (base + i) * VERTEX_STRIDE;
          vertexData[at] = offset[0];
          vertexData[at + 1] = offset[1];
          vertexData[at + 2] = fillColor[0];
          vertexData[at + 3] = fillColor[1];
          vertexData[at + 4] = fillColor[2];
          vertexData[at + 5] = fillColor[3];
          // type = fill(0), and prev/next/side/extra stay 0
        }

        for (let i = 0; i < record.fillIndices.length; i++) {
          indexData[indexOffset + i] = record.fillIndices[i] + base;
        }

        base += pointCount;
        indexOffset += record.fillIndices.length;
      }

      // 2. Stroke: a quad per edge (4 vertices, 2 triangles)
      if (record.strokeRings) {
        const strokeColor: [number, number, number, number] = [
          style.strokeColor[0],
          style.strokeColor[1],
          style.strokeColor[2],
          style.strokeColor[3] * style.strokeOpacity,
        ];
        const strokeWidth = style.strokeWidth * (style.strokeWidth < 0 ? screenDpr : contentDpr);

        for (const ring of record.strokeRings) {
          const n = ring.length;

          for (let i = 0; i < n; i++) {
            const curr = ring[i];
            const next = ring[(i + 1) % n];
            const prev = ring[(i - 1 + n) % n];
            const nextNext = ring[(i + 2) % n];

            // The left and right of the start point (curr)
            this.writeStrokeVertex(
              vertexData,
              base * VERTEX_STRIDE,
              curr,
              strokeColor,
              prev,
              next,
              1,
              0,
              strokeWidth,
              record.createdZoom,
              centerLngLat,
            );
            this.writeStrokeVertex(
              vertexData,
              (base + 1) * VERTEX_STRIDE,
              curr,
              strokeColor,
              prev,
              next,
              -1,
              0,
              strokeWidth,
              record.createdZoom,
              centerLngLat,
            );
            // The left and right of the end point (next)
            this.writeStrokeVertex(
              vertexData,
              (base + 2) * VERTEX_STRIDE,
              next,
              strokeColor,
              curr,
              nextNext,
              1,
              1,
              strokeWidth,
              record.createdZoom,
              centerLngLat,
            );
            this.writeStrokeVertex(
              vertexData,
              (base + 3) * VERTEX_STRIDE,
              next,
              strokeColor,
              curr,
              nextNext,
              -1,
              1,
              strokeWidth,
              record.createdZoom,
              centerLngLat,
            );

            // Triangle 1: start left, start right, end left / Triangle 2: end left, start
            // right, end right
            indexData[indexOffset] = base;
            indexData[indexOffset + 1] = base + 1;
            indexData[indexOffset + 2] = base + 2;
            indexData[indexOffset + 3] = base + 2;
            indexData[indexOffset + 4] = base + 1;
            indexData[indexOffset + 5] = base + 3;

            base += 4;
            indexOffset += 6;
          }
        }
      }
    }

    return { vertexData, indexData };
  }

  /**
   * Triangulates a polygon (making use of the cache)
   *
   * When a supplier is injected, the work is delegated to it. While the triangulation has
   * not finished yet, null is returned and the fill of that polygon is omitted (the
   * outline is still drawn).
   */
  private triangulate(
    polygon: SDFPolygonBatchData,
    flatCoords: number[],
    holeIndices: number[],
    useEarcutCache: boolean,
    triangulator?: PolygonTriangulator,
  ): number[] | null {
    if (triangulator) {
      return triangulator.triangulate({
        featureId: polygon.featureId,
        partIndex: polygon.partIndex ?? 0,
        flatCoords,
        holeIndices,
      });
    }

    if (useEarcutCache && polygon.featureId) {
      // Try to get it from the cache
      const partIndex = polygon.partIndex ?? 0;
      const cached = this.earcutCache.get(polygon.featureId, partIndex);
      if (cached) return cached;

      const indices = earcut(flatCoords, holeIndices);
      this.earcutCache.set(polygon.featureId, indices, partIndex);
      return indices;
    }

    // When there is no featureId, run it without the cache
    return earcut(flatCoords, holeIndices);
  }

  /**
   * Writes a stroke vertex directly into the vertex array (relative coordinates)
   */
  private writeStrokeVertex(
    target: Float32Array,
    at: number,
    pos: [number, number],
    color: [number, number, number, number],
    prev: [number, number],
    next: [number, number],
    side: number,
    t: number,
    strokeWidth: number,
    createdZoom: number,
    centerLngLat: [number, number],
  ): void {
    // Compute the offset from the center at 64-bit precision
    const posOffset = calculateLngLatOffset(pos, centerLngLat);
    const prevOffset = calculateLngLatOffset(prev, centerLngLat);
    const nextOffset = calculateLngLatOffset(next, centerLngLat);

    target[at] = posOffset[0];
    target[at + 1] = posOffset[1];
    target[at + 2] = color[0];
    target[at + 3] = color[1];
    target[at + 4] = color[2];
    target[at + 5] = color[3];
    target[at + 6] = 1; // type = stroke
    target[at + 7] = prevOffset[0];
    target[at + 8] = prevOffset[1];
    target[at + 9] = nextOffset[0];
    target[at + 10] = nextOffset[1];
    target[at + 11] = side;
    target[at + 12] = t;
    target[at + 13] = strokeWidth;
    target[at + 14] = createdZoom;
  }

  /**
   * Disposes of the resources
   */
  dispose(): void {
    const gl = this.gl;

    if (this.program) {
      gl.deleteProgram(this.program);
      this.program = null;
    }
    if (this.vertexBuffer) {
      gl.deleteBuffer(this.vertexBuffer);
      this.vertexBuffer = null;
    }
    if (this.indexBuffer) {
      gl.deleteBuffer(this.indexBuffer);
      this.indexBuffer = null;
    }
    if (this.vao) {
      gl.deleteVertexArray(this.vao);
      this.vao = null;
    }
  }
}
