// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The GPU resources of a part: what is made is in the ledger under its owner, what does not fit is
 * refused before anything is made, and however a part ends the ledger comes back to 0
 */

import { describe, expect, it } from 'vitest';
import { DrawError } from '../shared/draw-error.js';
import { GpuResources } from './gpu.js';
import { GpuLedger } from './gpu-ledger.js';

const CONSTANTS = {
  ARRAY_BUFFER: 1,
  ELEMENT_ARRAY_BUFFER: 2,
  STATIC_DRAW: 3,
  DYNAMIC_DRAW: 4,
  TEXTURE_2D: 5,
  R8: 0x8229,
  RGBA8: 0x8058,
  RGBA32F: 0x8814,
  VERTEX_SHADER: 6,
  FRAGMENT_SHADER: 7,
  COMPILE_STATUS: 8,
  LINK_STATUS: 9,
  SEPARATE_ATTRIBS: 10,
  SYNC_GPU_COMMANDS_COMPLETE: 11,
};

/** A context that counts what is alive, and fails where it is told to */
function counted(options: { failOn?: string; linkFails?: boolean; lost?: boolean } = {}) {
  const alive = new Set<object>();
  const calls: string[] = [];
  const make = (name: string) => () => {
    calls.push(name);
    if (options.lost) return null;
    const object = { name };
    alive.add(object);
    return object;
  };
  const drop = (object: object | null) => {
    if (object) alive.delete(object);
  };
  const failing =
    (name: string) =>
    (..._args: unknown[]) => {
      calls.push(name);
      if (options.failOn === name) throw new Error(`${name} failed`);
    };
  const gl = {
    ...CONSTANTS,
    createBuffer: make('createBuffer'),
    createTexture: make('createTexture'),
    createVertexArray: make('createVertexArray'),
    createTransformFeedback: make('createTransformFeedback'),
    fenceSync: make('fenceSync'),
    createProgram: make('createProgram'),
    createShader: make('createShader'),
    deleteBuffer: drop,
    deleteTexture: drop,
    deleteVertexArray: drop,
    deleteTransformFeedback: drop,
    deleteSync: drop,
    deleteProgram: drop,
    deleteShader: drop,
    bindBuffer: failing('bindBuffer'),
    bindTexture: failing('bindTexture'),
    bufferData: failing('bufferData'),
    texStorage2D: failing('texStorage2D'),
    shaderSource() {},
    compileShader() {},
    attachShader() {},
    linkProgram() {},
    transformFeedbackVaryings() {},
    getExtension: () => null,
    getShaderParameter: () => true,
    getProgramParameter: () => options.linkFails !== true,
    getShaderInfoLog: () => '',
    getProgramInfoLog: () => 'the program does not link',
    isContextLost: () => options.lost === true,
  } as unknown as WebGL2RenderingContext;
  return { gl, alive, calls };
}

function open(
  gl: WebGL2RenderingContext,
  share: number | undefined = 0.5,
  limitBytes = 1_000,
): { gpu: GpuResources; ledger: GpuLedger } {
  const ledger = new GpuLedger();
  ledger.limitBytes = limitBytes;
  return {
    gpu: new GpuResources({ gl, ledger, owner: 'acme', ...(share !== undefined && { share }) }),
    ledger,
  };
}

function refusal(run: () => unknown): DrawError {
  try {
    run();
  } catch (error) {
    if (error instanceof DrawError) return error;
    throw error;
  }
  throw new Error('nothing was refused');
}

