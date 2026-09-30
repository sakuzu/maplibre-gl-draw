// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * QuadShader
 *
 * A shader for drawing a textured quad (a quadrilateral).
 * Uses MapLibre's projectTile to support pitch/roll/globe.
 * Avoids coordinate precision problems with offset mode.
 *
 * On frames where terrain (3D) is enabled, a billboard with only four corners
 * lets the terrain poke through from the inside, so the drawing is split into
 * three ways.
 *
 * 1. Analytic drape (the preferred one). `terrain/drape/quad.ts` paints it as
 *    pixels of the ground surface. Burying and clipping cannot occur by
 *    construction, and behind a ridge it is hidden by the depth of the terrain
 *    mesh
 * 2. Subdivision (degraded). On frames where the resources for the analytic
 *    drape cannot be prepared, the quad is split to the fineness of the
 *    terrain mesh grid and an elevation is given per vertex
 * 3. Four corner vertices (no terrain). This path is exactly identical to
 *    before on a flat map. On the globe the same grid as 2 is cut along the
 *    Mercator plane with the cell of the fills instead (no elevation), so the
 *    quad follows the sphere the way maplibre's layers do
 */

import type { ProjectionData } from 'maplibre-gl';
import type { TerrainAnchors } from '../../api/extension/context.js';
import type { RenderContext } from '../../api/extension/render.js';
import { globeGridOf } from '../globe-subdivision.js';
import { terrainStateOf } from '../terrain/binding.js';
import type { TerrainContext } from '../terrain/context.js';
import type { DrapeQuadCorners, QuadDrapeSurface } from '../terrain/drape/quad.js';
import { quadMercatorCorners } from '../terrain/drape/quad.js';
import {
  getQuadDrapeFrame,
  isTerrainElevationActive,
  reportTerrainCoarsening,
} from '../terrain/state.js';
import type { OffsetUniforms } from './helpers.js';
import {
  calculateLngLatOffset,
  createProgram,
  getProjectionTransitionUniform,
  OFFSET_MODE_GLSL,
} from './helpers.js';
import { ProjectionUniformManager } from './projection.js';
import {
  buildQuadGrid,
  computeQuadGridSize,
  type QuadGridGeometry,
  type QuadGridSize,
} from './quad-grid.js';

/**
 * The four corners of a quad, each `[lng, lat]` in degrees, as {@link computeQuadVertices}
 * returns them.
 */
export interface QuadVertices {
  /** The top-left corner (texture coordinate (0, 0)) */
  topLeft: [number, number];
  /** The top-right corner (texture coordinate (1, 0)) */
  topRight: [number, number];
  /** The bottom-left corner (texture coordinate (0, 1)) */
  bottomLeft: [number, number];
  /** The bottom-right corner (texture coordinate (1, 1)) */
  bottomRight: [number, number];
}

/**
 * Draws a textured quad on the map, such as a picture pasted onto it, following pitch,
 * globe and terrain.
 *
 * Call `ensureShader` with the shader data of the frame and `setOffsetUniforms` before
 * `draw`. On terrain the quad is painted as ground pixels when possible, otherwise it is
 * subdivided to the terrain mesh.
 */
export class QuadShader {
  private gl: WebGL2RenderingContext;
  private program: WebGLProgram | null = null;
  private variantName = '';
  private vao: WebGLVertexArrayObject | null = null;
  private positionBuffer: WebGLBuffer | null = null;
  private texCoordBuffer: WebGLBuffer | null = null;

  // Projection uniform management
  private projectionUniformManager: ProjectionUniformManager;

  // Uniform locations (renderer-specific)
  private textureLoc: WebGLUniformLocation | null = null;
  private opacityLoc: WebGLUniformLocation | null = null;

  // Stores the uniforms for offset mode
  private offsetUniforms: OffsetUniforms | null = null;

