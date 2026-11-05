// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The parts of the extensions on the GPU: `prepare` runs once for a definition, the shares are
 * held, and a part gives back everything when it ends, whichever way
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { GpuLedger } from '../../view/gpu-ledger.js';
import { DrawError } from '../errors.js';
import type { Gpu, GpuDefinition } from '../extension/webgl.js';
import { createGpuParts } from './gpu-parts.js';

function context(lost = () => false) {
  const alive = new Set<object>();
  const gl = {
    ARRAY_BUFFER: 1,
    STATIC_DRAW: 2,
    DYNAMIC_DRAW: 3,
    createBuffer() {
      const buffer = {};
      alive.add(buffer);
      return buffer;
    },
    deleteBuffer: (buffer: object) => alive.delete(buffer),
    bindBuffer() {},
    bufferData() {},
    isContextLost: lost,
  } as unknown as WebGL2RenderingContext;
  return { gl, alive };
}

function setUp(limitBytes = 1_000) {
  const ledger = new GpuLedger();
  ledger.limitBytes = limitBytes;
  return { ledger, parts: createGpuParts({ ledger, rowLimitBytes: () => 10_000 }) };
}

/** A definition that allocates 100 bytes and hands out what it draws with */
function definition(share = 0.5) {
  const seen: Gpu[] = [];
  const value: GpuDefinition<string> = {
    gpuShare: share,
    prepare: vi.fn((gpu: Gpu) => {
      seen.push(gpu);
      gpu.buffer(100);
      return 'drawing';
    }),
  };
  return { value, seen };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the parts of an instance', () => {
  it('prepare a definition once, however many use it', () => {
    const { parts, ledger } = setUp();
    const { gl } = context();
    const { value } = definition();
    const a = parts.add(value, 'acme');
    const b = parts.add(value, 'other');
    expect(a).toBe(b);
    a.attach(gl);
    b.attach(gl);
    expect(value.prepare).toHaveBeenCalledTimes(1);
    expect(ledger.snapshot().byOwner).toEqual({ acme: 100 });
    b.release();
    expect(ledger.snapshot().bytes).toBe(100);
    a.release();
    expect(ledger.snapshot().bytes).toBe(0);
  });

  it('hold the sum of the shares under what the extensions may take', () => {
    const { parts } = setUp();
    const first = definition(0.36).value;
    const second = definition(0.54).value;
    const part = parts.add(first, 'first');
    parts.add(second, 'second');
    // The same definition is not counted twice
    parts.add(first, 'first');
    let error: DrawError | null = null;
    try {
      parts.add(definition(0.01).value, 'more');
    } catch (thrown) {
      error = thrown as DrawError;
    }
    expect(error?.code).toBe('too-large');
    part.release();
    part.release();
    parts.add(definition(0.01).value, 'more');
  });

  it.each([0, -0.1, 1.5, Number.NaN])('refuse a share of %d', (share) => {
    const { parts } = setUp();
    expect(() => parts.add(definition(share).value, 'acme')).toThrow(DrawError);
  });

  it('hold what a part makes under its share of the limit, followed as the limit changes', () => {
    const { parts, ledger } = setUp(1_000);
    const { gl } = context();
    const { value, seen } = definition(0.2);
    parts.add(value, 'acme').attach(gl);
    expect(seen[0].memory().limitBytes).toBe(200);
    ledger.limitBytes = 2_000;
    expect(seen[0].memory().limitBytes).toBe(400);
  });
});

describe('a part ends with everything it made', () => {
  it('when prepare throws half way, without asking again until the context is back', () => {
    const report = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { parts, ledger } = setUp();
    let lost = false;
    const { gl, alive } = context(() => lost);
    const prepare = vi.fn((gpu: Gpu) => {
      gpu.buffer(100);
      throw new Error('half way');
    });
    const part = parts.add({ gpuShare: 0.5, prepare }, 'acme');
    part.attach(gl);
    expect(alive.size).toBe(0);
    expect(ledger.snapshot().objects).toBe(0);
    expect(ledger.audit()).toBe(true);
    expect(part.drawing).toBeNull();
    expect(report).toHaveBeenCalledOnce();
    part.detach(gl);
    part.attach(gl);
    expect(prepare).toHaveBeenCalledOnce();
    lost = true;
    part.detach(gl);
    lost = false;
    part.attach(gl);
    expect(prepare).toHaveBeenCalledTimes(2);
  });

  it('when prepare asks for more than its share', () => {
    const report = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { parts, ledger } = setUp(100);
    const { gl, alive } = context();
    const part = parts.add(definition(0.5).value, 'acme');
    part.attach(gl);
    expect(alive.size).toBe(0);
    expect(ledger.snapshot().objects).toBe(0);
    expect(report).toHaveBeenCalledOnce();
  });

  it('when what draws throws: it is not asked again, and the frame goes on', () => {
    const report = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { parts, ledger } = setUp();
    const { gl, alive } = context();
    const part = parts.add(definition().value, 'acme');
    part.attach(gl);
    const draw = vi.fn(() => {
      throw new Error('in a frame');
    });
    part.draw(draw);
    part.draw(draw);
    expect(draw).toHaveBeenCalledOnce();
    expect(alive.size).toBe(0);
    expect(ledger.snapshot().objects).toBe(0);
    expect(report).toHaveBeenCalledOnce();
  });

  it('when the context is lost, and prepare runs on a new `gpu` when it is back', () => {
    const { parts, ledger } = setUp();
    let lost = false;
    const { gl } = context(() => lost);
    const { value, seen } = definition();
    const part = parts.add(value, 'acme');
    part.attach(gl);
    lost = true;
    part.detach(gl);
    expect(seen[0].signal.aborted).toBe(true);
    expect(ledger.snapshot().objects).toBe(0);
    expect(part.drawing).toBeNull();
    lost = false;
    part.attach(gl);
    expect(value.prepare).toHaveBeenCalledTimes(2);
    expect(seen[1]).not.toBe(seen[0]);
    expect(ledger.snapshot().bytes).toBe(100);
  });

  it('but keeps what it holds while the context lasts, as when the map swaps its style', () => {
    const { parts, ledger } = setUp();
    const { gl } = context();
    const { value } = definition();
    const part = parts.add(value, 'acme');
    part.attach(gl);
    part.detach(gl);
    part.attach(gl);
    expect(value.prepare).toHaveBeenCalledOnce();
    expect(ledger.snapshot().bytes).toBe(100);
    part.release();
    expect(ledger.snapshot().bytes).toBe(0);
  });

  it('with the rows it holds, also when making them fails', () => {
    const { parts, ledger } = setUp();
    const { gl, alive } = context();
    const part = parts.add(
      {
        gpuShare: 0.5,
        prepare: () => ({
          render() {},
          rows: (_view: unknown, gpu: Gpu) => {
            gpu.buffer(5_000);
            if (alive.size > 1) throw new Error('no room');
            return {} as never;
          },
        }),
      },
      'acme',
    );
    part.attach(gl);
    const rows = part.gpuRows;
    if (!rows) throw new Error('rows');
    const held = rows.create({} as never);
    expect(ledger.snapshot().rowBytes).toBe(5_000);
    expect(() => rows.create({} as never)).toThrow('no room');
    expect(ledger.snapshot().rowBytes).toBe(5_000);
    held.release();
    expect(ledger.snapshot().rowBytes).toBe(0);
    rows.create({} as never);
    part.release();
    expect(alive.size).toBe(0);
    expect(ledger.snapshot().objects).toBe(0);
  });
});
