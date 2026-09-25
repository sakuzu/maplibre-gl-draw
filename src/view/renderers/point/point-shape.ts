// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * PointShapeRenderer
 *
 * A renderer that draws a point as a shape of a fixed size in screen pixels.
 * The Mercator-to-clip-space conversion is done on the GPU (using MapLibre's projectTile)
 */

import type { Map as MapLibreMap, ProjectionData } from 'maplibre-gl';
import { RENDERING_DEFAULTS } from '../../../shared/math/index.js';
import type { PointShape, PointStyle } from '../../../shared/types/style.js';
import type { PixelRatioInput } from '../../../shared/utils/pixel-ratio.js';
import { resolvePixelRatio } from '../../../shared/utils/pixel-ratio.js';
import { BufferCache } from '../../cache/buffer.js';
import type { OffsetUniforms, ShaderData } from '../../shaders/helpers.js';
import {
  calculateLngLatOffset,
  createProgram,
  getProjectionTransitionUniform,
  OFFSET_MODE_GLSL,
} from '../../shaders/helpers.js';
import { ProjectionUniformManager } from '../../shaders/projection.js';
import { anchorElevationMeters } from '../../terrain/anchor.js';
import { TerrainContext } from '../../terrain/context.js';
import { drawBillboardsWithoutDepth } from './billboard-depth.js';
import { samplePointShapeRings } from './point-sdf.js';

// The style types are defined in shared/ so that the configuration in shared/config can use them
export type { Color, PointShape, PointStyle } from '../../../shared/types/style.js';

/** Vertex data */
interface ShapeVertex {
  x: number;
  y: number;
}

// Number of segments that approximate a circle
const CIRCLE_SEGMENTS = RENDERING_DEFAULTS.CIRCLE_SEGMENTS;

/**
 * Generates the vertices of a normalized circle (for TRIANGLE_FAN)
 * A shape centered at (0,0) with radius 1
 */
function generateNormalizedCircleVertices(segments: number): ShapeVertex[] {
  const vertices: ShapeVertex[] = [];

  // Center point
  vertices.push({ x: 0, y: 0 });

  // Points on the outer edge
  for (let i = 0; i <= segments; i++) {
    const angle = (i / segments) * Math.PI * 2;
    vertices.push({
      x: Math.cos(angle),
      y: Math.sin(angle),
    });
  }

  return vertices;
}

/**
 * Generates the stroke vertices of a normalized circle (for TRIANGLE_STRIP)
 * Uses an inner radius and an outer radius
 */
function generateNormalizedCircleStrokeVertices(
  innerRadius: number,
  outerRadius: number,
  segments: number,
): ShapeVertex[] {
  const vertices: ShapeVertex[] = [];

  for (let i = 0; i <= segments; i++) {
    const angle = (i / segments) * Math.PI * 2;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);

    // Outside
    vertices.push({
      x: cos * outerRadius,
      y: sin * outerRadius,
    });

    // Inside
    vertices.push({
      x: cos * innerRadius,
      y: sin * innerRadius,
    });
  }

  return vertices;
}

/**
 * Generates the vertices of a normalized square (for TRIANGLE_FAN)
 */
function generateNormalizedSquareVertices(): ShapeVertex[] {
  return [
    { x: 0, y: 0 }, // center
    { x: -1, y: -1 }, // top-left
    { x: 1, y: -1 }, // top-right
    { x: 1, y: 1 }, // bottom-right
    { x: -1, y: 1 }, // bottom-left
    { x: -1, y: -1 }, // top-left (closing)
  ];
}

/**
 * Generates the stroke vertices of a normalized square
 */
function generateNormalizedSquareStrokeVertices(
  innerRadius: number,
  outerRadius: number,
): ShapeVertex[] {
  const vertices: ShapeVertex[] = [];

  const corners = [
    { x: -1, y: -1 }, // top-left
    { x: 1, y: -1 }, // top-right
    { x: 1, y: 1 }, // bottom-right
    { x: -1, y: 1 }, // bottom-left
  ];

  for (let i = 0; i <= 4; i++) {
    const corner = corners[i % 4];
    vertices.push({ x: corner.x * outerRadius, y: corner.y * outerRadius });
    vertices.push({ x: corner.x * innerRadius, y: corner.y * innerRadius });
  }

  return vertices;
}

