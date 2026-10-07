// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The GLSL sources of the SDF line program
 *
 * The HHAA approach:
 * 1. Project geographic coordinates -> Mercator -> clip space
 * 2. Compute the normal direction in clip space
 * 3. Compute the offset in screen space (pixels)
 * 4. Convert back to clip space and set gl_Position
 * 5. Pass the signed distance (pixels) to the fragment stage
 *
 * The vertex stage also computes the miter/bevel joins, the round caps, and the subdivision
 * of a segment on terrain and on the globe; the fragment stage computes the coverage of the line body and the
 * caps and applies the dash pattern.
 */

import { getProjectionTransitionUniform, OFFSET_MODE_GLSL } from '../../shaders/helpers.js';

/**
 * The vertex shader source of the SDF line program
 *
 * @param prelude The vertex shader prelude maplibre hands to the custom layer
 * @param define The defines of the projection variant
 *
 * @internal
 */
export function buildLineVertexSource(prelude: string, define: string): string {
  const projTransitionUniform = getProjectionTransitionUniform(prelude);
  return `#version 300 es
${prelude}
${define}
${projTransitionUniform}${OFFSET_MODE_GLSL}

// Strip vertex attributes
layout(location = 0) in float a_side;    // 1=left, -1=right
// a_station: the index of the subdivision point along the segment (0..u_stations)
layout(location = 1) in float a_station;

// Instance attributes
// a_indices: x=start point idx, y=end point idx, z=previous point idx (-1=none),
//            w=next point idx (-1=none)
layout(location = 2) in vec4 a_indices;
// a_extra: x=cumulative distance at the segment start (drawing-buffer px at the draw zoom,
//          for dashes), y=original line width (px), z=createdZoom, w=segment length
layout(location = 3) in vec4 a_extra;
layout(location = 4) in vec4 a_color;    // line color (opacity already folded in)

// Uniforms
uniform float u_width;        // line width (pixels) - for individual draws
uniform float u_zoom;         // current zoom level
uniform vec2 u_viewport;      // viewport size
uniform float u_miter_limit;  // miter limit
uniform sampler2D u_coord_tex;
uniform float u_tex_size;
uniform float u_size_scale;   // size factor at draw time (default 1)
uniform float u_stations;     // number of subdivisions of the segment (1 on a flat map)
// 1 when the subdivision points move along the Mercator plane (the globe), 0 when they move
// along the degrees (the terrain)
uniform float u_station_mercator;

out float v_dist;        // signed distance from the line center (pixels)
out float v_width;       // half the line width (pixels)
out float v_linesofar;   // cumulative distance (drawing-buffer px, for dashes)
// v_line_pos: position along the line (0=start, segmentLength=end,
//             negative=start cap, >segmentLength=end cap)
out float v_line_pos;
out float v_seg_length;  // segment length
out vec4 v_color;        // line color (instance attribute)

// Read the relative coordinate from the coordinate texture
// (already computed at 64-bit precision on the CPU side)
vec2 getCoordOffset(int idx) {
    int x = idx % int(u_tex_size);
    int y = idx / int(u_tex_size);
    return texelFetch(u_coord_tex, ivec2(x, y), 0).xy;
}

// Project the relative coordinate to get clip-space coordinates (high-precision version)
vec4 projectOffset(vec2 offset) {
    return project_position_to_clipspace_from_offset(offset, u_projection_matrix);
}

// The Mercator limit of latitude (the plane reaches infinity at the poles)
const float STATION_MAX_LAT = 85.0511287798066;

// Mercator coordinates (0-1) -> WGS84
vec2 stationMercatorToLngLat(vec2 mercator) {
    float lng = mercator.x * 360.0 - 180.0;
    float lat = degrees(atan(sinh(PI * (1.0 - 2.0 * mercator.y))));
    return vec2(lng, lat);
}

// The point at t along the segment from a to b (relative coordinates)
//
// On the terrain it moves along the degrees, as it always has. On the globe it moves along the
// straight line of the Mercator plane: that is the path maplibre draws an edge along on the
// sphere (a parallel stays a parallel), where a straight line between the projected ends would
// be a chord through the sphere.
vec2 stationOffset(vec2 a, vec2 b, float t) {
    if (u_station_mercator < 0.5) return mix(a, b, t);
    // The same absolute coordinates as project_position_to_clipspace_from_offset
    vec2 base = u_origin_shift + u_center_lnglat;
    vec2 la = a + base;
    vec2 lb = b + base;
    la.y = clamp(la.y, -STATION_MAX_LAT, STATION_MAX_LAT);
    lb.y = clamp(lb.y, -STATION_MAX_LAT, STATION_MAX_LAT);
    vec2 mercator = mix(lngLatToMercator(la), lngLatToMercator(lb), t);
    return stationMercatorToLngLat(mercator) - base;
}

// Convert clip-space coordinates into screen space (pixels)
vec2 clipToScreen(vec4 clip) {
    vec2 ndc = clip.xy / clip.w;
    return (ndc * 0.5 + 0.5) * u_viewport;
}

// Convert a screen-space offset into a clip-space offset
vec2 screenToClipOffset(vec2 screenOffset, float w) {
    return screenOffset * 2.0 / u_viewport * w;
}

void main() {
    // Get the indices
    int startIdx = int(a_indices.x);
    int endIdx = int(a_indices.y);
    int prevIdx = int(a_indices.z);
    int nextIdx = int(a_indices.w);

    // The position along the segment (0=start, 1=end)
    // With u_stations = 1 only 0 and 1 come out, which is identical to before terrain
    float stations = max(u_stations, 1.0);
    float t = min(a_station / stations, 1.0);
    bool atStart = a_station < 0.5;
    bool atEnd = t >= 1.0;

    // Get the relative coordinates (already computed at 64-bit precision on the CPU side)
    vec2 startOffset = getCoordOffset(startIdx);
    vec2 endOffset = getCoordOffset(endIdx);

    // High-precision version: project into clip space
    vec4 startClip = projectOffset(startOffset);
    vec4 endClip = projectOffset(endOffset);

    // Convert into screen space
    vec2 startScreen = clipToScreen(startClip);
    vec2 endScreen = clipToScreen(endClip);

    // The current point (start or end)
    vec4 currentClip = atStart ? startClip : endClip;
    vec2 currentScreen = atStart ? startScreen : endScreen;

    // The direction of the segment (screen space)
    vec2 segmentVec = endScreen - startScreen;
    float screenSegmentLength = length(segmentVec);
    vec2 segmentDir = segmentVec / screenSegmentLength;
    // The normal vector (pointing left)
    vec2 normal = vec2(-segmentDir.y, segmentDir.x);

    // Only for subdivision on terrain or on the globe (u_stations > 1), compute the position of
    // the subdivision point and the local direction. On a flat map without terrain, the uniform
    // branch skips this block entirely, so it is exactly identical to the previous computation.
    if (u_stations > 1.5) {
        float dt = 1.0 / stations;
        vec2 backOffset = stationOffset(startOffset, endOffset, max(t - dt, 0.0));
        vec2 forwardOffset = stationOffset(startOffset, endOffset, min(t + dt, 1.0));

        if (!atStart && !atEnd) {
            vec2 midOffset = stationOffset(startOffset, endOffset, t);
            currentClip = projectOffset(midOffset);
            currentScreen = clipToScreen(currentClip);
        }

        vec2 backScreen = atStart ? currentScreen : clipToScreen(projectOffset(backOffset));
        vec2 forwardScreen = atEnd ? currentScreen : clipToScreen(projectOffset(forwardOffset));
        vec2 localVec = forwardScreen - backScreen;
        float localLen = length(localVec);
        if (localLen > 0.0001) {
            vec2 localDir = localVec / localLen;
            segmentDir = localDir;
            normal = vec2(-localDir.y, localDir.x);
        }
    }

    // Miter computation
    float miterScale = 1.0;
    vec2 miterNormal = normal;

    if (atStart) {
        // Start point: take the previous segment into account
        if (prevIdx >= 0) {
            vec2 prevOffset = getCoordOffset(prevIdx);
            vec4 prevClip = projectOffset(prevOffset);
            vec2 prevScreen = clipToScreen(prevClip);

            vec2 prevDir = normalize(startScreen - prevScreen);
            vec2 prevNormal = vec2(-prevDir.y, prevDir.x);

            // The miter normal (the average of the two normals, normalized)
            vec2 avgNormal = prevNormal + normal;
            float avgLen = length(avgNormal);
            if (avgLen > 0.001) {
                miterNormal = avgNormal / avgLen;
                float cosHalf = dot(miterNormal, normal);
                if (cosHalf > 0.001) {
                    miterScale = 1.0 / cosHalf;
                    // Fall back to a bevel once the miter limit is exceeded
                    if (miterScale > u_miter_limit) {
                        miterScale = 1.0;
                        miterNormal = normal;
                    }
                }
            }
        }
    } else if (atEnd) {
        // End point: take the next segment into account
        if (nextIdx >= 0) {
            vec2 nextOffset = getCoordOffset(nextIdx);
            vec4 nextClip = projectOffset(nextOffset);
            vec2 nextScreen = clipToScreen(nextClip);

            vec2 nextDir = normalize(nextScreen - endScreen);
            vec2 nextNormal = vec2(-nextDir.y, nextDir.x);

            // The miter normal
            vec2 avgNormal = normal + nextNormal;
            float avgLen = length(avgNormal);
            if (avgLen > 0.001) {
                miterNormal = avgNormal / avgLen;
                float cosHalf = dot(miterNormal, normal);
                if (cosHalf > 0.001) {
                    miterScale = 1.0 / cosHalf;
                    // Fall back to a bevel once the miter limit is exceeded
                    if (miterScale > u_miter_limit) {
                        miterScale = 1.0;
                        miterNormal = normal;
                    }
                }
            }
        }
    }

    // Scale the line width with the zoom level (computed on the GPU side)
    // a_extra.y = the original line width (pixels relative to createdZoom)
    // a_extra.z = createdZoom
    // widthPixels = strokeWidth * 2^(u_zoom - createdZoom)
    //
    // strokeWidth < 0 means "a fixed width of -strokeWidth pixels (zoom-independent)".
    // This is the convention that lets features without a createdZoom be mixed into the same
    // batch (= the same u_zoom) as variable-width features and drawn together.
    //
    // u_size_scale is the size factor at draw time (default 1). It is multiplied outside the
    // branch so that it takes effect no matter which branch the data layer goes through.
    float strokeWidth = a_extra.y;
    float createdZoom = a_extra.z;
    float lineWidth = (strokeWidth > 0.0
        ? strokeWidth * pow(2.0, u_zoom - createdZoom)
        : (strokeWidth < 0.0 ? -strokeWidth : u_width)) * u_size_scale;
    // Below one pixel the line is drawn one pixel wide and fainter by its width, so the ink per
    // unit of length follows the width and goes to nothing with it (the caps of every dash
    // included, which would otherwise keep a blob of a fixed size)
    float ink = clamp(lineWidth, 0.0, 1.0);
    lineWidth = max(lineWidth, 1.0);
    float halfWidth = lineWidth / 2.0;

    // HHAA: expand by w+1 so that partially covered pixels are included too
    float expandedHalfWidth = halfWidth + 1.0;

    // The offset in screen space
    vec2 screenOffset = miterNormal * a_side * expandedHalfWidth * miterScale;

    // Convert it into an offset in clip space
    vec2 clipOffset = screenToClipOffset(screenOffset, currentClip.w);

    // Segment information
    float segmentStart = a_extra.x;        // cumulative distance at the starting position
    // Use the screen-space segment length computed on the GPU side (better precision)

    // Round cap handling
    // When there is no preceding or following segment, expand to round off the end
    bool isStartCap = atStart && (prevIdx < 0);
    bool isEndCap = atEnd && (nextIdx < 0);

    vec2 capOffset = vec2(0.0);
    float linePos = t * screenSegmentLength;  // position along the line

    if (isStartCap) {
        // Start cap: expand against the direction of travel
        capOffset = -segmentDir * expandedHalfWidth;
        linePos = -expandedHalfWidth;  // before the start point
    } else if (isEndCap) {
        // End cap: expand along the direction of travel
        capOffset = segmentDir * expandedHalfWidth;
        linePos = screenSegmentLength + expandedHalfWidth;  // beyond the end point
    }

    // The final position (including the cap expansion)
    vec2 totalScreenOffset = screenOffset + capOffset;
    vec2 totalClipOffset = screenToClipOffset(totalScreenOffset, currentClip.w);
    gl_Position = currentClip + vec4(totalClipOffset, 0.0, 0.0);

    // The values passed to the fragment stage
    v_dist = a_side * expandedHalfWidth;  // signed distance (pixels)
    v_width = halfWidth;                   // half the line width (pixels)
    v_linesofar = segmentStart + t * screenSegmentLength;  // cumulative distance (for dashes)
    v_line_pos = linePos;                  // position along the line
    v_seg_length = screenSegmentLength;    // segment length (computed on the GPU)
    v_color = a_color * ink;               // line color (instance attribute), by the ink
}`;
}

