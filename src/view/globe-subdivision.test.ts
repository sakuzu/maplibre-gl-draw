// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for the subdivision of the geometry on the globe: the cells recorded per frame, the
 * step handed to the renderers, and the cut of the paths drawn on the CPU
 */

import { describe, expect, it } from 'vitest';
import {
  densifyPathForGlobe,
  getGlobeTessellationStep,
  getSurfaceTessellationStep,
  globeGridOf,
  tessellateSurfaceFill,
  updateGlobeSubdivision,
} from './globe-subdivision.js';
import { INACTIVE_TERRAIN_STATE, TerrainContext } from './terrain/context.js';

describe('updateGlobeSubdivision', () => {
  it('records no cell on a flat map, and the cells of the zoom on the globe', () => {
    const context = new TerrainContext();
    updateGlobeSubdivision(context, 0, 2);
    expect(context.globeGrids).toBeNull();
    expect(globeGridOf(context, 'fill')).toBe(0);

    updateGlobeSubdivision(context, 1, 2);
    expect(context.globeGrids).toEqual({ fill: 1 / 128, line: 1 / 512 });
  });

  it('advances the generation only when a cell changes', () => {
    const context = new TerrainContext();
    const start = context.globeGeneration;
    updateGlobeSubdivision(context, 0, 2);
    expect(context.globeGeneration).toBe(start);

    updateGlobeSubdivision(context, 1, 2);
    expect(context.globeGeneration).toBe(start + 1);
    // Zooming within a level, and through levels where the cells stay, changes nothing
    updateGlobeSubdivision(context, 0.5, 2.9);
    updateGlobeSubdivision(context, 1, 5);
    expect(context.globeGeneration).toBe(start + 1);
    // A fill cell halves past zoom 6
    updateGlobeSubdivision(context, 1, 7);
    expect(context.globeGeneration).toBe(start + 2);
    // Leaving the globe
    updateGlobeSubdivision(context, 0, 13);
    expect(context.globeGeneration).toBe(start + 3);
  });
});

describe('the step of the surface', () => {
  it('is null on a flat map without terrain', () => {
    expect(getSurfaceTessellationStep(new TerrainContext(), 'fill')).toBeNull();
  });

  it("is the globe's cell of the kind asked for", () => {
    const context = new TerrainContext();
    updateGlobeSubdivision(context, 1, 1);
    expect(getSurfaceTessellationStep(context, 'fill')?.grid).toBe(1 / 128);
    expect(getSurfaceTessellationStep(context, 'line')?.grid).toBe(1 / 512);
    expect(getGlobeTessellationStep(context, 'fill')?.region).toBeNull();
  });

  it("is the terrain's while the terrain is drawn", () => {
    const context = new TerrainContext();
    updateGlobeSubdivision(context, 1, 1);
    const region = { x0: 0, y0: 0, x1: 1, y1: 1 };
    context.renderState = {
      ...INACTIVE_TERRAIN_STATE,
      active: true,
      stepMeters: 10,
      stepGrid: 1 / 65536,
      tessellationRegion: region,
    };
    expect(getSurfaceTessellationStep(context, 'fill')).toMatchObject({ grid: 1 / 65536, region });
  });
});

describe('tessellateSurfaceFill', () => {
  it('cuts a fill as large as a continent along the cells', () => {
    const context = new TerrainContext();
    updateGlobeSubdivision(context, 1, 1);
    const step = getSurfaceTessellationStep(context, 'fill');
    if (!step) throw new Error('no step');
    const flat = [-40, 20, 40, 20, 40, 50, -40, 50];
    const indices = [0, 1, 2, 0, 2, 3];
    const result = tessellateSurfaceFill(context, 'box', 0, flat, indices, step);
    expect(result.flatCoords.length).toBeGreaterThan(flat.length * 10);
    // Every vertex of the bottom edge stays on its parallel
    const bottom = [];
    for (let i = 1; i < result.flatCoords.length; i += 2) {
      if (Math.abs(result.flatCoords[i] - 20) < 1e-9) bottom.push(result.flatCoords[i - 1]);
    }
    expect(bottom.length).toBeGreaterThan(20);
  });

  it('leaves a fill inside one cell as it is', () => {
    const context = new TerrainContext();
    updateGlobeSubdivision(context, 1, 1);
    const step = getSurfaceTessellationStep(context, 'fill');
    if (!step) throw new Error('no step');
    const flat = [139.7, 35.6, 139.71, 35.6, 139.71, 35.61];
    const indices = [0, 1, 2];
    const result = tessellateSurfaceFill(context, 'small', 0, flat, indices, step);
    expect(result.flatCoords).toBe(flat);
    expect(result.indices).toBe(indices);
  });
});

describe('densifyPathForGlobe', () => {
  it('cuts a path on the globe and leaves it alone on a flat map', () => {
    const context = new TerrainContext();
    const path: [number, number][] = [
      [-60, 45],
      [60, 45],
    ];
    expect(densifyPathForGlobe(context, path)).toBe(path);
    updateGlobeSubdivision(context, 1, 1);
    expect(densifyPathForGlobe(context, path).length).toBeGreaterThan(100);
  });
});
