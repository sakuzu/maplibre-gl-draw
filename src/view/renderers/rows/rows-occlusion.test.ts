// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { calculateOffsetUniforms } from '../../shaders/helpers.js';
import { TerrainContext } from '../../terrain/context.js';
import {
  MAX_SAMPLES,
  MIN_SAMPLES,
  NEAR_SKIP,
  NODES_WITHOUT_STEP,
  SELF_SKIP_NODES,
  TERRAIN_GHOST_OPACITY,
} from '../../terrain/occlusion.js';
import type { TerrainRenderState } from '../../terrain/state.js';
import { buildBulkFramesVertexSource } from '../../ui/bulk-frames.js';
import { TERRAIN_OCCLUSION_GLSL, TerrainOcclusionUniforms } from './rows-occlusion.js';
import { buildRowsVertexSource } from './rows-shader.js';

/** A GL that keeps the uniforms written, by their names */
function uniformGL() {
  const written = new Map<string, number[]>();
  const gl = {
    getUniformLocation: (_program: unknown, name: string) => ({ name }),
    uniform1f: (location: { name: string }, x: number) => written.set(location.name, [x]),
    uniform3f: (location: { name: string }, x: number, y: number, z: number) =>
      written.set(location.name, [x, y, z]),
  } as unknown as WebGL2RenderingContext;
  return { gl, written };
}

/** A terrain state drawn, with the camera of the occlusion test of the CPU */
function terrainWithCamera(camera: readonly [number, number, number] | null): TerrainContext {
  const terrain = new TerrainContext();
  terrain.renderState = {
    ...terrain.renderState,
    active: true,
    stepGrid: 1 / 2 ** 20,
  } as TerrainRenderState;
  terrain.anchorFrame = {
    ...terrain.anchorFrame,
    terrain: {} as never,
    elevationScale: 1e-7,
    cameraMercator: camera,
  };
  return terrain;
}

describe('the test of the terrain hiding a point, in a vertex shader', () => {
  it('takes the constants of the test on the CPU', () => {
    const glsl = TERRAIN_OCCLUSION_GLSL;
    expect(glsl).toContain(`for (int i = 0; i < ${MAX_SAMPLES}; i++)`);
    expect(glsl).toContain(`min(${MAX_SAMPLES}.0, max(${MIN_SAMPLES}.0, ceil(horizontal / node)))`);
    expect(glsl).toContain(`min(0.5, ${SELF_SKIP_NODES}.0 * node / horizontal)`);
    expect(glsl).toContain(`horizontal / ${NODES_WITHOUT_STEP}.0`);
    expect(glsl).toContain(`float t = ${NEAR_SKIP} + (tEnd - ${NEAR_SKIP})`);
    expect(glsl).toContain(`return ${TERRAIN_GHOST_OPACITY};`);
  });

  it('passes over the samples off the atlas of the ground drawn', () => {
    const glsl = TERRAIN_OCCLUSION_GLSL;
    const loop = glsl.slice(glsl.indexOf('for (int i = 0;'));
    expect(loop.indexOf('if (!terrainGhostOnAtlas(p.xy)) continue;')).toBeGreaterThan(0);
    expect(loop.indexOf('if (!terrainGhostOnAtlas(p.xy)) continue;')).toBeLessThan(
      loop.indexOf('dem_elevation_meters(p.xy)'),
    );
  });

  it('is made by the points of the rows and by the frames of their points', () => {
    const rows = buildRowsVertexSource('', '');
    expect(rows).toContain(TERRAIN_OCCLUSION_GLSL);
    expect(rows).toContain('terrain_occlusion_opacity(offset, a_tail.w)');
    const frames = buildBulkFramesVertexSource('', '');
    expect(frames).toContain(TERRAIN_OCCLUSION_GLSL);
    expect(frames).toContain('v_ghost = terrainGhostOpacity(');
  });
});

describe('the uniforms of the test', () => {
  const center = calculateOffsetUniforms([10, 20], new Float32Array(16));

  it('write the camera from the center of the draw, on the copy of the world nearest to it', () => {
    const { gl, written } = uniformGL();
    const uniforms = new TerrainOcclusionUniforms(gl, {} as WebGLProgram);
    const [cx, cy] = center.centerMercator;
    uniforms.write(true, terrainWithCamera([cx + 1.25, cy - 0.01, 3e-4]), center);
    expect(written.get('u_ghost_on')).toEqual([1]);
    const [x, y, z] = written.get('u_ghost_camera') as number[];
    expect(x).toBeCloseTo(0.25, 12);
    expect(y).toBeCloseTo(-0.01, 12);
    expect(z).toBe(3e-4);
    expect(written.get('u_ghost_node')).toEqual([1 / 2 ** 20]);
  });

  it('turn the test off when it is not wanted, or the camera is not known', () => {
    for (const [wanted, camera] of [
      [false, [0.5, 0.5, 1e-4]],
      [true, null],
    ] as const) {
      const { gl, written } = uniformGL();
      new TerrainOcclusionUniforms(gl, {} as WebGLProgram).write(
        wanted,
        terrainWithCamera(camera),
        center,
      );
      expect(written.get('u_ghost_on')).toEqual([0]);
      expect(written.has('u_ghost_camera')).toBe(false);
    }
  });
});
