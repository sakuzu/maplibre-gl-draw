// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests of retained mode (building and drawing kept separate)
 *
 * On a mock WebGL2 context it is checked that the three renderers
 *
 * - create GPU resources (textures, buffers, VAOs) when building
 * - do neither texture creation nor bufferData when drawing
 * - release every resource they created when disposed
 *
 * The contents of the shaders and the rendering results are out of scope.
 */

import type { Map as MapLibreMap, ProjectionData } from 'maplibre-gl';
import { describe, expect, it } from 'vitest';
import type { ShaderData } from '../shaders/helpers.js';
import type { LineBatchItem } from './line/line-types.js';
import { SDFLineRenderer } from './line/sdf-line.js';
import type { PointInstanceDataFull } from './point/point-instance.js';
import { PointInstanceRenderer } from './point/point-instance.js';
import type { SDFPolygonBatchData } from './polygon/sdf-polygon.js';
import { SDFPolygonRenderer } from './polygon/sdf-polygon.js';

/** A mock GL that counts the number of GPU resources alive */
interface MockGL {
  gl: WebGL2RenderingContext;
  /** The number of textures, buffers and VAOs alive */
  live: () => number;
  /** The number of data transfers to textures (texImage2D / texStorage2D / texSubImage2D) */
  texUploads: () => number;
  /** The number of calls to bufferData */
  bufferData: () => number;
  /** The number of draw calls */
  draws: () => number;
  /** The value last written to uniform1f (uniform name -> value) */
  uniform1f: (name: string) => number | undefined;
  /** Clear the record of call counts (the number alive is kept) */
  reset: () => void;
}

function createMockGL(): MockGL {
  let nextId = 1;
  const live = new Set<object>();
  let texUploads = 0;
  let bufferData = 0;
  let draws = 0;
  const uniform1f = new Map<string, number>();

  const create = (kind: string): object => {
    const resource = { kind, id: nextId++ };
    live.add(resource);
    return resource;
  };
  const destroy = (resource: object | null): void => {
    if (resource) live.delete(resource);
  };

  const gl = {
    canvas: { width: 800, height: 600 },
    drawingBufferWidth: 800,
    drawingBufferHeight: 600,

    // The constants (the values have no meaning in themselves, but are kept distinguishable)
    ARRAY_BUFFER: 1,
    ELEMENT_ARRAY_BUFFER: 24,
    UNSIGNED_INT: 25,
    STATIC_DRAW: 2,
    DYNAMIC_DRAW: 3,
    STREAM_DRAW: 4,
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

    // Resources
    createTexture: () => create('texture'),
    deleteTexture: (t: object | null) => destroy(t),
    createBuffer: () => create('buffer'),
    deleteBuffer: (b: object | null) => destroy(b),
    createVertexArray: () => create('vao'),
    deleteVertexArray: (v: object | null) => destroy(v),

    // Shaders
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

    // Binding and transfer
    bindBuffer: () => {},
    bufferData: () => {
      bufferData++;
    },
    bindTexture: () => {},
    activeTexture: () => {},
    texImage2D: () => {
      texUploads++;
    },
    // Only MAX_TEXTURE_SIZE is asked (the coordinate textures are bounded by it)
    getParameter: () => 4096,
    texStorage2D: () => {
      texUploads++;
    },
    texSubImage2D: () => {
      texUploads++;
    },
    texParameteri: () => {},
    bindVertexArray: () => {},
    enableVertexAttribArray: () => {},
    vertexAttribPointer: () => {},
    vertexAttribDivisor: () => {},

    // uniform
    uniform1f: (loc: { name: string } | null, value: number) => {
      if (loc) uniform1f.set(loc.name, value);
    },
    uniform1i: () => {},
    uniform2f: () => {},
    uniform2fv: () => {},
    uniform3fv: () => {},
    uniform4fv: () => {},
    uniform4f: () => {},
    uniformMatrix4fv: () => {},

    // Drawing
    drawArrays: () => {
      draws++;
    },
    drawArraysInstanced: () => {
      draws++;
    },
    drawElements: () => {
      draws++;
    },
  } as unknown as WebGL2RenderingContext;

  return {
    gl,
    live: () => live.size,
    texUploads: () => texUploads,
    bufferData: () => bufferData,
    draws: () => draws,
    uniform1f: (name: string) => uniform1f.get(name),
    reset: () => {
      texUploads = 0;
      bufferData = 0;
      draws = 0;
      uniform1f.clear();
    },
  };
}

