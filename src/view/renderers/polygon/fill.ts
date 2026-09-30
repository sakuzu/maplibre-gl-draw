// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * FillShaderManager
 *
 * A shader manager that manages the fill rendering of polygons
 * Performs the WGS84 to clip space conversion on the GPU (offset mode)
 */

import earcut from 'earcut';
import type { ProjectionData } from 'maplibre-gl';
import type { Coordinate } from '../../../store/types.js';
import type { OffsetUniforms, ShaderData } from '../../shaders/helpers.js';
import {
  calculateLngLatOffset,
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
import { buildEarcutInput } from './earcut-input.js';

/**
 * The fill renderer core uses for polygons, shared with custom feature renderers.
 *
 * Takes `[lng, lat]` rings in degrees, triangulates them (holes included) and converts them
 * to clip space on the GPU relative to the view center, for float precision. Call
 * `ensureShader` with the shader data of the frame and `setOffsetUniforms` before drawing.
 */
export class FillShaderManager {
  private gl: WebGL2RenderingContext;
  private program: WebGLProgram | null = null;
  private variantName = '';

  // Projection uniform management
  private projectionUniformManager: ProjectionUniformManager;

  // Uniform locations (renderer specific)
  private colorLoc: WebGLUniformLocation | null = null;

  // Uniform values for offset mode
  private offsetUniforms: OffsetUniforms | null = null;

  // The VAO and buffers reused for drawing (attributes are set up only once at construction)
  private vao: WebGLVertexArrayObject | null = null;
  private vertexBuffer: WebGLBuffer | null = null;
  private indexBuffer: WebGLBuffer | null = null;

  /**
   * @param terrain The terrain state of the draw instance (an inactive one draws flat)
   */
  constructor(gl: WebGL2RenderingContext, terrain: TerrainContext = new TerrainContext()) {
    this.gl = gl;
    this.projectionUniformManager = new ProjectionUniformManager(gl, {
      surface: true,
    }).useTerrainState(terrain);
    this.vertexBuffer = gl.createBuffer();
    this.indexBuffer = gl.createBuffer();
    this.vao = gl.createVertexArray();
    this.setupVAO();
  }

  /**
   * Sets the vertex attributes and the index buffer on the VAO
   *
   * The ELEMENT_ARRAY_BUFFER binding is part of the VAO state, so it is bundled while
   * the VAO is bound.
   */
  private setupVAO(): void {
    const gl = this.gl;

    gl.bindVertexArray(this.vao);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);

    gl.bindVertexArray(null);
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
      this.colorLoc = this.gl.getUniformLocation(this.program, 'u_color');
    }
  }

  /**
   * Sets the uniforms for offset mode
   * Uses the projectionCenter computed at high precision on the CPU side
   */
  setOffsetUniforms(uniforms: OffsetUniforms): void {
    this.offsetUniforms = uniforms;
  }

  /**
   * Creates the shader program (offset mode)
   */
  private createShaderProgram(prelude: string, define: string): WebGLProgram {
    // u_projection_transition is defined only in the prelude of globe mode
    const projTransitionUniform = getProjectionTransitionUniform(prelude);
    // High precision version: uses relative coordinates computed at 64-bit precision on
    // the CPU side
    const vertexSource = `#version 300 es
${prelude}
${define}
${projTransitionUniform}${OFFSET_MODE_GLSL}${TERRAIN_SHADE_VERTEX_GLSL}
layout(location = 0) in vec2 a_pos;  // relative coords (64-bit precision on the CPU)
void main() {
    // High precision version: uses relative coords computed at 64-bit precision on the CPU
    gl_Position = project_position_to_clipspace_from_offset(a_pos, u_projection_matrix);
    emitShadeOffset(a_pos);
}`;

    // The fill gets the same terrain shading as the ground (factor 1.0 when there is no terrain)
    const fragmentSource = `#version 300 es
precision highp float;
uniform vec4 u_color;
out vec4 fragColor;
${TERRAIN_SHADE_FRAGMENT_GLSL}
void main() {
    fragColor = vec4(u_color.rgb * terrainFillShade(), u_color.a);
}`;

    return createProgram(this.gl, vertexSource, fragmentSource);
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
   * Fill-renders a single-ring polygon
   *
   * Use drawPolygonRings for a polygon that has holes.
   *
   * @param coords The coordinate array (WGS84)
   * @param color The fill color
   * @param projectionData MapLibre's ProjectionData
   * @param zoom The current zoom level
   */
  drawPolygon(
    coords: Coordinate[],
    color: [number, number, number, number],
    projectionData: ProjectionData,
    zoom: number,
  ): void {
    this.drawPolygonRings([coords], color, projectionData, zoom);
  }

  /**
   * Fill-renders a polygon given as an array of rings (supports holes)
   *
   * Sends the WGS84 coordinates to the GPU as they are and converts them in the shader
   *
   * @param rings The array of rings ([0] is the outer ring, [1..] are inner rings, WGS84)
   * @param color The fill color
   * @param projectionData MapLibre's ProjectionData
   * @param zoom The current zoom level
   */
  drawPolygonRings(
    rings: Coordinate[][],
    color: [number, number, number, number],
    projectionData: ProjectionData,
    zoom: number,
  ): void {
    if (!this.program) return;

    const gl = this.gl;

    // Flatten all rings to build the earcut input (inner rings are treated as holes)
    const { flatCoords, holeIndices, rings: openRings } = buildEarcutInput(rings);
    if (openRings.length === 0) return;

    // Triangulate with earcut (run on absolute coordinates)
    const indices = earcut(flatCoords, holeIndices);
    if (indices.length === 0) return;

    // Compute relative coordinates on the CPU side (offset mode: computed at 64-bit precision)
    const centerLngLat: [number, number] = this.offsetUniforms?.centerLngLat ?? [0, 0];

    // Vertices hold only the relative coordinates of each point; the triangle
    // composition is expressed with indices
    const pointCount = flatCoords.length / 2;
    const vertexData = new Float32Array(flatCoords.length);
    for (let i = 0; i < pointCount; i++) {
      // Compute the offset from the center at 64-bit precision
      const offset = calculateLngLatOffset(
        [flatCoords[i * 2], flatCoords[i * 2 + 1]],
        centerLngLat,
      );
      vertexData[i * 2] = offset[0];
      vertexData[i * 2 + 1] = offset[1];
    }

    const indexData = new Uint32Array(indices);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, vertexData, gl.DYNAMIC_DRAW);

    gl.bindVertexArray(this.vao);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indexData, gl.DYNAMIC_DRAW);

    gl.useProgram(this.program);

    // Set the projection uniforms
    this.setProjectionUniforms(projectionData, zoom);

    if (this.colorLoc) {
      gl.uniform4fv(this.colorLoc, color);
    }

    gl.drawElements(gl.TRIANGLES, indexData.length, gl.UNSIGNED_INT, 0);

    gl.bindVertexArray(null);
  }

  /**
   * Releases the resources
   *
   * @internal
   */
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
    if (this.indexBuffer) {
      this.gl.deleteBuffer(this.indexBuffer);
      this.indexBuffer = null;
    }
  }
}
