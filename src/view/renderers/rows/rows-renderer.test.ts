// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The renderer that draws rows of every kind in one draw, on a GL that records its calls
 *
 * - Its shaders never read `gl_InstanceID` (a range of rows is drawn by pointing the instance
 *   attributes at its first instance)
 * - Nothing is written to the GPU while a frame is drawn: a chunk, the values of the styles and
 *   the writes in place are written by `flushUploads`, and a chunk is drawn after it
 * - A range of rows is one draw of the instances of its rows
 * - A write in place is taken only when the rows packed again have the instances the chunk holds
 * - The program is not waited for where the context compiles in parallel
 * - What it allocates is in the ledger, and leaves it when released
 */

import type { ProjectionData } from 'maplibre-gl';
import { describe, expect, it } from 'vitest';
import { GpuLedger } from '../../gpu-ledger.js';
import { beginRenderFrame } from '../../shaders/frame.js';
import type { ShaderData } from '../../shaders/helpers.js';
import { ROW_STATE_WIDTH, type RowStateBinding } from '../row-state.js';
import {
  ROWS_INSTANCE_BYTES,
  ROWS_KIND,
  type RowsChunkData,
  RowsPalette,
  writeRowsInstance,
} from './rows-format.js';
import { RowsRenderer } from './rows-renderer.js';
import { buildRowsFragmentSource, buildRowsVertexSource } from './rows-shader.js';

const SHADER_DATA: ShaderData = { vertexShaderPrelude: '', define: '', variantName: 'mercator' };
const PROJECTION = {
  mainMatrix: new Float32Array(16),
  projectionTransition: 0,
} as unknown as ProjectionData;

interface Call {
  readonly name: string;
  readonly args: unknown[];
}

/**
 * A GL that records its calls. `complete` answers `COMPLETION_STATUS_KHR` when the context
 * compiles in parallel (it does when `parallel` is set)
 */
function recordingGL(options: { parallel?: boolean; complete?: () => boolean } = {}) {
  const calls: Call[] = [];
  let next = 1;
  const target: Record<string, unknown> = {
    drawingBufferWidth: 800,
    drawingBufferHeight: 600,
  };
  const gl = new Proxy(target, {
    get(t, prop: string) {
      if (prop in t) return t[prop];
      if (/^[A-Z_0-9]+$/.test(prop)) return prop.length;
      return (...args: unknown[]) => {
        calls.push({ name: prop, args });
        if (prop.startsWith('create')) return { id: next++ };
        if (prop === 'getExtension') return options.parallel ? {} : null;
        if (prop === 'getProgramParameter') {
          return args[1] === 0x91b1 ? (options.complete?.() ?? true) : true;
        }
        if (prop === 'getUniformLocation') return { name: args[1] };
        if (prop === 'getParameter') return 4;
        return undefined;
      };
    },
  }) as unknown as WebGL2RenderingContext;
  return {
    gl,
    calls,
    names: (from = 0) => calls.slice(from).map((c) => c.name),
    count: (name: string, from = 0) => calls.slice(from).filter((c) => c.name === name).length,
  };
}

/**
 * The packed arrays of a chunk of `rows` rows: row `r` has `r + 1` points (so the rows have
 * different numbers of instances), every point a coordinate of its own
 */
function chunkData(rows: number, palette = new RowsPalette()): RowsChunkData {
  palette.add([1, 0, 0, 1, 0, 0, 0, 1, 4, 1, 0, 0, 0, 0, 0, 0]);
  const rowFirst = new Int32Array(rows + 1);
  for (let r = 0; r < rows; r++) rowFirst[r + 1] = rowFirst[r] + r + 1;
  const count = rowFirst[rows];
  const instances = new Float32Array(count * 8);
  const coords = new Float32Array(count * 2);
  let i = 0;
  for (let r = 0; r < rows; r++) {
    for (let k = 0; k <= r; k++) {
      writeRowsInstance(instances, i, ROWS_KIND.point, r, i, -1, -1, -1);
      coords[i * 2] = r;
      coords[i * 2 + 1] = k;
      i++;
    }
  }
  return {
    origin: [139, 35],
    rowBase: 0,
    rows,
    instances,
    instanceCount: count,
    points: instances.slice(),
    pointCount: count,
    coords,
    coordCount: count,
    rowStyles: new Float32Array(rows * 4),
    rowFirst,
    pointFirst: rowFirst.slice(),
    coordFirst: rowFirst.slice(),
    palette,
    sprites: null,
  };
}

function binding(): RowStateBinding {
  return {
    texture: { texture: {} as WebGLTexture, width: ROW_STATE_WIDTH, height: 1, rows: 10 },
    translations: new Float32Array(8),
  };
}

