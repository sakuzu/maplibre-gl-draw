// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for the single-pass rendering of points (completing the fill and the stroke in one draw)
 *
 * So that overlapping points do not produce a picture where the stroke of a farther point is
 * laid over the fill of a nearer point, a point is completed in one instance and one draw, and
 * the instance order is handed to the GPU as the feature order. Here,
 *
 * - that both the immediate mode and the retained mode issue exactly one draw call
 * - that the order of the instance array is exactly the order of the input (the features)
 * - that points without a stroke also ride on the same instance array
 * - the computation of the SDF radius and stroke boundaries
 *
 * are verified with a record of the GL calls and with pure functions. The rendered result itself
 * is out of scope.
 */

import type { Map as MapLibreMap, ProjectionData } from 'maplibre-gl';
import { describe, expect, it } from 'vitest';
import type { ShaderData } from '../../shaders/helpers.js';
import type { PointInstanceDataFull } from './point-instance.js';
import {
  buildPointInstanceData,
  POINT_AA_PADDING_PX,
  POINT_MIN_OUTER_PX,
  PointInstanceRenderer,
  pointInkFactor,
  pointSdfEdges,
} from './point-instance.js';

/** A recorded GL call */
interface GLCall {
  name: string;
  args: unknown[];
}

/** A mock GL that records the calls */
interface RecordingGL {
  gl: WebGL2RenderingContext;
  calls: (name: string) => GLCall[];
  /** The arrays uploaded to ARRAY_BUFFER */
  uploads: () => Float32Array[];
  reset: () => void;
}

const GL_CONSTANTS = {
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
} as const;

function createRecordingGL(): RecordingGL {
  let calls: GLCall[] = [];
  const record = (name: string, ...args: unknown[]): void => {
    calls.push({ name, args });
  };

  const gl = {
    canvas: { width: 800, height: 600 },
    drawingBufferWidth: 800,
    drawingBufferHeight: 600,

    ...GL_CONSTANTS,

    // Point billboards are drawn with the depth test disabled (drawBillboardsWithoutDepth in
    // point-instance).
    DEPTH_TEST: 2929,
    isEnabled: () => false,
    enable: () => {},
    disable: () => {},

    createBuffer: () => ({ kind: 'buffer' }),
    deleteBuffer: () => {},
    createVertexArray: () => ({ kind: 'vao' }),
    deleteVertexArray: () => {},

    createShader: () => ({ kind: 'shader' }),
    shaderSource: (_s: unknown, source: string) => record('shaderSource', source),
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
    useProgram: () => record('useProgram'),
    getUniformLocation: (_p: unknown, name: string) => ({ name }),

    bindBuffer: () => {},
    bufferData: (target: number, data: unknown, usage: number) =>
      record('bufferData', target, data, usage),
    bindVertexArray: () => {},
    enableVertexAttribArray: () => {},
    vertexAttribPointer: (...args: unknown[]) => record('vertexAttribPointer', ...args),
    vertexAttribDivisor: () => {},

    uniform1f: (loc: { name: string } | null, x: number) => record('uniform1f', loc?.name, x),
    // The projection uniforms are written by the shared ProjectionUniformManager (the terrain
    // sampler number is uniform1i)
    uniform1i: () => {},
    uniform2f: () => {},
    uniform2fv: () => {},
    uniform3fv: () => {},
    uniform4fv: () => {},
    uniform4f: () => {},
    uniformMatrix4fv: () => {},

    drawArrays: (...args: unknown[]) => record('drawArrays', ...args),
    drawArraysInstanced: (...args: unknown[]) => record('drawArraysInstanced', ...args),
    drawElements: (...args: unknown[]) => record('drawElements', ...args),
  } as unknown as WebGL2RenderingContext;

  return {
    gl,
    calls: (name: string) => calls.filter((call) => call.name === name),
    uploads: () =>
      calls
        .filter((call) => call.name === 'bufferData')
        .map((call) => call.args[1] as Float32Array),
    reset: () => {
      calls = [];
    },
  };
}

const SHADER_DATA: ShaderData = {
  vertexShaderPrelude: 'vec4 projectTile(vec2 p) { return vec4(p, 0.0, 1.0); }',
  define: '',
  variantName: 'mercator',
};

/** projectionData with an identity matrix */
function createProjectionData(): ProjectionData {
  const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  return {
    mainMatrix: identity,
    tileMercatorCoords: [0, 0, 1, 1],
    clippingPlane: [0, 0, 0, 0],
    projectionTransition: 0,
    fallbackMatrix: identity,
  } as unknown as ProjectionData;
}

