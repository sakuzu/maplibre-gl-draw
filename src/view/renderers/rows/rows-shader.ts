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
 * The blending is the one of the layer, so the branches differ only in what they emit. The
 * shaders never read `gl_InstanceID`: a range of rows is drawn by pointing the instance
 * attributes at its first instance, so the place of an instance in a draw means nothing.
 */

import { DEFAULT_TILE_SIZE, RENDERING_DEFAULTS } from '../../../shared/math/index.js';
import { getProjectionTransitionUniform, OFFSET_MODE_GLSL } from '../../shaders/helpers.js';
import {
  TERRAIN_SHADE_FRAGMENT_GLSL,
  TERRAIN_SHADE_VERTEX_GLSL,
} from '../../shaders/terrain-shade.js';
import { DASH_COEFFICIENTS } from '../line/dash.js';
import { POINT_AA_PADDING_PX, POINT_MIN_OUTER_PX } from '../point/point-instance.js';
import { POINT_SDF_GLSL } from '../point/point-sdf.js';
import { ROW_HIDDEN_POSITION_GLSL, ROW_STATE_GLSL } from '../row-state.js';
import { ROWS_KIND, ROWS_KIND_FACTOR, ROWS_STYLE_TEXELS } from './rows-format.js';

/** A float literal of GLSL */
function glslFloat(value: number): string {
  const text = String(value);
  return /[.eE]/.test(text) ? text : `${text}.0`;
}

/** A distance no fragment is near (device px): the end of a dash that has none */
const FAR = 1e6;

/**
 * The depth of the vertices of a point or a sprite in clip space: just inside the near plane,
 * so that a depth test, where one is on, never hides a symbol (exactly on the plane, rounding
 * can clip it)
 */
const SYMBOL_DEPTH = -0.999;

/**
 * The vertex shader source
 *
 * @param prelude The vertex shader prelude maplibre hands to the custom layer
 * @param define The defines of the projection variant
 * @internal
 */
