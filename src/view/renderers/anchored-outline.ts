// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * AnchoredOutlineRenderer
 *
 * Draws a closed outline that is a figure of the screen around an anchor: the anchor (a
 * position and its height) is projected in the shader, the way a marker is (PointShapeRenderer
 * and the billboard of PointInstanceRenderer), and the outline is laid around it in pixels. The
 * outline is therefore seen exactly where the marker is and hidden where it is: the far side of
 * the globe clips the anchor, and nothing of the outline is carried back onto the map, so a
 * pitched view or the edge of the sphere does not bend it.
 *
 * The line is drawn as StrokeRenderer draws it (the HHAA coverage and the dashes), but every
 * vertex is in pixels already, so its normals and miters are made on the CPU.
 */

import type { Map as MapLibreMap, ProjectionData } from 'maplibre-gl';
import { getDashPattern, RENDERING_DEFAULTS } from '../../shared/math/index.js';
import type { StrokeStyle } from '../../shared/types/style.js';
import type { PixelRatioInput } from '../../shared/utils/pixel-ratio.js';
import { resolvePixelRatio } from '../../shared/utils/pixel-ratio.js';
import type { OffsetUniforms, ShaderData } from '../shaders/helpers.js';
import {
  calculateLngLatOffset,
  createProgram,
  getProjectionTransitionUniform,
  OFFSET_MODE_GLSL,
} from '../shaders/helpers.js';
import { ProjectionUniformManager } from '../shaders/projection.js';
import { TerrainContext } from '../terrain/context.js';
import { drawBillboardsWithoutDepth } from './point/billboard-depth.js';

/** A point of the screen relative to the anchor, in CSS px (y points down) */
export interface OutlineOffset {
  x: number;
  y: number;
}

/** Floats per vertex: the offset (x, y in device px), the signed distance across, the distance along */
const FLOATS_PER_VERTEX = 4;
const STRIDE = FLOATS_PER_VERTEX * 4;

/**
 * The vertices of a closed outline as a triangle strip: two per corner (the two sides of the
 * line) and the first corner again at the end
 *
 * Each vertex is the corner moved along the miter of its two edges by half the width plus one
 * pixel (the band the HHAA coverage fades in), the same join as StrokeRenderer: a miter longer
 * than the limit becomes a bevel along the edge that arrives. The distance along the outline is
 * in CSS px, the unit of the dash patterns.
 *
 * @param corners The corners relative to the anchor, in CSS px, in order (not closed)
 * @param widthPx The width of the line in device px
 * @param pixelRatio Device px per CSS px
 * @param miterLimit The longest miter, in half widths
 * @returns The interleaved vertices (x, y, signed distance, distance), empty for fewer than two
 *   distinct corners
 * @internal
 */
export function buildOutlineStrip(
  corners: readonly OutlineOffset[],
  widthPx: number,
  pixelRatio: number,
  miterLimit: number = RENDERING_DEFAULTS.MITER_LIMIT,
): Float32Array {
  // Repeated corners make no edge
  const ring = corners.filter((corner, i) => {
    const next = corners[(i + 1) % corners.length];
    return corners.length === 1 || corner.x !== next.x || corner.y !== next.y;
  });
  const n = ring.length;
  if (n < 2) return new Float32Array(0);

  const expanded = widthPx / 2 + 1;
  const unit = (from: OutlineOffset, to: OutlineOffset) => {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const length = Math.hypot(dx, dy);
    return { x: dx / length, y: dy / length };
  };

  const data = new Float32Array((n + 1) * 2 * FLOATS_PER_VERTEX);
  let along = 0;
  for (let i = 0; i <= n; i++) {
    const corner = ring[i % n];
    if (i > 0) {
      const before = ring[i - 1];
      along += Math.hypot(corner.x - before.x, corner.y - before.y);
    }
    const arriving = unit(ring[(i + n - 1) % n], corner);
    const leaving = unit(corner, ring[(i + 1) % n]);
    const n1 = { x: -arriving.y, y: arriving.x };
    const n2 = { x: -leaving.y, y: leaving.x };
    let normal = n1;
    let scale = 1;
    const sum = { x: n1.x + n2.x, y: n1.y + n2.y };
    const sumLength = Math.hypot(sum.x, sum.y);
    if (sumLength > 0.001) {
      const miter = { x: sum.x / sumLength, y: sum.y / sumLength };
      const cosHalf = miter.x * n1.x + miter.y * n1.y;
      if (cosHalf > 0.001 && 1 / cosHalf <= miterLimit) {
        normal = miter;
        scale = 1 / cosHalf;
      }
    }
    for (const side of [1, -1]) {
      const base = (i * 2 + (side === 1 ? 0 : 1)) * FLOATS_PER_VERTEX;
      data[base] = corner.x * pixelRatio + normal.x * side * expanded * scale;
      data[base + 1] = corner.y * pixelRatio + normal.y * side * expanded * scale;
      data[base + 2] = side * expanded;
      data[base + 3] = along;
    }
  }
  return data;
}