/** Three points from back to front (made distinguishable by color) */
const POINTS: PointInstanceDataFull[] = [
  {
    coord: [0, 0],
    fillColor: [1, 0, 0, 1],
    fillSize: 6,
    strokeColor: [1, 1, 1, 1],
    strokeWidth: 2,
  },
  {
    coord: [1, 0],
    fillColor: [0, 1, 0, 1],
    fillSize: 5,
    // A point without a stroke (it can be drawn while mixed into the same single draw)
    strokeColor: [1, 1, 1, 1],
    strokeWidth: 0,
  },
  {
    coord: [2, 0],
    fillColor: [0, 0, 1, 1],
    fillSize: 4,
    strokeColor: [1, 1, 1, 1],
    strokeWidth: 3,
  },
];

/** Floats per instance (position 2 + colors 8 + sizes 2 + elevation 1) */
const STRIDE = 13;

/** Extracts the uploaded instance array (the one that is not the 8 floats of the billboard) */
function instanceUpload(mock: RecordingGL): Float32Array {
  const uploaded = mock
    .uploads()
    .filter((data) => data.length % STRIDE === 0 && data.length >= STRIDE);
  return uploaded[0];
}

function createRenderer(mock: RecordingGL): PointInstanceRenderer {
  const renderer = new PointInstanceRenderer({} as MapLibreMap, mock.gl, 1);
  renderer.ensureShader(SHADER_DATA);
  renderer.setProjectionData(createProjectionData());
  return renderer;
}

describe('single-pass rendering of points', () => {
  it('completes the fill and the stroke in one draw in the immediate mode', () => {
    const mock = createRecordingGL();
    const renderer = createRenderer(mock);

    mock.reset();
    renderer.drawAll(POINTS, 'circle', 12);

    const draws = mock.calls('drawArraysInstanced');
    expect(draws).toHaveLength(1);
    // 4 vertices of the billboard (quad) x the number of points
    expect(draws[0].args).toEqual([GL_CONSTANTS.TRIANGLE_STRIP, 0, 4, POINTS.length]);
    // Nor does it switch programs between the fill and the stroke
    expect(mock.calls('useProgram')).toHaveLength(1);
  });

  it('also uses one draw in the retained mode, not splitting batches by stroke presence', () => {
    const mock = createRecordingGL();
    const renderer = createRenderer(mock);

    const batch = renderer.buildRetained(POINTS, 'circle', { origin: [0, 0] });
    if (!batch) throw new Error('batch');
    expect(batch.instanceCount).toBe(POINTS.length);

    mock.reset();
    renderer.drawRetained(batch, 12, createProjectionData());

    const draws = mock.calls('drawArraysInstanced');
    expect(draws).toHaveLength(1);
    expect(draws[0].args).toEqual([GL_CONSTANTS.TRIANGLE_STRIP, 0, 4, POINTS.length]);
    expect(mock.calls('useProgram')).toHaveLength(1);
  });

  it('orders the instances exactly as the input (the features)', () => {
    const mock = createRecordingGL();
    const renderer = createRenderer(mock);

    mock.reset();
    renderer.drawAll(POINTS, 'circle', 12);

    const data = instanceUpload(mock);
    expect(data).toHaveLength(POINTS.length * STRIDE);

    for (let i = 0; i < POINTS.length; i++) {
      const at = i * STRIDE;
      // Relative coordinates (the origin is [0, 0])
      expect(data[at]).toBe(POINTS[i].coord[0]);
      expect(data[at + 1]).toBe(POINTS[i].coord[1]);
      // Fill color -> stroke color -> radius -> stroke width
      expect(Array.from(data.slice(at + 2, at + 6))).toEqual(POINTS[i].fillColor);
      expect(Array.from(data.slice(at + 6, at + 10))).toEqual(POINTS[i].strokeColor);
      expect(data[at + 10]).toBe(POINTS[i].fillSize);
      expect(data[at + 11]).toBe(POINTS[i].strokeWidth);
    }
  });

  it('keeps the instance array of the retained mode in the input order as well', () => {
    const mock = createRecordingGL();
    const renderer = createRenderer(mock);

    mock.reset();
    renderer.buildRetained(POINTS, 'circle', { origin: [0, 0] });

    const data = instanceUpload(mock);
    expect(data).toHaveLength(POINTS.length * STRIDE);
    // The order is checked through the sequence of fill colors (red -> green -> blue)
    expect([data[2], data[STRIDE + 3], data[STRIDE * 2 + 4]]).toEqual([1, 1, 1]);
  });

  it('switches the shape with a uniform (circle 0 / square 1 / triangle 2 / star 3)', () => {
    const mock = createRecordingGL();
    const renderer = createRenderer(mock);

    mock.reset();
    renderer.drawAll(POINTS, 'circle', 12);
    renderer.drawAll(POINTS, 'square', 12);
    renderer.drawAll(POINTS, 'triangle', 12);
    renderer.drawAll(POINTS, 'star', 12);

    const shapeWrites = mock
      .calls('uniform1f')
      .filter((call) => call.args[0] === 'u_shape')
      .map((call) => call.args[1]);
    expect(shapeWrites).toEqual([0, 1, 2, 3]);
  });

  it('uses a single shader that receives both the fill and the stroke color as attributes', () => {
    const mock = createRecordingGL();
    createRenderer(mock);

    const sources = mock.calls('shaderSource').map((call) => call.args[0] as string);
    // Only two, the vertex and the fragment shader (not split into fill and stroke versions)
    expect(sources).toHaveLength(2);
    expect(sources[0]).toContain('a_instance_fill_color');
    expect(sources[0]).toContain('a_instance_stroke_color');
    // The fragment stage measures the distance with the shared distance functions of the shapes
    expect(sources[1]).toContain('pointShapeSdf(v_offset_px, v_outer_px, u_shape)');
  });
});

