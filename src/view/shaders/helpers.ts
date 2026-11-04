// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only AND MIT

/**
 * Shader helpers
 *
 * Utilities for creating and managing WebGL2 shaders
 * Performs the WGS84 -> Mercator -> clip coordinate conversion on the GPU
 */

import {
  CENTER_OFFSET_GLSL,
  CENTER_PROJECTION_CONSTANTS,
  clipOfPosition,
  glslFloat32,
  type ProjectionMatrices,
} from './center-projection.js';

export type { ProjectionMatrices };

/**
 * The shader prelude the map passes to a custom layer, for compiling programs for the current
 * projection.
 */
export interface ShaderData {
  /** The GLSL the map prepends to a vertex shader (its projection functions) */
  vertexShaderPrelude: string;
  /** The `#define` lines of the current projection */
  define: string;
  /** The name of the projection variant; a program is compiled again when it changes */
  variantName: string;
}

/**
 * The values for drawing positions relative to a center, which keeps the precision of 32-bit
 * floats near it at every zoom, on Web Mercator, on the globe and in the transition between.
 */
export interface OffsetUniforms {
  /** The center, rounded to 32-bit floats for the shader (what the offsets are taken from) */
  centerLngLat: [number, number];
  /** The center at 64-bit precision, for the offsets computed on the CPU */
  centerLngLat64: [number, number];
  /** The Mercator coordinates of the center, at 64-bit precision */
  centerMercator: [number, number];
  /**
   * The center in clip space as the view projects it, at 64-bit precision: on Web Mercator,
   * on the globe, or both mixed by the transition between them
   */
  projectionCenter: [number, number, number, number];
}

/**
 * Converts WGS84 coordinates to Mercator coordinates (high precision
 * computation on the CPU side)
 */
