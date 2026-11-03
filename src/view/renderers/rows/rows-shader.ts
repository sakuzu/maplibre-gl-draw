// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The GLSL sources of the program that draws rows of every kind in one draw (`RowsRenderer`)
 *
 * The vertex and the fragment stages branch on the kind of the instance (`rows-format.ts`), and
 * each branch is the formula of the renderer that draws that kind elsewhere, as it is:
 *
 * - a point: the instanced points (`point-instance.ts`), the fill and the stroke in one quad
 * - a segment of a line: the SDF lines (`line-shader.ts`) with one station, its miter falling
 *   back to a bevel, its box coverage and its color multiplied into every component
 * - an edge of the outline of a polygon: the outline of the SDF polygons (`sdf-polygon.ts`), its
 *   miter only shortened, its two-pixel smoothing and its factor on the alpha only
 * - the fill of a polygon: the fill of the SDF polygons, with the shading of the terrain
 * - a dashed segment (of a line, or of the outline of a polygon): the segment of a line, cut into
 *   dashes and gaps by the pattern the lines dashed on the CPU use (`dash.ts`), each dash with
 *   the round ends it gets there. The CPU draws each dash as a line of its own: a dash that goes
 *   on over a corner gets the miter of the corner, and one that ends near a corner gets a round
 *   end that reaches over it. A segment here draws the dashes the CPU draws on it, its own (cut
 *   at its ends, where a dash going on over a corner keeps its miter), and the parts of the
 *   dashes of the segments next to it that reach over the corners into its strip
 * - a sprite: a picture of a texture an extension gives, centered on its point
 *
 * On the terrain and on the globe the same branches draw the rows cut for the surface: the fill
 * of a polygon is triangles cut on the mesh of the surface and the outline its rings cut alike,
 * and a line is drawn in pieces, `[t0, t1]` of its segments (`a_tail.yz`), each piece between
 * two points of its segment on the Mercator plane. A point and a sprite take the elevation of
 * the ground under them from the heights of their chunk (`u_heights`), which the CPU writes with
 * the elevation the hit testing projects them with, and are drawn faint where the terrain hides
 * them from the camera (`TERRAIN_OCCLUSION_GLSL`); on the far side of the globe they are not
 * drawn.
 *
 * The program has its own projection prelude for each variant (`rowsProjectionPrelude`): it
 * projects with the functions of the library alone and reads of the prelude maplibre gives a
 * custom layer only its uniforms, so both variants are compiled before either is drawn.
 *
 * The blending is the one of the layer, so the branches differ only in what they emit. The
 * shaders never read `gl_InstanceID`: a range of rows is drawn by pointing the instance
 * attributes at its first instance, so the place of an instance in a draw means nothing.
 */

import { DEFAULT_TILE_SIZE, RENDERING_DEFAULTS } from '../../../shared/math/index.js';
import { CENTER_PROJECTION_CONSTANTS, glslFloat32 } from '../../shaders/center-projection.js';
import {
  getProjectionTransitionUniform,
  OFFSET_MODE_GLSL,
  type ShaderData,
} from '../../shaders/helpers.js';
import {
  TERRAIN_SHADE_FRAGMENT_GLSL,
  TERRAIN_SHADE_VERTEX_GLSL,
} from '../../shaders/terrain-shade.js';
import {
  DRAPE_GROUND_BLOCKS,
  DRAPE_GROUND_COARSE_BLOCKS,
  DRAPE_GROUND_PLACE_STEPS,
  DRAPE_GROUND_SHADE_RANGE,
} from '../../terrain/drape/ground-buffer.js';
import { TERRAIN_OCCLUSION_GLSL } from '../../terrain/occlusion.js';
import { DASH_COEFFICIENTS } from '../line/dash.js';
import { POINT_AA_PADDING_PX, POINT_MIN_OUTER_PX } from '../point/point-instance.js';
import { POINT_SDF_GLSL } from '../point/point-sdf.js';
import { ROW_HIDDEN_POSITION_GLSL, ROW_STATE_GLSL } from '../row-state.js';
import {
  ROW_SPRITE_SCALE_MAX_STOPS,
  ROWS_EDGE_FRINGE,
  ROWS_EDGE_INSIDE_LEFT,
  ROWS_KIND,
  ROWS_KIND_SHIFT,
  ROWS_PAIR_EDGE_BITS,
  ROWS_PAIR_EDGES,
  ROWS_ROW_MASK,
  ROWS_STYLE_TEXELS,
} from './rows-format.js';

/** A float literal of GLSL */
function glslFloat(value: number): string {
  const text = String(value);
  return /[.eE]/.test(text) ? text : `${text}.0`;
}

/** A distance no fragment is near (device px): the end of a dash that has none */
const FAR = 1e6;

/**
 * The width, as a share of a segment whatever its length, of the points the direction of a line
 * is taken from where its segment is cut: the two pieces that meet there take the same direction,
 * from the points of the segment as far before and after the cut
 */
const JOINT_WIDTH = 1 / 64;

/**
 * The depth of the vertices of a point or a sprite in clip space: just inside the near plane,
 * so that a depth test, where one is on, never hides a symbol (exactly on the plane, rounding
 * can clip it)
 */
const SYMBOL_DEPTH = -0.999;

/**
 * The projection variants of the program: the flat map, and the globe (with the transition
 * between the globe and the flat map)
 *
 * @internal
 */
export type RowsVariant = 'flat' | 'globe';

/** The variants, in the order they are compiled */
export const ROWS_VARIANTS: readonly RowsVariant[] = ['flat', 'globe'];

/**
 * The variant of the program that draws in the projection of a frame (the globe where maplibre
 * draws the globe)
 *
 * @internal
 */
export function rowsVariantOf(shaderData: Pick<ShaderData, 'define'>): RowsVariant {
  return /#define\s+GLOBE\b/.test(shaderData.define) ? 'globe' : 'flat';
}

/**
 * The projection prelude and the defines of a variant: the uniforms of the projection maplibre
 * writes the values of, declared as its preludes declare them, and \`GLOBE\` on the globe
 *
 * @internal
 */
export function rowsProjectionPrelude(variant: RowsVariant): { prelude: string; define: string } {
  if (variant === 'flat') return { prelude: 'uniform mat4 u_projection_matrix;\n', define: '' };
  return {
    prelude: `uniform mat4 u_projection_matrix;
uniform highp vec4 u_projection_tile_mercator_coords;
uniform highp vec4 u_projection_clipping_plane;
uniform highp float u_projection_transition;
uniform mat4 u_projection_fallback_matrix;
`,
    define: '#define GLOBE',
  };
}

/**
 * The vertex shader source
 *
 * @param prelude The vertex shader prelude maplibre hands to the custom layer
 * @param define The defines of the projection variant
 * @internal
 */
