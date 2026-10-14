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
 * - shape (float): the code of the shape (`POINT_SHAPE_CODE`), so points of every shape are
 *   drawn in one draw call and in their order
 */

import type { Map as MapLibreMap, ProjectionData } from 'maplibre-gl';
import type { PixelRatioInput } from '../../../shared/utils/pixel-ratio.js';
import { resolvePixelRatio } from '../../../shared/utils/pixel-ratio.js';
import type { GpuLedger } from '../../gpu-ledger.js';
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
import { type RetainedDrawRun, retainedDrawRun } from '../draw-run.js';
import {
  bindRowState,
  ROW_HIDDEN_POSITION_GLSL,
  ROW_STATE_GLSL,
  type RowStateBinding,
  RowStateUniforms,
} from '../row-state.js';
import {
  disableDepthForBillboards,
  drawBillboardsWithoutDepth,
  restoreDepthAfterBillboards,
} from './billboard-depth.js';
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
   * The shape of this point (when omitted, the shape given to the draw or the build)
   *
   * The shape is a value of the instance, so points of different shapes go in one batch in
   * their order.
   */
  shape?: PointShape;
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

/**
 * The smallest outer radius a point is drawn at (device pixels): a diameter of one pixel
 *
 * A smaller point cannot be drawn smaller, since the antialiasing band alone is a pixel wide: its
 * coverage would tend to a blob of a fixed size as the radius goes to 0, and the point would never
 * fade. Below this radius the shape is drawn at it, fainter by the ratio of the areas
 * (`pointInkFactor`), so the ink it leaves follows its area and goes to nothing with it.
 */
export const POINT_MIN_OUTER_PX = 0.5;

// Stride of the instance data (floats per instance)
// position(2) + fillColor(4) + strokeColor(4) + size(1) + strokeWidth(1)
//   + elevation(1) + shape(1) = 14 floats
const INSTANCE_STRIDE = 14;
const INSTANCE_BYTES_PLAIN = INSTANCE_STRIDE * 4;

/** The float of the instance that holds the code of the shape */
const INSTANCE_SHAPE = 13;

/**
 * Floats per instance of a batch of rows held as columns: the 14 of an instance and the number
 * of the row in its row group
 *
 * @internal
 */
export const ROW_POINT_STRIDE = 15;
const ROW_POINT_BYTES = ROW_POINT_STRIDE * 4;

/** The size of the vertex buffer of the billboard */
const QUAD_BYTES = 8 * 4;

/** Number of vertices of the billboard (quad) */
const QUAD_VERTEX_COUNT = 4;

/**
 * The code of a shape as the instances carry it
 *
 * @internal
 */
export function pointShapeCode(shape: PointShape): number {
  return POINT_SHAPE_CODE[shape] ?? 0;
}

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
  // Below a diameter of one pixel the shape is drawn at that diameter (pointInkFactor)
  if (outer > 0 && outer < POINT_MIN_OUTER_PX) {
    const grow = POINT_MIN_OUTER_PX / outer;
    return {
      radius: radius * grow,
      outer: POINT_MIN_OUTER_PX,
      extent: POINT_MIN_OUTER_PX + POINT_AA_PADDING_PX,
    };
  }
  return { radius, outer, extent: outer + POINT_AA_PADDING_PX };
}

/**
 * The factor the alpha of a point is multiplied by (the same computation as the shader)
 *
 * 1 at an outer radius of `POINT_MIN_OUTER_PX` and above. Below it the point is drawn at that
 * radius (`pointSdfEdges`), and the factor is the ratio of its true area to the area drawn, so the
 * ink it leaves follows its area and goes to 0 with it. A radius of 0 or below draws nothing (0).
 *
 * @param outerPx The outer radius (radius + stroke width, with the size factor; device pixels)
 */
