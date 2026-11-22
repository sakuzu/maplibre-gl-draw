// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The GLSL sources of the program that draws rows of every kind in one draw (`RowsRenderer`)
 *
 * The vertex and the fragment stages branch on the kind of the instance (`rows-format.ts`), and
 * each branch is the formula of the renderer that draws that kind for the features, as it is, on
 * the same projection (the prelude maplibre gives a custom layer and `OFFSET_MODE_GLSL`):
 *
 * - a point: the instanced points (`point-instance.ts`), the fill and the stroke in one quad
 * - a segment of a line: the SDF lines (`line-shader.ts`), its miter falling back to a bevel, its
 *   round ends and its color multiplied into every component
 * - an edge of the outline of a polygon: the outline of the SDF polygons (`sdf-polygon.ts`), its
 *   miter only shortened, its two-pixel smoothing and its factor on the alpha only
 * - the fill of a polygon: the fill of the SDF polygons
 * - a dashed segment (of a line, or of the outline of a polygon): the segment of a line, cut into
 *   dashes and gaps by the pattern the lines dashed on the CPU use (`dash.ts`), each dash with the
 *   round ends it gets there. The CPU draws each dash as a line of its own: a dash that goes on
 *   over a corner gets the miter of the corner, and one that ends near a corner gets a round end
 *   that reaches over it. A segment here draws the dashes the CPU draws on it, its own (cut at
 *   its ends, where a dash going on over a corner keeps its miter), and the parts of the dashes
 *   of the segments next to it that reach over the corners into its strip, each blended over the
 *   ones drawn before it as the blending of the frame would blend them
 *
 * On the terrain and on the globe the branches take the formulas the renderers of the features
 * use there: a segment is drawn in stations along it (`u_stations`, the strip of `line-shader.ts`,
 * the stations moving along the degrees on the terrain and along the Mercator plane on the globe,
 * the miters at its ends only); a point packed for the surface stands at the elevation it carries,
 * the one the hit testing projects it with, and is not hidden by the depth of the terrain (as the
 * points are drawn with the depth test off: it is drawn at the near plane, which the depth test
 * of the frame always passes); a fill drops the faces turned away from the camera while the
 * terrain is drawn (`terrain-cull.ts`); and on a frame that draws the polygons and the lines flat
 * (`surfacesFlattened`), they get no elevation while the points keep theirs. On a frame the
 * analytic drape paints, a point the terrain hides from the camera is drawn faint, as the points
 * drawn one at a time are there (`rows-occlusion.ts`, once per vertex, the same for every vertex
 * of the point). Those frames can draw the points of a chunk of the other frames only
 * (`u_points_only`): the drape paints the rest of it.
 *
 * The blending is the one of the layer, so the branches differ only in what they emit. The
 * shaders never read `gl_InstanceID`: a range of rows is drawn by pointing the instance
 * attributes at its first instance, so the place of an instance in a draw means nothing.
 */

import { DEFAULT_TILE_SIZE } from '../../../shared/math/index.js';
import { getProjectionTransitionUniform, OFFSET_MODE_GLSL } from '../../shaders/helpers.js';
import {
  TERRAIN_SHADE_FRAGMENT_GLSL,
  TERRAIN_SHADE_VERTEX_GLSL,
} from '../../shaders/terrain-shade.js';
import { DASH_COEFFICIENTS } from '../line/dash.js';
import { POINT_AA_PADDING_PX, POINT_MIN_OUTER_PX } from '../point/point-instance.js';
import { POINT_SDF_GLSL } from '../point/point-sdf.js';
import { ROW_HIDDEN_POSITION_GLSL, ROW_STATE_GLSL } from '../row-state.js';
import { ROWS_KIND, ROWS_KIND_SHIFT, ROWS_ROW_MASK, ROWS_STYLE_TEXELS } from './rows-format.js';
import { TERRAIN_OCCLUSION_GLSL } from './rows-occlusion.js';

/** A float literal of GLSL */
function glslFloat(value: number): string {
  const text = String(value);
  return /[.eE]/.test(text) ? text : `${text}.0`;
}

/** A distance no fragment is near (device px): the end of a dash that has none */
const FAR = 1e6;

