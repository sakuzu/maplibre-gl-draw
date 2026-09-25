// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Analytic drape for textured quads
 *
 * An Image (a picture pasted onto the map) and a quad with a fill and text are features that
 * "fill the inside of a rectangle determined by four corners". Previously only
 * those 4 vertices were drawn as a TRIANGLE_STRIP, so wherever the terrain rose
 * above the plane spanned by the four corners it always cut through. The essence
 * of the problem is the absence of subdivision, so turning off the depth test does
 * not fix it (turning it off instead makes images behind a ridge show through).
 *
 * Here we solve it with the same idea as for polygons and lines. We draw a terrain
 * mesh built by the same rules as MapLibre's, and for each pixel solve "is this
 * ground point inside the quad" by inverse bilinear interpolation; if it is inside,
 * the resulting (u, v) determines the content. Because it is painted as ground
 * pixels, burying and dropouts cannot occur by construction, occlusion follows
 * directly from the depth of the terrain mesh, and shading is applied with the same
 * formula as the fill.
 *
 * There are two ways of deciding the content.
 *
 * - Image (`drawQuad`). The texture is looked up with (u, v)
 * - Fill + text (`drawSurface`). The fill is a rectangle (color + border)
 *   produced analytically, and the text looks up the glyph's occupancy rectangle
 *   from (u, v) within the same per-pixel evaluation and references the SDF atlas.
 *   Because the fill and the text become pixels of a single surface, no
 *   subdivision mismatch between the two can occur, and since SDF is
 *   resolution-independent the text stays crisp even on a huge quad
 *
 * Because quads are few in number, textures are bound one at a time in draw order
 * (there is no need to pack styles into a texture as for polygons and lines).
 */

import type { ProjectionData } from 'maplibre-gl';
import { setDepthTestEnabled } from '../../layer/depth-state.js';
import type { ShaderData } from '../../shaders/helpers.js';
import { createProgram } from '../../shaders/helpers.js';
import type { RenderableTerrainTile, TerrainTileData } from '../detect.js';
import { circumferenceAtLatitude, tileCenterLatitude } from '../metrics.js';
import {
  applyEdgeConstrainUniforms,
  EDGE_CONSTRAIN_GLSL,
  EDGE_CONSTRAIN_UNIFORMS,
} from './edge-constrain.js';
import {
  createTerrainMeshBuffers,
  disposeTerrainMeshBuffers,
  type TerrainMeshBuffers,
  TILE_EXTENT,
} from './mesh.js';
import { binQuadGlyphs } from './quad-glyphs.js';
import { DRAPE_LIFT_RATIO, type DrapeLight } from './renderer.js';
import {
  applyDrapeProjectionUniforms,
  applyDrapeTerrainUniforms,
  DRAPE_PROJECTION_UNIFORMS,
  DRAPE_TERRAIN_UNIFORMS,
  TERRAIN_SAMPLE_GLSL,
  TERRAIN_SHADE_GLSL,
  type UniformSet,
} from './shared.js';
import { buildTileKeySet, resolveTileEdges, wrappedTileKey } from './stitch.js';

/** Texture units */
const UNIT_TERRAIN = 0;
const UNIT_TEXTURE = 1;
const UNIT_ATLAS = 2;
const UNIT_GLYPH = 3;
const UNIT_BIN = 4;

/** Width of the glyph data texture (texels). Even, because one glyph takes 2 texels */
const GLYPH_TEX_WIDTH = 256;

/** Number of glyph data textures kept (LRU) */
const GLYPH_CACHE_LIMIT = 64;

/**
 * The (u, v) that represents "there is no solution"
 *
 * It is merely a value that tips the test to "outside the range". Because fwidth
 * must be taken under uniform control flow, failure is expressed as a value rather
 * than by discard. An extremely large value would make the derivatives of
 * neighboring pixels blow up, so it is kept just large enough to be recognized as
 * outside the range.
 */
const OUTSIDE_UV = -8;

/** The four corners of a quad to drape on the terrain, each `[lng, lat]` in degrees. */
export interface DrapeQuadCorners {
  /** The corner at local (0, 0) */
  readonly topLeft: readonly [number, number];
  /** The corner at local (1, 0) */
  readonly topRight: readonly [number, number];
  /** The corner at local (0, 1) */
  readonly bottomLeft: readonly [number, number];
  /** The corner at local (1, 1) */
  readonly bottomRight: readonly [number, number];
}

/** A color as RGBA, each 0..1, not premultiplied. */
export type QuadDrapeColor = readonly [number, number, number, number];

/**
 * The fill of a draped quad: a background color and a border.
 *
 * Painted analytically instead of being baked into a Canvas. The border occupies
 * "borderWidth inward", the same extent as Canvas's
 * `strokeRect(bw/2, bw/2, w - bw, h - bw)`.
 */
export interface QuadDrapeFill {
  /** Background color */
  readonly color: QuadDrapeColor;
  /** Border color */
  readonly borderColor: QuadDrapeColor;
  /** Border width (in the quad's local 0..1 coordinates. Separate for x and y) */
  readonly border: readonly [number, number];
}

/**
 * The text of a draped quad, as glyphs of an SDF atlas the caller owns.
 *
 * The glyph atlas owned by the caller is referenced as is. It is not
 * held a second time here.
 */