/**
 * Generates the fill vertices of a shape normalized to the radius 1 (for TRIANGLE_FAN)
 *
 * The circle and the square fill the radius. The triangle and the star are inscribed in the
 * outer edge (`outerRatio`) and fill the inside of the stroke band, the same boundaries the
 * instanced renderer draws with its distance function. `'icon'` is drawn as a circle.
 */
function generateFillVertices(shape: PointShape, outerRatio: number): ShapeVertex[] {
  switch (shape) {
    case 'square':
      return generateNormalizedSquareVertices();
    case 'triangle':
    case 'star': {
      const { inner } = samplePointShapeRings(shape, outerRatio, outerRatio - 1);
      const ring = inner.map(([x, y]) => ({ x, y }));
      return [{ x: 0, y: 0 }, ...ring, ring[0]];
    }
    default:
      return generateNormalizedCircleVertices(CIRCLE_SEGMENTS);
  }
}

/**
 * Generates the stroke vertices of a shape normalized to the radius 1 (for TRIANGLE_STRIP)
 *
 * The stroke is the band between the radius and the outer edge (`outerRatio`); for the triangle
 * and the star, the band of the stroke width inside the outer edge.
 */
function generateStrokeVertices(shape: PointShape, outerRatio: number): ShapeVertex[] {
  switch (shape) {
    case 'square':
      return generateNormalizedSquareStrokeVertices(1, outerRatio);
    case 'triangle':
    case 'star': {
      const rings = samplePointShapeRings(shape, outerRatio, outerRatio - 1);
      const vertices: ShapeVertex[] = [];
      for (let i = 0; i <= rings.outer.length; i++) {
        const j = i % rings.outer.length;
        vertices.push({ x: rings.outer[j][0], y: rings.outer[j][1] });
        vertices.push({ x: rings.inner[j][0], y: rings.inner[j][1] });
      }
      return vertices;
    }
    default:
      return generateNormalizedCircleStrokeVertices(1, outerRatio, CIRCLE_SEGMENTS);
  }
}

/** Packs vertices into an interleaved Float32Array (x, y) */
function toVertexData(vertices: ShapeVertex[]): Float32Array {
  const data = new Float32Array(vertices.length * 2);
  for (let i = 0; i < vertices.length; i++) {
    data[i * 2] = vertices[i].x;
    data[i * 2 + 1] = vertices[i].y;
  }
  return data;
}

/**
 * The point renderer core uses for point markers (circles, squares, triangles and stars; the
 * shape `'icon'` is drawn as a circle), shared with custom feature renderers.
 *
 * Draws a billboard of a size in CSS px at a `[lng, lat]` position in degrees, converting to
 * clip space on the GPU. Call `ensureShader`, `setOffsetUniforms` and `setProjectionData`
 * before drawing.
 */
export class PointShapeRenderer {
  private gl: WebGL2RenderingContext;
  private program: WebGLProgram | null = null;
  private variantName = '';
  private bufferCache: BufferCache;

  // Projection uniform management
  private projectionUniformManager: ProjectionUniformManager;

  // Uniform locations (specific to this renderer)
  private colorLoc: WebGLUniformLocation | null = null;
  private pointLngLatLoc: WebGLUniformLocation | null = null;
  /** Uniform for the ground elevation of the anchor (meters) */
  private anchorElevationLoc: WebGLUniformLocation | null = null;
  private sizeClipLoc: WebGLUniformLocation | null = null;

  // ProjectionData
  private projectionData: ProjectionData | null = null;

  // Stores the uniforms for the offset mode
  private offsetUniforms: OffsetUniforms | null = null;

