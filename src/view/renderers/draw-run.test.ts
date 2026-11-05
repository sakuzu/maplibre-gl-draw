// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The run of retained draws, and what the draws of rows skip
 *
 * - Outside a run every draw sets its program, its vertex array and the texture of the state of
 *   the rows, and unbinds its vertex array, as a lone draw always did
 * - In a run, what the run set is not set again: the program in use, the texture of the state
 *   of the rows on its unit, the active unit; the vertex array is unbound once, at the end
 * - The run forgets everything (and unbinds the vertex array left) when it is told to before
 *   something else draws, when it ends, when a new run begins, and when a new frame starts
 * - A batch of rows points its instance attributes at the first instance of a range only when
 *   they point elsewhere
 * - The uniforms of the state of the rows and of the polygons of rows are written when their
 *   values change, and all again in a new frame or with a new program
 */

import type { Map as MapLibreMap, ProjectionData } from 'maplibre-gl';
import { describe, expect, it } from 'vitest';
import { GpuLedger } from '../gpu-ledger.js';
import { beginRenderFrame } from '../shaders/frame.js';
import type { ShaderData } from '../shaders/helpers.js';
import { retainedDrawRun } from './draw-run.js';
import { ROW_LINE_STRIDE } from './line/line-geometry.js';
import { SDFLineRenderer } from './line/sdf-line.js';
import { PointInstanceRenderer, ROW_POINT_STRIDE } from './point/point-instance.js';
import { SDFPolygonRenderer } from './polygon/sdf-polygon.js';
import { createRowStateTexture, type RowStateBinding } from './row-state.js';

interface Call {
  name: string;
  args: unknown[];
}

/** A GL that records every call */
function createGL() {
  const calls: Call[] = [];
  let next = 1;
  const target: Record<string, unknown> = {
    drawingBufferWidth: 800,
    drawingBufferHeight: 600,
    canvas: { width: 800, height: 600 },
  };
  const gl = new Proxy(target, {
    get(t, prop: string) {
      if (prop in t) return t[prop];
      if (/^[A-Z_0-9]+$/.test(prop)) return prop === 'TEXTURE0' ? 100 : prop.length;
      return (...args: unknown[]) => {
        calls.push({ name: prop, args });
        if (prop.startsWith('create')) return { id: next++, kind: prop };
        if (prop === 'getShaderParameter' || prop === 'getProgramParameter') return true;
        if (prop === 'getUniformLocation') return { name: args[1] };
        if (prop === 'getParameter') return 4;
        return undefined;
      };
    },
  }) as unknown as WebGL2RenderingContext;
  return {
    gl,
    of: (name: string) => calls.filter((call) => call.name === name),
    uniform: (name: string) =>
      calls.filter(
        (call) =>
          call.name.startsWith('uniform') && (call.args[0] as { name?: string })?.name === name,
      ),
    clear: () => {
      calls.length = 0;
    },
  };
}

type Mock = ReturnType<typeof createGL>;

const SHADER_DATA: ShaderData = { vertexShaderPrelude: '', define: '', variantName: 'mercator' };

const projection = (): ProjectionData =>
  ({
    mainMatrix: new Float32Array(16),
    tileMercatorCoords: [0, 0, 1, 1],
    clippingPlane: [0, 0, 0, 0],
    projectionTransition: 0,
    fallbackMatrix: new Float32Array(16),
  }) as unknown as ProjectionData;

function binding(mock: Mock, rows: number, translations = new Float32Array(8)): RowStateBinding {
  const texture = createRowStateTexture(mock.gl, rows);
  if (!texture) throw new Error('texture');
  return { texture, translations };
}

/** The renderers of a context, with a point batch and a line batch of rows */
function setup() {
  const mock = createGL();
  const point = new PointInstanceRenderer({} as MapLibreMap, mock.gl, new GpuLedger(), 1);
  point.ensureShader(SHADER_DATA);
  const line = new SDFLineRenderer({} as MapLibreMap, mock.gl, new GpuLedger(), 1);
  line.ensureShader(SHADER_DATA);
  const polygon = new SDFPolygonRenderer(mock.gl, { gpu: new GpuLedger() }, 1);
  polygon.ensureShader(SHADER_DATA);
  const points = point.buildRetainedRows(
    new Float32Array(4 * ROW_POINT_STRIDE),
    4,
    [0, 0],
    Int32Array.of(0, 1, 2, 3, 4),
  );
  const lines = line.buildRetainedRows(
    {
      texData: new Float32Array(2 * 2 * 4),
      texSize: 2,
      instanceData: new Float32Array(4 * ROW_LINE_STRIDE),
      instanceCount: 4,
      maxSegmentMeters: 10,
      maxSegmentMercator: 0,
    },
    [0, 0],
    Int32Array.of(0, 2, 4),
  );
  const polygons = polygon.createRetainedRows(8, 12, [0, 0], Int32Array.of(0, 6, 12));
  if (!points || !lines || !polygons) throw new Error('batch');
  const run = retainedDrawRun(mock.gl);
  return { mock, point, line, polygon, points, lines, polygons, run };
}

