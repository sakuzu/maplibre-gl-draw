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