export function buildRowsVertexSource(prelude: string, define: string, ground = false): string {
  const dashed = DASH_COEFFICIENTS.dashed;
  const dotted = DASH_COEFFICIENTS.dotted;
  return `#version 300 es
#define TABLE_ROWS
${ground ? '#define ROWS_GROUND' : ''}
${prelude}
${define}
${getProjectionTransitionUniform(prelude)}${OFFSET_MODE_GLSL}${TERRAIN_SHADE_VERTEX_GLSL}${ROW_STATE_GLSL}${TERRAIN_OCCLUSION_GLSL}

// The corner of the strip of 4 vertices (0 to 3)
layout(location = 0) in float a_corner;
// The tag: the kind above bit ${ROWS_KIND_SHIFT} and the number of the row in its group below it,
// taken apart with a shift and a mask (exact on every GPU)
layout(location = 1) in uint a_tag;
// xyz: coordinates 0 to 2
layout(location = 2) in vec3 a_head;
// x: coordinate 3, y and z: the range of the segment drawn, w: the length of the line before a
// dashed segment (CSS px at zoom 0)
layout(location = 3) in vec4 a_tail;

// The coordinates of the chunk (offsets from its origin)
uniform sampler2D u_coords;
uniform int u_coord_width;
// The elevation of the ground under each coordinate of a point (meters), as the coordinates
uniform sampler2D u_heights;
// 1 when the points and the sprites stand on the terrain (their elevation from u_heights)
uniform float u_symbol_terrain;
// The style of each row of the chunk: x the number of its style, y its created zoom, z 1 when it
// has one
uniform sampler2D u_row_styles;
uniform int u_row_style_width;
// The first row of the chunk in its group
uniform int u_row_base;
// The values of the styles of the layer, ${ROWS_STYLE_TEXELS} texels per style
uniform sampler2D u_styles;
uniform int u_style_width;

uniform vec2 u_viewport;
uniform float u_zoom;
uniform float u_miter_limit;
uniform float u_size_scale;
// The factor from device pixels to clip space
uniform vec2 u_pixel_to_clip;
// Device pixels per CSS px (the sprites are sized in CSS px)
uniform float u_screen_ratio;
// The clip w of the center of the screen (how far the camera is from it)
uniform float u_camera_to_center_w;
// The bearing of the map (degrees)
uniform float u_bearing;
// How the size of the sprites follows the distance: stops of (distance ratio, factor), in
// ascending order of the ratio, u_sprite_scale_count of them (0: it does not)
uniform vec2 u_sprite_scale_stops[${ROW_SPRITE_SCALE_MAX_STOPS}];
uniform int u_sprite_scale_count;

flat out int v_kind;
// The color (the fill of a point)
flat out vec4 v_color;
// The stroke of a point
flat out vec4 v_color2;
// A point: radius, outer radius, ink, shape. A segment: half width, length on screen. An edge
// of an outline: half width. A sprite: ink
flat out vec4 v_params;
// A dashed segment: the dash, the period (CSS px), CSS px per device pixel along the segment (a
// period of 0: not dashed)
flat out vec3 v_dash;
// A dashed segment: the positions of its start and of its end on the line (CSS px), 1 when its end
// is the end of the line
flat out vec3 v_dash_range;
// A dashed segment: the dash of the segment before it whose round end reaches over the corner at
// its start, and the one of the segment after it whose round end reaches over the corner at its
// end. x and y: the cosine and the sine that turn a direction along this segment into one along
// that segment; z and w: where the dash starts and ends on that segment, in device px from the
// corner (far away for none)
flat out vec4 v_dash_prev;
flat out vec4 v_dash_next;
// A point: the offset in device pixels. A segment: the signed distance from its center line, the
// position along it, and for a dashed one its position on the line (CSS px). An edge of an
// outline: the signed distance. A sprite: the texture coordinates
out vec4 v_geom;

// The state of the row of the instance: its moving set moves every coordinate read
uint g_row_state = 0u;
int g_corner = 0;

vec2 rowsCoord(float index) {
    int i = int(index + 0.5);
    return rowStateMove(g_row_state, texelFetch(u_coords, ivec2(i % u_coord_width, i / u_coord_width), 0).xy);
}

vec4 rowsStyle(int style, int texel) {
    int i = style * ${ROWS_STYLE_TEXELS} + texel;
    return texelFetch(u_styles, ivec2(i % u_style_width, i / u_style_width), 0);
}

vec4 rowsProject(vec2 offset) {
    return project_position_to_clipspace_from_offset(offset, u_projection_matrix);
}

// The position at t along the segment from a to b (offsets from the origin): its ends as they
// are, a point between them on the Mercator plane, which the lines on the terrain and on the
// globe go along
vec4 rowsProjectAlong(vec2 a, vec2 b, float t) {
    if (t == 0.0) return rowsProject(a);
    if (t == 1.0) return rowsProject(b);
    vec2 ma = project_offset(vec3(a + origin_shift(), 0.0)).xy;
    vec2 mb = project_offset(vec3(b + origin_shift(), 0.0)).xy;
    return project_mercator_offset_to_clipspace(mix(ma, mb, t), u_projection_matrix);
}

// The elevation of the ground under the anchor of a point or a sprite (meters): the one the CPU
// wrote for its coordinate, with which the hit testing projects it, or for a row a moving set
// moves, the one of the DEM where it is drawn (the CPU writes it when the move ends)
float rowsAnchorElevation(float index, vec2 offset) {
    if (u_symbol_terrain < 0.5) return 0.0;
    if (((g_row_state >> 1u) & 3u) != 0u) return dem_elevation_meters(shade_mercator_offset(offset));
    int i = int(index + 0.5);
    return texelFetch(u_heights, ivec2(i % u_coord_width, i / u_coord_width), 0).r;
}

// Projects the anchor of a point or a sprite at its elevation (meters), as the hit testing
// projects it
vec4 rowsProjectAnchor(vec2 offset, float elevation) {
    vec2 lngLatOffset = offset + origin_shift();
    vec2 halfLat = half_latitude_offset(lngLatOffset.y);
    vec2 mercatorOffset = vec2(lngLatOffset.x * ${glslFloat32(CENTER_PROJECTION_CONSTANTS.perDegree)}, mercator_offset_y(halfLat));
    return project_center_offset(mercatorOffset, lngLatOffset.x, halfLat, elevation * u_elevation_params.x, u_projection_matrix);
}

// Whether the anchor of a symbol is not drawn: behind the camera, or on the far side of the
// globe (its depth past the far plane, as the clipping of the globe gives it)
bool rowsAnchorHidden(vec4 clip) {
    if (clip.w <= 0.0) return true;
#ifdef GLOBE
    if (u_projection_transition > 0.0 && clip.z > clip.w) return true;
#endif
    return false;
}

// The opacity of a symbol at an anchor and its elevation (meters): faint where the terrain
// hides it from the camera
float rowsGhost(vec2 offset, float elevation) {
    if (u_ghost_on < 0.5) return 1.0;
    return terrainGhostOpacity(shade_mercator_offset(offset), elevation * u_elevation_params.x);
}

vec2 clipToScreen(vec4 clip) {
    vec2 ndc = clip.xy / clip.w;
    return (ndc * 0.5 + 0.5) * u_viewport;
}

vec2 screenToClipOffset(vec2 screenOffset, float w) {
    return screenOffset * 2.0 / u_viewport * w;
}

// The corner of the quad of a point or a sprite: (-1, -1), (1, -1), (-1, 1), (1, 1)
vec2 quadCorner() {
    return vec2((g_corner & 1) == 1 ? 1.0 : -1.0, (g_corner & 2) == 2 ? 1.0 : -1.0);
}

// The length of a segment as the lines dashed on the CPU measure it, in CSS px at zoom 0
float dashLength0(vec2 a, vec2 b) {
    vec2 base = origin_shift() + u_center_lnglat;
    float latitude = (a.y + b.y) * 0.5 + base.y;
    float cosLatitude = max(cos(latitude * PI / 180.0), 1e-6);
    float perDegree = ${glslFloat(DEFAULT_TILE_SIZE)} / 360.0;
    return length(vec2((b.x - a.x) * perDegree, (b.y - a.y) * perDegree / cosLatitude));
}

// The dash of the segment from \`from\` to \`to\` (on screen, \`lengthCss\` long on the line) next to
// a dashed segment going along \`dir\` whose round end is at the corner they share (at \`corner\` on
// the line, CSS px), as \`v_dash_prev\` and \`v_dash_next\` hold it. A dash that goes on over the
// corner is drawn on both sides of it up to the miter, so nothing of it reaches over; one cut at
// the corner or near it has a round end that does. \`before\`: the segment is the one before the
// corner (its last dash), else the one after it (its first dash)
vec4 dashNeighbor(vec2 from, vec2 to, float lengthCss, vec2 dir, float corner, vec2 pattern, bool before) {
    vec4 none = before ? vec4(1.0, 0.0, -2.0 * ${glslFloat(FAR)}, -${glslFloat(FAR)})
        : vec4(1.0, 0.0, ${glslFloat(FAR)}, 2.0 * ${glslFloat(FAR)});
    vec2 along = to - from;
    float px = length(along);
    if (px <= 0.0) return none;
    vec2 other = along / px;
    float perPx = lengthCss / px;
    float dash = pattern.x;
    float period = pattern.x + pattern.y;
    float m = mod(corner, period);
    if (m > 0.0 && m < dash) return none;
    vec2 turn = vec2(dot(dir, other), dot(dir, vec2(-other.y, other.x)));
    if (before) {
        // The last dash that ends at the corner or before it, on the segment
        float end = m >= dash ? corner - m + dash : corner - pattern.y;
        float first = corner - lengthCss;
        if (end <= first) return none;
        return vec4(turn, (max(end - dash, first) - corner) / perPx, (end - corner) / perPx);
    }
    // The first dash that starts at the corner or after it, on the segment
    float start = m > 0.0 ? corner - m + period : corner;
    float last = corner + lengthCss;
    if (start >= last) return none;
    return vec4(turn, (start - corner) / perPx, (min(start + dash, last) - corner) / perPx);
}

void drawPoint(int style) {
    vec2 offset = rowsCoord(a_head.x);
    emitShadeOffset(offset);
    float elevation = rowsAnchorElevation(a_head.x, offset);
    vec4 centerClip = rowsProjectAnchor(offset, elevation);
    if (rowsAnchorHidden(centerClip)) {
        gl_Position = ${ROW_HIDDEN_POSITION_GLSL};
        return;
    }
    vec4 size = rowsStyle(style, 2);
    float radius = max(size.x, 0.0) * u_size_scale;
    float outer = radius + max(size.y, 0.0) * u_size_scale;
    float ink = 1.0;
    if (outer > 0.0 && outer < ${glslFloat(POINT_MIN_OUTER_PX)}) {
        float grow = ${glslFloat(POINT_MIN_OUTER_PX)} / outer;
        ink = 1.0 / (grow * grow);
        radius *= grow;
        outer = ${glslFloat(POINT_MIN_OUTER_PX)};
    }
    vec2 offsetPx = quadCorner() * (outer + ${glslFloat(POINT_AA_PADDING_PX)});
    gl_Position = vec4(centerClip.xy / centerClip.w + offsetPx * u_pixel_to_clip, ${glslFloat(SYMBOL_DEPTH)}, 1.0);
    v_color = rowsStyle(style, 0);
    v_color2 = rowsStyle(style, 1);
    v_params = vec4(radius, outer, ink * rowsGhost(offset, elevation), size.z);
    v_geom = vec4(offsetPx, 0.0, 0.0);
}

// The factor of the size of a sprite at a ratio of distances: linear between two stops, that of
// the first or the last stop beyond them
float spriteDistanceScale(float distanceRatio) {
    vec2 first = u_sprite_scale_stops[0];
    if (distanceRatio <= first.x) return first.y;
    for (int i = 1; i < ${ROW_SPRITE_SCALE_MAX_STOPS}; i++) {
        if (i >= u_sprite_scale_count) break;
        vec2 next = u_sprite_scale_stops[i];
        if (distanceRatio <= next.x) {
            vec2 previous = u_sprite_scale_stops[i - 1];
            return mix(previous.y, next.y, (distanceRatio - previous.x) / max(next.x - previous.x, 1e-9));
        }
    }
    return u_sprite_scale_stops[u_sprite_scale_count - 1].y;
}

void drawSprite(int style) {
    vec2 offset = rowsCoord(a_head.x);
    emitShadeOffset(offset);
    float elevation = rowsAnchorElevation(a_head.x, offset);
    vec4 centerClip = rowsProjectAnchor(offset, elevation);
    if (rowsAnchorHidden(centerClip)) {
        gl_Position = ${ROW_HIDDEN_POSITION_GLSL};
        return;
    }
    vec3 centerNdc = centerClip.xyz / centerClip.w;
    vec4 uv = rowsStyle(style, 0);
    vec4 shape = rowsStyle(style, 1);
    float ratio = 1.0;
    if (u_sprite_scale_count > 0 && u_camera_to_center_w > 0.0 && centerClip.w > 0.0) {
        ratio = spriteDistanceScale(u_camera_to_center_w / centerClip.w);
        ratio = mix(ratio, 1.0, u_projection_transition);
    }
    vec2 halfPx = shape.xy * u_size_scale * ratio;
    // A picture smaller than a pixel is drawn a pixel wide, fainter by the ratio of the areas
    float extentPx = 2.0 * max(halfPx.x, halfPx.y);
    float ink = 1.0;
    if (extentPx < 1.0) {
        ink = extentPx * extentPx;
        halfPx /= max(extentPx, 1e-6);
    }
    vec2 unit = quadCorner();
    // Y-down pixels; a picture with a bearing turns by it minus the bearing of the map
    vec2 pixelOffset = unit * halfPx;
    if (shape.z >= 0.0) {
        float angle = radians(shape.z - u_bearing);
        float sinA = sin(angle);
        float cosA = cos(angle);
        pixelOffset = vec2(
            pixelOffset.x * cosA - pixelOffset.y * sinA,
            pixelOffset.x * sinA + pixelOffset.y * cosA
        );
    }
    vec2 offsetNdc = pixelOffset * u_screen_ratio * u_pixel_to_clip * vec2(1.0, -1.0);
    gl_Position = vec4(centerNdc.xy + offsetNdc, ${glslFloat(SYMBOL_DEPTH)}, 1.0);
    v_params = vec4(ink * rowsGhost(offset, elevation), 0.0, 0.0, 0.0);
    v_geom = vec4(mix(uv.xy, uv.zw, unit * 0.5 + 0.5), 0.0, 0.0);
}

// The miter at an end of a segment where the line goes on: its normal and the factor of its
// length, from the normal of the segment there and the direction of the line before or after it
// (on screen). Past the miter limit the end falls back to the normal of the segment (a bevel)
vec3 segmentMiter(vec2 own, vec2 otherDir) {
    vec2 otherNormal = vec2(-otherDir.y, otherDir.x);
    vec2 avgNormal = otherNormal + own;
    float avgLen = length(avgNormal);
    if (avgLen > 0.001) {
        vec2 miterNormal = avgNormal / avgLen;
        float cosHalf = dot(miterNormal, own);
        if (cosHalf > 0.001) {
            float miterScale = 1.0 / cosHalf;
            if (miterScale > u_miter_limit) return vec3(own, 1.0);
            return vec3(miterNormal, miterScale);
        }
        return vec3(miterNormal, 1.0);
    }
    return vec3(own, 1.0);
}

void drawSegment(int kind, int style, float createdZoom, bool hasCreatedZoom) {
    int prevIdx = int(a_head.x);
    int nextIdx = int(a_tail.x);
    // The piece of the segment drawn, [t0, t1] of it: the whole segment (0 and 1) on a flat map,
    // a piece of a segment cut on the terrain or the globe into pieces of equal length
    float t0 = a_tail.y;
    float t1 = a_tail.z;
    float span = t1 - t0;
    bool cutStart = t0 > 0.0;
    bool cutEnd = t1 < 1.0;
    bool atStart = g_corner < 2;
    bool atEnd = !atStart;
    float t = atStart ? 0.0 : 1.0;
    float side = (g_corner & 1) == 0 ? 1.0 : -1.0;

    vec2 startOffset = rowsCoord(a_head.y);
    vec2 endOffset = rowsCoord(a_head.z);
    emitShadeOffset(atStart ? startOffset : endOffset);
    vec4 startClip = rowsProjectAlong(startOffset, endOffset, t0);
    vec4 endClip = rowsProjectAlong(startOffset, endOffset, t1);
    vec2 startScreen = clipToScreen(startClip);
    vec2 endScreen = clipToScreen(endClip);
    vec4 currentClip = atStart ? startClip : endClip;

    vec2 segmentVec = endScreen - startScreen;
    float screenSegmentLength = length(segmentVec);
    vec2 segmentDir = segmentVec / screenSegmentLength;
    vec2 normal = vec2(-segmentDir.y, segmentDir.x);
    // The ends of the whole segment on screen, and its direction: the miter at a vertex of the
    // line takes it for this segment, as the piece of the segment next to it there does
    vec2 wholeStart = startScreen;
    vec2 wholeEnd = endScreen;
    if (cutStart || cutEnd) {
        wholeStart = clipToScreen(rowsProject(startOffset));
        wholeEnd = clipToScreen(rowsProject(endOffset));
    }
    vec2 wholeDir = cutStart || cutEnd ? normalize(wholeEnd - wholeStart) : segmentDir;
    vec2 wholeNormal = vec2(-wholeDir.y, wholeDir.x);

    // Where a segment is cut, the two pieces that meet there take the normal of the line there,
    // from the points of the segment a share of it before and after the cut
    vec3 miter = vec3(normal, 1.0);
    if (atStart) {
        if (cutStart) {
            vec2 dir = clipToScreen(rowsProjectAlong(startOffset, endOffset, t0 + ${glslFloat(JOINT_WIDTH)}))
                - clipToScreen(rowsProjectAlong(startOffset, endOffset, t0 - ${glslFloat(JOINT_WIDTH)}));
            dir = normalize(dir);
            miter = vec3(-dir.y, dir.x, 1.0);
        } else if (prevIdx >= 0) {
            vec2 prevScreen = clipToScreen(rowsProject(rowsCoord(a_head.x)));
            miter = segmentMiter(wholeNormal, normalize(startScreen - prevScreen));
        }
    } else if (cutEnd) {
        vec2 dir = clipToScreen(rowsProjectAlong(startOffset, endOffset, t1 + ${glslFloat(JOINT_WIDTH)}))
            - clipToScreen(rowsProjectAlong(startOffset, endOffset, t1 - ${glslFloat(JOINT_WIDTH)}));
        dir = normalize(dir);
        miter = vec3(-dir.y, dir.x, 1.0);
    } else if (nextIdx >= 0) {
        vec2 nextScreen = clipToScreen(rowsProject(rowsCoord(a_tail.x)));
        miter = segmentMiter(wholeNormal, normalize(nextScreen - endScreen));
    }
    vec2 miterNormal = miter.xy;
    float miterScale = miter.z;

    // The widths of a line, or of the dashed outline of a polygon, and its color
    bool outline = kind == ${ROWS_KIND.dashedOutline};
    vec4 widths = rowsStyle(style, outline ? 2 : 1);
    vec4 color = rowsStyle(style, outline ? 3 : 0);
    // A width that follows the zoom from the created zoom, or a fixed one (negative)
    float strokeWidth = hasCreatedZoom ? widths.x : widths.y;
    float lineWidth = (strokeWidth > 0.0
        ? strokeWidth * pow(2.0, u_zoom - createdZoom)
        : (strokeWidth < 0.0 ? -strokeWidth : 0.0)) * u_size_scale;
    float ink = clamp(lineWidth, 0.0, 1.0);
    lineWidth = max(lineWidth, 1.0);
    float halfWidth = lineWidth / 2.0;
    float expandedHalfWidth = halfWidth + 1.0;

    vec2 screenOffset = miterNormal * side * expandedHalfWidth * miterScale;
    // The ends of the line are round; the ends of the pieces of a cut segment are not
    bool isStartCap = atStart && !cutStart && (prevIdx < 0);
    bool isEndCap = atEnd && !cutEnd && (nextIdx < 0);
    vec2 capOffset = vec2(0.0);
    float linePos = t * screenSegmentLength;
    if (isStartCap) {
        capOffset = -segmentDir * expandedHalfWidth;
        linePos = -expandedHalfWidth;
    } else if (isEndCap) {
        capOffset = segmentDir * expandedHalfWidth;
        linePos = screenSegmentLength + expandedHalfWidth;
    }
    vec2 vertexOffset = screenOffset + capOffset;
    vec2 totalClipOffset = screenToClipOffset(vertexOffset, currentClip.w);
    gl_Position = currentClip + vec4(totalClipOffset, 0.0, 0.0);

    v_color = vec4(color.rgb, color.a * ink);
    v_params = vec4(halfWidth, screenSegmentLength, 0.0, 0.0);
    v_geom = vec4(side * expandedHalfWidth, linePos, 0.0, 0.0);

    int pattern = int(widths.w + 0.5);
    if (pattern > 0 && screenSegmentLength > 0.0) {
        // The pattern of the lines dashed on the CPU (dash.ts), from the width drawn in CSS px
        float cssWidth = widths.z
            * (hasCreatedZoom ? pow(2.0, u_zoom - createdZoom) : 1.0)
            * u_size_scale;
        vec3 k = pattern == 1
            ? vec3(${glslFloat(dashed.a)}, ${glslFloat(dashed.b)}, ${glslFloat(dashed.c)})
            : vec3(${glslFloat(dotted.a)}, ${glslFloat(dotted.b)}, ${glslFloat(dotted.c)});
        float dash = max(k.x, k.y * cssWidth);
        float gap = max(cssWidth + 1.0, k.z * cssWidth);
        float scale = pow(2.0, u_zoom);
        // The dashes of the whole segment: a piece of it draws the parts of them in its strip, so
        // a dash and its round ends are drawn whatever the lengths of the pieces
        float wholeCss = dashLength0(startOffset, endOffset) * scale;
        float firstCss = a_tail.w * scale;
        float startCss = firstCss + t0 * wholeCss;
        float lengthCss = span * wholeCss;
        float cssPerPx = lengthCss / screenSegmentLength;
        v_dash = vec3(dash, dash + gap, cssPerPx);
        v_dash_range = vec3(firstCss, firstCss + wholeCss, nextIdx < 0 ? 1.0 : 0.0);
        // The dashes of the segments before and after it whose round ends reach over its corners
        if (prevIdx >= 0) {
            vec2 prevOffset = rowsCoord(a_head.x);
            v_dash_prev = dashNeighbor(
                clipToScreen(rowsProject(prevOffset)), wholeStart,
                dashLength0(prevOffset, startOffset) * scale, wholeDir, firstCss,
                vec2(dash, gap), true
            );
        }
        if (nextIdx >= 0) {
            vec2 nextOffset = rowsCoord(a_tail.x);
            v_dash_next = dashNeighbor(
                wholeEnd, clipToScreen(rowsProject(nextOffset)),
                dashLength0(endOffset, nextOffset) * scale, wholeDir, firstCss + wholeCss,
                vec2(dash, gap), false
            );
        }
        // The position of this vertex on the line: its projection on the segment. A corner of a
        // miter lies ahead of or behind the end of the segment, so the position along the strip
        // (linePos, the end of the segment at both corners) would shear the dashes of the whole
        // segment by up to the length of the miter; the projection is exact everywhere in it,
        // as the dashes cut on the CPU are
        float along = t * screenSegmentLength + dot(vertexOffset, segmentDir);
        v_geom.z = startCss + along * cssPerPx;
    }
}

void drawOutline(int style, float createdZoom, bool hasCreatedZoom) {
    bool first = g_corner < 2;
    float side = (g_corner & 1) == 0 ? 1.0 : -1.0;
    vec2 pos = rowsCoord(first ? a_head.y : a_head.z);
    vec2 prev = rowsCoord(first ? a_head.x : a_head.y);
    vec2 next = rowsCoord(first ? a_head.z : a_tail.x);
    emitShadeOffset(pos);

    vec4 clipPos = rowsProject(pos);
    vec4 clipPrev = rowsProject(prev);
    vec4 clipNext = rowsProject(next);
    vec2 screenPos = (clipPos.xy / clipPos.w * 0.5 + 0.5) * u_viewport;
    vec2 screenPrev = (clipPrev.xy / clipPrev.w * 0.5 + 0.5) * u_viewport;
    vec2 screenNext = (clipNext.xy / clipNext.w * 0.5 + 0.5) * u_viewport;
    vec2 dirPrev = normalize(screenPos - screenPrev);
    vec2 dirNext = normalize(screenNext - screenPos);
    vec2 normalPrev = vec2(-dirPrev.y, dirPrev.x);
    vec2 normalNext = vec2(-dirNext.y, dirNext.x);
    vec2 miterNormal = normalize(normalPrev + normalNext);
    float cosHalfAngle = dot(miterNormal, normalPrev);
    float miterScale = 1.0 / max(cosHalfAngle, 0.1);
    miterScale = min(miterScale, u_miter_limit);

    vec4 widths = rowsStyle(style, 2);
    float strokeWidth = hasCreatedZoom ? widths.x : widths.y;
    float lineWidth = (strokeWidth >= 0.0
        ? strokeWidth * pow(2.0, u_zoom - createdZoom)
        : -strokeWidth) * u_size_scale;
    float ink = clamp(lineWidth, 0.0, 1.0);
    lineWidth = max(lineWidth, 1.0);
    float halfWidth = lineWidth / 2.0;
    float expandedHalfWidth = halfWidth + 1.0;

    vec2 finalScreenPos = screenPos + miterNormal * side * expandedHalfWidth * miterScale;
    vec2 finalNdc = (finalScreenPos / u_viewport) * 2.0 - 1.0;
    gl_Position = vec4(finalNdc * clipPos.w, clipPos.z, clipPos.w);

    vec4 color = rowsStyle(style, 1);
    v_color = vec4(color.rgb, color.a * ink);
    v_params = vec4(halfWidth, 0.0, 0.0, 0.0);
    v_geom = vec4(side * expandedHalfWidth, 0.0, 0.0, 0.0);
}

void drawFill(int style) {
    float index = g_corner == 0 ? a_head.x : (g_corner == 1 ? a_head.y : (g_corner == 2 ? a_head.z : a_tail.x));
    vec2 pos = rowsCoord(index);
    emitShadeOffset(pos);
    gl_Position = rowsProject(pos);
    v_color = rowsStyle(style, 0);
}

#ifdef ROWS_GROUND
// The polygons and the lines read the ground seen at each pixel (terrain/drape/ground-buffer.ts):
// each is drawn as a box on the screen that holds every pixel whose ground it may cover, and the
// fragment tells from that ground whether the pixel is in it or how far it is from it. The tiles
// of the ground, two texels for slot s: its box (the Mercator offset of its corner from the
// center, and its side) and the range of the elevations of its ground (meters); the ranges of its
// blocks, a line of texels (DRAPE_GROUND_BLOCKS on a side, row by row from its north west corner,
// then the coarser ones)
uniform highp sampler2D u_ground_tiles;
uniform highp sampler2D u_ground_blocks;
uniform int u_ground_count;
// A fill: its four corners (Mercator offsets from the center), and in v_gc.x what it knows of its
// edges on the outline (ROWS_PAIR_EDGES). An edge: its ends, the points before and after it (its
// own ends for none), the piece of it drawn with whether a point is before and after it, and in
// v_params.z what an edge of an outline knows (ROWS_EDGE_INSIDE_LEFT, ROWS_EDGE_FRINGE)
flat out vec4 v_ga;
flat out vec4 v_gb;
flat out vec4 v_gc;

// Where the ground may be at the corners of a polygon or a line, for the box on the screen that
// holds it (meters): low and high at each of four corners (Mercator offsets from the center, in
// a box from lo to hi). The ground of each block of a tile is within a reach of a plane, and a
// plane interpolated between the corners is the plane, so the ground anywhere between the corners
// is between what low and high give there (the planes of the blocks the box meets, or of the
// coarser blocks for a box over many, or the range of the whole tile for a box over many of them;
// a tile met by the box widened by a share of it, as the mesh at the edge of a tile takes the
// elevations of the tile next to it). False when the box meets no tile
bool rowsGroundBounds(vec2 lo, vec2 hi, vec2 m0, vec2 m1, vec2 m2, vec2 m3,
        out vec4 low, out vec4 high) {
    low = vec4(1e9);
    high = vec4(-1e9);
    bool met = false;
    for (int s = 0; s < u_ground_count; s++) {
        vec4 box = texelFetch(u_ground_tiles, ivec2(0, s), 0);
        float margin = box.z / 64.0;
        if (hi.x < box.x - margin || lo.x > box.x + box.z + margin
            || hi.y < box.y - margin || lo.y > box.y + box.z + margin) continue;
        met = true;
        vec2 from = (lo - box.xy) / box.z;
        vec2 to = (hi - box.xy) / box.z;
        vec4 us = (vec4(m0.x, m1.x, m2.x, m3.x) - box.x) / box.z;
        vec4 vs = (vec4(m0.y, m1.y, m2.y, m3.y) - box.y) / box.z;
        int base = 0;
        float n = ${glslFloat(DRAPE_GROUND_BLOCKS)};
        ivec2 a = ivec2(clamp(floor(from * n), 0.0, n - 1.0));
        ivec2 b = ivec2(clamp(floor(to * n), 0.0, n - 1.0));
        ivec2 span = b - a + 1;
        if (span.x * span.y > 16) {
            base = ${DRAPE_GROUND_BLOCKS * DRAPE_GROUND_BLOCKS};
            n = ${glslFloat(DRAPE_GROUND_COARSE_BLOCKS)};
            a = ivec2(clamp(floor(from * n), 0.0, n - 1.0));
            b = ivec2(clamp(floor(to * n), 0.0, n - 1.0));
            span = b - a + 1;
        }
        if (span.x * span.y > 16) {
            vec4 range = texelFetch(u_ground_tiles, ivec2(1, s), 0);
            low = min(low, vec4(range.x));
            high = max(high, vec4(range.y));
            continue;
        }
        int width = int(n);
        for (int k = 0; k < 16; k++) {
            if (k >= span.x * span.y) break;
            ivec2 at = a + ivec2(k % span.x, k / span.x);
            vec4 plane = texelFetch(u_ground_blocks, ivec2(base + at.y * width + at.x, s), 0);
            vec4 h = plane.x + plane.y * us + plane.z * vs;
            low = min(low, h - plane.w);
            high = max(high, h + plane.w);
        }
    }
    vec4 pad = 0.5 + 0.0001 * (abs(low) + abs(high));
    low -= pad;
    high += pad;
    return met;
}

// Projects a Mercator offset from the center at an elevation (meters)
vec4 rowsProjectMercator(vec2 mercatorOffset, float elevation) {
    vec2 halfLat = half_latitude_of_mercator_offset(mercatorOffset.y);
    return project_center_offset(mercatorOffset, mercatorOffset.x * 360.0, halfLat,
        elevation * u_elevation_params.x, u_projection_matrix);
}

// Emits the corner of a box on the screen (device px): its origin and its two axes
void rowsEmitBox(vec2 origin, vec2 axisX, vec2 axisY) {
    vec2 unit = quadCorner() * 0.5 + 0.5;
    vec2 at = origin + axisX * unit.x + axisY * unit.y;
    gl_Position = vec4(at / u_viewport * 2.0 - 1.0, ${glslFloat(SYMBOL_DEPTH)}, 1.0);
}

// Emits the corner of the whole screen
void rowsEmitScreen() {
    gl_Position = vec4(quadCorner(), ${glslFloat(SYMBOL_DEPTH)}, 1.0);
}

void drawGroundFill(int style) {
    vec2 m0 = shade_mercator_offset(rowsCoord(a_head.x));
    vec2 m1 = shade_mercator_offset(rowsCoord(a_head.y));
    vec2 m2 = shade_mercator_offset(rowsCoord(a_head.z));
    vec2 m3 = shade_mercator_offset(rowsCoord(a_tail.x));
    emitShadeOffset(rowsCoord(a_head.x));
    vec2 lo = min(min(m0, m1), min(m2, m3));
    vec2 hi = max(max(m0, m1), max(m2, m3));
    vec4 low;
    vec4 high;
    if (!rowsGroundBounds(lo, hi, m0, m1, m2, m3, low, high)) {
        gl_Position = ${ROW_HIDDEN_POSITION_GLSL};
        return;
    }
    v_ga = vec4(m0, m1);
    v_gb = vec4(m2, m3);
    v_gc = vec4(a_tail.w, 0.0, 0.0, 0.0);
    v_color = rowsStyle(style, 0);
    v_params = vec4(0.0);
    // The box on the screen of the corners between where the ground may be
    vec2 slo = vec2(1e30);
    vec2 shi = vec2(-1e30);
    int behind = 0;
    for (int k = 0; k < 8; k++) {
        int c = k / 2;
        vec2 m = c == 0 ? m0 : (c == 1 ? m1 : (c == 2 ? m2 : m3));
        vec4 clip = rowsProjectMercator(m, (k & 1) == 0 ? low[c] : high[c]);
        if (clip.w <= 1e-6) {
            behind++;
            continue;
        }
        vec2 at = clipToScreen(clip);
        slo = min(slo, at);
        shi = max(shi, at);
    }
    if (behind == 8) {
        gl_Position = ${ROW_HIDDEN_POSITION_GLSL};
        return;
    }
    if (behind > 0) {
        rowsEmitScreen();
        return;
    }
    slo -= 1.0;
    shi += 1.0;
    // The step of the ground from a pixel to the next one near the fill, at most
    vec2 extent = hi - lo;
    v_params.y = max(extent.x, extent.y) / max(min(shi.x - slo.x, shi.y - slo.y) - 2.0, 1.0);
    rowsEmitBox(slo, vec2(shi.x - slo.x, 0.0), vec2(0.0, shi.y - slo.y));
}

void drawGroundEdge(int kind, int style, float createdZoom, bool hasCreatedZoom) {
    bool segment = kind == ${ROWS_KIND.segment};
    bool dashedOutline = kind == ${ROWS_KIND.dashedOutline};
    // An outline or a fringe goes round its ring: it always has a point before and after it
    bool ring = kind == ${ROWS_KIND.outline} || kind == ${ROWS_KIND.fringe};
    int prevIdx = int(a_head.x);
    int nextIdx = int(a_tail.x);
    float t0 = ring ? 0.0 : a_tail.y;
    float t1 = ring ? 1.0 : a_tail.z;
    vec2 offsetA = rowsCoord(a_head.y);
    vec2 offsetB = rowsCoord(a_head.z);
    vec2 ma = shade_mercator_offset(offsetA);
    vec2 mb = shade_mercator_offset(offsetB);
    emitShadeOffset(offsetA);
    bool hasPrev = ring || prevIdx >= 0;
    bool hasNext = ring || nextIdx >= 0;
    vec2 offsetP = hasPrev ? rowsCoord(a_head.x) : offsetA;
    vec2 offsetN = hasNext ? rowsCoord(a_tail.x) : offsetB;
    vec2 mp = shade_mercator_offset(offsetP);
    vec2 mn = shade_mercator_offset(offsetN);
    // The widths and the color of the line or of the outline, as the segments and the outlines
    // take them (a fringe draws no outline)
    bool polygonLine = !segment;
    vec4 widths = rowsStyle(style, polygonLine ? 2 : 1);
    vec4 color = rowsStyle(style, kind == ${ROWS_KIND.outline} ? 1 : (dashedOutline ? 3 : 0));
    float strokeWidth = hasCreatedZoom ? widths.x : widths.y;
    float lineWidth = (kind == ${ROWS_KIND.outline}
        ? (strokeWidth >= 0.0 ? strokeWidth * pow(2.0, u_zoom - createdZoom) : -strokeWidth)
        : (strokeWidth > 0.0
            ? strokeWidth * pow(2.0, u_zoom - createdZoom)
            : (strokeWidth < 0.0 ? -strokeWidth : 0.0))) * u_size_scale;
    float ink = clamp(lineWidth, 0.0, 1.0);
    lineWidth = max(lineWidth, 1.0);
    float halfWidth = lineWidth / 2.0;
    bool fringe = kind == ${ROWS_KIND.fringe};
    if (fringe) ink = 0.0;
    float flags = ring ? a_tail.w : 0.0;
    // The soft edge of the fill outside the polygon, in the color of the fill
    bool softEdge = ring && (int(flags + 0.5) & ${ROWS_EDGE_FRINGE}) != 0;
    v_color = vec4(color.rgb, color.a * ink);
    v_color2 = softEdge ? rowsStyle(style, 0) : vec4(0.0);
    v_params = vec4(halfWidth, 0.0, flags, 0.0);
    v_ga = vec4(ma, mb);
    v_gb = vec4(mp, mn);
    v_gc = vec4(t0, t1, hasPrev ? 1.0 : 0.0, hasNext ? 1.0 : 0.0);
    // A dashed line or outline: the pattern as the segments take it (CSS px), where the segment
    // starts on the line, and the lengths of the segments before it, of it and after it on the line
    int pattern = int(widths.w + 0.5);
    if (pattern > 0 && !ring) {
        float cssWidth = widths.z
            * (hasCreatedZoom ? pow(2.0, u_zoom - createdZoom) : 1.0)
            * u_size_scale;
        vec3 k = pattern == 1
            ? vec3(${glslFloat(DASH_COEFFICIENTS.dashed.a)}, ${glslFloat(DASH_COEFFICIENTS.dashed.b)}, ${glslFloat(DASH_COEFFICIENTS.dashed.c)})
            : vec3(${glslFloat(DASH_COEFFICIENTS.dotted.a)}, ${glslFloat(DASH_COEFFICIENTS.dotted.b)}, ${glslFloat(DASH_COEFFICIENTS.dotted.c)});
        float dash = max(k.x, k.y * cssWidth);
        float gap = max(cssWidth + 1.0, k.z * cssWidth);
        float scale = pow(2.0, u_zoom);
        v_dash = vec3(dash, dash + gap, a_tail.w * scale);
        v_dash_range = vec3(
            hasPrev ? dashLength0(offsetP, offsetA) * scale : 0.0,
            dashLength0(offsetA, offsetB) * scale,
            hasNext ? dashLength0(offsetB, offsetN) * scale : 0.0
        );
    }

    vec2 pa = mix(ma, mb, t0);
    vec2 pb = mix(ma, mb, t1);
    vec4 low;
    vec4 high;
    if (!rowsGroundBounds(min(pa, pb), max(pa, pb), pa, pb, pa, pb, low, high)
        || (ink <= 0.0 && !softEdge)) {
        gl_Position = ${ROW_HIDDEN_POSITION_GLSL};
        return;
    }
    vec4 ca0 = rowsProjectMercator(pa, low.x);
    vec4 ca1 = rowsProjectMercator(pa, high.x);
    vec4 cb0 = rowsProjectMercator(pb, low.y);
    vec4 cb1 = rowsProjectMercator(pb, high.y);
    int behind = (ca0.w <= 1e-6 ? 1 : 0) + (ca1.w <= 1e-6 ? 1 : 0)
        + (cb0.w <= 1e-6 ? 1 : 0) + (cb1.w <= 1e-6 ? 1 : 0);
    if (behind == 4) {
        gl_Position = ${ROW_HIDDEN_POSITION_GLSL};
        return;
    }
    if (behind > 0) {
        rowsEmitScreen();
        return;
    }
    vec2 sa0 = clipToScreen(ca0);
    vec2 sa1 = clipToScreen(ca1);
    vec2 sb0 = clipToScreen(cb0);
    vec2 sb1 = clipToScreen(cb1);
    // A box along the piece on the screen that holds the four, widened by the half width
    vec2 along = (sb0 + sb1) * 0.5 - (sa0 + sa1) * 0.5;
    float length2 = dot(along, along);
    vec2 dir = length2 > 1e-12 ? along * inversesqrt(length2) : vec2(1.0, 0.0);
    vec2 nrm = vec2(-dir.y, dir.x);
    vec2 o = sa0;
    vec4 p = vec4(dot(sa1 - o, dir), dot(sb0 - o, dir), dot(sb1 - o, dir), 0.0);
    vec4 n = vec4(dot(sa1 - o, nrm), dot(sb0 - o, nrm), dot(sb1 - o, nrm), 0.0);
    float reach = halfWidth + 2.0;
    // The step of the ground from a pixel to the next one near the piece
    float onScreen = max(length(along), 1.0);
    v_params.y = max(length(pb - pa) / onScreen, 1e-12);
    float dLo = min(min(p.x, p.y), min(p.z, p.w)) - reach;
    float dHi = max(max(p.x, p.y), max(p.z, p.w)) + reach;
    float nLo = min(min(n.x, n.y), min(n.z, n.w)) - reach;
    float nHi = max(max(n.x, n.y), max(n.z, n.w)) + reach;
    rowsEmitBox(o + dir * dLo + nrm * nLo, dir * (dHi - dLo), nrm * (nHi - nLo));
}
#endif

void main() {
    int kind = int(a_tag >> ${ROWS_KIND_SHIFT}u);
    int row = int(a_tag & ${ROWS_ROW_MASK}u);
    g_corner = int(a_corner + 0.5);
    v_kind = kind;
    v_color = vec4(0.0);
    v_color2 = vec4(0.0);
    v_params = vec4(0.0);
    v_dash = vec3(0.0);
    v_dash_range = vec3(0.0);
    v_dash_prev = vec4(1.0, 0.0, -2.0 * ${glslFloat(FAR)}, -${glslFloat(FAR)});
    v_dash_next = vec4(1.0, 0.0, ${glslFloat(FAR)}, 2.0 * ${glslFloat(FAR)});
    v_geom = vec4(0.0);

    // The state of the row: a hidden row draws nothing, a moving one is moved by its set
    uint rowState = readRowState(float(row));
    if (rowStateHidden(rowState)) {
        emitShadeOffset(vec2(0.0));
        gl_Position = ${ROW_HIDDEN_POSITION_GLSL};
        return;
    }
    g_row_state = rowState;

    int local = row - u_row_base;
    vec4 rowStyle = texelFetch(
        u_row_styles,
        ivec2(local % u_row_style_width, local / u_row_style_width),
        0
    );
    int style = int(rowStyle.x + 0.5);
    float createdZoom = rowStyle.y;
    bool hasCreatedZoom = rowStyle.z > 0.5;

#ifdef ROWS_GROUND
    if (kind == ${ROWS_KIND.fill}) {
        drawGroundFill(style);
        return;
    }
    if (kind == ${ROWS_KIND.segment} || kind == ${ROWS_KIND.dashedOutline}
        || kind == ${ROWS_KIND.outline} || kind == ${ROWS_KIND.fringe}) {
        drawGroundEdge(kind, style, createdZoom, hasCreatedZoom);
        return;
    }
#else
    // The soft edges of the fills are drawn only where the ground is read
    if (kind == ${ROWS_KIND.fringe}) {
        gl_Position = ${ROW_HIDDEN_POSITION_GLSL};
        return;
    }
#endif
    if (kind == ${ROWS_KIND.point}) {
        drawPoint(style);
    } else if (kind == ${ROWS_KIND.segment} || kind == ${ROWS_KIND.dashedOutline}) {
        drawSegment(kind, style, createdZoom, hasCreatedZoom);
    } else if (kind == ${ROWS_KIND.outline}) {
        drawOutline(style, createdZoom, hasCreatedZoom);
    } else if (kind == ${ROWS_KIND.fill}) {
        drawFill(style);
    } else {
        drawSprite(style);
    }
}`;
}

