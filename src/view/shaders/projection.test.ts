// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Verification of the terrain switch of the projection uniforms
 *
 * There is a single thing being watched: that on a frame that draws polygons
 * and lines flat (the zoomed-out band; surfacesFlattened in
 * `terrain/context.ts`) only the renderers that stick to the ground surface
 * stop applying the elevation, while the symbol renderers do not.
 *
 * In the zoomed-out band the subdivision region (DEM atlas ∩ view) covers only
 * part of the screen, so triangles outside the region come out unsplit. Only
 * the vertices pick up the elevation, the interior pierces through the
 * mountain, and on a pitched view it turns into a vertical curtain (a cliff).
 * Symbols are determined by a single vertex, so they do not create cliffs, and
 * stopping the elevation would put them out of step with hit testing.
 */

import type { ProjectionData } from 'maplibre-gl';
import { describe, expect, it } from 'vitest';
import {
  releaseTerrainContext,
  TerrainContext,
  type TerrainRenderState,
} from '../terrain/context.js';
import {
  setTerrainRenderState,
  setTerrainSurfacesFlattened,
  withoutTerrainElevation,
} from '../terrain/state.js';
import { beginRenderFrame } from './frame.js';
import { ProjectionUniformManager } from './projection.js';

/** A mock GL that records uniform writes */
function createMockGL(): {
  gl: WebGL2RenderingContext;
  lastValue: (name: string) => number | undefined;
} {
  const written = new Map<string, number>();
  const gl = {
    getUniformLocation: (_program: unknown, name: string) => ({ name }),
    uniform1f: (loc: { name: string }, value: number) => written.set(loc.name, value),
    uniform1i: (loc: { name: string }, value: number) => written.set(loc.name, value),
    uniform2f: (loc: { name: string }, x: number) => written.set(loc.name, x),
    uniform3f: (loc: { name: string }, x: number) => written.set(loc.name, x),
    uniform4f: (loc: { name: string }, x: number) => written.set(loc.name, x),
    uniform2fv: (loc: { name: string }, values: number[]) => written.set(loc.name, values[0]),
    uniform3fv: (loc: { name: string }, values: number[]) => written.set(loc.name, values[0]),
    uniform4fv: (loc: { name: string }, values: number[]) => written.set(loc.name, values[0]),
    uniformMatrix4fv: (loc: { name: string }, _t: boolean, values: number[]) =>
      written.set(loc.name, values[0]),
  } as unknown as WebGL2RenderingContext;

  return { gl, lastValue: (name: string) => written.get(name) };
}

/** The state of a frame where the DEM atlas is available */
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

/** Draws one frame and reads u_terrain_on */
function terrainOnOf(
  terrain: TerrainContext,
  surface: boolean,
  draw?: (run: () => void) => void,
): number | undefined {
  const { gl, lastValue } = createMockGL();
  const manager = new ProjectionUniformManager(gl, { surface, terrain });
  manager.getLocations({} as WebGLProgram);
  beginRenderFrame();
  const run = (): void => manager.setUniforms(PROJECTION, 14, null);
  if (draw) draw(run);
  else run();
  return lastValue('u_terrain_on');
}

describe('a frame that draws polygons and lines flat', () => {
  const context = new TerrainContext();

  /** Builds a frame with terrain alive */
  function withTerrain(flattened: boolean, body: () => void): void {
    try {
      setTerrainRenderState(context, ACTIVE_TERRAIN);
      setTerrainSurfacesFlattened(context, flattened);
      body();
    } finally {
      releaseTerrainContext(context);
    }
  }

  it('adds the elevation in both surface and symbol renderers on a normal frame', () => {
    withTerrain(false, () => {
      expect(terrainOnOf(context, true)).toBe(1);
      expect(terrainOnOf(context, false)).toBe(1);
    });
  });

  it('stops the elevation only in the surface renderers on a flat-drawing frame', () => {
    withTerrain(true, () => {
      expect(terrainOnOf(context, true)).toBe(0);
      // Points and handles are determined by a single vertex, so they do not create
      // cliffs. Stopping the elevation would put them out of step with the anchor
      // projection (hit testing)
      expect(terrainOnOf(context, false)).toBe(1);
    });
  });

  it('still applies the box selection suppression to both, as before', () => {
    withTerrain(false, () => {
      expect(terrainOnOf(context, true, (run) => withoutTerrainElevation(context, run))).toBe(0);
      expect(terrainOnOf(context, false, (run) => withoutTerrainElevation(context, run))).toBe(0);
    });
  });

  it('behaves as before (stays 0) with terrain disabled even when flattening is specified', () => {
    try {
      setTerrainSurfacesFlattened(context, true);
      expect(terrainOnOf(context, true)).toBe(0);
      expect(terrainOnOf(context, false)).toBe(0);
    } finally {
      releaseTerrainContext(context);
    }
  });
});

describe('the terrain of the draw instance', () => {
  it('reads only the context it was given, never another instance', () => {
    const drawn = new TerrainContext();
    const other = new TerrainContext();
    setTerrainRenderState(other, ACTIVE_TERRAIN);

    // The other instance has terrain alive; this one does not
    expect(terrainOnOf(drawn, true)).toBe(0);
    expect(terrainOnOf(other, true)).toBe(1);
  });

  it('draws without terrain when no context is set', () => {
    const { gl, lastValue } = createMockGL();
    const manager = new ProjectionUniformManager(gl);
    manager.getLocations({} as WebGLProgram);
    beginRenderFrame();
    manager.setUniforms(PROJECTION, 14, null);
    expect(lastValue('u_terrain_on')).toBe(0);
  });
});