describe('the draws of rows outside a run', () => {
  it('set everything and unbind their vertex array every time', () => {
    const { mock, point, points } = setup();
    const state = binding(mock, 4);
    beginRenderFrame();
    mock.clear();
    point.drawRetainedRange(points, 0, 2, projection(), state);
    point.drawRetainedRange(points, 0, 2, projection(), state);
    expect(mock.of('useProgram')).toHaveLength(2);
    expect(mock.of('bindVertexArray').map((call) => call.args[0])).toEqual([
      points.vao,
      null,
      points.vao,
      null,
    ]);
    expect(mock.of('bindTexture')).toHaveLength(2);
  });
});

describe('the draws of rows in a run', () => {
  it('skip the program, the texture of the state and the unit set by the run, and unbind once', () => {
    const { mock, point, line, points, lines, run } = setup();
    const state = binding(mock, 4);
    beginRenderFrame();
    mock.clear();
    run.begin();
    point.drawRetainedRange(points, 0, 2, projection(), state);
    point.drawRetainedRange(points, 0, 2, projection(), state);
    line.drawRetainedRange(lines, 0, 2, 12, projection(), state);
    line.drawRetainedRange(lines, 0, 2, 12, projection(), state);
    // One program per change of program
    expect(mock.of('useProgram')).toHaveLength(2);
    // The texture of the state is bound once for the group; the unit 0 is left active by it, so
    // the lines bind their coordinates on it without choosing it again
    const units = mock.of('activeTexture').map((call) => call.args[0]);
    expect(units).toEqual([101, 100]);
    expect(
      mock.of('bindTexture').filter((call) => call.args[1] === state.texture.texture),
    ).toHaveLength(1);
    expect(mock.of('bindTexture').filter((call) => call.args[1] === lines.texture)).toHaveLength(2);
    // The vertex arrays stay bound until the run ends
    expect(mock.of('bindVertexArray').some((call) => call.args[0] === null)).toBe(false);
    run.end();
    expect(mock.of('bindVertexArray').filter((call) => call.args[0] === null)).toHaveLength(1);
  });

  it('bind the texture of the state again for another group', () => {
    const { mock, point, points, run } = setup();
    const first = binding(mock, 4);
    const second = binding(mock, 4);
    beginRenderFrame();
    mock.clear();
    run.begin();
    point.drawRetainedRange(points, 0, 1, projection(), first);
    point.drawRetainedRange(points, 1, 2, projection(), second);
    point.drawRetainedRange(points, 2, 3, projection(), second);
    run.end();
    expect(mock.of('bindTexture').map((call) => call.args[1])).toEqual([
      first.texture.texture,
      second.texture.texture,
    ]);
  });

  it('set everything again after the run is told that something else drew', () => {
    const { mock, point, points, run } = setup();
    const state = binding(mock, 4);
    beginRenderFrame();
    run.begin();
    point.drawRetainedRange(points, 0, 2, projection(), state);
    mock.clear();
    run.forget();
    // The vertex array left bound is unbound before the other drawing
    expect(mock.of('bindVertexArray').map((call) => call.args[0])).toEqual([null]);
    mock.clear();
    point.drawRetainedRange(points, 0, 2, projection(), state);
    expect(mock.of('useProgram')).toHaveLength(1);
    expect(mock.of('bindTexture')).toHaveLength(1);
    expect(mock.of('activeTexture')).toHaveLength(2);
    run.end();
  });

  it('set everything again in a new frame, and in a new run', () => {
    const { mock, point, points, run } = setup();
    const state = binding(mock, 4);
    beginRenderFrame();
    run.begin();
    point.drawRetainedRange(points, 0, 2, projection(), state);
    // A frame that starts while a run is open (its end was skipped) trusts nothing of it
    beginRenderFrame();
    mock.clear();
    point.drawRetainedRange(points, 0, 2, projection(), state);
    expect(mock.of('useProgram')).toHaveLength(1);
    expect(mock.of('bindTexture')).toHaveLength(1);
    // A run that begins forgets the one before
    mock.clear();
    run.begin();
    point.drawRetainedRange(points, 0, 2, projection(), state);
    expect(mock.of('bindVertexArray').map((call) => call.args[0])).toEqual([null, points.vao]);
    expect(mock.of('useProgram')).toHaveLength(1);
    expect(mock.of('bindTexture')).toHaveLength(1);
    run.end();
  });

  it('write a program again whenever the program in use changes', () => {
    const { mock, point, polygon, points, polygons, run } = setup();
    const state = binding(mock, 4);
    beginRenderFrame();
    mock.clear();
    run.begin();
    point.drawRetainedRange(points, 0, 1, projection(), state);
    polygon.drawRetainedRange(polygons, 0, 1, 12, projection(), [800, 600], state);
    point.drawRetainedRange(points, 1, 2, projection(), state);
    run.end();
    expect(mock.of('useProgram')).toHaveLength(3);
  });
});