const SHADER_DATA: ShaderData = {
  vertexShaderPrelude: 'vec4 projectTile(vec2 p) { return vec4(p, 0.0, 1.0); }',
  define: '',
  variantName: 'mercator',
};

/** A projectionData with the identity matrix */
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

const LINE_ITEMS: LineBatchItem[] = [
  {
    coords: [
      [0, 0],
      [1, 1],
      [2, 0],
    ],
    featureId: 'a',
    closed: false,
    strokeWidth: 2,
    createdZoom: 0,
    color: [1, 0, 0, 1],
    opacity: 1,
  },
  {
    coords: [
      [5, 5],
      [6, 6],
    ],
    featureId: 'b',
    closed: false,
    strokeWidth: 3,
    createdZoom: 0,
    color: [0, 1, 0, 1],
    opacity: 0.5,
  },
];

const POLYGONS: SDFPolygonBatchData[] = [
  {
    coordinates: [
      [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 1],
      ],
    ],
    style: {
      fillColor: [1, 0, 0, 0.5],
      fillOpacity: 1,
      strokeColor: [0, 0, 0, 1],
      strokeWidth: 2,
      strokeOpacity: 1,
    },
    createdZoom: 0,
    featureId: 'p',
  },
];

const POINTS: PointInstanceDataFull[] = [
  {
    coord: [0, 0],
    fillColor: [1, 0, 0, 1],
    fillSize: 6,
    strokeColor: [1, 1, 1, 1],
    strokeWidth: 2,
  },
  {
    coord: [1, 1],
    fillColor: [0, 1, 0, 1],
    fillSize: 4,
    strokeColor: [1, 1, 1, 1],
    strokeWidth: 0,
  },
];

describe('retained mode of SDFLineRenderer', () => {
  it('creates the coordinate texture, the instance buffer and the VAO when building', () => {
    const mock = createMockGL();
    const renderer = new SDFLineRenderer({} as MapLibreMap, mock.gl);
    renderer.ensureShader(SHADER_DATA);

    const before = mock.live();
    const batch = renderer.buildRetainedBatch(LINE_ITEMS, { lineStyle: 'solid' });

    expect(batch).not.toBeNull();
    // The texture + the quad buffer + the instance buffer + the VAO
    expect(mock.live() - before).toBe(4);
    expect(batch?.instanceCount).toBe(3);
  });

  it('does neither texture creation nor bufferData when drawing', () => {
    const mock = createMockGL();
    const renderer = new SDFLineRenderer({} as MapLibreMap, mock.gl);
    renderer.ensureShader(SHADER_DATA);
    const batch = renderer.buildRetainedBatch(LINE_ITEMS, { lineStyle: 'solid' });
    if (!batch) throw new Error('batch');

    mock.reset();
    renderer.drawRetainedBatch(batch, 12, createProjectionData());
    renderer.drawRetainedBatch(batch, 13, createProjectionData());

    expect(mock.texUploads()).toBe(0);
    expect(mock.bufferData()).toBe(0);
    expect(mock.draws()).toBe(2);
  });

  it('releases every resource it built when disposed', () => {
    const mock = createMockGL();
    const renderer = new SDFLineRenderer({} as MapLibreMap, mock.gl);
    renderer.ensureShader(SHADER_DATA);

    const before = mock.live();
    const batch = renderer.buildRetainedBatch(LINE_ITEMS, { lineStyle: 'solid' });
    if (!batch) throw new Error('batch');
    renderer.disposeRetainedBatch(batch);

    expect(mock.live()).toBe(before);
  });

  it('does not build when the shader is not initialized or the input is empty', () => {
    const mock = createMockGL();
    const renderer = new SDFLineRenderer({} as MapLibreMap, mock.gl);

    expect(renderer.buildRetainedBatch(LINE_ITEMS, { lineStyle: 'solid' })).toBeNull();

    renderer.ensureShader(SHADER_DATA);
    expect(renderer.buildRetainedBatch([], { lineStyle: 'solid' })).toBeNull();
  });

  it('allows the reference zoom of the line width to be fixed', () => {
    const mock = createMockGL();
    const renderer = new SDFLineRenderer({} as MapLibreMap, mock.gl);
    renderer.ensureShader(SHADER_DATA);

    const fixed = renderer.buildRetainedBatch(LINE_ITEMS, { lineStyle: 'solid' }, { widthZoom: 0 });
    const scaled = renderer.buildRetainedBatch(LINE_ITEMS, { lineStyle: 'solid' });

    expect(fixed?.widthZoom).toBe(0);
    expect(scaled?.widthZoom).toBeNull();
  });

  it('allows the origin of the relative coordinates to be set, defaulting to the first', () => {
    const mock = createMockGL();
    const renderer = new SDFLineRenderer({} as MapLibreMap, mock.gl);
    renderer.ensureShader(SHADER_DATA);

    expect(
      renderer.buildRetainedBatch(LINE_ITEMS, { lineStyle: 'solid' }, { origin: [10, 20] })?.origin,
    ).toEqual([10, 20]);
    expect(renderer.buildRetainedBatch(LINE_ITEMS, { lineStyle: 'solid' })?.origin).toEqual([0, 0]);
  });
});

