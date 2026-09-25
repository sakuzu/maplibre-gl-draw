// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests of the "negative line width = fixed width" convention
 *
 * When drawing the features of the Store in retained mode, features that have no
 * createdZoom (that is, those whose width should stay constant on the screen) and
 * features that scale relative to createdZoom must be mixed into the same batch for the
 * z-order. u_zoom is per batch, so a fixed width is expressed by the sign of an attribute.
 *
 * What is pinned down here is that "the CPU side passes a negative width to the GPU
 * while keeping it negative". The interpretation of the sign itself lives in the vertex
 * shader and cannot be run in an environment without GL, so it is out of scope.
 */

import type { Map as MapLibreMap, ProjectionData } from 'maplibre-gl';
import { describe, expect, it } from 'vitest';
import type { Coordinate } from '../../store/types.js';
import type { ShaderData } from '../shaders/helpers.js';
import type { LineBatchItem, LineBatchShape } from './line/line-types.js';
import { SDFLineRenderer } from './line/sdf-line.js';
import type { SDFPolygonBatchData, SDFPolygonStyle } from './polygon/sdf-polygon.js';
import { SDFPolygonRenderer } from './polygon/sdf-polygon.js';

/** A recorded GL call */
interface GLCall {
  name: string;
  args: unknown[];
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

interface RecordingGL {
  gl: WebGL2RenderingContext;
  calls: (name: string) => GLCall[];
  reset: () => void;
}

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

    createTexture: () => ({}),
    deleteTexture: () => {},
    createBuffer: () => ({}),
    deleteBuffer: () => {},
    createVertexArray: () => ({}),
    deleteVertexArray: () => {},

    createShader: () => ({}),
    shaderSource: () => {},
    compileShader: () => {},
    getShaderParameter: () => true,
    getShaderInfoLog: () => '',
    deleteShader: () => {},
    createProgram: () => ({}),
    attachShader: () => {},
    linkProgram: () => {},
    getProgramParameter: () => true,
    getProgramInfoLog: () => '',
    deleteProgram: () => {},
    useProgram: () => {},
    getUniformLocation: (_p: unknown, name: string) => ({ name }),

    bindBuffer: () => {},
    bufferData: (target: number, data: unknown, usage: number) =>
      record('bufferData', target, data, usage),
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

    uniform1f: () => {},
    uniform1i: () => {},
    uniform2f: () => {},
    uniform2fv: () => {},
    uniform3fv: () => {},
    uniform4fv: () => {},
    uniform4f: () => {},
    uniformMatrix4fv: () => {},