describe('the instance attributes of a batch of rows', () => {
  it('are pointed at the first instance of a range only when they point elsewhere', () => {
    const { mock, point, line, points, lines } = setup();
    const state = binding(mock, 4);
    beginRenderFrame();
    const pointers = (draw: () => void): number => {
      mock.clear();
      draw();
      return mock.of('vertexAttribPointer').length;
    };
    const drawPoints = (from: number, to: number) => () =>
      point.drawRetainedRange(points, from, to, projection(), state);
    // A range from the first row: the attributes point there since the build
    expect(pointers(drawPoints(0, 2))).toBe(0);
    // Another first instance: the 8 attributes of the instances are pointed again (no enabling)
    expect(pointers(drawPoints(2, 4))).toBe(8);
    expect(mock.of('enableVertexAttribArray')).toHaveLength(0);
    expect(mock.of('vertexAttribPointer')[0].args[5]).toBe(2 * ROW_POINT_STRIDE * 4);
    expect(pointers(drawPoints(2, 3))).toBe(0);
    // Back to the first row: pointed back
    expect(pointers(drawPoints(0, 4))).toBe(8);
    expect(mock.of('vertexAttribPointer')[0].args[5]).toBe(0);

    const drawLines = (from: number, to: number) => () =>
      line.drawRetainedRange(lines, from, to, 12, projection(), state);
    expect(pointers(drawLines(0, 2))).toBe(0);
    expect(pointers(drawLines(1, 2))).toBe(4);
    expect(mock.of('vertexAttribPointer')[0].args[5]).toBe(2 * ROW_LINE_STRIDE * 4);
    expect(pointers(drawLines(1, 2))).toBe(0);
    expect(pointers(drawLines(0, 1))).toBe(4);
  });
});

describe('the uniforms of the draws of rows', () => {
  it('of the state of the rows are written when they change, and all in a new frame', () => {
    const { mock, point, points } = setup();
    const translations = new Float32Array(8);
    const state = binding(mock, 4, translations);
    beginRenderFrame();
    mock.clear();
    point.drawRetainedRange(points, 0, 1, projection(), state);
    point.drawRetainedRange(points, 1, 2, projection(), state);
    expect(mock.uniform('u_row_state')).toHaveLength(1);
    expect(mock.uniform('u_row_state_width')).toHaveLength(1);
    expect(mock.uniform('u_state_translate')).toHaveLength(1);
    // The translations are the same array, written in place by the caller
    translations[2] = 0.5;
    point.drawRetainedRange(points, 2, 3, projection(), state);
    expect(mock.uniform('u_state_translate')).toHaveLength(2);
    expect(mock.uniform('u_row_state')).toHaveLength(1);
    beginRenderFrame();
    point.drawRetainedRange(points, 0, 1, projection(), state);
    expect(mock.uniform('u_row_state')).toHaveLength(2);
    expect(mock.uniform('u_row_state_width')).toHaveLength(2);
    expect(mock.uniform('u_state_translate')).toHaveLength(3);
  });

  it('of the polygons of rows are written when they change, and all in a new frame', () => {
    const { mock, polygon, polygons } = setup();
    const state = binding(mock, 2);
    const names = ['u_viewport', 'u_zoom', 'u_miterLimit', 'u_size_scale', 'u_opacity'];
    const writes = () => names.map((name) => mock.uniform(name).length);
    beginRenderFrame();
    mock.clear();
    polygon.drawRetainedRange(polygons, 0, 1, 12, projection(), [800, 600], state);
    expect(writes()).toEqual([1, 1, 1, 1, 1]);
    polygon.drawRetainedRange(polygons, 1, 2, 12, projection(), [800, 600], state);
    expect(writes()).toEqual([1, 1, 1, 1, 1]);
    polygon.drawRetainedRange(polygons, 0, 2, 13, projection(), [800, 600], state, {
      scale: 1,
      opacity: 0.5,
    });
    expect(writes()).toEqual([1, 2, 1, 1, 2]);
    beginRenderFrame();
    polygon.drawRetainedRange(polygons, 0, 2, 13, projection(), [800, 600], state);
    expect(writes()).toEqual([2, 3, 2, 2, 3]);
  });

  it('start anew with a program made again', () => {
    const { mock, polygon, polygons } = setup();
    const state = binding(mock, 2);
    beginRenderFrame();
    polygon.drawRetainedRange(polygons, 0, 1, 12, projection(), [800, 600], state);
    // A new variant makes the programs again, whose uniforms start from their initial values
    polygon.ensureShader({ ...SHADER_DATA, variantName: 'globe' });
    mock.clear();
    polygon.drawRetainedRange(polygons, 0, 1, 12, projection(), [800, 600], state);
    expect(mock.uniform('u_viewport')).toHaveLength(1);
    expect(mock.uniform('u_row_state')).toHaveLength(1);
  });
});
