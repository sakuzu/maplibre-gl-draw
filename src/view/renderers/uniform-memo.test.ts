// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests of memoizing uniforms within a frame
 *
 * Retained mode issues a draw call per chunk (batch), so once there are several hundred
 * visible chunks, setting the uniforms alone eats up the CPU every frame. The only thing
 * that changes between chunks is the shift of the origin (u_origin_shift), so
 *
 * - that a uniform with the same value is not rewritten within the same frame
 * - that u_origin_shift is rewritten correctly for each chunk
 * - that they are rewritten when the frame changes
 *
 * are checked. The rendering results themselves are out of scope.
 */

import type { Map as MapLibreMap, ProjectionData } from 'maplibre-gl';
import { describe, expect, it } from 'vitest';
import { beginRenderFrame } from '../shaders/frame.js';
import type { ShaderData } from '../shaders/helpers.js';
import { calculateOffsetUniforms } from '../shaders/helpers.js';
import type { LineBatchItem } from './line/line-types.js';
import { SDFLineRenderer } from './line/sdf-line.js';
import type { PointInstanceDataFull } from './point/point-instance.js';
import { PointInstanceRenderer } from './point/point-instance.js';

/** A mock GL that records the writes of uniforms */
interface MockGL {
  gl: WebGL2RenderingContext;
  /** The number of writes per uniform name (regardless of the program) */
  writes: (name: string) => number;
  /** The sequence of values written per uniform name */
  values: (name: string) => number[][];
  /** Clear the record */
  reset: () => void;
}

function createMockGL(): MockGL {
  const calls: Array<{ name: string; values: number[] }> = [];

  const record = (loc: { name: string } | null, values: number[]): void => {
    if (loc) calls.push({ name: loc.name, values });
  };

  const gl = {
    canvas: { width: 800, height: 600 },
    drawingBufferWidth: 800,
    drawingBufferHeight: 600,

    ARRAY_BUFFER: 1,
    ELEMENT_ARRAY_BUFFER: 24,
    UNSIGNED_INT: 25,
    STATIC_DRAW: 2,
    DYNAMIC_DRAW: 3,
    FLOAT: 5,
    TEXTURE_2D: 6,
    RGBA32F: 7,
    RGBA: 8,
    TEXTURE0: 9,
    NEAREST: 10,
    CLAMP_TO_EDGE: 11,
    TEXTURE_MIN_FILTER: 12,
    TEXTURE_MAG_FILTER: 13,
    TEXTURE_WRAP_S: 14,
    TEXTURE_WRAP_T: 15,
    TRIANGLE_STRIP: 16,
    // Point billboards are drawn with the depth test turned off
    // (drawBillboardsWithoutDepth in point-instance).
    DEPTH_TEST: 2929,
    isEnabled: () => false,
    enable: () => {},
    disable: () => {},
    TRIANGLE_FAN: 17,
    TRIANGLES: 18,
    VERTEX_SHADER: 20,
    FRAGMENT_SHADER: 21,
    COMPILE_STATUS: 22,
    LINK_STATUS: 23,

    createTexture: () => ({ kind: 'texture' }),
    deleteTexture: () => {},
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
    // The locations are made distinct per program (so a program mix-up can be detected)
    getUniformLocation: (program: object, name: string) => ({ program, name }),

    bindBuffer: () => {},
    bufferData: () => {},
    bindTexture: () => {},
    activeTexture: () => {},
    texImage2D: () => {},
    // Only MAX_TEXTURE_SIZE is asked (the coordinate textures are bounded by it)
    getParameter: () => 4096,
    texStorage2D: () => {},
    texSubImage2D: () => {},
    texParameteri: () => {},
    bindVertexArray: () => {},
    enableVertexAttribArray: () => {},
    vertexAttribPointer: () => {},
    vertexAttribDivisor: () => {},

    uniform1f: (loc: { name: string } | null, x: number) => record(loc, [x]),
    uniform1i: (loc: { name: string } | null, x: number) => record(loc, [x]),
    uniform2f: (loc: { name: string } | null, x: number, y: number) => record(loc, [x, y]),
    uniform4f: (loc: { name: string } | null, x: number, y: number, z: number, w: number) =>
      record(loc, [x, y, z, w]),
    uniform2fv: (loc: { name: string } | null, v: ArrayLike<number>) => record(loc, Array.from(v)),
    uniform3fv: (loc: { name: string } | null, v: ArrayLike<number>) => record(loc, Array.from(v)),
    uniform4fv: (loc: { name: string } | null, v: ArrayLike<number>) => record(loc, Array.from(v)),
    uniformMatrix4fv: (loc: { name: string } | null, _t: boolean, v: ArrayLike<number>) =>
      record(loc, Array.from(v)),

    drawArrays: () => {},
    drawArraysInstanced: () => {},
    drawElements: () => {},
  } as unknown as WebGL2RenderingContext;

  return {
    gl,
    writes: (name) => calls.filter((call) => call.name === name).length,
    values: (name) => calls.filter((call) => call.name === name).map((call) => call.values),
    reset: () => {
      calls.length = 0;
    },
  };
}

