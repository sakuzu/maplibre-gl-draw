// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The sources of quads of the drawing of the rows (a prototype), on a GL that records its calls
 *
 * - What the renderer allocates for a source (its texture) and for a chunk with quads (the table
 *   of its quads) is in the ledger, and leaves it when the type goes and when the renderer is
 *   released, with the programs of the quads
 * - A function that does not compile fails alone: the other sources and the program of the rows
 *   draw on
 */

import { describe, expect, it } from 'vitest';
import { GpuLedger } from '../../gpu-ledger.js';
import {
  ROWS_KIND,
  ROWS_QUAD_FLOATS,
  type RowQuadSource,
  type RowsChunkData,
  RowsPalette,
  writeRowsInstance,
} from './rows-format.js';
import { RowQuadType } from './rows-quads.js';
import { RowsRenderer } from './rows-renderer.js';

/**
 * A GL that records its calls, whose shaders do not compile (nor their programs link) when their
 * source holds `broken`
 */
function recordingGL() {
  const calls: { name: string; args: unknown[] }[] = [];
  const sources = new Map<unknown, string>();
  const attached = new Map<unknown, unknown[]>();
  let next = 1;
  const target: Record<string, unknown> = { drawingBufferWidth: 800, drawingBufferHeight: 600 };
  const gl = new Proxy(target, {
    get(t, prop: string) {
      if (prop in t) return t[prop];
      if (/^[A-Z_0-9]+$/.test(prop)) return prop;
      return (...args: unknown[]) => {
        calls.push({ name: prop, args });
        if (prop.startsWith('create')) return { id: next++ };
        if (prop === 'shaderSource') sources.set(args[0], args[1] as string);
        if (prop === 'attachShader') {
          attached.set(args[0], [...(attached.get(args[0]) ?? []), args[1]]);
        }
        if (prop === 'getShaderParameter') {
          return !(sources.get(args[0]) ?? '').includes('broken');
        }
        if (prop === 'getProgramParameter') {
          if (args[1] !== 'LINK_STATUS') return true;
          return !(attached.get(args[0]) ?? []).some((s) =>
            (sources.get(s) ?? '').includes('broken'),
          );
        }
        if (prop === 'getExtension') return null;
        if (prop === 'getUniformLocation') return { name: args[1] };
        if (prop === 'getParameter') return 4;
        return undefined;
      };
    },
  }) as unknown as WebGL2RenderingContext;
  return { gl, count: (name: string) => calls.filter((c) => c.name === name).length };
}

/** A source of quads whose function paints one color, with a texture of 4 by 4 texels */
function source(entry: string, body = 'return vec4(values.rgb, 1.0);'): RowQuadSource {
  return {
    glsl: `vec4 ${entry}(vec2 uv, vec2 uvDx, vec2 uvDy, vec2 sizePx, vec4 values, sampler2D tex, sampler2D unused) { ${body} }`,
    entry,
    textures: [{ format: 'rgba8', width: 4, height: 4, data: new Uint8Array(64) }],
    quad: () => true,
  };
}

/** A chunk of one row, a quad */
function quadChunk(palette = new RowsPalette()): RowsChunkData {
  const instances = new Float32Array(8);
  writeRowsInstance(instances, 0, ROWS_KIND.quad, 0, 0, -1, -1, -1);
  const quads = new Float32Array(ROWS_QUAD_FLOATS);
  quads.set([10, 10, 0, 1 << 1, 1, 0, 0, 1]);
  return {
    origin: [139, 35],
    rowBase: 0,
    rows: 1,
    instances,
    instanceCount: 1,
    points: instances.slice(),
    pointCount: 1,
    coords: new Float32Array(2),
    coordCount: 1,
    rowStyles: new Float32Array(4),
    rowStyle: new Int32Array(1).fill(-1),
    rowFirst: Int32Array.of(0, 1),
    pointFirst: Int32Array.of(0, 1),
    coordFirst: Int32Array.of(0, 1),
    palette,
    sprites: null,
    quads,
    hasQuads: true,
  };
}

describe('the sources of quads of the drawing of the rows', () => {
  it('releases what it allocates when the type goes and when it is released', () => {
    const mock = recordingGL();
    const ledger = new GpuLedger();
    const renderer = new RowsRenderer(null, mock.gl, ledger, 1, undefined);
    const base = ledger.snapshot().byOwner.rows ?? 0;
    const type = new RowQuadType(source('pie_color'));
    const renderers = new Map<string, unknown>([['pie', { rowQuads: type }]]);

    renderer.syncQuadTypes(renderers);
    // The texture of the source, and the programs of the quads (linked at once by this GL)
    expect(ledger.snapshot().byOwner.rows).toBe(base + 64);
    expect(type.state).toBe('ready');
    expect(type.slot).toBe(1);

    const palette = new RowsPalette();
    const chunk = renderer.createChunk(quadChunk(palette));
    renderer.flushUploads();
    const withChunk = ledger.snapshot().byOwner.rows ?? 0;
    expect(withChunk).toBeGreaterThan(base + 64);
    expect(renderer.quadStats()).toMatchObject({ types: 1, ready: 1, chunks: 1, quadChunks: 1 });

    // The type goes: its texture is released
    renderer.syncQuadTypes(new Map());
    expect(ledger.snapshot().byOwner.rows).toBe(withChunk - 64);
    expect(type.state).toBe('pending');
    expect(type.slot).toBe(0);

    // The chunk and the renderer go: nothing is left, the programs of the quads included
    renderer.disposeChunk(chunk);
    renderer.retirePalette(palette);
    const programs = mock.count('createProgram');
    renderer.dispose();
    expect(ledger.snapshot().byOwner.rows).toBeUndefined();
    expect(mock.count('deleteProgram')).toBe(programs);
    expect(renderer.quadStats()).toMatchObject({ types: 0, chunks: 0, quadChunks: 0 });
  });

  it('leaves a function that does not compile to the drawing one by one, and draws the others', () => {
    const mock = recordingGL();
    const ledger = new GpuLedger();
    const renderer = new RowsRenderer(null, mock.gl, ledger, 1, undefined);
    const good = new RowQuadType(source('good_color'));
    const bad = new RowQuadType(source('broken_color', 'return broken;'));
    const renderers = new Map<string, unknown>([
      ['good', { rowQuads: good }],
      ['bad', { rowQuads: bad }],
    ]);
    // The programs of both fail (the GL compiles at once), each function is compiled alone, and
    // the programs are compiled again with the good one
    renderer.syncQuadTypes(renderers);
    expect(bad.state).toBe('failed');
    expect(good.state).toBe('pending');
    renderer.syncQuadTypes(renderers);
    expect(good.state).toBe('ready');
    expect(bad.state).toBe('failed');
    // The program of the rows draws on
    renderer.ensureShader({ vertexShaderPrelude: '', define: '', variantName: 'mercator' });
    expect(renderer.ready).toBe(true);
    expect(renderer.quadStats()).toMatchObject({ types: 2, ready: 1, failed: 1 });
    renderer.dispose();
    expect(ledger.snapshot().byOwner.rows).toBeUndefined();
  });
});
