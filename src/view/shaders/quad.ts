// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * QuadShader
 *
 * A shader for drawing a quad (a quadrilateral) with a content: a picture, or whatever a GLSL
 * function paints at a position in the quad (`QuadDrapeContent`, the same content the analytic
 * drape paints). Projects its corners from their offsets from the center of the view
 * (OFFSET_MODE_GLSL), with pitch, roll and the globe, without the precision problems of absolute
 * coordinates.
 *
 * On frames where terrain (3D) is enabled, a billboard with only four corners
 * lets the terrain poke through from the inside, so the drawing is split into
 * three ways.
 *
 * 1. Analytic drape (the preferred one). `terrain/drape/quad.ts` paints it as
 *    pixels of the ground surface, with its content (the same entry point an
 *    extension paints its quads through, `drawQuadOnTerrain`). Burying and
 *    clipping cannot occur by
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
import type { GpuMemoryRecord, TerrainSurface } from '../../api/extension/context.js';
import type { RenderContext } from '../../api/extension/render.js';
import { globeGridOf } from '../globe-subdivision.js';
import { terrainStateOf } from '../terrain/binding.js';
import type { TerrainContext } from '../terrain/context.js';
import type { DrapeQuadCorners, QuadDrapeContent } from '../terrain/drape/quad.js';
import { QUAD_DRAPE_TEXTURE_UNITS, quadMercatorCorners } from '../terrain/drape/quad.js';
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
 * The GLSL of a picture as the content of a draped quad: the texel at (u, v), darkened by the
 * relief as the fill is
 */
const QUAD_IMAGE_GLSL = `
uniform sampler2D u_image_texture;

vec4 quadDrapeColor(vec2 uv, vec2 uvDx, vec2 uvDy, float shade) {
    vec4 color = texture(u_image_texture, clamp(uv, 0.0, 1.0));
    return vec4(color.rgb * shade * color.a, color.a);
}
`;

/** The texture unit the picture is bound to */
const QUAD_IMAGE_TEXTURE_UNIT = QUAD_DRAPE_TEXTURE_UNITS[0];

/** The owner the buffers of a quad are recorded under in the GPU ledger */
const QUAD_OWNER = 'images';

/** The bytes of the positions of the four corners (4 vertices of 2 floats) */
const QUAD_POSITION_BYTES = 8 * 4;

/** The texture coordinates of the four corners */
const QUAD_TEX_COORDS = new Float32Array([
  0.0,
  0.0, // top-left
  1.0,
  0.0, // top-right
  0.0,
  1.0, // bottom-left
  1.0,
  1.0, // bottom-right
]);

/** The ledger a `QuadShader` records its buffers in: `ctx.gpu` of an extension */
export type QuadShaderLedger = Pick<GpuMemoryRecord, 'record' | 'release'>;

/**
 * A picture as the content of a quad: set the texture of the quad before it is drawn.
 */
export class QuadImageContent implements QuadDrapeContent {
  readonly glsl = QUAD_IMAGE_GLSL;
  /** The texture of the picture of the quad being drawn */
  texture: WebGLTexture | null = null;

  bind(gl: WebGL2RenderingContext, uniform: (name: string) => WebGLUniformLocation | null): void {
    gl.activeTexture(gl.TEXTURE0 + QUAD_IMAGE_TEXTURE_UNIT);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.uniform1i(uniform('u_image_texture'), QUAD_IMAGE_TEXTURE_UNIT);
  }
}

/**
 * Draws a quad on the map with a content, following pitch, globe and terrain: a picture pasted
 * onto it (`QuadImageContent`, the content by default), or the content given.
 *
 * Call `ensureShader` with the shader data of the view being drawn and `setOffsetUniforms` before
 * `draw`. On terrain the quad is painted as ground pixels when possible, otherwise it is
 * subdivided to the terrain mesh, where a content is given a shading of 1.
 */
