// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The terrain of the building blocks of the second entry, reached through the public render
 * context
 *
 * A renderer of an extension only holds the `RenderContext` it receives (or its `terrain`).
 * The building blocks that draw on the terrain must find the terrain state of the instance
 * behind it. `null` draws without terrain, and an object the engine did not hand out is refused
 * with `invalid-input`, as `viewUniforms` refuses it.
 */

import type { ProjectionData } from 'maplibre-gl';
import { afterEach, describe, expect, it } from 'vitest';
import type { ScreenContext, TerrainSurface } from '../../api/extension/context.js';
import type { RenderContext } from '../../api/extension/render.js';
import { createTerrainSurface } from '../../api/impl/contexts.js';
import { createRenderContext } from '../../api/impl/render-context.js';
import type { FrameDrawContext } from '../../extension/renderers.js';
import { beginRenderFrame } from '../shaders/frame.js';
import { ProjectionUniformManager } from '../shaders/projection.js';
import { drawQuadOnTerrain } from '../shaders/quad.js';
import { terrainStateOf } from './binding.js';
import { releaseTerrainContext, TerrainContext, type TerrainRenderState } from './context.js';
import { terrainTessellationStep } from './polygon.js';
import { setTerrainRenderState } from './state.js';

const ACTIVE_TERRAIN: TerrainRenderState = {
  active: true,
  atlasTexture: {} as WebGLTexture,
  atlasRect: [0, 0, 1, 1],
  atlasSize: [256, 256],
  elevationScale: 1 / 40_000_000,
  liftMeters: 0.1,
  stepMeters: 64,
  stepGrid: 1 / (2 ** 12 * 128),
  tessellationRegion: null,
  tessellationTiling: null,
  generation: 1,
};

const PROJECTION = { mainMatrix: new Float32Array(16) } as unknown as ProjectionData;

/** A GL that records the uniform writes */
function createMockGL(): { gl: WebGL2RenderingContext; terrainOn: () => number | undefined } {
  const written = new Map<string, number>();
  const record = (loc: { name: string }, value: number | number[]) =>
    written.set(loc.name, Array.isArray(value) ? value[0] : value);
  const gl = {
    getUniformLocation: (_program: unknown, name: string) => ({ name }),
    uniform1f: record,
    uniform1i: record,
    uniform2f: record,
    uniform3f: record,
    uniform4f: record,
    uniform2fv: record,
    uniform3fv: record,
    uniform4fv: record,
    uniformMatrix4fv: (loc: { name: string }, _t: boolean, values: number[]) => record(loc, values),
  } as unknown as WebGL2RenderingContext;
  return { gl, terrainOn: () => written.get('u_terrain_on') };
}

/** A render context of the contract over a terrain state */
function renderContextOver(terrain: TerrainContext): RenderContext {
  const base = {
    terrain,
    shaderData: {},
    mainMatrixArray: new Float64Array(16),
    centerLngLat: [0, 0],
    pixelRatio: 1,
    opacity: 1,
  } as unknown as FrameDrawContext;
  return createRenderContext(
    base,
    PROJECTION,
    14,
    createTerrainSurface(terrain),
    {} as ScreenContext,
    () => {
      throw new Error('no look is read');
    },
  );
}

/** The u_terrain_on a manager writes after `setTerrain(source)` */
function terrainOnWith(source: RenderContext | TerrainSurface | null): number | undefined {
  const { gl, terrainOn } = createMockGL();
  const manager = new ProjectionUniformManager(gl);
  manager.setTerrain(source);
  manager.getLocations({} as WebGLProgram);
  beginRenderFrame();
  manager.setUniforms(PROJECTION, null);
  return terrainOn();
}

describe('the terrain behind a render context', () => {
  const terrain = new TerrainContext();
  afterEach(() => releaseTerrainContext(terrain));

  it('finds the state from the render context and from its terrain', () => {
    const ctx = renderContextOver(terrain);
    expect(terrainStateOf(ctx)).toBe(terrain);
    expect(terrainStateOf(ctx.terrain)).toBe(terrain);
  });

  it('finds no state for null, and refuses an object the engine did not hand out', () => {
    expect(terrainStateOf(null)).toBeNull();
    const refused = expect.objectContaining({ code: 'invalid-input' });
    expect(() => terrainStateOf({} as TerrainSurface)).toThrow(refused);
    expect(() => terrainStateOf({ terrain: {} } as RenderContext)).toThrow(refused);
  });

  it('lets ProjectionUniformManager draw on the terrain of the render context', () => {
    setTerrainRenderState(terrain, ACTIVE_TERRAIN);
    const ctx = renderContextOver(terrain);
    expect(terrainOnWith(ctx)).toBe(1);
    expect(terrainOnWith(ctx.terrain)).toBe(1);
    expect(terrainOnWith(null)).toBe(0);
    expect(() => terrainOnWith({} as TerrainSurface)).toThrow(
      expect.objectContaining({ code: 'invalid-input' }),
    );
  });

  it('gives the tessellation step of the terrain of the render context', () => {
    const ctx = renderContextOver(terrain);
    expect(terrainTessellationStep(ctx)).toBeNull();
    setTerrainRenderState(terrain, ACTIVE_TERRAIN);
    expect(terrainTessellationStep(ctx)?.grid).toBe(ACTIVE_TERRAIN.stepGrid);
    expect(terrainTessellationStep(ctx.terrain)?.grid).toBe(ACTIVE_TERRAIN.stepGrid);
    expect(() => terrainTessellationStep({} as TerrainSurface)).toThrow(
      expect.objectContaining({ code: 'invalid-input' }),
    );
  });

  it('drapes no quad without terrain', () => {
    const corners = {
      topLeft: [0, 1],
      topRight: [1, 1],
      bottomLeft: [0, 0],
      bottomRight: [1, 0],
    } as const;
    const content = { glsl: '', bind: () => {} };
    expect(drawQuadOnTerrain(renderContextOver(terrain), corners, content, 1)).toBe(false);
    expect(() => drawQuadOnTerrain({} as TerrainSurface, corners, content, 1)).toThrow(
      expect.objectContaining({ code: 'invalid-input' }),
    );
  });
});