  // The resources of the subdivision path (terrain present, no analytic drape)
  private gridVao: WebGLVertexArrayObject | null = null;
  private gridPositionBuffer: WebGLBuffer | null = null;
  private gridTexCoordBuffer: WebGLBuffer | null = null;
  private gridIndexBuffer: WebGLBuffer | null = null;
  /** The most recently built grid (not rebuilt if the corners and divisions are the same) */
  private grid: QuadGridGeometry | null = null;
  private gridKey = '';
  /** The vertex offsets of the grid (a work array re-subtracting the center every frame) */
  private gridOffsets: Float32Array = new Float32Array(0);
  /** The capacity of the vertex buffer allocated on the GPU (number of elements) */
  private gridPositionCapacity = 0;

  /**
   * The terrain state of the draw instance being drawn (null draws without terrain)
   *
   * The CustomLayer binds its instance's state after construction. An extension renderer that
   * owns a QuadShader calls `setTerrain(ctx)` with the render context it receives.
   */
  private terrain: TerrainContext | null = null;

  /** @param gl - The WebGL context of the map */
  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.projectionUniformManager = new ProjectionUniformManager(gl);
    this.setupBuffers();
  }

  /**
   * Sets the terrain the next draws use.
   *
   * @param terrain - The render context of the draw call, or its `terrain`; `null` (or an
   *   object the engine did not hand out) draws without terrain
   */
  setTerrain(terrain: RenderContext | TerrainAnchors | null): void {
    this.useTerrainState(terrainStateOf(terrain));
  }

  /**
   * Sets the terrain state of an instance directly
   *
   * @internal
   */
  useTerrainState(terrain: TerrainContext | null): this {
    this.terrain = terrain;
    this.projectionUniformManager.useTerrainState(terrain);
    return this;
  }

  /**
   * Initializes the buffers
   */
  private setupBuffers(): void {
    const gl = this.gl;

    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);

    // The position buffer (updated dynamically)
    this.positionBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.positionBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, 8 * 4, gl.DYNAMIC_DRAW); // 4 vertices x 2 components
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.enableVertexAttribArray(0);

    // The texture coordinate buffer (fixed)
    this.texCoordBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.texCoordBuffer);
    // prettier-ignore
    const texCoords = new Float32Array([
      0.0,
      0.0, // top-left
      1.0,
      0.0, // top-right
      0.0,
      1.0, // bottom-left
      1.0,
      1.0, // bottom-right
    ]);
    gl.bufferData(gl.ARRAY_BUFFER, texCoords, gl.STATIC_DRAW);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 0, 0);
    gl.enableVertexAttribArray(1);

    gl.bindVertexArray(null);
  }

  /**
   * Sets the uniforms for offset mode
   */
  setOffsetUniforms(uniforms: OffsetUniforms): void {
    this.offsetUniforms = uniforms;
  }

  /**
   * Ensures the shader (recreating it when necessary)
   */
  ensureShader(shaderData: {
    vertexShaderPrelude: string;
    define: string;
    variantName: string;
  }): void {
    if (this.variantName === shaderData.variantName) return;

    if (this.program) {
      this.gl.deleteProgram(this.program);
    }

    this.program = this.createQuadProgram(shaderData.vertexShaderPrelude, shaderData.define);
    this.variantName = shaderData.variantName;

    // Obtain the projection uniform locations
    this.projectionUniformManager.getLocations(this.program);

    // Obtain the renderer-specific uniform locations
    this.textureLoc = this.gl.getUniformLocation(this.program, 'u_texture');
    this.opacityLoc = this.gl.getUniformLocation(this.program, 'u_opacity');
  }

  /**
   * Creates the shader program for a quad (offset mode)
   */
  private createQuadProgram(prelude: string, define: string): WebGLProgram {
    const projTransitionUniform = getProjectionTransitionUniform(prelude);
    const vertexSource = `#version 300 es
${prelude}
${define}
${projTransitionUniform}${OFFSET_MODE_GLSL}
in vec2 a_pos;      // relative coordinates (already computed at 64-bit precision on the CPU)
in vec2 a_texCoord;
out vec2 v_texCoord;
void main() {
    // High precision version: uses relative coordinates computed at 64-bit precision on the CPU
    gl_Position = project_position_to_clipspace_from_offset(a_pos, u_projection_matrix);
    v_texCoord = a_texCoord;
}`;

    const fragmentSource = `#version 300 es
precision highp float;
uniform sampler2D u_texture;
uniform float u_opacity;
in vec2 v_texCoord;
out vec4 fragColor;
void main() {
    vec4 color = texture(u_texture, v_texCoord);
    fragColor = vec4(color.rgb, color.a * u_opacity);
}`;

    return createProgram(this.gl, vertexSource, fragmentSource);
  }

  /**
   * Sets the projection uniforms (supporting offset mode + globe mode)
   * @param projectionData MapLibre's ProjectionData
   * @param zoom The current zoom level (used to switch offset mode)
   */
  private setProjectionUniforms(projectionData: ProjectionData, zoom: number): void {
    this.projectionUniformManager.setUniforms(projectionData, zoom, this.offsetUniforms);
  }

  /**
   * Draws a quad
   *
   * @param vertices The four vertices of the quad (WGS84 coordinates [lng, lat])
   * @param texture The texture
   * @param opacity The opacity
   * @param projectionData MapLibre's ProjectionData
   * @param zoom The current zoom level
   */
  draw(
    vertices: QuadVertices,
    texture: WebGLTexture,
    opacity: number,
    projectionData: ProjectionData,
    zoom: number,
  ): void {
    if (!this.program) return;

    // On frames where terrain is enabled, first try the analytic drape (painting it as
    // pixels of the ground surface). If it succeeds, the billboard is not drawn.
    const terrain = this.terrain;
    const terrainOn = terrain !== null && isTerrainElevationActive(terrain);
    if (terrain && terrainOn) {
      const frame = getQuadDrapeFrame(terrain);
      if (frame?.renderer.drawQuad(vertices, texture, opacity, frame)) return;
    }

    const gl = this.gl;

    gl.useProgram(this.program);
    this.setProjectionUniforms(projectionData, zoom);

    // Set the opacity
    if (this.opacityLoc) {
      gl.uniform1f(this.opacityLoc, opacity);
    }

    // Bind the texture
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    if (this.textureLoc) {
      gl.uniform1i(this.textureLoc, 0);
    }

    // Compute the relative coordinates on the CPU side (offset mode: computed at 64-bit
    // precision)
    // The shader's project_position_to_clipspace_from_offset handles it appropriately
    // according to the zoom
    const centerLngLat: [number, number] = this.offsetUniforms?.centerLngLat ?? [0, 0];

    if (terrain && terrainOn && this.drawSubdivided(terrain, vertices, centerLngLat)) {
      gl.bindVertexArray(null);
      gl.bindTexture(gl.TEXTURE_2D, null);
      return;
    }

    // On the globe (without terrain) the four corners would be joined by chords through the
    // sphere. The quad is cut along the Mercator plane with the cell of the fills instead, so
    // its edges and its picture lie on the sphere as they do on the Mercator map
    // (view/globe-subdivision.ts)
    if (
      terrain &&
      !terrain.renderState.active &&
      this.drawOnGlobe(globeGridOf(terrain, 'fill'), vertices, centerLngLat)
    ) {
      gl.bindVertexArray(null);
      gl.bindTexture(gl.TEXTURE_2D, null);
      return;
    }

    const topLeftOffset = calculateLngLatOffset(vertices.topLeft, centerLngLat);
    const topRightOffset = calculateLngLatOffset(vertices.topRight, centerLngLat);
    const bottomLeftOffset = calculateLngLatOffset(vertices.bottomLeft, centerLngLat);
    const bottomRightOffset = calculateLngLatOffset(vertices.bottomRight, centerLngLat);

    // Update the position data (relative coordinates)
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.positionBuffer);
    // prettier-ignore
    const positions = new Float32Array([
      topLeftOffset[0],
      topLeftOffset[1],
      topRightOffset[0],
      topRightOffset[1],
      bottomLeftOffset[0],
      bottomLeftOffset[1],
      bottomRightOffset[0],
      bottomRightOffset[1],
    ]);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, positions);

    // Draw
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    gl.bindVertexArray(null);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  /**
   * Draws with a subdivided grid (the degraded path)
   *
   * Splits the four corners to the fineness of the terrain mesh grid and adds
   * the DEM elevation per vertex. Applying the elevation to the vertices is
   * done by the shared GLSL, so the shader is the same one as the billboard.
   *
   * @returns true if it was drawn. When no subdivision is needed (the terrain
   *   step is unavailable) it returns false and the caller draws with the
   *   conventional four corner vertices
   */
  private drawSubdivided(
    terrain: TerrainContext,
    vertices: QuadVertices,
    centerLngLat: [number, number],
  ): boolean {
    const stepGrid = terrain.renderState.stepGrid;
    if (!(stepGrid > 0)) return false;

    const quad = quadMercatorCorners(vertices);
    const size = computeQuadGridSize(quad, stepGrid);
    if (size.nx <= 1 && size.ny <= 1) return false;

    // The chord dips below the terrain in proportion to how coarsely it was split, so
    // reflect that in the depth bias
    reportTerrainCoarsening(terrain, size.coarsening);

    return this.drawGrid(quad, size, centerLngLat);
  }

  /**
   * Draws with a grid cut along the Mercator plane on the globe
   *
   * @param cell The cell of the fills on the globe (Mercator; 0 on a flat map)
   * @returns true if it was drawn. A flat map, and a quad inside one cell, return false and
   *   the caller draws the four corners
   */
  private drawOnGlobe(
    cell: number,
    vertices: QuadVertices,
    centerLngLat: [number, number],
  ): boolean {
    if (!(cell > 0)) return false;
    const quad = quadMercatorCorners(vertices);
    const size = computeQuadGridSize(quad, cell, 1);
    if (size.nx <= 1 && size.ny <= 1) return false;
    return this.drawGrid(quad, size, centerLngLat);
  }

  /**
   * Draws the quad as a grid of `size` interpolated on the Mercator plane (shared by the
   * terrain and the globe)
   */
  private drawGrid(
    quad: ArrayLike<number>,
    size: QuadGridSize,
    centerLngLat: [number, number],
  ): boolean {
    const gl = this.gl;
    const key = `${Array.from(quad).join(',')}|${size.nx}x${size.ny}`;
    if (!this.grid || this.gridKey !== key) {
      this.grid = buildQuadGrid(quad, size.nx, size.ny);
      this.gridKey = key;
      if (!this.uploadGridStatics(this.grid)) return false;
    }
    const grid = this.grid;
    if (!this.gridVao || !this.gridPositionBuffer) return false;

    // The vertex offsets are re-subtracted every time the center moves (subtracted at 64-bit
    // and then converted to Float32)
    const needed = grid.vertexCount * 2;
    if (this.gridOffsets.length < needed) this.gridOffsets = new Float32Array(needed);
    const offsets = this.gridOffsets;
    const centerLng = centerLngLat[0];
    const centerLat = centerLngLat[1];
    for (let i = 0; i < needed; i += 2) {
      offsets[i] = grid.lngLat[i] - centerLng;
      offsets[i + 1] = grid.lngLat[i + 1] - centerLat;
    }

    gl.bindVertexArray(this.gridVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.gridPositionBuffer);
    if (this.gridPositionCapacity < needed) {
      gl.bufferData(gl.ARRAY_BUFFER, offsets.subarray(0, needed), gl.DYNAMIC_DRAW);
      this.gridPositionCapacity = needed;
    } else {
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, offsets.subarray(0, needed));
    }

    gl.drawElements(gl.TRIANGLES, grid.indices.length, gl.UNSIGNED_SHORT, 0);
    return true;
  }

  /**
   * Uploads the texture coordinates and indices of the grid to the GPU
   */
  private uploadGridStatics(grid: QuadGridGeometry): boolean {
    const gl = this.gl;

    if (!this.gridVao) {
      this.gridVao = gl.createVertexArray();
      this.gridPositionBuffer = gl.createBuffer();
      this.gridTexCoordBuffer = gl.createBuffer();
      this.gridIndexBuffer = gl.createBuffer();
      if (
        !this.gridVao ||
        !this.gridPositionBuffer ||
        !this.gridTexCoordBuffer ||
        !this.gridIndexBuffer
      ) {
        return false;
      }
      gl.bindVertexArray(this.gridVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.gridPositionBuffer);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      gl.enableVertexAttribArray(0);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.gridTexCoordBuffer);
      gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 0, 0);
      gl.enableVertexAttribArray(1);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.gridIndexBuffer);
      gl.bindVertexArray(null);
      this.gridPositionCapacity = 0;
    }

    gl.bindVertexArray(this.gridVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.gridTexCoordBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, grid.texCoords, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.gridIndexBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, grid.indices, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    return true;
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
    if (this.vao) {
      gl.deleteVertexArray(this.vao);
      this.vao = null;
    }
    if (this.positionBuffer) {
      gl.deleteBuffer(this.positionBuffer);
      this.positionBuffer = null;
    }
    if (this.texCoordBuffer) {
      gl.deleteBuffer(this.texCoordBuffer);
      this.texCoordBuffer = null;
    }
    if (this.gridVao) {
      gl.deleteVertexArray(this.gridVao);
      this.gridVao = null;
    }
    for (const buffer of [this.gridPositionBuffer, this.gridTexCoordBuffer, this.gridIndexBuffer]) {
      if (buffer) gl.deleteBuffer(buffer);
    }
    this.gridPositionBuffer = null;
    this.gridTexCoordBuffer = null;
    this.gridIndexBuffer = null;
    this.grid = null;
    this.gridKey = '';
    this.gridPositionCapacity = 0;
  }
}

