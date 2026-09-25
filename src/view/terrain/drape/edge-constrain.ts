// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Resolving T-junctions with neighboring tiles (edge constraints)
 *
 * At a terrain tile boundary the neighbors look the DEM up at different resolutions, so
 * vertices at the same position do not land at the same height and a crack opens. Constraining
 * the boundary vertices onto "the polyline of the coarser side" closes the T-junction whatever
 * the zoom difference is.
 *
 * The analytic drape of polygons and lines (renderer.ts) and the drape of textured quads
 * (quad.ts) share this constraint. Constraining only one of them results in the disagreement
 * "the polygons close but the image cracks" at the same boundary.
 */

import { TILE_EXTENT } from './mesh.js';
import type { DrapeTerrainTexture, UniformSet } from './shared.js';
import { toFloat32Matrix } from './shared.js';
import type { ResolvedEdge, ResolvedTileEdges } from './stitch.js';

/** The order of the edges (used to assemble the uniform names) */
export const EDGE_NAMES = ['top', 'bottom', 'left', 'right'] as const;
export type EdgeName = (typeof EDGE_NAMES)[number];

/**
 * The DEM texture unit per edge (one's own DEM is unit 0)
 *
 * 6 is not used. The DEM atlas (TERRAIN_ATLAS_TEXTURE_UNIT in state.ts) is bound to 6 at the
 * head of the frame and stays there, and every renderer of the vertex displacement path reads
 * it as u_dem_atlas as is. Overwriting it here would make whatever is drawn after the drape
 * rendering (a preview being drawn, dashed lines and so on) look elevations up in a broken
 * texture and fly off screen. 1 to 4 are used by the data textures (renderer.ts) and the
 * contents of the quads (quad.ts).
 */
export const EDGE_UNITS: Record<EdgeName, number> = { top: 5, bottom: 7, left: 8, right: 9 };

/** The mapping put into an edge with no coarse neighbor (unit scale, no translation) */
const IDENTITY_EDGE_TRANSFORM: readonly [number, number, number] = [1, 0, 0];

/** The uniform declarations for a single edge */
const edgeUniformDecl = (edge: EdgeName): string => `
uniform sampler2D u_edge_dem_${edge};
uniform mat4 u_edge_dem_matrix_${edge};
uniform vec4 u_edge_dem_unpack_${edge};
// (dim, scale, translation x, translation y)
uniform vec4 u_edge_dem_frame_${edge};`;

/**
 * The GLSL of the edge constraint (injected into the vertex shader)
 *
 * It goes after TERRAIN_SAMPLE_GLSL (because it uses u_terrain_exaggeration and the upstream DEM
 * functions it carries). The caller
 * obtains the constrained elevation with `drape_edge_constrained(a_pos, ele)`.
 */
export const EDGE_CONSTRAIN_GLSL = `
// The constraint step per edge (top, bottom, left, right). 0 means no constraint
uniform vec4 u_edge_step;
${EDGE_NAMES.map(edgeUniformDecl).join('')}

// Looks the elevation of this position up in the DEM of the coarser side
//
// One's own tile coordinates are mapped into the coarser side's tile coordinates first, and
// then read with the coarser side's DEM matrix and the upstream layout (upstream-terrain.ts). The
// mapping is a power-of-2 scale and a translation by an integer multiple of one mesh cell, so
// no error appears even in float and the nodes of the step land exactly on the coarser side's
// mesh nodes. In other words the value obtained here is bit-for-bit the same as the value the
// coarser side looks up at its own vertex.
float drape_edge_elevation(sampler2D dem, mat4 mtx, vec4 unpack, vec4 frame, vec2 pos) {
    vec2 q = pos * frame.y + frame.zw;
    vec2 coord = upstream_dem_coord((mtx * vec4(q, 0.0, 1.0)).xy, frame.x);
    return upstream_dem_bilinear(dem, unpack, coord) * u_terrain_exaggeration;
}

// Constrains the elevation onto the polyline of the coarser side (resolving the T-junction)
//
// The boundary is a straight line in tile coordinates, so only the elevation has to move. It
// is stepped at the coarser side's node spacing step, and the value linearly interpolated
// between the elevations at its two ends is used. This puts 2^dz vertices of the finer side on
// one segment of the coarser side, and the gap disappears whatever the level difference is.
//
// The elevation of a node is always taken from the coarser side's DEM. Taking it from one's
// own DEM would give not the coarser side's polyline but "a polyline stepping one's own DEM
// coarsely", which stays apart by the difference in DEM resolution (this is what is behind the
// thin line remaining at the tile boundary).
float drape_constrain(
    sampler2D dem, mat4 mtx, vec4 unpack, vec4 frame,
    vec2 pos, float along, float step, bool horizontal
) {
    float t0 = floor(along / step) * step;
    float t1 = min(t0 + step, ${TILE_EXTENT}.0);
    vec2 p0 = horizontal ? vec2(t0, pos.y) : vec2(pos.x, t0);
    vec2 p1 = horizontal ? vec2(t1, pos.y) : vec2(pos.x, t1);
    float e0 = drape_edge_elevation(dem, mtx, unpack, frame, p0);
    float e1 = drape_edge_elevation(dem, mtx, unpack, frame, p1);
    float w = t1 > t0 ? (along - t0) / (t1 - t0) : 0.0;
    return mix(e0, e1, w);
}

// A boundary vertex is constrained onto the coarser side's polyline only when the neighbor is
// coarser.
//
// The four corners belong to two edges. Whichever polyline they are put on, they cannot be
// made to agree with all three or more adjoining tiles (because each has its own DEM), so an
// order that looks at the top and bottom edges first is fixed. What disagrees is only the
// single point at the corner, and it closes within one mesh cell from there.
float drape_edge_constrained(vec2 pos, float ele) {
    if (pos.y <= 0.0 && u_edge_step.x > 0.0) {
        return drape_constrain(
            u_edge_dem_top, u_edge_dem_matrix_top, u_edge_dem_unpack_top, u_edge_dem_frame_top,
            pos, pos.x, u_edge_step.x, true);
    }
    if (pos.y >= ${TILE_EXTENT}.0 && u_edge_step.y > 0.0) {
        return drape_constrain(
            u_edge_dem_bottom, u_edge_dem_matrix_bottom, u_edge_dem_unpack_bottom,
            u_edge_dem_frame_bottom,
            pos, pos.x, u_edge_step.y, true);
    }
    if (pos.x <= 0.0 && u_edge_step.z > 0.0) {
        return drape_constrain(
            u_edge_dem_left, u_edge_dem_matrix_left, u_edge_dem_unpack_left, u_edge_dem_frame_left,
            pos, pos.y, u_edge_step.z, false);
    }
    if (pos.x >= ${TILE_EXTENT}.0 && u_edge_step.w > 0.0) {
        return drape_constrain(
            u_edge_dem_right, u_edge_dem_matrix_right, u_edge_dem_unpack_right,
            u_edge_dem_frame_right,
            pos, pos.y, u_edge_step.w, false);
    }
    return ele;
}
`;

