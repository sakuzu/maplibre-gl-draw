// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A quad shows its content the same way wherever it is drawn: the GLSL of the content is the
 * fragment of the program of the quad, its `bind` runs for each draw, and a quad allocates
 * nothing of its own for what it shows
 */

import { describe, expect, it, vi } from 'vitest';
import type { QuadDrapeContent } from '../terrain/drape/quad.js';
import { computeQuadVertices, QuadImageContent, QuadShader } from './quad.js';

const FILL_GLSL = `
uniform vec4 u_fill_color;
vec4 quadDrapeColor(vec2 uv, vec2 uvDx, vec2 uvDy, float shade) {
  return vec4(u_fill_color.rgb * shade * u_fill_color.a, u_fill_color.a);
}`;

/** A context that compiles anything and records the sources and the calls */
function fakeGL() {
  const sources: string[] = [];
  const calls: string[] = [];
  const gl = new Proxy(
    {},
    {
      get(_target, name: string) {
        if (name === 'shaderSource') {
          return (_shader: unknown, source: string) => sources.push(source);
        }
        if (name.startsWith('create') || name === 'getUniformLocation') return () => ({ name });
        if (name === 'getProgramParameter' || name === 'getShaderParameter') return () => true;
        if (/^[A-Z]/.test(name)) return name;
        return () => {
          calls.push(name);
          return undefined;
        };
      },
    },
  ) as unknown as WebGL2RenderingContext;
  return { gl, sources, calls };
}

const SHADER = { vertexShaderPrelude: '', define: '', variantName: 'test' };
const VERTICES = computeQuadVertices(0, 0, 1, 1, 0);
const PROJECTION = { mainMatrix: new Float32Array(16) } as never;

describe('a quad with a content', () => {
  it('compiles the GLSL of the content into its fragment shader', () => {
    const { gl, sources } = fakeGL();
    const content: QuadDrapeContent = { glsl: FILL_GLSL, bind: vi.fn() };
    new QuadShader(gl, content).ensureShader(SHADER);
    const fragment = sources.find((source) => source.includes('fragColor'));
    expect(fragment).toContain('uniform vec4 u_fill_color');
    expect(fragment).toContain('quadDrapeColor(v_texCoord, uvDx, uvDy, 1.0)');
  });

  it('binds the content for each draw, with the location of a uniform by its name', () => {
    const { gl } = fakeGL();
    const seen: unknown[] = [];
    const content: QuadDrapeContent = {
      glsl: FILL_GLSL,
      bind: (_gl, uniform) => seen.push(uniform('u_fill_color')),
    };
    const shader = new QuadShader(gl, content);
    shader.ensureShader(SHADER);
    shader.draw(VERTICES, 1, PROJECTION);
    shader.draw(VERTICES, 0.5, PROJECTION);
    expect(seen).toHaveLength(2);
    expect(seen[0]).toBe(seen[1]);
  });

  it('allocates nothing for what it shows when it draws', () => {
    const { gl, calls } = fakeGL();
    const shader = new QuadShader(gl, { glsl: FILL_GLSL, bind: vi.fn() });
    shader.ensureShader(SHADER);
    calls.length = 0;
    shader.draw(VERTICES, 1, PROJECTION);
    expect(calls.filter((call) => /texImage|texStorage|bufferData/.test(call))).toEqual([]);
  });

  it('shows a picture by default, from the texture its content is given', () => {
    const { gl, calls } = fakeGL();
    const shader = new QuadShader(gl);
    expect(shader.content).toBeInstanceOf(QuadImageContent);
    shader.ensureShader(SHADER);
    shader.content.texture = {} as WebGLTexture;
    shader.draw(VERTICES, 1, PROJECTION);
    expect(calls).toContain('bindTexture');
    expect(calls).toContain('drawArrays');
  });
});