/**
 * The fragment shader source of the SDF line program
 *
 * @internal
 */
export const LINE_FRAGMENT_SOURCE = `#version 300 es
precision highp float;

in float v_dist;        // signed distance from the line center (pixels)
in float v_width;       // half the line width (pixels)
in float v_line_pos;    // position along the line
in float v_seg_length;  // segment length
in float v_linesofar;   // cumulative distance (drawing-buffer px, for dashes)
in vec4 v_color;        // line color (opacity already folded in)

uniform float u_dashEnabled;  // flag that enables the dash pattern
uniform vec4 u_dashArray;     // [dash, gap, period, 0] in drawing-buffer px
uniform float u_opacity;      // opacity factor at draw time (default 1)

out vec4 fragColor;

void main() {
    float d = v_dist;
    float w = v_width;

    // Compute the distance from the ends along the line
    // startDist: distance from the start point (negative=inside the line, positive=cap region)
    float startDist = -v_line_pos;
    // endDist: distance from the end point (negative=inside the line, positive=cap region)
    float endDist = v_line_pos - v_seg_length;

    float coverage;

    if (startDist > 0.0) {
        // Start cap region: circular distance function
        float capDist = length(vec2(d, startDist)) - w;
        coverage = 1.0 - clamp(capDist + 0.5, 0.0, 1.0);
    } else if (endDist > 0.0) {
        // End cap region: circular distance function
        float capDist = length(vec2(d, endDist)) - w;
        coverage = 1.0 - clamp(capDist + 0.5, 0.0, 1.0);
    } else {
        // Ordinary line rendering (HHAA)
        float left = clamp(d - w + 0.5, 0.0, 1.0);
        float right = clamp(d + w + 0.5, 0.0, 1.0);
        coverage = right - left;
    }

    // Apply the dash pattern
    if (u_dashEnabled > 0.5 && coverage > 0.0) {
        float patternLength = u_dashArray.z;
        float dashLength = u_dashArray.x;
        float posInPattern = mod(v_linesofar, patternLength);
        if (posInPattern > dashLength) {
            coverage = 0.0;
        }
    }

    // The factor is multiplied into the whole value the same way the existing coverage is
    fragColor = v_color * coverage * u_opacity;
}`;
