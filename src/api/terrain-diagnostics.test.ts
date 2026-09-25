// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for draw.getTerrainDiagnostics
 *
 * The diagnostics are a snapshot of plain values for debugging and measurement: they report
 * the numbers of the terrain state the last frame drew with, and never hand out a GL object.
 */

import { describe, expect, it } from 'vitest';
import { TerrainContext } from '../view/terrain/context.js';
import { setTerrainRenderState } from '../view/terrain/state.js';
import { createInstanceApi, type InstanceApiDeps } from './instance-api.js';

function createApi(terrain: TerrainContext | null) {
  const customLayer = terrain ? { id: 'layer', getTerrainContext: () => terrain } : { id: 'layer' };
  return createInstanceApi({ customLayer } as unknown as InstanceApiDeps);
}

describe('draw.getTerrainDiagnostics', () => {
  it('reports the numbers of the terrain state without the DEM atlas texture', () => {
    const terrain = new TerrainContext();
    setTerrainRenderState(terrain, {
      active: true,
      atlasTexture: {} as WebGLTexture,
      atlasRect: [0.1, 0.2, 4, 8],
      atlasSize: [512, 256],
      elevationScale: 1e-7,
      liftMeters: 0.5,
      stepMeters: 30,
      stepGrid: 0.001,
      tessellationRegion: null,
      tessellationTiling: null,
      generation: 3,
    });

    const { render } = createApi(terrain).getTerrainDiagnostics();

    expect(render).toEqual({
      active: true,
      atlasRect: [0.1, 0.2, 4, 8],
      atlasSize: [512, 256],
      elevationScale: 1e-7,
      liftMeters: 0.5,
      stepMeters: 30,
      stepGrid: 0.001,
      generation: 3,
    });
    expect('atlasTexture' in render).toBe(false);
  });

  it('reports an inactive terrain for a layer without a terrain context', () => {
    const { render, drape } = createApi(null).getTerrainDiagnostics();

    expect(render.active).toBe(false);
    expect(drape.used).toBe(false);
  });
});
