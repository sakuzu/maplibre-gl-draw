// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The frames of the features selected in bulk, one per row, drawn on the GPU
 *
 * Features selected one by one get a frame each from the selection UI, made on the CPU from each
 * feature. Many features selected at once get the same frames drawn from the extents of their
 * rows, in one draw per row group: every row of the group is an instance, and the vertex shader
 * reads the state of its row (the texture the rows are drawn with) and draws a frame only for a
 * row marked as selected in bulk. A row being dragged is moved by its moving set as it is drawn
 * (`rowStateMove`), so its frame follows it.
 *
 * A frame is the extent of the row, moved as the row is, widened by the margin of the selection UI
 * on the ground as the frame of a feature is (`applyMarginToBoundingBox`, with the scale of the
 * frame of the map: `screen-scale.ts`), and outlined by the line of the stroke of the selection UI
 * as StrokeRenderer draws it; a row of one position gets
 * the square of the extent of its marker plus the margin, on the screen, as a point does (while
 * the rows are turned from the rotation handle, the box of the margin alone, as the selection UI
 * turns the box of no extent of a point).
 */

import { pageRowBounds, type RowGroup } from '@sakuzu/kasane/render';
import type { ProjectionData } from 'maplibre-gl';
import type { SelectionUIConfig } from '../../shared/config/selection.js';
import { RENDERING_DEFAULTS } from '../../shared/math/constants.js';
import {
  type ScreenScaleFrame,
  type ScreenScaleUniforms,
  screenScaleUniformsOf,
} from '../../shared/math/screen-scale.js';
import type { PixelRatioInput } from '../../shared/utils/pixel-ratio.js';
import { resolvePixelRatio } from '../../shared/utils/pixel-ratio.js';
import type { GpuLedger } from '../gpu-ledger.js';
import { RetainedDrawRun } from '../renderers/draw-run.js';
import {
  bindRowState,
  ROW_HIDDEN_POSITION_GLSL,
  type RowStateBinding,
  RowStateUniforms,
  TABLE_ROWS_GLSL,
} from '../renderers/row-state.js';
import {
  createProgram,
  getProjectionTransitionUniform,
  OFFSET_MODE_GLSL,
  type OffsetUniforms,
  type ShaderData,
} from '../shaders/helpers.js';
import { ProjectionUniformManager } from '../shaders/projection.js';

/** The floats of the instance of a row: its extent from the origin, its number, its marker */
const FLOATS_PER_ROW = 8;
const STRIDE = FLOATS_PER_ROW * 4;
/** The vertices of a frame: four sides of two triangles */
const VERTICES_PER_FRAME = 24;

/**
 * The half width and half height in CSS px of the frame of a row of one position, around it, or
 * null for the default square
 *
 * @internal
 */
export type PointFrameExtent = (group: RowGroup, row: number) => readonly [number, number] | null;

/** The default half size of the frame of a row of one position (a 12 px square) */
const DEFAULT_POINT_HALF = 6;

/** The instances of the rows of a group */
interface GroupFrames {
  readonly data: RowGroup['data'];
  readonly revision: number | string;
  readonly buffer: WebGLBuffer;
  readonly vao: WebGLVertexArrayObject;
  readonly origin: [number, number];
  readonly rows: number;
}

/**
 * Draws the frames of the rows marked as selected in bulk
 *
 * @internal
 */
export class BulkFramesRenderer {
  private program: WebGLProgram | null = null;
  private variantName = '';
  private readonly projection: ProjectionUniformManager;
  private rowState: RowStateUniforms | null = null;
  private readonly run: RetainedDrawRun;
  private offsetUniforms: OffsetUniforms | null = null;
  private locations: Record<string, WebGLUniformLocation | null> = {};
  private readonly frames = new Map<number, GroupFrames>();
  private readonly originShift: [number, number] = [0, 0];
  private shaderData: ShaderData | null = null;
  private rotating = false;
  private scale: ScreenScaleUniforms | null = null;

  constructor(
    private readonly gl: WebGL2RenderingContext,
    private readonly ledger: GpuLedger,
    private readonly pixelRatio?: PixelRatioInput,
  ) {
    this.projection = new ProjectionUniformManager(gl, { surface: true });
    this.run = new RetainedDrawRun(gl);
  }