export class QuadShader<C extends QuadDrapeContent = QuadImageContent> {
  /** What the quads show: set what it reads before each `draw` */
  readonly content: C;
  private gl: WebGL2RenderingContext;
  private program: WebGLProgram | null = null;
  private variantName = '';
  private vao: WebGLVertexArrayObject | null = null;
  private positionBuffer: WebGLBuffer | null = null;
  private texCoordBuffer: WebGLBuffer | null = null;
  /** Where the bytes of the buffers are recorded */
  private readonly ledger: QuadShaderLedger;

  // Projection uniform management
  private projectionUniformManager: ProjectionUniformManager;

  // Uniform locations (renderer-specific)
  private opacityLoc: WebGLUniformLocation | null = null;
  /** The locations of the uniforms of the content, by their names */
  private contentUniforms = new Map<string, WebGLUniformLocation | null>();
  private readonly contentUniform = (name: string): WebGLUniformLocation | null => {
    let location = this.contentUniforms.get(name);
    if (location === undefined) {
      location = this.program ? this.gl.getUniformLocation(this.program, name) : null;
      this.contentUniforms.set(name, location);
    }
    return location;
  };

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

  /**
   * @param gl - The WebGL context of the map
   * @param ledger - The ledger its buffers are recorded in (`ctx.gpu` of an extension)
   * @param content - What the quads show (`QuadImageContent` when left out). Its GLSL is compiled
   *   into the program of the quads, and into the one of the analytic drape
   */
  constructor(gl: WebGL2RenderingContext, ledger: QuadShaderLedger, content?: C) {
    this.gl = gl;
    this.ledger = ledger;
    this.content = content ?? (new QuadImageContent() as QuadDrapeContent as C);
    this.projectionUniformManager = new ProjectionUniformManager(gl);
    try {
      this.setupBuffers();
    } catch (error) {
      // Nothing is in a ledger yet: what was made goes here
      this.dispose();
      throw error;
    }
  }