  /** Injected device pixel ratio (when not injected, it is read from window each time) */
  private pixelRatio: PixelRatioInput | undefined;
  /** The terrain state of the draw instance this renderer belongs to */
  private readonly terrain: TerrainContext;

  constructor(
    _map: MapLibreMap,
    gl: WebGL2RenderingContext,
    pixelRatio?: PixelRatioInput,
    terrain: TerrainContext = new TerrainContext(),
  ) {
    this.gl = gl;
    this.pixelRatio = pixelRatio;
    this.terrain = terrain;
    this.projectionUniformManager = new ProjectionUniformManager(gl, { terrain });
    this.bufferCache = new BufferCache(gl);
  }

  /**
   * Ensures the shader exists (recreating it when necessary)
   */
  ensureShader(shaderData: ShaderData): void {
    if (this.variantName === shaderData.variantName) return;

    if (this.program) {
      this.gl.deleteProgram(this.program);
    }

    this.program = this.createShaderProgram(shaderData.vertexShaderPrelude, shaderData.define);
    this.variantName = shaderData.variantName;

    // Get the projection uniform locations
    this.projectionUniformManager.getLocations(this.program);

    // Get the uniform locations specific to this renderer
    this.colorLoc = this.gl.getUniformLocation(this.program, 'u_color');
    this.pointLngLatLoc = this.gl.getUniformLocation(this.program, 'u_point_offset');
    this.anchorElevationLoc = this.gl.getUniformLocation(this.program, 'u_anchor_elevation_m');
    this.sizeClipLoc = this.gl.getUniformLocation(this.program, 'u_size_clip');
  }

  /**
   * Sets the uniforms for the offset mode
   */
  setOffsetUniforms(uniforms: OffsetUniforms): void {
    this.offsetUniforms = uniforms;
  }

  /**
   * Creates the shader program (offset mode)
   */
  private createShaderProgram(prelude: string, define: string): WebGLProgram {
    const projTransitionUniform = getProjectionTransitionUniform(prelude);
    // Vertex shader:
    // - a_offset: the normalized offset (a vertex of the shape)
    // - u_point_offset: the relative coordinates of the point (the offset from the center,
    //   computed with 64-bit precision on the CPU side)
    // - u_size_clip: the size in clip space
    const vertexSource = `#version 300 es
${prelude}
${define}
${projTransitionUniform}${OFFSET_MODE_GLSL}
in vec2 a_offset;
uniform vec2 u_point_offset;
uniform vec2 u_size_clip;
// Ground elevation of the anchor (meters). It comes from the same source as hit testing (CPU)
uniform float u_anchor_elevation_m;
void main() {
    // The elevation is not sampled from the DEM atlas; the value passed by the CPU is used as is
    // (two sources make the drawn position and the hit area disagree)
    g_anchor_elevation_m = u_anchor_elevation_m;
    g_anchor_elevation_on = 1.0;

    // Offset mode: uses the relative coordinates computed with 64-bit precision on the CPU side
    vec4 centerClip = project_position_to_clipspace_from_offset(u_point_offset, u_projection_matrix);

    // Convert to NDC coordinates and then apply the offset
    vec3 centerNDC = centerClip.xyz / centerClip.w;

    // Scale the offset by the size in clip space (applied in NDC space)
    vec2 offsetNDC = a_offset * u_size_clip;

    // Center + offset (in NDC space, w=1)
    gl_Position = vec4(centerNDC.xy + offsetNDC, centerNDC.z, 1.0);
}`;

    const fragmentSource = `#version 300 es
precision highp float;
uniform vec4 u_color;
out vec4 fragColor;
void main() {
    fragColor = u_color;
}`;

    return createProgram(this.gl, vertexSource, fragmentSource);
  }

  /**
   * Sets the projection uniforms (supporting the offset mode and the globe mode)
   * @param zoom The current zoom level (used to switch the offset mode)
   */
  private setProjectionUniforms(zoom: number): void {
    if (!this.projectionData) return;
    this.projectionUniformManager.setUniforms(this.projectionData, zoom, this.offsetUniforms);
  }

