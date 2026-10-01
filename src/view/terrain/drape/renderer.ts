// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Analytic drape rendering
 *
 * Instead of placing features onto the terrain as "a collection of triangles",
 * they are painted as "pixels of the ground surface". A mesh built by the same
 * rules as MapLibre's terrain mesh is drawn, and the fragment shader solves
 * analytically whether that pixel is inside the feature and how far it is from the
 * outline.
 *
 * With this, the "tears, streaks and holes" that stem from a mismatch in the
 * subdivision of the surface cannot occur by construction (there is no room for
 * our own triangles to disagree with the terrain). No lift (depth bias) is needed
 * either, so the "silhouette show-through" in which the fill on the far side of a
 * ridge shows through does not exist in principle. The line width can also be kept
 * constant in screen pixels (the inverse Jacobian maps a distance in tile-local
 * coordinates to a screen distance).
 *
 * The limits and the degradation follow the upper limits of binning.ts. Only when
 * those limits are exceeded does the caller fall back to the conventional vertex
 * displacement path.
 */

import type { ProjectionData } from 'maplibre-gl';
import {
  SELECTION_HIGHLIGHT_FILL_OPACITY,
  SELECTION_HIGHLIGHT_RGB,
  SELECTION_HIGHLIGHT_STROKE_EXTRA,
} from '../../../shared/config/selection-highlight.js';
import type { ShaderData } from '../../shaders/helpers.js';
import { createProgram } from '../../shaders/helpers.js';
import type { TerrainTileData } from '../detect.js';
import {
  DRAPE_DASH_TEXEL,
  DRAPE_SELECTION_TEXEL,
  DRAPE_STYLE_TEXELS,
  type DrapePackBuilder,
} from './bin-store.js';
import {
  applyEdgeConstrainUniforms,
  EDGE_CONSTRAIN_GLSL,
  EDGE_CONSTRAIN_UNIFORMS,
  EDGE_UNITS,
} from './edge-constrain.js';
import {
  createTerrainMeshBuffers,
  disposeTerrainMeshBuffers,
  type TerrainMeshBuffers,
  TILE_EXTENT,
} from './mesh.js';
import {
  applyDrapeProjectionUniforms,
  applyDrapeTerrainUniforms,
  DRAPE_PROJECTION_UNIFORMS,
  DRAPE_TERRAIN_UNIFORMS,
  TERRAIN_SAMPLE_GLSL,
  TERRAIN_SHADE_GLSL,
} from './shared.js';
import type { ResolvedTileEdges } from './stitch.js';

export { EDGE_UNITS };

/**
 * Width of the data textures (texels)
 *
 * The maximum texture dimension WebGL2 is guaranteed to provide is 2048. The wider
 * it is taken, the fewer rows the same number of edges fits into, and the better
 * the mechanism that transfers only the increment works.
 */
const DATA_TEX_WIDTH = 2048;

/** Texture units */
const UNIT_TERRAIN = 0;
const UNIT_EDGE = 1;
const UNIT_RUN = 2;
const UNIT_CELL = 3;
const UNIT_STYLE = 4;

/**
 * The texture unit of the starts of the edges along their paths
 *
 * 5 and 7 to 9 hold the DEMs of the edges (`EDGE_UNITS`) and 6 the DEM atlas, so it comes after
 * them (WebGL2 guarantees 16 units to a fragment shader).
 */
export const DRAPE_EDGE_START_UNIT = 10;

/** The pixels of a 512-pixel tile, the size the dash patterns are measured in */
const DASH_TILE_PX = 512;

/**
 * Upper limit on the sources of the factors
 *
 * 0 = neutral (factor 1), then the datasets, then the Store layers
 * (their opacity; see `drapeLayerSource` in pass.ts). A dataset past the limit is
 * drawn with a factor of 1 (the plain color), and a layer past it has its opacity
 * baked into its colors. 64 vec2 stay well inside the 224 fragment uniform vectors
 * WebGL2 guarantees.
 */
export const DRAPE_MAX_SOURCES = 64;

/**
 * The light source of the shading
 *
 * The default is "direction 335 degrees, anchor viewport", the same as hillshade.
 * Light from the northwest is the standard practice in cartography, whereas light
 * from the southeast causes the illusion that the relief is inverted. Neither a UI
 * nor an option is provided; it is held as the default value of a uniform. Even if
 * it is changed in the future, only the way the uniform is supplied needs to
 * change.
 */
export interface DrapeLight {
  /** A unit vector in the map coordinate system (east, north, up) */
  readonly direction: readonly [number, number, number];
  /** Strength of the shading (0 means no shading) */
  readonly strength: number;
}

/**
 * The defaults of the shading, 335 degrees as seen on screen (northwest), an
 * altitude of 45 degrees and a strength of 0.45
 */