  /**
   * Takes the projection variant of the frame: its program is made when frames are first drawn
   * with it (a map without features selected in bulk makes none)
   */
  ensureShader(shaderData: ShaderData): void {
    this.shaderData = shaderData;
  }

  /**
   * Makes the program of the projection variant taken last, once
   *
   * @returns Whether it can draw frames (false before the first `ensureShader`)
   */
  ensureProgram(): boolean {
    const shaderData = this.shaderData;
    if (!shaderData) return false;
    if (this.variantName === shaderData.variantName && this.program) return true;
    const gl = this.gl;
    if (this.program) gl.deleteProgram(this.program);
    this.program = createProgram(
      gl,
      buildBulkFramesVertexSource(shaderData.vertexShaderPrelude, shaderData.define),
      BULK_FRAMES_FRAGMENT_SOURCE,
    );
    this.variantName = shaderData.variantName;
    this.projection.getLocations(this.program);
    this.rowState = new RowStateUniforms(gl, this.program);
    const names = [
      'u_viewport',
      'u_margin',
      'u_half_width',
      'u_color',
      'u_pixels_per_meter_at_equator',
      'u_center_secant',
      'u_scale_transition',
      'u_degrees_per_meter_north',
      'u_ratio',
      'u_origin_latitude',
      'u_rotating',
    ];
    this.locations = Object.fromEntries(
      names.map((name) => [name, gl.getUniformLocation(this.program as WebGLProgram, name)]),
    );
    return true;
  }

  /** Sets the uniforms of the offset mode (the camera of the copy of the world being drawn) */
  setOffsetUniforms(uniforms: OffsetUniforms): void {
    this.offsetUniforms = uniforms;
  }

  /**
   * Sets whether the features selected in bulk are being turned from the rotation handle: the
   * selection UI then frames a feature of one position by the margin alone, as a box of no
   * extent turned with the others (not by its marker)
   */
  setRotating(rotating: boolean): void {
    this.rotating = rotating;
  }

  /**
   * Sets the scale of the frame of the map being drawn: the margin is laid on the ground with it,
   * as the selection UI lays it
   */
  setScreenScale(frame: ScreenScaleFrame): void {
    this.scale = screenScaleUniformsOf(frame);
  }

