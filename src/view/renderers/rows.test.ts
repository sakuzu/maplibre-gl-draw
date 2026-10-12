// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The retained batches of rows held as columns, on a GL that records its calls
 *
 * - A range of rows is one draw: the instance attributes of the points and the lines are pointed
 *   at the first instance of the range, the indices of the polygons start at the first index
 * - The rows are drawn by the variant of the programs (`TABLE_ROWS`), with the texture of the
 *   state of the rows bound
 * - The texture of the state is uploaded whatever the alignment of the context
 * - The ledger holds what the batches hold, and nothing once they are disposed
 */

import type { Map as MapLibreMap, ProjectionData } from 'maplibre-gl';
import { describe, expect, it } from 'vitest';
import { GpuLedger } from '../gpu-ledger.js';
import type { ShaderData } from '../shaders/helpers.js';
import { ROW_LINE_STRIDE } from './line/line-geometry.js';
import { SDFLineRenderer } from './line/sdf-line.js';
import { PointInstanceRenderer, ROW_POINT_STRIDE } from './point/point-instance.js';
import { ROW_POLYGON_STRIDE, SDFPolygonRenderer } from './polygon/sdf-polygon.js';
import {
  createRowStateTexture,
  deleteRowStateTexture,
  ROW_STATE_WIDTH,
  type RowStateBinding,
  uploadRowState,
} from './row-state.js';

interface Call {
  name: string;
  args: unknown[];
}

const CONSTANTS: Record<string, number> = {
  ARRAY_BUFFER: 1,
  ELEMENT_ARRAY_BUFFER: 2,
  STATIC_DRAW: 3,
  DYNAMIC_DRAW: 4,
  STREAM_DRAW: 5,
  FLOAT: 6,
  TEXTURE_2D: 7,
  RGBA32F: 8,
  RGBA: 9,
  TEXTURE0: 100,
  NEAREST: 11,
  CLAMP_TO_EDGE: 12,
  TEXTURE_MIN_FILTER: 13,
  TEXTURE_MAG_FILTER: 14,
  TEXTURE_WRAP_S: 15,
  TEXTURE_WRAP_T: 16,
  TRIANGLE_STRIP: 17,
  TRIANGLES: 18,
  UNSIGNED_INT: 19,
  VERTEX_SHADER: 20,
  FRAGMENT_SHADER: 21,
  COMPILE_STATUS: 22,
  LINK_STATUS: 23,
  DEPTH_TEST: 24,
  R8UI: 25,
  RED_INTEGER: 26,
  UNSIGNED_BYTE: 27,
  UNPACK_ALIGNMENT: 28,
  MAX_TEXTURE_SIZE: 29,
  CULL_FACE: 30,
};

/** A GL that records every call and answers what the renderers ask */
function createGL(alignment = 4) {
  const calls: Call[] = [];
  const sources: string[] = [];
  let unpackAlignment = alignment;
  let next = 1;
  const record =
    (name: string, result?: (...args: unknown[]) => unknown) =>
    (...args: unknown[]) => {
      calls.push({ name, args });
      return result?.(...args);
    };
  const gl = new Proxy(
    {
      ...CONSTANTS,
      drawingBufferWidth: 800,
      drawingBufferHeight: 600,
      canvas: { width: 800, height: 600 },
      createBuffer: record('createBuffer', () => ({ buffer: next++ })),
      createTexture: record('createTexture', () => ({ texture: next++ })),
      createVertexArray: record('createVertexArray', () => ({ vao: next++ })),
      createProgram: record('createProgram', () => ({ program: next++ })),
      createShader: record('createShader', () => ({ shader: next++ })),
      shaderSource: (_shader: unknown, source: string) => {
        sources.push(source);
      },
      getShaderParameter: () => true,
      getProgramParameter: () => true,
      getUniformLocation: (_program: unknown, name: string) => ({ name }),
      getParameter: (name: number) =>
        name === CONSTANTS.UNPACK_ALIGNMENT ? unpackAlignment : 4096,
      pixelStorei: (name: number, value: number) => {
        calls.push({ name: 'pixelStorei', args: [name, value] });
        if (name === CONSTANTS.UNPACK_ALIGNMENT) unpackAlignment = value;
      },
      isEnabled: () => false,
    } as Record<string, unknown>,
    {
      get(target, prop: string) {
        if (prop in target) return target[prop];
        return record(prop);
      },
    },
  ) as unknown as WebGL2RenderingContext;
  return {
    gl,
    calls,
    sources,
    of: (name: string) => calls.filter((call) => call.name === name),
    clear: () => {
      calls.length = 0;
    },
    alignment: () => unpackAlignment,
  };
}