export function lngLatToMercator(lng: number, lat: number): [number, number] {
  const x = (lng + 180) / 360;
  const latRad = (lat * Math.PI) / 180;
  const y = (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2;
  return [x, y];
}

/**
 * The precision every sampler of the engine is read with
 *
 * GLSL ES 3.00 gives `sampler2D` no default precision other than lowp, in both stages, and a
 * texture lookup returns the precision of its sampler. The engine reads coordinates (RGBA32F
 * textures) and 24-bit fixed-point elevations through samplers, which lowp would quantize on
 * GPUs that honour it, so every program declares highp for them. `createProgram` inserts the
 * statement into both stages, so no shader source can leave it out.
 */
export const SAMPLER_PRECISION_GLSL = 'precision highp sampler2D;';

/** The version directive every shader of the engine starts with */
const VERSION_DIRECTIVE = /^#version 300 es[^\n]*\n/;

/**
 * Gives a shader source the engine's sampler precision
 *
 * The statement goes right after the `#version 300 es` line (the directive must stay first).
 * A source without that directive is returned unchanged. Repeating the statement in the source
 * itself is harmless.
 */
export function withSamplerPrecision(source: string): string {
  const match = VERSION_DIRECTIVE.exec(source);
  if (!match) return source;
  return `${match[0]}${SAMPLER_PRECISION_GLSL}\n${source.slice(match[0].length)}`;
}

/** `COMPLETION_STATUS_KHR` of `KHR_parallel_shader_compile` */
const COMPLETION_STATUS_KHR = 0x91b1;

/**
 * A program being compiled and linked, which a frame need not wait for
 *
 * Asking whether a program linked waits for the driver, up to seconds for a large shader. Where the
 * context has `KHR_parallel_shader_compile`, `done` tells without waiting; without it, it is true
 * at once and `take` waits.
 */
export class ProgramCompile {
  readonly #gl: WebGL2RenderingContext;
  readonly #parallel: boolean;
  readonly #vertex: WebGLShader;
  readonly #fragment: WebGLShader;
  readonly #program: WebGLProgram;
  #taken = false;

  /**
   * @param gl The WebGL2 context
   * @param vertexSource The vertex shader source, starting with \`#version 300 es\`
   * @param fragmentSource The fragment shader source, starting with \`#version 300 es\`
   * @param transformFeedbackVaryings The outputs a transform feedback captures, one buffer each
   */
  constructor(
    gl: WebGL2RenderingContext,
    vertexSource: string,
    fragmentSource: string,
    transformFeedbackVaryings?: readonly string[],
  ) {
    this.#gl = gl;
    this.#parallel = !!gl.getExtension?.('KHR_parallel_shader_compile');
    this.#vertex = gl.createShader(gl.VERTEX_SHADER) as WebGLShader;
    gl.shaderSource(this.#vertex, withSamplerPrecision(vertexSource));
    gl.compileShader(this.#vertex);
    this.#fragment = gl.createShader(gl.FRAGMENT_SHADER) as WebGLShader;
    gl.shaderSource(this.#fragment, withSamplerPrecision(fragmentSource));
    gl.compileShader(this.#fragment);
    this.#program = gl.createProgram() as WebGLProgram;
    gl.attachShader(this.#program, this.#vertex);
    gl.attachShader(this.#program, this.#fragment);
    if (transformFeedbackVaryings) {
      gl.transformFeedbackVaryings(
        this.#program,
        [...transformFeedbackVaryings],
        gl.SEPARATE_ATTRIBS,
      );
    }
    gl.linkProgram(this.#program);
  }

  /** Whether \`take\` answers without waiting */
  get done(): boolean {
    if (this.#taken || !this.#parallel) return true;
    return this.#gl.getProgramParameter(this.#program, COMPLETION_STATUS_KHR) === true;
  }

  /**
   * The linked program, once (waiting for it when it is not \`done\`)
   *
   * @throws Error with the info log when a shader fails to compile or the program fails to link
   */
  take(): WebGLProgram {
    const gl = this.#gl;
    this.#taken = true;
    if (!gl.getProgramParameter(this.#program, gl.LINK_STATUS)) {
      const log = [
        gl.getShaderInfoLog(this.#vertex),
        gl.getShaderInfoLog(this.#fragment),
        gl.getProgramInfoLog(this.#program),
      ]
        .filter((text) => text)
        .join('\n');
      this.#release();
      gl.deleteProgram(this.#program);
      throw new Error(`Program link error: ${log}`);
    }
    this.#release();
    return this.#program;
  }

  /** Lets go of a program not taken */
  dispose(): void {
    if (this.#taken) return;
    this.#taken = true;
    this.#release();
    this.#gl.deleteProgram(this.#program);
  }

  #release(): void {
    this.#gl.deleteShader(this.#vertex);
    this.#gl.deleteShader(this.#fragment);
  }
}

/**
 * Compiles and links a WebGL2 program from a vertex and a fragment shader source.
 *
 * Every program of the engine is compiled here, so the rules that apply to all of them live
 * here: both stages are given highp samplers (`withSamplerPrecision`).
 *
 * @param gl The WebGL2 context
 * @param vertexSource The vertex shader source, starting with `#version 300 es`
 * @param fragmentSource The fragment shader source, starting with `#version 300 es`
 * @param transformFeedbackVaryings The outputs a transform feedback captures, one buffer each
 * @returns The linked program
 * @throws Error with the info log when a shader fails to compile or the program fails to link
 */
export function createProgram(
  gl: WebGL2RenderingContext,
  vertexSource: string,
  fragmentSource: string,
  transformFeedbackVaryings?: readonly string[],
): WebGLProgram {
  const vertexShader = gl.createShader(gl.VERTEX_SHADER)!;
  gl.shaderSource(vertexShader, withSamplerPrecision(vertexSource));
  gl.compileShader(vertexShader);
  if (!gl.getShaderParameter(vertexShader, gl.COMPILE_STATUS)) {
    throw new Error(`Vertex shader error: ${gl.getShaderInfoLog(vertexShader)}`);
  }

  const fragmentShader = gl.createShader(gl.FRAGMENT_SHADER)!;
  gl.shaderSource(fragmentShader, withSamplerPrecision(fragmentSource));
  gl.compileShader(fragmentShader);
  if (!gl.getShaderParameter(fragmentShader, gl.COMPILE_STATUS)) {
    throw new Error(`Fragment shader error: ${gl.getShaderInfoLog(fragmentShader)}`);
  }

  const program = gl.createProgram()!;
  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  if (transformFeedbackVaryings) {
    gl.transformFeedbackVaryings(program, [...transformFeedbackVaryings], gl.SEPARATE_ATTRIBS);
  }
  gl.linkProgram(program);

  gl.deleteShader(vertexShader);
  gl.deleteShader(fragmentShader);

  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(`Program link error: ${gl.getProgramInfoLog(program)}`);
  }

  return program;
}

/**
 * Returns the declaration of `u_projection_transition` when a maplibre prelude lacks it.
 *
 * MapLibre's globe mode prelude defines u_projection_transition, but the
 * Mercator mode does not. This function inspects the prelude and returns the
 * uniform declaration only when it is needed.
 *
 * @param prelude MapLibre's vertexShaderPrelude
 * @returns The uniform declaration (when needed) or an empty string
 */
export function getProjectionTransitionUniform(prelude: string): string {
  return prelude.includes('u_projection_transition')
    ? ''
    : 'uniform float u_projection_transition;\n';
}

/**
 * GLSL that reads the elevation (meters) from the DEM atlas
 *
 * Used by both the vertex shader (which lifts the vertices) and the fragment
 * shader (which applies shading to the polygon fill; `terrain-shade.ts`).
 * Because they share the same way of taking samples, the elevation the vertex
 * picks up and the elevation the shading reads are always from the same
 * surface.
 *
 * The uniforms end up declared in both stages, but declarations with the same
 * name and type are bundled into one uniform, so the value only needs to be
 * written once.
 */
export const DEM_SAMPLE_GLSL = `
uniform float u_terrain_on;
uniform sampler2D u_dem_atlas;
// xy = the atlas origin (relative to the Mercator coordinates of the viewport center),
// zw = 1/width, 1/height
uniform vec4 u_dem_atlas_rect;
uniform vec2 u_dem_atlas_size;
// x = the meters -> Mercator z coefficient, y = the lift from the ground surface (meters)
uniform vec2 u_elevation_params;

float dem_decode(vec4 texel) {
    return dot(texel.rgb * 255.0, vec3(65536.0, 256.0, 1.0)) / 16777216.0 * 65536.0 - 32768.0;
}

// Reads the elevation (meters) from the atlas with bilinear interpolation
//
// Our own subdivision points are placed exactly on the real mesh nodes of the terrain tiles
// (view/terrain/tiling.ts). At the nodes, the value of the polyline surface MapLibre draws
// and the bilinear value of the DEM agree, so here it is enough to read the DEM directly.
// Only the points off the nodes (the vertices of the original feature, the points of its
// outline) differ between the two, but that difference stays within the sag of a single
// cell and can be covered by the depth bias.
float dem_elevation_meters(vec2 mercatorOffset) {
    vec2 uv = clamp((mercatorOffset - u_dem_atlas_rect.xy) * u_dem_atlas_rect.zw, 0.0, 1.0);
    vec2 coord = uv * u_dem_atlas_size - 0.5;
    vec2 f = fract(coord);
    ivec2 c = ivec2(floor(coord));
    ivec2 hi = ivec2(u_dem_atlas_size) - 1;
    float tl = dem_decode(texelFetch(u_dem_atlas, clamp(c, ivec2(0), hi), 0));
    float tr = dem_decode(texelFetch(u_dem_atlas, clamp(c + ivec2(1, 0), ivec2(0), hi), 0));
    float bl = dem_decode(texelFetch(u_dem_atlas, clamp(c + ivec2(0, 1), ivec2(0), hi), 0));
    float br = dem_decode(texelFetch(u_dem_atlas, clamp(c + ivec2(1, 1), ivec2(0), hi), 0));
    return mix(mix(tl, tr, f.x), mix(bl, br, f.x), f.y);
}
`;

/**
 * The GLSL functions that project positions relative to the view center (offset mode), on Web
 * Mercator, on the globe and in the transition between; include it in a vertex shader after the
 * maplibre prelude and its `#define`.
 *
 * A position is given as its offset in degrees from the center of the view, computed in float64
 * on the CPU and rounded to a 32-bit float, which keeps its precision near the camera. The
 * approach is the one of deck.gl's project module (see THIRD_PARTY_NOTICES.md for the source and
 * the copyright notice): no absolute coordinate is held in the shader, only offsets, and the
 * center in clip space is computed on the CPU in float64 and added at the end. The offset is
 * turned into the offset of the space the matrix of the view takes (the Mercator plane, the unit
 * sphere of the globe, or both mixed by the transition) with only the operations GLSL ES 3.00
 * bounds the error of (`view/shaders/center-projection.ts`), so at every zoom a position is a few
 * roundoffs of its distance from the center off.
 *
 * The uniforms:
 * - `u_center_lnglat`: the center, rounded to Float32 (what the offsets are taken from)
 * - `u_center_sine_cosine`: sin and cos of its latitude and of its longitude (float64 on the CPU)
 * - `u_projection_center`: the center in clip space (float64 on the CPU)
 * - `u_origin_shift`: the gap between the origin of a retained batch and the center
 * - maplibre's prelude: `u_projection_matrix`, and on the globe `u_projection_transition`,
 *   `u_projection_fallback_matrix` and `u_projection_clipping_plane`
 */
export const OFFSET_MODE_GLSL =
  `
#define PI 3.14159265359

// The WGS84 coordinates of the viewport center (already rounded to Float32)
uniform vec2 u_center_lnglat;

// The reference coordinates of a retained batch - the center of the view. Immediate mode uses
// (0,0)
// The vertices of a retained batch are relative to the reference coordinates, so the gap to the
// center is received here
uniform vec2 u_origin_shift;

// 1 when the offsets handed to the projection are taken from the center (u_center_lnglat) rather
// than from the origin of the batch: a row moved by the motion of its moving set gives its
// positions so (ROW_STATE_GLSL), and every position a vertex reads is of the same row
float g_offset_from_center = 0.0;

// The gap between what the offsets are taken from and the center
vec2 origin_shift() {
    return g_offset_from_center > 0.5 ? vec2(0.0) : u_origin_shift;
}

// Note: u_projection_transition is defined in MapLibre's globe mode prelude
// It is not defined in Mercator mode, so it must be added dynamically using
// getProjectionTransitionUniform() (exported from shader-helpers.ts)

// ---- terrain -------------------------------------------------------------
//
// Only when terrain is enabled (u_terrain_on = 1) is the elevation of the ground surface
// added to the vertex.
// When it is 0, the computed result is exactly identical to before terrain was introduced
// (the guarantee of zero regression).
//
// The elevation is looked up from the DEM atlas (view/terrain/dem-atlas.ts). The atlas is
// RGBA8 with the elevation in meters packed into a 24-bit fixed-point value, and the
// bilinear interpolation is done by hand (because encoded values cannot be interpolated
// linearly; the same treatment as MapLibre's terrain prelude).
//
// The unit of the amount added to the vertex is always Mercator
// (the same value as MercatorCoordinate.fromLngLat(lngLat, meters).z).
// Adding meters directly is wrong.
` +
  DEM_SAMPLE_GLSL +
  `
// ---- The explicit elevation of an anchor ----------------------------------
//
// UI that is determined by a single point, such as points, vertex handles and midpoint
// handles, does not look the elevation up from the DEM atlas but receives the value the CPU
// computed. It therefore goes through exactly the same elevation and the same matrix as hit
// testing (on the CPU), so the drawn position and the hit region agree structurally
// (see view/terrain/anchor.ts).
//
// The caller assigns to these two before calling project_*. Draws that do not assign
// (polygons and lines) look the value up from the atlas as before, so the results of the
// existing paths do not change.
//
// The lift (u_elevation_params.y) is not added. That exists for rendering reasons, to avoid
// Z-fighting with the terrain mesh; anchors are drawn without the depth test so it is not
// needed, and adding it would put them out of step with the projection on the CPU side.
float g_anchor_elevation_m = 0.0;
float g_anchor_elevation_on = 0.0;

// The elevation at Mercator coordinates relative to the center (in Mercator units, lift
// included)
float terrain_elevation_from_offset(vec2 mercatorOffset) {
    if (u_terrain_on < 0.5) return 0.0;
    if (g_anchor_elevation_on > 0.5) return g_anchor_elevation_m * u_elevation_params.x;
    return (dem_elevation_meters(mercatorOffset) + u_elevation_params.y) * u_elevation_params.x;
}
` +
  CENTER_OFFSET_GLSL +
  `
// Converts an offset from the center in degrees into the offset on the Mercator plane (z is
// kept as it is)
vec3 project_offset(vec3 offset) {
    vec2 halfLat = half_latitude_offset(offset.y);
    return vec3(offset.x * ${glslFloat32(CENTER_PROJECTION_CONSTANTS.perDegree)}, mercator_offset_y(halfLat), offset.z);
}

// Projects an offset from the center in degrees into clip space, with the elevation of the
// terrain under it
vec4 project_offset_to_clipspace(vec2 lngLatOffset, mat4 viewProjectionMatrix) {
    vec2 halfLat = half_latitude_offset(lngLatOffset.y);
    vec2 mercatorOffset = vec2(lngLatOffset.x * ${glslFloat32(CENTER_PROJECTION_CONSTANTS.perDegree)}, mercator_offset_y(halfLat));
    float elevation = terrain_elevation_from_offset(mercatorOffset);
    return project_center_offset(mercatorOffset, lngLatOffset.x, halfLat, elevation, viewProjectionMatrix);
}

// Projects an offset from the center on the Mercator plane into clip space, with the elevation
// of the terrain under it (the points of a line taken along the Mercator plane)
vec4 project_mercator_offset_to_clipspace(vec2 mercatorOffset, mat4 viewProjectionMatrix) {
    vec2 halfLat = half_latitude_of_mercator_offset(mercatorOffset.y);
    float lngOffset = mercatorOffset.x * 360.0;
    float elevation = terrain_elevation_from_offset(mercatorOffset);
    return project_center_offset(mercatorOffset, lngOffset, halfLat, elevation, viewProjectionMatrix);
}

// Projects a position given relative to the origin of what is drawn (a retained batch, or the
// center in immediate mode) into clip space: what the renderers call
vec4 project_position_to_clipspace_from_offset(vec2 lngLatOffset, mat4 viewProjectionMatrix) {
    // Add the gap between the reference coordinates and the center exactly once here
    return project_offset_to_clipspace(lngLatOffset + origin_shift(), viewProjectionMatrix);
}

// The Mercator coordinates relative to the center (used as the sample position of the
// shading)
//
// It is exactly the quantity this vertex uses when looking up the elevation
// (the argument of terrain_elevation_from_offset). If only the shading were derived a
// different way, the elevation the vertex picks up and the elevation the fill reads would
// diverge.
vec2 shade_mercator_offset(vec2 lngLatOffset) {
    return project_offset(vec3(lngLatOffset + origin_shift(), 0.0)).xy;
}
`;

/**
 * Computes the offset-mode uniforms for a center (the center of the view, or the origin of what
 * is drawn), to pass to `setOffsetUniforms` of the renderers.
 *
 * The center is rounded to Float32 (what the offsets are taken from) and projected into clip
 * space in float64 as the shaders project a position: on Web Mercator, on the globe, or both
 * mixed by the transition of the frame.
 *
 * @param centerLngLat The center `[lng, lat]` in degrees
 * @param projection MapLibre's projection data of the frame (its matrices and its transition)
 * @returns The uniform values for offset mode
 */
export function calculateOffsetUniforms(
  centerLngLat: readonly [number, number] | readonly number[],
  projection: ProjectionMatrices,
): OffsetUniforms {
  // Round the center coordinates to Float32 (the same procedure as deck.gl)
  const centerLng = Math.fround(centerLngLat[0] as number);
  const centerLat = Math.fround(centerLngLat[1] as number);
  const [centerMercX, centerMercY] = lngLatToMercator(centerLng, centerLat);
  return {
    centerLngLat: [centerLng, centerLat],
    centerLngLat64: [centerLngLat[0] as number, centerLngLat[1] as number],
    centerMercator: [centerMercX, centerMercY],
    projectionCenter: clipOfPosition(projection, centerLng, centerLat),
  };
}

/**
 * The projection matrix of the copy of the world moved east by `lngShift` degrees
 *
 * A view across the antimeridian draws the stored features a second time, moved by 360
 * degrees. That copy is drawn as a virtual camera: the center moves by -lngShift (so every
 * offset the CPU computes against it comes out shifted, in 64 bits) and the matrix moves by
 * +lngShift (M' = M * T(lngShift / 360) in Mercator units), so the two cancel for the camera
 * and the copy lands next to the stored one. Passing both to `calculateOffsetUniforms` gives
 * the same projection center as the real camera. It is one formula for the CPU and the GPU.
 *
 * @param matrix The projection matrix (column-major 4x4)
 * @param lngShift The shift in degrees of longitude (a multiple of 360)
 * @returns The translated matrix (64-bit values)
 */
export function translateMatrixByLongitude(matrix: ArrayLike<number>, lngShift: number): number[] {
  const out = Array.from({ length: 16 }, (_, i) => matrix[i]);
  const dx = lngShift / 360;
  for (let i = 0; i < 4; i++) out[12 + i] = matrix[12 + i] + dx * matrix[i];
  return out;
}

/**
 * Returns a position relative to the view center in degrees, computed at 64-bit precision
 * so that it survives Float32.
 *
 * Used to solve the coordinate precision problem at high zoom levels.
 * Converting absolute coordinates to Float32 loses precision, but relative
 * coordinates (small values) keep enough precision even in Float32.
 *
 * @param lngLat The WGS84 coordinates [lng, lat]
 * @param centerLngLat The center coordinates [lng, lat] (64-bit precision)
 * @returns The relative coordinates [dLng, dLat] (Float32 has enough precision)
 */
export function calculateLngLatOffset(
  lngLat: [number, number],
  centerLngLat: [number, number],
): [number, number] {
  // The subtraction is done at 64-bit precision, and since the result is a small value the
  // precision is kept even in Float32
  return [lngLat[0] - centerLngLat[0], lngLat[1] - centerLngLat[1]];
}
