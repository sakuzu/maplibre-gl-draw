// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The vertices every retained batch of a renderer shares
 *
 * The vertices of the stations of a line segment and of the billboard of a point are the same
 * for every batch, so a renderer holds one buffer of each and the vertex array of every batch
 * points at it:
 *
 * - a batch makes no buffer of them, and its release does not delete the shared one
 * - the ledger counts the shared buffer once, however many batches point at it
 * - the renderer deletes it when it is disposed (the context lost, or the layer removed), and
 *   the renderer made after a restore makes a new one, which its batches point at
 */

import type { Map as MapLibreMap, ProjectionData } from 'maplibre-gl';
import { describe, expect, it } from 'vitest';
import { GpuLedger } from '../gpu-ledger.js';
import type { ShaderData } from '../shaders/helpers.js';
import { ROW_LINE_STRIDE, STATION_VERTICES } from './line/line-geometry.js';
import { SDFLineRenderer } from './line/sdf-line.js';
import { PointInstanceRenderer, ROW_POINT_STRIDE } from './point/point-instance.js';

/** The bytes of the vertices of the billboard (4 vertices of 2 floats) */
const BILLBOARD_BYTES = 8 * 4;

const projection = (): ProjectionData =>
  ({
    mainMatrix: new Float32Array(16),
    tileMercatorCoords: [0, 0, 1, 1],
    clippingPlane: [0, 0, 0, 0],
    projectionTransition: 0,
    fallbackMatrix: new Float32Array(16),
  }) as unknown as ProjectionData;

const SHADER_DATA: ShaderData = { vertexShaderPrelude: '', define: '', variantName: 'mercator' };

interface Call {
  name: string;
  args: unknown[];
}

/**
 * A GL that records every call; while `lost`, it makes no buffer, as a lost context does (the
 * programs are still made, so that what is tested is the guard of the shared buffer)
 */
function createGL() {
  const calls: Call[] = [];
  const live = new Set<object>();
  const state = { lost: false };
  let next = 1;
  const target: Record<string, unknown> = {
    drawingBufferWidth: 800,
    drawingBufferHeight: 600,
    canvas: { width: 800, height: 600 },
  };
  const gl = new Proxy(target, {
    get(t, prop: string) {
      if (prop in t) return t[prop];
      if (/^[A-Z_0-9]+$/.test(prop)) return prop.length;
      return (...args: unknown[]) => {
        calls.push({ name: prop, args });
        if (prop.startsWith('create')) {
          if (state.lost && prop === 'createBuffer') return null;
          const object = { id: next++, kind: prop };
          live.add(object);
          return object;
        }
        if (prop.startsWith('delete')) {
          live.delete(args[0] as object);
          return undefined;
        }
        if (prop === 'getShaderParameter' || prop === 'getProgramParameter') return true;
        if (prop === 'getUniformLocation') return { name: args[1] };
        if (prop === 'getParameter') return 4096;
        return undefined;
      };
    },
  }) as unknown as WebGL2RenderingContext;
  return {
    gl,
    calls,
    state,
    live,
    of: (name: string) => calls.filter((call) => call.name === name),
    clear: () => {
      calls.length = 0;
    },
  };
}

type Mock = ReturnType<typeof createGL>;

/** The buffers bound to ARRAY_BUFFER when the attribute at `location` was pointed */
function pointedBuffers(mock: Mock, location: number): unknown[] {
  const out: unknown[] = [];
  let bound: unknown = null;
  for (const call of mock.calls) {
    if (call.name === 'bindBuffer' && call.args[0] === 'ARRAY_BUFFER'.length) bound = call.args[1];
    if (call.name === 'vertexAttribPointer' && call.args[0] === location) out.push(bound);
  }
  return out;
}

/** The buffer the attribute of the vertices (location 0) was last pointed at */
function lastPointed(mock: Mock): unknown {
  const pointed = pointedBuffers(mock, 0);
  return pointed[pointed.length - 1];
}