describe('a part on the GPU', () => {
  it('records what it makes under its owner, bytes and all', () => {
    const { gl } = counted();
    const { gpu, ledger } = open(gl);
    gpu.buffer(100);
    gpu.texture(4, 4, gl.RGBA8);
    gpu.vertexArray();
    gpu.transformFeedback();
    gpu.fence();
    gpu.program('v', 'f');
    expect(ledger.snapshot().byOwner).toEqual({ acme: 164 });
    expect(ledger.snapshot().objects).toBe(6);
    expect(ledger.audit()).toBe(true);
    expect(gpu.memory().gpuBytes).toBe(164);
  });

  it('counts the levels of a texture', () => {
    const { gl } = counted();
    const { gpu, ledger } = open(gl);
    gpu.texture(8, 4, gl.R8, 3);
    expect(ledger.snapshot().bytes).toBe(32 + 8 + 2);
  });

  it('refuses a format it cannot count', () => {
    const { gl, calls } = counted();
    const { gpu } = open(gl);
    expect(refusal(() => gpu.texture(4, 4, 12345)).code).toBe('invalidInput');
    expect(calls).toEqual([]);
  });

  it('refuses what is over its share before anything is made, for good', () => {
    const { gl, calls } = counted();
    const { gpu, ledger } = open(gl);
    const error = refusal(() => gpu.buffer(501));
    expect(error.code).toBe('tooLarge');
    expect(error.retryable).toBe(false);
    expect(calls).toEqual([]);
    expect(ledger.snapshot().bytes).toBe(0);
  });

  it('refuses what the room of the instance cannot take, for now', () => {
    const { gl, calls } = counted();
    const { gpu, ledger } = open(gl);
    const other = {};
    ledger.record(other, 'others', 'buffer', 800);
    const error = refusal(() => gpu.buffer(300));
    expect(error.code).toBe('tooLarge');
    expect(error.retryable).toBe(true);
    expect(calls).toEqual([]);
    ledger.release(other);
    gpu.buffer(300);
  });

  it('tells the most it can hold now, the room of the instance included', () => {
    const { gl } = counted();
    const { gpu, ledger } = open(gl);
    gpu.buffer(100);
    expect(gpu.memory().limitBytes).toBe(500);
    ledger.record({}, 'others', 'buffer', 700);
    expect(gpu.memory().limitBytes).toBe(300);
  });

  it('follows the limit of the instance, and keeps what it holds when it goes down', () => {
    const { gl, alive } = counted();
    const { gpu, ledger } = open(gl);
    gpu.buffer(400);
    ledger.limitBytes = 500;
    expect(gpu.memory().limitBytes).toBe(250);
    expect(alive.size).toBe(1);
    expect(refusal(() => gpu.buffer(1)).code).toBe('tooLarge');
    ledger.limitBytes = 2_000;
    gpu.buffer(500);
  });

  it('gives back what it no longer needs, once', () => {
    const { gl, alive } = counted();
    const { gpu, ledger } = open(gl);
    const buffer = gpu.buffer(100);
    gpu.release(buffer);
    gpu.release(buffer);
    gpu.release({} as WebGLBuffer);
    expect(alive.size).toBe(0);
    expect(ledger.snapshot().bytes).toBe(0);
    expect(gpu.memory().gpuBytes).toBe(0);
    gpu.buffer(500);
  });

  it('leaves nothing of a program that does not link, and tells the log', () => {
    const { gl, alive } = counted({ linkFails: true });
    const { gpu, ledger } = open(gl);
    const error = refusal(() => gpu.program('v', 'f'));
    expect(error.code).toBe('invalidInput');
    expect(error.message).toContain('the program does not link');
    expect(alive.size).toBe(0);
    expect(ledger.snapshot().objects).toBe(0);
  });

  it('reads the failure of a program linked in the background when the program is read', () => {
    const { gl, alive } = counted({ linkFails: true });
    const { gpu, ledger } = open(gl);
    const compile = gpu.compile('v', 'f', { varyings: ['out'] });
    expect(compile.done).toBe(true);
    expect(refusal(() => compile.program).code).toBe('invalidInput');
    expect(refusal(() => compile.program).code).toBe('invalidInput');
    expect(alive.size).toBe(0);
    expect(ledger.snapshot().objects).toBe(0);
  });

  it('keeps a program linked in the background until the part ends', () => {
    const { gl, alive } = counted();
    const { gpu, ledger } = open(gl);
    const taken = gpu.compile('v', 'f');
    const { program } = taken;
    expect(taken.program).toBe(program);
    expect(ledger.snapshot().objects).toBe(1);
    const waiting = gpu.compile('v', 'f');
    gpu.close();
    expect(alive.size).toBe(0);
    expect(ledger.snapshot().objects).toBe(0);
    expect(refusal(() => waiting.program).code).toBe('invalidState');
  });
});