/**
 * Paints a quad with a fill and text as pixels of the terrain surface.
 *
 * Used by custom renderers that draw text on a filled quad. The fill is decided by a
 * rectangle fill and the text by an SDF atlas lookup, both within the same
 * fragment, so a mismatch of subdivision between the fill and the text cannot
 * occur.
 *
 * Returns false on frames with no terrain and on frames that have terrain but
 * no entry point for the analytic drape (the DEM has not arrived, the shader
 * cannot be built). The caller falls back to the conventional way of drawing
 * (the fill texture + a separate draw of the text).
 *
 * @param terrain - The render context of the draw call, or its `terrain`
 * @param corners - The corners of the quad in degrees
 * @param surface - The fill and the text
 * @param opacity - The opacity, 0..1
 * @returns true if it was painted; false when the caller must draw it another way
 */
export function drawQuadSurfaceOnTerrain(
  terrain: RenderContext | TerrainAnchors,
  corners: DrapeQuadCorners,
  surface: QuadDrapeSurface,
  opacity: number,
): boolean {
  const state = terrainStateOf(terrain);
  return state !== null && drawQuadSurfaceOnTerrainState(state, corners, surface, opacity);
}

/**
 * {@link drawQuadSurfaceOnTerrain} over the terrain state of an instance
 *
 * @internal
 */