const SHADER_DATA: ShaderData = {
  vertexShaderPrelude: '',
  define: '',
  variantName: 'mercator',
};

const projection = (): ProjectionData =>
  ({
    mainMatrix: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
    tileMercatorCoords: [0, 0, 1, 1],
    clippingPlane: [0, 0, 0, 0],
    projectionTransition: 0,
    fallbackMatrix: new Float32Array(16),
  }) as unknown as ProjectionData;

function binding(gl: WebGL2RenderingContext, rows: number): RowStateBinding {
  const texture = createRowStateTexture(gl, rows);
  if (!texture) throw new Error('texture');
  return { texture, translations: new Float32Array(8) };
}

describe('the texture of the state of the rows', () => {
  it('is uploaded with an alignment of 1 and puts the alignment of the context back', () => {
    const mock = createGL(4);
    const texture = createRowStateTexture(mock.gl, ROW_STATE_WIDTH + 3);
    if (!texture) throw new Error('texture');
    expect(texture.height).toBe(2);
    mock.clear();
    const state = new Uint8Array(ROW_STATE_WIDTH + 3).fill(1);
    uploadRowState(mock.gl, texture, state);
    const order = mock.calls.map((call) => call.name).filter((name) => name !== 'bindTexture');
    expect(order).toEqual(['pixelStorei', 'texSubImage2D', 'pixelStorei']);
    expect(mock.of('pixelStorei').map((call) => call.args[1])).toEqual([1, 4]);
    const upload = mock.of('texSubImage2D')[0].args;
    expect(upload.slice(4, 8)).toEqual([
      ROW_STATE_WIDTH,
      2,
      CONSTANTS.RED_INTEGER,
      CONSTANTS.UNSIGNED_BYTE,
    ]);
    const data = upload[8] as Uint8Array;
    // The rows past the last one are 0
    expect(data.length).toBe(ROW_STATE_WIDTH * 2);
    expect(data[ROW_STATE_WIDTH + 2]).toBe(1);
    expect(data[ROW_STATE_WIDTH + 3]).toBe(0);
    expect(mock.alignment()).toBe(4);
  });

  it('is an integer texture read without filtering, and is counted in the ledger', () => {
    const mock = createGL();
    const ledger = new GpuLedger();
    const texture = createRowStateTexture(mock.gl, 300, ledger);
    if (!texture) throw new Error('texture');
    expect(mock.of('texStorage2D')[0].args).toEqual([
      CONSTANTS.TEXTURE_2D,
      1,
      CONSTANTS.R8UI,
      ROW_STATE_WIDTH,
      3,
    ]);
    expect(ledger.snapshot().byOwner['row-state']).toBe(ROW_STATE_WIDTH * 3);
    deleteRowStateTexture(mock.gl, texture, ledger);
    expect(ledger.snapshot().bytes).toBe(0);
  });
});

describe('a point batch of rows', () => {
  it('draws a range of rows with the variant of the rows, from the first instance of the range', () => {
    const mock = createGL();
    const ledger = new GpuLedger();
    const renderer = new PointInstanceRenderer({} as MapLibreMap, mock.gl, 1, undefined, ledger);
    renderer.ensureShader(SHADER_DATA);
    const instances = new Float32Array(5 * ROW_POINT_STRIDE);
    // Rows 0, 1, 2 have 1, 2 and 2 instances (row 1 is a MultiPoint)
    const batch = renderer.buildRetainedRows(instances, 5, [0, 0], Int32Array.of(0, 1, 3, 5));
    if (!batch) throw new Error('batch');
    expect(ledger.snapshot().byOwner.points).toBeGreaterThanOrEqual(5 * ROW_POINT_STRIDE * 4);

    mock.clear();
    renderer.drawRetainedRange(batch, 1, 3, 12, projection(), binding(mock.gl, 3));
    const draws = mock.of('drawArraysInstanced');
    expect(draws).toHaveLength(1);
    expect(draws[0].args[3]).toBe(4);
    // The attribute of the positions starts at instance 1, the one of the row is at location 8
    const pointers = mock.of('vertexAttribPointer');
    expect(pointers.find((call) => call.args[0] === 1)?.args[5]).toBe(ROW_POINT_STRIDE * 4);
    expect(pointers.find((call) => call.args[0] === 8)?.args[5]).toBe(
      ROW_POINT_STRIDE * 4 + 14 * 4,
    );
    // The variant of the rows is a program of its own, built from TABLE_ROWS
    expect(mock.sources.some((source) => source.includes('#define TABLE_ROWS'))).toBe(true);
    expect(
      mock
        .of('uniform1i')
        .some((call) => (call.args[0] as { name: string }).name === 'u_row_state'),
    ).toBe(true);

    renderer.disposeRetained(batch);
    expect(ledger.snapshot().byOwner.points ?? 0).toBe(0);
  });

  it('draws nothing for an empty range', () => {
    const mock = createGL();
    const renderer = new PointInstanceRenderer({} as MapLibreMap, mock.gl, 1);
    renderer.ensureShader(SHADER_DATA);
    const batch = renderer.buildRetainedRows(
      new Float32Array(ROW_POINT_STRIDE * 2),
      2,
      [0, 0],
      Int32Array.of(0, 0, 2),
    );
    if (!batch) throw new Error('batch');
    mock.clear();
    renderer.drawRetainedRange(batch, 0, 1, 12, projection(), binding(mock.gl, 2));
    expect(mock.of('drawArraysInstanced')).toHaveLength(0);
  });
});

