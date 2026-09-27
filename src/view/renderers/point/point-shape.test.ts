// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests that the per-point shape renderer (PointShapeRenderer) draws billboards without the
 * depth test.
 *
 * A hand-drawn Point may be taken over by a FeatureTypeRenderer and arrive on this path.
 * When only the instanced side (point-instance) was wrapped, hand-drawn points alone were eaten
 * by the terrain and stayed as half circles. Here, that the depth test is always disabled during
 * the draw calls, and that the original state is restored once drawing is finished, are verified
 * with a record of the GL calls.
 */

import type { Map as MapLibreMap, ProjectionData } from 'maplibre-gl';
import { describe, expect, it } from 'vitest';
import { syncDepthTestEnabled } from '../../layer/depth-state.js';
import type { ShaderData } from '../../shaders/helpers.js';
import { STAR_INNER_RATIO } from './point-sdf.js';
import { type PointShape, PointShapeRenderer } from './point-shape.js';

const DEPTH_TEST = 2929;

interface Recording {
  gl: WebGL2RenderingContext;
  /** Whether the depth test was enabled at draw time (per draw call) */
  depthAtDraw: boolean[];
  /** History of enable/disable */
  log: string[];
  drawCount: () => number;
}

function createRecordingGL(depthInitiallyEnabled: boolean): Recording {
  let depthEnabled = depthInitiallyEnabled;
  const depthAtDraw: boolean[] = [];
  const log: string[] = [];
  let draws = 0;

  const noteDraw = (): void => {
    draws++;
    depthAtDraw.push(depthEnabled);
  };

  const gl = {
    canvas: { width: 800, height: 600 },
    drawingBufferWidth: 800,
    drawingBufferHeight: 600,

    ARRAY_BUFFER: 1,
    STATIC_DRAW: 2,
    DYNAMIC_DRAW: 3,
    FLOAT: 5,
    TRIANGLE_STRIP: 16,
    TRIANGLE_FAN: 17,
    TRIANGLES: 18,
    VERTEX_SHADER: 20,
    FRAGMENT_SHADER: 21,
    COMPILE_STATUS: 22,
    LINK_STATUS: 23,
    DEPTH_TEST,

    isEnabled: (cap: number) => (cap === DEPTH_TEST ? depthEnabled : false),
    enable: (cap: number) => {
      if (cap === DEPTH_TEST) {
        depthEnabled = true;
        log.push('enable');
      }
    },
    disable: (cap: number) => {
      if (cap === DEPTH_TEST) {
        depthEnabled = false;
        log.push('disable');
      }
    },

    createBuffer: () => ({ kind: 'buffer' }),
    deleteBuffer: () => {},
    createVertexArray: () => ({ kind: 'vao' }),
    deleteVertexArray: () => {},

    createShader: () => ({ kind: 'shader' }),
    shaderSource: () => {},
    compileShader: () => {},
    getShaderParameter: () => true,
    getShaderInfoLog: () => '',
    deleteShader: () => {},
    createProgram: () => ({ kind: 'program' }),
    attachShader: () => {},
    linkProgram: () => {},
    getProgramParameter: () => true,
    getProgramInfoLog: () => '',
    deleteProgram: () => {},
    useProgram: () => {},
    getUniformLocation: (_p: unknown, name: string) => ({ name }),

    bindBuffer: () => {},
    bufferData: () => {},
    bindVertexArray: () => {},
    enableVertexAttribArray: () => {},
    vertexAttribPointer: () => {},
    vertexAttribDivisor: () => {},

    uniform1f: () => {},
    uniform1i: () => {},
    uniform2f: () => {},
    uniform2fv: () => {},
    uniform3fv: () => {},
    uniform4fv: () => {},
    uniform4f: () => {},
    uniformMatrix4fv: () => {},

    drawArrays: () => noteDraw(),
    drawArraysInstanced: () => noteDraw(),
    drawElements: () => noteDraw(),
  } as unknown as WebGL2RenderingContext;

  return { gl, depthAtDraw, log, drawCount: () => draws };
}

const SHADER_DATA: ShaderData = {
  variantName: 'test',
  vertexShaderPrelude: '',
  define: '',
} as unknown as ShaderData;

const PROJECTION_DATA = {
  mainMatrix: new Float64Array(16),
  tileMercatorCoords: [0, 0, 1, 1],
  clippingPlane: [0, 0, 0, 0],
  projectionTransition: 0,
  fallbackMatrix: new Float64Array(16),
} as unknown as ProjectionData;

/**
 * Aligns the depth record with the actual state at the beginning of a frame
 *
 * In real use the CustomLayer does this every frame. The symbol renderers do not call
 * `gl.isEnabled`; they read this record to restore the original state (see the reasoning in
 * depth-state.ts).
 */
