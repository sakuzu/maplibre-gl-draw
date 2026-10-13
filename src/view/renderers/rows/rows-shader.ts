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
 *   the round ends it gets there
 * - a sprite: a picture of a texture an extension gives, centered on its point
 *
 * The blending is the one of the layer, so the branches differ only in what they emit. The
 * shaders never read `gl_InstanceID`: a range of rows is drawn by pointing the instance
 * attributes at its first instance, so the place of an instance in a draw means nothing.
 */

import { RENDERING_DEFAULTS } from '../../../shared/math/index.js';
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
// A dashed segment: the dash, the period (CSS px), CSS px per device pixel along the segment,
// the position of its start on the line (CSS px)
flat out vec4 v_dash;
// A dashed segment: x the position of the end of the line when the segment is its last one
// (-1 otherwise), y 1 for a dashed segment (0 otherwise)
flat out vec2 v_dash_end;
// A point: the offset in device pixels. A segment: the signed distance from its center line and
// the position along it. An edge of an outline: the signed distance. A sprite: the texture
// coordinates
out vec4 v_geom;

// The translation of the row of the instance (its moving set), added to every coordinate read
vec2 g_row_shift = vec2(0.0);
int g_corner = 0;

vec2 rowsCoord(float index) {
    int i = int(index + 0.5);
    return texelFetch(u_coords, ivec2(i % u_coord_width, i / u_coord_width), 0).xy + g_row_shift;
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
    vec2 base = u_origin_shift + u_center_lnglat;
    float latitude = (a.y + b.y) * 0.5 + base.y;
    float cosLatitude = max(cos(latitude * PI / 180.0), 1e-6);
    float perDegree = 512.0 / 360.0;
    return length(vec2((b.x - a.x) * perDegree, (b.y - a.y) * perDegree / cosLatitude));
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
    vec2 totalClipOffset = screenToClipOffset(screenOffset + capOffset, currentClip.w);
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
        v_dash = vec4(dash, dash + gap, lengthCss / screenSegmentLength, startCss);
        v_dash_end = vec2(nextIdx < 0 ? startCss + lengthCss : -1.0, 1.0);
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
    v_dash = vec4(0.0);
    v_dash_end = vec2(-1.0, 0.0);
    v_geom = vec4(0.0);

    // The state of the row: a hidden row draws nothing, a moving one is translated
    uint rowState = readRowState(row);
    if (rowStateHidden(rowState)) {
        emitShadeOffset(vec2(0.0));
        gl_Position = ${ROW_HIDDEN_POSITION_GLSL};
        return;
    }
    g_row_shift = rowStateTranslation(rowState);

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
flat in vec4 v_dash;
flat in vec2 v_dash_end;
in vec4 v_geom;

// The opacity factor of the drawing (the opacity of the layer)
uniform float u_opacity;
// 1 to discard the back faces of the fills (the terrain), 0 otherwise
uniform float u_cull_back;
// The pictures of the sprites of the chunk
uniform sampler2D u_sprites;

out vec4 fragColor;

const float AA = 0.5;
${POINT_SDF_GLSL}
${TERRAIN_SHADE_FRAGMENT_GLSL}

// The coverage of a round end at a distance along the line beyond it (device pixels)
float capCoverage(float d, float along, float w) {
    float capDist = length(vec2(d, along)) - w;
    return 1.0 - clamp(capDist + 0.5, 0.0, 1.0);
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
    float linePos = v_geom.y;
    float startDist = -linePos;
    float endDist = linePos - v_params.y;
    float coverage;
    if (v_dash_end.y < 0.5) {
        if (startDist > 0.0) {
            coverage = capCoverage(d, startDist, w);
        } else if (endDist > 0.0) {
            coverage = capCoverage(d, endDist, w);
        } else {
            float left = clamp(d - w + 0.5, 0.0, 1.0);
            float right = clamp(d + w + 0.5, 0.0, 1.0);
            coverage = right - left;
        }
    } else {
        // The dashes start at the start of the line: [k * period, k * period + dash]
        float dash = v_dash.x;
        float period = v_dash.y;
        float cssPerPx = v_dash.z;
        if (startDist > 0.0) {
            // Before the start of the line: the round end of the first dash
            coverage = capCoverage(d, startDist, w);
        } else if (endDist > 0.0) {
            // Past the end of the line: the round end of the last dash, cut at the end
            float atEnd = mod(v_dash_end.x, period);
            float back = atEnd <= dash ? 0.0 : (atEnd - dash) / cssPerPx;
            coverage = capCoverage(d, endDist + back, w);
        } else {
            float pos = v_dash.w + linePos * cssPerPx;
            float m = mod(pos, period);
            if (m <= dash) {
                float left = clamp(d - w + 0.5, 0.0, 1.0);
                float right = clamp(d + w + 0.5, 0.0, 1.0);
                coverage = right - left;
            } else {
                // In a gap: the round end of the dash before it, or of the one after it (when
                // the line goes on to it)
                float along = m - dash;
                float toNext = period - m;
                if (v_dash_end.x < 0.0 || pos + toNext <= v_dash_end.x) along = min(along, toNext);
                coverage = capCoverage(d, along / cssPerPx, w);
            }
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
        fragColor = texture(u_sprites, v_geom.xy) * (u_opacity * v_params.x);
    }
}`;
}

/** The miter limit the segments and the outlines use (the one of the other renderers) */
export const ROWS_MITER_LIMIT = RENDERING_DEFAULTS.MITER_LIMIT;