describe('a line batch of rows', () => {
  it('draws a range of rows from the first instance of the range', () => {
    const mock = createGL();
    const ledger = new GpuLedger();
    const renderer = new SDFLineRenderer({} as MapLibreMap, mock.gl, 1);
    renderer.useLedger(ledger);
    renderer.ensureShader(SHADER_DATA);
    const instanceCount = 6;
    const batch = renderer.buildRetainedRows(
      {
        texData: new Float32Array(4 * 4 * 4),
        texSize: 4,
        instanceData: new Float32Array(instanceCount * ROW_LINE_STRIDE),
        instanceCount,
        maxSegmentMeters: 10,
        maxSegmentMercator: 0,
      },
      [0, 0],
      Int32Array.of(0, 2, 6),
    );
    if (!batch) throw new Error('batch');
    mock.clear();
    renderer.drawRetainedRange(batch, 1, 2, 12, projection(), binding(mock.gl, 2));
    const draws = mock.of('drawArraysInstanced');
    expect(draws).toHaveLength(1);
    expect(draws[0].args[3]).toBe(4);
    const pointers = mock.of('vertexAttribPointer');
    expect(pointers.find((call) => call.args[0] === 2)?.args[5]).toBe(2 * ROW_LINE_STRIDE * 4);
    expect(pointers.find((call) => call.args[0] === 5)?.args[5]).toBe(2 * ROW_LINE_STRIDE * 4 + 48);

    const held = ledger.snapshot().byOwner.lines;
    renderer.disposeRetainedBatch(batch);
    expect(ledger.snapshot().byOwner.lines).toBeLessThan(held);
  });
});

describe('a polygon batch of rows', () => {
  it('is one buffer of its size, filled in slices, and draws a range of rows as one range of indices', () => {
    const mock = createGL();
    const ledger = new GpuLedger();
    const renderer = new SDFPolygonRenderer(mock.gl, 1, { gpu: ledger });
    renderer.ensureShader(SHADER_DATA);
    const batch = renderer.createRetainedRows(10, 30, [0, 0], Int32Array.of(0, 12, 30));
    if (!batch) throw new Error('batch');
    const sizes = mock
      .of('bufferData')
      .map((call) => call.args[1])
      .filter((size) => typeof size === 'number');
    expect(sizes).toEqual([10 * ROW_POLYGON_STRIDE * 4, 30 * 4]);
    expect(ledger.snapshot().byOwner.polygons).toBe(10 * ROW_POLYGON_STRIDE * 4 + 30 * 4);

    mock.clear();
    renderer.writeRetainedRows(
      batch,
      new Float32Array(4 * ROW_POLYGON_STRIDE),
      6,
      new Uint32Array(12),
      18,
    );
    const writes = mock.of('bufferSubData');
    expect(writes.map((call) => call.args[1])).toEqual([6 * ROW_POLYGON_STRIDE * 4, 18 * 4]);

    mock.clear();
    renderer.drawRetainedRange(batch, 1, 2, 12, projection(), [800, 600], binding(mock.gl, 2));
    const draws = mock.of('drawElements');
    expect(draws).toHaveLength(1);
    expect(draws[0].args).toEqual([CONSTANTS.TRIANGLES, 18, CONSTANTS.UNSIGNED_INT, 12 * 4]);

    renderer.disposeRetained(batch);
    expect(ledger.snapshot().byOwner.polygons ?? 0).toBe(0);
  });
});