/** The names of the uniforms the edge constraint uses (for getUniformLocation) */
export const EDGE_CONSTRAIN_UNIFORMS: readonly string[] = [
  'u_edge_step',
  ...EDGE_NAMES.flatMap((edge) => [
    `u_edge_dem_${edge}`,
    `u_edge_dem_matrix_${edge}`,
    `u_edge_dem_unpack_${edge}`,
    `u_edge_dem_frame_${edge}`,
  ]),
];

/**
 * Writes the uniforms of the edge constraint
 *
 * The step and the DEM are both written from one and the same value (the result of
 * resolveTileEdges). They all come out of the terrain tile state at one and the same instant,
 * so the inconsistency "the DEM is new but the step is old" cannot occur. An edge with no
 * coarse neighbor (an edge that is not constrained) gets one's own DEM at unit scale with a
 * translation of 0. It is never referenced because the step is 0, but leaving an unbound
 * sampler makes the rendering itself fail in some implementations.
 */
export function applyEdgeConstrainUniforms(
  gl: WebGL2RenderingContext,
  set: UniformSet,
  edges: ResolvedTileEdges<DrapeTerrainTexture>,
  own: DrapeTerrainTexture,
): void {
  if (set.u_edge_step) {
    gl.uniform4f(
      set.u_edge_step,
      edges.top?.step ?? 0,
      edges.bottom?.step ?? 0,
      edges.left?.step ?? 0,
      edges.right?.step ?? 0,
    );
  }
  for (const edge of EDGE_NAMES) {
    bindEdgeTerrain(gl, set, edge, edges[edge], own);
  }
}

/** Binds "the coarser side's DEM" for a single edge */
function bindEdgeTerrain(
  gl: WebGL2RenderingContext,
  set: UniformSet,
  edge: EdgeName,
  source: ResolvedEdge<DrapeTerrainTexture> | null,
  own: DrapeTerrainTexture,
): void {
  const terrain = source ? source.terrain : own;
  const transform: readonly [number, number, number] = source
    ? [source.transform.scale, source.transform.offsetX, source.transform.offsetY]
    : IDENTITY_EDGE_TRANSFORM;

  const unit = EDGE_UNITS[edge];
  gl.activeTexture(gl.TEXTURE0 + unit);
  gl.bindTexture(gl.TEXTURE_2D, terrain.texture);
  const sampler = set[`u_edge_dem_${edge}`];
  if (sampler) gl.uniform1i(sampler, unit);
  const matrix = set[`u_edge_dem_matrix_${edge}`];
  if (matrix) gl.uniformMatrix4fv(matrix, false, toFloat32Matrix(terrain.matrix));
  const unpack = set[`u_edge_dem_unpack_${edge}`];
  if (unpack) {
    const u = terrain.unpack;
    gl.uniform4f(unpack, u[0], u[1], u[2], u[3]);
  }
  const frame = set[`u_edge_dem_frame_${edge}`];
  if (frame) {
    gl.uniform4f(frame, terrain.dim, transform[0], transform[1], transform[2]);
  }
}
