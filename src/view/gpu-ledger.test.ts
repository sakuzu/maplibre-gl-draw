// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_GPU_LIMIT_BYTES,
  GpuLedger,
  mipmappedTextureBytes,
  textureBytes,
} from './gpu-ledger.js';

describe('GpuLedger', () => {
  it('adds what is allocated and takes out what is released, per part', () => {
    const ledger = new GpuLedger();
    const a = {};
    const b = {};
    const t = {};
    ledger.record(a, 'points', 'buffer', 100);
    ledger.record(b, 'lines', 'buffer', 40);
    ledger.record(t, 'lines', 'texture', textureBytes(4, 4, 16));
    expect(ledger.snapshot()).toMatchObject({
      bytes: 396,
      bufferBytes: 140,
      textureBytes: 256,
      byPart: { points: 100, lines: 296 },
    });
    ledger.release(b);
    ledger.release(b);
    expect(ledger.snapshot().byPart).toEqual({ points: 100, lines: 256 });
  });

  it('replaces the size of a buffer written again, as bufferData replaces its storage', () => {
    const ledger = new GpuLedger();
    const buffer = {};
    ledger.record(buffer, 'polygons', 'buffer');
    ledger.record(buffer, 'polygons', 'buffer', 1000);
    ledger.record(buffer, 'polygons', 'buffer', 300);
    expect(ledger.snapshot().bytes).toBe(300);
    ledger.release(buffer);
    expect(ledger.snapshot()).toMatchObject({
      bytes: 0,
      bufferBytes: 0,
      textureBytes: 0,
      objects: 0,
      byPart: {},
    });
  });

  it('counts the objects that hold no bytes of their own, by kind', () => {
    const ledger = new GpuLedger();
    ledger.record({}, 'points', 'vertex-array');
    ledger.record({}, 'points', 'program');
    ledger.record({}, 'demAtlas', 'framebuffer');
    ledger.record({}, 'points', 'buffer', 8);
    expect(ledger.snapshot()).toMatchObject({
      bytes: 8,
      objects: 4,
      objectsByKind: { 'vertex-array': 1, program: 1, framebuffer: 1, buffer: 1 },
    });
  });

  it('ignores a missing object', () => {
    const ledger = new GpuLedger();
    ledger.record(null, 'points', 'buffer', 10);
    ledger.release(null);
    expect(ledger.snapshot().bytes).toBe(0);
    expect(ledger.holds(null)).toBe(false);
  });

  it('tells the most bytes held at once, and the allocations made', () => {
    const ledger = new GpuLedger();
    const a = {};
    const b = {};
    ledger.record(a, 'x', 'buffer', 100);
    ledger.record(b, 'x', 'texture', 50);
    ledger.release(a);
    ledger.record(a, 'x', 'buffer', 10);
    expect(ledger.snapshot()).toMatchObject({ bytes: 60, peakBytes: 150, allocations: 3 });
  });

  it('tells what it holds outside the rows, from the parts or from what is recorded', () => {
    const ledger = new GpuLedger();
    const [rows, atlas, kept] = [{}, {}, {}];
    ledger.record(rows, 'polygons', 'buffer', 100);
    ledger.record(atlas, 'demAtlas', 'texture', 30);
    ledger.record(kept, 'a part', 'buffer', 5, true);
    expect(ledger.outsideRowBytes).toBe(30);
    expect(ledger.snapshot()).toMatchObject({ rowBytes: 105, outsideRowBytes: 30 });
    ledger.release(rows);
    ledger.release(atlas);
    expect(ledger.outsideRowBytes).toBe(0);
    expect(ledger.snapshot().rowBytes).toBe(5);
  });

  it('holds the parts of the rows, and only those, as rows', () => {
    const ledger = new GpuLedger();
    for (const part of ['polygons', 'lines', 'points', 'fills', 'strokes', 'outlines']) {
      ledger.record({}, part, 'buffer', 1);
    }
    for (const part of ['images', 'pointShapes', 'demAtlas', 'drape']) {
      ledger.record({}, part, 'buffer', 10);
    }
    expect(ledger.rowBytesHeld).toBe(6);
    expect(ledger.outsideRowBytes).toBe(40);
  });

  it('measures what fits outside the rows against its limit, the rows aside', () => {
    const ledger = new GpuLedger();
    expect(ledger.limitBytes).toBe(DEFAULT_GPU_LIMIT_BYTES);
    expect(DEFAULT_GPU_LIMIT_BYTES).toBe(64_000_000);
    ledger.limitBytes = 100;
    ledger.record({}, 'images', 'texture', 60);
    // The rows do not take the room of the limit
    ledger.record({}, 'polygons', 'buffer', 1_000);
    expect(ledger.fits(40)).toBe(true);
    expect(ledger.fits(41)).toBe(false);
    expect(ledger.roomBytes).toBe(40);
  });

  it('takes no allocation without a part', () => {
    expect(() => new GpuLedger().record({}, '', 'buffer', 1)).toThrow();
  });

  it('finds that its sums do not agree with what it holds', () => {
    const ledger = new GpuLedger();
    ledger.record({}, 'a', 'buffer', 10);
    ledger.record({}, 'b', 'texture', 20);
    expect(ledger.audit()).toBe(true);
    (ledger as unknown as { bufferBytes: number }).bufferBytes = 11;
    expect(ledger.audit()).toBe(false);
  });

  it('finds the sums of its parts that do not agree with what they hold', () => {
    const ledger = new GpuLedger();
    ledger.record({}, 'a', 'buffer', 10);
    expect(ledger.audit()).toBe(true);
    (ledger as unknown as { parts: Map<string, number> }).parts.set('a', 9);
    expect(ledger.audit()).toBe(false);
  });

  it('deletes what was left behind, and counts it in its own numbers', () => {
    const gl = {
      deleteBuffer: vi.fn(),
      deleteTexture: vi.fn(),
      deleteRenderbuffer: vi.fn(),
      deleteVertexArray: vi.fn(),
      deleteProgram: vi.fn(),
      deleteFramebuffer: vi.fn(),
    } as unknown as WebGL2RenderingContext;
    const ledger = new GpuLedger();
    ledger.record({}, 'a', 'buffer', 10);
    ledger.record({}, 'a', 'texture', 20);
    ledger.record({}, 'b', 'renderbuffer', 5);
    ledger.record({}, 'b', 'vertex-array');
    ledger.record({}, 'b', 'program');
    ledger.record({}, 'b', 'framebuffer');
    expect(ledger.drain(gl)).toEqual({ a: 30, b: 5 });
    expect(gl.deleteBuffer).toHaveBeenCalledTimes(1);
    expect(gl.deleteTexture).toHaveBeenCalledTimes(1);
    expect(gl.deleteRenderbuffer).toHaveBeenCalledTimes(1);
    expect(gl.deleteVertexArray).toHaveBeenCalledTimes(1);
    expect(gl.deleteProgram).toHaveBeenCalledTimes(1);
    expect(gl.deleteFramebuffer).toHaveBeenCalledTimes(1);
    expect(ledger.snapshot()).toMatchObject({
      bytes: 0,
      objects: 0,
      leakedBytes: 35,
      leakedObjects: 6,
    });
    expect(ledger.drain(gl)).toEqual({});
  });

  it('keeps what one ledger found left behind out of another', () => {
    const gl = { deleteBuffer: vi.fn() } as unknown as WebGL2RenderingContext;
    const one = new GpuLedger();
    const other = new GpuLedger();
    one.record({}, 'a', 'buffer', 10);
    other.record({}, 'a', 'buffer', 20);
    one.drain(gl);
    expect(one.snapshot().leakedBytes).toBe(10);
    expect(other.snapshot()).toMatchObject({ bytes: 20, leakedBytes: 0 });
  });

  it('gives back what a build that fails had made, and nothing else', () => {
    const gl = {
      deleteBuffer: vi.fn(),
      deleteVertexArray: vi.fn(),
    } as unknown as WebGL2RenderingContext;
    const ledger = new GpuLedger();
    const kept = { name: 'kept' };
    ledger.record(kept, 'a', 'buffer', 10);
    expect(() =>
      ledger.scope(gl, () => {
        ledger.record({ name: 'made' }, 'a', 'buffer', 20);
        ledger.record({ name: 'array' }, 'a', 'vertex-array');
        throw new Error('failed');
      }),
    ).toThrow('failed');
    expect(ledger.snapshot()).toMatchObject({ bytes: 10, objects: 1 });
    expect(gl.deleteBuffer).toHaveBeenCalledTimes(1);
    expect(gl.deleteBuffer).not.toHaveBeenCalledWith(kept);
    expect(gl.deleteVertexArray).toHaveBeenCalledTimes(1);
  });

  it('moves what it holds to another ledger, under the same parts', () => {
    const own = new GpuLedger();
    const target = new GpuLedger();
    const buffer = {};
    own.record(buffer, 'images', 'buffer', 32);
    own.record({}, 'images', 'vertex-array');
    own.moveTo(target);
    expect(own.snapshot()).toMatchObject({ bytes: 0, objects: 0 });
    expect(target.snapshot()).toMatchObject({ bytes: 32, objects: 2, byPart: { images: 32 } });
    expect(target.holds(buffer)).toBe(true);
    expect(target.audit()).toBe(true);
  });
});

describe('the bytes of a texture', () => {
  it('of one level', () => {
    expect(textureBytes(4, 2, 16)).toBe(128);
    expect(textureBytes(-1, 2, 16)).toBe(0);
  });

  it('with the whole chain of its mipmaps', () => {
    // 4 x 2, 2 x 1, 1 x 1
    expect(mipmappedTextureBytes(4, 2, 4)).toBe((8 + 2 + 1) * 4);
    expect(mipmappedTextureBytes(0, 2, 4)).toBe(0);
  });
});
