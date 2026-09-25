// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * How maplibre lays out a DEM tile, reads it on the GPU and measures elevations (the one copy
 * the engine keeps)
 *
 * A custom layer does not receive the `TERRAIN3D` part of maplibre's vertex prelude
 * (maplibre-coupling.md, item 2), so the engine reads maplibre's DEM textures with its own
 * shaders: the drape (`drape/shared.ts`, `drape/edge-constrain.ts`) and the DEM atlas
 * (`dem-atlas.ts`). Whatever those shaders must assume about the upstream layout is written
 * here and nowhere else, so an upstream change is one edit.
 *
 * Copied from maplibre-gl-js 6.11.1:
 *
 * - `src/data/dem_data.ts`, `DEMData`: the texture of a DEM tile is `dim + 4` texels on a
 *   side, the `dim` pixels of the tile behind a border of 2 texels on every side
 *   (`dim = data.height - 4` at line 54, `_idx` at line 140). `backfillBorder` (line 157) fills
 *   the border from the neighbouring tiles, and until a neighbour arrives it repeats the edge
 *   pixels (line 83).
 * - `src/shaders/glsl/_prelude.vertex.glsl`, `ele` and `get_elevation` (lines 137 to 169): a
 *   tile position is mapped by `u_terrain_matrix` into the unit square of the DEM tile and the
 *   texel coordinate is `uv * u_terrain_dim + 1.5` (DEM pixel i describes the cell centred at
 *   `(i + 0.5) / dim` and sits at texel `i + 2`). The four texels around it are fetched with
 *   `texelFetch`, clamped to the texture, decoded with `u_terrain_unpack` and interpolated
 *   bilinearly by hand (an encoded DEM cannot be interpolated by the sampler), then multiplied
 *   by `u_terrain_exaggeration`.
 * - `src/geo/lng_lat.ts`, `earthRadius = 6371008.8` (line 8), and
 *   `src/geo/mercator_coordinate.ts`, `circumferenceAtLatitude` (line 14): the sphere an
 *   elevation in meters is turned into Mercator units on (`mercatorZfromAltitude`), which is
 *   how maplibre scales its terrain mesh and `map.project`. It is not the WGS84 equator the
 *   geometry of the engine measures distances on; the 0.1 % between them is a pixel at the
 *   top of a high, exaggerated mountain.
 * - `src/render/terrain.ts`, `getElevationSampler` (line 324, `DEM_CELL_CENTER_OFFSET = -0.5`
 *   at line 60): the CPU sampler places the pixels the same way, and it is what
 *   `map.queryTerrainElevation` returns where the terrain is drawn. The engine's CPU side reads
 *   that function (`ground.ts`) and copies nothing of it.
 *
 * Up to maplibre 6.7 the border was one texel and the offset `+ 1.0` (the pixels sat on the
 * cell corners); 6.8.0 and 6.9.1 changed both (the move to the cell centres is
 * maplibre-gl-js#8420). The end-to-end test `src/e2e/terrain.e2e.test.ts` compares what
 * these shaders read with `map.queryTerrainElevation`, and the projection of the anchors
 * (which uses the sphere through `metrics.ts`) with `map.project`, on a known DEM, and fails
 * when they part.
 */

/**
 * The circumference of the sphere maplibre turns elevations into Mercator units on (meters),
 * `2 * PI * earthRadius`
 */
export const UPSTREAM_EARTH_CIRCUMFERENCE_METERS = 2 * Math.PI * 6371008.8;

/** The border around the pixels of a DEM tile, in texels on each side */
export const DEM_BORDER_TEXELS = 2;

/**
 * What is added to `uv * dim` to get the texel coordinate of a position (the border, less half
 * a texel because pixels are centred on their cells)
 */
export const DEM_TEXEL_OFFSET = DEM_BORDER_TEXELS - 0.5;

/**
 * The texel coordinate of a position of the DEM tile (the same formula as `get_elevation`)
 *
 * @param uv The position in the unit square of the DEM tile
 * @param dim The number of pixels of the DEM tile on a side (`u_terrain_dim`)
 */
export function demTexelCoord(uv: number, dim: number): number {
  return uv * dim + DEM_TEXEL_OFFSET;
}

/**
 * The texel coordinate of the last texel of a DEM texture (the far end of the border)
 *
 * A bilinear sample needs the texel at `floor(coord) + 1`, so real data is read only for
 * texel coordinates in `[0, demLastTexel(dim)]`; beyond it the clamp repeats the last texel.
 *
 * @param dim The number of pixels of the DEM tile on a side
 */
export function demLastTexel(dim: number): number {
  return dim + 2 * DEM_BORDER_TEXELS - 1;
}

/** A number as a GLSL float literal */
function glslFloat(value: number): string {
  return Number.isInteger(value) ? `${value}.0` : `${value}`;
}

/**
 * The GLSL of the upstream DEM layout, for both shader stages
 *
 * - `upstream_dem_coord(uv, dim)`: the texel coordinate of a position ({@link demTexelCoord})
 * - `upstream_dem_last_texel(dim)`: {@link demLastTexel}
 * - `upstream_dem_bilinear(dem, unpack, coord)`: the elevation at a texel coordinate, in
 *   meters before the exaggeration (the body of `get_elevation`)
 *
 * The functions take the texture and its unpack vector as arguments, so the drape can also
 * read the DEM of a neighbouring tile with them (`edge-constrain.ts`).
 */
export const UPSTREAM_DEM_GLSL = `
vec2 upstream_dem_coord(vec2 uv, float dim) {
    return uv * dim + ${glslFloat(DEM_TEXEL_OFFSET)};
}

float upstream_dem_last_texel(float dim) {
    return dim + ${glslFloat(2 * DEM_BORDER_TEXELS - 1)};
}

float upstream_dem_ele(sampler2D dem, vec4 unpack, ivec2 pos) {
    vec4 rgb = (texelFetch(dem, pos, 0) * 255.0) * unpack;
    return rgb.r + rgb.g + rgb.b - unpack.a;
}

float upstream_dem_bilinear(sampler2D dem, vec4 unpack, vec2 coord) {
    vec2 f = fract(coord);
    ivec2 c = ivec2(floor(coord));
    ivec2 hi = textureSize(dem, 0) - 1;
    float tl = upstream_dem_ele(dem, unpack, clamp(c, ivec2(0), hi));
    float tr = upstream_dem_ele(dem, unpack, clamp(c + ivec2(1, 0), ivec2(0), hi));
    float bl = upstream_dem_ele(dem, unpack, clamp(c + ivec2(0, 1), ivec2(0), hi));
    float br = upstream_dem_ele(dem, unpack, clamp(c + ivec2(1, 1), ivec2(0), hi));
    return mix(mix(tl, tr, f.x), mix(bl, br, f.x), f.y);
}
`;