export function pointInkFactor(outerPx: number): number {
  if (!(outerPx > 0)) return 0;
  if (outerPx >= POINT_MIN_OUTER_PX) return 1;
  const ratio = outerPx / POINT_MIN_OUTER_PX;
  return ratio * ratio;
}

/**
 * Point batch of the retained mode (GPU resources)
 *
 * It shares no resources with the shared instance buffer and shared VAO of the immediate mode.
 * Since the fill and the stroke are drawn from a single instance array, a batch holds only one
 * instance buffer and one VAO. The vertices of the billboard are the same for every point, so
 * the VAO points at the one buffer of the renderer, which the batch neither owns nor deletes.
 */
export interface RetainedPointBatch {
  /** The shape of the points that do not name one */
  readonly shape: PointShape;
  /**
   * For a batch of rows held as columns, where the instances of each row start: row `r` of the
   * batch has the instances `[rowFirst[r], rowFirst[r + 1])` (rows + 1 entries). Undefined for
   * any other batch
   */
  readonly rowFirst?: Int32Array;
  /** VAO dedicated to this batch */
  readonly vao: WebGLVertexArrayObject;
  /**
   * For a batch of rows held as columns, the instance the instance attributes of its VAO point
   * at now (a state of the VAO: a draw of a range of rows points them at the first instance of
   * the range, only when they point elsewhere)
   */
  pointedFirst?: number;
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
  shape: PointShape = 'circle',
): Float32Array {
  const dpr = resolvePixelRatio(pixelRatio);
  const data = new Float32Array(points.length * INSTANCE_STRIDE);
  const defaultCode = pointShapeCode(shape);

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
    data[offset + INSTANCE_SHAPE] = p.shape ? pointShapeCode(p.shape) : defaultCode;
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
 * Writes one instance: what `buildPackedPointInstanceData` writes for one point
 *
 * @param target The instance array
 * @param at Where the instance starts in `target`
 * @param style The packed style ({@link PACKED_POINT_STYLE_STRIDE} values from `styleAt`)
 * @param dpr The pixel ratio the sizes are converted with
 * @param elevation The elevation of the anchor in meters
 * @param shapeCode The code of the shape ({@link pointShapeCode})
 * @internal
 */
export function writePointInstance(
  target: Float32Array,
  at: number,
  lng: number,
  lat: number,
  origin: readonly [number, number],
  style: ArrayLike<number>,
  styleAt: number,
  dpr: number,
  elevation: number,
  shapeCode: number,
): void {
  target[at] = lng - origin[0];
  target[at + 1] = lat - origin[1];
  target[at + 2] = style[styleAt];
  target[at + 3] = style[styleAt + 1];
  target[at + 4] = style[styleAt + 2];
  target[at + 5] = style[styleAt + 3];
  target[at + 6] = style[styleAt + 4];
  target[at + 7] = style[styleAt + 5];
  target[at + 8] = style[styleAt + 6];
  target[at + 9] = style[styleAt + 7];
  target[at + 10] = style[styleAt + 8] * dpr;
  target[at + 11] = style[styleAt + 9] * dpr;
  target[at + 12] = elevation;
  target[at + INSTANCE_SHAPE] = shapeCode;
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
  shape: PointShape = 'circle',
): Float32Array {
  const dpr = resolvePixelRatio(pixelRatio);
  const { count, lngLat, style } = points;
  const data = new Float32Array(count * INSTANCE_STRIDE);
  const code = pointShapeCode(shape);

  for (let i = 0; i < count; i++) {
    const lng = lngLat[i * 2];
    const lat = lngLat[i * 2 + 1];
    writePointInstance(
      data,
      i * INSTANCE_STRIDE,
      lng,
      lat,
      origin,
      style,
      i * PACKED_POINT_STYLE_STRIDE,
      dpr,
      terrain ? anchorElevationMeters(terrain, lng, lat) : 0,
      code,
    );
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
  /** Frame number in which u_pixel_to_clip was last written (-1 if never written) */
  pixelToClipFrame: number;
  /** Canvas dimensions that u_pixel_to_clip was based on */
  canvasWidth: number;
  canvasHeight: number;
  /** Values written to the draw-time factors */
  sizeScale: number;
  opacity: number;
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
    pixelToClipFrame: -1,
    canvasWidth: Number.NaN,
    canvasHeight: Number.NaN,
    sizeScale: Number.NaN,
    opacity: Number.NaN,
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
  /** The variant of the program that draws rows held as columns (made on its first use) */
  private rowProgram: WebGLProgram | null = null;
  /** The uniforms of the state of the rows in `rowProgram` */
  private rowStateUniforms: RowStateUniforms | null = null;
  /** The shader data the programs were made with (the variant of the rows is made from it) */
  private shaderData: ShaderData | null = null;

  /**
   * The vertices of the billboard, one buffer shared by the VAOs of the immediate mode and every
   * retained batch of this renderer (recorded once in the ledger, deleted by `dispose`). The
   * renderer lives as long as its context does: a lost context drops the renderer and its
   * batches, and the restore makes a new renderer with a new buffer
   */
  private quadBuffer: WebGLBuffer | null = null;

  // VAO (created per program; points at the shared instance buffer of the immediate mode)
  private quadVaos: Map<WebGLProgram, WebGLVertexArrayObject> = new Map();

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
  /** Where the GPU memory this renderer allocates is recorded */
  private readonly ledger: GpuLedger | undefined;
  /** The run of the retained draws of the context (shared with the other renderers) */
  private readonly run: RetainedDrawRun;
  /**
   * The gap between the origin of a retained batch and the camera center, written for each
   * draw (the projection keeps its values, not the array)
   */
  private readonly originShift: [number, number] = [0, 0];

  constructor(
    _map: MapLibreMap,
    gl: WebGL2RenderingContext,
    pixelRatio?: PixelRatioInput,
    terrain: TerrainContext = new TerrainContext(),
    ledger?: GpuLedger,
  ) {
    this.gl = gl;
    this.pixelRatio = pixelRatio;
    this.terrain = terrain;
    this.ledger = ledger;
    this.run = retainedDrawRun(gl);
    this.instanceBuffer = gl.createBuffer();
    this.quadBuffer = gl.createBuffer();
    if (this.quadBuffer) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, generateQuadVertices(), gl.STATIC_DRAW);
      ledger?.record(this.quadBuffer, 'points', 'buffer', QUAD_BYTES);
    }
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
      this.shaderData = shaderData;
    }
  }

  /**
   * Makes the variant of the program that draws rows held as columns, for the shader data of
   * the program (once per variant)
   *
   * @returns Whether it can draw rows (false before the first `ensureShader`)
   * @internal
   */
  ensureRowProgram(): boolean {
    if (this.rowProgram) return true;
    const shaderData = this.shaderData;
    if (!shaderData) return false;
    this.rowProgram = this.createPointProgram(
      shaderData.vertexShaderPrelude,
      shaderData.define,
      true,
    );
    this.rowStateUniforms = new RowStateUniforms(this.gl, this.rowProgram);
    return true;
  }

  /**
   * Creates the shader program (offset mode, high precision version)
   *
   * The fill and the stroke are drawn by one program. The vertex stage spans a billboard of the
   * outer radius plus the padding, and the fragment stage separates fill, stroke and outside by
   * the signed distance to the outer edge of the shape.
   */
  private createPointProgram(prelude: string, define: string, rows = false): WebGLProgram {
    const projTransitionUniform = getProjectionTransitionUniform(prelude);
    const vertexSource = `#version 300 es
${rows ? '#define TABLE_ROWS' : ''}
${prelude}
${define}
${projTransitionUniform}${OFFSET_MODE_GLSL}${ROW_STATE_GLSL}
layout(location = 0) in vec2 a_quad;             // billboard vertex (±1)
layout(location = 1) in vec2 a_instance_lnglat_offset;  // offset from center (64-bit on CPU)
layout(location = 2) in vec4 a_instance_fill_color;     // fill color
layout(location = 3) in vec4 a_instance_stroke_color;   // stroke color
layout(location = 4) in float a_instance_size;          // fill radius (pixels)
layout(location = 5) in float a_instance_stroke_width;  // stroke width (pixels)
layout(location = 6) in float a_instance_elevation_m;   // anchor ground elevation (meters)
layout(location = 7) in float a_instance_shape;         // shape (0 circle, 1 square, 2 triangle, 3 star)
#ifdef TABLE_ROWS
layout(location = 8) in float a_row;                    // the number of the row in its group
#endif

uniform vec2 u_pixel_to_clip; // pixel-to-clip-space conversion factor
uniform float u_size_scale;   // size factor at draw time (default 1)

// Values constant per instance are passed as flat (avoids both interpolation error and cost)
flat out vec4 v_fill_color;
flat out vec4 v_stroke_color;
out vec2 v_offset_px;
flat out float v_radius_px;
flat out float v_outer_px;
flat out float v_ink;
flat out float v_shape;

void main() {
    // The anchor elevation comes from the CPU (the same source as hit testing).
    // The DEM atlas is not sampled (two sources make the rendering and the hit area disagree).
    g_anchor_elevation_m = a_instance_elevation_m;
    g_anchor_elevation_on = 1.0;

#ifdef TABLE_ROWS
    // The state of the row: a hidden row draws nothing, a moving one is moved by its set
    uint rowState = readRowState(a_row);
    if (rowStateHidden(rowState)) {
        gl_Position = ${ROW_HIDDEN_POSITION_GLSL};
        return;
    }
    vec2 lnglatOffset = rowStateMove(rowState, a_instance_lnglat_offset);
#else
    vec2 lnglatOffset = a_instance_lnglat_offset;
#endif

    // High precision version: uses relative coordinates computed with 64-bit precision on the CPU
    vec4 centerClip = project_position_to_clipspace_from_offset(lnglatOffset, u_projection_matrix);

    float radius = max(a_instance_size, 0.0) * u_size_scale;
    float outer = radius + max(a_instance_stroke_width, 0.0) * u_size_scale;
    // Below a diameter of one pixel the shape is drawn at that diameter, fainter by the ratio of
    // the areas, so the ink it leaves follows its area (pointSdfEdges, pointInkFactor)
    v_ink = 1.0;
    if (outer > 0.0 && outer < ${POINT_MIN_OUTER_PX.toFixed(1)}) {
        float grow = ${POINT_MIN_OUTER_PX.toFixed(1)} / outer;
        v_ink = 1.0 / (grow * grow);
        radius *= grow;
        outer = ${POINT_MIN_OUTER_PX.toFixed(1)};
    }
    // The billboard is sized as the outer radius plus the antialiasing padding
    // (so that the edge is not clipped)
    vec2 offsetPx = a_quad * (outer + ${POINT_AA_PADDING_PX.toFixed(1)});

    gl_Position = vec4(centerClip.xy / centerClip.w + offsetPx * u_pixel_to_clip, centerClip.z / centerClip.w, 1.0);

    v_fill_color = a_instance_fill_color;
    v_stroke_color = a_instance_stroke_color;
    v_offset_px = offsetPx;
    v_radius_px = radius;
    v_outer_px = outer;
    v_shape = a_instance_shape;
}`;

    const fragmentSource = `#version 300 es
precision highp float;
flat in vec4 v_fill_color;
flat in vec4 v_stroke_color;
in vec2 v_offset_px;
flat in float v_radius_px;
flat in float v_outer_px;
flat in float v_ink;          // the factor of a point below one pixel (1 otherwise)
flat in float v_shape;        // shape (0 = circle, 1 = square, 2 = triangle, 3 = star)
uniform float u_opacity;      // opacity factor at draw time (default 1)
out vec4 fragColor;

const float AA = ${AA_HALF_WIDTH_PX.toFixed(1)};
${POINT_SDF_GLSL}
void main() {
    // Points of size 0 are not drawn (same as before, when the billboard collapsed)
    if (v_outer_px <= 0.0) discard;

    // The billboard is one to one with screen pixels, so the distance can be measured in pixels.
    // d is the signed distance to the outer edge (negative inside)
    float d = pointShapeSdf(v_offset_px, v_outer_px, v_shape);

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
    fragColor = vec4(color.rgb, color.a * u_opacity * coverage * v_ink);
}`;

    return createProgram(this.gl, vertexSource, fragmentSource);
  }

  /**
   * Creates a VAO (with the given instance buffer)
   *
   * The immediate mode passes the shared instance buffer, and the retained mode passes the
   * instance buffer dedicated to the batch. The attribute layout is common to both, and both
   * point at the shared buffer of the billboard.
   */
  private createVAOWith(instanceBuffer: WebGLBuffer | null, rows = false): WebGLVertexArrayObject {
    const gl = this.gl;

    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);

    // Vertex buffer of the billboard (location = 0; the shared buffer)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
    gl.enableVertexAttribArray(0); // a_quad
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    // Instance buffer
    gl.bindBuffer(gl.ARRAY_BUFFER, instanceBuffer);
    this.pointInstanceAttribs(rows, 0);

    gl.bindVertexArray(null);

    return vao;
  }

  /**
   * Points the instance attributes of the bound vertex array at the bound instance buffer,
   * from instance `first` (a batch of rows draws a range of its rows this way: WebGL2 has no
   * draw that starts at an instance)
   *
   * @param setup Whether the attributes are also enabled and made per instance (when the vertex
   *   array is made; a vertex array keeps both, so pointing it elsewhere needs only the pointers)
   */
  private pointInstanceAttribs(rows: boolean, first: number, setup = true): void {
    const gl = this.gl;
    const stride = rows ? ROW_POINT_BYTES : INSTANCE_BYTES_PLAIN;
    const base = first * stride;
    const attribute = (location: number, size: number, offset: number): void => {
      if (setup) gl.enableVertexAttribArray(location);
      gl.vertexAttribPointer(location, size, gl.FLOAT, false, stride, base + offset);
      if (setup) gl.vertexAttribDivisor(location, 1);
    };

    // Relative coordinates: location=1, offset 0, 2 floats
    attribute(1, 2, 0);
    // Fill color: location=2, offset 8, 4 floats
    attribute(2, 4, 8);
    // Stroke color: location=3, offset 24, 4 floats
    attribute(3, 4, 24);
    // Radius: location=4, offset 40, 1 float
    attribute(4, 1, 40);
    // Stroke width: location=5, offset 44, 1 float
    attribute(5, 1, 44);
    // Ground elevation of the anchor (meters): location=6, offset 48, 1 float
    attribute(6, 1, 48);
    // Shape: location=7, offset 52, 1 float
    attribute(7, 1, INSTANCE_SHAPE * 4);
    // The number of the row (rows held as columns only): location=8, offset 56, 1 float
    if (rows) attribute(8, 1, INSTANCE_STRIDE * 4);
  }

  /**
   * Gets or creates the VAO of the immediate mode
   */
  private getVAO(program: WebGLProgram): WebGLVertexArrayObject {
    let vao = this.quadVaos.get(program);
    if (!vao) {
      vao = this.createVAOWith(this.instanceBuffer);
      this.quadVaos.set(program, vao);
    }
    return vao;
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
   * @param shape The shape of the points that do not name one
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
      shape,
    );

    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, instanceData, gl.DYNAMIC_DRAW);
    this.ledger?.record(this.instanceBuffer, 'points', 'buffer', instanceData.byteLength);

    this.run.useProgram(this.program);
    this.setProjectionUniforms(this.program, zoom);
    // Always written (1 when the caller has none) so that no factor of an earlier draw is left
    this.setDrawFactors(this.program, factors);

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
   * @returns The built batch, or null when the shader is not initialized, there are no points, or
   *   the buffer of the billboard could not be made (the context was lost when the renderer was
   *   made)
   */
  buildRetained(
    points: PointInstanceDataFull[],
    shape: PointShape,
    options: RetainedPointBuildOptions = {},
  ): RetainedPointBatch | null {
    if (!this.program || !this.quadBuffer) return null;
    if (points.length === 0) return null;

    const gl = this.gl;

    // The origin of the relative coordinates is fixed per batch (it must not depend on the
    // camera center)
    const origin = normalizeOrigin(options.origin ?? defaultPointOrigin(points));

    const instanceBuffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, instanceBuffer);
    const data = buildPointInstanceData(points, origin, this.pixelRatio, this.terrain, shape);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    this.ledger?.record(instanceBuffer, 'points', 'buffer', data.byteLength);

    const vao = this.createVAOWith(instanceBuffer);

    return {
      shape,
      vao,
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
    if (!this.program || !this.quadBuffer) return null;
    if (points.count === 0) return null;

    const gl = this.gl;
    const origin = normalizeOrigin(options.origin ?? [points.lngLat[0], points.lngLat[1]]);

    const instanceBuffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, instanceBuffer);
    const data = buildPackedPointInstanceData(points, origin, this.pixelRatio, this.terrain, shape);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    this.ledger?.record(instanceBuffer, 'points', 'buffer', data.byteLength);

    const vao = this.createVAOWith(instanceBuffer);

    return {
      shape,
      vao,
      instanceBuffer,
      instanceCount: points.count,
      origin,
    };
  }

  /**
   * Builds a point batch of rows held as columns
   *
   * The instances are written by the caller ({@link writePointInstance}, then the number of the
   * row in its group), {@link ROW_POINT_STRIDE} floats each, in the order of the rows.
   *
   * @param instances The instances (at least `count * ROW_POINT_STRIDE` floats)
   * @param count The number of instances
   * @param origin The origin the positions are relative to (already rounded to Float32)
   * @param rowFirst Where the instances of each row of the batch start (rows + 1 entries)
   * @returns The batch, or null when there is nothing to draw
   * @internal
   */
  buildRetainedRows(
    instances: Float32Array,
    count: number,
    origin: [number, number],
    rowFirst: Int32Array,
  ): RetainedPointBatch | null {
    if (count === 0 || !this.quadBuffer) return null;
    const gl = this.gl;
    const instanceBuffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, instanceBuffer);
    const data = instances.subarray(0, count * ROW_POINT_STRIDE);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    this.ledger?.record(instanceBuffer, 'points', 'buffer', data.byteLength);
    const vao = this.createVAOWith(instanceBuffer, true);
    return {
      shape: 'circle',
      rowFirst,
      vao,
      pointedFirst: 0,
      instanceBuffer,
      instanceCount: count,
      origin: normalizeOrigin(origin),
    };
  }

  /**
   * Draws the rows `[fromRow, toRow)` of a batch of rows held as columns
   *
   * The instance attributes are pointed at the first instance of `fromRow`, and the state of
   * the rows (hidden, moving) is read from the texture of their group.
   *
   * @param factors The draw-time factors (scale 1 and opacity 1 when omitted)
   * @internal
   */
  drawRetainedRange(
    batch: RetainedPointBatch,
    fromRow: number,
    toRow: number,
    zoom: number,
    projectionData: ProjectionData,
    rowState: RowStateBinding,
    factors: RetainedDrawFactors = NEUTRAL_DRAW_FACTORS,
  ): void {
    const rowFirst = batch.rowFirst;
    if (!rowFirst || !this.ensureRowProgram() || !this.rowProgram) return;
    const first = rowFirst[fromRow];
    const count = rowFirst[toRow] - first;
    if (count <= 0) return;

    const gl = this.gl;
    const program = this.rowProgram;
    const cameraUniforms = this.offsetUniforms;
    const offsetUniforms =
      cameraUniforms ??
      calculateOffsetUniforms(batch.origin, projectionData.mainMatrix as unknown as Float32Array);
    const originShift = this.originShift;
    originShift[0] = cameraUniforms ? batch.origin[0] - cameraUniforms.centerLngLat[0] : 0;
    originShift[1] = cameraUniforms ? batch.origin[1] - cameraUniforms.centerLngLat[1] : 0;

    const run = this.run;
    run.useProgram(program);
    this.setProjectionUniformsWith(program, zoom, projectionData, offsetUniforms, originShift);
    this.setDrawFactors(program, factors);
    bindRowState(
      run,
      this.rowStateUniforms as RowStateUniforms,
      rowState,
      cameraUniforms ? cameraUniforms.centerLngLat : batch.origin,
    );

    run.bindVertexArray(batch.vao);
    if (batch.pointedFirst !== first) {
      gl.bindBuffer(gl.ARRAY_BUFFER, batch.instanceBuffer);
      this.pointInstanceAttribs(true, first, false);
      batch.pointedFirst = first;
    }
    const depthWasEnabled = disableDepthForBillboards(gl);
    try {
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, QUAD_VERTEX_COUNT, count);
    } finally {
      restoreDepthAfterBillboards(gl, depthWasEnabled);
    }
    run.release();
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
    const originShift = this.originShift;
    originShift[0] = cameraUniforms ? batch.origin[0] - cameraUniforms.centerLngLat[0] : 0;
    originShift[1] = cameraUniforms ? batch.origin[1] - cameraUniforms.centerLngLat[1] : 0;

    const run = this.run;
    run.useProgram(this.program);
    this.setProjectionUniformsWith(this.program, zoom, projectionData, offsetUniforms, originShift);
    this.setDrawFactors(this.program, factors);

    run.bindVertexArray(batch.vao);
    const depthWasEnabled = disableDepthForBillboards(gl);
    try {
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, QUAD_VERTEX_COUNT, batch.instanceCount);
    } finally {
      restoreDepthAfterBillboards(gl, depthWasEnabled);
    }
    run.release();
  }

  /**
   * Disposes of a point batch of the retained mode
   */
  disposeRetained(batch: RetainedPointBatch): void {
    const gl = this.gl;

    // The buffer of the billboard is shared and stays (`dispose` deletes it)
    gl.deleteVertexArray(batch.vao);
    this.ledger?.release(batch.instanceBuffer);
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
    if (this.rowProgram) {
      gl.deleteProgram(this.rowProgram);
      this.rowProgram = null;
      this.rowStateUniforms = null;
    }

    // The uniform locations and the record of the values written last are tied to the program,
    // so they are discarded along with it (a recreated program also resets its uniforms to their
    // initial values)
    this.programStates.clear();

    // Clear the VAOs of the immediate mode (the shared buffer of the billboard stays)
    for (const vao of this.quadVaos.values()) gl.deleteVertexArray(vao);
    this.quadVaos.clear();
  }

  /**
   * Disposes of the resources
   */
  dispose(): void {
    const gl = this.gl;

    this.disposePrograms();

    if (this.instanceBuffer) {
      this.ledger?.release(this.instanceBuffer);
      gl.deleteBuffer(this.instanceBuffer);
      this.instanceBuffer = null;
    }
    if (this.quadBuffer) {
      this.ledger?.release(this.quadBuffer);
      gl.deleteBuffer(this.quadBuffer);
      this.quadBuffer = null;
    }
  }
}
