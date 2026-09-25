// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only AND BSD-3-Clause

/**
 * The shared parts of the analytic drape
 *
 * There are two passes that draw the ground (`renderer.ts`, which paints the polygons and
 * lines of features, and `quad.ts`, which pastes textured quads). Both are completely
 * identical up to "drawing a terrain mesh with the same rules as MapLibre, with the same DEM
 * and the same projection"; the only difference is what they solve in the fragment. The common
 * part is placed here, which structurally guarantees that the two passes sit on the same
 * ground.
 */

import type { ProjectionData } from 'maplibre-gl';
import { TERRAIN_SHADE_CORE_GLSL } from '../shade.js';
import { demLastTexel, UPSTREAM_DEM_GLSL } from '../upstream-terrain.js';
import { TILE_EXTENT } from './mesh.js';

/**
 * The GLSL that samples the DEM (used in both the vertex and the fragment stage)
 *
 * It does what the #ifdef TERRAIN3D section of MapLibre's vertex prelude does (the prelude
 * handed to a CustomLayer contains only the projection part and not this section). The layout
 * of the DEM texture is maplibre's and is copied once, in `upstream-terrain.ts`. Since the
 * elevation is looked up the same way, with the same DEM and the same grid, our own mesh
 * agrees with MapLibre's terrain surface.
 */
export const TERRAIN_SAMPLE_GLSL = `
uniform sampler2D u_terrain;
uniform float u_terrain_dim;
uniform mat4 u_terrain_matrix;
uniform vec4 u_terrain_unpack;
uniform float u_terrain_exaggeration;
${UPSTREAM_DEM_GLSL}
// The texel coordinate of a tile position in this tile's DEM
vec2 drape_dem_coord(vec2 pos) {
    return upstream_dem_coord((u_terrain_matrix * vec4(pos, 0.0, 1.0)).xy, u_terrain_dim);
}

float drape_get_elevation(vec2 pos) {
    return upstream_dem_bilinear(u_terrain, u_terrain_unpack, drape_dem_coord(pos)) *
        u_terrain_exaggeration;
}
`;

/**
 * The GLSL of the terrain shading (an aid to reading the map)
 *
 * It builds the gradient from differences between neighboring DEM samples and hands it to the
 * shared formula (`TERRAIN_SHADE_CORE_GLSL` in `terrain/shade.ts`). All this takes charge of
 * is how the samples are taken. The vertex displacement path
 * (`shaders/terrain-shade.ts`) hands samples taken from the atlas to the same formula.
 *
 * The caller must declare `u_light_dir` (east, north and up in the map coordinate system),
 * `u_shade_strength` and `u_tile_meters` (the ground size of that tile). It goes after
 * TERRAIN_SAMPLE_GLSL.
 */
export const TERRAIN_SHADE_GLSL =
  TERRAIN_SHADE_CORE_GLSL +
  `
float terrainShade(vec2 tilePos) {
    if (u_shade_strength <= 0.0) return 1.0;
    float texel = ${TILE_EXTENT}.0 / max(u_terrain_dim, 1.0);
    vec2 pos = tilePos * ${TILE_EXTENT}.0;

    // The samples for the gradient are kept within the range where DEM texels exist.
    //
    // A render tile reads only a part of its DEM tile (deltaZoom = 1), and at the far end of
    // the DEM texture the forward sample may run past the last texel. Reading outside the
    // range makes the clamp in upstream_dem_bilinear return the border value, the sample
    // freezes and the gradient becomes too small. The band where it shrinks fails to receive
    // its shading, floats brightly and shows up as a streak of 1 to 2 pixels along the tile
    // boundary.
    //
    // What is kept in is only the place where the texels really run out. Everywhere else real
    // data continues both forward and backward, so the width stays at its full value.
    vec2 coord = drape_dem_coord(pos);
    // The advance of coord per 1 tile coordinate (the diagonal of the DEM matrix x the DEM
    // dimension)
    vec2 perUnit = max(
        vec2(u_terrain_matrix[0].x, u_terrain_matrix[1].y) * u_terrain_dim,
        vec2(1e-9));
    vec2 forward = clamp(
        (vec2(upstream_dem_last_texel(u_terrain_dim)) - coord) / perUnit, vec2(0.0), vec2(texel));
    vec2 backward = clamp(coord / perUnit, vec2(0.0), vec2(texel));

    float ex1 = drape_get_elevation(vec2(pos.x + forward.x, pos.y));
    float ex0 = drape_get_elevation(vec2(pos.x - backward.x, pos.y));
    float ey1 = drape_get_elevation(vec2(pos.x, pos.y + forward.y));
    float ey0 = drape_get_elevation(vec2(pos.x, pos.y - backward.y));
    // 1.0 in within-tile coordinates corresponds to u_tile_meters. y points south, so north is
    // flipped. What it is divided by is "the width actually used" (dividing by anything other
    // than the shrunk width makes the gradient too thin)
    vec2 span =
        max(forward + backward, vec2(1e-4)) / ${TILE_EXTENT}.0 * max(u_tile_meters, 1.0);
    float dzdEast = (ex1 - ex0) / span.x;
    float dzdNorth = -(ey1 - ey0) / span.y;
    return terrainShadeFromGradient(dzdEast, dzdNorth);
}
`;