/**
 * The fragment shader source
 *
 * @param variant `color`: the colors. `ground`: the polygons and the lines read the ground seen at
 *   each pixel (terrain/drape/ground-buffer.ts)
 * @internal
 */
export function buildRowsFragmentSource(variant: RowsFragmentVariant = 'color'): string {
  const defines: Record<RowsFragmentVariant, string> = {
    color: '',
    ground: '#define ROWS_GROUND',
  };
  return `#version 300 es
precision highp float;
${defines[variant]}

flat in int v_kind;
flat in vec4 v_color;
flat in vec4 v_color2;
flat in vec4 v_params;
flat in vec3 v_dash;
flat in vec3 v_dash_range;
flat in vec4 v_dash_prev;
flat in vec4 v_dash_next;
in vec4 v_geom;

// The opacity factor of the drawing (the opacity of the layer)
uniform float u_opacity;
// 1 to discard the back faces of the fills (the terrain), 0 otherwise
uniform float u_cull_back;
// The pictures of the sprites of the chunk
uniform sampler2D u_sprites;
// 1 when the pictures hold their colors multiplied by their alpha (they are divided back)
uniform float u_sprite_premultiplied;

#ifdef ROWS_GROUND
flat in vec4 v_ga;
flat in vec4 v_gb;
flat in vec4 v_gc;
// The ground seen at each pixel (its place in its tile, the shading there, its slot plus one) and
// the tiles of the slots (rows-shader.ts, the vertex stage)
uniform highp usampler2D u_ground;
uniform highp sampler2D u_ground_tiles;
// The depth of the ground seen at each pixel: the polygons and the lines take it as their own, so
// the 3D layers of the map in front of the ground hide them as they hide the ground (the points
// and the sprites keep the depth of their markers)
uniform highp sampler2D u_ground_depth;
#endif
out vec4 fragColor;

const float AA = 0.5;
${POINT_SDF_GLSL}
${TERRAIN_SHADE_FRAGMENT_GLSL}

// The coverage of a round end at a distance along the line beyond it (device pixels)
float capCoverage(float d, float along, float w) {
    float capDist = length(vec2(d, along)) - w;
    return 1.0 - clamp(capDist + 0.5, 0.0, 1.0);
}

// The coverage of a line across it, d device pixels from its center line
float bodyCoverage(float d, float w) {
    float left = clamp(d - w + 0.5, 0.0, 1.0);
    float right = clamp(d + w + 0.5, 0.0, 1.0);
    return right - left;
}

// The coverage of a dash drawn as a line of its own from a to b along its segment, at u along it
// and d across it (device pixels): round ends, or none at an end far away (one that goes on over
// a corner, up to the miter)
float dashCoverage(float d, float u, float a, float b, float w) {
    if (u < a) return capCoverage(d, a - u, w);
    if (u > b) return capCoverage(d, u - b, w);
    return bodyCoverage(d, w);
}

// Two coverages of one color drawn over each other, as one (alpha: the alpha of the color)
float overCoverage(float c, float more, float alpha) {
    return c + more - alpha * c * more;
}

// The coverage of a dash of a segment next to this one at a point u along this segment from the
// corner they share and d across it, the dash given as \`v_dash_prev\` or \`v_dash_next\` gives it
float neighborCoverage(vec4 dash, float u, float d, float w) {
    return dashCoverage(u * dash.y + d * dash.x, u * dash.x - d * dash.y, dash.z, dash.w, w);
}

// The coverage of a dashed segment: the dashes the CPU draws on it, cut at its ends (where a dash
// goes on over a corner, up to the miter), and those of the segments next to it that reach over
// the corners, each blended over the others as the CPU draws them
float dashedCoverage(float d, float w) {
    float dash = v_dash.x;
    float period = v_dash.y;
    float perPx = v_dash.z;
    float first = v_dash_range.x;
    float last = v_dash_range.y;
    bool lineEnd = v_dash_range.z > 0.5;
    float alpha = v_color.a * u_opacity;
    // The position on the line, and the nearest one on the segment (past its ends, in the
    // strips of its corners, the dashes at its ends are the ones near)
    float pos = v_geom.z;
    float at = clamp(pos, first, last);
    float m = mod(at, period);
    float coverage = 0.0;
    if (m < dash) {
        // In a dash: its ends on the segment, round where it starts or ends on it
        float start = at - m;
        float end = start + dash;
        float a = start >= first ? (start - pos) / perPx : -${glslFloat(FAR)};
        float b = end <= last || lineEnd ? (min(end, last) - pos) / perPx : ${glslFloat(FAR)};
        coverage = dashCoverage(d, 0.0, a, b, w);
    } else {
        // In a gap: the dash before it and the one after it, when they are on the segment
        float end = at - m + dash;
        if (end > first) {
            float start = end - dash;
            float a = start >= first ? (start - pos) / perPx : -${glslFloat(FAR)};
            coverage = dashCoverage(d, 0.0, a, (end - pos) / perPx, w);
        }
        float next = at - m + period;
        if (next < last) {
            float nextEnd = next + dash;
            float b = nextEnd <= last || lineEnd
                ? (min(nextEnd, last) - pos) / perPx
                : ${glslFloat(FAR)};
            coverage = overCoverage(coverage, dashCoverage(d, 0.0, (next - pos) / perPx, b, w), alpha);
        }
    }
    float fromStart = (pos - first) / perPx;
    coverage = overCoverage(coverage, neighborCoverage(v_dash_prev, fromStart, d, w), alpha);
    float fromEnd = (pos - last) / perPx;
    coverage = overCoverage(coverage, neighborCoverage(v_dash_next, fromEnd, d, w), alpha);
    return coverage;
}

vec4 shadePoint() {
    if (v_params.y <= 0.0) discard;
    float d = pointShapeSdf(v_geom.xy, v_params.y, v_params.w);
    float coverage = 1.0 - smoothstep(-AA, AA, d);
    if (coverage <= 0.0) discard;
    float band = v_params.y - v_params.x;
    float fillMix = band > 0.0
        ? 1.0 - smoothstep(-band - AA, -band + AA, d)
        : 1.0;
    vec4 color = mix(v_color2, v_color, fillMix);
    return vec4(color.rgb, color.a * u_opacity * coverage * v_params.z);
}

vec4 shadeSegment() {
    float d = v_geom.x;
    float w = v_params.x;
    float coverage;
    if (v_dash.y > 0.0) {
        // The dashes start at the start of the line: [k * period, k * period + dash]
        coverage = dashedCoverage(d, w);
    } else {
        float linePos = v_geom.y;
        float startDist = -linePos;
        float endDist = linePos - v_params.y;
        if (startDist > 0.0) {
            coverage = capCoverage(d, startDist, w);
        } else if (endDist > 0.0) {
            coverage = capCoverage(d, endDist, w);
        } else {
            coverage = bodyCoverage(d, w);
        }
    }
    return vec4(v_color.rgb, v_color.a * coverage * u_opacity);
}

vec4 shadeOutline() {
    float d = abs(v_geom.x) - v_params.x;
    float alpha = 1.0 - smoothstep(-1.0, 1.0, d);
    if (alpha < 0.01) discard;
    return vec4(v_color.rgb, v_color.a * alpha * u_opacity);
}

vec4 shadeFill() {
    if (u_cull_back > 0.5 && !gl_FrontFacing) discard;
    return vec4(v_color.rgb * terrainFillShade(), v_color.a * u_opacity);
}

vec4 shadeSprite() {
    vec4 texel = texture(u_sprites, v_geom.xy);
    if (u_sprite_premultiplied > 0.5 && texel.a > 0.0) texel.rgb /= texel.a;
    return vec4(texel.rgb, texel.a * u_opacity * v_params.x);
}

#ifdef ROWS_GROUND
// The ground a texel of the ground holds (terrain/drape/ground-buffer.ts): its Mercator offset
// from the center, from its tile (the first one where none is seen) and its place in it, and the
// shading there
void groundPlace(uvec4 g, out vec2 q, out float shade) {
    int slot = max(int(g.x) - 1, 0);
    vec4 box = texelFetch(u_ground_tiles, ivec2(0, slot), 0);
    q = box.xy + vec2(g.yz) / ${glslFloat(DRAPE_GROUND_PLACE_STEPS)} * box.z;
    shade = float(g.w) / ${glslFloat(DRAPE_GROUND_PLACE_STEPS)} * ${glslFloat(DRAPE_GROUND_SHADE_RANGE)};
}

// The ground seen at a pixel: its Mercator offset from the center and the shading there (false
// where no ground is seen)
bool groundOf(ivec2 at, out vec2 q, out float shade) {
    ivec2 size = textureSize(u_ground, 0);
    uvec4 g = texelFetch(u_ground, clamp(at, ivec2(0), size - 1), 0);
    q = vec2(0.0);
    shade = 1.0;
    if (g.x == 0u) return false;
    groundPlace(g, q, shade);
    return true;
}

// The step of the ground from a pixel to the next one along an axis: the shorter of the steps
// forward and back where the ground is seen (across the edge of a ridge, the other side is far).
// A pixel whose ground is far from both of its neighbors while they are near each other is a
// pixel seen through a crack between two tiles (lone: no ground of its own there)
vec2 groundStep(ivec2 at, ivec2 axis, vec2 q, inout bool lone) {
    vec2 forward;
    vec2 back;
    float shade;
    bool hasForward = groundOf(at + axis, forward, shade);
    bool hasBack = groundOf(at - axis, back, shade);
    vec2 a = hasForward ? forward - q : vec2(0.0);
    vec2 b = hasBack ? q - back : vec2(0.0);
    if (hasForward && hasBack) {
        vec2 across = forward - back;
        float near = min(dot(a, a), dot(b, b));
        if (near > 4.0 * dot(across, across)) lone = true;
    }
    if (!hasForward || dot(a, a) == 0.0) return b;
    if (!hasBack || dot(b, b) == 0.0) return a;
    return dot(a, a) <= dot(b, b) ? a : b;
}

// The map from a displacement on the ground (Mercator) to one on the screen (device px) at a pixel
mat2 groundToScreen(ivec2 at, vec2 q, inout bool lone) {
    vec2 dx = groundStep(at, ivec2(1, 0), q, lone);
    vec2 dy = groundStep(at, ivec2(0, 1), q, lone);
    float det = dx.x * dy.y - dy.x * dx.y;
    if (abs(det) < 1e-36) {
        float s = max(max(length(dx), length(dy)), 1e-20);
        return mat2(1.0 / s, 0.0, 0.0, 1.0 / s);
    }
    return mat2(dy.y, -dx.y, -dy.x, dx.x) / det;
}

// Which side of an edge a point is on, with the edge taken in one order whatever the triangle
// (so two triangles that share it find the same value, of opposite signs), and the sign that
// turns it toward the inside of a triangle of orientation o
bool insideEdge(vec2 a, vec2 b, vec2 q, float o) {
    bool swap = a.x > b.x || (a.x == b.x && a.y > b.y);
    vec2 lo = swap ? b : a;
    vec2 hi = swap ? a : b;
    float e = (hi.x - lo.x) * (q.y - lo.y) - (hi.y - lo.y) * (q.x - lo.x);
    float side = swap ? -o : o;
    float v = e * side;
    // On the edge, one of the two triangles takes the point
    return v > 0.0 || (v == 0.0 && side > 0.0);
}

bool inTriangle(vec2 q, vec2 a, vec2 b, vec2 c) {
    float area = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
    if (area == 0.0) return false;
    float o = area > 0.0 ? 1.0 : -1.0;
    return insideEdge(a, b, q, o) && insideEdge(b, c, q, o) && insideEdge(c, a, q, o);
}

// The ground of the pixel of the fragment, read in the same way by every fragment of a quad, with
// its steps to the next pixels of the quad (dFdx, dFdy): false where no ground is seen
bool groundHere(out vec2 q, out float shade, out vec2 stepX, out vec2 stepY) {
    ivec2 size = textureSize(u_ground, 0);
    uvec4 g = texelFetch(u_ground, clamp(ivec2(gl_FragCoord.xy), ivec2(0), size - 1), 0);
    groundPlace(g, q, shade);
    stepX = dFdx(q);
    stepY = dFdy(q);
    return g.x != 0u;
}

// Whether the steps of the quad may cross an edge of the ground seen (a ridge, a crack between
// tiles): longer than the steps the polygon or the line expects near it (v_params.y)
bool groundBroken(vec2 stepX, vec2 stepY) {
    float most = 8.0 * v_params.y;
    return max(dot(stepX, stepX), dot(stepY, stepY)) > most * most;
}

// The map from a displacement on the ground to one on the screen from the steps of the quad
mat2 groundToScreenOf(vec2 dx, vec2 dy) {
    float det = dx.x * dy.y - dy.x * dx.y;
    if (abs(det) < 1e-36) {
        float s = max(max(length(dx), length(dy)), 1e-20);
        return mat2(1.0 / s, 0.0, 0.0, 1.0 / s);
    }
    return mat2(dy.y, -dx.y, -dy.x, dx.x) / det;
}

// The shortest vector from the pixel (the origin) to a segment on the screen
vec2 groundClosest(vec2 a, vec2 b) {
    vec2 ab = b - a;
    float len2 = dot(ab, ab);
    float t = len2 > 0.0 ? clamp(-dot(a, ab) / len2, 0.0, 1.0) : 0.0;
    return a + ab * t;
}

float groundCross(vec2 a, vec2 b) {
    return a.x * b.y - a.y * b.x;
}

// The screen distance from the pixel to the dashes of a pattern on a segment, as the drape
// measures it (terrain/drape/renderer.ts): sa and sb are its ends on the screen around the pixel,
// start and len where it starts on the line and how long it is, dash and period those of the
// pattern (CSS px on the flat map at the zoom of the frame). The place on the line is taken
// where the pixel is nearest to the segment on the screen, and the dash there and the next one
// are measured, each a segment with round ends
float groundDashDistance(vec2 sa, vec2 sb, float start, float len, float dash, float period) {
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
        best = min(best, length(groundClosest(sa + ab * u0, sa + ab * u1)));
    }
    return best;
}

// The ground of the pixel and the map from a displacement on it to one on the screen (false for
// a pixel where no ground is seen, or seen through a crack between two tiles)
bool groundAndScreen(out vec2 q, out float shade, out mat2 toScreen) {
    vec2 stepX;
    vec2 stepY;
    bool seen = groundHere(q, shade, stepX, stepY);
    toScreen = groundToScreenOf(stepX, stepY);
    if (!seen) return false;
    if (groundBroken(stepX, stepY)) {
        // Across an edge of the ground, the steps are taken on the side the ground goes on
        bool lone = false;
        toScreen = groundToScreen(ivec2(gl_FragCoord.xy), q, lone);
        if (lone) return false;
    }
    return true;
}

// A pair of triangles of a fill: the pixels whose ground is in one of them, softened as the drape
// softens the edge of a fill (half a pixel in and out of it) within its edges on the outline
vec4 shadeGroundFill() {
    vec2 q;
    float shade;
    mat2 toScreen;
    if (!groundAndScreen(q, shade, toScreen)) discard;
    vec2 a = v_ga.xy;
    vec2 b = v_ga.zw;
    vec2 c = v_gb.xy;
    vec2 d = v_gb.zw;
    if (!inTriangle(q, a, b, c) && !inTriangle(q, b, c, d)) discard;
    float coverage = 1.0;
    int edges = int(v_gc.x + 0.5);
    if ((edges & ${ROWS_PAIR_EDGES}) != 0 && edges > ${ROWS_PAIR_EDGES}) {
        vec2 sa = toScreen * (a - q);
        vec2 sb = toScreen * (b - q);
        vec2 sc = toScreen * (c - q);
        vec2 sd = toScreen * (d - q);
        float dist = 1.0e9;
        if ((edges & ${ROWS_PAIR_EDGE_BITS.ab}) != 0) dist = min(dist, length(groundClosest(sa, sb)));
        if ((edges & ${ROWS_PAIR_EDGE_BITS.bc}) != 0) dist = min(dist, length(groundClosest(sb, sc)));
        if ((edges & ${ROWS_PAIR_EDGE_BITS.ca}) != 0) dist = min(dist, length(groundClosest(sc, sa)));
        if ((edges & ${ROWS_PAIR_EDGE_BITS.bd}) != 0) dist = min(dist, length(groundClosest(sb, sd)));
        if ((edges & ${ROWS_PAIR_EDGE_BITS.dc}) != 0) dist = min(dist, length(groundClosest(sd, sc)));
        coverage = clamp(0.5 + dist, 0.0, 1.0);
    }
    return vec4(v_color.rgb * shade, v_color.a * coverage * u_opacity);
}

// An edge of an outline (or of a fringe) or a segment of a line: the pixels that are nearer to it
// than to the edges before and after it (the one that ends at the corner they share taking the
// ties, so each pixel is drawn by one of them, as the drape takes the nearest edge), measured to
// its dashes where it is dashed. An outline draws the soft edge of the fill outside its polygon
// under it, as the drape does
vec4 shadeGroundEdge() {
    vec2 q;
    float shade;
    mat2 toScreen;
    if (!groundAndScreen(q, shade, toScreen)) discard;
    vec2 a = v_ga.xy;
    vec2 b = v_ga.zw;
    vec2 p = v_gb.xy;
    vec2 n = v_gb.zw;
    float t0 = v_gc.x;
    float t1 = v_gc.y;
    bool before = v_gc.z > 0.5 && t0 == 0.0;
    bool after = v_gc.w > 0.5 && t1 == 1.0;
    vec2 sa = toScreen * (a - q);
    vec2 sb = toScreen * (b - q);
    vec2 ab = sb - sa;
    float len2 = dot(ab, ab);
    float u = len2 > 0.0 ? clamp(-dot(sa, ab) / len2, 0.0, 1.0) : 0.0;
    // A piece of a segment takes the pixels nearest to it
    if (u < t0 || u > t1 || (u == t1 && t1 < 1.0)) discard;
    float dist = length(sa + ab * u);
    float own = dist;
    float prevDist = 1.0e9;
    float nextDist = 1.0e9;
    if (v_dash.y > 0.0) {
        float start = v_dash.z;
        float len = v_dash_range.y;
        own = groundDashDistance(sa, sb, start, len, v_dash.x, v_dash.y);
        if (before) {
            prevDist = groundDashDistance(toScreen * (p - q), sa, start - v_dash_range.x,
                v_dash_range.x, v_dash.x, v_dash.y);
        }
        if (after) {
            nextDist = groundDashDistance(sb, toScreen * (n - q), start + len, v_dash_range.z,
                v_dash.x, v_dash.y);
        }
    } else {
        if (before) prevDist = length(groundClosest(toScreen * (p - q), sa));
        if (after) nextDist = length(groundClosest(sb, toScreen * (n - q)));
    }
    if (own >= prevDist || own > nextDist) discard;

    // The outline, where its dashes are (the whole of it when it is solid)
    float strokeAlpha = v_color.a * clamp(v_params.x + 0.5 - own, 0.0, 1.0);
    // The soft edge of the fill outside the polygon: which side is inside, at a corner the side
    // of the two edges there (both for a convex corner, either for a reflex one). On the Mercator
    // plane the y goes to the south, so the left of an edge on the map is the right of it here
    float fillAlpha = 0.0;
    int flags = int(v_params.z + 0.5);
    if ((flags & ${ROWS_EDGE_FRINGE}) != 0 && v_color2.a > 0.0) {
        float side = (flags & ${ROWS_EDGE_INSIDE_LEFT}) != 0 ? -1.0 : 1.0;
        bool inside = groundCross(b - a, q - a) * side > 0.0;
        if (u <= 0.0) {
            bool inPrev = groundCross(a - p, q - p) * side > 0.0;
            bool convex = groundCross(a - p, b - p) * side > 0.0;
            inside = convex ? inside && inPrev : inside || inPrev;
        } else if (u >= 1.0) {
            bool inNext = groundCross(n - b, q - b) * side > 0.0;
            bool convex = groundCross(b - a, n - a) * side > 0.0;
            inside = convex ? inside && inNext : inside || inNext;
        }
        if (!inside) fillAlpha = v_color2.a * clamp(0.5 - dist, 0.0, 1.0);
    }
    float alpha = strokeAlpha + fillAlpha * (1.0 - strokeAlpha);
    if (alpha <= 0.0) discard;
    vec3 rgb = (v_color.rgb * strokeAlpha + v_color2.rgb * shade * fillAlpha * (1.0 - strokeAlpha))
        / alpha;
    return vec4(rgb, alpha * u_opacity);
}
#endif

#if defined(ROWS_GROUND)
void main() {
    gl_FragDepth = gl_FragCoord.z;
    if (v_kind == ${ROWS_KIND.point}) {
        fragColor = shadePoint();
    } else if (v_kind == ${ROWS_KIND.fill}) {
        fragColor = shadeGroundFill();
        gl_FragDepth = texelFetch(u_ground_depth, ivec2(gl_FragCoord.xy), 0).r;
    } else if (v_kind == ${ROWS_KIND.segment} || v_kind == ${ROWS_KIND.dashedOutline}
        || v_kind == ${ROWS_KIND.outline} || v_kind == ${ROWS_KIND.fringe}) {
        fragColor = shadeGroundEdge();
        gl_FragDepth = texelFetch(u_ground_depth, ivec2(gl_FragCoord.xy), 0).r;
    } else {
        fragColor = shadeSprite();
    }
}
#else
void main() {
    if (v_kind == ${ROWS_KIND.point}) {
        fragColor = shadePoint();
    } else if (v_kind == ${ROWS_KIND.segment} || v_kind == ${ROWS_KIND.dashedOutline}) {
        fragColor = shadeSegment();
    } else if (v_kind == ${ROWS_KIND.outline}) {
        fragColor = shadeOutline();
    } else if (v_kind == ${ROWS_KIND.fill}) {
        fragColor = shadeFill();
    } else {
        fragColor = shadeSprite();
    }
}
#endif`;
}

/**
 * The fragment variants of the program: the colors, and the colors with the polygons and the
 * lines reading the ground seen at each pixel (`buildRowsFragmentSource`)
 *
 * @internal
 */
export type RowsFragmentVariant = 'color' | 'ground';

/** The miter limit the segments and the outlines use (the one of the other renderers) */
export const ROWS_MITER_LIMIT = RENDERING_DEFAULTS.MITER_LIMIT;