export interface QuadDrapeGlyphs {
  /** The texture of the SDF atlas */
  readonly atlas: WebGLTexture;
  /** Width of the atlas (texels) */
  readonly atlasWidth: number;
  /** Height of the atlas (texels) */
  readonly atlasHeight: number;
  /**
   * Glyph array (8 elements per glyph)
   *
   * The occupancy rectangle (x0, y0, x1, y1) is in the quad's local 0..1
   * coordinates, and the following 4 elements are the atlas UV (u0, v0, u1, v1).
   */
  readonly glyphs: Float32Array;
  /** Number of glyphs */
  readonly glyphCount: number;
  /** Key telling whether repacking is needed (content, style, size, atlas version) */
  readonly key: string;
  /** Number of atlas texels per 1 unit of local coordinates (x, y) */
  readonly atlasTexelsPerUnit: readonly [number, number];
  /** Color of the letterform */
  readonly color: QuadDrapeColor;
  /** Color of the halo (outline) */
  readonly haloColor: QuadDrapeColor;
  /** Width of the halo (in units of the SDF value. 0 means no halo) */
  readonly haloWidth: number;
  /** Isosurface of the letterform (SDF value) */
  readonly edge: number;
  /** Change of the SDF value per atlas texel (= 1 / the radius of the distance field) */
  readonly valuePerTexel: number;
  /** Bias for mip selection (negative is toward the sharper side) */
  readonly lodBias: number;
}

/** What {@link drawQuadSurfaceOnTerrain} paints inside a quad: a fill and optional text. */
export interface QuadDrapeSurface {
  /** The fill (background and border) */
  readonly fill: QuadDrapeFill;
  /** Text (null if there is none) */
  readonly text: QuadDrapeGlyphs | null;
}

/**
 * What is required in this frame to paste a quad onto the ground surface
 *
 * CustomLayer assembles it every frame and puts it into `terrain/state`, and
 * QuadShader reads it when drawing. The per-tile DEM and ProjectionData are passed
 * as "lookup functions". While the DEM of the target zoom has not arrived MapLibre
 * returns the parent tile's texture and matrix, and replaces them the moment the
 * real one arrives, so they must not be baked in (the polygon and line drape fell
 * into the same trap).
 */
export interface QuadDrapeFrame {
  /** Owner of the GPU resources (owned by CustomLayer) */
  readonly renderer: QuadDrapeRenderer;
  /** The shader variant for this frame */
  readonly shaderData: ShaderData;
  /** The terrain tiles to draw */
  readonly tiles: readonly RenderableTerrainTile[];
  /** The DEM of a single tile (null if it has not arrived) */
  getTerrainData(tile: RenderableTerrainTile): TerrainTileData | null;
  /** The ProjectionData of a single tile (null if it cannot be obtained) */
  getProjectionData(tile: RenderableTerrainTile): ProjectionData | null;
  /** Subdivision count of the terrain mesh */
  readonly meshSize: number;
  /** Light source of the shading (the same one as the polygon fill) */
  readonly light: DrapeLight;
  /**
   * Whether to leave the depth test enabled after drawing has finished
   *
   * It changes partway through a frame (on through the layer drawing, off from the
   * selection UI onward), so only this field is mutable.
   */
  keepDepthTest: boolean;
}

const VERTEX_SOURCE = (prelude: string, define: string): string => `#version 300 es
${prelude}
${define}
layout(location = 0) in vec2 a_pos;
// A very slight lift from the ground surface (meters), so that boundary vertices
// lowered by edge constraining do not lose to the terrain mesh in depth (the same
// amount as the polygon and line drape)
uniform float u_drape_lift_m;
out vec2 v_tile;
${TERRAIN_SAMPLE_GLSL}
${EDGE_CONSTRAIN_GLSL}
void main() {
    // A boundary vertex is constrained to the coarser side's polyline only when the
    // neighbor is coarser (edge-constrain.ts). Without the constraint it sits at a
    // height different from the neighboring tile at an LOD boundary and a crack
    // opens (skirts are not used, so the crack shows on screen as it is)
    float ele = drape_edge_constrained(a_pos, drape_get_elevation(a_pos));
    gl_Position = projectTileWithElevation(a_pos, ele + u_drape_lift_m);
    v_tile = a_pos / ${TILE_EXTENT}.0;
}`;

