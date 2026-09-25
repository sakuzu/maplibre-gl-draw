// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * StrokeRenderer
 *
 * A renderer that draws lines with thickness using triangle strips.
 * It uses the same HHAA scheme as SDFLineRenderer.
 * Normals are computed in screen space to achieve a uniform line width.
 */

import type { Map as MapLibreMap, ProjectionData } from 'maplibre-gl';
import { getDashPattern, getMetersPerPixel, RENDERING_DEFAULTS } from '../../shared/math/index.js';
import type { StrokeStyle } from '../../shared/types/style.js';
import type { PixelRatioInput } from '../../shared/utils/pixel-ratio.js';
import { resolveContentPixelRatio, resolvePixelRatio } from '../../shared/utils/pixel-ratio.js';
import { getSurfaceTessellationStep } from '../globe-subdivision.js';
import type { OffsetUniforms, ShaderData } from '../shaders/helpers.js';
import {
  calculateLngLatOffset,
  createProgram,
  getProjectionTransitionUniform,
  OFFSET_MODE_GLSL,
} from '../shaders/helpers.js';
import { ProjectionUniformManager } from '../shaders/projection.js';
import { anchorElevationMeters } from '../terrain/anchor.js';
import { TerrainContext } from '../terrain/context.js';
import { densifyPath } from '../terrain/tessellation.js';
import { screenPixelDistance } from './line/line-geometry.js';
import type { WidthUnit } from './line/line-types.js';

/** Sentinel meaning that there is no per-vertex elevation (the same convention as the shader) */
const NO_ELEVATION = -1.0e6;

/**
 * The upper limit on subdivision points that may be inserted when draping the
 * outline of the selection UI onto the terrain
 *
 * A selection box has only 4 edges, but selecting a wide feature makes one edge
 * hundreds of kilometers long. The step is the node spacing of the terrain mesh,
 * so without an upper limit the number of points diverges.
 */
const UI_DENSIFY_MAX_POINTS = 4096;

// The style types are defined in shared/ so that the configuration in shared/config can use them
export type { Color, LineStyle, StrokeStyle } from '../../shared/types/style.js';

export type { WidthUnit };

/**
 * The stroke options
 */
export interface StrokeOptions {
  widthUnit: WidthUnit;
  closed: boolean; // Whether the path is closed
  /**
   * Whether to look up the ground elevation on the CPU for each point of the path
   * and place the point on it
   *
   * The lines of the selection UI (the selection box and the connecting lines) set
   * this. The elevation then comes from the same function as the handles, so the
   * drawn line and the position that can be grabbed match structurally.
   */
  followTerrain?: boolean;
  /**
   * The elevation (in meters) to place the path on. When omitted, the ground
   * elevation is looked up from the DEM
   *
   * A "single plate enclosing the feature", such as a selection box, twists in
   * space if a different height is picked up for each vertex, and in a tilted
   * view it appears far away from the feature. Placing it on a single height
   * keeps it a flat plate.
   */
  elevationMeters?: number;
}

/** A WGS84 coordinate */
interface LngLatCoord {
  lng: number;
  lat: number;
}

/** Vertex data (based on WGS84 coordinates) */
interface StrokeVertex {
  // The current vertex (WGS84)
  lng: number;
  lat: number;
  // The previous vertex (itself when this is the start point)
  prevLng: number;
  prevLat: number;
  // The next vertex (itself when this is the end point)
  nextLng: number;
  nextLat: number;
  // The side (+1: left, -1: right)
  side: number;
  // The cumulative distance (for dashes, CSS px)
  distance: number;
}

// The structure of the vertex data: lng, lat, prevLng, prevLat, nextLng, nextLat, side, distance
const FLOATS_PER_VERTEX = 9;
const STRIDE = FLOATS_PER_VERTEX * 4; // 36 bytes

/**
 * The cumulative distance of every vertex of a path, in CSS px at `zoom` (for dashes)
 *
 * The fragment shader compares it with the dash pattern, which is also in CSS px, so a dash
 * keeps its length on screen at any zoom and latitude (the same rule as the SDF line
 * renderer: the distance is measured on the 512 px Web Mercator world).
 *
 * @internal
 */
export function strokeDashDistances(
  coords: ReadonlyArray<readonly [number, number]>,
  zoom: number,
): number[] {
  const distances: number[] = [];
  let cumulative = 0;
  for (let i = 0; i < coords.length; i++) {
    if (i > 0) cumulative += screenPixelDistance(coords[i - 1], coords[i], zoom);
    distances.push(cumulative);
  }
  return distances;
}

