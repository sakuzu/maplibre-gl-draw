// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for where the anchors read the ground elevation from
 *
 * Inside the terrain tiles maplibre draws, the elevation is maplibre's own
 * (`map.queryTerrainElevation`, the drawn surface). Outside them the public method is slow and
 * nothing is drawn, so the elevation of the current zoom level is used instead.
 */

import { describe, expect, it, vi } from 'vitest';

import { anchorElevationMeters, clearAnchorFrame, setAnchorFrame } from './anchor.js';
import { TerrainContext } from './context.js';
import type { RenderableTerrainTile, TerrainLike } from './detect.js';
import { groundElevationMeters, TerrainCoverage } from './ground.js';

function tile(z: number, x: number, y: number, wrap = 0): RenderableTerrainTile {
  return { x, y, z, wrap, tileID: {} };
}

/** A terrain whose fallback lookup returns a fixed elevation */
function createTerrain(fallback: number, tiles: RenderableTerrainTile[] = []) {
  const getElevationForLngLatZoom = vi.fn(() => fallback);
  const terrain = {
    getTerrainData: () => null,
    getElevationForLngLatZoom,
    tileManager: {
      getRenderableTiles: () =>
        tiles.map((t) => ({ tileID: { wrap: t.wrap, canonical: { x: t.x, y: t.y, z: t.z } } })),
    },
  };
  return { terrain: terrain as unknown as TerrainLike, getElevationForLngLatZoom };
}

describe('TerrainCoverage', () => {
  it('covers a point inside a drawn tile of any zoom level', () => {
    const coverage = new TerrainCoverage();
    // z1: the north-east quarter; z2: one tile in the south-west quarter
    coverage.update([tile(1, 1, 0), tile(2, 1, 2)]);
    expect(coverage.covers(90, 45)).toBe(true);
    expect(coverage.covers(-60, -30)).toBe(true);
    expect(coverage.covers(-150, -30)).toBe(false);
    expect(coverage.covers(-90, 45)).toBe(false);
  });

  it('tells the copies of the world apart', () => {
    const coverage = new TerrainCoverage();
    coverage.update([tile(1, 0, 0, 1)]);
    // The west half of the copy east of the antimeridian
    expect(coverage.covers(200, 45)).toBe(true);
    expect(coverage.covers(-160, 45)).toBe(false);
  });

  it('reports whether the set changed', () => {
    const coverage = new TerrainCoverage();
    expect(coverage.update([tile(1, 1, 0)])).toBe(true);
    expect(coverage.update([tile(1, 1, 0)])).toBe(false);
    expect(coverage.clear()).toBe(true);
    expect(coverage.clear()).toBe(false);
    expect(coverage.covers(90, 45)).toBe(false);
  });

  it('covers nothing beyond the latitude range of the tiles', () => {
    const coverage = new TerrainCoverage();
    coverage.update([tile(0, 0, 0)]);
    expect(coverage.covers(0, 89)).toBe(false);
  });
});

describe('groundElevationMeters', () => {
  it('asks the map inside the drawn tiles', () => {
    const coverage = new TerrainCoverage();
    coverage.update([tile(0, 0, 0)]);
    const { terrain, getElevationForLngLatZoom } = createTerrain(5);
    const query = { queryTerrainElevation: vi.fn(() => 1234) };
    expect(groundElevationMeters(query, terrain, coverage, 10, 20, 3)).toBe(1234);
    expect(query.queryTerrainElevation).toHaveBeenCalledWith([10, 20]);
    expect(getElevationForLngLatZoom).not.toHaveBeenCalled();
  });

  it('reads the zoom level of the frame outside the drawn tiles', () => {
    const coverage = new TerrainCoverage();
    coverage.update([tile(1, 1, 0)]);
    const { terrain, getElevationForLngLatZoom } = createTerrain(5);
    const query = { queryTerrainElevation: vi.fn(() => 1234) };
    expect(groundElevationMeters(query, terrain, coverage, -90, 45, 3)).toBe(5);
    expect(query.queryTerrainElevation).not.toHaveBeenCalled();
    expect(getElevationForLngLatZoom).toHaveBeenCalledWith(expect.anything(), 3);
  });

  it('falls back when the map has no elevation to give', () => {
    const coverage = new TerrainCoverage();
    coverage.update([tile(0, 0, 0)]);
    const { terrain } = createTerrain(5);
    expect(
      groundElevationMeters({ queryTerrainElevation: () => null }, terrain, coverage, 0, 0, 3),
    ).toBe(5);
  });
});

describe('anchorElevationMeters reads the drawn surface', () => {
  const OFFSET = {
    centerLngLat: [179, 0] as [number, number],
    centerLngLat64: [179, 0] as [number, number],
    centerMercator: [0.997, 0.5] as [number, number],
    projectionCenter: [0, 0, 0, 1] as [number, number, number, number],
    unitsPerDegree: [1, 1, 1] as [number, number, number],
    unitsPerDegree2: [0, 0, 0] as [number, number, number],
  };

  it('asks the map on the copy of the world the point is drawn on', () => {
    const context = new TerrainContext();
    // The camera sits just west of the antimeridian and the tile east of it is drawn as the
    // copy with wrap 1
    const { terrain } = createTerrain(5, [tile(1, 0, 0, 1)]);
    const query = { queryTerrainElevation: vi.fn(() => 800) };
    setAnchorFrame(context, {
      terrain,
      elevationQuery: query,
      zoom: 14,
      elevationScale: 1e-3,
      mainMatrix: new Array(16).fill(0),
      offsetUniforms: OFFSET,
      width: 800,
      height: 600,
    });

    expect(anchorElevationMeters(context, -179, 45)).toBe(800);
    expect(query.queryTerrainElevation).toHaveBeenCalledWith([181, 45]);
    clearAnchorFrame(context);
  });
});
