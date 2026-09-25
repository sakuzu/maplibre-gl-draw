// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for binding the DEM to the drape shaders
 *
 * The drape rebuilds MapLibre's terrain mesh, so it must displace it by the same exaggeration
 * as the map. Hard-coding 1 made polygons and lines sink under an exaggerated terrain.
 */

import { describe, expect, it, vi } from 'vitest';

import { applyDrapeTerrainUniforms, type UniformSet } from './shared.js';

function createGl() {
  return {
    TEXTURE0: 0x84c0,
    TEXTURE_2D: 0x0de1,
    activeTexture: vi.fn(),
    bindTexture: vi.fn(),
    uniform1i: vi.fn(),
    uniform1f: vi.fn(),
    uniform4f: vi.fn(),
    uniformMatrix4fv: vi.fn(),
  };
}

describe('applyDrapeTerrainUniforms', () => {
  it('writes the terrain exaggeration rather than a constant', () => {
    const gl = createGl();
    const exaggerationLoc = {} as WebGLUniformLocation;
    const set: UniformSet = { u_terrain_exaggeration: exaggerationLoc };
    applyDrapeTerrainUniforms(
      gl as unknown as WebGL2RenderingContext,
      set,
      {
        texture: {} as WebGLTexture,
        matrix: new Float32Array(16),
        unpack: [0, 0, 0, 0],
        dim: 256,
        exaggeration: 1.5,
      },
      3,
    );
    expect(gl.uniform1f).toHaveBeenCalledWith(exaggerationLoc, 1.5);
  });
});