  /**
   * Draws the frames of the rows of a group marked as selected in bulk
   *
   * @param revision Changes with every change of the extents of the rows (their instances are
   *   made again): of the rows, or of the pictures the points are drawn with
   * @param pointExtent The extent of the marker of a row of one position
   */
  drawGroup(
    group: RowGroup,
    binding: RowStateBinding,
    revision: number | string,
    projectionData: ProjectionData,
    config: SelectionUIConfig,
    pointExtent: PointFrameExtent,
  ): void {
    if (!this.ensureProgram()) return;
    const program = this.program;
    const scale = this.scale;
    if (!program || !this.rowState || !scale) return;
    const frames = this.framesOf(group, revision, pointExtent);
    if (!frames || frames.rows === 0) return;
    const gl = this.gl;
    gl.useProgram(program);
    const camera = this.offsetUniforms;
    this.originShift[0] = camera ? frames.origin[0] - camera.centerLngLat[0] : 0;
    this.originShift[1] = camera ? frames.origin[1] - camera.centerLngLat[1] : 0;
    this.projection.setUniforms(projectionData, camera, this.originShift);
    bindRowState(
      this.run,
      this.rowState,
      binding,
      frames.origin,
      camera ? camera.centerLngLat : frames.origin,
    );
    const ratio = resolvePixelRatio(this.pixelRatio);
    const stroke = config.box.stroke;
    const loc = this.locations;
    if (loc.u_viewport) gl.uniform2f(loc.u_viewport, gl.drawingBufferWidth, gl.drawingBufferHeight);
    if (loc.u_margin) gl.uniform1f(loc.u_margin, config.box.margin);
    if (loc.u_half_width) gl.uniform1f(loc.u_half_width, (stroke.width * ratio) / 2);
    if (loc.u_ratio) gl.uniform1f(loc.u_ratio, ratio);
    if (loc.u_color) {
      const [r, g, b, a] = stroke.color;
      gl.uniform4f(loc.u_color, r, g, b, a * stroke.opacity);
    }
    if (loc.u_pixels_per_meter_at_equator) {
      gl.uniform1f(loc.u_pixels_per_meter_at_equator, scale.pixelsPerMeterAtEquator);
    }
    if (loc.u_center_secant) gl.uniform1f(loc.u_center_secant, scale.centerSecant);
    if (loc.u_scale_transition) gl.uniform1f(loc.u_scale_transition, scale.transition);
    if (loc.u_degrees_per_meter_north) {
      gl.uniform1f(loc.u_degrees_per_meter_north, scale.degreesPerMeterNorth);
    }
    if (loc.u_origin_latitude) gl.uniform1f(loc.u_origin_latitude, frames.origin[1]);
    if (loc.u_rotating) gl.uniform1f(loc.u_rotating, this.rotating ? 1 : 0);
    gl.bindVertexArray(frames.vao);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, VERTICES_PER_FRAME, frames.rows);
    gl.bindVertexArray(null);
  }

  /** The instances of the rows of a group (made again with new rows or new extents) */
  private framesOf(
    group: RowGroup,
    revision: number | string,
    pointExtent: PointFrameExtent,
  ): GroupFrames | null {
    const known = this.frames.get(group.handle);
    if (known && known.data === group.data && known.revision === revision) return known;
    if (known) this.release(known);
    const gl = this.gl;
    const data = group.data;
    const bounds = pageRowBounds(data);
    const n = data.length;
    // The origin of the group: the extent of its first row with one
    let origin: [number, number] = [0, 0];
    for (let row = 0; row < n; row++) {
      if (!Number.isNaN(bounds[row * 4])) {
        origin = [bounds[row * 4], bounds[row * 4 + 1]];
        break;
      }
    }
    const values = new Float32Array(n * FLOATS_PER_ROW);
    for (let row = 0; row < n; row++) {
      const at = row * FLOATS_PER_ROW;
      const b = row * 4;
      if (Number.isNaN(bounds[b])) {
        // No geometry: drawn nowhere (an extent of nothing)
        values[at + 4] = -1;
        continue;
      }
      values[at] = bounds[b] - origin[0];
      values[at + 1] = bounds[b + 1] - origin[1];
      values[at + 2] = bounds[b + 2] - origin[0];
      values[at + 3] = bounds[b + 3] - origin[1];
      values[at + 4] = row;
      if (bounds[b] === bounds[b + 2] && bounds[b + 1] === bounds[b + 3]) {
        const extent = pointExtent(group, row);
        values[at + 5] = extent?.[0] ?? DEFAULT_POINT_HALF;
        values[at + 6] = extent?.[1] ?? DEFAULT_POINT_HALF;
      }
    }
    const buffer = gl.createBuffer() as WebGLBuffer;
    const vao = gl.createVertexArray() as WebGLVertexArrayObject;
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, values, gl.STATIC_DRAW);
    this.ledger.record(buffer, 'bulk-frames', 'buffer', values.byteLength);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 4, gl.FLOAT, false, STRIDE, 0);
    gl.vertexAttribDivisor(0, 1);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, STRIDE, 16);
    gl.vertexAttribDivisor(1, 1);
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    const frames: GroupFrames = { data, revision, buffer, vao, origin, rows: n };
    this.frames.set(group.handle, frames);
    return frames;
  }

  /**
   * Lets go of the instances of the groups not in `kept` (the groups no longer drawn, or no
   * longer holding a row selected in bulk)
   */
  retain(kept: ReadonlySet<number>): void {
    for (const [handle, frames] of this.frames) {
      if (kept.has(handle)) continue;
      this.release(frames);
      this.frames.delete(handle);
    }
  }

  private release(frames: GroupFrames): void {
    this.ledger.release(frames.buffer);
    this.gl.deleteBuffer(frames.buffer);
    this.gl.deleteVertexArray(frames.vao);
  }

  dispose(): void {
    this.retain(new Set());
    if (this.program) this.gl.deleteProgram(this.program);
    this.program = null;
    this.variantName = '';
  }
}

/**
 * The vertex shader of the frames (the variant of the rows: it reads the state of the rows)
 *
 * A frame is drawn as the selection UI draws the frame of a feature: the extent of the row, moved
 * as the row is, widened by the margin on the ground (`applyMarginToBoundingBox`, after the move,
 * so a resize does not scale the margin), and outlined by the line of StrokeRenderer (the
 * miters at the corners and the band of one pixel the coverage fades in). A row of one position
 * gets the square of its marker and the margin on the screen, as AnchoredOutlineRenderer draws
 * the frame of a point; while the rows are turned from the rotation handle it is a box of no
 * extent, widened by the margin as the others are (the selection UI turns the initial box of
 * every feature, and the box of a point has no extent).
 *
 * @internal
 */