  /**
   * Converts a size in pixels to a size in clip space
   *
   * CSS pixels are converted to device pixels first, and then to clip space. The viewport covers
   * the drawing buffer (in device pixels), so the pixel ratio has to be taken into account.
   */
  private pixelsToClipSize(pixels: number): { x: number; y: number } {
    // Convert CSS pixels to device pixels
    const dpr = resolvePixelRatio(this.pixelRatio);
    const physicalPixels = pixels * dpr;
    // Convert device pixels to clip space (the drawing buffer is what the viewport covers)
    return {
      x: (physicalPixels / this.gl.drawingBufferWidth) * 2,
      y: (physicalPixels / this.gl.drawingBufferHeight) * 2,
    };
  }

  /**
   * Sets the ProjectionData
   */
  setProjectionData(projectionData: ProjectionData): void {
    this.projectionData = projectionData;
  }

  /**
   * Draws a point
   * @param coord The coordinates [lng, lat]
   * @param style The point style
   * @param zoom The current zoom level
   * @param featureId The feature ID (optional)
   */
  draw(
    coord: [number, number],
    style: PointStyle,
    zoom: number,
    featureId?: string,
    /**
     * The elevation to place it at (meters). When omitted, the ground elevation is used
     *
     * The four corners of the selection box and the rotation handle are placed at the same
     * single height as the box. Picking up the ground height for each of them makes them look as
     * if they float above or sink below the box (billboard).
     */
    elevationMeters?: number,
  ): void {
    if (!this.program || !this.projectionData) return;

    const gl = this.gl;
    const [lng, lat] = coord;

    // Convert the size to clip space
    const radiusClip = this.pixelsToClipSize(style.size / 2);
    // Ratio of the outer edge (radius + stroke width) to the radius. The vertices are normalized
    // to the radius, and the outer edge is the circumradius of the shape
    const radiusPx = style.size / 2;
    const outerRatio = radiusPx > 0 ? (radiusPx + Math.max(0, style.strokeWidth)) / radiusPx : 1;

    gl.useProgram(this.program);

    // Set the projection uniforms
    this.setProjectionUniforms(zoom);

    // Compute the relative coordinates on the CPU side (offset mode: 64-bit precision)
    const centerLngLat: [number, number] = this.offsetUniforms?.centerLngLat ?? [0, 0];
    const pointOffset = calculateLngLatOffset([lng, lat], centerLngLat);

    // Set the relative coordinates
    if (this.pointLngLatLoc) {
      gl.uniform2f(this.pointLngLatLoc, pointOffset[0], pointOffset[1]);
    }

    // Ground elevation of the anchor. It is taken from the same function that hit testing
    // (createCoordinateTransform) goes through, so the drawn position and the hit area match
    // structurally. When terrain is disabled it returns 0, giving the same result as before
    // terrain was introduced.
    if (this.anchorElevationLoc) {
      gl.uniform1f(
        this.anchorElevationLoc,
        elevationMeters ?? anchorElevationMeters(this.terrain, lng, lat),
      );
    }

    // Billboards are drawn without the depth test (see the note in billboard-depth.ts). A
    // hand-drawn Point can arrive here through a CustomFeatureRenderer, so wrapping only the
    // instanced side would leave the points of this path as half circles.
    drawBillboardsWithoutDepth(gl, () => {
      // Draw the fill
      if (style.fillOpacity > 0) {
        this.drawFill(radiusClip.x, radiusClip.y, outerRatio, style, featureId);
      }

      // Draw the stroke
      if (style.strokeOpacity > 0 && style.strokeWidth > 0) {
        this.drawStroke(radiusClip.x, radiusClip.y, outerRatio, style, featureId);
      }
    });
  }