/**
 * The width of the samples taken for the shading gradient (in tile coordinates)
 *
 * The authority for the implementation is TERRAIN_SHADE_GLSL, but the formula itself is also
 * placed here as a pure function so that it can be verified. The DEM texels exist only in
 * [0, demLastTexel(dim)] of coord space (the border texels at both ends are copied from the
 * neighboring tiles, `upstream-terrain.ts`), so a width that goes outside that cannot be used.
 *
 * @param coord The coord of the current position (in texel space)
 * @param coordPerUnit The advance of coord per 1 tile coordinate
 * @param want The width one wants to use (in tile coordinates)
 * @param dim The dimension of the DEM
 */
export function drapeShadeWindow(
  coord: number,
  coordPerUnit: number,
  want: number,
  dim: number,
): { back: number; forward: number } {
  const perUnit = Math.max(coordPerUnit, 1e-9);
  const clampWidth = (value: number): number => Math.min(Math.max(value, 0), want);
  return {
    back: clampWidth(coord / perUnit),
    forward: clampWidth((demLastTexel(dim) - coord) / perUnit),
  };
}

/** The names of the projection uniforms (declared by the prelude) */
export const DRAPE_PROJECTION_UNIFORMS = [
  'u_projection_matrix',
  'u_projection_tile_mercator_coords',
  'u_projection_clipping_plane',
  'u_projection_transition',
  'u_projection_fallback_matrix',
] as const;

/** The names of the DEM uniforms (declared by TERRAIN_SAMPLE_GLSL) */
export const DRAPE_TERRAIN_UNIFORMS = [
  'u_terrain',
  'u_terrain_dim',
  'u_terrain_matrix',
  'u_terrain_unpack',
  'u_terrain_exaggeration',
] as const;

/** The index of uniform locations */
export type UniformSet = Record<string, WebGLUniformLocation | null>;

/**
 * Writes that tile's ProjectionData into the uniforms
 */
export function applyDrapeProjectionUniforms(
  gl: WebGL2RenderingContext,
  set: UniformSet,
  projectionData: ProjectionData,
): void {
  if (set.u_projection_matrix) {
    gl.uniformMatrix4fv(set.u_projection_matrix, false, projectionData.mainMatrix);
  }
  if (set.u_projection_tile_mercator_coords && projectionData.tileMercatorCoords) {
    gl.uniform4fv(set.u_projection_tile_mercator_coords, projectionData.tileMercatorCoords);
  }
  if (set.u_projection_clipping_plane && projectionData.clippingPlane) {
    gl.uniform4fv(set.u_projection_clipping_plane, projectionData.clippingPlane);
  }
  if (set.u_projection_transition) {
    gl.uniform1f(set.u_projection_transition, projectionData.projectionTransition ?? 0);
  }
  if (set.u_projection_fallback_matrix && projectionData.fallbackMatrix) {
    gl.uniformMatrix4fv(set.u_projection_fallback_matrix, false, projectionData.fallbackMatrix);
  }
}

/** The parts of a DEM texture set that are needed */
export interface DrapeTerrainTexture {
  texture: WebGLTexture;
  matrix: ArrayLike<number>;
  unpack: ArrayLike<number>;
  dim: number;
  /** The vertical exaggeration of the terrain (the same factor MapLibre's mesh uses) */
  exaggeration: number;
}

/**
 * Binds the DEM and writes it into the uniforms (bound the same way as MapLibre's terrain
 * prelude)
 *
 * The exaggeration is the one MapLibre applies to its own terrain mesh, so the drape surface
 * stays on the map's ground surface (`getTerrainExaggeration` in `detect.ts`).
 */
export function applyDrapeTerrainUniforms(
  gl: WebGL2RenderingContext,
  set: UniformSet,
  terrain: DrapeTerrainTexture,
  unit: number,
): void {
  gl.activeTexture(gl.TEXTURE0 + unit);
  gl.bindTexture(gl.TEXTURE_2D, terrain.texture);
  if (set.u_terrain) gl.uniform1i(set.u_terrain, unit);
  if (set.u_terrain_dim) gl.uniform1f(set.u_terrain_dim, terrain.dim);
  if (set.u_terrain_matrix) {
    gl.uniformMatrix4fv(set.u_terrain_matrix, false, toFloat32Matrix(terrain.matrix));
  }
  if (set.u_terrain_unpack) {
    const u = terrain.unpack;
    gl.uniform4f(set.u_terrain_unpack, u[0], u[1], u[2], u[3]);
  }
  if (set.u_terrain_exaggeration) gl.uniform1f(set.u_terrain_exaggeration, terrain.exaggeration);
}

/** ArrayLike into a 4x4 Float32Array */
export function toFloat32Matrix(source: ArrayLike<number>): Float32Array {
  const out = new Float32Array(16);
  for (let i = 0; i < 16; i++) out[i] = source[i];
  return out;
}