export function buildBulkFramesVertexSource(prelude: string, define: string): string {
  return `#version 300 es
#define TABLE_ROWS
${prelude}
${define}
${getProjectionTransitionUniform(prelude)}${OFFSET_MODE_GLSL}${TABLE_ROWS_GLSL}

// The extent of the row from the origin of its group: west, south, east, north
layout(location = 0) in vec4 a_bounds;
// x: the number of the row (-1: none), y and z: the half size of the marker of a row of one
// position (CSS px; 0 for a row with an extent)
layout(location = 1) in vec4 a_meta;

uniform vec2 u_viewport;
// The margin of the frame (CSS px), the half width of its lines (device px), device px per CSS px
uniform float u_margin;
uniform float u_half_width;
uniform float u_ratio;
// The scale of the frame of the map (screenScaleUniformsOf): the CSS px of a meter at the equator
// on Web Mercator, the secant of the latitude of the center of the view, the transition to the
// globe, and the degrees of latitude of a meter north
uniform float u_pixels_per_meter_at_equator;
uniform float u_center_secant;
uniform float u_scale_transition;
uniform float u_degrees_per_meter_north;
// The latitude of the origin of the group (the offsets are taken from it)
uniform float u_origin_latitude;
// 1 while the rows are turned from the rotation handle
uniform float u_rotating;

out float v_dist;
out float v_width;
out float v_point;

vec2 toScreen(vec4 clip) {
    return (clip.xy / clip.w * 0.5 + 0.5) * u_viewport;
}

// The degrees of longitude and of latitude of a CSS px east and north at a latitude, on the plane
// tangent to the sphere there: the scale of the frame (metersPerPixelInFrame)
vec2 degreesPerPixelAt(float latitude) {
    float secant = 1.0 / max(cos(radians(latitude)), 1e-6);
    float pixelsPerMeter = u_pixels_per_meter_at_equator * mix(secant, u_center_secant, u_scale_transition);
    float north = u_degrees_per_meter_north / pixelsPerMeter;
    return vec2(north * secant, north);
}

// The direction of the miter at a corner of the outline, scaled by its length in half widths, as
// StrokeRenderer joins two sides: the mean of their normals, a bevel past the miter limit
vec2 miterAt(vec2 previous, vec2 corner, vec2 next) {
    vec2 in1 = corner - previous;
    vec2 in2 = next - corner;
    float l1 = length(in1);
    float l2 = length(in2);
    vec2 dir1 = l1 > 0.0 ? in1 / l1 : (l2 > 0.0 ? in2 / l2 : vec2(1.0, 0.0));
    vec2 dir2 = l2 > 0.0 ? in2 / l2 : dir1;
    vec2 normal1 = vec2(-dir1.y, dir1.x);
    vec2 normal2 = vec2(-dir2.y, dir2.x);
    vec2 sum = normal1 + normal2;
    float sumLength = length(sum);
    if (sumLength <= 0.001) return normal1;
    vec2 normal = sum / sumLength;
    float cosHalf = dot(normal, normal1);
    if (cosHalf <= 0.001) return normal;
    float scale = 1.0 / cosHalf;
    return scale > ${RENDERING_DEFAULTS.MITER_LIMIT.toFixed(1)} ? normal1 : normal * scale;
}

void main() {
    uint state = a_meta.x < 0.0 ? 1u : readRowState(a_meta.x);
    v_width = u_half_width;
    bool marker = a_meta.y > 0.0 && u_rotating < 0.5;
    v_point = marker ? 1.0 : 0.0;
    v_dist = 0.0;
    if ((state & 8u) == 0u || rowStateHidden(state)) {
        gl_Position = ${ROW_HIDDEN_POSITION_GLSL};
        return;
    }
    // The corners on the screen (y up): top left, top right, bottom right, bottom left
    vec2 corners[4];
    if (marker) {
        // A row of one position: the square of its marker and the margin, on the screen
        vec4 clip = project_position_to_clipspace_from_offset(rowStateMove(state, a_bounds.xy), u_projection_matrix);
        if (clip.w <= 0.0) {
            gl_Position = ${ROW_HIDDEN_POSITION_GLSL};
            return;
        }
        vec2 center = toScreen(clip);
        vec2 halfSize = (a_meta.yz + u_margin) * u_ratio;
        corners[0] = center + vec2(-halfSize.x, halfSize.y);
        corners[1] = center + vec2(halfSize.x, halfSize.y);
        corners[2] = center + vec2(halfSize.x, -halfSize.y);
        corners[3] = center + vec2(-halfSize.x, -halfSize.y);
    } else {
        // The extent moved as the row is
        vec2 moved[4] = vec2[4](
            rowStateMove(state, a_bounds.xw),
            rowStateMove(state, a_bounds.zw),
            rowStateMove(state, a_bounds.zy),
            rowStateMove(state, a_bounds.xy)
        );
        // Widened by the margin on the ground, as applyMarginToBoundingBox widens it: in CSS px of
        // the scale at the latitude of its center on the tangent plane there (y down), every side
        // moved out along the sides (taken from the center when the row is moved by a motion: its
        // latitude is close enough for the size of a pixel)
        float baseLatitude = g_offset_from_center > 0.5 ? u_origin_latitude - u_origin_shift.y : u_origin_latitude;
        float latitude = (moved[0].y + moved[1].y + moved[2].y + moved[3].y) * 0.25 + baseLatitude;
        vec2 perPixel = degreesPerPixelAt(latitude);
        vec2 degPerPx = vec2(perPixel.x, -perPixel.y);
        vec2 q[4] = vec2[4](moved[0] / degPerPx, moved[1] / degPerPx, moved[2] / degPerPx, moved[3] / degPerPx);
        vec2 right = q[1] - q[0];
        if (length(right) == 0.0) right = q[2] - q[3];
        vec2 down = q[3] - q[0];
        if (length(down) == 0.0) down = q[2] - q[1];
        bool hasRight = length(right) > 0.0;
        bool hasDown = length(down) > 0.0;
        right = hasRight ? normalize(right) : vec2(1.0, 0.0);
        down = hasDown ? normalize(down) : vec2(0.0, 1.0);
        if (!hasRight && hasDown) right = vec2(down.y, -down.x);
        if (hasRight && !hasDown) down = vec2(-right.y, right.x);
        q[0] += (-right - down) * u_margin;
        q[1] += (right - down) * u_margin;
        q[2] += (right + down) * u_margin;
        q[3] += (-right + down) * u_margin;
        for (int i = 0; i < 4; i++) {
            vec4 clip = project_position_to_clipspace_from_offset(q[i] * degPerPx, u_projection_matrix);
            if (clip.w <= 0.0) {
                gl_Position = ${ROW_HIDDEN_POSITION_GLSL};
                return;
            }
            corners[i] = toScreen(clip);
        }
    }
    // A side of the frame: the quad of the line between two corners, each moved along its miter by
    // half the width and one pixel to either side (the band the coverage fades in)
    int side = gl_VertexID / 6;
    int vertex = gl_VertexID % 6;
    bool atEnd = vertex == 1 || vertex == 4 || vertex == 5;
    float across = (vertex == 2 || vertex == 3 || vertex == 5) ? -1.0 : 1.0;
    int k = atEnd ? (side + 1) % 4 : side;
    float reach = u_half_width + 1.0;
    vec2 position = corners[k] + miterAt(corners[(k + 3) % 4], corners[k], corners[(k + 1) % 4]) * across * reach;
    gl_Position = vec4(position / u_viewport * 2.0 - 1.0, 0.0, 1.0);
    v_dist = across * reach;
}`;
}

/**
 * The fragment shader of the frames: the coverage of the line as StrokeRenderer computes it
 * (HHAA), given to the color as the selection UI gives it (StrokeRenderer to the whole color for
 * a frame with an extent, AnchoredOutlineRenderer to the alpha for the frame of a point)
 */
const BULK_FRAMES_FRAGMENT_SOURCE = `#version 300 es
precision highp float;
uniform vec4 u_color;
in float v_dist;
in float v_width;
in float v_point;
out vec4 fragColor;

float pixelLine(float x) {
    return clamp(x + 0.5, 0.0, 1.0);
}

void main() {
    float coverage = pixelLine(v_dist + v_width) - pixelLine(v_dist - v_width);
    // Not premultiplied: the coverage goes to the alpha only (blend.ts)
    fragColor = vec4(u_color.rgb, u_color.a * coverage);
}`;
