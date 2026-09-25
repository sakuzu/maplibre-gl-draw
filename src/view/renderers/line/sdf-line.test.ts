// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for SDFLineRenderer
 *
 * Color and opacity are passed to the shader as instance attributes, so this verifies the pure
 * function that computes the color written into the buffer. It also checks the index computation
 * for partially updating the coordinate texture of a retained batch (GL is replaced with a
 * minimal stub).
 */

import { describe, expect, it, vi } from 'vitest';
import { toLineInstanceColor } from './line-geometry.js';
import type { RetainedLineBatch } from './line-types.js';
import type { Color } from './sdf-line.js';
import { SDFLineRenderer } from './sdf-line.js';

describe('toLineInstanceColor', () => {
  it('folds the opacity into every component (premultiplied alpha)', () => {
    const color: Color = [1, 0.5, 0, 1];

    expect(toLineInstanceColor(color, 0.5)).toEqual([0.5, 0.25, 0, 0.5]);
  });

  it('returns the color unchanged at opacity 1', () => {
    const color: Color = [0.2, 0.4, 0.6, 0.8];

    expect(toLineInstanceColor(color, 1)).toEqual(color);
  });

  it('becomes fully transparent at opacity 0', () => {
    expect(toLineInstanceColor([1, 1, 1, 1], 0)).toEqual([0, 0, 0, 0]);
  });

  it('gives the same composited result as the previous u_color * (coverage * u_opacity)', () => {
    const color: Color = [0.9, 0.3, 0.1, 1];
    const opacity = 0.4;
    const coverage = 0.75;

    // New path: multiply the pre-folded color by the coverage
    const instanceColor = toLineInstanceColor(color, opacity);
    const next = instanceColor.map((c) => c * coverage);
    // Old path: multiply the uniform color by (coverage * opacity)
    const prev = color.map((c) => c * (coverage * opacity));

    for (let i = 0; i < 4; i++) {
      expect(next[i]).toBeCloseTo(prev[i], 10);
    }
  });

  it('normalizes out-of-range or invalid opacity values', () => {
    expect(toLineInstanceColor([1, 1, 1, 1], 2)).toEqual([1, 1, 1, 1]);
    expect(toLineInstanceColor([1, 1, 1, 1], -1)).toEqual([0, 0, 0, 0]);
    expect(toLineInstanceColor([1, 1, 1, 1], Number.NaN)).toEqual([1, 1, 1, 1]);
  });
});

describe('patchRetainedBatchCoords (applying the diff from a vertex drag)', () => {
  /** A minimal GL stub that records texSubImage2D calls */
  function createGlStub() {
    const calls: Array<{ x: number; y: number; data: number[] }> = [];
    const bound: WebGLTexture[] = [];

    const gl = {
      TEXTURE_2D: 'TEXTURE_2D',
      TEXTURE0: 'TEXTURE0',
      RGBA: 'RGBA',
      FLOAT: 'FLOAT',
      activeTexture: vi.fn(),
      bindTexture: (_target: string, texture: WebGLTexture): void => {
        bound.push(texture);
      },
      texSubImage2D: (
        _target: string,
        _level: number,
        x: number,
        y: number,
        _w: number,
        _h: number,
        _format: string,
        _type: string,
        data: Float32Array,
      ): void => {
        calls.push({ x, y, data: [...data] });
      },
    };

    return { gl, calls, bound };
  }

  /** Calls only the method without using WebGL */
  function createRenderer(gl: unknown): SDFLineRenderer {
    const renderer = Object.create(SDFLineRenderer.prototype) as SDFLineRenderer;
    (renderer as unknown as { gl: unknown }).gl = gl;
    return renderer;
  }

  const batch = {
    texture: {} as WebGLTexture,
    texSize: 4,
    origin: [10, 20],
  } as unknown as RetainedLineBatch;

  it('computes the texel position from coordIndex and writes the offset from the origin', () => {
    const { gl, calls, bound } = createGlStub();

    createRenderer(gl).patchRetainedBatchCoords(batch, [
      { coordIndex: 0, lngLat: [10.5, 20.25] },
      // A row is 4 texels, so 6 is (2, 1)
      { coordIndex: 6, lngLat: [9, 21] },
    ]);

    expect(bound).toEqual([batch.texture]);
    expect(calls).toEqual([
      { x: 0, y: 0, data: [0.5, 0.25, 0, 0] },
      { x: 2, y: 1, data: [-1, 1, 0, 0] },
    ]);
  });

  it('does not write for indices outside the texture', () => {
    const { gl, calls } = createGlStub();

    createRenderer(gl).patchRetainedBatchCoords(batch, [
      { coordIndex: -1, lngLat: [10, 20] },
      // texSize * texSize = 16, so 16 is out of range
      { coordIndex: 16, lngLat: [10, 20] },
      { coordIndex: 1.5, lngLat: [10, 20] },
      { coordIndex: 15, lngLat: [11, 20] },
    ]);

    expect(calls).toEqual([{ x: 3, y: 3, data: [1, 0, 0, 0] }]);
  });

  it('does not touch the texture when there is no diff', () => {
    const { gl, calls, bound } = createGlStub();

    createRenderer(gl).patchRetainedBatchCoords(batch, []);

    expect(calls).toEqual([]);
    expect(bound).toEqual([]);
  });
});