describe('retained mode of SDFPolygonRenderer', () => {
  it('creates vertex buffer, index buffer and VAO when building, releasing them on dispose', () => {
    const mock = createMockGL();
    const renderer = new SDFPolygonRenderer(mock.gl);
    renderer.ensureShader(SHADER_DATA);

    const before = mock.live();
    const batch = renderer.buildRetained(POLYGONS);
    if (!batch) throw new Error('batch');

    expect(mock.live() - before).toBe(3);
    expect(batch.indexCount).toBeGreaterThan(0);

    renderer.disposeRetained(batch);
    expect(mock.live()).toBe(before);
  });

  it('does not call bufferData when drawing', () => {
    const mock = createMockGL();
    const renderer = new SDFPolygonRenderer(mock.gl);
    renderer.ensureShader(SHADER_DATA);
    const batch = renderer.buildRetained(POLYGONS);
    if (!batch) throw new Error('batch');

    mock.reset();
    renderer.drawRetained(batch, 12, createProjectionData(), [800, 600]);

    expect(mock.bufferData()).toBe(0);
    expect(mock.draws()).toBe(1);
  });

  it('produces the same number of indices as drawBatch in immediate mode', () => {
    const mock = createMockGL();
    const renderer = new SDFPolygonRenderer(mock.gl);
    renderer.ensureShader(SHADER_DATA);

    const immediate = renderer.drawBatch(POLYGONS, createProjectionData(), 12, [800, 600]);
    const retained = renderer.buildRetained(POLYGONS);

    expect(retained?.indexCount).toBe(immediate);
  });

  it('does not build when the shader is not initialized or the input is empty', () => {
    const mock = createMockGL();
    const renderer = new SDFPolygonRenderer(mock.gl);

    expect(renderer.buildRetained(POLYGONS)).toBeNull();

    renderer.ensureShader(SHADER_DATA);
    expect(renderer.buildRetained([])).toBeNull();
  });
});

describe('retained mode of PointInstanceRenderer', () => {
  it('creates one set of resources when building and releases them when disposed', () => {
    const mock = createMockGL();
    const renderer = new PointInstanceRenderer({} as MapLibreMap, mock.gl);
    renderer.ensureShader(SHADER_DATA);

    const before = mock.live();
    const batch = renderer.buildRetained(POINTS, 'circle');
    if (!batch) throw new Error('batch');

    // The fill and the outline are drawn in one draw, so there are only three: the
    // billboard vertex buffer + the instance buffer + the VAO
    expect(mock.live() - before).toBe(3);
    expect(batch.instanceCount).toBe(2);

    renderer.disposeRetained(batch);
    expect(mock.live()).toBe(before);
  });

  it('draws even points without an outline with the same single set of resources', () => {
    const mock = createMockGL();
    const renderer = new PointInstanceRenderer({} as MapLibreMap, mock.gl);
    renderer.ensureShader(SHADER_DATA);

    const before = mock.live();
    const batch = renderer.buildRetained([{ ...POINTS[1] }], 'square');
    if (!batch) throw new Error('batch');

    expect(mock.live() - before).toBe(3);
    expect(batch.instanceCount).toBe(1);

    renderer.disposeRetained(batch);
    expect(mock.live()).toBe(before);
  });

  it('completes in one draw without calling bufferData when drawing', () => {
    const mock = createMockGL();
    const renderer = new PointInstanceRenderer({} as MapLibreMap, mock.gl);
    renderer.ensureShader(SHADER_DATA);
    const batch = renderer.buildRetained(POINTS, 'circle');
    if (!batch) throw new Error('batch');

    mock.reset();
    renderer.drawRetained(batch, 12, createProjectionData());

    expect(mock.bufferData()).toBe(0);
    // Once for the fill + the outline
    expect(mock.draws()).toBe(1);
  });

  it('does not build when the shader is not initialized or the input is empty', () => {
    const mock = createMockGL();
    const renderer = new PointInstanceRenderer({} as MapLibreMap, mock.gl);

    expect(renderer.buildRetained(POINTS, 'circle')).toBeNull();

    renderer.ensureShader(SHADER_DATA);
    expect(renderer.buildRetained([], 'circle')).toBeNull();
  });
});

