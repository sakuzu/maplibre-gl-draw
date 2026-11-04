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
import { describe, expect, it, vi } from 'vitest';
import { GpuLedger } from '../../gpu-ledger.js';
import { beginRenderFrame } from '../../shaders/frame.js';
import { calculateOffsetUniforms, type ShaderData } from '../../shaders/helpers.js';
import { TerrainContext } from '../../terrain/context.js';
import { DRAPE_GROUND_BLOCK_TEXELS } from '../../terrain/drape/ground-depth.js';
import { ROW_STATE_WIDTH, type RowStateBinding } from '../row-state.js';
import {
  ROWS_INSTANCE_BYTES,
  ROWS_KIND,
  type RowSpriteSource,
  type RowsChunkData,
  RowsPalette,
  readRowsInstance,
  writeRowsInstance,
} from './rows-format.js';
import { RowsRenderer, writeSpriteScaleStops } from './rows-renderer.js';
import { buildRowsFragmentSource, buildRowsVertexSource } from './rows-shader.js';

const SHADER_DATA: ShaderData = { vertexShaderPrelude: '', define: '', variantName: 'mercator' };
const PROJECTION = {
  mainMatrix: new Float32Array(16),
  projectionTransition: 0,
} as unknown as ProjectionData;
/** A matrix of a view that can be inverted */
const MATRIX = [2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1, 1, 0, 0, -1, 0];

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
    rowStyle: new Int32Array(rows).fill(-1),
    rowFirst,
    pointFirst: rowFirst.slice(),
    coordFirst: rowFirst.slice(),
    palette,
    sprites: null,
  };
}

/**
 * Rows `[from, from + counts.length)` of a chunk of `chunkData` packed again on their own with
 * `counts[r]` points each
 */
function rowsPatch(data: RowsChunkData, from: number, counts: number[]): RowsChunkData {
  const rows = counts.length;
  const rowFirst = new Int32Array(rows + 1);
  for (let r = 0; r < rows; r++) rowFirst[r + 1] = rowFirst[r] + counts[r];
  const count = rowFirst[rows];
  const instances = new Float32Array(count * 8);
  for (let r = 0, i = 0; r < rows; r++) {
    for (let k = 0; k < counts[r]; k++, i++) {
      writeRowsInstance(instances, i, ROWS_KIND.point, from + r, i, -1, -1, -1);
    }
  }
  return {
    ...data,
    rowBase: from,
    rows,
    instances,
    instanceCount: count,
    points: instances.slice(),
    pointCount: count,
    coords: new Float32Array(count * 2).fill(5),
    coordCount: count,
    rowStyles: new Float32Array(rows * 4).fill(1),
    rowStyle: new Int32Array(rows).fill(-1),
    rowFirst,
    pointFirst: rowFirst.slice(),
    coordFirst: rowFirst.slice(),
  };
}

