// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The frames of the features selected in bulk, one per row, drawn on the GPU (11.6 of the design)
 *
 * Features selected one by one get a frame each from the selection UI, made on the CPU from each
 * feature. Many features selected at once get the same frames drawn from the extents of their
 * rows, in one draw per row group: every row of the group is an instance, and the vertex shader
 * reads the state of its row (the texture the rows are drawn with) and draws a frame only for a
 * row marked as selected in bulk. A row being dragged is moved by its moving set as it is drawn
 * (`rowStateMove`), so its frame follows it.
 *
 * A frame is the extent of the row widened by the margin of the selection UI on the plane of the
 * map, as the frame of a feature is (`marginOnMapPlane`), outlined by lines of the width of the
 * stroke of the selection UI; a row of one position gets the square of the extent of its marker
 * plus the margin, on the screen, as a point does.
 */

import type { ProjectionData } from 'maplibre-gl';
import type { RowGroup } from '../../feature-table/layer-table.js';
import type { SelectionUIConfig } from '../../shared/config/selection.js';
import { DEFAULT_TILE_SIZE } from '../../shared/math/constants.js';
import type { PixelRatioInput } from '../../shared/utils/pixel-ratio.js';
import { resolvePixelRatio } from '../../shared/utils/pixel-ratio.js';
import type { GpuLedger } from '../gpu-ledger.js';
import { RetainedDrawRun } from '../renderers/draw-run.js';
import {
  bindRowState,
  ROW_HIDDEN_POSITION_GLSL,
  ROW_STATE_GLSL,
  type RowStateBinding,
  RowStateUniforms,
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
  readonly revision: number;
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

  constructor(
    private readonly gl: WebGL2RenderingContext,
    private readonly pixelRatio?: PixelRatioInput,
    private readonly ledger?: GpuLedger,
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
    const names = ['u_viewport', 'u_margin', 'u_half_width', 'u_color', 'u_deg_per_px', 'u_ratio'];
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
   * Draws the frames of the rows of a group marked as selected in bulk
   *
   * @param revision Changes with every change of the extents of the rows (their instances are
   *   made again)
   * @param pointExtent The extent of the marker of a row of one position
   */
  drawGroup(
    group: RowGroup,
    binding: RowStateBinding,
    revision: number,
    projectionData: ProjectionData,
    zoom: number,
    config: SelectionUIConfig,
    pointExtent: PointFrameExtent,
  ): void {
    if (!this.ensureProgram()) return;
    const program = this.program;
    if (!program || !this.rowState) return;
    const frames = this.framesOf(group, revision, pointExtent);
    if (!frames || frames.rows === 0) return;
    const gl = this.gl;
    gl.useProgram(program);
    const camera = this.offsetUniforms;
    this.originShift[0] = camera ? frames.origin[0] - camera.centerLngLat[0] : 0;
    this.originShift[1] = camera ? frames.origin[1] - camera.centerLngLat[1] : 0;
    this.projection.setUniforms(projectionData, zoom, camera, this.originShift);
    bindRowState(this.run, this.rowState, binding, camera ? camera.centerLngLat : frames.origin);
    const ratio = resolvePixelRatio(this.pixelRatio);
    const stroke = config.boundingBox.stroke;
    const loc = this.locations;
    if (loc.u_viewport) gl.uniform2f(loc.u_viewport, gl.drawingBufferWidth, gl.drawingBufferHeight);
    if (loc.u_margin) gl.uniform1f(loc.u_margin, config.boundingBox.margin);
    if (loc.u_half_width) gl.uniform1f(loc.u_half_width, (stroke.width * ratio) / 2);
    if (loc.u_ratio) gl.uniform1f(loc.u_ratio, ratio);
    if (loc.u_color) {
      const [r, g, b, a] = stroke.color;
      gl.uniform4f(loc.u_color, r, g, b, a * stroke.opacity);
    }
    if (loc.u_deg_per_px) gl.uniform1f(loc.u_deg_per_px, 360 / (DEFAULT_TILE_SIZE * 2 ** zoom));
    gl.bindVertexArray(frames.vao);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, VERTICES_PER_FRAME, frames.rows);
    gl.bindVertexArray(null);
  }

  /** The instances of the rows of a group (made again with new rows or new extents) */
  private framesOf(
    group: RowGroup,
    revision: number,
    pointExtent: PointFrameExtent,
  ): GroupFrames | null {
    const known = this.frames.get(group.handle);
    if (known && known.data === group.data && known.revision === revision) return known;
    if (known) this.release(known);
    const gl = this.gl;
    const data = group.data;
    const bounds = data.rowBounds;
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
    this.ledger?.record(buffer, 'bulk-frames', 'buffer', values.byteLength);
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
    this.ledger?.release(frames.buffer);
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
 * @internal
 */
export function buildBulkFramesVertexSource(prelude: string, define: string): string {
  return `#version 300 es
#define TABLE_ROWS
${prelude}
${define}
${getProjectionTransitionUniform(prelude)}${OFFSET_MODE_GLSL}${ROW_STATE_GLSL}

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
// Degrees of longitude per CSS px at the zoom of the frame
uniform float u_deg_per_px;

vec2 toScreen(vec4 clip) {
    return (clip.xy / clip.w * 0.5 + 0.5) * u_viewport;
}

void main() {
    uint state = a_meta.x < 0.0 ? 1u : readRowState(a_meta.x);
    if ((state & 8u) == 0u || rowStateHidden(state)) {
        gl_Position = ${ROW_HIDDEN_POSITION_GLSL};
        return;
    }
    vec2 corners[4];
    if (a_meta.y > 0.0) {
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
        // The extent widened by the margin on the plane of the map, then moved as the row is
        float latitude = (a_bounds.y + a_bounds.w) * 0.5 + u_origin_shift.y + u_center_lnglat.y;
        vec2 margin = u_margin * u_deg_per_px * vec2(1.0, cos(radians(latitude)));
        vec4 b = a_bounds + vec4(-margin, margin);
        vec2 offsets[4] = vec2[4](b.xw, b.zw, b.zy, b.xy);
        for (int i = 0; i < 4; i++) {
            vec4 clip = project_position_to_clipspace_from_offset(rowStateMove(state, offsets[i]), u_projection_matrix);
            if (clip.w <= 0.0) {
                gl_Position = ${ROW_HIDDEN_POSITION_GLSL};
                return;
            }
            corners[i] = toScreen(clip);
        }
    }
    // A side of the frame: a quad along it, as wide as the stroke, reaching past its ends by
    // half the width (so the corners are closed)
    int side = gl_VertexID / 6;
    int vertex = gl_VertexID % 6;
    vec2 from = corners[side];
    vec2 to = corners[(side + 1) % 4];
    vec2 along = to - from;
    float len = length(along);
    vec2 dir = len > 0.0 ? along / len : vec2(1.0, 0.0);
    vec2 normal = vec2(-dir.y, dir.x);
    bool atEnd = vertex == 1 || vertex == 4 || vertex == 5;
    bool outer = vertex == 2 || vertex == 3 || vertex == 5;
    vec2 base = atEnd ? to + dir * u_half_width : from - dir * u_half_width;
    vec2 position = base + normal * (outer ? u_half_width : -u_half_width);
    gl_Position = vec4(position / u_viewport * 2.0 - 1.0, 0.0, 1.0);
}`;
}

/** The fragment shader of the frames: the color of the stroke of the selection UI */
const BULK_FRAMES_FRAGMENT_SOURCE = `#version 300 es
precision highp float;
uniform vec4 u_color;
out vec4 fragColor;
void main() {
    fragColor = u_color;
}`;