export const DRAPE_LIGHT_AZIMUTH_DEG = 335;
export const DRAPE_LIGHT_ALTITUDE_DEG = 45;
export const DRAPE_LIGHT_STRENGTH = 0.45;

/**
 * Converts a screen-anchored (anchor viewport) light source into a vector in the
 * map coordinate system
 *
 * So that the light always comes from the top left on screen, the map's rotation
 * (bearing) is added to convert it into an azimuth in the map coordinate system.
 */
export function resolveDrapeLight(bearingDeg: number): DrapeLight {
  const azimuth = ((DRAPE_LIGHT_AZIMUTH_DEG + bearingDeg) * Math.PI) / 180;
  const altitude = (DRAPE_LIGHT_ALTITUDE_DEG * Math.PI) / 180;
  const horizontal = Math.cos(altitude);
  return {
    direction: [Math.sin(azimuth) * horizontal, Math.cos(azimuth) * horizontal, Math.sin(altitude)],
    strength: DRAPE_LIGHT_STRENGTH,
  };
}

/**
 * A segment of range drawing
 *
 * Only [paintFrom, paintTo) of the element sequence is painted. It is used to
 * insert an image (a quad) between polygons and lines following the stacking
 * order. The selection highlight accumulates its coverage from every element, so
 * emitSelection is raised only for the final segment and it is composed once.
 */
export interface DrapeDrawSegment {
  readonly paintFrom: number;
  readonly paintTo: number;
  readonly emitSelection: boolean;
}

/** The drawing instruction for a single tile */
export interface DrapeTileDraw {
  /** The tile ID passed to getProjectionData */
  readonly tileID: unknown;
  /** The complete set of DEM textures */
  readonly terrain: TerrainTileData;
  /** The starting position within the cell index texture (texels) */
  readonly cellOffset: number;
  /** The subdivision count of the grid (per side) */
  readonly grid: number;
  /** The ground size of this tile (meters). Used to compute the shading gradient */
  readonly groundMeters: number;
  /** The zoom of this tile (it scales the lengths of the edges into dash pattern pixels) */
  readonly tileZ: number;
  /**
   * The constraint for each edge (resolving T-junctions)
   *
   * The step, the coordinate transform and the DEM of the constraint target come
   * as a single value. This shape makes it impossible to create a state in which
   * only one of them is stale.
   */
  readonly edges: ResolvedTileEdges<TerrainTileData>;
}

/**
 * The ratio of the lift from the ground surface (a proportion of the tile's ground
 * size)
 *
 * One ten-thousandth. That amounts to 2 m for a z11 tile (about 19 km) and 6 cm
 * for z16 (about 600 m). On screen it is less than 0.1 pixel, so it is invisible,
 * yet in depth it reliably wins against the terrain surface.
 */
export const DRAPE_LIFT_RATIO = 1 / 2_500;

const VERTEX_SOURCE = (prelude: string, define: string): string => `#version 300 es
${prelude}
${define}
layout(location = 0) in vec2 a_pos;
// A very slight lift from the ground surface (meters), in order to win against the
// terrain surface in depth
uniform float u_drape_lift_m;
out vec2 v_tile;
${TERRAIN_SAMPLE_GLSL}
${EDGE_CONSTRAIN_GLSL}

void main() {
    // A boundary vertex is constrained to the coarser side's polyline only when the
    // neighbor is coarser (edge-constrain.ts)
    float ele = drape_edge_constrained(a_pos, drape_get_elevation(a_pos));

    // The boundary is not moved. Neither an overhang nor a skirt is created; it is
    // closed only in the form where adjacent tiles share the same polyline.
    gl_Position = projectTileWithElevation(a_pos, ele + u_drape_lift_m);
    v_tile = a_pos / ${TILE_EXTENT}.0;
}`;

/**
 * The shader that paints the pixels (exported because a test watches its structure)
 */