describe('however a part ends, nothing of it stays', () => {
  it.each([
    ['bufferData', (gpu: GpuResources) => gpu.buffer(10)],
    ['bindBuffer', (gpu: GpuResources) => gpu.buffer(10)],
    ['texStorage2D', (gpu: GpuResources) => gpu.texture(2, 2, 0x8058)],
    ['bindTexture', (gpu: GpuResources) => gpu.texture(2, 2, 0x8058)],
  ])('an allocation that fails in %s', (failOn, allocate) => {
    const { gl, alive } = counted({ failOn });
    const { gpu, ledger } = open(gl);
    expect(() => allocate(gpu)).toThrow(`${failOn} failed`);
    expect(alive.size).toBe(0);
    expect(ledger.snapshot().objects).toBe(0);
    expect(ledger.audit()).toBe(true);
  });

  it('a lost context, that makes nothing', () => {
    const { gl, alive } = counted({ lost: true });
    const { gpu, ledger } = open(gl);
    expect(refusal(() => gpu.buffer(10)).code).toBe('invalidState');
    expect(refusal(() => gpu.vertexArray()).code).toBe('invalidState');
    expect(alive.size).toBe(0);
    expect(ledger.snapshot().objects).toBe(0);
  });

  it('the end of the part, with everything it made and what it opened for rows', () => {
    const { gl, alive } = counted();
    const { gpu, ledger } = open(gl);
    gpu.buffer(100);
    gpu.texture(2, 2, gl.RGBA8);
    gpu.vertexArray();
    gpu.transformFeedback();
    gpu.fence();
    gpu.program('v', 'f');
    const rows = gpu.openRows(() => 10_000);
    rows.buffer(2_000);
    expect(ledger.snapshot().rowBytes).toBe(2_000);
    expect(ledger.audit()).toBe(true);
    let stopped = 0;
    gpu.signal.addEventListener('abort', () => stopped++);
    gpu.close();
    gpu.close();
    expect(stopped).toBe(1);
    expect(rows.signal.aborted).toBe(true);
    expect(alive.size).toBe(0);
    expect(ledger.snapshot().bytes).toBe(0);
    expect(ledger.snapshot().objects).toBe(0);
    expect(ledger.audit()).toBe(true);
  });

  it('a result that arrives after the end allocates nothing', () => {
    const { gl, alive, calls } = counted();
    const { gpu, ledger } = open(gl);
    gpu.close();
    calls.length = 0;
    for (const late of [
      () => gpu.buffer(10),
      () => gpu.texture(2, 2, gl.RGBA8),
      () => gpu.vertexArray(),
      () => gpu.transformFeedback(),
      () => gpu.fence(),
      () => gpu.program('v', 'f'),
      () => gpu.compile('v', 'f'),
      () => gpu.openRows(() => 1),
    ]) {
      expect(refusal(late).code).toBe('invalidState');
    }
    expect(calls).toEqual([]);
    expect(alive.size).toBe(0);
    expect(ledger.snapshot().objects).toBe(0);
  });
});

describe('the rows of a part', () => {
  it('are out of its share and of the limit of the instance, under a limit of their own', () => {
    const { gl } = counted();
    const { gpu, ledger } = open(gl);
    gpu.buffer(500);
    const rows = gpu.openRows(() => 5_000);
    rows.buffer(4_000);
    expect(ledger.outsideRowBytes).toBe(500);
    const error = refusal(() => rows.buffer(1_001));
    expect(error.code).toBe('tooLarge');
    expect(error.retryable).toBe(true);
    expect(rows.memory().limitBytes).toBe(5_000);
  });

  it('go on their own, the part stays', () => {
    const { gl, alive } = counted();
    const { gpu, ledger } = open(gl);
    gpu.buffer(100);
    const rows = gpu.openRows(() => 5_000);
    rows.buffer(1_000);
    rows.close();
    expect(alive.size).toBe(1);
    expect(ledger.snapshot().bytes).toBe(100);
    gpu.close();
    expect(alive.size).toBe(0);
  });
});

describe('`rows` of a part', () => {
  it('allocates out of the share and of the limit of the instance, told apart in the ledger', () => {
    const { gl, alive } = counted();
    const ledger = new GpuLedger();
    ledger.limitBytes = 1_000;
    const gpu = new GpuResources({
      gl,
      ledger,
      owner: 'acme',
      share: 0.1,
      rowsLimitBytes: () => 5_000,
    });
    expect(gpu.rows).toBe(gpu.rows);
    expect(gpu.rows.rows).toBe(gpu.rows);
    gpu.rows.buffer(4_000);
    gpu.buffer(100);
    expect(ledger.snapshot().rowBytes).toBe(4_000);
    expect(ledger.outsideRowBytes).toBe(100);
    expect(ledger.snapshot().byOwner).toEqual({ acme: 4_100 });
    expect(gpu.memory().gpuBytes).toBe(100);
    expect(gpu.rows.memory().gpuBytes).toBe(4_000);
    expect(refusal(() => gpu.rows.buffer(1_001)).code).toBe('tooLarge');
    gpu.close();
    expect(alive.size).toBe(0);
    expect(ledger.snapshot().objects).toBe(0);
  });
});

describe('the ledger of a part', () => {
  it('tells when its sums do not agree with what is recorded', () => {
    const { gl } = counted();
    const { gpu, ledger } = open(gl);
    gpu.buffer(100);
    expect(ledger.audit()).toBe(true);
    (ledger as unknown as { owners: Map<string, number> }).owners.set('acme', 1);
    expect(ledger.audit()).toBe(false);
  });
});
