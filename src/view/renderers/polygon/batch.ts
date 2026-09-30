// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * PolygonBatchRenderer
 *
 * A renderer that draws multiple polygon fills in a single draw call.
 * By using per-vertex color, polygons of different colors can also be drawn in one go.
 * The draw order is preserved by the order in which the vertices are laid out.
 */

import earcut from 'earcut';
import type { ProjectionData } from 'maplibre-gl';

import type { Coordinate } from '../../../store/types.js';
import { EarcutCache } from '../../cache/earcut.js';
import { getSurfaceTessellationStep, tessellateSurfaceFill } from '../../globe-subdivision.js';
import type { OffsetUniforms, ShaderData } from '../../shaders/helpers.js';
import {
  calculateLngLatOffset,
  createProgram,
  getProjectionTransitionUniform,
  OFFSET_MODE_GLSL,
} from '../../shaders/helpers.js';
import { ProjectionUniformManager } from '../../shaders/projection.js';
import {
  TERRAIN_SHADE_FRAGMENT_GLSL,
  TERRAIN_SHADE_VERTEX_GLSL,
} from '../../shaders/terrain-shade.js';
import { TerrainContext } from '../../terrain/context.js';
import { TERRAIN_MAX_TILED_COARSEN } from '../../terrain/metrics.js';
import { batchTessellationFactor, ringBoundingCells } from '../../terrain/polygon.js';
import { reportTerrainCoarsening } from '../../terrain/state.js';

import { buildEarcutInput } from './earcut-input.js';
import { drawFillWithTerrainCull } from './terrain-cull.js';

/** The color type */
export type Color = [number, number, number, number];

/** Polygon data for a batch */
export interface PolygonBatchData {
  coordinates: Coordinate[][]; // array of rings ([0] is the outer ring, [1..] are inner rings)
  color: Color;
  featureId?: string; // the feature ID used for caching
  /** The part number used for caching (a part of a MultiPolygon; omitted = 0 for a
   * single polygon) */
  partIndex?: number;
}

/**
 * PolygonBatchRenderer
 */
/**
 * The state of the draw instance a polygon renderer belongs to
 */
export interface PolygonRendererScope {
  /** The terrain state (an inactive one draws flat) */
  terrain?: TerrainContext;
  /** Triangulation results keyed by feature id (a private cache when omitted) */
  earcut?: EarcutCache;
}

/** @internal */
export class PolygonBatchRenderer {
  private gl: WebGL2RenderingContext;
  /** The terrain state of the draw instance */
  private readonly terrain: TerrainContext;
  /** Triangulation results of the draw instance, keyed by feature id */
  private readonly earcutCache: EarcutCache;
  private program: WebGLProgram | null = null;
  private variantName = '';

  // Projection uniform management
  private projectionUniformManager: ProjectionUniformManager;

  // Stores the offset uniforms
  private offsetUniforms: OffsetUniforms | null = null;

  // Buffers for the batch
  private vertexBuffer: WebGLBuffer | null = null;
  private indexBuffer: WebGLBuffer | null = null;
  private vao: WebGLVertexArrayObject | null = null;

  constructor(gl: WebGL2RenderingContext, scope: PolygonRendererScope = {}) {
    this.gl = gl;
    this.terrain = scope.terrain ?? new TerrainContext();
    this.earcutCache = scope.earcut ?? new EarcutCache();
    this.projectionUniformManager = new ProjectionUniformManager(gl, {
      surface: true,
    }).useTerrainState(this.terrain);
    this.vertexBuffer = gl.createBuffer();
    this.indexBuffer = gl.createBuffer();
    this.vao = gl.createVertexArray();
  }

  /**
   * Ensures the shader (recreating it when necessary)
   */
  ensureShader(shaderData: ShaderData): void {
    if (this.variantName !== shaderData.variantName) {
      if (this.program) {
        this.gl.deleteProgram(this.program);
      }

      this.program = this.createShaderProgram(shaderData.vertexShaderPrelude, shaderData.define);
      this.variantName = shaderData.variantName;

      // Get the projection uniform locations
      this.projectionUniformManager.getLocations(this.program);

      // Set up the VAO
      this.setupVAO();
    }
  }

