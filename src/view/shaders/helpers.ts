// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only AND MIT

/**
 * Shader helpers
 *
 * Utilities for creating and managing WebGL2 shaders
 * Performs the WGS84 -> Mercator -> clip coordinate conversion on the GPU
 */

// The shader prelude and the offset values are the types of the extension contract, so that the
// renderers and the second layer of the API name the same types as the main entry
import type { OffsetUniforms, ShaderData } from '../../api/extension/render.js';

export type { OffsetUniforms, ShaderData };

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

/**
 * Compiles and links a WebGL2 program from a vertex and a fragment shader source.
 *
 * Every program of the engine is compiled here, so the rules that apply to all of them live
 * here: both stages are given highp samplers (`withSamplerPrecision`).
 *
 * @param gl The WebGL2 context
 * @param vertexSource The vertex shader source, starting with `#version 300 es`
 * @param fragmentSource The fragment shader source, starting with `#version 300 es`
 * @returns The linked program
 * @throws Error with the info log when a shader fails to compile or the program fails to link
 */
export function createProgram(
  gl: WebGL2RenderingContext,
  vertexSource: string,
  fragmentSource: string,
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
 * The GLSL functions that project positions relative to the view center (offset mode), with
 * globe support; include it in a vertex shader after the maplibre prelude.
 *
 * To solve the coordinate precision problem (jitter), it uses the same
 * approach as deck.gl's project module. The projection functions below include
 * a port from deck.gl. See THIRD_PARTY_NOTICES.md for the source and the
 * copyright notice.
 * In globe mode, MapLibre's projectTile() is used.
 *
 * The essential points:
 * 1. Do not add Mercator coordinates inside the shader
 * 2. Handle only relative coordinates (offsets) in the shader
 * 3. Compute the clip coordinates of the center at 64-bit precision on the CPU
 *    side and add them at the end
 *
 * The computation flow:
 * 1. position.xyz -= coordinateOrigin  // make it relative (Float32 is enough)
 * 2. offset = project_offset(position) // convert degrees -> Mercator units
 * 3. gl_Position = viewProjectionMatrix * offset + projectionCenter
 *    ^ projectionCenter is computed at 64-bit precision on the CPU side
 *
 * Globe mode support:
 * - When projectionTransition > 0, MapLibre's projectTile() is used
 * - Globe mode is active at zoom < 12, where the precision problem does not
 *   occur
 * - In Mercator mode, the precision problem is solved by offset mode
 *
 * The uniforms used:
 * - u_center_lnglat: the WGS84 coordinates of the viewport center (already
 *   rounded to Float32)
 * - u_projection_center: the center coordinates in clip space (computed at
 *   64-bit precision on the CPU side)
 * - u_units_per_degree: the conversion coefficient from degrees to Mercator
 *   units (computed on the CPU side)
 * - u_units_per_degree2: the non-linear correction coefficient (corrects the
 *   variation due to latitude)
 * - u_projection_transition: defined in MapLibre's prelude (0 = Mercator,
 *   1 = globe)
 *
 * The uniforms for globe mode (defined in MapLibre's prelude):
 * - u_projection_tile_mercator_coords: the Mercator coordinates of the tile
 * - u_projection_clipping_plane: the clipping plane
 * - u_projection_fallback_matrix: the fallback matrix
 */
export const OFFSET_MODE_GLSL =
  `
#define PI 3.14159265359

// The WGS84 coordinates of the viewport center (already rounded to Float32)
uniform vec2 u_center_lnglat;
// The Mercator coordinates of the viewport center (Float32)
uniform vec2 u_center_mercator;
// The center coordinates in clip space (computed at 64-bit precision on the CPU side)
uniform vec4 u_projection_center;
// The conversion coefficient from degrees to Mercator units
uniform vec3 u_units_per_degree;
// The non-linear correction coefficient (the variation due to latitude)
uniform vec3 u_units_per_degree2;

// The offset mode flag (1 = offset mode, 0 = the projectTile approach)
// Offset mode is used to solve the precision problem at high zoom levels (around zoom >= 12)
// At low zoom levels, or when unset (default 0), projectTile() is used
// Offset mode computes with coordinates relative to the viewport center, so with data
// covering a wide area the error grows at vertices far from the center
uniform float u_use_offset_mode;

// The reference coordinates of a retained batch - the linearization center (the camera
// center). Immediate mode uses (0,0)
// The vertices of a retained batch are relative to the reference coordinates, so the
// difference needed to align the linearization center with the camera center is received here
uniform vec2 u_origin_shift;

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

// The elevation at absolute Mercator coordinates (in Mercator units, lift included)
float terrain_elevation_at(vec2 mercator) {
    if (u_terrain_on < 0.5) return 0.0;
    if (g_anchor_elevation_on > 0.5) return g_anchor_elevation_m * u_elevation_params.x;
    return terrain_elevation_from_offset(mercator - u_center_mercator);
}

// Converts WGS84 coordinates to Mercator coordinates (the 0-1 range)
vec2 lngLatToMercator(vec2 lngLat) {
    float x = (lngLat.x + 180.0) / 360.0;
    float latRad = lngLat.y * PI / 180.0;
    float y = (1.0 - log(tan(latRad) + 1.0 / cos(latRad)) / PI) / 2.0;
    return vec2(x, y);
}

// Converts offset coordinates into the units of the common space (Mercator)
// A port of deck.gl's project_offset_
// See THIRD_PARTY_NOTICES.md for the source and the copyright notice
vec3 project_offset(vec3 offset) {
    float dy = offset.y;
    vec3 unitsPerDegree = u_units_per_degree + u_units_per_degree2 * dy;
    return offset * unitsPerDegree;
}

// Converts WGS84 coordinates to relative coordinates and projects them into clip space
// (for Mercator mode)
// A port of deck.gl's project_position + project_common_position_to_clipspace
// See THIRD_PARTY_NOTICES.md for the source and the copyright notice
vec4 project_position_mercator(vec2 lngLat, mat4 viewProjectionMatrix) {
    // 1. Compute the coordinates relative to the center (Float32 has enough precision)
    vec2 lngLatOffset = lngLat - u_center_lnglat;

    // 2. Convert the relative coordinates into the units of the common space
    vec3 mercatorOffset = project_offset(vec3(lngLatOffset, 0.0));

    // 2.5 Put the terrain elevation into z. u_projection_center is computed at z=0, but the
    // matrix is linear, so composing it by adding only the z term is correct
    mercatorOffset.z = terrain_elevation_from_offset(mercatorOffset.xy);

    // 3. viewProjectionMatrix * offset + projectionCenter
    // Setting w=0 keeps the fourth column of the matrix (the translation) from having an
    // effect
    // The translation comes only from projectionCenter
    vec4 offset = vec4(mercatorOffset, 0.0);
    return viewProjectionMatrix * offset + u_projection_center;
}

// Projects relative coordinates (already computed on the CPU side) into clip space
// (for Mercator mode, the high precision version)
// The offset from the center is computed at 64-bit precision on the CPU side and the result
// is received here
// This keeps the precision loss from the conversion to Float32 to a minimum
// The clip conversion is a port of deck.gl's project_common_position_to_clipspace
// See THIRD_PARTY_NOTICES.md for the source and the copyright notice
vec4 project_offset_to_clipspace(vec2 lngLatOffset, mat4 viewProjectionMatrix) {
    // Convert the relative coordinates into the units of the common space
    vec3 mercatorOffset = project_offset(vec3(lngLatOffset, 0.0));

    // Put the terrain elevation into z (0 when terrain is disabled)
    mercatorOffset.z = terrain_elevation_from_offset(mercatorOffset.xy);

    // viewProjectionMatrix * offset + projectionCenter
    vec4 offset = vec4(mercatorOffset, 0.0);
    return viewProjectionMatrix * offset + u_projection_center;
}

// Projects WGS84 coordinates into clip space
// Switches automatically between globe mode, low zoom and high zoom
// - Globe mode (u_projection_transition > 0): uses MapLibre's projectTile()
// - Mercator mode with u_use_offset_mode=0: uses projectTile() (for low zoom)
// - Mercator mode with u_use_offset_mode=1: solves the precision problem with offset mode
//   (for high zoom)
vec4 project_position_to_clipspace(vec2 lngLat, mat4 viewProjectionMatrix) {
    // In globe mode, use MapLibre's projectTile()
    // u_projection_transition is defined in MapLibre's prelude
    if (u_projection_transition > 0.0) {
        // Convert WGS84 -> Mercator and hand it to projectTile()
        vec2 mercator = lngLatToMercator(lngLat);
        return projectTileWithElevation(mercator, terrain_elevation_at(mercator));
    }
    // Used only when offset mode is enabled
    // It solves the precision problem at high zoom levels, but with data covering a wide
    // area the error grows at vertices far from the center
    if (u_use_offset_mode > 0.5) {
        return project_position_mercator(lngLat, viewProjectionMatrix);
    }
    // Default: use MapLibre's projectTile()
    // It is safe because the precision problem does not occur at low zoom levels
    // (projectTileWithElevation at elevation 0 gives the same result as projectTile)
    vec2 mercator = lngLatToMercator(lngLat);
    return projectTileWithElevation(mercator, terrain_elevation_at(mercator));
}

// Projects relative coordinates (already computed at 64-bit precision on the CPU side) into
// clip space (the high precision version)
// The offset from the center is computed at 64-bit precision on the CPU side and the result
// is received here
// This makes it possible to draw at the correct position even at high zoom levels
// - Globe mode: restores the absolute coordinates from relative + center coordinates and
//   uses projectTile()
// - Mercator mode with u_use_offset_mode=1: high precision drawing with offset mode
// - Otherwise: restores the absolute coordinates and uses projectTile()
vec4 project_position_to_clipspace_from_offset(vec2 lngLatOffset, mat4 viewProjectionMatrix) {
    // Add the gap between the reference coordinates and the linearization center exactly
    // once here
    // (adding it inside project_offset_to_clipspace would double-count it)
    vec2 shifted = lngLatOffset + u_origin_shift;

    // In globe mode, use MapLibre's projectTile()
    if (u_projection_transition > 0.0) {
        // Restore the absolute coordinates from the relative ones (Float32 precision, but
        // acceptable in globe mode)
        vec2 lngLat = shifted + u_center_lnglat;
        vec2 mercator = lngLatToMercator(lngLat);
        return projectTileWithElevation(mercator, terrain_elevation_at(mercator));
    }
    // Used only when offset mode is enabled
    if (u_use_offset_mode > 0.5) {
        return project_offset_to_clipspace(shifted, viewProjectionMatrix);
    }
    // Default: restore the absolute coordinates and use MapLibre's projectTile()
    vec2 lngLat = shifted + u_center_lnglat;
    vec2 mercator = lngLatToMercator(lngLat);
    return projectTileWithElevation(mercator, terrain_elevation_at(mercator));
}

// The Mercator coordinates relative to the center (used as the sample position of the
// shading)
//
// It is exactly the quantity this vertex uses when looking up the elevation
// (the argument of terrain_elevation_from_offset). If only the shading were derived a
// different way, the elevation the vertex picks up and the elevation the fill reads would
// diverge. The branches are evaluated in the same order as the projection.
vec2 shade_mercator_offset(vec2 lngLatOffset) {
    vec2 shifted = lngLatOffset + u_origin_shift;
    if (u_projection_transition > 0.0 || u_use_offset_mode <= 0.5) {
        return lngLatToMercator(shifted + u_center_lnglat) - u_center_mercator;
    }
    return project_offset(vec3(shifted, 0.0)).xy;
}
`;

/**
 * Computes the offset-mode uniforms for a view center, to pass to `setOffsetUniforms` of the
 * renderers.
 *
 * The uniforms for globe mode are obtained directly from ProjectionData, so
 * this function performs only the offset computation for the Mercator
 * projection.
 *
 * @param centerLngLat The view center `[lng, lat]` in degrees
 * @param mainMatrix MapLibre's projection matrix (column-major 4x4)
 * @returns The uniform values for offset mode
 */
export function calculateOffsetUniforms(
  centerLngLat: [number, number],
  mainMatrix: Float32Array | number[],
): OffsetUniforms {
  // 1. Round the center coordinates to Float32 (the same procedure as deck.gl)
  const centerLng = Math.fround(centerLngLat[0]);
  const centerLat = Math.fround(centerLngLat[1]);

  // 2. Compute the Mercator coordinates of the center at 64-bit precision
  const [centerMercX, centerMercY] = lngLatToMercator(centerLng, centerLat);

  // 3. Convert the Mercator coordinates of the center into clip space (matrix computation
  // at 64-bit precision)
  // gl_Position = mainMatrix * [mercX, mercY, 0, 1]
  const m = mainMatrix;
  const projectionCenter: [number, number, number, number] = [
    m[0] * centerMercX + m[4] * centerMercY + m[12],
    m[1] * centerMercX + m[5] * centerMercY + m[13],
    m[2] * centerMercX + m[6] * centerMercY + m[14],
    m[3] * centerMercX + m[7] * centerMercY + m[15],
  ];

  // 4. Compute the conversion coefficient from degrees to Mercator units
  // The Mercator projection: x = (lng + 180) / 360
  //                          y = (1 - log(tan(lat) + sec(lat)) / PI) / 2
  // dx/dlng = 1/360
  // dy/dlat = -1 / (360 * cos(lat))  (linear approximation)
  const latRad = (centerLat * Math.PI) / 180;
  const cosLat = Math.cos(latRad);

  const unitsPerDegreeX = 1 / 360;
  const unitsPerDegreeY = -1 / (360 * cosLat);

  // 5. The non-linear correction coefficient (the variation due to latitude)
  // Corresponds to deck.gl's unitsPerDegree2 and corrects the distortion at high latitudes
  //
  // A port of getDistanceScales (highPrecision) from @math.gl/web-mercator:
  //   latCosine2 = DEGREES_TO_RADIANS * tan(lat) / cos(lat)
  //   unitsPerDegree2Y = (unitsPerDegreeX * latCosine2) / 2
  // See THIRD_PARTY_NOTICES.md for the source and the copyright notice
  //
  // In this project the Y axis is flipped (a tile coordinate system), so the sign is flipped
  const latCosine2 = ((Math.PI / 180) * Math.tan(latRad)) / cosLat;
  const unitsPerDegree2Y = -(unitsPerDegreeX * latCosine2) / 2;

  return {
    centerLngLat: [centerLng, centerLat],
    centerLngLat64: [centerLngLat[0], centerLngLat[1]], // keeps the original 64-bit values
    centerMercator: [centerMercX, centerMercY],
    projectionCenter,
    unitsPerDegree: [unitsPerDegreeX, unitsPerDegreeY, 1],
    unitsPerDegree2: [0, unitsPerDegree2Y, 0],
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
 * the same projection center as the real camera, and the absolute path of the shader
 * (projectTile at low zoom) moves by the same amount through the matrix. It is one formula
 * for the CPU and the GPU.
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

/**
 * Viewport information
 */
export interface Viewport {
  width: number;
  height: number;
}

/**
 * The interface for the offset mode coordinate transform
 */
export interface OffsetModeTransform {
  project: (lngLat: [number, number]) => { x: number; y: number };
  unproject: (point: { x: number; y: number }) => { lng: number; lat: number };
}

/**
 * Creates the offset mode coordinate transform (performs the same computation
 * as the shader on the CPU side)
 *
 * The computation flow of the shader:
 * 1. lngLatOffset = lngLat - u_center_lnglat
 * 2. mercatorOffset = project_offset(lngLatOffset)
 *    = lngLatOffset * (u_units_per_degree + u_units_per_degree2 * lngLatOffset.y)
 * 3. clipPos = viewProjectionMatrix * vec4(mercatorOffset, 0) + u_projection_center
 * 4. ndc = clipPos.xy / clipPos.w
 * 5. screen = (ndc * 0.5 + 0.5) * viewport
 *
 * @param uniforms The uniform values for offset mode
 * @param mainMatrix MapLibre's projection matrix
 * @param viewport The viewport information
 */
export function createOffsetModeTransform(
  uniforms: OffsetUniforms,
  mainMatrix: Float32Array | number[],
  viewport: Viewport,
): OffsetModeTransform {
  const m = mainMatrix;
  // Use the center coordinates already rounded to Float32 (to stay consistent with
  // projectionCenter)
  const { centerLngLat, projectionCenter, unitsPerDegree, unitsPerDegree2 } = uniforms;

  return {
    project: (lngLat: [number, number]): { x: number; y: number } => {
      // 1. Compute the relative coordinates (using the center coordinates rounded to Float32)
      const lngOffset = lngLat[0] - centerLngLat[0];
      const latOffset = lngLat[1] - centerLngLat[1];

      // 2. Convert into a Mercator offset (equivalent to the shader's project_offset)
      const upd = [
        unitsPerDegree[0] + unitsPerDegree2[0] * latOffset,
        unitsPerDegree[1] + unitsPerDegree2[1] * latOffset,
        unitsPerDegree[2] + unitsPerDegree2[2] * latOffset,
      ];
      const mercX = lngOffset * upd[0];
      const mercY = latOffset * upd[1];

      // 3. viewProjectionMatrix * offset + projectionCenter
      // offset.w = 0, so the fourth column of the matrix has no effect
      const clipX = m[0] * mercX + m[4] * mercY + projectionCenter[0];
      const clipY = m[1] * mercX + m[5] * mercY + projectionCenter[1];
      const clipW = m[3] * mercX + m[7] * mercY + projectionCenter[3];

      // 4. Convert to NDC
      const ndcX = clipX / clipW;
      const ndcY = clipY / clipW;

      // 5. Convert to screen coordinates
      const screenX = (ndcX * 0.5 + 0.5) * viewport.width;
      const screenY = (1 - (ndcY * 0.5 + 0.5)) * viewport.height; // the Y axis is flipped

      return { x: screenX, y: screenY };
    },

    unproject: (point: { x: number; y: number }): { lng: number; lat: number } => {
      // The inverse transform: screen coordinates -> geographic coordinates

      // 1. Screen coordinates -> NDC
      const ndcX = (point.x / viewport.width) * 2 - 1;
      const ndcY = -((point.y / viewport.height) * 2 - 1); // the Y axis is flipped

      // The inverse transform is non-linear, so an approximate solution is found with
      // Newton's method
      // A linear approximation is used as the initial value

      // Estimate the initial clipW using the w component of projectionCenter
      const initialClipW = projectionCenter[3];

      // clipX = ndcX * clipW, clipY = ndcY * clipW
      // clipX = m[0]*mercX + m[4]*mercY + projectionCenter[0]
      // clipY = m[1]*mercX + m[5]*mercY + projectionCenter[1]
      // clipW = m[3]*mercX + m[7]*mercY + projectionCenter[3]

      // Initial estimate: solve the linear equations taking clipW ~= projectionCenter[3]
      const clipX0 = ndcX * initialClipW;
      const clipY0 = ndcY * initialClipW;

      // Find mercX and mercY (a 2x2 system of simultaneous equations)
      // m[0]*mercX + m[4]*mercY = clipX0 - projectionCenter[0]
      // m[1]*mercX + m[5]*mercY = clipY0 - projectionCenter[1]
      const det = m[0] * m[5] - m[1] * m[4];
      if (Math.abs(det) < 1e-10) {
        // Return the center for a singular matrix
        return { lng: centerLngLat[0], lat: centerLngLat[1] };
      }

      const bx = clipX0 - projectionCenter[0];
      const by = clipY0 - projectionCenter[1];
      const mercX = (m[5] * bx - m[4] * by) / det;
      const mercY = (m[0] * by - m[1] * bx) / det;

      // Mercator offset -> geographic coordinate offset (the inverse transform)
      // mercX = lngOffset * unitsPerDegree[0]
      // mercY = latOffset * (unitsPerDegree[1] + unitsPerDegree2[1] * latOffset)
      // Solve the quadratic equation

      const lngOffset = mercX / unitsPerDegree[0];

      // The quadratic equation in latOffset:
      // unitsPerDegree2[1] * latOffset^2 + unitsPerDegree[1] * latOffset - mercY = 0
      let latOffset: number;
      if (Math.abs(unitsPerDegree2[1]) < 1e-15) {
        // Linear approximation
        latOffset = mercY / unitsPerDegree[1];
      } else {
        const a = unitsPerDegree2[1];
        const b = unitsPerDegree[1];
        const c = -mercY;
        const discriminant = b * b - 4 * a * c;
        if (discriminant < 0) {
          latOffset = mercY / unitsPerDegree[1]; // fallback
        } else {
          // Choosing the sign: pick the smaller solution (the one closer to the center)
          const sqrtD = Math.sqrt(discriminant);
          const lat1 = (-b + sqrtD) / (2 * a);
          const lat2 = (-b - sqrtD) / (2 * a);
          latOffset = Math.abs(lat1) < Math.abs(lat2) ? lat1 : lat2;
        }
      }

      return {
        lng: centerLngLat[0] + lngOffset,
        lat: centerLngLat[1] + latOffset,
      };
    },
  };
}