/** The depth of a point on the terrain in normalized device coordinates: just past the near plane */
const POINT_NEAR_DEPTH = -0.999999;

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
${prelude}
${define}
${getProjectionTransitionUniform(prelude)}${OFFSET_MODE_GLSL}${TERRAIN_SHADE_VERTEX_GLSL}${ROW_STATE_GLSL}${TERRAIN_OCCLUSION_GLSL}

// The vertex of the strip: a corner (0 to 3) for every kind, and for a segment the side (its
// lowest bit) and the station along it (the rest)
layout(location = 0) in float a_corner;
// The tag: the kind above bit ${ROWS_KIND_SHIFT} and the number of the row in its group below it,
// taken apart with a shift and a mask (exact on every GPU)
layout(location = 1) in uint a_tag;
// xyz: coordinates 0 to 2
layout(location = 2) in vec3 a_head;
// x: coordinate 3, w: the length of the line before a dashed segment (CSS px at zoom 0), or the
// elevation of a point packed for the surface (meters); for a segment packed for the surface, y
// and z: the longest segment of its line in meters and on the Mercator plane
layout(location = 3) in vec4 a_tail;

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
// The most stations a segment of the chunk is drawn in (1: its two ends only)
uniform float u_stations;
// What the stations of a segment are decided from: the step of the terrain in meters (0 when the
// terrain does not decide them), else the cell of the globe for the lines on the Mercator plane
uniform float u_station_step;
uniform float u_station_grid;
// 1 when the stations move along the Mercator plane (the globe), 0 along the degrees (the terrain)
uniform float u_station_mercator;
// 1 when the rows of the chunk were packed for the surface: its points carry their elevations
uniform float u_surface;
// 1 on a frame that draws the polygons and the lines flat (the points keep their elevations)
uniform float u_surfaces_flat;
// 1 when only the points of the rows are drawn (the drape paints the rest of the chunk)
uniform float u_points_only;

flat out int v_kind;
// The color (the fill of a point)
flat out vec4 v_color;
// The stroke of a point
flat out vec4 v_color2;
// A point: radius, outer radius, ink, shape. A segment: half width, length on screen. An edge
// of an outline: half width
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
// A dashed segment: its start and its end on the screen (device px), and the w of their clip
// positions, from which a fragment finds its position on the line where it is
flat out vec4 v_dash_ends;
flat out vec2 v_dash_w;
// A dashed segment: the miters of its start and of its end (the normal and the scale; the normal
// of the segment and 1 where it meets no segment, or past the limit of the miter)
flat out vec3 v_dash_miter0;
flat out vec3 v_dash_miter1;
// A point: the offset in device pixels. A segment: the signed distance from its center line, the
// position along it, and for a dashed one its position on the line (CSS px). An edge of an
// outline: the signed distance
out vec4 v_geom;

int g_corner = 0;
// The vertex of the strip (for a segment, its side and its station)
int g_vertex = 0;

// The Mercator limit of latitude (the plane reaches infinity at the poles)
const float STATION_MAX_LAT = 85.0511287798066;

// Mercator coordinates (0-1) -> WGS84
vec2 stationMercatorToLngLat(vec2 mercator) {
    float lng = mercator.x * 360.0 - 180.0;
    float lat = degrees(atan(sinh(PI * (1.0 - 2.0 * mercator.y))));
    return vec2(lng, lat);
}

// The point at t along the segment from a to b (offsets): along the degrees on the terrain, along
// the straight line of the Mercator plane on the globe (the path maplibre draws an edge along)
vec2 stationOffset(vec2 a, vec2 b, float t) {
    if (u_station_mercator < 0.5) return mix(a, b, t);
    vec2 base = u_origin_shift + u_center_lnglat;
    vec2 la = a + base;
    vec2 lb = b + base;
    la.y = clamp(la.y, -STATION_MAX_LAT, STATION_MAX_LAT);
    lb.y = clamp(lb.y, -STATION_MAX_LAT, STATION_MAX_LAT);
    vec2 mercator = mix(lngLatToMercator(la), lngLatToMercator(lb), t);
    return stationMercatorToLngLat(mercator) - base;
}