    drawArrays: () => {},
    drawArraysInstanced: () => {},
    drawElements: () => {},
  } as unknown as WebGL2RenderingContext;

  return {
    gl,
    calls: (name: string) => calls.filter((call) => call.name === name),
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

/** Extract the arrays transferred to ARRAY_BUFFER */
function arrayUploads(mock: RecordingGL): Float32Array[] {
  return mock
    .calls('bufferData')
    .filter((call) => call.args[0] === GL_CONSTANTS.ARRAY_BUFFER)
    .map((call) => call.args[1] as Float32Array);
}

const LINE_SHAPE: LineBatchShape = { lineStyle: 'solid' };

/** The instance attributes of a line: 12 floats per instance, a_extra.y is the 5th */
const LINE_INSTANCE_STRIDE = 12;
const LINE_STROKE_WIDTH_OFFSET = 5;

/** The vertex attributes of a polygon: 15 floats per vertex, a_extra.y is the 13th */
const POLYGON_VERTEX_STRIDE = 15;
const POLYGON_STROKE_WIDTH_OFFSET = 13;

function lineStrokeWidths(instanceData: Float32Array): number[] {
  const widths: number[] = [];
  for (let i = 0; i < instanceData.length / LINE_INSTANCE_STRIDE; i++) {
    widths.push(instanceData[i * LINE_INSTANCE_STRIDE + LINE_STROKE_WIDTH_OFFSET]);
  }
  return widths;
}

function polygonStrokeWidths(vertexData: Float32Array): number[] {
  const widths: number[] = [];
  for (let i = 0; i < vertexData.length / POLYGON_VERTEX_STRIDE; i++) {
    widths.push(vertexData[i * POLYGON_VERTEX_STRIDE + POLYGON_STROKE_WIDTH_OFFSET]);
  }
  return widths;
}

const SEGMENT: Array<[number, number]> = [
  [0, 0],
  [1, 1],
];

function lineItem(strokeWidth: number, featureId: string): LineBatchItem {
  return {
    coords: SEGMENT,
    featureId,
    closed: false,
    strokeWidth,
    createdZoom: 0,
    color: [1, 0, 0, 1],
    opacity: 1,
  };
}

describe('negative line widths in SDFLineRenderer', () => {
  it('puts a negative width into a_extra.y while keeping it negative', () => {
    const mock = createRecordingGL();
    const renderer = new SDFLineRenderer({} as MapLibreMap, mock.gl);
    renderer.ensureShader(SHADER_DATA);

    mock.reset();
    renderer.drawAll([lineItem(-3, 'fixed')], LINE_SHAPE, 12, createProjectionData());

    const instanceData = arrayUploads(mock)[0];
    expect(lineStrokeWidths(instanceData)).toEqual([-3]);
  });

  it('preserves the sign when fixed and variable widths are mixed in one batch', () => {
    const mock = createRecordingGL();
    const renderer = new SDFLineRenderer({} as MapLibreMap, mock.gl);
    renderer.ensureShader(SHADER_DATA);

    mock.reset();
    renderer.drawAll(
      [lineItem(2, 'scaled'), lineItem(-4, 'fixed'), lineItem(6, 'scaled-2')],
      LINE_SHAPE,
      12,
      createProjectionData(),
    );

    const instanceData = arrayUploads(mock)[0];
    // The input order (= the z-order) is kept, and so is the sign
    expect(lineStrokeWidths(instanceData)).toEqual([2, -4, 6]);
  });

  it('preserves a negative width in a retained-mode batch as well', () => {
    const mock = createRecordingGL();
    const renderer = new SDFLineRenderer({} as MapLibreMap, mock.gl);
    renderer.ensureShader(SHADER_DATA);

    mock.reset();
    const batch = renderer.buildRetainedBatch([lineItem(-5, 'fixed')], LINE_SHAPE, {
      origin: [0, 0],
    });

    expect(batch).not.toBeNull();
    // The first one is the quad vertices, the second one is the instance attributes
    const instanceData = arrayUploads(mock)[1];
    expect(lineStrokeWidths(instanceData)).toEqual([-5]);
  });
});

describe('negative outline widths in SDFPolygonRenderer', () => {
  const SQUARE: Coordinate[] = [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
  ];

  function style(strokeWidth: number): SDFPolygonStyle {
    return {
      fillColor: [1, 0, 0, 0.5],
      fillOpacity: 1,
      strokeColor: [0, 0, 0, 1],
      strokeWidth,
      strokeOpacity: 1,
    };
  }

  function drawPolygons(mock: RecordingGL, polygons: SDFPolygonBatchData[]): Float32Array {
    const renderer = new SDFPolygonRenderer(mock.gl);
    renderer.ensureShader(SHADER_DATA);

    mock.reset();
    renderer.drawBatch(polygons, createProjectionData(), 12, [800, 600]);

    return arrayUploads(mock)[0];
  }

  it('does not drop the outline for a negative width and puts it into a_extra.y as is', () => {
    const mock = createRecordingGL();
    const vertexData = drawPolygons(mock, [
      { coordinates: [SQUARE], style: style(-2), createdZoom: 0 },
    ]);

    // 4 fill vertices (the outline attributes are 0) + 4 outline edges x 4 vertices
    expect(vertexData).toHaveLength((4 + 16) * POLYGON_VERTEX_STRIDE);
    const widths = polygonStrokeWidths(vertexData);
    expect(widths.slice(0, 4)).toEqual([0, 0, 0, 0]);
    expect(widths.slice(4)).toEqual(new Array(16).fill(-2));
  });

  it('draws no outline for width 0, as before', () => {
    const mock = createRecordingGL();
    const vertexData = drawPolygons(mock, [
      { coordinates: [SQUARE], style: style(0), createdZoom: 0 },
    ]);

    // Only the 4 fill vertices
    expect(vertexData).toHaveLength(4 * POLYGON_VERTEX_STRIDE);
  });

  it('preserves the sign and the order when fixed and variable widths are mixed', () => {
    const mock = createRecordingGL();
    const second: Coordinate[] = SQUARE.map(([lng, lat]) => [lng + 10, lat + 10]);
    const vertexData = drawPolygons(mock, [
      { coordinates: [SQUARE], style: style(-2), createdZoom: 0 },
      { coordinates: [second], style: style(3), createdZoom: 14 },
    ]);

    const widths = polygonStrokeWidths(vertexData);
    // Polygon 0: 4 fill + 16 outline / Polygon 1: 4 fill + 16 outline
    expect(widths.slice(4, 20)).toEqual(new Array(16).fill(-2));
    expect(widths.slice(24, 40)).toEqual(new Array(16).fill(3));
  });
});
