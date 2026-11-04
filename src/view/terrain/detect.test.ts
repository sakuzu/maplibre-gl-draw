// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for reaching MapLibre's terrain
 *
 * The vertical exaggeration must be the one MapLibre itself multiplies by. The anchors take
 * their elevation from `getElevationForLngLatZoom`, which already includes it, so a GPU path
 * that drew at a different factor would split symbols from the polygons and lines under them.
 */

import { describe, expect, it } from 'vitest';

import {
  getTerrainDepth,
  getTerrainExaggeration,
  getTerrainTileData,
  type RenderableTerrainTile,
  type TerrainLike,
} from './detect.js';

const TILE: RenderableTerrainTile = { x: 0, y: 0, z: 0, tileID: {} };

function createTerrain(extra: Partial<TerrainLike> = {}): TerrainLike {
  return {
    getTerrainData: () => ({
      texture: {} as WebGLTexture,
      u_terrain_matrix: new Float32Array(16),
      u_terrain_unpack: [6553.6, 25.6, 0.1, 10000],
      u_terrain_dim: 256,
    }),
    ...extra,
  };
}

describe('getTerrainExaggeration', () => {
  it('returns the factor the terrain object multiplies by', () => {
    expect(getTerrainExaggeration(createTerrain({ exaggeration: 1.5 }))).toBe(1.5);
  });

  it('falls back to the specification when the field is missing', () => {
    expect(getTerrainExaggeration(createTerrain({ options: { exaggeration: 2 } }))).toBe(2);
  });

  it('returns 1 when neither is available', () => {
    expect(getTerrainExaggeration(createTerrain())).toBe(1);
    expect(getTerrainExaggeration(null)).toBe(1);
  });

  it('keeps 0 (a flat terrain) and rejects negative or non-finite values', () => {
    expect(getTerrainExaggeration(createTerrain({ exaggeration: 0 }))).toBe(0);
    expect(getTerrainExaggeration(createTerrain({ exaggeration: -1 }))).toBe(1);
    expect(getTerrainExaggeration(createTerrain({ exaggeration: Number.NaN }))).toBe(1);
  });
});

describe('getTerrainTileData', () => {
  it('carries the exaggeration into the data the drape binds', () => {
    const data = getTerrainTileData(createTerrain({ exaggeration: 1.5 }), TILE);
    expect(data?.exaggeration).toBe(1.5);
  });
});

describe('getTerrainDepth', () => {
  const depthTexture = {} as WebGLTexture;
  const ratio = (globalThis as { devicePixelRatio?: number }).devicePixelRatio;
  const withDepth = (size: unknown, texture: unknown = depthTexture): TerrainLike =>
    ({
      getTerrainData: () => ({ depthTexture }),
      _fboDepthTexture: { texture, size },
    }) as unknown as TerrainLike;

  it('takes the depth MapLibre drew at the size of the canvas over the ratio of the device', () => {
    (globalThis as { devicePixelRatio?: number }).devicePixelRatio = 2;
    try {
      const depth = getTerrainDepth(withDepth([640, 360.5]), TILE, 1280, 721);
      expect(depth).toEqual({ texture: depthTexture, width: 640, height: 360 });
    } finally {
      (globalThis as { devicePixelRatio?: number }).devicePixelRatio = ratio;
    }
  });

  it('takes none of another size, of a texture not its own, or where there is none', () => {
    (globalThis as { devicePixelRatio?: number }).devicePixelRatio = 2;
    try {
      // Not drawn again yet after the canvas changed its size
      expect(getTerrainDepth(withDepth([600, 360]), TILE, 1280, 720)).toBeNull();
      // The stand in of 1 x 1 before the first depth is drawn
      expect(getTerrainDepth(withDepth([640, 360], {}), TILE, 1280, 720)).toBeNull();
      expect(getTerrainDepth(createTerrain(), TILE, 1280, 720)).toBeNull();
      const throwing = {
        getTerrainData: () => {
          throw new Error('no');
        },
      } as TerrainLike;
      expect(getTerrainDepth(throwing, TILE, 1280, 720)).toBeNull();
    } finally {
      (globalThis as { devicePixelRatio?: number }).devicePixelRatio = ratio;
    }
  });
});
