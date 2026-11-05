// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from 'vitest';
import { GpuLedger, textureBytes } from './gpu-ledger.js';

describe('GpuLedger', () => {
  it('adds what is allocated and takes out what is released, per renderer', () => {
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
      byOwner: { points: 100, lines: 296 },
    });
    ledger.release(b);
    ledger.release(b);
    expect(ledger.snapshot().byOwner).toEqual({ points: 100, lines: 256 });
  });

  it('replaces the size of a buffer written again, as bufferData replaces its storage', () => {
    const ledger = new GpuLedger();
    const buffer = {};
    ledger.record(buffer, 'polygons', 'buffer', 1000);
    ledger.record(buffer, 'polygons', 'buffer', 300);
    expect(ledger.snapshot().bytes).toBe(300);
    ledger.release(buffer);
    expect(ledger.snapshot()).toMatchObject({
      bytes: 0,
      bufferBytes: 0,
      textureBytes: 0,
      byOwner: {},
    });
  });

  it('ignores a missing object', () => {
    const ledger = new GpuLedger();
    ledger.record(null, 'points', 'buffer', 10);
    ledger.release(null);
    expect(ledger.snapshot().bytes).toBe(0);
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

  it('tells what it holds outside the rows, from the owners or from what is recorded', () => {
    const ledger = new GpuLedger();
    const [rows, atlas, kept] = [{}, {}, {}];
    ledger.record(rows, 'rows', 'buffer', 100);
    ledger.record(atlas, 'dem-atlas', 'texture', 30);
    ledger.record(kept, 'a part', 'buffer', 5, true);
    expect(ledger.outsideRowBytes).toBe(30);
    expect(ledger.snapshot().rowBytes).toBe(105);
    ledger.release(rows);
    ledger.release(atlas);
    expect(ledger.outsideRowBytes).toBe(0);
    expect(ledger.snapshot().rowBytes).toBe(5);
  });

  it('takes no allocation without an owner', () => {
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

  it('deletes what was left behind, and tells it', () => {
    const gl = {
      deleteBuffer: vi.fn(),
      deleteTexture: vi.fn(),
      deleteRenderbuffer: vi.fn(),
    } as unknown as WebGL2RenderingContext;
    const ledger = new GpuLedger();
    const before = ledger.snapshot().leakedBytes;
    ledger.record({}, 'a', 'buffer', 10);
    ledger.record({}, 'a', 'texture', 20);
    ledger.record({}, 'b', 'renderbuffer', 5);
    expect(ledger.drain(gl)).toEqual({ a: 30, b: 5 });
    expect(gl.deleteBuffer).toHaveBeenCalledTimes(1);
    expect(gl.deleteTexture).toHaveBeenCalledTimes(1);
    expect(gl.deleteRenderbuffer).toHaveBeenCalledTimes(1);
    expect(ledger.snapshot().bytes).toBe(0);
    expect(ledger.snapshot().leakedBytes - before).toBe(35);
    expect(ledger.drain(gl)).toEqual({});
  });

  it('gives back what a build that fails had made, and nothing else', () => {
    const gl = { deleteBuffer: vi.fn() } as unknown as WebGL2RenderingContext;
    const ledger = new GpuLedger();
    const kept = { name: 'kept' };
    ledger.record(kept, 'a', 'buffer', 10);
    expect(() =>
      ledger.scope(gl, () => {
        ledger.record({ name: 'made' }, 'a', 'buffer', 20);
        throw new Error('failed');
      }),
    ).toThrow('failed');
    expect(ledger.snapshot().bytes).toBe(10);
    expect(gl.deleteBuffer).toHaveBeenCalledTimes(1);
    expect(gl.deleteBuffer).not.toHaveBeenCalledWith(kept);
  });
});