const SHADER_DATA: ShaderData = {
  vertexShaderPrelude: 'vec4 projectTile(vec2 p) { return vec4(p, 0.0, 1.0); }',
  define: '',
  variantName: 'mercator',
};

/**
 * A projectionData with the identity matrix (recreated each time = matching the style of
 * creating one per frame)
 */
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

/** A point placed at the given coordinate (having both a fill and an outline) */
function points(lng: number, lat: number): PointInstanceDataFull[] {
  return [
    {
      coord: [lng, lat],
      fillColor: [1, 0, 0, 1],
      fillSize: 4,
      strokeColor: [0, 0, 0, 1],
      strokeWidth: 1,
    },
  ];
}

/** A line starting at the given coordinate */
function lineItems(lng: number, lat: number): LineBatchItem[] {
  return [
    {
      coords: [
        [lng, lat],
        [lng + 1, lat + 1],
      ],
      featureId: `l${lng}`,
      closed: false,
      strokeWidth: 2,
      createdZoom: 0,
      color: [1, 0, 0, 1],
      opacity: 1,
    },
  ];
}

describe('memoizing uniforms in the retained rendering of points', () => {
  it('writes the matrix only once no matter how many chunks are drawn in one frame', () => {
    const mock = createMockGL();
    const renderer = new PointInstanceRenderer({} as MapLibreMap, mock.gl);
    renderer.ensureShader(SHADER_DATA);

    const projectionData = createProjectionData();
    renderer.setOffsetUniforms(
      calculateOffsetUniforms([0, 0], projectionData.mainMatrix as unknown as Float32Array),
    );

    const batches = [
      renderer.buildRetained(points(0, 0), 'circle', { origin: [0, 0] })!,
      renderer.buildRetained(points(10, 10), 'circle', { origin: [10, 10] })!,
      renderer.buildRetained(points(20, 20), 'circle', { origin: [20, 20] })!,
    ];

    beginRenderFrame();
    mock.reset();
    for (const batch of batches) {
      renderer.drawRetained(batch, 14, projectionData);
    }

    // The fill and the outline are one program, so the matrix is written only once
    expect(mock.writes('u_projection_matrix')).toBe(1);
    expect(mock.writes('u_projection_fallback_matrix')).toBe(1);
    expect(mock.writes('u_center_lnglat')).toBe(1);
    expect(mock.writes('u_use_offset_mode')).toBe(1);
    expect(mock.writes('u_size_scale')).toBe(1);
    expect(mock.writes('u_shape')).toBe(1);
  });

  it('rewrites u_origin_shift with its own origin for each chunk', () => {
    const mock = createMockGL();
    const renderer = new PointInstanceRenderer({} as MapLibreMap, mock.gl);
    renderer.ensureShader(SHADER_DATA);

    const projectionData = createProjectionData();
    // The center of the linearization (the camera center) is [0, 0]
    renderer.setOffsetUniforms(
      calculateOffsetUniforms([0, 0], projectionData.mainMatrix as unknown as Float32Array),
    );

    const batches = [
      renderer.buildRetained(points(0, 0), 'circle', { origin: [0, 0] })!,
      renderer.buildRetained(points(10, 20), 'circle', { origin: [10, 20] })!,
    ];

    beginRenderFrame();
    mock.reset();
    for (const batch of batches) {
      renderer.drawRetained(batch, 14, projectionData);
    }

    // 1 program x 2 chunks. The shift of the origin is specific to the chunk
    const written = mock.values('u_origin_shift');
    expect(written).toHaveLength(2);
    expect(written[0]).toEqual([0, 0]);
    expect(written[1]).toEqual([10, 20]);
  });

  it('rewrites the matrix when the frame changes', () => {
    const mock = createMockGL();
    const renderer = new PointInstanceRenderer({} as MapLibreMap, mock.gl);
    renderer.ensureShader(SHADER_DATA);

    const projectionData = createProjectionData();
    renderer.setOffsetUniforms(
      calculateOffsetUniforms([0, 0], projectionData.mainMatrix as unknown as Float32Array),
    );
    const batch = renderer.buildRetained(points(0, 0), 'circle', { origin: [0, 0] })!;

    beginRenderFrame();
    renderer.drawRetained(batch, 14, projectionData);

    mock.reset();
    renderer.drawRetained(batch, 14, projectionData);
    expect(mock.writes('u_projection_matrix')).toBe(0);

    // Even with the same ProjectionData, it is rewritten when the frame changes
    beginRenderFrame();
    mock.reset();
    renderer.drawRetained(batch, 14, projectionData);
    expect(mock.writes('u_projection_matrix')).toBe(1);
  });

  it('rewrites the matrix even in the same frame when the ProjectionData changes', () => {
    const mock = createMockGL();
    const renderer = new PointInstanceRenderer({} as MapLibreMap, mock.gl);
    renderer.ensureShader(SHADER_DATA);

    const first = createProjectionData();
    renderer.setOffsetUniforms(
      calculateOffsetUniforms([0, 0], first.mainMatrix as unknown as Float32Array),
    );
    const batch = renderer.buildRetained(points(0, 0), 'circle', { origin: [0, 0] })!;

    beginRenderFrame();
    renderer.drawRetained(batch, 14, first);

    mock.reset();
    renderer.drawRetained(batch, 14, createProjectionData());
    expect(mock.writes('u_projection_matrix')).toBe(1);
  });

  it('throws away the memo when the shader is rebuilt', () => {
    const mock = createMockGL();
    const renderer = new PointInstanceRenderer({} as MapLibreMap, mock.gl);
    renderer.ensureShader(SHADER_DATA);

    const projectionData = createProjectionData();
    renderer.setOffsetUniforms(
      calculateOffsetUniforms([0, 0], projectionData.mainMatrix as unknown as Float32Array),
    );
    const batch = renderer.buildRetained(points(0, 0), 'circle', { origin: [0, 0] })!;

    beginRenderFrame();
    renderer.drawRetained(batch, 14, projectionData);

    // Changing the projection rebuilds the program (the uniforms return to their initial values)
    renderer.ensureShader({ ...SHADER_DATA, variantName: 'globe' });
    const rebuilt = renderer.buildRetained(points(0, 0), 'circle', { origin: [0, 0] })!;

    mock.reset();
    renderer.drawRetained(rebuilt, 14, projectionData);
    expect(mock.writes('u_projection_matrix')).toBe(1);
  });
});

