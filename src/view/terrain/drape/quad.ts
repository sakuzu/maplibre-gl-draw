// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Analytic drape for quads
 *
 * A quad (a rectangle given by its four corners, such as an image pasted onto the map) fills the
 * inside of its four corners. Drawn as those 4 vertices in a TRIANGLE_STRIP, it always cuts
 * through the terrain wherever the terrain rises above the plane spanned by the corners. The
 * essence of the problem is the absence of subdivision, so turning off the depth test does not
 * fix it (turning it off instead makes what lies behind a ridge show through).
 *
 * Here we solve it with the same idea as for polygons and lines. We draw a terrain mesh built by
 * the same rules as MapLibre's, and for each pixel solve "is this ground point inside the quad"
 * by inverse bilinear interpolation; if it is inside, the resulting (u, v) determines the color.
 * Because it is painted as ground pixels, burying and dropouts cannot occur by construction,
 * occlusion follows directly from the depth of the terrain mesh, and shading is applied with the
 * same formula as the fill.
 *
 * What the quad shows at (u, v) is not decided here: the caller gives a content
 * ({@link QuadDrapeContent}), a GLSL function of (u, v) and of its derivatives with the uniforms
 * and the textures it reads. This module owns the corners, the mesh, the cut into tiles, (u, v)
 * and its derivatives, the depth, the shading of the terrain, the smoothing of the edge of the
 * quad and the opacity. One program is built for each content (its GLSL) and kept.
 *
 * Because quads are few in number, they are drawn one at a time in draw order.
 */

import type { ProjectionData } from 'maplibre-gl';
import type { GpuLedger, GpuLedgerOwner } from '../../gpu-ledger.js';
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
import { DRAPE_LIFT_RATIO, DRAPE_OWNER, type DrapeLight } from './renderer.js';
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

/** The texture unit of the DEM of the tile being drawn */
const UNIT_TERRAIN = 0;

/**
 * The texture units a {@link QuadDrapeContent} binds its textures to: 1 to 4 and 10 to 15.
 *
 * The draw of a draped quad reads the DEM of its tile on the unit 0 and the DEMs of the tiles
 * next to it on the units 5, 7, 8 and 9 (`EDGE_UNITS`), and the DEM atlas stays bound to the unit
 * 6 through the frame (`TERRAIN_ATLAS_TEXTURE_UNIT`), where other drawing reads it. WebGL2
 * guarantees 16 units to a fragment shader.
 */
export const QUAD_DRAPE_TEXTURE_UNITS: readonly number[] = Object.freeze([
  1, 2, 3, 4, 10, 11, 12, 13, 14, 15,
]);

/**
 * The (u, v) that represents "there is no solution"
 *
 * It is merely a value that tips the test to "outside the range". Because the derivatives
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

/**
 * What a quad draped on the terrain shows: a GLSL function of the position in the quad, and the
 * uniforms and the textures it reads ({@link drawQuadOnTerrain}).
 *
 * The library draws the terrain under the quad and, for each pixel, finds the position `(u, v)`
 * in the quad (from `(0, 0)` at `topLeft` to `(1, 1)` at `bottomRight`), its change from one pixel
 * to the next, the depth and the shading of the terrain. It smooths the edge of the quad over a
 * pixel and applies the opacity. What the quad shows at `(u, v)` is the content's.
 *
 * `glsl` is GLSL ES 3.00, put into the fragment shader after the declarations of the library
 * (`precision highp float`, `highp int` and `highp sampler2D`). It declares the uniforms and the
 * samplers it reads and defines the function
 *
 * ```glsl
 * vec4 quadDrapeColor(vec2 uv, vec2 uvDx, vec2 uvDy, float shade)
 * ```
 *
 * - `uv`: the position in the quad, from 0 to 1 inside it (a little outside it on the pixels of
 *   its edge)
 * - `uvDx`, `uvDy`: the change of `uv` from one pixel to the next along the x and the y of the
 *   screen, taken before any branch. The function is called once for each pixel of the quad, so
 *   `texture` may read there; in a loop or a branch of its own, read with `textureGrad` and these
 *   two, and do not call `dFdx`, `dFdy` or `fwidth`, which are undefined there
 * - `shade`: the factor of the shading of the terrain at the pixel (1 without shading). Multiply
 *   the colors that show the relief by it
 * - it returns the color with its alpha premultiplied (`vec4(rgb * a, a)`)
 *
 * Give the names `glsl` declares a prefix of its own: a name the shader of the library has
 * already (such as `u_opacity`, `quadUV` or `terrainShade`) keeps the program from being built.
 * One program is built for each distinct `glsl` and kept, so build the string once and pass the
 * same one at every draw.
 *
 * @example A content that fills the quad with one color, darkened by the relief
 * ```ts
 * const solid = (rgba: [number, number, number, number]): QuadDrapeContent => ({
 *   glsl: `
 *     uniform vec4 u_solid_color;
 *     vec4 quadDrapeColor(vec2 uv, vec2 uvDx, vec2 uvDy, float shade) {
 *       return vec4(u_solid_color.rgb * shade * u_solid_color.a, u_solid_color.a);
 *     }`,
 *   bind(gl, uniform) {
 *     gl.uniform4f(uniform('u_solid_color'), rgba[0], rgba[1], rgba[2], rgba[3]);
 *   },
 * });
 * ```
 */
