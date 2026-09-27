// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * PointInstanceRenderer
 *
 * A renderer that draws points in bulk with instancing.
 * Even when colors and sizes differ, points of the same shape can be drawn in one draw call.
 *
 * A single instance completes both the fill and the stroke. For each point it spans a billboard
 * of the outer radius (radius + stroke width), and the fragment shader looks at the signed
 * distance to the outer edge of the shape (SDF, see point-sdf.ts): the band of the stroke width
 * inside the edge takes the stroke color, the rest of the inside the fill color, and anything
 * outside is discarded. Splitting the fill and the stroke into separate draws would
 * put the stroke of a farther point on top of the fill of a nearer point within the same chunk
 * and break their front-to-back relation. Folding them into one draw makes them stack from back
 * to front in primitive order (= instance order = feature order) even within the same draw.
 *
 * Each instance carries the following attributes:
 * - position (vec2): coordinates relative to the origin
 * - fill color (vec4) / stroke color (vec4): RGBA
 * - radius (float) / stroke width (float): device pixels
 */

import type { Map as MapLibreMap, ProjectionData } from 'maplibre-gl';
import type { PixelRatioInput } from '../../../shared/utils/pixel-ratio.js';
import { resolvePixelRatio } from '../../../shared/utils/pixel-ratio.js';
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
import { anchorElevationMeters } from '../../terrain/anchor.js';
import { TerrainContext } from '../../terrain/context.js';
import { NEUTRAL_DRAW_FACTORS, type RetainedDrawFactors } from '../draw-factors.js';
import { drawBillboardsWithoutDepth } from './billboard-depth.js';
import { POINT_SDF_GLSL, POINT_SHAPE_CODE, type SdfPointShape } from './point-sdf.js';

/** Color type */
export type Color = [number, number, number, number];

/** Point shape (every shape is inscribed in the circle of the outer radius) */
export type PointShape = SdfPointShape;

/**
 * The instanced shape a point style is drawn with, or null for a shape the instanced renderer
 * does not draw (`'icon'`, which goes through the per-point renderer)
 *
 * The retained batches (Store and datasets) and the immediate batches all decide
 * with this function, so the three paths agree on which points are instanced.
 */
export function toInstancedPointShape(shape: string): PointShape | null {
  return INSTANCED_SHAPES.has(shape) ? (shape as PointShape) : null;
}

/** The shapes the instanced renderer draws */
const INSTANCED_SHAPES: ReadonlySet<string> = new Set(Object.keys(POINT_SHAPE_CODE));

/** Point data for instanced rendering (full version) */
export interface PointInstanceDataFull {
  coord: [number, number]; // [lng, lat]
  fillColor: Color;
  fillSize: number; // radius in pixels
  strokeColor: Color;
  strokeWidth: number; // pixels
  /**
   * Ground elevation of the anchor (meters; omitted or 0 means "do not add elevation")
   *
   * Both a point and a vertex handle are UI determined by a single point, so on terrain the
   * longitude and latitude alone do not determine their position. The same elevation as the one
   * used for hit testing is computed on the CPU (view/terrain/anchor.ts) and passed in here, and
   * the vertex shader uses this value as is. Sampling the DEM atlas the way polygons and lines
   * do would give two sources of truth that disagree with hit testing.
   */
  elevationMeters?: number;
  /**
   * Opacity factor used when the point is occluded by the terrain (omitted or 1 is normal
   * display)
   *
   * Points are drawn without the depth test, so a point behind a mountain is plainly visible and
   * is misread as being in front. Occluded ones are drawn faint (ghost).
   *
   * The factor is folded into the alpha of the color. Since its result changes as the camera
   * moves, it is not set on paths that bake it in (retained batches). It is set only on the
   * immediate path, which is rebuilt every frame (baking it in would leave a stale ghost). The
   * editing UI of the current selection (handles, selection outline) is also under manipulation,
   * so it is not set there either.
   */
  ghost?: number;
}

/** Point data for instanced rendering with coordinates only (the style is given as arguments) */
export interface PointInstanceData {
  coord: [number, number]; // [lng, lat]
}

/**
 * Half width of the antialiasing band (device pixels)
 *
 * The billboard is placed one to one with device pixels (the offset is computed in pixels and
 * converted to NDC), so smoothing 0.5px on either side of the boundary yields a 1px wide band.
 */
const AA_HALF_WIDTH_PX = 0.5;

/**
 * Padding added to the billboard (device pixels)
 *
 * Cutting the billboard exactly at the outer radius loses the outer half of the antialiasing.
 */
export const POINT_AA_PADDING_PX = 1;

