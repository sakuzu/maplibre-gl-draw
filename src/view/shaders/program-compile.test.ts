// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from 'vitest';
import { ProgramCompile } from './helpers.js';

/** A GL whose program is done, and links, as a test says */
function glOf(parallel: boolean, state: { done: boolean; linked: boolean }) {
  const gl = {
    VERTEX_SHADER: 1,
    FRAGMENT_SHADER: 2,
    LINK_STATUS: 3,
    SEPARATE_ATTRIBS: 4,
    getExtension: () => (parallel ? {} : null),
    createShader: () => ({}),
    shaderSource: vi.fn(),
    compileShader: vi.fn(),
    createProgram: () => ({}),
    attachShader: vi.fn(),
    transformFeedbackVaryings: vi.fn(),
    linkProgram: vi.fn(),
    deleteShader: vi.fn(),
    deleteProgram: vi.fn(),
    getShaderInfoLog: () => 'the log',
    getProgramInfoLog: () => '',
    getProgramParameter: vi.fn((_program: unknown, name: number) =>
      name === 3 ? state.linked : state.done,
    ),
  };
  return gl as typeof gl & WebGL2RenderingContext;
}

const SOURCE = '#version 300 es\nvoid main() {}';

describe('ProgramCompile', () => {
  it('tells it is done without asking whether it linked, where the context compiles in parallel', () => {
    const state = { done: false, linked: true };
    const gl = glOf(true, state);
    const compile = new ProgramCompile(gl, SOURCE, SOURCE);
    expect(compile.done).toBe(false);
    state.done = true;
    expect(compile.done).toBe(true);
    expect(gl.getProgramParameter).not.toHaveBeenCalledWith(expect.anything(), gl.LINK_STATUS);
    expect(compile.take()).toBeDefined();
    expect(gl.deleteShader).toHaveBeenCalledTimes(2);
  });

  it('is done at once without the extension, the wait left to take', () => {
    const gl = glOf(false, { done: false, linked: true });
    const compile = new ProgramCompile(gl, SOURCE, SOURCE);
    expect(compile.done).toBe(true);
    expect(gl.getProgramParameter).not.toHaveBeenCalled();
    compile.take();
    expect(gl.getProgramParameter).toHaveBeenCalledTimes(1);
  });

  it('gives the captured outputs before linking', () => {
    const gl = glOf(false, { done: true, linked: true });
    new ProgramCompile(gl, SOURCE, SOURCE, ['v_out']);
    expect(gl.transformFeedbackVaryings).toHaveBeenCalledWith(expect.anything(), ['v_out'], 4);
  });

  it('throws the log when it did not link, and lets go of the program', () => {
    const gl = glOf(false, { done: true, linked: false });
    const compile = new ProgramCompile(gl, SOURCE, SOURCE);
    expect(() => compile.take()).toThrow('the log');
    expect(gl.deleteProgram).toHaveBeenCalledTimes(1);
  });

  it('lets go of a program not taken, once', () => {
    const gl = glOf(false, { done: true, linked: true });
    const compile = new ProgramCompile(gl, SOURCE, SOURCE);
    compile.dispose();
    compile.dispose();
    expect(gl.deleteProgram).toHaveBeenCalledTimes(1);
  });
});