/**
 * StrokeRenderer
 */
export class StrokeRenderer {
  private map: MapLibreMap;
  private gl: WebGL2RenderingContext;
  /** The injected rendering ratio (when not injected, it is read from window each time) */
  private pixelRatio: PixelRatioInput | undefined;
  /** The terrain state of the draw instance this renderer belongs to */
  private readonly terrain: TerrainContext;
  private program: WebGLProgram | null = null;
  private variantName = '';
  private projectionUniformManager: ProjectionUniformManager;

  // Uniform locations (specific to this renderer)
  private colorLoc: WebGLUniformLocation | null = null;
  private dashArrayLoc: WebGLUniformLocation | null = null;
  private dashEnabledLoc: WebGLUniformLocation | null = null;
  private widthLoc: WebGLUniformLocation | null = null;
  private viewportLoc: WebGLUniformLocation | null = null;
  private miterLimitLoc: WebGLUniformLocation | null = null;
  private explicitElevationLoc: WebGLUniformLocation | null = null;

  // Holds the uniforms for offset mode
  private offsetUniforms: OffsetUniforms | null = null;

  // The VAO and vertex buffer reused across draws (the attributes are set up only once,
  // at construction)
  private vao: WebGLVertexArrayObject | null = null;
  private vertexBuffer: WebGLBuffer | null = null;

  constructor(
    map: MapLibreMap,
    gl: WebGL2RenderingContext,
    pixelRatio?: PixelRatioInput,
    terrain: TerrainContext = new TerrainContext(),
  ) {
    this.map = map;
    this.gl = gl;
    this.pixelRatio = pixelRatio;
    this.terrain = terrain;
    this.projectionUniformManager = new ProjectionUniformManager(gl, { surface: true, terrain });
    this.vertexBuffer = gl.createBuffer();
    this.vao = gl.createVertexArray();
    this.setupVAO();
  }