function beginFrame(gl: WebGL2RenderingContext): void {
  syncDepthTestEnabled(gl);
}

function drawOnce(
  gl: WebGL2RenderingContext,
  shape: PointShape = 'circle',
  featureId?: string,
): void {
  const renderer = new PointShapeRenderer({} as unknown as MapLibreMap, gl, 1);
  renderer.ensureShader(SHADER_DATA);
  renderer.setProjectionData(PROJECTION_DATA);
  renderer.draw(
    [139.7, 35.68],
    {
      shape,
      size: 20,
      fillColor: [1, 0, 0, 1],
      fillOpacity: 1,
      strokeColor: [0, 0, 0, 1],
      strokeOpacity: 1,
      strokeWidth: 2,
    } as Parameters<PointShapeRenderer['draw']>[1],
    12,
    featureId,
  );
}

describe('depth test of PointShapeRenderer', () => {
  it('draws billboards without the depth test even when terrain has it enabled', () => {
    const rec = createRecordingGL(true);
    beginFrame(rec.gl);
    drawOnce(rec.gl);

    expect(rec.drawCount()).toBeGreaterThan(0);
    // The depth test must never be enabled during the draw calls.
    // If it stayed enabled, the lower half of the billboard would be buried in the ground and
    // the point would become a half circle.
    expect(rec.depthAtDraw.every((enabled) => enabled === false)).toBe(true);
    // Once drawing is finished it is restored (polygons and lines must be hidden correctly by
    // the depth of the terrain).
    expect(rec.gl.isEnabled(DEPTH_TEST)).toBe(true);
    expect(rec.log).toEqual(['disable', 'enable']);
  });

  it('does not touch the GL state with no terrain (depth test disabled from the start)', () => {
    const rec = createRecordingGL(false);
    beginFrame(rec.gl);
    drawOnce(rec.gl);

    expect(rec.drawCount()).toBeGreaterThan(0);
    expect(rec.log).toEqual([]);
    expect(rec.gl.isEnabled(DEPTH_TEST)).toBe(false);
  });
});

/** Draws one point of a shape and returns the vertex arrays uploaded (fill first, then stroke) */
function uploadedVertices(shape: PointShape, featureId?: string): Array<Array<[number, number]>> {
  const rec = createRecordingGL(false);
  const uploads: Array<Array<[number, number]>> = [];
  (rec.gl as unknown as { bufferData: (t: number, data: Float32Array) => void }).bufferData = (
    _t,
    data,
  ) => {
    const vertices: Array<[number, number]> = [];
    for (let i = 0; i < data.length; i += 2) vertices.push([data[i], data[i + 1]]);
    uploads.push(vertices);
  };
  beginFrame(rec.gl);
  drawOnce(rec.gl, shape, featureId);
  return uploads;
}

describe('shapes of PointShapeRenderer', () => {
  // size 20 and stroke 2: the outer edge is at 1.2 times the radius, the stroke is 0.2 deep
  it('draws the triangle with a vertex pointing up, inscribed in the outer radius', () => {
    for (const featureId of [undefined, 'f1']) {
      const [fill, stroke] = uploadedVertices('triangle', featureId);
      // Fan: the center, three vertices and the closing vertex
      expect(fill).toHaveLength(5);
      // The fill is the inside of the stroke band (the apex moves in by twice the stroke)
      expect(fill[1][0]).toBeCloseTo(0, 6);
      expect(fill[1][1]).toBeCloseTo(0.8, 6);
      // Strip: outer and inner pairs for the three vertices and the closing pair
      expect(stroke).toHaveLength(8);
      expect(stroke[0][1]).toBeCloseTo(1.2, 6);
      expect(stroke[1][1]).toBeCloseTo(0.8, 6);
    }
  });

  it('draws the star with ten vertices, its tips on the outer radius', () => {
    const [fill, stroke] = uploadedVertices('star');
    const outer = stroke.filter((_, i) => i % 2 === 0).map(([x, y]) => Math.hypot(x, y));
    expect(Math.max(...outer)).toBeCloseTo(1.2, 6);
    // The inner vertices of the pentagram
    expect(Math.min(...outer)).toBeCloseTo(1.2 * STAR_INNER_RATIO, 6);
    expect(fill.length).toBeGreaterThan(11);
    expect(stroke[0][0]).toBeCloseTo(0, 6);
    expect(stroke[0][1]).toBeCloseTo(1.2, 6);
  });

  it('keeps drawing the icon shape as a circle', () => {
    const [iconFill] = uploadedVertices('icon');
    const [circleFill] = uploadedVertices('circle');
    expect(iconFill).toEqual(circleFill);
  });
});
