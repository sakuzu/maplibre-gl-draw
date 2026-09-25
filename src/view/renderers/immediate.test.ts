// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests of immediate mode (the path that redraws every frame)
 *
 * The actual rendering methods are run on a mock WebGL2 context that records the calls,
 *
 * - that rendering each frame does not recreate GPU resources (textures, buffers, VAOs)
 * - that the draw calls are issued with the arguments required for indexed rendering
 * - that the z-order (fill -> outline, the input order of the polygons) is preserved
 *   even within a single draw call
 *
 * and these are checked. The contents of the shaders and the rendering results are out of scope.
 */

import type { Map as MapLibreMap, ProjectionData } from 'maplibre-gl';
import { describe, expect, it } from 'vitest';
import type { Coordinate } from '../../store/types.js';
import { EarcutCache } from '../cache/earcut.js';
import type { ShaderData } from '../shaders/helpers.js';
import type { LineBatchItem, LineBatchShape } from './line/line-types.js';
import { SDFLineRenderer } from './line/sdf-line.js';
import { FillShaderManager } from './polygon/fill.js';
import type { SDFPolygonBatchData } from './polygon/sdf-polygon.js';
import { SDFPolygonRenderer } from './polygon/sdf-polygon.js';
import type { StrokeOptions, StrokeStyle } from './stroke.js';
import { StrokeRenderer } from './stroke.js';

/** A recorded GL call */
interface GLCall {
  name: string;
  args: unknown[];
}

/** The number of GPU resources created */
interface CreatedCounts {
  textures: number;
  buffers: number;
  vaos: number;
}

/** A mock GL that records the calls */
interface RecordingGL {
  gl: WebGL2RenderingContext;
  /** The calls with the given name since recording started */
  calls: (name: string) => GLCall[];
  /** The number of GPU resources created since recording started */
  created: () => CreatedCounts;
  /** Clear the record (the already created resources are kept) */
  reset: () => void;
}

/**
 * The constants of the mock GL (the values have no meaning in themselves, but they are
 * kept distinguishable)
 */
const GL_CONSTANTS = {
  ARRAY_BUFFER: 1,
  ELEMENT_ARRAY_BUFFER: 2,
  STATIC_DRAW: 3,
  DYNAMIC_DRAW: 4,
  STREAM_DRAW: 5,
  FLOAT: 6,
  UNSIGNED_INT: 7,
  TEXTURE_2D: 8,
  RGBA32F: 9,
  RGBA: 10,
  TEXTURE0: 11,
  NEAREST: 12,
  CLAMP_TO_EDGE: 13,
  TEXTURE_MIN_FILTER: 14,
  TEXTURE_MAG_FILTER: 15,
  TEXTURE_WRAP_S: 16,
  TEXTURE_WRAP_T: 17,
  TRIANGLE_STRIP: 18,
  TRIANGLE_FAN: 19,
  TRIANGLES: 20,
  VERTEX_SHADER: 21,
  FRAGMENT_SHADER: 22,
  COMPILE_STATUS: 23,
  LINK_STATUS: 24,
} as const;