/** Inverse bilinear interpolation and other parts used by both fragment shaders */
const QUAD_UV_GLSL = `
float cross2(vec2 a, vec2 b) {
    return a.x * b.y - a.y * b.x;
}

/**
 * Inverse bilinear interpolation (a point -> the (u, v) inside the quad)
 *
 * Solves the bilinear map P(u, v) = a + u(b - a) + v(d - a) + uv(a - b + c - d)
 * for (u, v). v is a root of a quadratic equation, and to avoid loss of
 * significance it is solved in the sign-aligned form
 * (q = -(k1 + sign(k1)*sqrt(D))/2, with the roots k0/q and q/k2).
 * Even when it degenerates into a parallelogram (k2 = 0), k0/q is directly the
 * linear solution.
 *
 * Because a quad is a "rotated rectangle normalized by the latitude scale", on the
 * Mercator plane it becomes nearly a parallelogram, so in practice the linear
 * branch is taken.
 */
vec2 quadUV(vec2 p) {
    vec2 e = u_quad_b - u_quad_a;
    vec2 f = u_quad_d - u_quad_a;
    vec2 g = u_quad_a - u_quad_b + u_quad_c - u_quad_d;
    vec2 h = p - u_quad_a;

    float k2 = cross2(g, f);
    float k1 = cross2(h, g) + cross2(e, f);
    float k0 = cross2(h, e);

    if (abs(k1) < 1e-30 && abs(k2) < 1e-30) return vec2(${OUTSIDE_UV}.0);

    float disc = k1 * k1 - 4.0 * k0 * k2;
    if (disc < 0.0) return vec2(${OUTSIDE_UV}.0);
    float root = sqrt(disc);
    float q = -0.5 * (k1 + (k1 >= 0.0 ? root : -root));

    float v1 = (q != 0.0) ? (k0 / q) : ${OUTSIDE_UV}.0;
    float v2 = (k2 != 0.0) ? (q / k2) : ${OUTSIDE_UV}.0;
    float v = (abs(v1 - 0.5) <= abs(v2 - 0.5)) ? v1 : v2;

    vec2 den = e + g * v;
    vec2 num = h - f * v;
    if (abs(den.x) < 1e-30 && abs(den.y) < 1e-30) return vec2(${OUTSIDE_UV}.0);
    float u = (abs(den.x) >= abs(den.y)) ? (num.x / den.x) : (num.y / den.y);
    return vec2(u, v);
}
`;

/** Uniform declarations for the quad's four corners and for the shading */
const QUAD_COMMON_UNIFORMS_GLSL = `
// The four corners of the quad (in this tile's 0..1 coordinates. They may lie
// outside the tile)
uniform vec2 u_quad_a;   // top left
uniform vec2 u_quad_b;   // top right
uniform vec2 u_quad_c;   // bottom right
uniform vec2 u_quad_d;   // bottom left
uniform float u_opacity;
// Shading (an aid to reading the terrain). The same light source and the same
// formula as the polygon fill.
uniform vec3 u_light_dir;
uniform float u_shade_strength;
uniform float u_tile_meters;
`;

/** The fragment shader that pastes an image */
const IMAGE_FRAGMENT_SOURCE =
  `#version 300 es
precision highp float;
precision highp sampler2D;

in vec2 v_tile;

${QUAD_COMMON_UNIFORMS_GLSL}
uniform sampler2D u_texture;

out vec4 fragColor;

` +
  TERRAIN_SAMPLE_GLSL +
  TERRAIN_SHADE_GLSL +
  QUAD_UV_GLSL +
  `
void main() {
    // Take the derivatives before entering a branch (under uniform control flow)
    vec2 uv = quadUV(v_tile);
    vec2 w = max(fwidth(uv), vec2(1e-8));

    // The edge is smoothed with one pixel of coverage (the billboard's edge does
    // not turn jagged)
    vec2 cover = clamp((0.5 - abs(uv - 0.5)) / w + 0.5, 0.0, 1.0);
    float coverage = cover.x * cover.y;
    if (coverage <= 0.0) discard;

    vec4 color = texture(u_texture, clamp(uv, 0.0, 1.0));
    float alpha = color.a * u_opacity * coverage;
    if (alpha <= 0.0) discard;

    fragColor = vec4(color.rgb * terrainShade(v_tile), alpha);
}`;

/**
 * The fragment shader that paints fill + text
 *
 * The fill is a rectangular fill, and the text references the SDF atlas at the
 * same pixel. Compositing is accumulated premultiplied and converted back to
 * straight at the end (because the frame's blend state is `applyDrawBlendState`
 * = RGB straight, A additive).
 *
 * Shading is applied only to the fill. The text gives priority to legibility and
 * is unshaded, just like labels, lines and points.
 */