describe('building the instance array', () => {
  it('applies the device pixel ratio to the radius and the stroke width', () => {
    const data = buildPointInstanceData(POINTS, [0, 0], 2);

    expect(data[10]).toBe(POINTS[0].fillSize * 2);
    expect(data[11]).toBe(POINTS[0].strokeWidth * 2);
    // A point without a stroke keeps width 0 (it stays in the sequence without being thinned out)
    expect(data[STRIDE + 11]).toBe(0);
  });

  it('gives relative coordinates as the difference from the origin', () => {
    const data = buildPointInstanceData(POINTS, [1, 0], 1);

    expect(data[0]).toBe(-1);
    expect(data[STRIDE]).toBe(0);
    expect(data[STRIDE * 2]).toBe(1);
  });
});

describe('SDF boundaries (pointSdfEdges)', () => {
  it('makes the outer radius equal the radius when the stroke is 0', () => {
    expect(pointSdfEdges(6, 0)).toEqual({
      radius: 6,
      outer: 6,
      extent: 6 + POINT_AA_PADDING_PX,
    });
  });

  it('adds the stroke outside the radius', () => {
    expect(pointSdfEdges(6, 2)).toEqual({
      radius: 6,
      outer: 8,
      extent: 8 + POINT_AA_PADDING_PX,
    });
  });

  it('keeps the billboard enclosing the outer radius even with a large stroke', () => {
    const edges = pointSdfEdges(1, 40);

    expect(edges.outer).toBe(41);
    expect(edges.extent).toBeGreaterThan(edges.outer);
  });

  it('applies the size factor to both the radius and the stroke (padding stays in pixels)', () => {
    expect(pointSdfEdges(6, 2, 0.5)).toEqual({
      radius: 3,
      outer: 4,
      extent: 4 + POINT_AA_PADDING_PX,
    });
  });

  it('treats negative values as 0', () => {
    expect(pointSdfEdges(-6, -2)).toEqual({
      radius: 0,
      outer: 0,
      extent: POINT_AA_PADDING_PX,
    });
  });

  it('draws a point below a diameter of one pixel at that diameter, keeping its proportions', () => {
    expect(pointSdfEdges(0.1, 0.1)).toEqual({
      radius: 0.25,
      outer: POINT_MIN_OUTER_PX,
      extent: POINT_MIN_OUTER_PX + POINT_AA_PADDING_PX,
    });
    expect(pointSdfEdges(1, 0, 0.25).outer).toBe(POINT_MIN_OUTER_PX);
  });
});

describe('the ink of a point below one pixel (pointInkFactor)', () => {
  it('is 1 at a diameter of one pixel and above', () => {
    expect(pointInkFactor(POINT_MIN_OUTER_PX)).toBe(1);
    expect(pointInkFactor(6)).toBe(1);
  });

  it('below it, is the ratio of the true area to the area drawn', () => {
    expect(pointInkFactor(POINT_MIN_OUTER_PX / 2)).toBeCloseTo(0.25);
    expect(pointInkFactor(POINT_MIN_OUTER_PX / 10)).toBeCloseTo(0.01);
  });

  it('falls steadily to 0 with the radius, without a lower limit', () => {
    let previous = 1;
    for (const outer of [0.4, 0.3, 0.2, 0.1, 0.01, 0.001]) {
      const ink = pointInkFactor(outer);
      expect(ink).toBeLessThan(previous);
      previous = ink;
    }
    expect(pointInkFactor(0)).toBe(0);
    expect(pointInkFactor(-1)).toBe(0);
  });
});