export function drawQuadSurfaceOnTerrainState(
  terrain: TerrainContext,
  corners: DrapeQuadCorners,
  surface: QuadDrapeSurface,
  opacity: number,
): boolean {
  if (!isTerrainElevationActive(terrain)) return false;
  const frame = getQuadDrapeFrame(terrain);
  if (!frame) return false;
  return frame.renderer.drawSurface(corners, surface, opacity, frame);
}

/** The valid range of the latitude */
const MAX_LATITUDE = 89.9;

/**
 * Returns the corners of a rectangle of a size in degrees, rotated about its center.
 *
 * When a large image is placed at a low zoom level, the latitude may exceed
 * +/-90 degrees. In that case it is scaled down automatically so that the
 * whole thing is displayed.
 *
 * @param centerLng The center longitude
 * @param centerLat The center latitude
 * @param widthDeg The width (degrees)
 * @param heightDeg The height (degrees)
 * @param rotationRad The rotation angle (radians, counter-clockwise)
 * @returns The four vertices of the quad (WGS84 coordinates [lng, lat])
 */
export function computeQuadVertices(
  centerLng: number,
  centerLat: number,
  widthDeg: number,
  heightDeg: number,
  rotationRad: number,
): QuadVertices {
  const cos = Math.cos(rotationRad);
  const sin = Math.sin(rotationRad);

  // The scale factor according to the latitude
  // The real distance of 1 degree of longitude = the real distance of 1 degree of latitude
  // x cos(latitude)
  const latCos = Math.cos((centerLat * Math.PI) / 180);

  // Normalize from degrees to a "latitude degree scale" (so that the real distances become
  // equal)
  // Longitude direction: widthDeg degrees x latCos -> equivalent latitude degrees
  // Latitude direction: heightDeg degrees -> as is
  let hwNorm = (widthDeg / 2) * latCos;
  let hhNorm = heightDeg / 2;

  // The local coordinates before rotation (a normalized isotropic coordinate system)
  const baseCorners = [
    { x: -hwNorm, y: hhNorm }, // top-left (north-west)
    { x: hwNorm, y: hhNorm }, // top-right (north-east)
    { x: -hwNorm, y: -hhNorm }, // bottom-left (south-west)
    { x: hwNorm, y: -hhNorm }, // bottom-right (south-east)
  ];

  // Precompute the latitude offset after rotation to decide the scale factor
  let maxLatOffset = 0;
  for (const c of baseCorners) {
    const ry = c.x * sin + c.y * cos;
    maxLatOffset = Math.max(maxLatOffset, Math.abs(ry));
  }

  // Scale down when the latitude exceeds the range
  const maxAllowedOffset = MAX_LATITUDE - Math.abs(centerLat);
  if (maxLatOffset > maxAllowedOffset && maxLatOffset > 0) {
    const scaleFactor = maxAllowedOffset / maxLatOffset;
    hwNorm *= scaleFactor;
    hhNorm *= scaleFactor;
  }

  // The local coordinates after the scale is applied
  const corners = [
    { x: -hwNorm, y: hhNorm }, // top-left (north-west)
    { x: hwNorm, y: hhNorm }, // top-right (north-east)
    { x: -hwNorm, y: -hhNorm }, // bottom-left (south-west)
    { x: hwNorm, y: -hhNorm }, // bottom-right (south-east)
  ];

  // Apply the rotation and convert to longitude and latitude
  const rotated = corners.map((c) => {
    const rx = c.x * cos - c.y * sin;
    const ry = c.x * sin + c.y * cos;
    return {
      // Convert to longitude: latitude degree scale -> longitude degrees (divide by latCos)
      lng: centerLng + rx / latCos,
      lat: centerLat + ry,
    };
  });

  // Return as WGS84 coordinates (the Mercator conversion is done in the shader)
  return {
    topLeft: [rotated[0].lng, rotated[0].lat],
    topRight: [rotated[1].lng, rotated[1].lat],
    bottomLeft: [rotated[2].lng, rotated[2].lat],
    bottomRight: [rotated[3].lng, rotated[3].lat],
  };
}