describe('the shaders of the drawing in one draw', () => {
  it('never read gl_InstanceID', () => {
    const vertex = buildRowsVertexSource('', '');
    const fragment = buildRowsFragmentSource();
    expect(vertex).not.toContain('gl_InstanceID');
    expect(fragment).not.toContain('gl_InstanceID');
    // Every kind has its branch in both stages
    for (const kind of Object.values(ROWS_KIND)) {
      expect(vertex.includes(`kind == ${kind}`) || kind === ROWS_KIND.sprite).toBe(true);
    }
    expect(fragment).toContain('texture(u_sprites');
  });
});

describe('RowsRenderer', () => {
  it('writes a chunk only when the uploads are flushed, and draws it after that', () => {
    const mock = recordingGL();
    const renderer = new RowsRenderer(null, mock.gl, 1);
    renderer.ensureShader(SHADER_DATA);
    expect(renderer.ready).toBe(true);
    const chunk = renderer.createChunk(chunkData(4));
    beginRenderFrame();
    const before = mock.calls.length;
    renderer.drawRange(chunk, 0, 4, 14, PROJECTION, binding());
    // Not written yet: nothing is made, written or drawn
    expect(mock.names(before)).toEqual([]);
    expect(renderer.hasPendingUploads).toBe(true);

    const flush = mock.calls.length;
    renderer.flushUploads();
    expect(chunk.uploaded).toBe(true);
    expect(renderer.hasPendingUploads).toBe(false);
    // The instance and the point buffers, the textures of the coordinates, of the styles of the
    // rows and of the values of the styles
    expect(mock.count('bufferData', flush)).toBe(2);
    expect(mock.count('texStorage2D', flush)).toBe(3);
    expect(mock.count('texSubImage2D', flush)).toBe(3);

    const draw = mock.calls.length;
    renderer.drawRange(chunk, 0, 4, 14, PROJECTION, binding());
    const names = mock.names(draw);
    expect(names.filter((n) => n.startsWith('draw'))).toEqual(['drawArraysInstanced']);
    // Nothing is written to a buffer or a texture while drawing
    for (const name of ['bufferData', 'bufferSubData', 'texSubImage2D', 'texStorage2D']) {
      expect(names).not.toContain(name);
    }
    const drawCall = mock.calls.filter((c) => c.name === 'drawArraysInstanced').at(-1) as Call;
    // A strip of 4 vertices per instance: the 10 points of the 4 rows
    expect(drawCall.args.slice(1)).toEqual([0, 4, 10]);
  });

  it('draws a range of rows by pointing the instance attributes at its first instance', () => {
    const mock = recordingGL();
    const renderer = new RowsRenderer(null, mock.gl, 1);
    renderer.ensureShader(SHADER_DATA);
    const chunk = renderer.createChunk(chunkData(4));
    renderer.flushUploads();
    beginRenderFrame();
    const at = mock.calls.length;
    // Rows 2 and 3: instances 3 to 9
    renderer.drawRange(chunk, 2, 4, 14, PROJECTION, binding());
    const pointers = mock.calls.slice(at).filter((c) => c.name === 'vertexAttribPointer');
    expect(pointers.map((c) => [c.args[0], c.args[5]])).toEqual([
      [1, 3 * ROWS_INSTANCE_BYTES],
      [2, 3 * ROWS_INSTANCE_BYTES + 16],
    ]);
    const drawCall = mock.calls.filter((c) => c.name === 'drawArraysInstanced').at(-1) as Call;
    expect(drawCall.args[3]).toBe(7);
    // The same range again needs no pointing
    const again = mock.calls.length;
    renderer.drawRange(chunk, 2, 4, 14, PROJECTION, binding());
    expect(mock.count('vertexAttribPointer', again)).toBe(0);
    // An empty range draws nothing
    const empty = mock.calls.length;
    renderer.drawRange(chunk, 2, 2, 14, PROJECTION, binding());
    expect(mock.count('drawArraysInstanced', empty)).toBe(0);
  });

  it('does not wait for the program where the context compiles in parallel', () => {
    let complete = false;
    const mock = recordingGL({ parallel: true, complete: () => complete });
    const renderer = new RowsRenderer(null, mock.gl, 1);
    renderer.ensureShader(SHADER_DATA);
    expect(renderer.ready).toBe(false);
    expect(renderer.compiling).toBe(true);
    // The link status is not asked while it compiles
    expect(mock.calls.some((c) => c.name === 'getProgramParameter' && c.args[1] !== 0x91b1)).toBe(
      false,
    );
    const chunk = renderer.createChunk(chunkData(2));
    renderer.flushUploads();
    beginRenderFrame();
    const at = mock.calls.length;
    renderer.drawRange(chunk, 0, 2, 14, PROJECTION, binding());
    expect(mock.count('drawArraysInstanced', at)).toBe(0);
    complete = true;
    expect(renderer.ready).toBe(true);
    expect(renderer.compiling).toBe(false);
    renderer.drawRange(chunk, 0, 2, 14, PROJECTION, binding());
    expect(mock.count('drawArraysInstanced', at)).toBe(1);
  });

  it('writes rows in place only when they have the instances the chunk holds', () => {
    const mock = recordingGL();
    const renderer = new RowsRenderer(null, mock.gl, 1);
    renderer.ensureShader(SHADER_DATA);
    const data = chunkData(4);
    const chunk = renderer.createChunk(data);
    renderer.flushUploads();

    // Rows 2 and 3 packed again on their own, at new places and with another style
    const rows = {
      ...data,
      rows: 2,
      rowBase: 2,
      instances: new Float32Array(7 * 8),
      instanceCount: 7,
      pointCount: 7,
      coords: new Float32Array(7 * 2).fill(5),
      coordCount: 7,
      rowStyles: Float32Array.of(1, 12, 1, 0, 1, 12, 1, 0),
      rowFirst: Int32Array.of(0, 3, 7),
      pointFirst: Int32Array.of(0, 3, 7),
      coordFirst: Int32Array.of(0, 3, 7),
    };
    for (let i = 0; i < 7; i++) {
      writeRowsInstance(rows.instances, i, ROWS_KIND.point, i < 3 ? 2 : 3, i, -1, -1, -1);
    }
    const at = mock.calls.length;
    expect(renderer.patchRows(chunk, 2, rows)).toBe(true);
    expect(Array.from(data.coords.subarray(6, 20))).toEqual(Array(14).fill(5));
    expect(Array.from(data.rowStyles.subarray(8, 16))).toEqual([1, 12, 1, 0, 1, 12, 1, 0]);
    // Uploaded with the next flush, not before
    expect(mock.count('texSubImage2D', at)).toBe(0);
    expect(renderer.hasPendingUploads).toBe(true);
    renderer.flushUploads();
    expect(mock.count('texSubImage2D', at)).toBe(2);

    // Another kind, another number of instances, or another palette: refused, nothing written
    const kind = { ...rows, instances: rows.instances.slice() };
    writeRowsInstance(kind.instances, 0, ROWS_KIND.fill, 2, 0, 1, 2, 2);
    const coords = data.coords.slice();
    expect(renderer.patchRows(chunk, 2, kind)).toBe(false);
    expect(renderer.patchRows(chunk, 2, { ...rows, instanceCount: 6 })).toBe(false);
    expect(renderer.patchRows(chunk, 2, { ...rows, palette: new RowsPalette() })).toBe(false);
    expect(Array.from(data.coords)).toEqual(Array.from(coords));
  });

  it('records what it allocates in the ledger and takes it out when released', () => {
    const mock = recordingGL();
    const ledger = new GpuLedger();
    const renderer = new RowsRenderer(null, mock.gl, 1, undefined, ledger);
    renderer.ensureShader(SHADER_DATA);
    const corners = ledger.snapshot().byOwner.rows;
    const palette = new RowsPalette();
    const chunk = renderer.createChunk(chunkData(4, palette));
    renderer.flushUploads();
    const held = ledger.snapshot().byOwner.rows;
    // The instances and the points (32 bytes each), and the three textures
    expect(held - corners).toBeGreaterThanOrEqual(2 * 10 * ROWS_INSTANCE_BYTES + 10 * 8);
    renderer.retirePalette(palette);
    // The palette stays while a chunk is built with it
    expect(palette.gpu).not.toBeNull();
    renderer.disposeChunk(chunk);
    expect(palette.gpu).toBeNull();
    expect(ledger.snapshot().byOwner.rows).toBe(corners);
    renderer.dispose();
    expect(ledger.snapshot().byOwner.rows).toBeUndefined();
  });

  it('makes a chunk released before its upload without writing it', () => {
    const mock = recordingGL();
    const renderer = new RowsRenderer(null, mock.gl, 1);
    const chunk = renderer.createChunk(chunkData(2));
    renderer.disposeChunk(chunk);
    const at = mock.calls.length;
    renderer.flushUploads();
    expect(mock.count('bufferData', at)).toBe(0);
    expect(chunk.uploaded).toBe(false);
  });
});