export const DRAPE_FRAGMENT_SOURCE =
  `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;

in vec2 v_tile;

uniform sampler2D u_edge_tex;
uniform sampler2D u_run_tex;
uniform sampler2D u_cell_tex;
uniform sampler2D u_style_tex;
// Where each edge starts along its path (Mercator units), in step with u_edge_tex
uniform sampler2D u_edge_start_tex;
uniform int u_data_width;
uniform int u_cell_base;
uniform float u_cells;
uniform float u_opacity;
uniform float u_zoom;
// The factors per source (x = opacity, y = size). The zoom response of a
// dataset is applied here (baking it into the elements would mean
// rebuilding the index on every zoom)
uniform vec2 u_source_factors[${DRAPE_MAX_SOURCES}];
// Shading (an aid to reading the terrain). It is applied only to the fill, with
// the same light source and the same formula as the ground. This is not 3D
// lighting that illuminates symbols with an arbitrary light. It is also distinct
// from vertical exaggeration of the terrain (which follows the map's own factor), and
// it does not change the dimensions of the relief at all.
uniform vec3 u_light_dir;      // a unit vector in the map coordinate system (east, north, up)
uniform float u_shade_strength;
uniform float u_tile_meters;   // the ground size of this tile (meters)
// The selection highlight (rgb = the base color, a = the opacity of the area fill)
uniform vec4 u_selection_color;
// The extra outline thickness added by the selection highlight (physical pixels)
uniform float u_selection_stroke_extra;
// The range of elements to paint, [x, y). In order to insert an image (a quad)
// between polygons and lines following the stacking order, the element sequence is
// split at the image's position and drawn range by range. Elements outside the
// range still count toward the coverage of the selection highlight (the final
// segment composes the coverage of all elements)
uniform vec2 u_paint_range;
// Whether to compose the selection highlight in this draw (1 only for the final
// segment)
uniform float u_emit_selection;
// The pixels of a dash pattern per unit of the Mercator world (512 * 2^zoom) and per
// unit of this tile (512 * 2^(zoom - tile zoom)). A pattern is measured the way the
// subdividing path measures it: in pixels of the flat map at the zoom of the frame
uniform float u_dash_world_px;
uniform float u_dash_tile_px;

out vec4 fragColor;

` +
  TERRAIN_SAMPLE_GLSL +
  TERRAIN_SHADE_GLSL +
  `

vec4 fetchData(sampler2D tex, int i) {
    return texelFetch(tex, ivec2(i % u_data_width, i / u_data_width), 0);
}

float cross2(vec2 a, vec2 b) {
    return a.x * b.y - a.y * b.x;
}

// Whether the segment (p, q) and the segment (a, b) intersect
bool crosses(vec2 p, vec2 q, vec2 a, vec2 b) {
    float d1 = cross2(b - a, p - a);
    float d2 = cross2(b - a, q - a);
    float d3 = cross2(q - p, a - p);
    float d4 = cross2(q - p, b - p);
    return (d1 * d2 < 0.0) && (d3 * d4 < 0.0);
}

// The shortest vector from the origin to a segment
vec2 closestVector(vec2 a, vec2 b) {
    vec2 ab = b - a;
    float len2 = dot(ab, ab);
    float t = len2 > 0.0 ? clamp(-dot(a, ab) / len2, 0.0, 1.0) : 0.0;
    return a + ab * t;
}

// The screen distance from the pixel to the dashes of a pattern on one edge
//
// sa and sb are the ends of the edge on the screen, around the pixel. start and len are
// where the edge starts along its path and how long it is, and dash and period those of
// the pattern (all in pattern pixels). The place along the edge is taken where the pixel
// is closest to it on the screen, so the dash picked is the one closest on the screen.
// The dash there and the next one are measured: between them lies a gap, and the pixel
// is closer to one of their ends. A dash is cut where the edge ends; the dash goes on
// on the next edge, which draws its own part, and the two parts meet in a round joint
// as a solid line does. Each part is a segment with round caps, so a dash gets the
// round caps of the subdividing path at its ends.
float dashDistance(vec2 sa, vec2 sb, float start, float len, float dash, float period) {
    if (len <= 0.0) return 1.0e9;
    vec2 ab = sb - sa;
    float len2 = dot(ab, ab);
    float u = len2 > 0.0 ? clamp(-dot(sa, ab) / len2, 0.0, 1.0) : 0.0;
    float k = floor((start + u * len) / period);
    float best = 1.0e9;
    for (int i = 0; i < 2; i++) {
        float from = (k + float(i)) * period;
        float u0 = (from - start) / len;
        float u1 = (from + dash - start) / len;
        if (u1 <= 0.0 || u0 >= 1.0) continue;
        u0 = clamp(u0, 0.0, 1.0);
        u1 = clamp(u1, 0.0, 1.0);
        best = min(best, length(closestVector(sa + ab * u0, sa + ab * u1)));
    }
    return best;
}

// Compose on top (premultiplied alpha)
vec4 over(vec4 below, vec3 rgb, float a) {
    return vec4(rgb * a + below.rgb * (1.0 - a), a + below.a * (1.0 - a));
}

void main() {
    vec2 p = v_tile;

    // The inverse Jacobian, mapping a displacement in tile-local coordinates to a
    // displacement in screen pixels. The derivatives are taken before entering a
    // branch (under uniform control flow).
    vec2 dpdx = dFdx(p);
    vec2 dpdy = dFdy(p);
    float det = dpdx.x * dpdy.y - dpdy.x * dpdx.y;
    mat2 jacobianInverse;
    if (abs(det) < 1e-24) {
        // When the derivatives vanish, for instance on a surface seen exactly edge
        // on, the matrix cannot be built. An isotropic approximation stands in for
        // it (discarding would leave that pixel unpainted)
        float s = max(max(length(dpdx), length(dpdy)), 1e-12);
        jacobianInverse = mat2(1.0 / s, 0.0, 0.0, 1.0 / s);
    } else {
        jacobianInverse = mat2(dpdy.y, -dpdx.y, -dpdy.x, dpdx.x) / det;
    }

    ivec2 cell = ivec2(clamp(floor(p * u_cells), vec2(0.0), vec2(u_cells - 1.0)));
    int cellIndex = u_cell_base + cell.y * int(u_cells) + cell.x;
    vec4 cellData = fetchData(u_cell_tex, cellIndex);
    int runStart = int(cellData.x);
    int runCount = int(cellData.y);
    if (runCount == 0) discard;

    vec2 origin = vec2(cell) / u_cells;

    vec4 acc = vec4(0.0);
    float shade = -1.0;
    // The coverage of the selection highlight (the maximum over the features that
    // are selected at this pixel)
    float selFill = 0.0;
    float selStroke = 0.0;

    for (int r = 0; r < runCount; r++) {
        vec4 run = fetchData(u_run_tex, runStart + r);
        int elementIndex = int(run.x);
        int edgeStart = int(run.y);
        int edgeCount = int(run.z);
        bool inside = run.w > 0.5;

        // Range drawing. Only the elements in u_paint_range are painted. The coverage
        // of the selection is accumulated from outside the range as well, but only by
        // the segment that composes it (u_emit_selection); the other segments skip it.
        // The runs of a cell are in draw order (binning.ts), so a segment that does not
        // compose the selection is done once it passes the end of its range: with k
        // images between the sections, a section no longer pays for the runs of the
        // sections after it
        if (u_emit_selection < 0.5 && float(elementIndex) >= u_paint_range.y) break;
        bool paints = float(elementIndex) >= u_paint_range.x
            && float(elementIndex) < u_paint_range.y;
        bool selected = u_emit_selection > 0.5
            && fetchData(u_style_tex, elementIndex * ${DRAPE_STYLE_TEXELS} + ${DRAPE_SELECTION_TEXEL}).x
                > 0.5;
        if (!paints && !selected) continue;

        int styleAt = elementIndex * ${DRAPE_STYLE_TEXELS};
        vec4 fill = fetchData(u_style_tex, styleAt);
        vec4 stroke = fetchData(u_style_tex, styleAt + 1);
        vec4 params = fetchData(u_style_tex, styleAt + 2);
        // (a, b, c, the physical pixels of the width per CSS pixel; 0 for a solid outline)
        vec4 dashSpec = fetchData(u_style_tex, styleAt + ${DRAPE_DASH_TEXEL});
        int source = int(params.z);
        vec2 factors = source >= 0 && source < ${DRAPE_MAX_SOURCES}
            ? u_source_factors[source]
            : vec2(1.0, 1.0);
        // An element that has a reference zoom for its line width changes its
        // thickness with the same formula as the retained batch path
        float widthScale = params.w >= 0.0 ? exp2(u_zoom - params.w) : 1.0;
        float halfWidth = params.x * 0.5 * factors.y * widthScale;
        bool isPolygon = params.y < 0.5;

        // A dashed outline: the dash and the gap follow from the width the line has in
        // this frame (in CSS pixels), with the formulas of the subdividing path
        // (dash.ts): dash = max(a, b * w), gap = max(w + 1, c * w)
        bool dashed = dashSpec.w > 0.0;
        float dashLength = 0.0;
        float dashPeriod = 1.0;
        if (dashed) {
            float w = 2.0 * halfWidth / dashSpec.w;
            dashLength = max(dashSpec.x, dashSpec.y * w);
            dashPeriod = dashLength + max(w + 1.0, dashSpec.z * w);
        }
        // The distance to the whole outline is what the fill and the selection read. A
        // dashed outline measures its dashes apart, and the whole outline only when
        // something reads it
        bool wantsEdges = !dashed || selected || (paints && isPolygon && fill.a > 0.0);
        bool wantsDashes = dashed && paints;

        float minDist = 1.0e9;
        float dashDist = 1.0e9;
        for (int e = 0; e < edgeCount; e++) {
            vec4 seg = fetchData(u_edge_tex, edgeStart + e);
            vec2 a = seg.xy;
            vec2 b = seg.zw;
            if (crosses(origin, p, a, b)) inside = !inside;
            // The distance is taken on the screen: the segment is mapped to screen pixels
            // around the pixel first. The closest point found on the ground and mapped
            // afterwards is not the closest one on the screen where the ground is seen
            // at a slant, and the line came out thinner between its vertices than at them
            vec2 sa = jacobianInverse * (a - p);
            vec2 sb = jacobianInverse * (b - p);
            if (wantsEdges) minDist = min(minDist, length(closestVector(sa, sb)));
            if (wantsDashes) {
                int at = edgeStart + e;
                float start = texelFetch(
                    u_edge_start_tex, ivec2(at % u_data_width, at / u_data_width), 0
                ).r * u_dash_world_px;
                float len = length(b - a) * u_dash_tile_px;
                dashDist = min(dashDist, dashDistance(sa, sb, start, len, dashLength, dashPeriod));
            }
        }
        // The outline is drawn where its dashes are (the whole of it when it is solid)
        float strokeDist = dashed ? dashDist : minDist;

        if (paints && isPolygon && fill.a > 0.0) {
            // A signed distance, negative inside and positive outside (screen pixels)
            float signedDist = inside ? -minDist : minDist;
            float coverage = clamp(0.5 - signedDist, 0.0, 1.0);
            if (coverage > 0.0) {
                // Apply the same shading as the ground only to the fill (lines,
                // points and handles are unshaded)
                if (shade < 0.0) shade = terrainShade(p);
                acc = over(acc, fill.rgb * shade, fill.a * coverage * factors.x);
            }
        }

        if (paints && halfWidth > 0.0 && stroke.a > 0.0) {
            float coverage = clamp(halfWidth + 0.5 - strokeDist, 0.0, 1.0);
            if (coverage > 0.0) acc = over(acc, stroke.rgb, stroke.a * coverage * factors.x);
        }

        // Accumulate the coverage of the selection highlight. It is not composed
        // here.
        //
        // Composing it at the stacking order of the selected feature buries the
        // highlight under the fill of the features stacked above it (the
        // municipalities when a prefecture is selected). Small features appear as
        // the zoom is raised, so it showed up as "the red disappears when you zoom
        // in". The immediate mode always overpainted it last, so this is aligned
        // with the same "compose last" convention.
        if (selected) {
            if (isPolygon) {
                float signedDist = inside ? -minDist : minDist;
                float coverage = clamp(0.5 - signedDist, 0.0, 1.0);
                selFill = max(selFill, coverage * factors.x);
            }
            // The added thickness is kept constant in screen pixels (so that "an
            // outline one size thicker" always looks the same regardless of the
            // unit of the original thickness). The highlight outline is also drawn
            // for features that have no outline (the same as the immediate mode), and
            // it is solid under a dashed outline too
            float selHalf = halfWidth + u_selection_stroke_extra * 0.5;
            selStroke = max(selStroke, clamp(selHalf + 0.5 - minDist, 0.0, 1.0) * factors.x);
        }
    }

    // The selection highlight is composed at the end of the pixel (so it is not
    // buried under the features stacked above). In range drawing only the final
    // segment composes it (composing per segment would bury it under the fill of
    // later segments, and the overlapping places would also turn darker)
    if (u_emit_selection > 0.5 && selFill > 0.0) {
        // The fill gets the same shading as the ground (the same convention as the
        // underlying fill)
        if (shade < 0.0) shade = terrainShade(p);
        acc = over(acc, u_selection_color.rgb * shade, u_selection_color.a * selFill);
    }
    if (u_emit_selection > 0.5 && selStroke > 0.0) acc = over(acc, u_selection_color.rgb, selStroke);

    if (acc.a <= 0.0) discard;
    fragColor = acc * u_opacity;
}`;