// Stride of the instance data (floats per instance)
// position(2) + fillColor(4) + strokeColor(4) + size(1) + strokeWidth(1)
//   + elevation(1) = 13 floats
const INSTANCE_STRIDE = 13;
const INSTANCE_BYTES = INSTANCE_STRIDE * 4;

/** Number of vertices of the billboard (quad) */
const QUAD_VERTEX_COUNT = 4;

/** Value of the uniform that represents the shape */
const SHAPE_UNIFORM: Readonly<Record<PointShape, number>> = POINT_SHAPE_CODE;

/**
 * SDF boundaries of one instance (device pixels)
 */
export interface PointSdfEdges {
  /**
   * Radius of the fill. Everything inside this takes the fill color (for a shape other than the
   * circle and the square: everything deeper than the stroke width inside the outer edge)
   */
  radius: number;
  /**
   * Outer radius (radius + stroke width), the circumradius of the shape. Nothing outside the
   * shape of this radius is drawn
   */
  outer: number;
  /** Half edge of the billboard (outer radius + antialiasing padding) */
  extent: number;
}

/**
 * Computes the SDF boundaries
 *
 * This is the same computation the shader performs in the vertex and fragment stages (the GLSL
 * side writes these formulas as they are, and embeds the same constant `POINT_AA_PADDING_PX` for
 * the padding). Negative values are treated as 0, and when the stroke width is 0 the outer
 * radius equals the radius.
 *
 * @param fillSizePx Radius of the fill (device pixels)
 * @param strokeWidthPx Stroke width (device pixels)
 * @param sizeScale Size factor at draw time (default 1)
 */
export function pointSdfEdges(
  fillSizePx: number,
  strokeWidthPx: number,
  sizeScale = 1,
): PointSdfEdges {
  const radius = Math.max(0, fillSizePx) * sizeScale;
  const outer = radius + Math.max(0, strokeWidthPx) * sizeScale;
  return { radius, outer, extent: outer + POINT_AA_PADDING_PX };
}

/**
 * Point batch of the retained mode (GPU resources)
 *
 * It shares no resources with the shared instance buffer and shared VAO of the immediate mode.
 * Since the fill and the stroke are drawn from a single instance array, a batch holds only one
 * set of billboard vertex buffer, instance buffer and VAO.
 */
export interface RetainedPointBatch {
  /** Shape of the points */
  readonly shape: PointShape;
  /** VAO dedicated to this batch */
  readonly vao: WebGLVertexArrayObject;
  /** Vertex buffer of the billboard */
  readonly shapeBuffer: WebGLBuffer;
  /** Instance buffer */
  readonly instanceBuffer: WebGLBuffer;
  /** Number of instances */
  readonly instanceCount: number;
  /** Origin of the relative coordinates (already rounded to Float32) */
  readonly origin: [number, number];
}

/**
 * Options for building a point batch of the retained mode
 */
export interface RetainedPointBuildOptions {
  /** Origin of the relative coordinates (defaults to the coordinates of the first point) */
  origin?: [number, number];
}

/**
 * Rounds the origin of the relative coordinates to Float32
 */
function normalizeOrigin(origin: [number, number]): [number, number] {
  return [Math.fround(origin[0]), Math.fround(origin[1])];
}

/**
 * Default origin of a point batch (the first point)
 */
function defaultPointOrigin(points: PointInstanceDataFull[]): [number, number] {
  const first = points[0]?.coord;
  return first ? [first[0], first[1]] : [0, 0];
}

/**
 * Builds the instance array (shared by the immediate mode and the retained mode)
 *
 * The order is exactly the order of the input (since the instance order directly becomes the
 * front-to-back order of the rendering, nothing is reordered or thinned out). Coordinates are
 * stored as values relative to `origin`, so with a fixed `origin` the result does not depend on
 * the camera.
 */