const SURFACE_FRAGMENT_SOURCE =
  `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;

in vec2 v_tile;

${QUAD_COMMON_UNIFORMS_GLSL}

// Fill
uniform vec4 u_fill_color;
uniform vec4 u_border_color;
uniform vec2 u_border;

// Text (u_grid = 0 means there is no text)
uniform sampler2D u_atlas;
uniform sampler2D u_glyph_tex;
uniform sampler2D u_bin_tex;
uniform int u_glyph_tex_width;
uniform int u_grid;
uniform vec2 u_atlas_size;
uniform vec2 u_atlas_texels;
uniform vec4 u_text_color;
uniform vec4 u_halo_color;
uniform float u_halo_width;
uniform float u_sdf_edge;
uniform float u_sdf_value_per_texel;
uniform float u_lod_scale;

out vec4 fragColor;

` +
  TERRAIN_SAMPLE_GLSL +
  TERRAIN_SHADE_GLSL +
  QUAD_UV_GLSL +
  `
vec4 fetchGlyph(int i) {
    return texelFetch(u_glyph_tex, ivec2(i % u_glyph_tex_width, i / u_glyph_tex_width), 0);
}

// Compose on top (premultiplied alpha)
vec4 over(vec4 below, vec3 rgb, float a) {
    return vec4(rgb * a + below.rgb * (1.0 - a), a + below.a * (1.0 - a));
}

void main() {
    // Take the derivatives before entering a branch (under uniform control flow)
    vec2 uv = quadUV(v_tile);
    vec2 dux = dFdx(uv);
    vec2 duy = dFdy(uv);
    vec2 w = max(abs(dux) + abs(duy), vec2(1e-8));

    vec2 cover = clamp((0.5 - abs(uv - 0.5)) / w + 0.5, 0.0, 1.0);
    float coverage = cover.x * cover.y;
    if (coverage <= 0.0) discard;

    // --- Fill (background + border) ---
    bool onBorder = uv.x < u_border.x || uv.x > 1.0 - u_border.x
                 || uv.y < u_border.y || uv.y > 1.0 - u_border.y;
    vec4 fill = onBorder ? u_border_color : u_fill_color;
    float shade = terrainShade(v_tile);
    vec4 acc = vec4(fill.rgb * shade * fill.a, fill.a);

    // --- Text (references the SDF atlas) ---
    if (u_grid > 0) {
        // The gradient in atlas space. It is constant regardless of the glyph, so
        // it is taken only once outside the branch. Derivatives cannot be used
        // inside a branch, so texture lookups pass this gradient explicitly with
        // textureGrad (the mip bias is expressed by shrinking the gradient).
        vec2 tx = dux * u_atlas_texels;
        vec2 ty = duy * u_atlas_texels;
        vec2 gx = tx / u_atlas_size * u_lod_scale;
        vec2 gy = ty / u_atlas_size * u_lod_scale;
        float texelsPerPixel = sqrt(dot(tx, tx) + dot(ty, ty));
        float gamma = max(0.5 * texelsPerPixel * u_sdf_value_per_texel, 0.001);

        float gridF = float(u_grid);
        ivec2 cell = ivec2(clamp(floor(uv * gridF), 0.0, gridF - 1.0));
        vec4 bin = texelFetch(u_bin_tex, cell, 0);
        int start = int(bin.x);
        int count = int(bin.y);

        // For overlapping glyphs the maximum of the distance field is taken (this
        // combines them in the same way as drawing all halos and then all
        // letterforms in two passes)
        float dist = 0.0;
        for (int i = 0; i < count; i++) {
            int slot = (start + i) * 2;
            vec4 rect = fetchGlyph(slot);
            if (uv.x < rect.x || uv.x > rect.z || uv.y < rect.y || uv.y > rect.w) continue;
            vec4 auv = fetchGlyph(slot + 1);
            vec2 t = (uv - rect.xy) / max(rect.zw - rect.xy, vec2(1e-9));
            dist = max(dist, textureGrad(u_atlas, mix(auv.xy, auv.zw, t), gx, gy).r);
        }

        if (dist > 0.0) {
            if (u_halo_width > 0.0) {
                float haloEdge = u_sdf_edge - u_halo_width;
                float haloAlpha = smoothstep(haloEdge - gamma, haloEdge + gamma, dist);
                acc = over(acc, u_halo_color.rgb, u_halo_color.a * haloAlpha);
            }
            float textAlpha = smoothstep(u_sdf_edge - gamma, u_sdf_edge + gamma, dist);
            acc = over(acc, u_text_color.rgb, u_text_color.a * textAlpha);
        }
    }

    float alpha = acc.a * u_opacity * coverage;
    if (alpha <= 0.0) discard;
    fragColor = vec4(acc.rgb / max(acc.a, 1e-4), alpha);
}`;

/** Longitude -> Mercator x */
function mercatorX(lng: number): number {
  return (lng + 180) / 360;
}