describe('the draw-time factors (u_size_scale / u_opacity)', () => {
  it('lines: the factors go into the uniforms; omitted and immediate mode return to 1', () => {
    const mock = createMockGL();
    const renderer = new SDFLineRenderer({} as MapLibreMap, mock.gl);
    renderer.ensureShader(SHADER_DATA);
    const batch = renderer.buildRetainedBatch(LINE_ITEMS, { lineStyle: 'solid' });
    if (!batch) throw new Error('batch');

    renderer.drawRetainedBatch(batch, 12, createProjectionData(), { scale: 0.5, opacity: 0.25 });
    expect(mock.uniform1f('u_size_scale')).toBe(0.5);
    expect(mock.uniform1f('u_opacity')).toBe(0.25);

    renderer.drawRetainedBatch(batch, 12, createProjectionData());
    expect(mock.uniform1f('u_size_scale')).toBe(1);
    expect(mock.uniform1f('u_opacity')).toBe(1);

    // Immediate mode does not use the factors, but writes 1 every time to clear the residue
    renderer.drawRetainedBatch(batch, 12, createProjectionData(), { scale: 3, opacity: 0.5 });
    renderer.draw(
      [
        [0, 0],
        [1, 1],
      ],
      { width: 2, color: [0, 0, 0, 1], opacity: 1, lineStyle: 'solid' },
      { widthUnit: 'pixels', closed: false },
      12,
      createProjectionData(),
    );
    expect(mock.uniform1f('u_size_scale')).toBe(1);
    expect(mock.uniform1f('u_opacity')).toBe(1);
  });

  it('polygons: the factors go into the uniforms; omitted and immediate mode return to 1', () => {
    const mock = createMockGL();
    const renderer = new SDFPolygonRenderer(mock.gl);
    renderer.ensureShader(SHADER_DATA);
    const batch = renderer.buildRetained(POLYGONS);
    if (!batch) throw new Error('batch');

    renderer.drawRetained(batch, 12, createProjectionData(), [800, 600], {
      scale: 0.5,
      opacity: 0.25,
    });
    expect(mock.uniform1f('u_size_scale')).toBe(0.5);
    expect(mock.uniform1f('u_opacity')).toBe(0.25);

    renderer.drawRetained(batch, 12, createProjectionData(), [800, 600]);
    expect(mock.uniform1f('u_size_scale')).toBe(1);
    expect(mock.uniform1f('u_opacity')).toBe(1);

    renderer.drawRetained(batch, 12, createProjectionData(), [800, 600], {
      scale: 3,
      opacity: 0.5,
    });
    renderer.drawBatch(POLYGONS, createProjectionData(), 12, [800, 600]);
    expect(mock.uniform1f('u_size_scale')).toBe(1);
    expect(mock.uniform1f('u_opacity')).toBe(1);
  });

  it('points: the factors go into the uniforms; omitted and immediate mode return to 1', () => {
    const mock = createMockGL();
    const renderer = new PointInstanceRenderer({} as MapLibreMap, mock.gl);
    renderer.ensureShader(SHADER_DATA);
    renderer.setProjectionData(createProjectionData());
    const batch = renderer.buildRetained(POINTS, 'circle');
    if (!batch) throw new Error('batch');

    renderer.drawRetained(batch, 12, createProjectionData(), { scale: 0.5, opacity: 0.25 });
    expect(mock.uniform1f('u_size_scale')).toBe(0.5);
    expect(mock.uniform1f('u_opacity')).toBe(0.25);

    renderer.drawRetained(batch, 12, createProjectionData());
    expect(mock.uniform1f('u_size_scale')).toBe(1);
    expect(mock.uniform1f('u_opacity')).toBe(1);

    renderer.drawRetained(batch, 12, createProjectionData(), { scale: 3, opacity: 0.5 });
    renderer.drawAll(POINTS, 'circle', 12);
    expect(mock.uniform1f('u_size_scale')).toBe(1);
    expect(mock.uniform1f('u_opacity')).toBe(1);
  });
});