export function buildRowsVertexSource(prelude: string, define: string): string {
  const dashed = DASH_COEFFICIENTS.dashed;
  const dotted = DASH_COEFFICIENTS.dotted;
  return `#version 300 es
#define TABLE_ROWS
${prelude}
${define}
${getProjectionTransitionUniform(prelude)}${OFFSET_MODE_GLSL}${TERRAIN_SHADE_VERTEX_GLSL}${ROW_STATE_GLSL}

// The corner of the strip of 4 vertices (0 to 3)
layout(location = 0) in float a_corner;
// x: kind * ${ROWS_KIND_FACTOR} + the number of the row in its group, yzw: coordinates 0 to 2
layout(location = 1) in vec4 a_head;
// x: coordinate 3, y and z: the range of the segment drawn, w: the length of the line before a
// dashed segment (CSS px at zoom 0)
layout(location = 2) in vec4 a_tail;

// The coordinates of the chunk (offsets from its origin)
uniform sampler2D u_coords;
uniform int u_coord_width;
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
// How the size of the sprites follows the distance: base, factor, min, max (factor 0: it does not)
uniform vec4 u_sprite_scale;

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

// The dash of the segment from \`from\` to \`to\` next to a dashed segment going along \`dir\` whose
// round end is at the corner they share (at \`corner\` on the line, CSS px), as \`v_dash_prev\` and
// \`v_dash_next\` hold it. A dash that goes on over the corner is drawn on both sides of it up to
// the miter, so nothing of it reaches over; one cut at the corner or near it has a round end
// that does. \`before\`: the segment is the one before the corner (its last dash), else the one
// after it (its first dash)
vec4 dashNeighbor(vec2 from, vec2 to, vec2 dir, float corner, vec2 pattern, float scale, bool before) {
    vec4 none = before ? vec4(1.0, 0.0, -2.0 * ${glslFloat(FAR)}, -${glslFloat(FAR)})
        : vec4(1.0, 0.0, ${glslFloat(FAR)}, 2.0 * ${glslFloat(FAR)});
    vec2 along = clipToScreen(rowsProject(to)) - clipToScreen(rowsProject(from));
    float px = length(along);
    if (px <= 0.0) return none;
    vec2 other = along / px;
    float lengthCss = dashLength0(from, to) * scale;
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
    // The elevation of the anchor is not read from the DEM (the drawing of points on the terrain
    // gives it); with the terrain off it is not used
    g_anchor_elevation_m = 0.0;
    g_anchor_elevation_on = 1.0;
    vec2 offset = rowsCoord(a_head.y);
    emitShadeOffset(offset);
    vec4 centerClip = rowsProject(offset);
    if (centerClip.w <= 0.0) {
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
    v_params = vec4(radius, outer, ink, size.z);
    v_geom = vec4(offsetPx, 0.0, 0.0);
}

void drawSprite(int style) {
    g_anchor_elevation_m = 0.0;
    g_anchor_elevation_on = 1.0;
    vec2 offset = rowsCoord(a_head.y);
    emitShadeOffset(offset);
    vec4 centerClip = rowsProject(offset);
    if (centerClip.w <= 0.0) {
        gl_Position = ${ROW_HIDDEN_POSITION_GLSL};
        return;
    }
    vec3 centerNdc = centerClip.xyz / centerClip.w;
    vec4 uv = rowsStyle(style, 0);
    vec4 shape = rowsStyle(style, 1);
    float ratio = 1.0;
    if (u_sprite_scale.y != 0.0 && u_camera_to_center_w > 0.0 && centerClip.w > 0.0) {
        ratio = clamp(
            u_sprite_scale.x + u_sprite_scale.y * (u_camera_to_center_w / centerClip.w),
            u_sprite_scale.z,
            u_sprite_scale.w
        );
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
    v_params = vec4(ink, 0.0, 0.0, 0.0);
    v_geom = vec4(mix(uv.xy, uv.zw, unit * 0.5 + 0.5), 0.0, 0.0);
}

void drawSegment(int kind, int style, float createdZoom, bool hasCreatedZoom) {
    int prevIdx = int(a_head.y);
    int nextIdx = int(a_tail.x);
    bool atStart = g_corner < 2;
    bool atEnd = !atStart;
    float t = atStart ? 0.0 : 1.0;
    float side = (g_corner & 1) == 0 ? 1.0 : -1.0;

    vec2 startOffset = rowsCoord(a_head.z);
    vec2 endOffset = rowsCoord(a_head.w);
    emitShadeOffset(atStart ? startOffset : endOffset);
    vec4 startClip = rowsProject(startOffset);
    vec4 endClip = rowsProject(endOffset);
    vec2 startScreen = clipToScreen(startClip);
    vec2 endScreen = clipToScreen(endClip);
    vec4 currentClip = atStart ? startClip : endClip;

    vec2 segmentVec = endScreen - startScreen;
    float screenSegmentLength = length(segmentVec);
    vec2 segmentDir = segmentVec / screenSegmentLength;
    vec2 normal = vec2(-segmentDir.y, segmentDir.x);

    float miterScale = 1.0;
    vec2 miterNormal = normal;
    if (atStart) {
        if (prevIdx >= 0) {
            vec2 prevScreen = clipToScreen(rowsProject(rowsCoord(a_head.y)));
            vec2 prevDir = normalize(startScreen - prevScreen);
            vec2 prevNormal = vec2(-prevDir.y, prevDir.x);
            vec2 avgNormal = prevNormal + normal;
            float avgLen = length(avgNormal);
            if (avgLen > 0.001) {
                miterNormal = avgNormal / avgLen;
                float cosHalf = dot(miterNormal, normal);
                if (cosHalf > 0.001) {
                    miterScale = 1.0 / cosHalf;
                    if (miterScale > u_miter_limit) {
                        miterScale = 1.0;
                        miterNormal = normal;
                    }
                }
            }
        }
    } else if (nextIdx >= 0) {
        vec2 nextScreen = clipToScreen(rowsProject(rowsCoord(a_tail.x)));
        vec2 nextDir = normalize(nextScreen - endScreen);
        vec2 nextNormal = vec2(-nextDir.y, nextDir.x);
        vec2 avgNormal = normal + nextNormal;
        float avgLen = length(avgNormal);
        if (avgLen > 0.001) {
            miterNormal = avgNormal / avgLen;
            float cosHalf = dot(miterNormal, normal);
            if (cosHalf > 0.001) {
                miterScale = 1.0 / cosHalf;
                if (miterScale > u_miter_limit) {
                    miterScale = 1.0;
                    miterNormal = normal;
                }
            }
        }
    }

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
    bool isStartCap = atStart && (prevIdx < 0);
    bool isEndCap = atEnd && (nextIdx < 0);
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

    v_color = color * ink;
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
        float startCss = a_tail.w * scale;
        float lengthCss = dashLength0(startOffset, endOffset) * scale;
        float cssPerPx = lengthCss / screenSegmentLength;
        v_dash = vec3(dash, dash + gap, cssPerPx);
        v_dash_range = vec3(startCss, startCss + lengthCss, nextIdx < 0 ? 1.0 : 0.0);
        if (prevIdx >= 0) {
            v_dash_prev = dashNeighbor(
                rowsCoord(a_head.y), startOffset, segmentDir, startCss, vec2(dash, gap), scale, true
            );
        }
        if (nextIdx >= 0) {
            v_dash_next = dashNeighbor(
                endOffset, rowsCoord(a_tail.x), segmentDir, startCss + lengthCss, vec2(dash, gap),
                scale, false
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
    vec2 pos = rowsCoord(first ? a_head.z : a_head.w);
    vec2 prev = rowsCoord(first ? a_head.y : a_head.z);
    vec2 next = rowsCoord(first ? a_head.w : a_tail.x);
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
    float index = g_corner == 0 ? a_head.y : (g_corner == 1 ? a_head.z : (g_corner == 2 ? a_head.w : a_tail.x));
    vec2 pos = rowsCoord(index);
    emitShadeOffset(pos);
    gl_Position = rowsProject(pos);
    v_color = rowsStyle(style, 0);
}

void main() {
    int kind = int(floor(a_head.x / ${glslFloat(ROWS_KIND_FACTOR)}));
    float row = a_head.x - float(kind) * ${glslFloat(ROWS_KIND_FACTOR)};
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
    uint rowState = readRowState(row);
    if (rowStateHidden(rowState)) {
        emitShadeOffset(vec2(0.0));
        gl_Position = ${ROW_HIDDEN_POSITION_GLSL};
        return;
    }
    g_row_state = rowState;

    int local = int(row + 0.5) - u_row_base;
    vec4 rowStyle = texelFetch(
        u_row_styles,
        ivec2(local % u_row_style_width, local / u_row_style_width),
        0
    );
    int style = int(rowStyle.x + 0.5);
    float createdZoom = rowStyle.y;
    bool hasCreatedZoom = rowStyle.z > 0.5;

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
 * @internal
 */
export function buildRowsFragmentSource(): string {
  return `#version 300 es
precision highp float;

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
    return v_color * coverage * u_opacity;
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
        vec4 texel = texture(u_sprites, v_geom.xy);
        if (u_sprite_premultiplied > 0.5 && texel.a > 0.0) texel.rgb /= texel.a;
        fragColor = texel * (u_opacity * v_params.x);
    }
}`;
}

/** The miter limit the segments and the outlines use (the one of the other renderers) */
export const ROWS_MITER_LIMIT = RENDERING_DEFAULTS.MITER_LIMIT;