export function buildPointInstanceData(
  points: PointInstanceDataFull[],
  origin: [number, number],
  pixelRatio?: PixelRatioInput,
  terrain?: TerrainContext,
): Float32Array {
  const dpr = resolvePixelRatio(pixelRatio);
  const data = new Float32Array(points.length * INSTANCE_STRIDE);

  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const offset = i * INSTANCE_STRIDE;
    // Compute the relative coordinates (the origin is already rounded to Float32, and the
    // relative coordinates are small enough for sufficient precision)
    const lngLatOffset = calculateLngLatOffset(p.coord, origin);
    data[offset] = lngLatOffset[0]; // dLng (relative coordinate)
    data[offset + 1] = lngLatOffset[1]; // dLat (relative coordinate)
    // The faintness used when occluded is folded into the alpha (no extra attribute)
    const ghost = p.ghost ?? 1;
    data[offset + 2] = p.fillColor[0];
    data[offset + 3] = p.fillColor[1];
    data[offset + 4] = p.fillColor[2];
    data[offset + 5] = p.fillColor[3] * ghost;
    data[offset + 6] = p.strokeColor[0];
    data[offset + 7] = p.strokeColor[1];
    data[offset + 8] = p.strokeColor[2];
    data[offset + 9] = p.strokeColor[3] * ghost;
    // Convert CSS pixels to device pixels
    data[offset + 10] = p.fillSize * dpr;
    data[offset + 11] = p.strokeWidth * dpr;
    // Ground elevation of the anchor (meters). Without an explicit value it is sampled from the
    // single source of truth. Making each caller attach the elevation lets the defect come back
    // on whichever path forgot it, dropping to sea level 0 (which actually happened for points
    // and handles), so it is placed where every default path goes through. When terrain is
    // disabled it returns 0 and the result is identical to before.
    data[offset + 12] =
      p.elevationMeters ?? (terrain ? anchorElevationMeters(terrain, p.coord[0], p.coord[1]) : 0);
  }

  return data;
}

/**
 * The number of values of the style of one point in {@link PackedPointInstances}
 *
 * fill color (4, the opacity already folded into the alpha) + stroke color (4, likewise) + radius
 * of the fill (CSS pixels) + stroke width (CSS pixels)
 *
 * @internal
 */
export const PACKED_POINT_STYLE_STRIDE = 10;

/**
 * Points packed by the caller into typed arrays (the counterpart of an array of
 * `PointInstanceDataFull` without an object per point)
 *
 * @internal
 */
export interface PackedPointInstances {
  /** The number of points */
  count: number;
  /** `[lng, lat]` per point */
  lngLat: Float64Array;
  /**
   * The style of each point, {@link PACKED_POINT_STYLE_STRIDE} values per point, in the order of
   * `PointInstanceDataFull`: fillColor, strokeColor, fillSize, strokeWidth
   */
  style: Float64Array;
}

/**
 * Builds the instance array from packed points
 *
 * It writes exactly what `buildPointInstanceData` writes for the same points (the same arithmetic
 * in the same order), so the two paths draw the same picture.
 *
 * @internal
 */
export function buildPackedPointInstanceData(
  points: PackedPointInstances,
  origin: [number, number],
  pixelRatio?: PixelRatioInput,
  terrain?: TerrainContext,
): Float32Array {
  const dpr = resolvePixelRatio(pixelRatio);
  const { count, lngLat, style } = points;
  const data = new Float32Array(count * INSTANCE_STRIDE);

  for (let i = 0; i < count; i++) {
    const offset = i * INSTANCE_STRIDE;
    const lng = lngLat[i * 2];
    const lat = lngLat[i * 2 + 1];
    const s = i * PACKED_POINT_STYLE_STRIDE;
    data[offset] = lng - origin[0];
    data[offset + 1] = lat - origin[1];
    data[offset + 2] = style[s];
    data[offset + 3] = style[s + 1];
    data[offset + 4] = style[s + 2];
    data[offset + 5] = style[s + 3];
    data[offset + 6] = style[s + 4];
    data[offset + 7] = style[s + 5];
    data[offset + 8] = style[s + 6];
    data[offset + 9] = style[s + 7];
    data[offset + 10] = style[s + 8] * dpr;
    data[offset + 11] = style[s + 9] * dpr;
    data[offset + 12] = terrain ? anchorElevationMeters(terrain, lng, lat) : 0;
  }

  return data;
}

/**
 * Generates the vertices of the billboard (quad) (for TRIANGLE_STRIP)
 *
 * The difference between shapes (circle, square, triangle, star) is absorbed by the distance
 * function in the fragment shader, so the vertices may be the same billboard regardless of the
 * shape.
 */
function generateQuadVertices(): Float32Array {
  return new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]);
}

/**
 * The full set of projection uniform locations (cached per program)
 */
interface PointProjectionLocs {
  /** Pixel-to-clip-space conversion factor (specific to this renderer) */
  pixelToClip: WebGLUniformLocation | null;
  /** Size factor at draw time (vertex) */
  sizeScale: WebGLUniformLocation | null;
  /** Opacity factor at draw time (fragment) */
  opacity: WebGLUniformLocation | null;
  /** Shape (switches the distance function in the fragment shader) */
  shape: WebGLUniformLocation | null;
}