  /**
   * Set up the vertex attributes on the VAO
   *
   * The structure of the vertex data: lng, lat, prevLng, prevLat, nextLng, nextLat, side, distance
   * (8 floats = 32 bytes)
   */
  private setupVAO(): void {
    const gl = this.gl;

    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);

    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, STRIDE, 0); // a_pos
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, STRIDE, 8); // a_prev
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 2, gl.FLOAT, false, STRIDE, 16); // a_next
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 1, gl.FLOAT, false, STRIDE, 24); // a_side
    gl.enableVertexAttribArray(4);
    gl.vertexAttribPointer(4, 1, gl.FLOAT, false, STRIDE, 28); // a_distance
    gl.enableVertexAttribArray(5);
    gl.vertexAttribPointer(5, 1, gl.FLOAT, false, STRIDE, 32); // a_elevation_m

    gl.bindVertexArray(null);
  }

  /**
   * Make sure the shader exists (recreating it when necessary)
   */
  ensureShader(shaderData: ShaderData): void {
    if (this.variantName !== shaderData.variantName) {
      if (this.program) {
        this.gl.deleteProgram(this.program);
      }

      this.program = this.createShaderProgram(shaderData.vertexShaderPrelude, shaderData.define);
      this.variantName = shaderData.variantName;

      // Get the uniform locations specific to this renderer
      this.colorLoc = this.gl.getUniformLocation(this.program, 'u_color');
      this.dashArrayLoc = this.gl.getUniformLocation(this.program, 'u_dashArray');
      this.dashEnabledLoc = this.gl.getUniformLocation(this.program, 'u_dashEnabled');
      this.widthLoc = this.gl.getUniformLocation(this.program, 'u_width');
      this.viewportLoc = this.gl.getUniformLocation(this.program, 'u_viewport');
      this.miterLimitLoc = this.gl.getUniformLocation(this.program, 'u_miter_limit');
      this.explicitElevationLoc = this.gl.getUniformLocation(
        this.program,
        'u_explicit_elevation_m',
      );

      // Get the projection-related uniform locations (shared implementation)
      this.projectionUniformManager.getLocations(this.program);
    }
  }

  /**
   * Set the uniforms for offset mode
   */
  setOffsetUniforms(uniforms: OffsetUniforms): void {
    this.offsetUniforms = uniforms;
  }

  /**
   * Create the shader program (offset mode)
   *
   * The same HHAA scheme as SDFLineRenderer:
   * 1. Project the current, previous and next vertices into clip space
   * 2. Compute the direction vectors in screen space and derive the normals
   * 3. Miter computation
   * 4. Apply the offset in screen space
   * 5. Antialiasing in the fragment shader
   */
  private createShaderProgram(prelude: string, define: string): WebGLProgram {
    const projTransitionUniform = getProjectionTransitionUniform(prelude);
    const vertexSource = `#version 300 es
${prelude}
${define}
${projTransitionUniform}${OFFSET_MODE_GLSL}

// Vertex attributes
// The current vertex (relative coordinates: dLng, dLat - the offset from the center)
layout(location = 0) in vec2 a_pos;
layout(location = 1) in vec2 a_prev;     // The previous vertex (relative coordinates: dLng, dLat)
layout(location = 2) in vec2 a_next;     // The next vertex (relative coordinates: dLng, dLat)
layout(location = 3) in float a_side;    // +1 (left side) or -1 (right side)
layout(location = 4) in float a_distance;
// The elevation (in meters) to place this vertex on. Below the sentinel, the ground
// elevation is used
layout(location = 5) in float a_elevation_m;

uniform float u_width;        // The line width (in pixels)
uniform vec2 u_viewport;      // The viewport size
uniform float u_miter_limit;  // The miter limit
// The explicit elevation (in meters). When negative, the ground elevation is looked up from the DEM
uniform float u_explicit_elevation_m;

out float v_dist;       // The signed distance from the line center (in pixels)
out float v_width;      // Half of the line width (in pixels)
out float v_distance;   // The cumulative distance (for dashes)

// Project relative coordinates into clip space in offset mode (using the offset already
// computed on the CPU side)
vec4 projectOffset(vec2 offset) {
    return project_position_to_clipspace_from_offset(offset, u_projection_matrix);
}

// Convert clip space coordinates into screen space (pixels)
vec2 clipToScreen(vec4 clip) {
    // Convert to NDC (perspective division) and then to screen coordinates
    vec2 ndc = clip.xy / clip.w;
    return (ndc * 0.5 + 0.5) * u_viewport;
}

// Convert a screen space offset into a clip space offset
vec2 screenToClipOffset(vec2 screenOffset, float w) {
    return screenOffset * 2.0 / u_viewport * w;
}

void main() {
    // When an explicit elevation is given, place the vertex at that height rather
    // than using the DEM. A "single plate enclosing the feature", such as a selection
    // box, twists in space if a different height is picked up for each vertex
    // (view/ui/selection-ui-drawer.ts)
    if (a_elevation_m > -1.0e5) {
        // The per-vertex elevation (the value the CPU obtained from the ground). It is the
        // same value as in hit testing, so the drawn line and the position that can be
        // grabbed match structurally
        g_anchor_elevation_m = a_elevation_m;
        g_anchor_elevation_on = 1.0;
    } else if (u_explicit_elevation_m > -1.0e5) {
        g_anchor_elevation_m = u_explicit_elevation_m;
        g_anchor_elevation_on = 1.0;
    }

    // Offset mode: project the current, previous and next vertices into clip space
    // (using the relative coordinates already computed on the CPU side)
    vec4 currentClip = projectOffset(a_pos);
    vec4 prevClip = projectOffset(a_prev);
    vec4 nextClip = projectOffset(a_next);

    // Convert into screen space
    vec2 currentScreen = clipToScreen(currentClip);
    vec2 prevScreen = clipToScreen(prevClip);
    vec2 nextScreen = clipToScreen(nextClip);

    // Determine whether the previous and next vertices are the same (start/end point)
    bool hasPrev = distance(a_pos, a_prev) > 0.0000001;
    bool hasNext = distance(a_pos, a_next) > 0.0000001;

    vec2 normal;
    float miterScale = 1.0;

    if (!hasPrev && hasNext) {
        // Start point: only the normal of the next segment
        vec2 dir = normalize(nextScreen - currentScreen);
        normal = vec2(-dir.y, dir.x);
    } else if (hasPrev && !hasNext) {
        // End point: only the normal of the previous segment
        vec2 dir = normalize(currentScreen - prevScreen);
        normal = vec2(-dir.y, dir.x);
    } else if (hasPrev && hasNext) {
        // Intermediate point: miter join
        vec2 dir1 = normalize(currentScreen - prevScreen);
        vec2 dir2 = normalize(nextScreen - currentScreen);

        vec2 normal1 = vec2(-dir1.y, dir1.x);
        vec2 normal2 = vec2(-dir2.y, dir2.x);

        // The miter normal (the average of the two normals, normalized)
        vec2 avgNormal = normal1 + normal2;
        float avgLen = length(avgNormal);

        if (avgLen > 0.001) {
            normal = avgNormal / avgLen;
            float cosHalf = dot(normal, normal1);
            if (cosHalf > 0.001) {
                miterScale = 1.0 / cosHalf;
                // Bevel once the miter limit is exceeded
                if (miterScale > u_miter_limit) {
                    miterScale = 1.0;
                    normal = normal1;
                }
            }
        } else {
            // A 180 degree turn back
            normal = normal1;
        }
    } else {
        // A single point (fallback)
        normal = vec2(0.0, 1.0);
    }

    // HHAA: expand by w+1 so that partially covered pixels are included as well
    float halfWidth = u_width / 2.0;
    float expandedHalfWidth = halfWidth + 1.0;

    // The offset in screen space
    vec2 screenOffset = normal * a_side * expandedHalfWidth * miterScale;

    // Convert into an offset in clip space
    vec2 clipOffset = screenToClipOffset(screenOffset, currentClip.w);

    // The final position
    gl_Position = currentClip + vec4(clipOffset, 0.0, 0.0);

    // The values passed to the fragment shader
    v_dist = a_side * expandedHalfWidth;  // The signed distance (in pixels)
    v_width = halfWidth;                   // Half of the line width (in pixels)
    v_distance = a_distance;
}`;

    const fragmentSource = `#version 300 es
precision highp float;

uniform vec4 u_color;
uniform vec4 u_dashArray; // [dashLength, gapLength, patternLength, 0]
uniform float u_dashEnabled;

in float v_dist;       // The signed distance from the line center (in pixels)
in float v_width;      // Half of the line width (in pixels)
in float v_distance;   // The cumulative distance

out vec4 fragColor;

// HHAA: compute the intersection of the pixel and the half plane
float pixelLine(float x) {
    return clamp(x + 0.5, 0.0, 1.0);
}

void main() {
    // The dash pattern
    if (u_dashEnabled > 0.5) {
        float patternLength = u_dashArray.z;
        if (patternLength > 0.0) {
            float pos = mod(v_distance, patternLength);
            if (pos > u_dashArray.x) {
                discard;
            }
        }
    }

    // HHAA: compute the coverage as the difference of two half planes
    float d = v_dist;
    float w = v_width;

    float left = pixelLine(d - w);
    float right = pixelLine(d + w);
    float coverage = right - left;

    fragColor = u_color * coverage;
}`;

    return createProgram(this.gl, vertexSource, fragmentSource);
  }

  /**
   * Set the projection uniforms (supports offset mode and globe mode)
   * @param projectionData MapLibre's ProjectionData
   * @param zoom The current zoom level (used to switch offset mode)
   */
  private setProjectionUniforms(projectionData: ProjectionData, zoom: number): void {
    this.projectionUniformManager.setUniforms(projectionData, zoom, this.offsetUniforms);
  }

  /**
   * Convert the width into pixels
   * When widthUnit is meters, it is converted into pixels based on the zoom level and the latitude
   * On high-DPI displays it is converted into physical pixels, taking devicePixelRatio into account
   */
  private getWidthInPixels(
    width: number,
    widthUnit: WidthUnit,
    zoom: number,
    centerLat: number,
  ): number {
    if (widthUnit === 'pixels') {
      // Convert CSS pixels into physical pixels (fixed in screen pixels, so renderScale
      // is included)
      return width * resolvePixelRatio(this.pixelRatio);
    }

    // Meter units: convert into pixels
    const tileSize =
      (this.map as unknown as { transform?: { tileSize?: number } }).transform?.tileSize ?? 512;
    const metersPerPixel = getMetersPerPixel(centerLat, zoom, tileSize);
    // Meter units are converted into physical pixels as well. But a ground dimension
    // already scales with the camera zoom (metersPerPixel moves with the zoom), so
    // renderScale is not multiplied in (see "the two ratios" in
    // shared/utils/pixel-ratio.ts).
    return (width / metersPerPixel) * resolveContentPixelRatio(this.pixelRatio);
  }

  /**
   * Generate the vertex data of a line (triangle strip)
   * Each vertex carries the information of the previous and next vertices
   */
  private generateVertices(
    lngLatCoords: LngLatCoord[],
    closed: boolean,
    distances: number[],
  ): StrokeVertex[] {
    if (lngLatCoords.length < 2) return [];

    const vertices: StrokeVertex[] = [];

    const n = lngLatCoords.length;

    for (let i = 0; i < n; i++) {
      const current = lngLatCoords[i];
      const prev = i > 0 ? lngLatCoords[i - 1] : closed ? lngLatCoords[n - 2] : current;
      const next = i < n - 1 ? lngLatCoords[i + 1] : closed ? lngLatCoords[1] : current;

      // The cumulative distance (for the dash pattern, CSS px)
      const cumulativeDistance = distances[i];

      // The vertex on the left side (side = +1)
      vertices.push({
        lng: current.lng,
        lat: current.lat,
        prevLng: prev.lng,
        prevLat: prev.lat,
        nextLng: next.lng,
        nextLat: next.lat,
        side: 1,
        distance: cumulativeDistance,
      });

      // The vertex on the right side (side = -1)
      vertices.push({
        lng: current.lng,
        lat: current.lat,
        prevLng: prev.lng,
        prevLat: prev.lat,
        nextLng: next.lng,
        nextLat: next.lat,
        side: -1,
        distance: cumulativeDistance,
      });
    }

    return vertices;
  }

  /**
   * Draw a line
   */
  draw(
    coords: Array<[number, number]>,
    style: StrokeStyle,
    options: StrokeOptions,
    zoom: number,
    projectionData?: ProjectionData,
  ): void {
    if (!this.program || coords.length < 2 || !projectionData) return;

    const gl = this.gl;

    // On terrain a long edge sinks into valleys, so subdivision points are inserted
    // on a grid. The outlines of the selection box and the handles pass through here
    // too, so they sit at the same elevation as the feature itself. On the globe the same
    // points keep an edge on the path the features are drawn along instead of a chord through
    // the sphere (globe-subdivision.ts).
    // On a flat map without terrain, null is returned and the coordinates are used as they are.
    //
    // This is the one place where the step is not limited to the tessellation region
    // (the intersection of the DEM atlas and the view). If it were, an edge leaving the
    // region would become "a single straight line whose elevation was only sampled at its
    // two ends", and in a tilted view the box would cut diagonally through the terrain and
    // look like a box stretching to a completely different place. This renderer draws only
    // the outlines of selection boxes and handles, which have few edges, so the cost is
    // bounded by an upper limit on the number of points rather than by a region.
    const terrainStep = getSurfaceTessellationStep(this.terrain, 'line');
    const path = terrainStep
      ? densifyPath(coords, {
          ...terrainStep,
          region: null,
          maxPoints: Math.min(terrainStep.maxPoints, UI_DENSIFY_MAX_POINTS),
        })
      : coords;

    // Convert the WGS84 coordinates into the LngLatCoord form (the Mercator conversion
    // is done in the shader)
    const lngLatCoords: LngLatCoord[] = path.map(([lng, lat]) => ({ lng, lat }));

    // Compute the center latitude (for the pixel conversion in the case of meter units)
    const centerLat = coords.reduce((sum, [, lat]) => sum + lat, 0) / coords.length;

    // Convert the line width into pixels
    const widthPixels = this.getWidthInPixels(style.width, options.widthUnit, zoom, centerLat);

    // When following the ground is requested, look up the elevation on the CPU for each
    // point of the path. It comes from the same function as hit testing (anchor
    // projection), so the drawn line and the position that can be grabbed match
    // structurally. Placing it on a single height (elevationMeters) makes only the
    // rendering shift in a tilted view, so it can no longer be grabbed
    const elevations = options.followTerrain
      ? new Map(
          path.map(([lng, lat]) => [
            `${lng},${lat}`,
            anchorElevationMeters(this.terrain, lng, lat),
          ]),
        )
      : null;

    const vertices = this.generateVertices(
      lngLatCoords,
      options.closed,
      strokeDashDistances(path, zoom),
    );
    if (vertices.length < 4) return;

    // Compute the relative coordinates on the CPU side (offset mode)
    const centerLngLat: [number, number] = this.offsetUniforms?.centerLngLat ?? [0, 0];

    const vertexData = new Float32Array(vertices.length * FLOATS_PER_VERTEX);
    for (let i = 0; i < vertices.length; i++) {
      const base = i * FLOATS_PER_VERTEX;
      // Compute the coordinates relative to the center coordinate (computed at 64-bit
      // precision and then stored as Float32)
      const posOffset = calculateLngLatOffset([vertices[i].lng, vertices[i].lat], centerLngLat);
      const prevOffset = calculateLngLatOffset(
        [vertices[i].prevLng, vertices[i].prevLat],
        centerLngLat,
      );
      const nextOffset = calculateLngLatOffset(
        [vertices[i].nextLng, vertices[i].nextLat],
        centerLngLat,
      );
      vertexData[base + 0] = posOffset[0];
      vertexData[base + 1] = posOffset[1];
      vertexData[base + 2] = prevOffset[0];
      vertexData[base + 3] = prevOffset[1];
      vertexData[base + 4] = nextOffset[0];
      vertexData[base + 5] = nextOffset[1];
      vertexData[base + 6] = vertices[i].side;
      vertexData[base + 7] = vertices[i].distance;
      vertexData[base + 8] = elevations
        ? (elevations.get(`${vertices[i].lng},${vertices[i].lat}`) ?? NO_ELEVATION)
        : NO_ELEVATION;
    }

    // Transfer the vertex data (the VAO and the vertex buffer are reused)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, vertexData, gl.DYNAMIC_DRAW);
    gl.bindVertexArray(this.vao);

    gl.useProgram(this.program);
    this.setProjectionUniforms(projectionData, zoom);

    // Set the viewport size and the line width
    if (this.viewportLoc) {
      gl.uniform2f(this.viewportLoc, gl.drawingBufferWidth, gl.drawingBufferHeight);
    }
    if (this.widthLoc) {
      gl.uniform1f(this.widthLoc, widthPixels);
    }
    if (this.miterLimitLoc) {
      gl.uniform1f(this.miterLimitLoc, RENDERING_DEFAULTS.MITER_LIMIT);
    }
    if (this.explicitElevationLoc) {
      // The sentinel meaning that there is no explicit elevation. A depth that cannot exist is used
      gl.uniform1f(this.explicitElevationLoc, options.elevationMeters ?? -1.0e6);
    }

    const color = [style.color[0], style.color[1], style.color[2], style.color[3] * style.opacity];
    if (this.colorLoc) {
      gl.uniform4fv(this.colorLoc, color);
    }

    const dashPattern = style.dashArray ?? getDashPattern(style.lineStyle);
    const isDashed = style.lineStyle !== 'solid' && dashPattern.length >= 2;

    if (this.dashEnabledLoc) {
      gl.uniform1f(this.dashEnabledLoc, isDashed ? 1.0 : 0.0);
    }

    if (isDashed && this.dashArrayLoc) {
      const dashLength = dashPattern[0];
      const gapLength = dashPattern[1];
      const patternLength = dashLength + gapLength;
      gl.uniform4fv(this.dashArrayLoc, [dashLength, gapLength, patternLength, 0]);
    }

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, vertices.length);

    gl.bindVertexArray(null);
  }

  /**
   * Draw a closed path (such as the outer ring of a polygon)
   */
  drawClosed(
    coords: Array<[number, number]>,
    style: StrokeStyle,
    options: Omit<StrokeOptions, 'closed'>,
    zoom: number,
    projectionData?: ProjectionData,
  ): void {
    if (coords.length < 3) return;

    // When the first and last points are the same, remove the duplicate
    let closedCoords = coords;
    const first = coords[0];
    const last = coords[coords.length - 1];
    if (first[0] === last[0] && first[1] === last[1]) {
      closedCoords = coords.slice(0, -1);
    }

    // Draw it as a closed path
    const loopCoords = [...closedCoords, closedCoords[0]];

    this.draw(loopCoords, style, { ...options, closed: true }, zoom, projectionData);
  }

  /**
   * Dispose of the resources
   */
  dispose(): void {
    if (this.program) {
      this.gl.deleteProgram(this.program);
      this.program = null;
    }
    if (this.vao) {
      this.gl.deleteVertexArray(this.vao);
      this.vao = null;
    }
    if (this.vertexBuffer) {
      this.gl.deleteBuffer(this.vertexBuffer);
      this.vertexBuffer = null;
    }
  }
}