function createRecordingGL(): RecordingGL {
  let nextId = 1;
  let calls: GLCall[] = [];

  const record = (name: string, ...args: unknown[]): void => {
    calls.push({ name, args });
  };
  const create = (kind: string): object => ({ kind, id: nextId++ });

  const gl = {
    canvas: { width: 800, height: 600 },
    drawingBufferWidth: 800,
    drawingBufferHeight: 600,

    ...GL_CONSTANTS,

    // Resources
    createTexture: () => {
      record('createTexture');
      return create('texture');
    },
    deleteTexture: () => record('deleteTexture'),
    createBuffer: () => {
      record('createBuffer');
      return create('buffer');
    },
    deleteBuffer: () => record('deleteBuffer'),
    createVertexArray: () => {
      record('createVertexArray');
      return create('vao');
    },
    deleteVertexArray: () => record('deleteVertexArray'),

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
    bindBuffer: (target: number, buffer: unknown) => record('bindBuffer', target, buffer),
    bufferData: (target: number, data: unknown, usage: number) =>
      record('bufferData', target, data, usage),
    bindTexture: () => {},
    activeTexture: () => {},
    texImage2D: () => record('texImage2D'),
    // Only MAX_TEXTURE_SIZE is asked (the coordinate textures are bounded by it)
    getParameter: () => 4096,
    texStorage2D: (...args: unknown[]) => record('texStorage2D', ...args),
    texSubImage2D: (...args: unknown[]) => record('texSubImage2D', ...args),
    texParameteri: () => {},
    bindVertexArray: (vao: unknown) => record('bindVertexArray', vao),
    enableVertexAttribArray: () => {},
    vertexAttribPointer: () => {},
    vertexAttribDivisor: () => {},

    // uniform
    uniform1f: () => {},
    uniform1i: () => {},
    uniform2f: () => {},
    uniform2fv: () => {},
    uniform3fv: () => {},
    uniform4fv: () => {},
    uniform4f: () => {},
    uniformMatrix4fv: () => {},

    // Drawing
    drawArrays: (...args: unknown[]) => record('drawArrays', ...args),
    drawArraysInstanced: (...args: unknown[]) => record('drawArraysInstanced', ...args),
    drawElements: (...args: unknown[]) => record('drawElements', ...args),
  } as unknown as WebGL2RenderingContext;

  const countOf = (name: string): number => calls.filter((call) => call.name === name).length;

  return {
    gl,
    calls: (name: string) => calls.filter((call) => call.name === name),
    created: () => ({
      textures: countOf('createTexture'),
      buffers: countOf('createBuffer'),
      vaos: countOf('createVertexArray'),
    }),
    reset: () => {
      calls = [];
    },
  };
}

const NO_NEW_RESOURCES: CreatedCounts = { textures: 0, buffers: 0, vaos: 0 };

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

/** Extract the index arrays transferred to ELEMENT_ARRAY_BUFFER */
function indexUploads(mock: RecordingGL): Uint32Array[] {
  return mock
    .calls('bufferData')
    .filter((call) => call.args[0] === GL_CONSTANTS.ELEMENT_ARRAY_BUFFER)
    .map((call) => call.args[1] as Uint32Array);
}