/**
 * Draws closed outlines laid in pixels around an anchor projected like a marker
 *
 * @internal
 */
export class AnchoredOutlineRenderer {
  private readonly gl: WebGL2RenderingContext;
  private program: WebGLProgram | null = null;
  private variantName = '';
  private readonly projectionUniformManager: ProjectionUniformManager;
  private offsetUniforms: OffsetUniforms | null = null;
  /** The injected device pixel ratio (read from window each time when not injected) */
  private readonly pixelRatio: PixelRatioInput | undefined;

  private colorLoc: WebGLUniformLocation | null = null;
  private widthLoc: WebGLUniformLocation | null = null;
  private pixelToClipLoc: WebGLUniformLocation | null = null;
  private anchorOffsetLoc: WebGLUniformLocation | null = null;
  private anchorElevationLoc: WebGLUniformLocation | null = null;
  private dashArrayLoc: WebGLUniformLocation | null = null;
  private dashEnabledLoc: WebGLUniformLocation | null = null;

  private vao: WebGLVertexArrayObject | null;
  private vertexBuffer: WebGLBuffer | null;

  constructor(
    _map: MapLibreMap,
    gl: WebGL2RenderingContext,
    pixelRatio?: PixelRatioInput,
    terrain: TerrainContext = new TerrainContext(),
  ) {
    this.gl = gl;
    this.pixelRatio = pixelRatio;
    // An outline around an anchor is a symbol: it keeps the height of its anchor on the frames
    // that lay the surfaces flat, as the marker does
    this.projectionUniformManager = new ProjectionUniformManager(gl).useTerrainState(terrain);
    this.vertexBuffer = gl.createBuffer();
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, STRIDE, 0); // a_offset
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 1, gl.FLOAT, false, STRIDE, 8); // a_side_dist
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 1, gl.FLOAT, false, STRIDE, 12); // a_distance
    gl.bindVertexArray(null);
  }

  /** Makes sure the shader of the projection variant exists */
  ensureShader(shaderData: ShaderData): void {
    if (this.variantName === shaderData.variantName) return;
    if (this.program) this.gl.deleteProgram(this.program);
    this.program = this.createShaderProgram(shaderData.vertexShaderPrelude, shaderData.define);
    this.variantName = shaderData.variantName;
    this.projectionUniformManager.getLocations(this.program);
    const gl = this.gl;
    this.colorLoc = gl.getUniformLocation(this.program, 'u_color');
    this.widthLoc = gl.getUniformLocation(this.program, 'u_width');
    this.pixelToClipLoc = gl.getUniformLocation(this.program, 'u_pixel_to_clip');
    this.anchorOffsetLoc = gl.getUniformLocation(this.program, 'u_anchor_offset');
    this.anchorElevationLoc = gl.getUniformLocation(this.program, 'u_anchor_elevation_m');
    this.dashArrayLoc = gl.getUniformLocation(this.program, 'u_dashArray');
    this.dashEnabledLoc = gl.getUniformLocation(this.program, 'u_dashEnabled');
  }

  /** Sets the uniforms of the offset mode (the camera of the copy of the world being drawn) */
  setOffsetUniforms(uniforms: OffsetUniforms): void {
    this.offsetUniforms = uniforms;
  }

  private createShaderProgram(prelude: string, define: string): WebGLProgram {
    const projTransitionUniform = getProjectionTransitionUniform(prelude);
    const vertexSource = `#version 300 es
${prelude}
${define}
${projTransitionUniform}${OFFSET_MODE_GLSL}
layout(location = 0) in vec2 a_offset;     // the vertex around the anchor (device px, y down)
layout(location = 1) in float a_side_dist; // the signed distance across the line (device px)
layout(location = 2) in float a_distance;  // the distance along the outline (CSS px)

uniform vec2 u_anchor_offset;       // the anchor relative to the center (64-bit on the CPU)
uniform float u_anchor_elevation_m; // the height of the anchor, from the CPU as for a marker
uniform vec2 u_pixel_to_clip;       // device px to clip space
uniform float u_width;              // the width of the line (device px)

out float v_dist;
out float v_width;
out float v_distance;

void main() {
    // The height comes from the CPU, the source hit testing and the marker use
    g_anchor_elevation_m = u_anchor_elevation_m;
    g_anchor_elevation_on = 1.0;
    vec4 centerClip = project_position_to_clipspace_from_offset(u_anchor_offset, u_projection_matrix);
    // The depth of the anchor for every vertex: the far side of the globe clips the outline
    // with its anchor, as it clips a marker
    gl_Position = vec4(
        centerClip.xy / centerClip.w + vec2(a_offset.x, -a_offset.y) * u_pixel_to_clip,
        centerClip.z / centerClip.w,
        1.0
    );
    v_dist = a_side_dist;
    v_width = u_width / 2.0;
    v_distance = a_distance;
}`;

    const fragmentSource = `#version 300 es
precision highp float;

uniform vec4 u_color;
uniform vec4 u_dashArray; // [dashLength, gapLength, patternLength, 0]
uniform float u_dashEnabled;

in float v_dist;
in float v_width;
in float v_distance;

out vec4 fragColor;

// HHAA: the part of the pixel on the inner side of a half plane
float pixelLine(float x) {
    return clamp(x + 0.5, 0.0, 1.0);
}

void main() {
    if (u_dashEnabled > 0.5) {
        float patternLength = u_dashArray.z;
        if (patternLength > 0.0 && mod(v_distance, patternLength) > u_dashArray.x) discard;
    }
    float coverage = pixelLine(v_dist + v_width) - pixelLine(v_dist - v_width);
    // Blending is non-premultiplied, so the coverage goes to the alpha only
    fragColor = vec4(u_color.rgb, u_color.a * coverage);
}`;

    return createProgram(this.gl, vertexSource, fragmentSource);
  }

  /**
   * Draws a closed outline around an anchor
   *
   * @param anchor The position the outline is laid around, `[lng, lat]`
   * @param elevationMeters The height of the anchor (the height its marker is drawn at)
   * @param corners The corners relative to the anchor's point on the screen, in CSS px
   * @param style The line (its width is in CSS px)
   * @param opacity A factor on the opacity of the line (the terrain's ghost of the marker)
   * @param zoom The zoom of the frame
   * @param projectionData The projection of the copy of the world being drawn
   */
  draw(
    anchor: readonly [number, number],
    elevationMeters: number,
    corners: readonly OutlineOffset[],
    style: StrokeStyle,
    opacity: number,
    zoom: number,
    projectionData: ProjectionData,
  ): void {
    if (!this.program) return;
    const gl = this.gl;
    const pixelRatio = resolvePixelRatio(this.pixelRatio);
    const widthPx = style.width * pixelRatio;
    const data = buildOutlineStrip(corners, widthPx, pixelRatio);
    if (data.length === 0) return;

    gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
    gl.bindVertexArray(this.vao);
    gl.useProgram(this.program);
    this.projectionUniformManager.setUniforms(projectionData, zoom, this.offsetUniforms);

    const center: [number, number] = this.offsetUniforms?.centerLngLat ?? [0, 0];
    const offset = calculateLngLatOffset([anchor[0], anchor[1]], center);
    if (this.anchorOffsetLoc) gl.uniform2f(this.anchorOffsetLoc, offset[0], offset[1]);
    if (this.anchorElevationLoc) gl.uniform1f(this.anchorElevationLoc, elevationMeters);
    if (this.pixelToClipLoc) {
      gl.uniform2f(this.pixelToClipLoc, 2 / gl.drawingBufferWidth, 2 / gl.drawingBufferHeight);
    }
    if (this.widthLoc) gl.uniform1f(this.widthLoc, widthPx);
    if (this.colorLoc) {
      gl.uniform4fv(this.colorLoc, [
        style.color[0],
        style.color[1],
        style.color[2],
        style.color[3] * style.opacity * opacity,
      ]);
    }

    const dashPattern = style.dashArray ?? getDashPattern(style.lineStyle);
    const dashed = style.lineStyle !== 'solid' && dashPattern.length >= 2;
    if (this.dashEnabledLoc) gl.uniform1f(this.dashEnabledLoc, dashed ? 1 : 0);
    if (dashed && this.dashArrayLoc) {
      const [dash, gap] = dashPattern;
      gl.uniform4fv(this.dashArrayLoc, [dash, gap, dash + gap, 0]);
    }

    drawBillboardsWithoutDepth(gl, () => {
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, data.length / FLOATS_PER_VERTEX);
    });
    gl.bindVertexArray(null);
  }

  /** Releases the GPU resources */
  dispose(): void {
    if (this.program) {
      this.gl.deleteProgram(this.program);
      this.program = null;
    }
    if (this.vao) {
      this.gl.deleteVertexArray(this.vao);
      this.vao = null;
    }
    if (this.vertexBuffer) {
      this.gl.deleteBuffer(this.vertexBuffer);
      this.vertexBuffer = null;
    }
  }
}