/**
 * Record of the uniforms written last (for memoization within a frame)
 *
 * The retained mode rewrites the uniforms once per visible chunk, and on a wide view that alone
 * eats up the CPU budget of the frame. The only thing that changes between chunks is
 * u_origin_shift, so writes of identical values are skipped. When the frame changes, the whole
 * set is rewritten (see frame.ts).
 */
interface PointUniformMemo {
  /** Frame number in which the draw-time factors were last written (-1 if never written) */
  factorsFrame: number;
  /** Frame number in which the shape was last written (-1 if never written) */
  shapeFrame: number;
  /** Frame number in which u_pixel_to_clip was last written (-1 if never written) */
  pixelToClipFrame: number;
  /** Canvas dimensions that u_pixel_to_clip was based on */
  canvasWidth: number;
  canvasHeight: number;
  /** Values written to the draw-time factors */
  sizeScale: number;
  opacity: number;
  /** Value written to u_shape */
  shape: number;
}

/**
 * State held per program (uniform locations and the values written last)
 *
 * The projection uniforms are owned by the shared ProjectionUniformManager. Previously this
 * renderer alone wrote the same logic itself, and the terrain uniforms added later (u_terrain_on
 * and others) were left out of it. To make such omissions impossible, writing the projection
 * uniforms is concentrated in one place (ProjectionUniformManager). Since locations are per
 * program, the manager is held per program as well.
 */
interface PointProgramState {
  locs: PointProjectionLocs;
  memo: PointUniformMemo;
  projection: ProjectionUniformManager;
}

/**
 * Creates a record in the never-written state
 */
function createPointMemo(): PointUniformMemo {
  return {
    factorsFrame: -1,
    shapeFrame: -1,
    pixelToClipFrame: -1,
    canvasWidth: Number.NaN,
    canvasHeight: Number.NaN,
    sizeScale: Number.NaN,
    opacity: Number.NaN,
    shape: Number.NaN,
  };
}

/**
 * PointInstanceRenderer
 *
 * @internal
 */
export class PointInstanceRenderer {
  private gl: WebGL2RenderingContext;

  private program: WebGLProgram | null = null;
  private variantName = '';

  // Vertices of the billboard (the vertex buffer is created per VAO)
  private quadVertices: Float32Array;

  // VAO (created per program; points at the shared instance buffer of the immediate mode)
  private quadVaos: Map<WebGLProgram, { vao: WebGLVertexArrayObject; shapeBuffer: WebGLBuffer }> =
    new Map();

  // Instance buffer
  private instanceBuffer: WebGLBuffer | null = null;

  // Projection uniform locations and the values written last (per program)
  private programStates: Map<WebGLProgram, PointProgramState> = new Map();

  // ProjectionData
  private projectionData: ProjectionData | null = null;

  // Canvas size for pixel to clip conversion
  private canvasWidth = 0;
  private canvasHeight = 0;

  // Stores the offset uniforms
  private offsetUniforms: OffsetUniforms | null = null;