/** Extract the vertex arrays transferred to ARRAY_BUFFER */
function vertexUploads(mock: RecordingGL): Float32Array[] {
  return mock
    .calls('bufferData')
    .filter((call) => call.args[0] === GL_CONSTANTS.ARRAY_BUFFER)
    .map((call) => call.args[1] as Float32Array);
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

const LINE_SHAPE: LineBatchShape = { lineStyle: 'solid' };

/** A square of four corners (without a closing point) */
const SQUARE: Coordinate[] = [
  [0, 0],
  [1, 0],
  [1, 1],
  [0, 1],
];

/** A style that draws both the fill and the outline */
const FILL_AND_STROKE = {
  fillColor: [1, 0, 0, 0.5] as [number, number, number, number],
  fillOpacity: 1,
  strokeColor: [0, 0, 0, 1] as [number, number, number, number],
  strokeWidth: 2,
  strokeOpacity: 1,
};

describe('immediate mode of SDFLineRenderer', () => {
  it('does not recreate the coordinate texture or instance buffer when drawing twice', () => {
    const mock = createRecordingGL();
    const renderer = new SDFLineRenderer({} as MapLibreMap, mock.gl);
    renderer.ensureShader(SHADER_DATA);

    // The first time: only the coordinate texture is newly allocated
    mock.reset();
    renderer.drawAll(LINE_ITEMS, LINE_SHAPE, 12, createProjectionData());

    expect(mock.created()).toEqual({ textures: 1, buffers: 0, vaos: 0 });
    expect(mock.calls('texStorage2D')).toHaveLength(1);
    expect(mock.calls('drawArraysInstanced')).toHaveLength(1);

    // The second time: no resource is created; it only transfers into the allocated texture
    mock.reset();
    renderer.drawAll(LINE_ITEMS, LINE_SHAPE, 13, createProjectionData());

    expect(mock.created()).toEqual(NO_NEW_RESOURCES);
    expect(mock.calls('deleteTexture')).toHaveLength(0);
    expect(mock.calls('texStorage2D')).toHaveLength(0);
    expect(mock.calls('drawArraysInstanced')).toHaveLength(1);
  });

  it('transfers the coordinates with texSubImage2D rather than texImage2D', () => {
    const mock = createRecordingGL();
    const renderer = new SDFLineRenderer({} as MapLibreMap, mock.gl);
    renderer.ensureShader(SHADER_DATA);

    mock.reset();
    renderer.drawAll(LINE_ITEMS, LINE_SHAPE, 12, createProjectionData());
    renderer.drawAll(LINE_ITEMS, LINE_SHAPE, 12, createProjectionData());

    expect(mock.calls('texImage2D')).toHaveLength(0);
    expect(mock.calls('texSubImage2D')).toHaveLength(2);
  });

  it('draws line after line from the same scratch arrays (no allocation per line)', () => {
    const mock = createRecordingGL();
    const renderer = new SDFLineRenderer({} as MapLibreMap, mock.gl);
    renderer.ensureShader(SHADER_DATA);
    const style = {
      width: 2,
      color: [0, 0, 0, 1] as [number, number, number, number],
      opacity: 1,
      lineStyle: 'solid' as const,
    };
    const line = (offset: number): Array<[number, number]> => [
      [139.7 + offset, 35.68],
      [139.71 + offset, 35.69],
      [139.72 + offset, 35.68],
    ];

    mock.reset();
    for (let i = 0; i < 3; i++) {
      renderer.draw(
        line(i * 0.01),
        style,
        { widthUnit: 'pixels', closed: false },
        12,
        createProjectionData(),
      );
    }

    const buffersOf = (name: string): Set<ArrayBufferLike> =>
      new Set(
        mock
          .calls(name)
          .map((call) => call.args.find((arg) => arg instanceof Float32Array) as Float32Array)
          .map((array) => array.buffer),
      );
    expect(mock.calls('bufferData')).toHaveLength(3);
    expect(buffersOf('bufferData').size).toBe(1);
    expect(buffersOf('texSubImage2D').size).toBe(1);
  });
});

describe('immediate mode of FillShaderManager', () => {
  it('issues a draw call with indexed rendering', () => {
    const mock = createRecordingGL();
    const manager = new FillShaderManager(mock.gl);
    manager.ensureShader(SHADER_DATA);

    mock.reset();
    manager.drawPolygonRings([SQUARE], [1, 0, 0, 1], createProjectionData(), 12);

    const uploaded = indexUploads(mock);
    expect(uploaded).toHaveLength(1);
    // A square is 2 triangles = 6 indices
    expect(uploaded[0]).toBeInstanceOf(Uint32Array);
    expect(uploaded[0]).toHaveLength(6);

    const draws = mock.calls('drawElements');
    expect(draws).toHaveLength(1);
    expect(draws[0].args).toEqual([GL_CONSTANTS.TRIANGLES, 6, GL_CONSTANTS.UNSIGNED_INT, 0]);
    expect(mock.calls('drawArrays')).toHaveLength(0);

    // There are as many vertices as ring points (indices expand them, so no duplicates)
    const vertices = vertexUploads(mock);
    expect(vertices).toHaveLength(1);
    expect(vertices[0]).toHaveLength(SQUARE.length * 2);
  });

  it('does not recreate the VAO, vertex buffer or index buffer when drawing twice', () => {
    const mock = createRecordingGL();
    const manager = new FillShaderManager(mock.gl);
    manager.ensureShader(SHADER_DATA);

    mock.reset();
    manager.drawPolygonRings([SQUARE], [1, 0, 0, 1], createProjectionData(), 12);
    expect(mock.created()).toEqual(NO_NEW_RESOURCES);

    mock.reset();
    manager.drawPolygonRings([SQUARE], [0, 1, 0, 1], createProjectionData(), 12);

    expect(mock.created()).toEqual(NO_NEW_RESOURCES);
    expect(mock.calls('deleteBuffer')).toHaveLength(0);
    expect(mock.calls('deleteVertexArray')).toHaveLength(0);
    expect(mock.calls('drawElements')).toHaveLength(1);
  });

  it('creates only two buffers and one VAO at construction', () => {
    const mock = createRecordingGL();
    new FillShaderManager(mock.gl);

    // The vertex buffer + the index buffer + the VAO
    expect(mock.created()).toEqual({ textures: 0, buffers: 2, vaos: 1 });
  });
});

describe('immediate mode of StrokeRenderer', () => {
  const STYLE: StrokeStyle = {
    width: 2,
    color: [1, 0, 0, 1],
    opacity: 1,
    lineStyle: 'solid',
  };
  const OPTIONS: StrokeOptions = { widthUnit: 'pixels', closed: false };
  const COORDS: Array<[number, number]> = [
    [0, 0],
    [1, 1],
    [2, 0],
  ];

  it('creates one vertex buffer and one VAO at construction', () => {
    const mock = createRecordingGL();
    new StrokeRenderer({} as MapLibreMap, mock.gl);

    expect(mock.created()).toEqual({ textures: 0, buffers: 1, vaos: 1 });
  });

  it('does not recreate the VAO or the vertex buffer when drawing twice', () => {
    const mock = createRecordingGL();
    const renderer = new StrokeRenderer({} as MapLibreMap, mock.gl);
    renderer.ensureShader(SHADER_DATA);

    mock.reset();
    renderer.draw(COORDS, STYLE, OPTIONS, 12, createProjectionData());

    expect(mock.created()).toEqual(NO_NEW_RESOURCES);
    // There are two vertices, left and right, per point
    expect(mock.calls('drawArrays')[0].args).toEqual([
      GL_CONSTANTS.TRIANGLE_STRIP,
      0,
      COORDS.length * 2,
    ]);

    mock.reset();
    renderer.draw(COORDS, STYLE, OPTIONS, 13, createProjectionData());

    expect(mock.created()).toEqual(NO_NEW_RESOURCES);
    expect(mock.calls('deleteBuffer')).toHaveLength(0);
    expect(mock.calls('deleteVertexArray')).toHaveLength(0);
    expect(mock.calls('drawArrays')).toHaveLength(1);
  });
});

describe('the triangulation cache of two draw instances', () => {
  it('never hands one instance the triangles of another instance for the same feature id', () => {
    // Two instances (a print preview next to the editor, a duplicated document) hold a feature
    // with the same id but a different shape. Keyed by the id alone, the second one would draw
    // with the first one's indices (out of range, or a broken fill)
    const first = createRecordingGL();
    const second = createRecordingGL();
    const firstRenderer = new SDFPolygonRenderer(first.gl, undefined, {
      earcut: new EarcutCache(),
    });
    const secondRenderer = new SDFPolygonRenderer(second.gl, undefined, {
      earcut: new EarcutCache(),
    });
    firstRenderer.ensureShader(SHADER_DATA);
    secondRenderer.ensureShader(SHADER_DATA);

    const triangle: Coordinate[] = [
      [0, 0],
      [1, 0],
      [0, 1],
    ];
    const noStroke = { ...FILL_AND_STROKE, strokeWidth: 0, strokeOpacity: 0 };

    first.reset();
    firstRenderer.drawBatch(
      [{ featureId: 'same', coordinates: [SQUARE], style: noStroke, createdZoom: 0 }],
      createProjectionData(),
      12,
      [800, 600],
    );
    second.reset();
    secondRenderer.drawBatch(
      [{ featureId: 'same', coordinates: [triangle], style: noStroke, createdZoom: 0 }],
      createProjectionData(),
      12,
      [800, 600],
    );

    const squareFill = Array.from(indexUploads(first)[0]).filter((i) => i < SQUARE.length);
    const triangleFill = Array.from(indexUploads(second)[0]).filter((i) => i < triangle.length);
    expect(squareFill).toHaveLength(6);
    // The triangle's own triangulation (3 indices, all within its 3 vertices)
    expect(triangleFill).toHaveLength(3);
    expect(Array.from(indexUploads(second)[0]).every((i) => i < triangle.length)).toBe(true);
  });
});

describe('immediate mode of SDFPolygonRenderer', () => {
  /** The a_type of a vertex (0=fill, 1=stroke) */
  function vertexType(vertexData: Float32Array, vertexIndex: number): number {
    return vertexData[vertexIndex * 15 + 6];
  }

  it('builds an index sequence where the outline comes after the fill', () => {
    const mock = createRecordingGL();
    const renderer = new SDFPolygonRenderer(mock.gl);
    renderer.ensureShader(SHADER_DATA);

    const polygons: SDFPolygonBatchData[] = [
      { coordinates: [SQUARE], style: FILL_AND_STROKE, createdZoom: 0 },
    ];

    mock.reset();
    const drawn = renderer.drawBatch(polygons, createProjectionData(), 12, [800, 600]);

    const indexData = indexUploads(mock)[0];
    const vertexData = vertexUploads(mock)[0];

    // Fill: a square of 4 points = 6 indices / outline: 4 edges x 6 indices
    expect(indexData).toBeInstanceOf(Uint32Array);
    expect(indexData).toHaveLength(6 + 24);
    expect(drawn).toBe(indexData.length);

    // The vertices are 4 for the fill + 4 outline edges x 4
    expect(vertexData).toHaveLength((4 + 16) * 15);

    // First the indices of the fill (pointing only at fill vertices 0..3)
    const fillPart = Array.from(indexData.slice(0, 6));
    expect(fillPart.every((i) => i < 4)).toBe(true);
    for (const i of fillPart) {
      expect(vertexType(vertexData, i)).toBe(0);
    }

    // Then the indices of the outline (pointing only at outline vertices 4..)
    const strokePart = Array.from(indexData.slice(6));
    expect(strokePart.every((i) => i >= 4)).toBe(true);
    for (const i of strokePart) {
      expect(vertexType(vertexData, i)).toBe(1);
    }

    // Per edge, 2 triangles: "start left, start right, end left / end left, start right, end right"
    for (let segment = 0; segment < 4; segment++) {
      const base = 4 + segment * 4;
      expect(strokePart.slice(segment * 6, segment * 6 + 6)).toEqual([
        base,
        base + 1,
        base + 2,
        base + 2,
        base + 1,
        base + 3,
      ]);
    }

    // There is only one draw call, an indexed one
    const draws = mock.calls('drawElements');
    expect(draws).toHaveLength(1);
    expect(draws[0].args).toEqual([
      GL_CONSTANTS.TRIANGLES,
      indexData.length,
      GL_CONSTANTS.UNSIGNED_INT,
      0,
    ]);
    expect(mock.calls('drawArrays')).toHaveLength(0);
  });

  it('orders "fill -> outline" by the input order of the polygons for several polygons', () => {
    const mock = createRecordingGL();
    const renderer = new SDFPolygonRenderer(mock.gl);
    renderer.ensureShader(SHADER_DATA);

    const second: Coordinate[] = SQUARE.map(([lng, lat]) => [lng + 10, lat + 10]);
    const polygons: SDFPolygonBatchData[] = [
      { coordinates: [SQUARE], style: FILL_AND_STROKE, createdZoom: 0 },
      { coordinates: [second], style: FILL_AND_STROKE, createdZoom: 0 },
    ];

    mock.reset();
    renderer.drawBatch(polygons, createProjectionData(), 12, [800, 600]);

    const indexData = indexUploads(mock)[0];
    expect(indexData).toHaveLength((6 + 24) * 2);

    // 20 vertices per polygon (4 fill + 16 outline)
    const ranges = [
      { part: indexData.slice(0, 6), min: 0, max: 4 }, // the fill of polygon 0
      { part: indexData.slice(6, 30), min: 4, max: 20 }, // the outline of polygon 0
      { part: indexData.slice(30, 36), min: 20, max: 24 }, // the fill of polygon 1
      { part: indexData.slice(36, 60), min: 24, max: 40 }, // the outline of polygon 1
    ];
    for (const { part, min, max } of ranges) {
      expect(Array.from(part).every((i) => i >= min && i < max)).toBe(true);
    }
  });

  it('does not recreate the VAO, vertex buffer or index buffer when drawing twice', () => {
    const mock = createRecordingGL();
    const renderer = new SDFPolygonRenderer(mock.gl);
    // The vertex buffer + the index buffer + the VAO are created only once, at construction
    expect(mock.created()).toEqual({ textures: 0, buffers: 2, vaos: 1 });

    renderer.ensureShader(SHADER_DATA);

    const polygons: SDFPolygonBatchData[] = [
      { coordinates: [SQUARE], style: FILL_AND_STROKE, createdZoom: 0 },
    ];

    mock.reset();
    renderer.drawBatch(polygons, createProjectionData(), 12, [800, 600]);
    expect(mock.created()).toEqual(NO_NEW_RESOURCES);

    mock.reset();
    renderer.drawBatch(polygons, createProjectionData(), 13, [800, 600]);

    expect(mock.created()).toEqual(NO_NEW_RESOURCES);
    expect(mock.calls('deleteBuffer')).toHaveLength(0);
    expect(mock.calls('deleteVertexArray')).toHaveLength(0);
  });
});
