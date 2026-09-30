// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The terrain of the building blocks of the second entry, reached through the public render
 * context
 *
 * A renderer of an extension only holds the `RenderContext` it receives (or its `terrain`).
 * The building blocks that draw on the terrain must find the terrain state of the instance
 * behind it, and an object the engine did not hand out must draw without terrain.
 */

import type { ProjectionData } from 'maplibre-gl';
import { afterEach, describe, expect, it } from 'vitest';
import type { TerrainAnchors } from '../../api/extension/context.js';
import type { RenderContext } from '../../api/extension/render.js';
import { createTerrainAnchors } from '../../api/impl/contexts.js';
import { createRenderContext } from '../../api/impl/render-context.js';
import type { FrameDrawContext } from '../../extension/renderers.js';
import { beginRenderFrame } from '../shaders/frame.js';
import { ProjectionUniformManager } from '../shaders/projection.js';
import { drawQuadSurfaceOnTerrain } from '../shaders/quad.js';
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
    {} as WebGL2RenderingContext,
    base,
    PROJECTION,
    14,
    createTerrainAnchors(terrain),
  );
}

/** The u_terrain_on a manager writes after `setTerrain(source)` */
function terrainOnWith(source: RenderContext | TerrainAnchors | null): number | undefined {
  const { gl, terrainOn } = createMockGL();
  const manager = new ProjectionUniformManager(gl);
  manager.setTerrain(source);
  manager.getLocations({} as WebGLProgram);
  beginRenderFrame();
  manager.setUniforms(PROJECTION, 14, null);
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

  it('finds no state for null and for an object the engine did not hand out', () => {
    expect(terrainStateOf(null)).toBeNull();
    expect(terrainStateOf({} as TerrainAnchors)).toBeNull();
    expect(terrainStateOf({ terrain: {} } as RenderContext)).toBeNull();
  });

  it('lets ProjectionUniformManager draw on the terrain of the render context', () => {
    setTerrainRenderState(terrain, ACTIVE_TERRAIN);
    const ctx = renderContextOver(terrain);
    expect(terrainOnWith(ctx)).toBe(1);
    expect(terrainOnWith(ctx.terrain)).toBe(1);
    expect(terrainOnWith(null)).toBe(0);
    expect(terrainOnWith({} as TerrainAnchors)).toBe(0);
  });

  it('gives the tessellation step of the terrain of the render context', () => {
    const ctx = renderContextOver(terrain);
    expect(terrainTessellationStep(ctx)).toBeNull();
    setTerrainRenderState(terrain, ACTIVE_TERRAIN);
    expect(terrainTessellationStep(ctx)?.grid).toBe(ACTIVE_TERRAIN.stepGrid);
    expect(terrainTessellationStep(ctx.terrain)?.grid).toBe(ACTIVE_TERRAIN.stepGrid);
    expect(terrainTessellationStep({} as TerrainAnchors)).toBeNull();
  });

  it('paints no surface without terrain', () => {
    const corners = [
      [0, 1],
      [1, 1],
      [0, 0],
      [1, 0],
    ] as unknown as Parameters<typeof drawQuadSurfaceOnTerrain>[1];
    const surface = {} as Parameters<typeof drawQuadSurfaceOnTerrain>[2];
    expect(drawQuadSurfaceOnTerrain(renderContextOver(terrain), corners, surface, 1)).toBe(false);
    expect(drawQuadSurfaceOnTerrain({} as TerrainAnchors, corners, surface, 1)).toBe(false);
  });
});