  /**
   * Sets the terrain the next draws use.
   *
   * @param terrain - The render context of the draw call, or its `terrain`; `null` draws without
   *   terrain
   * @throws `DrawError` with the code `invalid-input` when it is an object the instance did not
   *   give a renderer, as `viewUniforms` does
   */
  setTerrain(terrain: RenderContext | TerrainSurface | null): void {
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
    gl.bufferData(gl.ARRAY_BUFFER, QUAD_POSITION_BYTES, gl.DYNAMIC_DRAW); // 4 vertices x 2 components
    this.ledger.record(this.positionBuffer, QUAD_OWNER, 'buffer', QUAD_POSITION_BYTES);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.enableVertexAttribArray(0);

    // The texture coordinate buffer (fixed)
    this.texCoordBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.texCoordBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, QUAD_TEX_COORDS, gl.STATIC_DRAW);
    this.ledger.record(this.texCoordBuffer, QUAD_OWNER, 'buffer', QUAD_TEX_COORDS.byteLength);
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
    this.opacityLoc = this.gl.getUniformLocation(this.program, 'u_opacity');
    this.contentUniforms.clear();
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
precision highp int;
precision highp sampler2D;
uniform float u_opacity;
in vec2 v_texCoord;
out vec4 fragColor;
${this.content.glsl}
void main() {
    vec2 uvDx = dFdx(v_texCoord);
    vec2 uvDy = dFdy(v_texCoord);
    // A content answers with premultiplied alpha, which the blending of the frame does not take
    vec4 color = quadDrapeColor(v_texCoord, uvDx, uvDy, 1.0);
    fragColor = vec4(color.rgb / max(color.a, 1e-4), color.a * u_opacity);
}`;

    return createProgram(this.gl, vertexSource, fragmentSource);
  }

  /**
   * Sets the projection uniforms (supporting offset mode + globe mode)
   * @param projectionData MapLibre's ProjectionData
   */
  private setProjectionUniforms(projectionData: ProjectionData): void {
    this.projectionUniformManager.setUniforms(projectionData, this.offsetUniforms);
  }

  /**
   * Draws a quad with the content as it stands
   *
   * @param vertices The four vertices of the quad (WGS84 coordinates [lng, lat])
   * @param opacity The opacity
   * @param projectionData MapLibre's ProjectionData
   */
  draw(vertices: QuadVertices, opacity: number, projectionData: ProjectionData): void {
    if (!this.program) return;

    // On frames where terrain is enabled, first try the analytic drape (painting it as
    // pixels of the ground surface). If it succeeds, the billboard is not drawn.
    const terrain = this.terrain;
    const terrainOn = terrain !== null && isTerrainElevationActive(terrain);
    if (terrain && terrainOn && drawQuadOnTerrainState(terrain, vertices, this.content, opacity)) {
      return;
    }

    const gl = this.gl;

    gl.useProgram(this.program);
    this.setProjectionUniforms(projectionData);

    // Set the opacity
    if (this.opacityLoc) {
      gl.uniform1f(this.opacityLoc, opacity);
    }

    this.content.bind(gl, this.contentUniform);

    // Compute the relative coordinates on the CPU side (offset mode: computed at 64-bit
    // precision), which the shader's project_position_to_clipspace_from_offset projects
    const centerLngLat: [number, number] = this.offsetUniforms?.centerLngLat ?? [0, 0];

    if (terrain && terrainOn && this.drawSubdivided(terrain, vertices, centerLngLat)) {
      gl.bindVertexArray(null);
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
      this.ledger.record(this.gridPositionBuffer, QUAD_OWNER, 'buffer', needed * 4);
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
    this.ledger.record(this.gridTexCoordBuffer, QUAD_OWNER, 'buffer', grid.texCoords.byteLength);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.gridIndexBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, grid.indices, gl.STATIC_DRAW);
    this.ledger.record(this.gridIndexBuffer, QUAD_OWNER, 'buffer', grid.indices.byteLength);
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
      this.ledger.release(this.positionBuffer);
      gl.deleteBuffer(this.positionBuffer);
      this.positionBuffer = null;
    }
    if (this.texCoordBuffer) {
      this.ledger.release(this.texCoordBuffer);
      gl.deleteBuffer(this.texCoordBuffer);
      this.texCoordBuffer = null;
    }
    if (this.gridVao) {
      gl.deleteVertexArray(this.gridVao);
      this.gridVao = null;
    }
    for (const buffer of [this.gridPositionBuffer, this.gridTexCoordBuffer, this.gridIndexBuffer]) {
      if (!buffer) continue;
      this.ledger.release(buffer);
      gl.deleteBuffer(buffer);
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
 * Paints a quad as pixels of the terrain surface, with what it shows given by a content of the
 * caller's.
 *
 * Where a quad drawn by its four corners would cut through the terrain, this paints the pixels of
 * the ground inside the quad: it follows the relief, and what lies behind a ridge is hidden by
 * the ridge. The content decides the color at each position in the quad
 * ({@link QuadDrapeContent}); the library gives it the position, its change between pixels and the
 * shading of the terrain, and applies the opacity. `QuadShader` draws its picture through it.
 *
 * Returns false on draws with no terrain and on draws that have terrain but cannot drape the quad
 * (the DEM has not arrived, the program of the content cannot be built). The caller then draws
 * the quad another way.
 *
 * @param terrain - The render context of the draw call, or its `terrain`
 * @param corners - The corners of the quad in degrees
 * @param content - What the quad shows
 * @param opacity - The opacity, 0..1
 * @returns true if it was painted; false when the caller must draw it another way
 * @throws `DrawError` with the code `invalid-input` when `terrain` is an object the instance did
 *   not give a renderer, as `viewUniforms` does
 */
export function drawQuadOnTerrain(
  terrain: RenderContext | TerrainSurface,
  corners: DrapeQuadCorners,
  content: QuadDrapeContent,
  opacity: number,
): boolean {
  const state = terrainStateOf(terrain);
  return state !== null && drawQuadOnTerrainState(state, corners, content, opacity);
}

/**
 * {@link drawQuadOnTerrain} over the terrain state of an instance
 *
 * @internal
 */
export function drawQuadOnTerrainState(
  terrain: TerrainContext,
  corners: DrapeQuadCorners,
  content: QuadDrapeContent,
  opacity: number,
): boolean {
  if (!isTerrainElevationActive(terrain)) return false;
  const frame = getQuadDrapeFrame(terrain);
  if (!frame) return false;
  return frame.renderer.drawQuad(corners, content, opacity, frame);
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