const LINE_ITEM = {
  coords: [
    [0, 0],
    [1, 1],
    [2, 0],
  ] as Array<[number, number]>,
  featureId: 'a',
  closed: false,
  strokeWidth: 2,
  createdZoom: 10,
  color: [1, 0, 0, 1] as [number, number, number, number],
  opacity: 1,
};

function lineRenderer(mock: Mock, ledger: GpuLedger): SDFLineRenderer {
  const renderer = new SDFLineRenderer({} as MapLibreMap, mock.gl, ledger, 1);
  renderer.ensureShader(SHADER_DATA);
  return renderer;
}

function lineRows(renderer: SDFLineRenderer) {
  return renderer.buildRetainedRows(
    {
      texData: new Float32Array(2 * 2 * 4),
      texSize: 2,
      instanceData: new Float32Array(2 * ROW_LINE_STRIDE),
      instanceCount: 2,
      maxSegmentMeters: 10,
      maxSegmentMercator: 0,
    },
    [0, 0],
    Int32Array.of(0, 2),
  );
}

describe('the vertices of the stations of the lines', () => {
  it('are one buffer the batches of a renderer point at, counted once', () => {
    const mock = createGL();
    const ledger = new GpuLedger();
    const renderer = lineRenderer(mock, ledger);
    const alone = ledger.snapshot().byOwner.lines;
    expect(alone).toBe(STATION_VERTICES.byteLength);

    const batches = [
      renderer.buildRetainedBatch([LINE_ITEM], { lineStyle: 'solid' }),
      renderer.buildRetainedBatch([LINE_ITEM], { lineStyle: 'solid' }),
      lineRows(renderer),
    ];
    for (const batch of batches) expect(batch).not.toBeNull();
    // The vertices of the stations are uploaded once, by the renderer
    const uploads = mock.of('bufferData').map((call) => call.args[1]);
    expect(uploads.filter((data) => data === STATION_VERTICES)).toHaveLength(1);
    // The vertex array of the immediate mode and those of the batches point the stations
    // (location 0) at the same buffer
    const pointed = pointedBuffers(mock, 0);
    expect(pointed).toHaveLength(4);
    expect(new Set(pointed).size).toBe(1);
    expect(pointed[0]).not.toBeNull();

    // Once the batches are released, the ledger holds the shared buffer alone, once
    for (const batch of batches) if (batch) renderer.disposeRetainedBatch(batch);
    expect(ledger.snapshot().byOwner.lines).toBe(STATION_VERTICES.byteLength);
    // Releasing the batches does not delete the shared buffer
    expect(mock.live.has(pointed[0] as object)).toBe(true);

    renderer.dispose();
    expect(mock.live.has(pointed[0] as object)).toBe(false);
    expect(ledger.snapshot().byOwner.lines ?? 0).toBe(0);
  });

  it('are made again by the renderer made after the context is restored', () => {
    const mock = createGL();
    const ledger = new GpuLedger();
    const lost = lineRenderer(mock, ledger);
    const before = lost.buildRetainedBatch([LINE_ITEM], { lineStyle: 'solid' });
    if (!before) throw new Error('batch');
    const oldStations = lastPointed(mock);

    // The loss drops the batches, then the renderer (as the engine does)
    mock.state.lost = true;
    lost.disposeRetainedBatch(before);
    lost.dispose();
    expect(ledger.snapshot().byOwner.lines ?? 0).toBe(0);

    // A renderer made while the context is lost has no shared buffer and builds nothing
    const during = lineRenderer(mock, ledger);
    expect(during.buildRetainedBatch([LINE_ITEM], { lineStyle: 'solid' })).toBeNull();
    during.dispose();

    // The restore makes a new renderer, a new buffer, and batches that point at it
    mock.state.lost = false;
    mock.clear();
    const restored = lineRenderer(mock, ledger);
    const after = restored.buildRetainedBatch([LINE_ITEM], { lineStyle: 'solid' });
    if (!after) throw new Error('batch');
    const newStations = lastPointed(mock);
    expect(newStations).not.toBe(oldStations);
    expect(mock.live.has(newStations as object)).toBe(true);
    restored.disposeRetainedBatch(after);
    expect(ledger.snapshot().byOwner.lines).toBe(STATION_VERTICES.byteLength);
  });
});

