// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for the GL resources of the SDF line renderer
 *
 * The coordinate texture of immediate mode is allocated as a power of two and reused while
 * the data fits, and a texture larger than the GPU allows is never allocated. GL is replaced
 * with a stub that records the allocations and uploads.
 */

import { describe, expect, it } from 'vitest';
import { createCoordTexture, ImmediateCoordTexture } from './line-gl.js';

function createGlStub() {
  const storage: number[] = [];
  const uploads: number[] = [];
  const deleted: object[] = [];
  let created = 0;
  const gl = {
    TEXTURE_2D: 1,
    RGBA32F: 2,
    RGBA: 3,
    FLOAT: 4,
    createTexture: () => ({ id: ++created }),
    deleteTexture: (texture: object) => deleted.push(texture),
    bindTexture: () => {},
    texParameteri: () => {},
    texStorage2D: (_t: number, _l: number, _f: number, size: number) => storage.push(size),
    texSubImage2D: (_t: number, _l: number, _x: number, _y: number, size: number) =>
      uploads.push(size),
  } as unknown as WebGL2RenderingContext;
  return { gl, storage, uploads, deleted };
}

describe('ImmediateCoordTexture', () => {
  it('allocates a power of two and uploads only the size of the data', () => {
    const { gl, storage, uploads } = createGlStub();
    const texture = new ImmediateCoordTexture(gl);

    expect(texture.upload(new Float32Array(5 * 5 * 4), 5, 4096)).toBe(true);

    expect(storage).toEqual([8]);
    expect(uploads).toEqual([5]);
    expect(texture.size).toBe(8);
  });

  it('reuses the texture while the data fits and reallocates when it grows', () => {
    const { gl, storage, uploads, deleted } = createGlStub();
    const texture = new ImmediateCoordTexture(gl);

    texture.upload(new Float32Array(64), 4, 4096);
    const first = texture.texture;
    texture.upload(new Float32Array(16), 2, 4096);
    expect(texture.texture).toBe(first);
    texture.upload(new Float32Array(400), 10, 4096);

    expect(storage).toEqual([4, 16]);
    expect(uploads).toEqual([4, 2, 10]);
    expect(deleted).toEqual([first]);
  });

  it('refuses data larger than the limit and never allocates past it', () => {
    const { gl, storage } = createGlStub();
    const texture = new ImmediateCoordTexture(gl);

    expect(texture.upload(new Float32Array(0), 9, 8)).toBe(false);
    expect(storage).toEqual([]);
    texture.upload(new Float32Array(0), 5, 6);
    expect(storage).toEqual([6]);
  });

  it('deletes the texture on dispose', () => {
    const { gl, deleted } = createGlStub();
    const texture = new ImmediateCoordTexture(gl);
    texture.upload(new Float32Array(0), 2, 4096);
    const allocated = texture.texture;

    texture.dispose();

    expect(deleted).toEqual([allocated]);
    expect(texture.texture).toBeNull();
    expect(texture.size).toBe(0);
  });
});

describe('createCoordTexture', () => {
  it('allocates exactly the size of the data', () => {
    const { gl, storage, uploads } = createGlStub();

    expect(createCoordTexture(gl, new Float32Array(0), 3, 4096)).not.toBeNull();
    expect(storage).toEqual([3]);
    expect(uploads).toEqual([3]);
  });

  it('returns null when the data does not fit in a texture of the GPU', () => {
    const { gl, storage } = createGlStub();

    expect(createCoordTexture(gl, new Float32Array(0), 9, 8)).toBeNull();
    expect(storage).toEqual([]);
  });
});
