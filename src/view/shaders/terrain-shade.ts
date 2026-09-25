// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Terrain shading applied to the polygon fill of the vertex displacement path
 *
 * There are two paths for laying a polygon fill onto the ground surface:
 * analytic drape (painting it as pixels of the ground surface) and vertex
 * displacement (lifting the vertices of the feature and painting them). The
 * path is switched by cost, so even on the same map it swaps over depending on
 * the camera angle and the amount of data. If the fill looks different between
 * the paths, the picture jumps at that switch. In practice it showed up as
 * "tilting makes relief appear on the polygon, and straightening it brings
 * back a uniform color".
 *
 * So the same shading as the analytic drape is applied to the fill of the
 * vertex displacement path as well. The formula shares the single place in
 * `terrain/shade.ts` (same light source, same normalization, same clamp); only
 * the way samples are taken differs. The drape reads the DEM in tile
 * coordinates, while this one reads the DEM atlas with the Mercator relative
 * coordinates handed over from the vertex.
 *
 * It is applied only to polygon fills. Lines, points, labels and handles are
 * left unshaded for readability (the same convention as the drape path).
 */

import { TERRAIN_SHADE_CORE_GLSL } from '../terrain/shade.js';
import { DEM_SAMPLE_GLSL } from './helpers.js';

/**
 * Vertex side: GLSL that hands over the sample position for the shading
 *
 * Place it after OFFSET_MODE_GLSL and call `emitShadeOffset(a_pos)` inside
 * main. A draw that does not call it leaves the varying undefined, so a shader
 * that has a fill must call it exactly once on every branch.
 */
export const TERRAIN_SHADE_VERTEX_GLSL = `
out vec2 v_shade_offset;

void emitShadeOffset(vec2 lngLatOffset) {
    v_shade_offset = shade_mercator_offset(lngLatOffset);
}
`;

/**
 * Fragment side: GLSL that produces the coefficient applied to the polygon fill
 *
 * `terrainFillShade()` returns 1.0 on flat ground and when terrain is
 * disabled. When terrain is disabled (`u_shade_strength` is 0) it returns
 * without reading the DEM, so the cost and the pixels are the same as before
 * terrain was introduced.
 *
 * The shading is applied even on frames that draw polygons and lines flat (the
 * zoomed-out band). Stopping the vertex displacement is a measure to avoid
 * cliffs; it does not mean the relief of the ground surface no longer needs to
 * be readable. If anything, that band is exactly the boundary where the paths
 * swap over.
 */
export const TERRAIN_SHADE_FRAGMENT_GLSL =
  `
in vec2 v_shade_offset;

// Shading (an aid for reading the terrain). Same light source and same formula as the ground,
// applied to the fill only
uniform vec3 u_light_dir;      // unit vector in the map coordinate system (east, north, up)
uniform float u_shade_strength;
` +
  DEM_SAMPLE_GLSL +
  TERRAIN_SHADE_CORE_GLSL +
  `
float terrainFillShade() {
    if (u_shade_strength <= 0.0) return 1.0;

    // The sample width is one texel of the DEM atlas. rect.zw = 1/width, 1/height
    // (Mercator), so the Mercator width of a texel is 1/(rect.zw * size).
    vec2 texel = 1.0 / max(u_dem_atlas_rect.zw * u_dem_atlas_size, vec2(1e-9));

    // The ground distance of Mercator 1.0 (meters). It is exactly the reciprocal of the
    // meters -> Mercator z coefficient (u_elevation_params.x). It uses the same value as the
    // conversion applied when the vertex adds the elevation, so the unit of the gradient
    // never drifts.
    float meters = 1.0 / max(u_elevation_params.x, 1e-12);

    // Outside the atlas, the clamp in dem_elevation_meters returns the edge value. The
    // gradient goes thin there, but since the atlas covers the terrain tiles in view, this
    // does not happen in the range where the polygon fill is applied (only the coarse tiles
    // on the horizon side fall outside the range).
    float ex1 = dem_elevation_meters(v_shade_offset + vec2(texel.x, 0.0));
    float ex0 = dem_elevation_meters(v_shade_offset - vec2(texel.x, 0.0));
    float ey1 = dem_elevation_meters(v_shade_offset + vec2(0.0, texel.y));
    float ey0 = dem_elevation_meters(v_shade_offset - vec2(0.0, texel.y));

    float dzdEast = (ex1 - ex0) / (2.0 * texel.x * meters);
    // Mercator y points south, so flip north
    float dzdNorth = -(ey1 - ey0) / (2.0 * texel.y * meters);
    return terrainShadeFromGradient(dzdEast, dzdNorth);
}
`;