  /**
   * Sets the uniforms for offset mode
   */
  setOffsetUniforms(uniforms: OffsetUniforms): void {
    this.offsetUniforms = uniforms;
  }

  /**
   * Creates the shader program (supporting per-vertex color, offset mode)
   */
  private createShaderProgram(prelude: string, define: string): WebGLProgram {
    const projTransitionUniform = getProjectionTransitionUniform(prelude);
    const vertexSource = `#version 300 es
${prelude}
${define}
${projTransitionUniform}${OFFSET_MODE_GLSL}${TERRAIN_SHADE_VERTEX_GLSL}
layout(location = 0) in vec2 a_pos;      // relative coords (64-bit precision on the CPU)
layout(location = 1) in vec4 a_color;    // per-vertex color

out vec4 v_color;

void main() {
    // High precision version: uses relative coords computed at 64-bit precision on the CPU
    gl_Position = project_position_to_clipspace_from_offset(a_pos, u_projection_matrix);
    v_color = a_color;
    emitShadeOffset(a_pos);
}`;

    // The fill gets the same terrain shading as the ground (factor 1.0 when there is no terrain)
    const fragmentSource = `#version 300 es
precision highp float;

in vec4 v_color;
out vec4 fragColor;
${TERRAIN_SHADE_FRAGMENT_GLSL}
void main() {
    fragColor = vec4(v_color.rgb * terrainFillShade(), v_color.a);
}`;

    return createProgram(this.gl, vertexSource, fragmentSource);
  }

  /**
   * Sets up the VAO
   */
  private setupVAO(): void {
    const gl = this.gl;

    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);

    // stride: pos(2) + color(4) = 6 floats = 24 bytes
    const stride = 24;