/** The last draw of the calls */
function lastDraw(calls: Call[]): Call {
  const all = calls.filter((c) => c.name === 'drawArraysInstanced');
  return all[all.length - 1];
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

describe('the stops of the distance scale of the sprites', () => {
  it('writes the stops a shader reads, two floats each, and how many there are', () => {
    const out = new Float32Array(16).fill(9);
    const stops = [
      { distanceRatio: 0.25, scale: 0.5 },
      { distanceRatio: 1, scale: 1 },
      { distanceRatio: 3, scale: 2 },
    ];
    expect(writeSpriteScaleStops(stops, out)).toBe(3);
    expect(Array.from(out.slice(0, 8))).toEqual([0.25, 0.5, 1, 1, 3, 2, 0, 0]);
    expect(writeSpriteScaleStops(undefined, out)).toBe(0);
    expect(writeSpriteScaleStops([], out)).toBe(0);
    expect(Array.from(out)).toEqual(new Array(16).fill(0));
  });

  it('draws the same size everywhere for stops it cannot read, told once', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const out = new Float32Array(16);
      const unordered = [
        { distanceRatio: 2, scale: 1 },
        { distanceRatio: 1, scale: 2 },
      ];
      const tooMany = Array.from({ length: 9 }, (_, i) => ({ distanceRatio: i, scale: 1 }));
      const notFinite = [{ distanceRatio: Number.NaN, scale: 1 }];
      for (const stops of [unordered, tooMany, notFinite]) {
        expect(writeSpriteScaleStops(stops, out)).toBe(0);
      }
      expect(writeSpriteScaleStops(unordered, out)).toBe(0);
      expect(warn).toHaveBeenCalledTimes(3);
    } finally {
      warn.mockRestore();
    }
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
    // rows and of the values of the styles (and the elevation of 0 bound for the chunks without
    // elevations, made with the first upload)
    expect(mock.count('bufferData', flush)).toBe(2);
    expect(mock.count('texStorage2D', flush)).toBe(4);
    expect(mock.count('texSubImage2D', flush)).toBe(4);

    const draw = mock.calls.length;
    renderer.drawRange(chunk, 0, 4, 14, PROJECTION, binding());
    const names = mock.names(draw);
    expect(names.filter((n) => n.startsWith('draw'))).toEqual(['drawArraysInstanced']);
    // Nothing is written to a buffer or a texture while drawing
    for (const name of ['bufferData', 'bufferSubData', 'texSubImage2D', 'texStorage2D']) {
      expect(names).not.toContain(name);
    }
    const drawCall = lastDraw(mock.calls);
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
    const pointers = mock.calls
      .slice(at)
      .filter((c) => c.name === 'vertexAttribPointer' || c.name === 'vertexAttribIPointer');
    // The tag as an integer attribute (its offset is its fifth argument), the floats after it
    expect(pointers.map((c) => [c.name, c.args[0], c.args[c.args.length - 1]])).toEqual([
      ['vertexAttribIPointer', 1, 3 * ROWS_INSTANCE_BYTES],
      ['vertexAttribPointer', 2, 3 * ROWS_INSTANCE_BYTES + 4],
      ['vertexAttribPointer', 3, 3 * ROWS_INSTANCE_BYTES + 16],
    ]);
    const drawCall = lastDraw(mock.calls);
    expect(drawCall.args[3]).toBe(7);
    // The same range again needs no pointing
    const again = mock.calls.length;
    renderer.drawRange(chunk, 2, 4, 14, PROJECTION, binding());
    expect(mock.count('vertexAttribPointer', again)).toBe(0);
    expect(mock.count('vertexAttribIPointer', again)).toBe(0);
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

  it('writes rows in place when they fit their places, the rest of a place collapsed', () => {
    const mock = recordingGL();
    const renderer = new RowsRenderer(null, mock.gl, 1);
    renderer.ensureShader(SHADER_DATA);
    const data = chunkData(4);
    const chunk = renderer.createChunk(data);
    renderer.flushUploads();
    const held = data.coords.slice();

    // Row 2 (3 points) packed again with 3, row 3 (4 points) with 2: both fit their places
    const counts = [3, 2];
    const patch = rowsPatch(data, 2, counts);
    const at = mock.calls.length;
    expect(renderer.patchRows(chunk, 2, patch)).toBe(true);
    // Nothing is uploaded before the next flush, and the packed arrays are not written
    expect(mock.calls.length).toBe(at);
    expect(Array.from(data.coords)).toEqual(Array.from(held));
    expect(renderer.hasPendingUploads).toBe(true);
    renderer.flushUploads();
    const calls = mock.calls.slice(at);
    // The instances of the places of the two rows (7), the ones of their points, in one write
    // each; their coordinates written (5) and their styles (2), one run of a line each
    const buffers = calls.filter((c) => c.name === 'bufferSubData');
    expect(buffers.map((c) => [c.args[1], (c.args[2] as Float32Array).length / 8])).toEqual([
      [3 * ROWS_INSTANCE_BYTES, 7],
      [3 * ROWS_INSTANCE_BYTES, 7],
    ]);
    const textures = calls.filter((c) => c.name === 'texSubImage2D');
    // x, y, width, height of each upload: the coordinates 3 to 5 and 6, 7, then the two styles
    expect(textures.map((c) => c.args.slice(2, 6))).toEqual([
      [3, 0, 5, 1],
      [2, 0, 2, 1],
    ]);
    // The last two instances of row 3 draw nothing: a fill of one coordinate
    const instances = buffers[0].args[2] as Float32Array;
    for (const i of [5, 6]) {
      const instance = readRowsInstance(instances, i);
      expect(instance.kind).toBe(ROWS_KIND.fill);
      expect(new Set(instance.indices).size).toBe(1);
      expect(instance.row).toBe(3);
    }
    // The coordinates of the instances are numbered in the places of their rows
    expect(readRowsInstance(instances, 3).indices[0]).toBe(6);

    // A row with more than its place holds, or another palette: refused, nothing written
    const later = mock.calls.length;
    expect(renderer.patchRows(chunk, 2, rowsPatch(data, 2, [4, 1]))).toBe(false);
    expect(renderer.patchRows(chunk, 2, { ...patch, palette: new RowsPalette() })).toBe(false);
    expect(renderer.hasPendingUploads).toBe(false);
    renderer.flushUploads();
    expect(mock.count('bufferSubData', later)).toBe(0);
  });

  it('uploads a texel written many times once, and only the texels written', () => {
    const mock = recordingGL();
    const renderer = new RowsRenderer(null, mock.gl, 1);
    renderer.ensureShader(SHADER_DATA);
    const data = chunkData(4);
    const chunk = renderer.createChunk(data);
    renderer.flushUploads();
    const at = mock.calls.length;
    for (let i = 0; i < 10; i++) renderer.patchCoords(chunk, 4, [i, i]);
    renderer.patchCoords(chunk, 8, [1, 1, 2, 2]);
    renderer.flushUploads();
    const textures = mock.calls.slice(at).filter((c) => c.name === 'texSubImage2D');
    expect(textures.map((c) => c.args.slice(2, 6))).toEqual([
      [4, 0, 1, 1],
      [8, 0, 2, 1],
    ]);
    expect(Array.from(textures[0].args[8] as Float32Array)).toEqual([9, 9]);
  });

  it('keeps none of the packed arrays of a chunk once they are on the GPU', () => {
    const mock = recordingGL();
    const renderer = new RowsRenderer(null, mock.gl, 1);
    renderer.ensureShader(SHADER_DATA);
    const data = chunkData(4);
    const chunk = renderer.createChunk(data);
    expect(chunk.packed).toBe(data);
    renderer.flushUploads();
    expect(chunk.packed).toBeNull();
    // What it keeps: the places of the rows and their styles, not the arrays written
    for (const key of ['instances', 'points', 'coords', 'rowStyles']) {
      expect(key in chunk.data).toBe(false);
    }
    expect(chunk.data.rowFirst).toBe(data.rowFirst);
  });

  it('writes into the packed arrays of a chunk not uploaded yet', () => {
    const mock = recordingGL();
    const renderer = new RowsRenderer(null, mock.gl, 1);
    renderer.ensureShader(SHADER_DATA);
    const data = chunkData(3);
    const chunk = renderer.createChunk(data);
    renderer.patchCoords(chunk, 1, [7, 8]);
    expect(Array.from(data.coords.subarray(2, 4))).toEqual([7, 8]);
    const at = mock.calls.length;
    renderer.flushUploads();
    // The three textures of the chunk, and the elevation of 0 made with the first upload
    expect(mock.count('texSubImage2D', at)).toBe(4);
    expect(mock.count('bufferSubData', at)).toBe(0);
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
    // The corners, the empty picture and the elevation of 0 (made with the first upload) stay
    // with the renderer
    expect(ledger.snapshot().byOwner.rows).toBe(corners + 8);
    renderer.dispose();
    expect(ledger.snapshot().byOwner.rows).toBeUndefined();
  });

  it('reads the ground from the depth of the terrain with tables of its tiles alone', () => {
    const held: number[] = [];
    for (const [width, height] of [
      [800, 600],
      [2560, 1440],
    ]) {
      const mock = recordingGL();
      (mock.gl as unknown as Record<string, number>).drawingBufferWidth = width;
      (mock.gl as unknown as Record<string, number>).drawingBufferHeight = height;
      const ledger = new GpuLedger();
      // The terrain of the frame: its Mercator units of a meter of elevation
      const terrain = new TerrainContext();
      terrain.renderState = { ...terrain.renderState, elevationScale: 1 / 32_000_000 };
      const renderer = new RowsRenderer(null, mock.gl, 1, terrain, ledger);
      renderer.ensureShader(SHADER_DATA);
      expect(renderer.groundReady).toBe(true);
      const before = ledger.snapshot().byOwner.rows ?? 0;
      const depth = { id: 'depth' } as unknown as WebGLTexture;
      const ground = {
        depth,
        liftMeters: 0.4,
        boxes: new Float64Array(30),
        ranges: new Float32Array(20),
        blocks: new Float32Array(DRAPE_GROUND_BLOCK_TEXELS * 4 * 10),
        count: 10,
      };
      expect(renderer.prepareGround(ground)).toBe(true);
      held.push((ledger.snapshot().byOwner.rows ?? 0) - before);
      const chunk = renderer.createChunk(chunkData(4));
      renderer.flushUploads();
      beginRenderFrame();
      renderer.setOffsetUniforms(calculateOffsetUniforms([139, 35], { mainMatrix: MATRIX }));
      renderer.setGround(ground);
      const draw = mock.calls.length;
      renderer.drawRange(
        chunk,
        0,
        4,
        14,
        { ...PROJECTION, mainMatrix: MATRIX } as never,
        binding(),
      );
      // The depth of the terrain is bound, the inverse of the projection and the lift written
      const bound = mock.calls.slice(draw).filter((c) => c.name === 'bindTexture');
      expect(bound.some((c) => c.args[1] === depth)).toBe(true);
      const matrices = mock.calls
        .slice(draw)
        .filter(
          (c) =>
            c.name === 'uniformMatrix4fv' &&
            (c.args[0] as { name: string }).name === 'u_ground_unproject',
        );
      expect(matrices).toHaveLength(1);
      expect((matrices[0] as Call).args[2] as Float32Array).not.toEqual(new Float32Array(16));
      renderer.disposeChunk(chunk);
      renderer.dispose();
      expect(ledger.snapshot().byOwner.rows).toBeUndefined();
    }
    // The tables of 64 tiles, whatever the size of the screen: two texels and the blocks a tile
    expect(held).toEqual([64 * 2 * 16 + 64 * DRAPE_GROUND_BLOCK_TEXELS * 16, held[0]]);
  });

  it('draws the pictures of an extension from its texture, sized by its distance scale', () => {
    const mock = recordingGL();
    const renderer = new RowsRenderer(null, mock.gl, 1);
    renderer.ensureShader(SHADER_DATA);
    const pictures = { id: 'pictures' } as unknown as WebGLTexture;
    const sprites: RowSpriteSource = {
      texture: pictures,
      revision: 1,
      sprite: () => null,
      distanceScale: [
        { distanceRatio: 0.5, scale: 0.75 },
        { distanceRatio: 2, scale: 1.5 },
      ],
    };
    const chunk = renderer.createChunk({ ...chunkData(2), sprites });
    renderer.flushUploads();
    beginRenderFrame();
    const at = mock.calls.length;
    renderer.drawRange(chunk, 0, 2, 14, PROJECTION, binding());
    const calls = mock.calls.slice(at);
    // The texture of the pictures is bound on its unit (4), and the unit 0 is active again
    const unit = calls.findIndex(
      (c) => c.name === 'activeTexture' && c.args[0] === 'TEXTURE0'.length + 4,
    );
    expect(unit).toBeGreaterThanOrEqual(0);
    expect(calls[unit + 1]).toEqual({ name: 'bindTexture', args: ['TEXTURE_2D'.length, pictures] });
    const uniformOf = (from: Call[], method: string, name: string) =>
      from.find((c) => c.name === method && (c.args[0] as { name: string }).name === name);
    const stops = uniformOf(calls, 'uniform2fv', 'u_sprite_scale_stops');
    expect(Array.from(stops?.args[1] as Float32Array).slice(0, 5)).toEqual([0.5, 0.75, 2, 1.5, 0]);
    expect(uniformOf(calls, 'uniform1i', 'u_sprite_scale_count')?.args[1]).toBe(2);
    // A chunk without pictures binds the empty picture of the renderer, and no scale
    const plain = renderer.createChunk(chunkData(2));
    renderer.flushUploads();
    const before = mock.calls.length;
    renderer.drawRange(plain, 0, 2, 14, PROJECTION, binding());
    const after = mock.calls.slice(before);
    expect(after.some((c) => c.name === 'bindTexture' && c.args[1] === pictures)).toBe(false);
    expect(uniformOf(after, 'uniform1i', 'u_sprite_scale_count')?.args[1]).toBe(0);
  });

  it('writes the values of the styles before the chunks, and the writes in place after them', () => {
    const mock = recordingGL();
    const renderer = new RowsRenderer(null, mock.gl, 1);
    renderer.ensureShader(SHADER_DATA);
    const palette = new RowsPalette();
    const chunk = renderer.createChunk(chunkData(3, palette));
    const at = mock.calls.length;
    renderer.flushUploads();
    const names = mock.calls.slice(at).map((c) => c.name);
    // The texture of the values (made with texStorage2D) comes before the buffers of the chunk
    expect(names.indexOf('texStorage2D')).toBeLessThan(names.indexOf('bufferData'));
    // A style added later is written to the texture of the palette, after it grew if needed
    palette.add(new Array(16).fill(0.5));
    expect(renderer.hasPendingUploads).toBe(true);
    const later = mock.calls.length;
    renderer.flushUploads();
    expect(mock.calls.slice(later).map((c) => c.name)).toEqual([
      'bindTexture',
      'texSubImage2D',
      'bindTexture',
    ]);
    expect(chunk.uploaded).toBe(true);
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
