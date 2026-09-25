// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for the per-instance separation of the terrain state
 *
 * There is one thing to protect: when a page has several rendering instances (the main one +
 * a thumbnail + a print preview and so on), the terrain state of one must not leak into
 * another. Every reader takes the context explicitly, so there is no "active" instance for a
 * write of one to be read through by another. Back when it leaked, instances whose generation counters happened to coincide
 * exhibited the defect that "flat geometry baked before the terrain took effect is never
 * rebuilt".
 */

import { describe, expect, it } from 'vitest';

import { createCoordinateTransform, setAnchorProjector } from '../../shared/math/index.js';
import type { OffsetUniforms } from '../shaders/helpers.js';
import {
  clearAnchorFrame,
  getAnchorElevationGeneration,
  installAnchorProjector,
  projectAnchor,
  setAnchorFrame,
  uninstallAnchorProjector,
} from './anchor.js';
import { releaseTerrainContext, TerrainContext, type TerrainRenderState } from './context.js';
import type { TerrainLike } from './detect.js';
import {
  getTerrainRenderState,
  isTerrainTessellationActive,
  setTerrainRenderState,
} from './state.js';

/** A terrain stand-in that only returns an elevation */
function createTerrain(
  elevation: number,
  tiles: Array<{ x: number; y: number; z: number }> = [{ x: 0, y: 0, z: 0 }],
): TerrainLike {
  return {
    getTerrainData: () => null,
    getElevationForLngLatZoom: () => elevation,
    tileManager: {
      getRenderableTiles: () => tiles.map((t) => ({ tileID: { canonical: { ...t } } })),
    },
  } as unknown as TerrainLike;
}

const OFFSET: OffsetUniforms = {
  centerLngLat: [0, 0],
  centerLngLat64: [0, 0],
  centerMercator: [0.5, 0.5],
  projectionCenter: [0, 0, 0, 1],
  unitsPerDegree: [1, 1, 1],
  unitsPerDegree2: [0, 0, 0],
};

/** The identity matrix with only the term "elevation affects clip y" added (column-major) */
function matrixWithElevationTerm(zToY: number): number[] {
  const m = new Array(16).fill(0);
  m[0] = 1;
  m[5] = 1;
  m[9] = zToY;
  m[10] = 1;
  m[15] = 1;
  return m;
}

function applyFrame(context: TerrainContext, terrain: TerrainLike): void {
  setAnchorFrame(context, {
    terrain,
    zoom: 14,
    elevationScale: 1e-3,
    mainMatrix: matrixWithElevationTerm(4),
    offsetUniforms: OFFSET,
    width: 800,
    height: 600,
  });
}

/** The frame state when the terrain is enabled (two are made, differing only in the step) */
function activeState(stepMeters: number, generation: number): TerrainRenderState {
  return {
    active: true,
    atlasTexture: null,
    atlasRect: [0, 0, 1, 1],
    atlasSize: [1, 1],
    tessellationRegion: null,
    tessellationTiling: null,
    elevationScale: 1e-3,
    liftMeters: 1,
    stepMeters,
    stepGrid: stepMeters / 1e7,
    generation,
  };
}

describe('per-instance separation of the terrain state', () => {
  it('reads only the state of the context it is given (an overwrite by another never leaks)', () => {
    const screen = new TerrainContext();
    const thumbnail = new TerrainContext();

    setTerrainRenderState(screen, activeState(30, 1));

    // The thumbnail draws one frame (the terrain has not arrived yet)
    expect(isTerrainTessellationActive(thumbnail)).toBe(false);
    setTerrainRenderState(thumbnail, activeState(120, 1));

    // The screen still has the step it set itself
    expect(getTerrainRenderState(screen).stepMeters).toBe(30);
  });

  it('keeps the subdivision cache separate per instance', () => {
    const screen = new TerrainContext();
    const thumbnail = new TerrainContext();
    const indices = [0, 1, 2];

    screen.fillCache.set('f1', 0, 'sig', indices, [0, 0], [0], 1);

    // Even with the same fingerprint, another instance's cache is never hit
    // (back when it was, triangles subdivided with a different step were picked up)
    expect(thumbnail.fillCache.get('f1', 0, 'sig', indices)).toBeNull();
    expect(screen.fillCache.get('f1', 0, 'sig', indices)).not.toBeNull();
  });

  it('keeps the other instance state even when one is destroyed', () => {
    const screen = new TerrainContext();
    const thumbnail = new TerrainContext();

    setTerrainRenderState(screen, activeState(30, 1));
    screen.fillCache.set('f1', 0, 'sig', [0, 1, 2], [0, 0], [0], 1);

    // The thumbnail's Map closes
    releaseTerrainContext(thumbnail);

    expect(getTerrainRenderState(screen).stepMeters).toBe(30);
    expect(screen.fillCache.size()).toBe(1);
  });

  it('counts the generation of the DEM coverage per instance as well', () => {
    const screen = new TerrainContext();
    const thumbnail = new TerrainContext();

    applyFrame(screen, createTerrain(1000, [{ x: 0, y: 0, z: 0 }]));
    const screenGeneration = getAnchorElevationGeneration(screen);

    // The thumbnail looks at a different tile set (back when it was shared the generation
    // advanced here and the retained batches on the screen side were rebuilt every frame)
    applyFrame(
      thumbnail,
      createTerrain(1000, [
        { x: 1, y: 1, z: 5 },
        { x: 2, y: 1, z: 5 },
      ]),
    );

    expect(getAnchorElevationGeneration(screen)).toBe(screenGeneration);
  });

  it('has hit testing use the per-map Context (correct after another instance drew)', () => {
    const screen = new TerrainContext();
    const thumbnail = new TerrainContext();
    const screenMap = {
      project: () => ({ x: -1, y: -1 }),
      unproject: () => ({ lng: 0, lat: 0 }),
    } as never;

    installAnchorProjector(screenMap, screen);
    applyFrame(screen, createTerrain(1000));
    const expected = projectAnchor(screen, 0, 0);

    // The thumbnail draws a frame of its own
    applyFrame(thumbnail, createTerrain(0));

    // Even so, the screen's hit testing goes through the screen's frame
    const transform = createCoordinateTransform(screenMap);
    expect(transform.project([0, 0])).toEqual(expected);
    expect(projectAnchor(thumbnail, 0, 0)).not.toEqual(expected);

    uninstallAnchorProjector(screenMap);
    setAnchorProjector(screenMap, null);
    clearAnchorFrame(screen);
  });
});