/** Latitude -> Mercator y */
function mercatorY(lat: number): number {
  const latRad = (lat * Math.PI) / 180;
  return (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2;
}

/**
 * Converts the four corners into Mercator coordinates (in the order top left,
 * top right, bottom right, bottom left)
 *
 * This order corresponds to (u, v) = (0,0), (1,0), (1,1), (0,1) of the inverse
 * bilinear interpolation.
 */
export function quadMercatorCorners(corners: DrapeQuadCorners): Float64Array {
  const out = new Float64Array(8);
  const order = [corners.topLeft, corners.topRight, corners.bottomRight, corners.bottomLeft];
  for (let i = 0; i < 4; i++) {
    out[i * 2] = mercatorX(order[i][0]);
    out[i * 2 + 1] = mercatorY(order[i][1]);
  }
  return out;
}

/** The range of mesh rows to draw (rows that are not visible are not drawn) */
export interface MeshRowRange {
  readonly start: number;
  readonly count: number;
}

/**
 * A y range within a tile -> a range of terrain mesh rows
 *
 * The mesh indices are in row-major order, with the 6 * meshSize indices of row k
 * laid out contiguously (the generation rule of `mesh.ts`). Simply dropping the
 * rows the quad does not cover narrows the range while keeping a single
 * drawElements call.
 */
export function meshRowRange(y0: number, y1: number, meshSize: number): MeshRowRange | null {
  if (!(y1 >= y0)) return null;
  if (y1 < 0 || y0 > 1) return null;
  const start = Math.max(0, Math.floor(y0 * meshSize));
  const end = Math.min(meshSize - 1, Math.ceil(y1 * meshSize) - 1);
  if (end < start) return null;
  return { start, count: end - start + 1 };
}

/**
 * Inverse bilinear interpolation on the CPU side (a mirror of the shader. For
 * tests and diagnostics)
 *
 * @param quad The four corners (x, y in the order top left, top right, bottom
 *   right, bottom left)
 * @returns The (u, v) inside the quad. null if there is no solution
 */
export function solveQuadUV(
  px: number,
  py: number,
  quad: ArrayLike<number>,
): [number, number] | null {
  const ax = quad[0];
  const ay = quad[1];
  const ex = quad[2] - ax;
  const ey = quad[3] - ay;
  const fx = quad[6] - ax;
  const fy = quad[7] - ay;
  const gx = ax - quad[2] + quad[4] - quad[6];
  const gy = ay - quad[3] + quad[5] - quad[7];
  const hx = px - ax;
  const hy = py - ay;

  const cross = (x0: number, y0: number, x1: number, y1: number): number => x0 * y1 - y0 * x1;
  const k2 = cross(gx, gy, fx, fy);
  const k1 = cross(hx, hy, gx, gy) + cross(ex, ey, fx, fy);
  const k0 = cross(hx, hy, ex, ey);

  if (Math.abs(k1) < 1e-30 && Math.abs(k2) < 1e-30) return null;
  const disc = k1 * k1 - 4 * k0 * k2;
  if (disc < 0) return null;
  const root = Math.sqrt(disc);
  const q = -0.5 * (k1 + (k1 >= 0 ? root : -root));

  const v1 = q !== 0 ? k0 / q : OUTSIDE_UV;
  const v2 = k2 !== 0 ? q / k2 : OUTSIDE_UV;
  const v = Math.abs(v1 - 0.5) <= Math.abs(v2 - 0.5) ? v1 : v2;

  const denX = ex + gx * v;
  const denY = ey + gy * v;
  if (Math.abs(denX) < 1e-30 && Math.abs(denY) < 1e-30) return null;
  const u = Math.abs(denX) >= Math.abs(denY) ? (hx - fx * v) / denX : (hy - fy * v) / denY;
  return [u, v];
}

/** A shader program paired with its uniform locations */
interface ProgramSlot {
  program: WebGLProgram;
  variantName: string;
  locations: UniformSet;
}

/** The complete set of glyph data textures */
interface GlyphBuffers {
  glyphTex: WebGLTexture;
  binTex: WebGLTexture;
  /** Height of the glyph data texture (rows) */
  glyphRows: number;
  /** Grid subdivision count of the bins (per side) */
  grid: number;
  /** Key of the packed content */
  key: string;
  /** Serial number of the most recent use (LRU) */
  usedAt: number;
}

/** The uniforms specific to pasting an image */
const IMAGE_UNIFORMS = ['u_texture'] as const;

/** The uniforms specific to fill + text */
const SURFACE_UNIFORMS = [
  'u_fill_color',
  'u_border_color',
  'u_border',
  'u_atlas',
  'u_glyph_tex',
  'u_bin_tex',
  'u_glyph_tex_width',
  'u_grid',
  'u_atlas_size',
  'u_atlas_texels',
  'u_text_color',
  'u_halo_color',
  'u_halo_width',
  'u_sdf_edge',
  'u_sdf_value_per_texel',
  'u_lod_scale',
] as const;

/** The uniforms that both fragment shaders have */
const QUAD_COMMON_UNIFORMS = [
  ...DRAPE_PROJECTION_UNIFORMS,
  ...DRAPE_TERRAIN_UNIFORMS,
  'u_quad_a',
  'u_quad_b',
  'u_quad_c',
  'u_quad_d',
  'u_opacity',
  'u_light_dir',
  'u_shade_strength',
  'u_tile_meters',
  'u_drape_lift_m',
  ...EDGE_CONSTRAIN_UNIFORMS,
] as const;

/**
 * The renderer that pastes textured quads onto the ground surface
 */
export class QuadDrapeRenderer {
  private gl: WebGL2RenderingContext;
  private imageSlot: ProgramSlot | null = null;
  private surfaceSlot: ProgramSlot | null = null;
  private mesh: TerrainMeshBuffers | null = null;
  private glyphCache = new Map<string, GlyphBuffers>();
  /** A 1x1 texture bound to the samplers in frames that have no text */
  private placeholderTex: WebGLTexture | null = null;
  private useCounter = 0;
  /** The most recent failure reason (for diagnostics) */
  lastError = '';

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
  }

  /**
   * Allocates the terrain mesh
   */
  private ensureMesh(meshSize: number): boolean {
    const gl = this.gl;
    if (this.mesh && this.mesh.meshSize === meshSize) return true;
    if (this.mesh) disposeTerrainMeshBuffers(gl, this.mesh);
    this.mesh = createTerrainMeshBuffers(gl, meshSize);
    if (!this.mesh) {
      this.lastError = 'mesh-alloc-failed';
      return false;
    }
    return true;
  }

  /**
   * Allocates a shader (one per fragment shader body)
   */
  private ensureProgram(
    slot: ProgramSlot | null,
    fragmentSource: string,
    extraUniforms: readonly string[],
    shaderData: ShaderData,
  ): ProgramSlot | null {
    const gl = this.gl;
    if (slot && slot.variantName === shaderData.variantName) return slot;
    if (slot) gl.deleteProgram(slot.program);

    let program: WebGLProgram;
    try {
      program = createProgram(
        gl,
        VERTEX_SOURCE(shaderData.vertexShaderPrelude, shaderData.define),
        fragmentSource,
      );
    } catch (error) {
      this.lastError = `shader: ${String(error)}`;
      return null;
    }

    const locations: UniformSet = {};
    for (const name of [...QUAD_COMMON_UNIFORMS, ...extraUniforms]) {
      locations[name] = gl.getUniformLocation(program, name);
    }
    return { program, variantName: shaderData.variantName, locations };
  }

  /**
   * Allocates the shader and the mesh (the image path. Kept for existing callers)
   */
  ensure(shaderData: ShaderData, meshSize: number): boolean {
    if (!this.ensureMesh(meshSize)) return false;
    this.imageSlot = this.ensureProgram(
      this.imageSlot,
      IMAGE_FRAGMENT_SOURCE,
      IMAGE_UNIFORMS,
      shaderData,
    );
    return this.imageSlot !== null;
  }

  /**
   * Allocates the shader and the mesh of the fill and text path
   */
  ensureSurface(shaderData: ShaderData, meshSize: number): boolean {
    if (!this.ensureMesh(meshSize)) return false;
    this.surfaceSlot = this.ensureProgram(
      this.surfaceSlot,
      SURFACE_FRAGMENT_SOURCE,
      SURFACE_UNIFORMS,
      shaderData,
    );
    return this.surfaceSlot !== null;
  }

  /**
   * Pastes an image onto a single quad
   *
   * @returns true if it could be pasted (the caller then does not perform the
   *   conventional flat drawing). false is returned only when the resources
   *   cannot be prepared, in which case the caller falls back to the degraded
   *   path.
   */
  drawQuad(
    corners: DrapeQuadCorners,
    texture: WebGLTexture,
    opacity: number,
    frame: QuadDrapeFrame,
  ): boolean {
    if (!this.ensure(frame.shaderData, frame.meshSize)) return false;
    const slot = this.imageSlot;
    if (!slot) return false;

    return this.drawTiles(corners, opacity, frame, slot, (set) => {
      const gl = this.gl;
      gl.activeTexture(gl.TEXTURE0 + UNIT_TEXTURE);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      if (set.u_texture) gl.uniform1i(set.u_texture, UNIT_TEXTURE);
    });
  }

  /**
   * Paints fill and text onto a single quad
   *
   * The fill is a rectangular fill, and the text looks up the SDF atlas within
   * the same per-pixel evaluation.
   *
   * @returns true if it could be painted. false is returned only when the
   *   resources cannot be prepared.
   */
  drawSurface(
    corners: DrapeQuadCorners,
    surface: QuadDrapeSurface,
    opacity: number,
    frame: QuadDrapeFrame,
  ): boolean {
    const gl = this.gl;
    if (!this.ensureSurface(frame.shaderData, frame.meshSize)) return false;
    const slot = this.surfaceSlot;
    if (!slot) return false;

    const text = surface.text && surface.text.glyphCount > 0 ? surface.text : null;
    const glyphs = text ? this.ensureGlyphBuffers(text) : null;

    return this.drawTiles(corners, opacity, frame, slot, (set) => {
      const fill = surface.fill;
      setColorUniform(gl, set.u_fill_color, fill.color);
      setColorUniform(gl, set.u_border_color, fill.borderColor);
      if (set.u_border) gl.uniform2f(set.u_border, fill.border[0], fill.border[1]);

      if (!text || !glyphs) {
        if (set.u_grid) gl.uniform1i(set.u_grid, 0);
        // A sampler that is not bound leads to undefined behavior, so something is
        // bound even when there is no text (there is no fill texture, so the bin
        // stands in for it)
        this.bindPlaceholderSamplers(set);
        return;
      }

      gl.activeTexture(gl.TEXTURE0 + UNIT_ATLAS);
      gl.bindTexture(gl.TEXTURE_2D, text.atlas);
      if (set.u_atlas) gl.uniform1i(set.u_atlas, UNIT_ATLAS);

      gl.activeTexture(gl.TEXTURE0 + UNIT_GLYPH);
      gl.bindTexture(gl.TEXTURE_2D, glyphs.glyphTex);
      if (set.u_glyph_tex) gl.uniform1i(set.u_glyph_tex, UNIT_GLYPH);

      gl.activeTexture(gl.TEXTURE0 + UNIT_BIN);
      gl.bindTexture(gl.TEXTURE_2D, glyphs.binTex);
      if (set.u_bin_tex) gl.uniform1i(set.u_bin_tex, UNIT_BIN);

      if (set.u_glyph_tex_width) gl.uniform1i(set.u_glyph_tex_width, GLYPH_TEX_WIDTH);
      if (set.u_grid) gl.uniform1i(set.u_grid, glyphs.grid);
      if (set.u_atlas_size) gl.uniform2f(set.u_atlas_size, text.atlasWidth, text.atlasHeight);
      if (set.u_atlas_texels) {
        gl.uniform2f(set.u_atlas_texels, text.atlasTexelsPerUnit[0], text.atlasTexelsPerUnit[1]);
      }
      setColorUniform(gl, set.u_text_color, text.color);
      setColorUniform(gl, set.u_halo_color, text.haloColor);
      if (set.u_halo_width) gl.uniform1f(set.u_halo_width, text.haloWidth);
      if (set.u_sdf_edge) gl.uniform1f(set.u_sdf_edge, text.edge);
      if (set.u_sdf_value_per_texel) gl.uniform1f(set.u_sdf_value_per_texel, text.valuePerTexel);
      if (set.u_lod_scale) gl.uniform1f(set.u_lod_scale, 2 ** text.lodBias);
    });
  }

  /**
   * Binds a 1x1 texture to the samplers when there is no text
   *
   * If drawing happens with a sampler left unbound and a texture of a different
   * type remains on that unit, it is regarded as incomplete and the whole draw
   * call is dropped. Even for pixels that do not read text, having something
   * bound is safer.
   */
  private bindPlaceholderSamplers(set: UniformSet): void {
    const gl = this.gl;
    if (!this.placeholderTex) {
      this.placeholderTex = createDataTexture(gl, 1, 1);
      if (this.placeholderTex) {
        gl.bindTexture(gl.TEXTURE_2D, this.placeholderTex);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 1, 1, gl.RGBA, gl.FLOAT, new Float32Array(4));
        gl.bindTexture(gl.TEXTURE_2D, null);
      }
    }
    for (const [name, unit] of [
      ['u_atlas', UNIT_ATLAS],
      ['u_glyph_tex', UNIT_GLYPH],
      ['u_bin_tex', UNIT_BIN],
    ] as const) {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, this.placeholderTex);
      if (set[name]) gl.uniform1i(set[name], unit);
    }
  }

  /**
   * Draws the tiles the quad covers (the skeleton shared by image and fill)
   */
  private drawTiles(
    corners: DrapeQuadCorners,
    opacity: number,
    frame: QuadDrapeFrame,
    slot: ProgramSlot,
    bindContent: (set: UniformSet) => void,
  ): boolean {
    const gl = this.gl;
    if (frame.tiles.length === 0) return false;
    const mesh = this.mesh;
    if (!mesh) return false;

    const quad = quadMercatorCorners(corners);
    let minX = quad[0];
    let maxX = quad[0];
    let minY = quad[1];
    let maxY = quad[1];
    for (let i = 2; i < 8; i += 2) {
      minX = Math.min(minX, quad[i]);
      maxX = Math.max(maxX, quad[i]);
      minY = Math.min(minY, quad[i + 1]);
      maxY = Math.max(maxY, quad[i + 1]);
    }
    // A quad with zero area is not drawn (the inverse bilinear cannot be solved)
    if (!(maxX > minX) || !(maxY > minY)) return true;

    gl.useProgram(slot.program);
    const set = slot.locations;

    bindContent(set);

    if (set.u_opacity) gl.uniform1f(set.u_opacity, opacity);
    if (set.u_light_dir) {
      const d = frame.light.direction;
      gl.uniform3f(set.u_light_dir, d[0], d[1], d[2]);
    }
    if (set.u_shade_strength) gl.uniform1f(set.u_shade_strength, frame.light.strength);

    // The depth of the terrain mesh hides what lies behind a ridge (depth works
    // because this is the ground surface, not a billboard). polygonOffset is
    // applied to the whole frame by CustomLayer.
    setDepthTestEnabled(gl, true);

    // The "neighbor" for edge constraining is looked up from the set of terrain
    // tiles drawn in this frame. A tile the quad does not cover is still valid as
    // a neighbor (maplibre draws that tile, so the boundary polyline really does
    // exist there)
    const drawnKeys = buildTileKeySet(frame.tiles);
    const tileByKey = new Map<string, RenderableTerrainTile>();
    for (const t of frame.tiles) tileByKey.set(wrappedTileKey(t), t);

    const indicesPerRow = mesh.meshSize * 6;
    for (const tile of frame.tiles) {
      const scale = 2 ** tile.z;
      const tileX0 = tile.x / scale;
      const tileY0 = tile.y / scale;
      const tileSpan = 1 / scale;
      if (maxX <= tileX0 || minX >= tileX0 + tileSpan) continue;
      if (maxY <= tileY0 || minY >= tileY0 + tileSpan) continue;

      const rows = meshRowRange((minY - tileY0) * scale, (maxY - tileY0) * scale, mesh.meshSize);
      if (!rows) continue;

      const data = frame.getTerrainData(tile);
      if (!data) continue;
      const projection = frame.getProjectionData(tile);
      if (!projection) continue;

      applyDrapeProjectionUniforms(gl, set, projection);
      applyDrapeTerrainUniforms(gl, set, data, UNIT_TERRAIN);
      // Constrain the boundary vertices to the coarser side's polyline (the same
      // mechanism as the polygon and line drape)
      const edges = resolveTileEdges(drawnKeys, tile, mesh.meshSize, (n) => {
        const neighbor = tileByKey.get(wrappedTileKey(n));
        return neighbor ? frame.getTerrainData(neighbor) : null;
      });
      applyEdgeConstrainUniforms(gl, set, edges, data);
      const groundMeters = circumferenceAtLatitude(tileCenterLatitude(tile.y, tile.z)) / scale;
      if (set.u_tile_meters) gl.uniform1f(set.u_tile_meters, groundMeters);
      // Lift by the same amount as the polygon and line drape so that boundary
      // vertices lowered by the constraint do not lose to the terrain mesh in
      // depth (on screen this is less than 0.1 pixel)
      if (set.u_drape_lift_m) gl.uniform1f(set.u_drape_lift_m, groundMeters * DRAPE_LIFT_RATIO);

      // The four corners into this tile's 0..1 coordinates (values that fall
      // outside the tile may stay as they are)
      setQuadUniform(gl, set.u_quad_a, quad[0], quad[1], tileX0, tileY0, scale);
      setQuadUniform(gl, set.u_quad_b, quad[2], quad[3], tileX0, tileY0, scale);
      setQuadUniform(gl, set.u_quad_c, quad[4], quad[5], tileX0, tileY0, scale);
      setQuadUniform(gl, set.u_quad_d, quad[6], quad[7], tileX0, tileY0, scale);

      gl.bindVertexArray(mesh.vao);
      gl.drawElements(
        gl.TRIANGLES,
        rows.count * indicesPerRow,
        gl.UNSIGNED_INT,
        rows.start * indicesPerRow * 4,
      );
      gl.bindVertexArray(null);
    }

    if (!frame.keepDepthTest) setDepthTestEnabled(gl, false);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, null);
    return true;
  }

  /**
   * Allocates the glyph data textures (no repacking if the key is the same)
   */
  private ensureGlyphBuffers(text: QuadDrapeGlyphs): GlyphBuffers | null {
    const gl = this.gl;
    this.useCounter++;

    const cached = this.glyphCache.get(text.key);
    if (cached) {
      cached.usedAt = this.useCounter;
      return cached;
    }

    const bins = binQuadGlyphs(text.glyphs, text.glyphCount);
    if (bins.grid === 0 || bins.entryCount === 0) return null;

    // 2 texels per glyph. The width is even, so a glyph never straddles two rows
    const texels = bins.entryCount * 2;
    const glyphRows = Math.max(1, Math.ceil(texels / GLYPH_TEX_WIDTH));

    const glyphTex = createDataTexture(gl, GLYPH_TEX_WIDTH, glyphRows);
    const binTex = createDataTexture(gl, bins.grid, bins.grid);
    if (!glyphTex || !binTex) {
      if (glyphTex) gl.deleteTexture(glyphTex);
      if (binTex) gl.deleteTexture(binTex);
      this.lastError = 'glyph-texture-alloc-failed';
      return null;
    }

    const payload = new Float32Array(GLYPH_TEX_WIDTH * glyphRows * 4);
    payload.set(bins.entries.subarray(0, Math.min(bins.entries.length, payload.length)));
    gl.bindTexture(gl.TEXTURE_2D, glyphTex);
    gl.texSubImage2D(
      gl.TEXTURE_2D,
      0,
      0,
      0,
      GLYPH_TEX_WIDTH,
      glyphRows,
      gl.RGBA,
      gl.FLOAT,
      payload,
    );

    gl.bindTexture(gl.TEXTURE_2D, binTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, bins.grid, bins.grid, gl.RGBA, gl.FLOAT, bins.cells);
    gl.bindTexture(gl.TEXTURE_2D, null);

    const entry: GlyphBuffers = {
      glyphTex,
      binTex,
      glyphRows,
      grid: bins.grid,
      key: text.key,
      usedAt: this.useCounter,
    };
    this.glyphCache.set(text.key, entry);
    this.evictGlyphBuffers();
    return entry;
  }

  /**
   * Discards glyph data textures that are not in use (LRU)
   */
  private evictGlyphBuffers(): void {
    if (this.glyphCache.size <= GLYPH_CACHE_LIMIT) return;
    const gl = this.gl;
    const sorted = [...this.glyphCache.entries()].sort((a, b) => a[1].usedAt - b[1].usedAt);
    for (const [key, entry] of sorted) {
      if (this.glyphCache.size <= GLYPH_CACHE_LIMIT) break;
      gl.deleteTexture(entry.glyphTex);
      gl.deleteTexture(entry.binTex);
      this.glyphCache.delete(key);
    }
  }

  /**
   * Releases the resources
   */
  dispose(): void {
    const gl = this.gl;
    for (const slot of [this.imageSlot, this.surfaceSlot]) {
      if (slot) gl.deleteProgram(slot.program);
    }
    this.imageSlot = null;
    this.surfaceSlot = null;
    if (this.mesh) {
      disposeTerrainMeshBuffers(gl, this.mesh);
      this.mesh = null;
    }
    for (const entry of this.glyphCache.values()) {
      gl.deleteTexture(entry.glyphTex);
      gl.deleteTexture(entry.binTex);
    }
    this.glyphCache.clear();
    if (this.placeholderTex) {
      gl.deleteTexture(this.placeholderTex);
      this.placeholderTex = null;
    }
  }
}

/** Writes a color uniform (shaped so that a readonly tuple can be passed as is) */
function setColorUniform(
  gl: WebGL2RenderingContext,
  location: WebGLUniformLocation | null,
  color: QuadDrapeColor,
): void {
  if (!location) return;
  gl.uniform4f(location, color[0], color[1], color[2], color[3]);
}

/**
 * Creates a float texture used only for indexed lookups (the same manner as the
 * polygon and line drape)
 */
function createDataTexture(
  gl: WebGL2RenderingContext,
  width: number,
  height: number,
): WebGLTexture | null {
  const texture = gl.createTexture();
  if (!texture) return null;
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA32F, width, height);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return texture;
}

/** Maps a Mercator coordinate into the tile's 0..1 space and writes it to a uniform */
function setQuadUniform(
  gl: WebGL2RenderingContext,
  location: WebGLUniformLocation | null,
  x: number,
  y: number,
  tileX0: number,
  tileY0: number,
  scale: number,
): void {
  if (!location) return;
  gl.uniform2f(location, (x - tileX0) * scale, (y - tileY0) * scale);
}