vec2 rowsCoord(float index) {
    int i = int(index + 0.5);
    return texelFetch(u_coords, ivec2(i % u_coord_width, i / u_coord_width), 0).xy;
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

// The corner of the quad of a point: (-1, -1), (1, -1), (-1, 1), (1, 1)
vec2 quadCorner() {
    return vec2((g_corner & 1) == 1 ? 1.0 : -1.0, (g_corner & 2) == 2 ? 1.0 : -1.0);
}

// The length of a segment as the lines dashed on the CPU measure it, in CSS px at zoom 0
float dashLength0(vec2 a, vec2 b) {
    vec2 base = u_origin_shift + u_center_lnglat;
    float latitude = (a.y + b.y) * 0.5 + base.y;
    float cosLatitude = max(cos(latitude * PI / 180.0), 1e-6);
    float perDegree = ${glslFloat(DEFAULT_TILE_SIZE)} / 360.0;
    return length(vec2((b.x - a.x) * perDegree, (b.y - a.y) * perDegree / cosLatitude));
}

// The device px from the corner along a segment next to a dashed one of a position on the line
// (CSS px), the segment from \`base\` on the line \`lengthCss\` long and \`px\` long on the screen,
// through the perspective of its ends (\`cornerAt\`: 1 when the corner is its end, 0 its start)
float neighborPx(float base, float lengthCss, float wFrom, float wTo, float cornerAt, float px, float c) {
    float g = (c - base) / lengthCss;
    float den = (1.0 - g) * wFrom + g * wTo;
    float u = den > 0.0 ? g * wTo / den : g;
    return (u - cornerAt) * px;
}

// The dash of the segment from \`from\` to \`to\` (on screen, \`lengthCss\` long on the line) next to
// a dashed segment going along \`dir\` whose round end is at the corner they share (at \`corner\` on
// the line, CSS px), as \`v_dash_prev\` and \`v_dash_next\` hold it. A dash that goes on over the
// corner is drawn on both sides of it up to the miter, so nothing of it reaches over; one cut at
// the corner or near it has a round end that does. \`before\`: the segment is the one before the
// corner (its last dash), else the one after it (its first dash)
// \`wFrom\` and \`wTo\` are the w of the clip positions of the ends of that segment: a position on it
// is put on the screen through their perspective, where its dash ends are drawn
vec4 dashNeighbor(vec2 from, vec2 to, float wFrom, float wTo, float lengthCss, vec2 dir, float corner, vec2 pattern, bool before) {
    vec4 none = before ? vec4(1.0, 0.0, -2.0 * ${glslFloat(FAR)}, -${glslFloat(FAR)})
        : vec4(1.0, 0.0, ${glslFloat(FAR)}, 2.0 * ${glslFloat(FAR)});
    vec2 along = to - from;
    float px = length(along);
    if (px <= 0.0) return none;
    vec2 other = along / px;
    float dash = pattern.x;
    float period = pattern.x + pattern.y;
    float m = mod(corner, period);
    if (m > 0.0 && m < dash) return none;
    vec2 turn = vec2(dot(dir, other), dot(dir, vec2(-other.y, other.x)));
    // The device px from the corner on the screen of a position on the line (CSS px)
    float base = before ? corner - lengthCss : corner;
    float cornerAt = before ? 1.0 : 0.0;
    if (before) {
        // The last dash that ends at the corner or before it, on the segment
        float end = m >= dash ? corner - m + dash : corner - pattern.y;
        float first = corner - lengthCss;
        if (end <= first) return none;
        return vec4(turn, neighborPx(base, lengthCss, wFrom, wTo, cornerAt, px, max(end - dash, first)), neighborPx(base, lengthCss, wFrom, wTo, cornerAt, px, end));
    }
    // The first dash that starts at the corner or after it, on the segment
    float start = m > 0.0 ? corner - m + period : corner;
    float last = corner + lengthCss;
    if (start >= last) return none;
    return vec4(turn, neighborPx(base, lengthCss, wFrom, wTo, cornerAt, px, start), neighborPx(base, lengthCss, wFrom, wTo, cornerAt, px, min(start + dash, last)));
}

void drawPoint(int style) {
    vec2 offset = rowsCoord(a_head.x);
    emitShadeOffset(offset);
    // Packed for the surface, the point stands at the elevation it carries
    if (u_surface > 0.5) {
        g_anchor_elevation_m = a_tail.w;
        g_anchor_elevation_on = 1.0;
    }
    vec4 centerClip = rowsProject(offset);
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
    float depth = centerClip.z / centerClip.w;
    // On the terrain the point is not hidden by the depth of the ground (the points are drawn with
    // the depth test off): at the near plane it passes the depth test of the frame
    if (u_terrain_on > 0.5 && depth >= -1.0 && depth <= 1.0) depth = ${glslFloat(POINT_NEAR_DEPTH)};
    gl_Position = vec4(centerClip.xy / centerClip.w + offsetPx * u_pixel_to_clip, depth, 1.0);
    v_color = rowsStyle(style, 0);
    v_color2 = rowsStyle(style, 1);
    // Hidden by the terrain on a frame the drape paints: faint, its fill and its stroke (the
    // vertices past the fourth repeat it, and draw nothing)
    if (u_ghost_on > 0.5 && u_surface > 0.5 && g_vertex < 4) {
        float ghost = terrain_occlusion_opacity(offset, a_tail.w);
        v_color.a *= ghost;
        v_color2.a *= ghost;
    }
    v_params = vec4(radius, outer, ink, size.z);
    v_geom = vec4(offsetPx, 0.0, 0.0);
}

// The miter at an end of a segment where the line goes on: its normal and the factor of its
// length, from the normal of the segment there and the direction of the line before or after it
// (on screen). Past the miter limit the end falls back to the normal of the segment (a bevel)
vec3 segmentMiter(vec2 own, vec2 otherNormal) {
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
    // The stations of the segment: those a batch of its line alone is drawn in
    // (\`resolveLineStations\` from the longest segment of the line), at most those of the chunk.
    // The vertices past its last station repeat it (no area)
    float wanted = u_station_step > 0.0
        ? ceil(a_tail.y / u_station_step)
        : (u_station_grid > 0.0 ? ceil(a_tail.z / u_station_grid) : 1.0);
    float stations = clamp(wanted, 1.0, max(u_stations, 1.0));
    int vertex = min(g_vertex, 2 * int(stations + 0.5) + 1);
    // The station along the segment (with one station only its two ends: 0 and 1)
    float t = min(float(vertex >> 1) / stations, 1.0);
    bool atStart = (vertex >> 1) == 0;
    bool atEnd = t >= 1.0;
    float side = (vertex & 1) == 0 ? 1.0 : -1.0;

    vec2 startOffset = rowsCoord(a_head.y);
    vec2 endOffset = rowsCoord(a_head.z);
    vec4 startClip = rowsProject(startOffset);
    vec4 endClip = rowsProject(endOffset);
    vec2 startScreen = clipToScreen(startClip);
    vec2 endScreen = clipToScreen(endClip);
    vec4 currentClip = atStart ? startClip : endClip;
    vec2 currentOffset = atStart ? startOffset : endOffset;

    vec2 segmentVec = endScreen - startScreen;
    float screenSegmentLength = length(segmentVec);
    vec2 segmentDir = segmentVec / screenSegmentLength;
    vec2 normal = vec2(-segmentDir.y, segmentDir.x);

    // In stations (the terrain and the globe): the position of the station, and the direction of
    // the segment there on the screen. With one station the block is skipped, and the strip is
    // the one of the two ends
    if (stations > 1.5) {
        float dt = 1.0 / stations;
        if (!atStart && !atEnd) {
            currentOffset = stationOffset(startOffset, endOffset, t);
            currentClip = rowsProject(currentOffset);
        }
        vec2 currentScreen = clipToScreen(currentClip);
        vec2 backScreen = atStart
            ? currentScreen
            : clipToScreen(rowsProject(stationOffset(startOffset, endOffset, max(t - dt, 0.0))));
        vec2 forwardScreen = atEnd
            ? currentScreen
            : clipToScreen(rowsProject(stationOffset(startOffset, endOffset, min(t + dt, 1.0))));
        vec2 localVec = forwardScreen - backScreen;
        float localLen = length(localVec);
        if (localLen > 0.0001) {
            segmentDir = localVec / localLen;
            normal = vec2(-segmentDir.y, segmentDir.x);
        }
    }
    emitShadeOffset(currentOffset);

    vec3 miter0 = vec3(normal, 1.0);
    vec3 miter1 = vec3(normal, 1.0);
    if (prevIdx >= 0) {
        vec2 prevScreen = clipToScreen(rowsProject(rowsCoord(a_head.x)));
        vec2 prevDir = normalize(startScreen - prevScreen);
        miter0 = segmentMiter(normal, vec2(-prevDir.y, prevDir.x));
    }
    if (nextIdx >= 0) {
        vec2 nextScreen = clipToScreen(rowsProject(rowsCoord(a_tail.x)));
        vec2 nextDir = normalize(nextScreen - endScreen);
        miter1 = segmentMiter(normal, vec2(-nextDir.y, nextDir.x));
    }
    // The miters only at the ends of the segment; a station between them is square to it
    vec3 miter = atStart ? miter0 : (atEnd ? miter1 : vec3(normal, 1.0));
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
        float lengthCss = dashLength0(startOffset, endOffset) * scale;
        float startCss = a_tail.w * scale;
        float cssPerPx = lengthCss / screenSegmentLength;
        v_dash = vec3(dash, dash + gap, cssPerPx);
        v_dash_range = vec3(startCss, startCss + lengthCss, nextIdx < 0 ? 1.0 : 0.0);
        v_dash_ends = vec4(startScreen, endScreen);
        v_dash_w = vec2(startClip.w, endClip.w);
        v_dash_miter0 = miter0;
        v_dash_miter1 = miter1;
        // The dashes of the segments before and after it whose round ends reach over its corners
        if (prevIdx >= 0) {
            vec2 prevOffset = rowsCoord(a_head.x);
            vec4 prevClip = rowsProject(prevOffset);
            v_dash_prev = dashNeighbor(
                clipToScreen(prevClip), startScreen, prevClip.w, startClip.w,
                dashLength0(prevOffset, startOffset) * scale, segmentDir, startCss,
                vec2(dash, gap), true
            );
        }
        if (nextIdx >= 0) {
            vec2 nextOffset = rowsCoord(a_tail.x);
            vec4 nextClip = rowsProject(nextOffset);
            v_dash_next = dashNeighbor(
                endScreen, clipToScreen(nextClip), endClip.w, nextClip.w,
                dashLength0(endOffset, nextOffset) * scale, segmentDir, startCss + lengthCss,
                vec2(dash, gap), false
            );
        }
        // The position of this vertex on the line: its projection on the segment, exact
        // everywhere in the strip as the dashes cut on the CPU are
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

    vec2 screenOffset = miterNormal * side * expandedHalfWidth * miterScale;
    vec2 finalScreenPos = screenPos + screenOffset;
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

void main() {
    int kind = int(a_tag >> ${ROWS_KIND_SHIFT}u);
    int row = int(a_tag & ${ROWS_ROW_MASK}u);
    g_vertex = int(a_corner + 0.5);
    // A kind drawn as a quad repeats its last corner past the fourth vertex (no area)
    g_corner = min(g_vertex, 3);
    v_kind = kind;
    v_color = vec4(0.0);
    v_color2 = vec4(0.0);
    v_params = vec4(0.0);
    v_dash = vec3(0.0);
    v_dash_range = vec3(0.0);
    v_dash_ends = vec4(0.0);
    v_dash_w = vec2(1.0);
    v_dash_miter0 = vec3(0.0, 1.0, 1.0);
    v_dash_miter1 = vec3(0.0, 1.0, 1.0);
    v_dash_prev = vec4(1.0, 0.0, -2.0 * ${glslFloat(FAR)}, -${glslFloat(FAR)});
    v_dash_next = vec4(1.0, 0.0, ${glslFloat(FAR)}, 2.0 * ${glslFloat(FAR)});
    v_geom = vec4(0.0);

    // The state of the row: a hidden row draws nothing; nor does a row that is not a point when
    // only the points are drawn
    if (rowStateHidden(readRowState(row)) || (u_points_only > 0.5 && kind != ${ROWS_KIND.point})) {
        emitShadeOffset(vec2(0.0));
        gl_Position = ${ROW_HIDDEN_POSITION_GLSL};
        return;
    }

    int local = row - u_row_base;
    vec4 rowStyle = texelFetch(
        u_row_styles,
        ivec2(local % u_row_style_width, local / u_row_style_width),
        0
    );
    int style = int(rowStyle.x + 0.5);
    float createdZoom = rowStyle.y;
    bool hasCreatedZoom = rowStyle.z > 0.5;
    // On a frame that draws the polygons and the lines flat, they get no elevation
    if (u_surfaces_flat > 0.5 && kind != ${ROWS_KIND.point}) {
        g_anchor_elevation_m = 0.0;
        g_anchor_elevation_on = 1.0;
    }

    if (kind == ${ROWS_KIND.point}) {
        drawPoint(style);
    } else if (kind == ${ROWS_KIND.segment} || kind == ${ROWS_KIND.dashedOutline}) {
        drawSegment(kind, style, createdZoom, hasCreatedZoom);
    } else if (kind == ${ROWS_KIND.outline}) {
        drawOutline(style, createdZoom, hasCreatedZoom);
    } else {
        drawFill(style);
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
flat in vec4 v_dash_ends;
flat in vec2 v_dash_w;
flat in vec3 v_dash_miter0;
flat in vec3 v_dash_miter1;
in vec4 v_geom;

// The opacity factor of the drawing (the opacity of the layer)
uniform float u_opacity;
// 1 while the terrain is drawn: a fill drops the faces turned away from the camera
uniform float u_fill_cull;

out vec4 fragColor;

const float AA = 0.5;

// Where a fragment of a dashed segment is, from where it falls on the segment on the screen: x its
// position on the line (CSS px), through the perspective of the ends of the segment; y the length
// on the line per device pixel along the segment there; z its signed distance from the center line
// on the screen (device px). The dashes cut on the CPU lie on the ground and each is a short line
// of its own, its round ends and its width on the screen where it is: on a pitched map the ratio
// changes along a segment, and a value interpolated over a long segment is not one on the screen
vec3 dashPlace() {
    vec2 from = v_dash_ends.xy;
    vec2 along = v_dash_ends.zw - from;
    float screenLength2 = dot(along, along);
    float first = v_dash_range.x;
    float whole = v_dash_range.y - first;
    if (screenLength2 <= 0.0) return vec3(v_geom.z, v_dash.z, v_geom.x);
    float screenLength = sqrt(screenLength2);
    vec2 dir = along / screenLength;
    vec2 at = gl_FragCoord.xy - from;
    float d = dot(at, vec2(-dir.y, dir.x));
    // The share of the segment on the screen, and on the ground
    float u = dot(at, dir) / screenLength;
    float w0 = v_dash_w.x;
    float w1 = v_dash_w.y;
    float den = (1.0 - u) * w1 + u * w0;
    if (den <= 0.0) return vec3(v_geom.z, v_dash.z, d);
    float g = u * w0 / den;
    float perPx = whole * w0 * w1 / (den * den) / screenLength;
    return vec3(first + g * whole, perPx > 0.0 ? perPx : v_dash.z, d);
}
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

// The coverage of a dash of a segment next to this one at a point u along this segment from the
// corner they share and d across it, the dash given as \`v_dash_prev\` or \`v_dash_next\` gives it
float neighborCoverage(vec4 dash, float u, float d, float w) {
    return dashCoverage(u * dash.y + d * dash.x, u * dash.x - d * dash.y, dash.z, dash.w, w);
}

// The color a line drawn with a coverage emits, as the SDF lines emit it
vec4 lineColor(float coverage) {
    return v_color * coverage * u_opacity;
}

// One fragment drawn over another of the same draw, as the one fragment the blending of the
// frame (the color by its alpha, the alpha added over) makes of the two
vec4 drawnOver(vec4 under, vec4 over) {
    float alpha = under.a + over.a - under.a * over.a;
    if (alpha <= 0.0) return vec4(0.0);
    vec3 rgb = (over.rgb * over.a + (1.0 - over.a) * under.rgb * under.a) / alpha;
    return vec4(rgb, alpha);
}

// Where a position on the line of a dashed segment (CSS px) is on the screen (xy, device px) and
// the w of its clip position (z), through the perspective of the ends of the segment
vec3 dashScreenAt(float p) {
    float first = v_dash_range.x;
    float whole = v_dash_range.y - first;
    float g = whole > 0.0 ? (p - first) / whole : 0.0;
    float w0 = v_dash_w.x;
    float w1 = v_dash_w.y;
    float den = (1.0 - g) * w0 + g * w1;
    float u = den > 0.0 ? g * w1 / den : g;
    return vec3(mix(v_dash_ends.xy, v_dash_ends.zw, u), mix(w0, w1, g));
}

// The barycentric coordinates of a point in a triangle (negative ones: outside)
vec3 barycentric(vec2 p, vec2 a, vec2 b, vec2 c) {
    vec2 v0 = b - a;
    vec2 v1 = c - a;
    vec2 v2 = p - a;
    float den = v0.x * v1.y - v1.x * v0.y;
    if (abs(den) < 1e-12) return vec3(-1.0);
    float y = (v2.x * v1.y - v1.x * v2.y) / den;
    float z = (v0.x * v2.y - v2.x * v0.y) / den;
    return vec3(1.0 - y - z, y, z);
}

// The coverage at the fragment of the part on this segment, from p0 to p1 on the line (CSS px),
// of a dash the CPU cuts and draws as a line of its own: a strip of 4 vertices, a round end where
// the dash starts or ends on the segment, the miter of the corner where it goes on over one
// (\`join0\` at the start of the segment, \`join1\` at its end), and the distance across and the
// position along it interpolated over the two triangles of the strip as the lines interpolate
// them, so a short part next to a corner takes the shape the line of the dash has there
float dashPartCoverage(float p0, float p1, bool join0, bool join1, float w) {
    vec3 s0 = dashScreenAt(p0);
    vec3 s1 = dashScreenAt(p1);
    vec2 along = v_dash_ends.zw - v_dash_ends.xy;
    float segment = length(along);
    if (segment <= 0.0) return 0.0;
    vec2 dir = along / segment;
    vec2 normal = vec2(-dir.y, dir.x);
    float reach = w + 1.0;
    float length1 = length(s1.xy - s0.xy);
    // The vertices: left and right of the start, left and right of the end
    vec2 l0;
    vec2 r0;
    vec2 l1;
    vec2 r1;
    float at0 = join0 ? 0.0 : -reach;
    float at1 = join1 ? length1 : length1 + reach;
    if (join0) {
        vec2 offset = v_dash_miter0.xy * reach * v_dash_miter0.z;
        l0 = s0.xy + offset;
        r0 = s0.xy - offset;
    } else {
        l0 = s0.xy + normal * reach - dir * reach;
        r0 = s0.xy - normal * reach - dir * reach;
    }
    if (join1) {
        vec2 offset = v_dash_miter1.xy * reach * v_dash_miter1.z;
        l1 = s1.xy + offset;
        r1 = s1.xy - offset;
    } else {
        l1 = s1.xy + normal * reach + dir * reach;
        r1 = s1.xy - normal * reach + dir * reach;
    }
    // The triangles of the strip, (l0, r0, l1) and (r0, l1, r1), interpolated with the
    // perspective of the clip positions of the two ends
    vec2 p = gl_FragCoord.xy;
    const float EDGE = -1e-4;
    float d;
    float along1;
    vec3 b = barycentric(p, l0, r0, l1);
    if (b.x >= EDGE && b.y >= EDGE && b.z >= EDGE) {
        vec3 k = vec3(b.x / s0.z, b.y / s0.z, b.z / s1.z);
        float sum = k.x + k.y + k.z;
        d = (k.x * reach - k.y * reach + k.z * reach) / sum;
        along1 = (k.x * at0 + k.y * at0 + k.z * at1) / sum;
    } else {
        b = barycentric(p, r0, l1, r1);
        if (b.x < EDGE || b.y < EDGE || b.z < EDGE) return 0.0;
        vec3 k = vec3(b.x / s0.z, b.y / s1.z, b.z / s1.z);
        float sum = k.x + k.y + k.z;
        d = (-k.x * reach + k.y * reach - k.z * reach) / sum;
        along1 = (k.x * at0 + k.y * at1 + k.z * at1) / sum;
    }
    float startDist = -along1;
    float endDist = along1 - length1;
    if (startDist > 0.0) return capCoverage(d, startDist, w);
    if (endDist > 0.0) return capCoverage(d, endDist, w);
    return bodyCoverage(d, w);
}

// The color of a dashed segment: the dashes the CPU draws on it, cut at its ends (where a dash
// goes on over a corner, up to the miter), and those of the segments next to it that reach over
// the corners, each drawn over the ones before it as the CPU draws them
vec4 dashedColor(float w) {
    float dash = v_dash.x;
    float period = v_dash.y;
    vec3 place = dashPlace();
    float perPx = place.y;
    float d = place.z;
    float first = v_dash_range.x;
    float last = v_dash_range.y;
    bool lineEnd = v_dash_range.z > 0.5;
    float pos = place.x;
    float at = clamp(pos, first, last);
    float m = mod(at, period);
    // The dash of the segment before it, drawn before this one
    float fromStart = (pos - first) / perPx;
    vec4 color = lineColor(neighborCoverage(v_dash_prev, fromStart, d, w));
    // A dash that goes on over a corner joins the segment there with the miter (the line of the
    // dash goes on, past the end of the line it stops)
    if (m < dash) {
        // In a dash: its part on the segment
        float start = at - m;
        float end = start + dash;
        color = drawnOver(color, lineColor(dashPartCoverage(
            max(start, first), min(end, last), start < first, end > last && !lineEnd, w)));
    } else {
        // In a gap: the dash before it and the one after it, when they are on the segment
        float end = at - m + dash;
        if (end > first) {
            float start = end - dash;
            color = drawnOver(color, lineColor(dashPartCoverage(
                max(start, first), min(end, last), start < first, false, w)));
        }
        float next = at - m + period;
        if (next < last) {
            float nextEnd = next + dash;
            color = drawnOver(color, lineColor(dashPartCoverage(
                next, min(nextEnd, last), false, nextEnd > last && !lineEnd, w)));
        }
    }
    // The dash of the segment after it, drawn after this one
    float fromEnd = (pos - last) / perPx;
    return drawnOver(color, lineColor(neighborCoverage(v_dash_next, fromEnd, d, w)));
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
    if (v_dash.y > 0.0) return dashedColor(w);
    float linePos = v_geom.y;
    float startDist = -linePos;
    float endDist = linePos - v_params.y;
    float coverage;
    if (startDist > 0.0) {
        coverage = capCoverage(d, startDist, w);
    } else if (endDist > 0.0) {
        coverage = capCoverage(d, endDist, w);
    } else {
        coverage = bodyCoverage(d, w);
    }
    return lineColor(coverage);
}

vec4 shadeOutline() {
    float d = abs(v_geom.x) - v_params.x;
    float alpha = 1.0 - smoothstep(-1.0, 1.0, d);
    if (alpha < 0.01) discard;
    return vec4(v_color.rgb, v_color.a * alpha * u_opacity);
}

vec4 shadeFill() {
    // The fills cut on the terrain face the camera (\`pushOriented\`): the slope behind a ridge
    // faces away from it
    if (u_fill_cull > 0.5 && !gl_FrontFacing) discard;
    return vec4(v_color.rgb * terrainFillShade(), v_color.a * u_opacity);
}

void main() {
    if (v_kind == ${ROWS_KIND.point}) {
        fragColor = shadePoint();
    } else if (v_kind == ${ROWS_KIND.segment} || v_kind == ${ROWS_KIND.dashedOutline}) {
        fragColor = shadeSegment();
    } else if (v_kind == ${ROWS_KIND.outline}) {
        fragColor = shadeOutline();
    } else {
        fragColor = shadeFill();
    }
}`;
}