  /**
   * Draws the fill
   * The shape geometry is normalized, so it can be cached by shape type (and, for the triangle
   * and the star, whose fill is the inside of the stroke band, by the outer ratio)
   */
  private drawFill(
    radiusX: number,
    radiusY: number,
    outerRatio: number,
    style: PointStyle,
    featureId?: string,
  ): void {
    const gl = this.gl;

    // Set the size
    if (this.sizeClipLoc) {
      gl.uniform2f(this.sizeClipLoc, radiusX, radiusY);
    }

    // Set the color
    const color = [
      style.fillColor[0],
      style.fillColor[1],
      style.fillColor[2],
      style.fillColor[3] * style.fillOpacity,
    ];
    if (this.colorLoc) {
      gl.uniform4fv(this.colorLoc, color);
    }

    const insetShape = style.shape === 'triangle' || style.shape === 'star';
    const outerRatioKey = Math.round(outerRatio * 100);
    // Cache key: the shape type only (the shape is normalized, so it does not depend on the
    // position or the size), plus the outer ratio for the shapes whose fill depends on it
    const geometryHash = insetShape ? `${style.shape}:${outerRatioKey}` : style.shape;
    const cacheKey = featureId ? `point:fill:${geometryHash}` : null;

    this.drawShapeGeometry(
      cacheKey,
      geometryHash,
      gl.TRIANGLE_FAN,
      (ratio) => generateFillVertices(style.shape, ratio),
      featureId ? outerRatioKey / 100 : outerRatio,
    );
  }

  /**
   * Draws the stroke
   * The stroke geometry depends on outerRatio, so it is cached by shape type + outerRatio
   */
  private drawStroke(
    radiusX: number,
    radiusY: number,
    outerRatio: number,
    style: PointStyle,
    featureId?: string,
  ): void {
    const gl = this.gl;

    // Set the size (uses the same radius as the fill)
    if (this.sizeClipLoc) {
      gl.uniform2f(this.sizeClipLoc, radiusX, radiusY);
    }

    // Set the color
    const color = [
      style.strokeColor[0],
      style.strokeColor[1],
      style.strokeColor[2],
      style.strokeColor[3] * style.strokeOpacity,
    ];
    if (this.colorLoc) {
      gl.uniform4fv(this.colorLoc, color);
    }

    // Cache key: the shape type + outerRatio (rounded to two decimal places)
    const outerRatioKey = Math.round(outerRatio * 100);
    const geometryHash = `${style.shape}:${outerRatioKey}`;
    const cacheKey = featureId ? `point:stroke:${geometryHash}` : null;

    this.drawShapeGeometry(
      cacheKey,
      geometryHash,
      gl.TRIANGLE_STRIP,
      (ratio) => generateStrokeVertices(style.shape, ratio),
      featureId ? outerRatioKey / 100 : outerRatio,
    );
  }

  /**
   * Draws normalized shape vertices, through the buffer cache when a cache key is given and with
   * a transient buffer otherwise
   */
  private drawShapeGeometry(
    cacheKey: string | null,
    geometryHash: string,
    drawMode: number,
    build: (outerRatio: number) => ShapeVertex[],
    outerRatio: number,
  ): void {
    const gl = this.gl;

    if (cacheKey) {
      const geometry = this.bufferCache.getOrCreate(cacheKey, geometryHash, () => {
        const vertices = build(outerRatio);
        return {
          vertices: toVertexData(vertices),
          vertexCount: vertices.length,
          drawMode,
          stride: 8,
          attributes: [{ index: 0, size: 2, offset: 0 }],
        };
      });

      gl.bindVertexArray(geometry.vao);
      gl.drawArrays(geometry.drawMode, 0, geometry.vertexCount);
      gl.bindVertexArray(null);
      return;
    }

    // No cache (a transient draw)
    const vertices = build(outerRatio);
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);

    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, toVertexData(vertices), gl.STATIC_DRAW);

    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    gl.drawArrays(drawMode, 0, vertices.length);

    gl.bindVertexArray(null);
    gl.deleteBuffer(buffer);
    gl.deleteVertexArray(vao);
  }

  /**
   * Disposes of the resources
   *
   * @internal
   */
  dispose(): void {
    if (this.program) {
      this.gl.deleteProgram(this.program);
      this.program = null;
    }
    this.bufferCache.dispose();
  }
}