  /** Injected device pixel ratio (when not injected, it is read from window each time) */
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
    this.instanceBuffer = gl.createBuffer();
    this.quadVertices = generateQuadVertices();
  }

  /**
   * Ensures the shader exists (recreating it when necessary)
   */
  ensureShader(shaderData: ShaderData): void {
    // The clip conversion uses the drawing buffer, which is what the viewport covers (the
    // canvas attribute can be larger when the browser could not allocate the full size)
    this.canvasWidth = this.gl.drawingBufferWidth;
    this.canvasHeight = this.gl.drawingBufferHeight;

    if (this.variantName !== shaderData.variantName) {
      this.disposePrograms();

      this.program = this.createPointProgram(shaderData.vertexShaderPrelude, shaderData.define);
      this.variantName = shaderData.variantName;
    }
  }

  /**
   * Creates the shader program (offset mode, high precision version)
   *
   * The fill and the stroke are drawn by one program. The vertex stage spans a billboard of the
   * outer radius plus the padding, and the fragment stage separates fill, stroke and outside by
   * the signed distance to the outer edge of the shape.
   */
  private createPointProgram(prelude: string, define: string): WebGLProgram {
    const projTransitionUniform = getProjectionTransitionUniform(prelude);
    const vertexSource = `#version 300 es
${prelude}
${define}
${projTransitionUniform}${OFFSET_MODE_GLSL}
layout(location = 0) in vec2 a_quad;             // billboard vertex (±1)
layout(location = 1) in vec2 a_instance_lnglat_offset;  // offset from center (64-bit on CPU)
layout(location = 2) in vec4 a_instance_fill_color;     // fill color
layout(location = 3) in vec4 a_instance_stroke_color;   // stroke color
layout(location = 4) in float a_instance_size;          // fill radius (pixels)
layout(location = 5) in float a_instance_stroke_width;  // stroke width (pixels)
layout(location = 6) in float a_instance_elevation_m;   // anchor ground elevation (meters)

uniform vec2 u_pixel_to_clip; // pixel-to-clip-space conversion factor
uniform float u_size_scale;   // size factor at draw time (default 1)

// Values constant per instance are passed as flat (avoids both interpolation error and cost)
flat out vec4 v_fill_color;
flat out vec4 v_stroke_color;
out vec2 v_offset_px;
flat out float v_radius_px;
flat out float v_outer_px;

void main() {
    // The anchor elevation comes from the CPU (the same source as hit testing).
    // The DEM atlas is not sampled (two sources make the rendering and the hit area disagree).
    g_anchor_elevation_m = a_instance_elevation_m;
    g_anchor_elevation_on = 1.0;

    // High precision version: uses relative coordinates computed with 64-bit precision on the CPU
    vec4 centerClip = project_position_to_clipspace_from_offset(a_instance_lnglat_offset, u_projection_matrix);

    float radius = max(a_instance_size, 0.0) * u_size_scale;
    float outer = radius + max(a_instance_stroke_width, 0.0) * u_size_scale;
    // The billboard is sized as the outer radius plus the antialiasing padding
    // (so that the edge is not clipped)
    vec2 offsetPx = a_quad * (outer + ${POINT_AA_PADDING_PX.toFixed(1)});

    gl_Position = vec4(centerClip.xy / centerClip.w + offsetPx * u_pixel_to_clip, centerClip.z / centerClip.w, 1.0);

    v_fill_color = a_instance_fill_color;
    v_stroke_color = a_instance_stroke_color;
    v_offset_px = offsetPx;
    v_radius_px = radius;
    v_outer_px = outer;
}`;

    const fragmentSource = `#version 300 es
precision highp float;
flat in vec4 v_fill_color;
flat in vec4 v_stroke_color;
in vec2 v_offset_px;
flat in float v_radius_px;
flat in float v_outer_px;
uniform float u_opacity;      // opacity factor at draw time (default 1)
uniform float u_shape;        // shape (0 = circle, 1 = square, 2 = triangle, 3 = star)
out vec4 fragColor;

const float AA = ${AA_HALF_WIDTH_PX.toFixed(1)};
${POINT_SDF_GLSL}
void main() {
    // Points of size 0 are not drawn (same as before, when the billboard collapsed)
    if (v_outer_px <= 0.0) discard;

    // The billboard is one to one with screen pixels, so the distance can be measured in pixels.
    // d is the signed distance to the outer edge (negative inside)
    float d = pointShapeSdf(v_offset_px, v_outer_px, u_shape);

    // Coverage of the outer edge. Outside it, everything but the antialiasing band is discarded
    float coverage = 1.0 - smoothstep(-AA, AA, d);
    if (coverage <= 0.0) discard;

    // The band of the stroke width inside the edge is the stroke; deeper is the fill. The inside
    // takes the fill color only when there is a stroke (width 0 means all fill)
    float band = v_outer_px - v_radius_px;
    float fillMix = band > 0.0
        ? 1.0 - smoothstep(-band - AA, -band + AA, d)
        : 1.0;
    vec4 color = mix(v_stroke_color, v_fill_color, fillMix);

    // Blending is non-premultiplied, so the factors are applied to the alpha only
    fragColor = vec4(color.rgb, color.a * u_opacity * coverage);
}`;

    return createProgram(this.gl, vertexSource, fragmentSource);
  }

  /**
   * Creates a VAO (with the given instance buffer)
   *
   * The immediate mode passes the shared instance buffer, and the retained mode passes the
   * instance buffer dedicated to the batch. The attribute layout is common to both.
   */
  private createVAOWith(instanceBuffer: WebGLBuffer | null): {
    vao: WebGLVertexArrayObject;
    shapeBuffer: WebGLBuffer;
  } {
    const gl = this.gl;

    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);

    // Vertex buffer of the billboard (location = 0)
    const vertexBuffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.quadVertices, gl.STATIC_DRAW);

    gl.enableVertexAttribArray(0); // a_quad
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    // Instance buffer
    gl.bindBuffer(gl.ARRAY_BUFFER, instanceBuffer);

    // Relative coordinates: location=1, offset 0, 2 floats
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, INSTANCE_BYTES, 0);
    gl.vertexAttribDivisor(1, 1);

    // Fill color: location=2, offset 8, 4 floats
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 4, gl.FLOAT, false, INSTANCE_BYTES, 8);
    gl.vertexAttribDivisor(2, 1);

    // Stroke color: location=3, offset 24, 4 floats
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 4, gl.FLOAT, false, INSTANCE_BYTES, 24);
    gl.vertexAttribDivisor(3, 1);

    // Radius: location=4, offset 40, 1 float
    gl.enableVertexAttribArray(4);
    gl.vertexAttribPointer(4, 1, gl.FLOAT, false, INSTANCE_BYTES, 40);
    gl.vertexAttribDivisor(4, 1);

    // Stroke width: location=5, offset 44, 1 float
    gl.enableVertexAttribArray(5);
    gl.vertexAttribPointer(5, 1, gl.FLOAT, false, INSTANCE_BYTES, 44);
    gl.vertexAttribDivisor(5, 1);

    // Ground elevation of the anchor (meters): location=6, offset 48, 1 float
    gl.enableVertexAttribArray(6);
    gl.vertexAttribPointer(6, 1, gl.FLOAT, false, INSTANCE_BYTES, 48);
    gl.vertexAttribDivisor(6, 1);

    gl.bindVertexArray(null);

    return { vao, shapeBuffer: vertexBuffer };
  }

  /**
   * Gets or creates the VAO of the immediate mode
   */
  private getVAO(program: WebGLProgram): WebGLVertexArrayObject {
    let entry = this.quadVaos.get(program);
    if (!entry) {
      entry = this.createVAOWith(this.instanceBuffer);
      this.quadVaos.set(program, entry);
    }
    return entry.vao;
  }

  /**
   * Sets the ProjectionData
   */
  setProjectionData(projectionData: ProjectionData): void {
    this.projectionData = projectionData;
  }

  /**
   * Sets the uniforms for the offset mode
   */
  setOffsetUniforms(uniforms: OffsetUniforms): void {
    this.offsetUniforms = uniforms;
  }

  /**
   * Gets the per-program state (creating it if absent)
   *
   * Locations stay unchanged until the program is relinked, and the uniform values also remain
   * until it is relinked. Therefore, when the program is disposed of, this cache (including the
   * record) must always be discarded too.
   */
  private getProgramState(program: WebGLProgram): PointProgramState {
    const cached = this.programStates.get(program);
    if (cached) return cached;

    const gl = this.gl;
    const locs: PointProjectionLocs = {
      pixelToClip: gl.getUniformLocation(program, 'u_pixel_to_clip'),
      sizeScale: gl.getUniformLocation(program, 'u_size_scale'),
      opacity: gl.getUniformLocation(program, 'u_opacity'),
      shape: gl.getUniformLocation(program, 'u_shape'),
    };
    const projection = new ProjectionUniformManager(gl).useTerrainState(this.terrain);
    projection.getLocations(program);
    const state: PointProgramState = { locs, memo: createPointMemo(), projection };
    this.programStates.set(program, state);
    return state;
  }

  /**
   * Writes the draw-time factors
   *
   * Uniforms are per-program state that persists, so the paths that do not use the factors (the
   * immediate mode, and the Store's retained rendering) always reset them to 1. If the value
   * already written is the same, it is not written again.
   */
  private setDrawFactors(program: WebGLProgram, factors: RetainedDrawFactors): void {
    const { locs, memo } = this.getProgramState(program);
    const frame = getRenderFrame();
    const staleFrame = memo.factorsFrame !== frame;

    if (locs.sizeScale && (staleFrame || memo.sizeScale !== factors.scale)) {
      this.gl.uniform1f(locs.sizeScale, factors.scale);
      memo.sizeScale = factors.scale;
    }
    if (locs.opacity && (staleFrame || memo.opacity !== factors.opacity)) {
      this.gl.uniform1f(locs.opacity, factors.opacity);
      memo.opacity = factors.opacity;
    }
    memo.factorsFrame = frame;
  }

  /**
   * Writes the shape (switches the distance function in the fragment shader)
   */
  private setShape(program: WebGLProgram, shape: PointShape): void {
    const { locs, memo } = this.getProgramState(program);
    const frame = getRenderFrame();
    const value = SHAPE_UNIFORM[shape] ?? 0;

    if (locs.shape && (memo.shapeFrame !== frame || memo.shape !== value)) {
      this.gl.uniform1f(locs.shape, value);
      memo.shape = value;
    }
    memo.shapeFrame = frame;
  }

  /**
   * Sets the projection uniforms (supporting the offset mode and the globe mode)
   * @param program The shader program
   * @param zoom The current zoom level (used to switch the offset mode)
   */
  private setProjectionUniforms(program: WebGLProgram, zoom: number): void {
    if (!this.projectionData) return;
    this.setProjectionUniformsWith(program, zoom, this.projectionData, this.offsetUniforms);
  }

  /**
   * Sets the projection uniforms (with the ProjectionData and the offset given explicitly)
   *
   * A batch of the retained mode uses its own origin rather than the camera center, so the
   * offset uniforms can be received as an argument.
   *
   * Uniforms whose value is the same as last time are not written again. The retained mode goes
   * through here once per chunk, but the only thing that changes between chunks is
   * u_origin_shift: the matrices, the canvas dimensions and the camera-related values are
   * invariant within a frame (see frame.ts).
   *
   * @param originShift The gap between the origin of the vertex offsets and the linearization
   *   center (defaults to [0,0])
   */
  private setProjectionUniformsWith(
    program: WebGLProgram,
    zoom: number,
    projectionData: ProjectionData,
    offsetUniforms: OffsetUniforms | null,
    originShift: [number, number] = [0, 0],
  ): void {
    const gl = this.gl;

    const { locs, memo, projection } = this.getProgramState(program);
    const frame = getRenderFrame();

    // The projection uniforms (offset mode, globe, terrain) are delegated to the shared manager.
    // Writing them here by hand would make this renderer alone miss uniforms added to the
    // projection (which is exactly what happened with the terrain uniforms added later).
    projection.setUniforms(projectionData, zoom, offsetUniforms, originShift);

    // Only the factor that places the billboard in pixels is specific to this renderer, so it is
    // written here by hand
    if (
      locs.pixelToClip &&
      (memo.pixelToClipFrame !== frame ||
        memo.canvasWidth !== this.canvasWidth ||
        memo.canvasHeight !== this.canvasHeight)
    ) {
      gl.uniform2f(locs.pixelToClip, 2 / this.canvasWidth, 2 / this.canvasHeight);
      memo.canvasWidth = this.canvasWidth;
      memo.canvasHeight = this.canvasHeight;
    }
    memo.pixelToClipFrame = frame;
  }

  /**
   * Draws all points in batches by shape
   *
   * The fill and the stroke are completed in a single draw call, so they stack from back to
   * front in instance order (= the order of the given array = feature order).
   *
   * @param points The array of point data
   * @param shape The point shape
   * @param zoom The current zoom level
   * @param factors The draw-time factors (the opacity of the layer being drawn; scale 1 and
   *   opacity 1 when omitted)
   */
  drawAll(
    points: PointInstanceDataFull[],
    shape: PointShape,
    zoom: number,
    factors: RetainedDrawFactors = NEUTRAL_DRAW_FACTORS,
  ): void {
    if (!this.program || !this.projectionData) return;
    if (points.length === 0) return;

    const gl = this.gl;

    // Get the center coordinates already rounded to Float32 (for the CPU-side offset computation)
    // In the offset mode, the CPU side and the shader side must use the same center coordinates.
    // Since projectionCenter is computed from these center coordinates with 64-bit precision,
    // using the same Float32-rounded center coordinates on the CPU side keeps them consistent.
    const centerLngLat: [number, number] = this.offsetUniforms?.centerLngLat ?? [0, 0];

    // Prepare the instance data (the relative coordinates are computed on the CPU side)
    const instanceData = buildPointInstanceData(
      points,
      centerLngLat,
      this.pixelRatio,
      this.terrain,
    );

    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, instanceData, gl.DYNAMIC_DRAW);

    gl.useProgram(this.program);
    this.setProjectionUniforms(this.program, zoom);
    // Always written (1 when the caller has none) so that no factor of an earlier draw is left
    this.setDrawFactors(this.program, factors);
    this.setShape(this.program, shape);

    gl.bindVertexArray(this.getVAO(this.program));
    drawBillboardsWithoutDepth(gl, () => {
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, QUAD_VERTEX_COUNT, points.length);
    });

    gl.bindVertexArray(null);
  }

  /**
   * Builds a point batch of the retained mode
   *
   * It creates the instance array and the VAO so that in later frames the points can be drawn
   * with only the bind, the uniforms and the draw call of `drawRetained`. The position, color
   * and size of the points do not depend on the camera (the projection is done by the uniforms
   * of each frame).
   *
   * @returns The built batch, or null when the shader is not initialized or there are no points
   */
  buildRetained(
    points: PointInstanceDataFull[],
    shape: PointShape,
    options: RetainedPointBuildOptions = {},
  ): RetainedPointBatch | null {
    if (!this.program) return null;
    if (points.length === 0) return null;

    const gl = this.gl;

    // The origin of the relative coordinates is fixed per batch (it must not depend on the
    // camera center)
    const origin = normalizeOrigin(options.origin ?? defaultPointOrigin(points));

    const instanceBuffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, instanceBuffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      buildPointInstanceData(points, origin, this.pixelRatio, this.terrain),
      gl.STATIC_DRAW,
    );

    const { vao, shapeBuffer } = this.createVAOWith(instanceBuffer);

    return {
      shape,
      vao,
      shapeBuffer,
      instanceBuffer,
      instanceCount: points.length,
      origin,
    };
  }

  /**
   * Builds a point batch of the retained mode from packed points
   *
   * The same batch as `buildRetained` builds for the same points, without an object per point.
   *
   * @returns The built batch, or null when the shader is not initialized or there are no points
   *
   * @internal
   */
  buildRetainedPacked(
    points: PackedPointInstances,
    shape: PointShape,
    options: RetainedPointBuildOptions = {},
  ): RetainedPointBatch | null {
    if (!this.program) return null;
    if (points.count === 0) return null;

    const gl = this.gl;
    const origin = normalizeOrigin(options.origin ?? [points.lngLat[0], points.lngLat[1]]);

    const instanceBuffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, instanceBuffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      buildPackedPointInstanceData(points, origin, this.pixelRatio, this.terrain),
      gl.STATIC_DRAW,
    );

    const { vao, shapeBuffer } = this.createVAOWith(instanceBuffer);

    return {
      shape,
      vao,
      shapeBuffer,
      instanceBuffer,
      instanceCount: points.count,
      origin,
    };
  }

  /**
   * Draws a point batch of the retained mode
   *
   * No bufferData is performed. The projection uniforms are recomputed every frame from the
   * origin of the batch (the instance array is not rebuilt).
   *
   * @param factors The draw-time factors (when omitted, scale 1 and opacity 1, as before)
   */
  drawRetained(
    batch: RetainedPointBatch,
    zoom: number,
    projectionData: ProjectionData,
    factors: RetainedDrawFactors = NEUTRAL_DRAW_FACTORS,
  ): void {
    if (!this.program) return;
    if (batch.instanceCount === 0) return;

    const gl = this.gl;

    // The linearization center is aligned with the camera center (linearizing around the origin
    // of the batch turns the residual of the Mercator approximation into a displacement of
    // pixel order at vertices far from the center).
    // The instances are relative to the origin, so that difference is passed as u_origin_shift
    const cameraUniforms = this.offsetUniforms;
    const offsetUniforms =
      cameraUniforms ??
      // Fallback (normally custom-layer has already called setOffsetUniforms every frame)
      calculateOffsetUniforms(batch.origin, projectionData.mainMatrix as unknown as Float32Array);
    const originShift: [number, number] = cameraUniforms
      ? [
          batch.origin[0] - cameraUniforms.centerLngLat[0],
          batch.origin[1] - cameraUniforms.centerLngLat[1],
        ]
      : [0, 0];

    gl.useProgram(this.program);
    this.setProjectionUniformsWith(this.program, zoom, projectionData, offsetUniforms, originShift);
    this.setDrawFactors(this.program, factors);
    this.setShape(this.program, batch.shape);

    gl.bindVertexArray(batch.vao);
    drawBillboardsWithoutDepth(gl, () => {
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, QUAD_VERTEX_COUNT, batch.instanceCount);
    });

    gl.bindVertexArray(null);
  }

  /**
   * Disposes of a point batch of the retained mode
   */
  disposeRetained(batch: RetainedPointBatch): void {
    const gl = this.gl;

    gl.deleteVertexArray(batch.vao);
    gl.deleteBuffer(batch.shapeBuffer);
    gl.deleteBuffer(batch.instanceBuffer);
  }

  /**
   * Disposes of the program
   */
  private disposePrograms(): void {
    const gl = this.gl;
    if (this.program) {
      gl.deleteProgram(this.program);
      this.program = null;
    }

    // The uniform locations and the record of the values written last are tied to the program,
    // so they are discarded along with it (a recreated program also resets its uniforms to their
    // initial values)
    this.programStates.clear();

    // Clear the VAOs and the vertex buffers of the billboard
    for (const entry of this.quadVaos.values()) {
      gl.deleteVertexArray(entry.vao);
      gl.deleteBuffer(entry.shapeBuffer);
    }
    this.quadVaos.clear();
  }

  /**
   * Disposes of the resources
   */
  dispose(): void {
    const gl = this.gl;

    this.disposePrograms();

    if (this.instanceBuffer) {
      gl.deleteBuffer(this.instanceBuffer);
      this.instanceBuffer = null;
    }
  }
}