describe('memoizing uniforms in the retained rendering of lines', () => {
  it('writes the matrix and viewport once in a frame, rewriting only the origin shift', () => {
    const mock = createMockGL();
    const renderer = new SDFLineRenderer({} as MapLibreMap, mock.gl);
    renderer.ensureShader(SHADER_DATA);

    const projectionData = createProjectionData();
    renderer.setOffsetUniforms(
      calculateOffsetUniforms([0, 0], projectionData.mainMatrix as unknown as Float32Array),
    );

    const batches = [
      renderer.buildRetainedBatch(lineItems(0, 0), { lineStyle: 'solid' }, { origin: [0, 0] })!,
      renderer.buildRetainedBatch(lineItems(10, 20), { lineStyle: 'solid' }, { origin: [10, 20] })!,
    ];

    beginRenderFrame();
    mock.reset();
    for (const batch of batches) {
      renderer.drawRetainedBatch(batch, 14, projectionData);
    }

    expect(mock.writes('u_projection_matrix')).toBe(1);
    expect(mock.writes('u_viewport')).toBe(1);
    expect(mock.writes('u_miter_limit')).toBe(1);
    expect(mock.writes('u_coord_tex')).toBe(1);
    expect(mock.writes('u_dashEnabled')).toBe(1);
    expect(mock.values('u_origin_shift')).toEqual([
      [0, 0],
      [10, 20],
    ]);
  });

  it('rewrites both the matrix and the viewport when the frame changes', () => {
    const mock = createMockGL();
    const renderer = new SDFLineRenderer({} as MapLibreMap, mock.gl);
    renderer.ensureShader(SHADER_DATA);

    const projectionData = createProjectionData();
    renderer.setOffsetUniforms(
      calculateOffsetUniforms([0, 0], projectionData.mainMatrix as unknown as Float32Array),
    );
    const batch = renderer.buildRetainedBatch(
      lineItems(0, 0),
      { lineStyle: 'solid' },
      { origin: [0, 0] },
    )!;

    beginRenderFrame();
    renderer.drawRetainedBatch(batch, 14, projectionData);

    mock.reset();
    renderer.drawRetainedBatch(batch, 14, projectionData);
    expect(mock.writes('u_projection_matrix')).toBe(0);
    expect(mock.writes('u_viewport')).toBe(0);

    beginRenderFrame();
    mock.reset();
    renderer.drawRetainedBatch(batch, 14, projectionData);
    expect(mock.writes('u_projection_matrix')).toBe(1);
    expect(mock.writes('u_viewport')).toBe(1);
  });
});