const POINT = {
  coord: [0, 0] as [number, number],
  fillColor: [1, 0, 0, 1] as [number, number, number, number],
  fillSize: 4,
  strokeColor: [0, 0, 0, 1] as [number, number, number, number],
  strokeWidth: 1,
};

function pointRenderer(mock: Mock, ledger: GpuLedger): PointInstanceRenderer {
  const renderer = new PointInstanceRenderer({} as MapLibreMap, mock.gl, ledger, 1, undefined);
  renderer.ensureShader(SHADER_DATA);
  return renderer;
}

describe('the vertices of the billboard of the points', () => {
  it('are one buffer the batches and the immediate mode point at, counted once', () => {
    const mock = createGL();
    const ledger = new GpuLedger();
    const renderer = pointRenderer(mock, ledger);
    expect(ledger.snapshot().byOwner.points).toBe(BILLBOARD_BYTES);

    // The immediate mode draws through a vertex array of its own
    renderer.setProjectionData(projection());
    renderer.drawAll([POINT], 'circle');
    const immediate = lastPointed(mock);
    expect(immediate).toBeDefined();
    // The billboard and the instances of the immediate mode
    const held = ledger.snapshot().byOwner.points;
    mock.clear();
    const batches = [
      renderer.buildRetained([POINT], 'circle'),
      renderer.buildRetainedPacked(
        { count: 1, lngLat: Float64Array.of(0, 0), style: new Float64Array(10) },
        'circle',
      ),
      renderer.buildRetainedRows(
        new Float32Array(ROW_POINT_STRIDE),
        1,
        [0, 0],
        Int32Array.of(0, 1),
      ),
    ];
    for (const batch of batches) expect(batch).not.toBeNull();
    const pointed = pointedBuffers(mock, 0);
    expect(pointed).toHaveLength(3);
    expect(new Set([...pointed, immediate]).size).toBe(1);
    // Only the instances are uploaded (the billboard was uploaded once, by the renderer)
    expect(mock.of('bufferData')).toHaveLength(3);

    for (const batch of batches) if (batch) renderer.disposeRetained(batch);
    expect(ledger.snapshot().byOwner.points).toBe(held);
    expect(mock.live.has(pointed[0] as object)).toBe(true);

    // A new variant of the shaders makes new vertex arrays of the immediate mode, not a new buffer
    renderer.ensureShader({ ...SHADER_DATA, variantName: 'globe' });
    expect(mock.live.has(pointed[0] as object)).toBe(true);
    expect(ledger.snapshot().byOwner.points).toBe(held);

    renderer.dispose();
    expect(mock.live.has(pointed[0] as object)).toBe(false);
    expect(ledger.snapshot().byOwner.points ?? 0).toBe(0);
  });

  it('are made again by the renderer made after the context is restored', () => {
    const mock = createGL();
    const ledger = new GpuLedger();
    const lost = pointRenderer(mock, ledger);
    const before = lost.buildRetained([POINT], 'circle');
    if (!before) throw new Error('batch');
    const oldBillboard = lastPointed(mock);

    mock.state.lost = true;
    lost.disposeRetained(before);
    lost.dispose();
    expect(ledger.snapshot().byOwner.points ?? 0).toBe(0);

    const during = pointRenderer(mock, ledger);
    expect(during.buildRetained([POINT], 'circle')).toBeNull();
    during.dispose();

    mock.state.lost = false;
    mock.clear();
    const restored = pointRenderer(mock, ledger);
    const after = restored.buildRetained([POINT], 'circle');
    if (!after) throw new Error('batch');
    const newBillboard = lastPointed(mock);
    expect(newBillboard).not.toBe(oldBillboard);
    expect(mock.live.has(newBillboard as object)).toBe(true);
    restored.disposeRetained(after);
    expect(ledger.snapshot().byOwner.points).toBe(BILLBOARD_BYTES);
  });
});