/** The positions that have already been transferred */
interface UploadMark {
  builderId: number;
  edges: number;
  edgeStarts: number;
  runs: number;
  cells: number;
  styles: number;
}

/**
 * The renderer of the analytic drape
 */
export class DrapeRenderer {
  private gl: WebGL2RenderingContext;
  private program: WebGLProgram | null = null;
  private variantName = '';
  private mesh: TerrainMeshBuffers | null = null;

  private edgeTex: WebGLTexture | null = null;
  private edgeStartTex: WebGLTexture | null = null;
  private runTex: WebGLTexture | null = null;
  private cellTex: WebGLTexture | null = null;
  private styleTex: WebGLTexture | null = null;
  private edgeTexSize: [number, number] = [0, 0];
  private edgeStartTexSize: [number, number] = [0, 0];
  private runTexSize: [number, number] = [0, 0];
  private cellTexSize: [number, number] = [0, 0];
  private styleTexSize: [number, number] = [0, 0];
  private uploaded: UploadMark = emptyUploadMark();
  /** The selection version the transferred style table reflects (-1 = not transferred) */
  private uploadedSelection = -1;

  private locations: Record<string, WebGLUniformLocation | null> = {};
  /** The most recent failure reason (for diagnostics) */
  lastError = '';
  /** MAX_TEXTURE_SIZE of the context (read once, 0 = not read yet) */
  private maxTextureSize = 0;

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
  }

  /**
   * Allocates the shader and the mesh
   */
  ensure(shaderData: ShaderData, meshSize: number): boolean {
    const gl = this.gl;

    if (!this.mesh || this.mesh.meshSize !== meshSize) {
      if (this.mesh) disposeTerrainMeshBuffers(gl, this.mesh);
      this.mesh = createTerrainMeshBuffers(gl, meshSize);
      if (!this.mesh) {
        this.lastError = 'mesh-alloc-failed';
        return false;
      }
    }

    if (this.program && this.variantName === shaderData.variantName) return true;

    if (this.program) gl.deleteProgram(this.program);
    try {
      this.program = createProgram(
        gl,
        VERTEX_SOURCE(shaderData.vertexShaderPrelude, shaderData.define),
        DRAPE_FRAGMENT_SOURCE,
      );
    } catch (error) {
      this.lastError = `shader: ${String(error)}`;
      this.program = null;
      return false;
    }
    this.variantName = shaderData.variantName;

    const names = [
      ...DRAPE_PROJECTION_UNIFORMS,
      ...DRAPE_TERRAIN_UNIFORMS,
      'u_edge_tex',
      'u_run_tex',
      'u_cell_tex',
      'u_style_tex',
      'u_edge_start_tex',
      'u_data_width',
      'u_cell_base',
      'u_cells',
      'u_opacity',
      'u_zoom',
      'u_source_factors[0]',
      'u_light_dir',
      'u_shade_strength',
      'u_tile_meters',
      'u_drape_lift_m',
      'u_selection_color',
      'u_selection_stroke_extra',
      'u_paint_range',
      'u_emit_selection',
      'u_dash_world_px',
      'u_dash_tile_px',
      ...EDGE_CONSTRAIN_UNIFORMS,
    ];
    this.locations = {};
    for (const name of names) {
      this.locations[name] = gl.getUniformLocation(this.program, name);
    }
    return true;
  }

  /**
   * Transfers the part of the packed arrays that has not been sent yet to the GPU
   *
   * The arrays are append-only, so sending only the rows that were added is
   * enough. Everything is sent only when the version has been swapped (it became a
   * different builder) and when the textures have been recreated.
   *
   * @returns false when a table does not fit in a texture of this GPU (taller than
   *   MAX_TEXTURE_SIZE, or the allocation failed). The caller then draws the frame
   *   without the analytic drape, the same way as when the index is over its budget
   */
  upload(pack: DrapePackBuilder): boolean {
    if (this.uploaded.builderId !== pack.id) {
      this.uploaded = { ...emptyUploadMark(), builderId: pack.id };
      this.uploadedSelection = -1;
    }
    // The selection highlight rewrites rows that have already been sent (it is not
    // an append), so when the version moves only the style table is sent again from
    // the beginning. The style table is a few texels per element, orders of magnitude
    // smaller than the edge table
    if (this.uploadedSelection !== pack.selectionVersion) {
      this.uploaded.styles = 0;
      this.uploadedSelection = pack.selectionVersion;
    }

    this.edgeTex = this.uploadTexture(
      this.edgeTex,
      'edgeTexSize',
      'edges',
      DATA_TEX_WIDTH,
      pack.edges,
      pack.edgeCount,
    );
    // The starts along the paths go one per texel, in step with the edges
    this.edgeStartTex = this.uploadTexture(
      this.edgeStartTex,
      'edgeStartTexSize',
      'edgeStarts',
      DATA_TEX_WIDTH,
      pack.edgeStarts,
      pack.edgeCount,
      1,
    );
    this.runTex = this.uploadTexture(
      this.runTex,
      'runTexSize',
      'runs',
      DATA_TEX_WIDTH,
      pack.runs,
      pack.runCount,
    );
    this.cellTex = this.uploadTexture(
      this.cellTex,
      'cellTexSize',
      'cells',
      DATA_TEX_WIDTH,
      pack.cells,
      pack.cellCount,
    );
    // The style table is laid out like the others (the texels of the elements one after
    // another in rows of DATA_TEX_WIDTH; an element may run over into the next row), so its
    // height grows with the elements / DATA_TEX_WIDTH, not with the elements
    this.styleTex = this.uploadTexture(
      this.styleTex,
      'styleTexSize',
      'styles',
      DATA_TEX_WIDTH,
      pack.styles,
      DRAPE_STYLE_TEXELS * Math.max(1, pack.elementCount),
    );
    return (
      this.edgeTex !== null &&
      this.edgeStartTex !== null &&
      this.runTex !== null &&
      this.cellTex !== null &&
      this.styleTex !== null
    );
  }

  /**
   * Draws a single tile
   *
   * @param projectionData The ProjectionData of that tile
   * @param sourceFactors The factors per source (x = opacity, y = size)
   * @param opacity The overall opacity (default 1)
   * @param segment The segment of range drawing (omitted = all elements + the
   *   selection highlight). When inserting an image between polygons and lines
   *   following the stacking order, the caller splits the element sequence at the
   *   image's position and draws it segment by segment
   */
  drawTile(
    draw: DrapeTileDraw,
    projectionData: ProjectionData,
    light: DrapeLight,
    zoom: number,
    sourceFactors: Float32Array,
    pixelRatio = 1,
    opacity = 1,
    segment?: DrapeDrawSegment,
  ): void {
    const gl = this.gl;
    const program = this.program;
    const mesh = this.mesh;
    if (
      !program ||
      !mesh ||
      !this.edgeTex ||
      !this.edgeStartTex ||
      !this.cellTex ||
      !this.styleTex
    ) {
      this.lastError = 'draw: missing resources';
      return;
    }

    gl.useProgram(program);
    const set = this.locations;

    applyDrapeProjectionUniforms(gl, set, projectionData);
    applyDrapeTerrainUniforms(gl, set, draw.terrain, UNIT_TERRAIN);

    this.bindData(UNIT_EDGE, this.edgeTex, set.u_edge_tex);
    this.bindData(UNIT_RUN, this.runTex, set.u_run_tex);
    this.bindData(UNIT_CELL, this.cellTex, set.u_cell_tex);
    this.bindData(UNIT_STYLE, this.styleTex, set.u_style_tex);
    this.bindData(DRAPE_EDGE_START_UNIT, this.edgeStartTex, set.u_edge_start_tex);

    if (set.u_data_width) gl.uniform1i(set.u_data_width, DATA_TEX_WIDTH);
    if (set.u_cell_base) gl.uniform1i(set.u_cell_base, draw.cellOffset);
    if (set.u_cells) gl.uniform1f(set.u_cells, draw.grid);
    if (set.u_opacity) gl.uniform1f(set.u_opacity, opacity);
    if (set.u_zoom) gl.uniform1f(set.u_zoom, zoom);
    if (set.u_dash_world_px) gl.uniform1f(set.u_dash_world_px, DASH_TILE_PX * 2 ** zoom);
    if (set.u_dash_tile_px) {
      gl.uniform1f(set.u_dash_tile_px, DASH_TILE_PX * 2 ** (zoom - draw.tileZ));
    }
    if (set['u_source_factors[0]']) {
      gl.uniform2fv(set['u_source_factors[0]'], sourceFactors);
    }
    if (set.u_light_dir) {
      gl.uniform3f(set.u_light_dir, light.direction[0], light.direction[1], light.direction[2]);
    }
    if (set.u_shade_strength) gl.uniform1f(set.u_shade_strength, light.strength);
    if (set.u_tile_meters) gl.uniform1f(set.u_tile_meters, draw.groundMeters);
    // The lift is made proportional to the tile's ground size. It then amounts to
    // the same quantity on screen, so at any zoom it stays within "too small to
    // see, yet reliably winning in depth". A constant depth bias (polygonOffset)
    // depends on the on-screen gradient of the depth and on the resolution of the
    // depth buffer, so on a shallow-angle slope it works too strongly or not at all
    if (set.u_drape_lift_m) {
      gl.uniform1f(set.u_drape_lift_m, draw.groundMeters * DRAPE_LIFT_RATIO);
    }
    // The appearance of the selection highlight is constant, so the values
    // themselves are the same every frame (a uniform is state that persists per
    // program, so writing it once per tile is enough)
    if (set.u_selection_color) {
      gl.uniform4f(
        set.u_selection_color,
        SELECTION_HIGHLIGHT_RGB[0],
        SELECTION_HIGHLIGHT_RGB[1],
        SELECTION_HIGHLIGHT_RGB[2],
        SELECTION_HIGHLIGHT_FILL_OPACITY,
      );
    }
    if (set.u_selection_stroke_extra) {
      gl.uniform1f(set.u_selection_stroke_extra, SELECTION_HIGHLIGHT_STROKE_EXTRA * pixelRatio);
    }
    // The segment of range drawing. When omitted, all elements are painted and the
    // selection highlight is composed as well (a uniform is state that persists per
    // program, so it is written explicitly every time)
    if (set.u_paint_range) {
      gl.uniform2f(set.u_paint_range, segment?.paintFrom ?? 0, segment?.paintTo ?? 1e9);
    }
    if (set.u_emit_selection) {
      gl.uniform1f(set.u_emit_selection, (segment?.emitSelection ?? true) ? 1 : 0);
    }
    // The step and the DEM are written from one and the same value (see the note in
    // edge-constrain.ts)
    applyEdgeConstrainUniforms(gl, set, draw.edges, draw.terrain);

    // The ground surface is one-sided, but a slope is sometimes seen from behind.
    // No culling is applied
    gl.disable(gl.CULL_FACE);

    gl.bindVertexArray(mesh.vao);
    gl.drawElements(gl.TRIANGLES, mesh.indexCount, gl.UNSIGNED_INT, 0);
    gl.bindVertexArray(null);
    gl.activeTexture(gl.TEXTURE0);
  }

  /**
   * Releases the resources
   */
  dispose(): void {
    const gl = this.gl;
    if (this.program) {
      gl.deleteProgram(this.program);
      this.program = null;
    }
    if (this.mesh) {
      disposeTerrainMeshBuffers(gl, this.mesh);
      this.mesh = null;
    }
    for (const texture of [
      this.edgeTex,
      this.edgeStartTex,
      this.runTex,
      this.cellTex,
      this.styleTex,
    ]) {
      if (texture) gl.deleteTexture(texture);
    }
    this.edgeTex = null;
    this.edgeStartTex = null;
    this.runTex = null;
    this.cellTex = null;
    this.styleTex = null;
    this.edgeTexSize = [0, 0];
    this.edgeStartTexSize = [0, 0];
    this.runTexSize = [0, 0];
    this.cellTexSize = [0, 0];
    this.styleTexSize = [0, 0];
    this.uploaded = emptyUploadMark();
    this.uploadedSelection = -1;
  }

  private bindData(
    unit: number,
    texture: WebGLTexture | null,
    location: WebGLUniformLocation | null,
  ): void {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    if (location) gl.uniform1i(location, unit);
  }

  /** The tallest data texture this GPU allows (MAX_TEXTURE_SIZE, read once) */
  private textureSizeLimit(): number {
    if (this.maxTextureSize === 0) {
      const max = Number(this.gl.getParameter(this.gl.MAX_TEXTURE_SIZE));
      this.maxTextureSize = Number.isFinite(max) && max > 0 ? max : 4096;
    }
    return this.maxTextureSize;
  }

  /**
   * Allocates a data texture and transfers the rows that have not been sent yet
   *
   * texStorage2D is immutable, so the texture is recreated whenever the required
   * size changes (once recreated, everything is sent again).
   *
   * @param channels The numbers per texel: 4 (RGBA32F) or 1 (R32F)
   */
  private uploadTexture(
    texture: WebGLTexture | null,
    sizeField: 'edgeTexSize' | 'edgeStartTexSize' | 'runTexSize' | 'cellTexSize' | 'styleTexSize',
    markField: 'edges' | 'edgeStarts' | 'runs' | 'cells' | 'styles',
    width: number,
    data: Float32Array,
    texelCount: number,
    channels: 1 | 4 = 4,
  ): WebGLTexture | null {
    const gl = this.gl;
    const size = this[sizeField];
    const neededRows = Math.max(1, Math.ceil(texelCount / width));
    const maxRows = this.textureSizeLimit();

    let target = texture;
    if (!target || size[0] !== width || size[1] < neededRows) {
      if (target) gl.deleteTexture(target);
      this[sizeField] = [0, 0];
      this.uploaded[markField] = 0;
      // A table taller than the GPU allows cannot be allocated (texStorage2D would fail with
      // INVALID_VALUE and leave a texture that samples as zeros)
      if (neededRows > maxRows) {
        this.lastError = `texture-limit: ${markField} needs ${neededRows} rows of ${maxRows}`;
        return null;
      }
      target = gl.createTexture();
      if (!target) return null;
      // Allocate a few extra rows (so it is not recreated on every increase)
      const rows = Math.min(maxRows, Math.max(1, Math.ceil(neededRows * 1.5)));
      gl.bindTexture(gl.TEXTURE_2D, target);
      gl.texStorage2D(gl.TEXTURE_2D, 1, channels === 4 ? gl.RGBA32F : gl.R32F, width, rows);
      // Only the allocation is checked (it is rare; getError is a synchronous round trip)
      if (gl.getError() !== gl.NO_ERROR) {
        gl.deleteTexture(target);
        this.lastError = `texture-alloc-failed: ${markField}`;
        return null;
      }
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this[sizeField] = [width, rows];
      this.uploaded[markField] = 0;
    } else {
      gl.bindTexture(gl.TEXTURE_2D, target);
    }

    const uploaded = this.uploaded[markField];
    if (texelCount <= uploaded) return target;

    // Writing continues from the middle of an already transferred row, so the
    // transfer starts at the beginning of that row
    const fromRow = Math.floor(uploaded / width);
    const toRow = Math.ceil(texelCount / width);
    const rows = toRow - fromRow;
    const needed = rows * width * channels;
    const offset = fromRow * width * channels;
    const payload =
      data.length >= offset + needed
        ? data.subarray(offset, offset + needed)
        : padTo(data.subarray(offset), needed);
    const format = channels === 4 ? gl.RGBA : gl.RED;
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, fromRow, width, rows, format, gl.FLOAT, payload);
    this.uploaded[markField] = texelCount;
    return target;
  }
}

/** Nothing transferred yet */
function emptyUploadMark(): UploadMark {
  return { builderId: -1, edges: 0, edgeStarts: 0, runs: 0, cells: 0, styles: 0 };
}

/** Pads with 0 up to the length required for the transfer */
function padTo(data: Float32Array, length: number): Float32Array {
  const out = new Float32Array(length);
  out.set(data.subarray(0, Math.min(data.length, length)));
  return out;
}
