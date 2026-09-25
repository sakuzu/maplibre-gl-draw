// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for the layout of the DEM atlas across the antimeridian
 *
 * The terrain tiles carry canonical x. Across the antimeridian the view holds tiles from both
 * ends of the range, and they must sit next to each other in the atlas instead of stretching it
 * over the whole width of the world.
 */

import { describe, expect, it } from 'vitest';
import { computeAtlasLayout, DemAtlas, tileMercatorX } from './dem-atlas.js';
import type { RenderableTerrainTile } from './detect.js';

function tile(x: number, y: number, z: number): RenderableTerrainTile {
  return { x, y, z, tileID: { x, y, z } };
}

/** Mercator x of a longitude */
const mx = (lng: number): number => (lng + 180) / 360;

describe('tileMercatorX', () => {
  it('keeps a tile near the camera on its canonical position', () => {
    expect(tileMercatorX(tile(3, 1, 2), mx(170))).toBe(0.75);
  });

  it('moves the tile at the west end of the world next to a camera at the east end', () => {
    expect(tileMercatorX(tile(0, 1, 2), mx(179.95))).toBe(1);
  });

  it('moves the tile at the east end of the world next to a camera at the west end', () => {
    expect(tileMercatorX(tile(3, 1, 2), mx(-179.95))).toBe(-0.25);
  });
});

describe('computeAtlasLayout', () => {
  it('covers only the two tiles on both sides of the antimeridian', () => {
    const layout = computeAtlasLayout([tile(3, 1, 2), tile(0, 1, 2)], mx(179.95));
    expect(layout).not.toBeNull();
    expect(layout?.minX).toBe(0.75);
    expect(layout?.spanX).toBe(0.5);
    expect(layout?.spanY).toBe(0.25);
  });

  it('is unchanged away from the antimeridian', () => {
    const layout = computeAtlasLayout([tile(1, 1, 2), tile(2, 1, 2)], mx(0));
    expect(layout?.minX).toBe(0.25);
    expect(layout?.spanX).toBe(0.5);
  });
});

describe('DemAtlas bakes only when what it reads changed', () => {
  /** A GL that accepts every call and counts the ones a bake makes */
  function createGl() {
    const counts = { getParameter: 0, drawArrays: 0, clear: 0 };
    const gl = new Proxy(
      {},
      {
        get(_target, prop) {
          if (typeof prop !== 'string') return undefined;
          if (/^[A-Z0-9_]+$/.test(prop)) return prop;
          if (prop === 'getParameter') {
            return (name: string) => {
              counts.getParameter++;
              return name === 'VIEWPORT' ? [0, 0, 800, 600] : null;
            };
          }
          if (prop === 'checkFramebufferStatus') return () => 'FRAMEBUFFER_COMPLETE';
          if (prop === 'getShaderParameter' || prop === 'getProgramParameter') return () => true;
          if (prop in counts) return () => counts[prop as keyof typeof counts]++;
          if (prop.startsWith('create')) return () => ({ kind: prop });
          return () => undefined;
        },
      },
    ) as unknown as WebGL2RenderingContext;
    return { gl, counts };
  }

  /** A terrain with two tiles whose DEM textures and exaggeration can be swapped */
  function createTerrain() {
    const textures = new Map<string, object>([
      ['12/3638/1613', { id: 'a' }],
      ['12/3639/1613', { id: 'b' }],
    ]);
    const terrain = {
      exaggeration: 1,
      tileManager: {
        getRenderableTiles: () =>
          [...textures.keys()].map((key) => {
            const [z, x, y] = key.split('/').map(Number);
            return { tileID: { canonical: { x, y, z }, key } };
          }),
      },
      getTerrainData: (tileID: { key: string }) => ({
        texture: textures.get(tileID.key),
        u_terrain_matrix: new Float64Array(16).fill(1),
        u_terrain_unpack: [6553.6, 25.6, 0.1, 10000],
        u_terrain_dim: 512,
      }),
    };
    return { terrain, textures };
  }

  it('reuses the atlas on the frames after every tile has arrived', () => {
    const { gl, counts } = createGl();
    const { terrain } = createTerrain();
    const atlas = new DemAtlas(gl);

    const first = atlas.build(terrain, 0.5, true);
    const drawsPerBake = counts.drawArrays;
    for (let frame = 0; frame < 9; frame++) {
      expect(atlas.build(terrain, 0.5, true)).toBe(first);
    }

    expect(atlas.bakeCount).toBe(1);
    expect(counts.drawArrays).toBe(drawsPerBake);
  });

  it('bakes every frame while tiles are loading (DEM textures change in place)', () => {
    const { gl } = createGl();
    const { terrain } = createTerrain();
    const atlas = new DemAtlas(gl);

    for (let frame = 0; frame < 3; frame++) atlas.build(terrain, 0.5, false);
    // The first frame after they have all arrived bakes once more, then it is reused
    atlas.build(terrain, 0.5, true);
    atlas.build(terrain, 0.5, true);

    expect(atlas.bakeCount).toBe(4);
  });

  it('bakes again when a DEM texture or the exaggeration changes', () => {
    const { gl } = createGl();
    const { terrain, textures } = createTerrain();
    const atlas = new DemAtlas(gl);
    atlas.build(terrain, 0.5, true);

    textures.set('12/3638/1613', { id: 'c' });
    atlas.build(terrain, 0.5, true);
    terrain.exaggeration = 1.5;
    atlas.build(terrain, 0.5, true);
    atlas.build(terrain, 0.5, true);

    expect(atlas.bakeCount).toBe(3);
  });

  it('bakes again after dispose', () => {
    const { gl } = createGl();
    const { terrain } = createTerrain();
    const atlas = new DemAtlas(gl);
    atlas.build(terrain, 0.5, true);
    atlas.dispose();
    atlas.build(terrain, 0.5, true);

    expect(atlas.bakeCount).toBe(2);
  });
});