    // a_pos: location 0
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, stride, 0);

    // a_color: location 1
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, stride, 8);

    // The ELEMENT_ARRAY_BUFFER binding is part of the VAO state
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);

    gl.bindVertexArray(null);
  }

  /**
   * Sets the projection uniforms (supporting offset mode + globe mode)
   * @param projectionData MapLibre's ProjectionData
   * @param zoom The current zoom level (used for switching offset mode)
   */
  private setProjectionUniforms(projectionData: ProjectionData, zoom: number): void {
    this.projectionUniformManager.setUniforms(projectionData, zoom, this.offsetUniforms);
  }

  /**
   * Batch-draws multiple polygon fills
   *
   * @param polygons The array of polygon data (in draw order)
   * @param projectionData MapLibre's ProjectionData
   * @param zoom The current zoom level
   * @returns The number of indices drawn (for debugging)
   */
  drawBatch(polygons: PolygonBatchData[], projectionData: ProjectionData, zoom: number): number {
    if (!this.program || polygons.length === 0) return 0;

    const gl = this.gl;

    // Compute relative coordinates on the CPU side (offset mode: computed at 64-bit precision)
    const centerLngLat: [number, number] = this.offsetUniforms?.centerLngLat ?? [0, 0];

    const { vertexData, indexData } = this.buildGeometry(polygons, centerLngLat);
    if (indexData.length === 0) return 0;

    // Transfer the vertex data
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, vertexData, gl.DYNAMIC_DRAW);

    // Draw
    gl.useProgram(this.program);
    this.setProjectionUniforms(projectionData, zoom);

    gl.bindVertexArray(this.vao);
    // The ELEMENT_ARRAY_BUFFER binding is VAO state, so the transfer is done after
    // binding the VAO
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indexData, gl.DYNAMIC_DRAW);
    drawFillWithTerrainCull(gl, this.terrain, () => {
      gl.drawElements(gl.TRIANGLES, indexData.length, gl.UNSIGNED_INT, 0);
    });
    gl.bindVertexArray(null);

    return indexData.length;
  }

  /**
   * Builds the vertex array and index array of the batch
   *
   * The indices are laid out in the order of the input polygons, so the draw order
   * (z-order) is preserved.
   */
  private buildGeometry(
    polygons: PolygonBatchData[],
    centerLngLat: [number, number],
  ): { vertexData: Float32Array; indexData: Uint32Array } {
    // Pass 1: collect the triangulation results and count the required array lengths
    const records: Array<{ flatCoords: number[]; indices: number[]; color: Color }> = [];
    let totalPoints = 0;
    let totalIndices = 0;

    // Subdivide on a grid only while terrain is active or the globe is drawn (on a flat map
    // without terrain it passes through as null)
    // The step is decided from the total across all features (the same criterion as
    // sdf-polygon)
    const terrainStep = getSurfaceTessellationStep(this.terrain, 'fill');
    let batchFactor = 1;
    if (terrainStep) {
      let totalCells = 0;
      for (const polygon of polygons) {
        const outer = polygon.coordinates[0];
        if (outer) totalCells += ringBoundingCells(outer, terrainStep.grid, terrainStep.region);
      }
      batchFactor = batchTessellationFactor(totalCells);
      reportTerrainCoarsening(this.terrain, batchFactor);
    }

    for (const polygon of polygons) {
      // Flatten all rings to build the earcut input (inner rings are treated as holes)
      const { flatCoords, holeIndices, rings } = buildEarcutInput(polygon.coordinates);
      if (rings.length === 0) continue;

      // Triangulate with earcut (making use of the cache)
      let indices: number[];
      if (polygon.featureId) {
        // Try to get it from the cache
        const partIndex = polygon.partIndex ?? 0;
        const cached = this.earcutCache.get(polygon.featureId, partIndex);
        if (cached) {
          indices = cached;
        } else {
          indices = earcut(flatCoords, holeIndices);
          this.earcutCache.set(polygon.featureId, indices, partIndex);
        }
      } else {
        // When there is no featureId, run it without the cache
        indices = earcut(flatCoords, holeIndices);
      }

      if (indices.length === 0) continue;

      const tessellated = terrainStep
        ? tessellateSurfaceFill(
            this.terrain,
            polygon.featureId,
            polygon.partIndex ?? 0,
            flatCoords,
            indices,
            {
              // While aligned to the actual tile mesh, do not move the step and pass only
              // the coarsening factor (so it keeps riding on a subset of the mesh nodes)
              grid: terrainStep.tiling ? terrainStep.grid : terrainStep.grid * batchFactor,
              maxPoints: terrainStep.maxPoints,
              region: terrainStep.region,
              tiling: terrainStep.tiling,
              coarsen: terrainStep.tiling
                ? Math.min(batchFactor, TERRAIN_MAX_TILED_COARSEN)
                : undefined,
            },
          )
        : { flatCoords, indices };

      records.push({
        flatCoords: tessellated.flatCoords,
        indices: tessellated.indices,
        color: polygon.color,
      });
      totalPoints += tessellated.flatCoords.length / 2;
      totalIndices += tessellated.indices.length;
    }

    // Pass 2: write directly into the typed arrays
    const vertexData = new Float32Array(totalPoints * 6);
    const indexData = new Uint32Array(totalIndices);
    let base = 0;
    let indexOffset = 0;

    for (const { flatCoords, indices, color } of records) {
      const pointCount = flatCoords.length / 2;

      for (let i = 0; i < pointCount; i++) {
        // Compute the offset from the center at 64-bit precision
        const offset = calculateLngLatOffset(
          [flatCoords[i * 2], flatCoords[i * 2 + 1]],
          centerLngLat,
        );
        const at = (base + i) * 6;
        vertexData[at] = offset[0];
        vertexData[at + 1] = offset[1];
        vertexData[at + 2] = color[0];
        vertexData[at + 3] = color[1];
        vertexData[at + 4] = color[2];
        vertexData[at + 5] = color[3];
      }

      for (let i = 0; i < indices.length; i++) {
        indexData[indexOffset + i] = indices[i] + base;
      }

      base += pointCount;
      indexOffset += indices.length;
    }

    return { vertexData, indexData };
  }

  /**
   * Disposes of the resources
   */
  dispose(): void {
    const gl = this.gl;

    if (this.program) {
      gl.deleteProgram(this.program);
      this.program = null;
    }
    if (this.vertexBuffer) {
      gl.deleteBuffer(this.vertexBuffer);
      this.vertexBuffer = null;
    }
    if (this.indexBuffer) {
      gl.deleteBuffer(this.indexBuffer);
      this.indexBuffer = null;
    }
    if (this.vao) {
      gl.deleteVertexArray(this.vao);
      this.vao = null;
    }
  }
}