export interface QuadDrapeContent {
  /** The GLSL of the content: its declarations and `quadDrapeColor` */
  readonly glsl: string;
  /**
   * Sets the uniforms `glsl` reads and binds its textures, with the program of the content in
   * use. Called once per draw, before the tiles under the quad are drawn. Textures are bound to
   * the units of {@link QUAD_DRAPE_TEXTURE_UNITS} only.
   *
   * @param gl - The WebGL context of the map
   * @param uniform - The location of a uniform `glsl` declares, by its name (null for one the
   *   program does not use)
   */
  bind(gl: WebGL2RenderingContext, uniform: (name: string) => WebGLUniformLocation | null): void;
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

/**
 * The fragment shader of a quad with the GLSL of its content (`QuadDrapeContent.glsl`)
 *
 * The content returns a premultiplied color, and it is converted back to straight at the end
 * (because the frame's blend state is `applyDrawBlendState` = RGB straight, A additive).
 */
const FRAGMENT_SOURCE = (contentGlsl: string): string =>
  `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;

in vec2 v_tile;

${QUAD_COMMON_UNIFORMS_GLSL}

out vec4 fragColor;

` +
  TERRAIN_SAMPLE_GLSL +
  TERRAIN_SHADE_GLSL +
  QUAD_UV_GLSL +
  `
${contentGlsl}

void main() {
    // Take the derivatives before entering a branch (under uniform control flow)
    vec2 uv = quadUV(v_tile);
    vec2 uvDx = dFdx(uv);
    vec2 uvDy = dFdy(uv);
    vec2 w = max(abs(uvDx) + abs(uvDy), vec2(1e-8));

    // The edge is smoothed with one pixel of coverage (the billboard's edge does
    // not turn jagged)
    vec2 cover = clamp((0.5 - abs(uv - 0.5)) / w + 0.5, 0.0, 1.0);
    float coverage = cover.x * cover.y;
    if (coverage <= 0.0) discard;

    vec4 color = quadDrapeColor(uv, uvDx, uvDy, terrainShade(v_tile));
    float alpha = color.a * u_opacity * coverage;
    if (alpha <= 0.0) discard;
    fragColor = vec4(color.rgb / max(color.a, 1e-4), alpha);
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

/**
 * The program of one content, paired with its uniform locations
 *
 * `program` is null when it could not be built for the variant: it is not built again until the
 * variant changes.
 */
interface ProgramSlot {
  program: WebGLProgram | null;
  variantName: string;
  /** The locations of the uniforms of the library */
  locations: UniformSet;
  /**
   * Looks up a uniform of the content, kept once looked up (the function handed to
   * `QuadDrapeContent.bind`)
   */
  uniform: (name: string) => WebGLUniformLocation | null;
}

/** The uniforms of the library in the programs of every content */
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
 * The renderer that pastes quads onto the ground surface, each with the content it is given
 */
export class QuadDrapeRenderer {
  private gl: WebGL2RenderingContext;
  /** The program of each content, by its GLSL */
  private programs = new Map<string, ProgramSlot>();
  private mesh: TerrainMeshBuffers | null = null;
  /** The most recent failure reason (for diagnostics) */
  lastError = '';
  /** Where the bytes of the mesh are recorded (nothing is recorded until `useLedger`) */
  private ledger: GpuLedgerOwner | undefined;

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
  }

  /**
   * Records the GPU memory this renderer allocates from now on (call it before the first draw:
   * it holds nothing before)
   *
   * @internal
   */
  useLedger(ledger: GpuLedger | undefined): this {
    this.ledger = ledger ? { ledger, owner: DRAPE_OWNER } : undefined;
    return this;
  }

  /**
   * Allocates the terrain mesh
   */
  private ensureMesh(meshSize: number): boolean {
    const gl = this.gl;
    if (this.mesh && this.mesh.meshSize === meshSize) return true;
    if (this.mesh) disposeTerrainMeshBuffers(gl, this.mesh, this.ledger);
    this.mesh = createTerrainMeshBuffers(gl, meshSize, this.ledger);
    if (!this.mesh) {
      this.lastError = 'mesh-alloc-failed';
      return false;
    }
    return true;
  }

  /**
   * Allocates the program of a content for the shader variant (kept for each content)
   */
  private ensureProgram(contentGlsl: string, shaderData: ShaderData): ProgramSlot {
    const gl = this.gl;
    const kept = this.programs.get(contentGlsl);
    if (kept && kept.variantName === shaderData.variantName) return kept;
    if (kept?.program) gl.deleteProgram(kept.program);

    let program: WebGLProgram | null = null;
    try {
      program = createProgram(
        gl,
        VERTEX_SOURCE(shaderData.vertexShaderPrelude, shaderData.define),
        FRAGMENT_SOURCE(contentGlsl),
      );
    } catch (error) {
      this.lastError = `shader: ${String(error)}`;
    }

    const locations: UniformSet = {};
    if (program) {
      for (const name of QUAD_COMMON_UNIFORMS) {
        locations[name] = gl.getUniformLocation(program, name);
      }
    }
    const contentLocations = new Map<string, WebGLUniformLocation | null>();
    const built = program;
    const slot: ProgramSlot = {
      program,
      variantName: shaderData.variantName,
      locations,
      uniform(name) {
        if (!built) return null;
        let location = contentLocations.get(name);
        if (location === undefined) {
          location = gl.getUniformLocation(built, name);
          contentLocations.set(name, location);
        }
        return location;
      },
    };
    this.programs.set(contentGlsl, slot);
    return slot;
  }

  /**
   * Allocates the program of a content and the mesh
   *
   * @returns false when either cannot be prepared
   */
  ensure(content: QuadDrapeContent, shaderData: ShaderData, meshSize: number): boolean {
    if (!this.ensureMesh(meshSize)) return false;
    return this.ensureProgram(content.glsl, shaderData).program !== null;
  }

  /**
   * Paints a single quad with a content
   *
   * @returns true if it could be painted (the caller then does not draw it another way). false
   *   is returned only when the resources cannot be prepared (the mesh, the program of the
   *   content), in which case the caller falls back to another path.
   */
  drawQuad(
    corners: DrapeQuadCorners,
    content: QuadDrapeContent,
    opacity: number,
    frame: QuadDrapeFrame,
  ): boolean {
    if (!this.ensureMesh(frame.meshSize)) return false;
    const slot = this.ensureProgram(content.glsl, frame.shaderData);
    if (!slot.program) return false;

    return this.drawTiles(corners, opacity, frame, slot.program, slot.locations, () => {
      content.bind(this.gl, slot.uniform);
    });
  }

  /**
   * Draws the tiles the quad covers
   */
  private drawTiles(
    corners: DrapeQuadCorners,
    opacity: number,
    frame: QuadDrapeFrame,
    program: WebGLProgram,
    set: UniformSet,
    bindContent: () => void,
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

    gl.useProgram(program);
    bindContent();

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
   * Releases the resources
   */
  dispose(): void {
    const gl = this.gl;
    for (const slot of this.programs.values()) {
      if (slot.program) gl.deleteProgram(slot.program);
    }
    this.programs.clear();
    if (this.mesh) {
      disposeTerrainMeshBuffers(gl, this.mesh, this.ledger);
      this.mesh = null;
    }
  }
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
