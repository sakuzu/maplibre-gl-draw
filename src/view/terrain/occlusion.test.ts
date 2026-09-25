// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for the occlusion test of symbols (ghosting)
 *
 * There are three things to protect.
 *
 * 1. An anchor behind a ridge is judged occluded
 * 2. An anchor on the near slope is not occluded (it does not hide itself with its own
 *    ground)
 * 3. When the terrain is disabled or the camera cannot be obtained, the answer is always
 *    "not occluded" (exactly the same appearance as before the terrain was introduced)
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { OffsetUniforms } from '../shaders/helpers.js';
import { setAnchorFrame } from './anchor.js';
import { releaseTerrainContext, TerrainContext, type TerrainRenderState } from './context.js';
import type { TerrainLike } from './detect.js';
import { anchorGhostOpacity, isAnchorOccluded, TERRAIN_GHOST_OPACITY } from './occlusion.js';

const OFFSET: OffsetUniforms = {
  centerLngLat: [0, 0],
  centerLngLat64: [0, 0],
  centerMercator: [0.5, 0.5],
  projectionCenter: [0, 0, 0, 1],
  unitsPerDegree: [1, 1, 1],
  unitsPerDegree2: [0, 0, 0],
};

/** Terrain that is nothing but a single 2000 m high ridge at latitude 35.30 to 35.32 */
function createRidgeTerrain(): TerrainLike {
  return {
    getTerrainData: () => null,
    getElevationForLngLatZoom: (lngLat: { lng: number; lat: number }) =>
      lngLat.lat >= 35.3 && lngLat.lat <= 35.32 ? 2000 : 0,
    tileManager: { getRenderableTiles: () => [{ tileID: { canonical: { x: 0, y: 0, z: 0 } } }] },
  } as unknown as TerrainLike;
}

/** Meters to Mercator z (represented by latitude 35 degrees) */
const SCALE = 1 / (40075016.686 * Math.cos((35 * Math.PI) / 180));

function mercY(lat: number): number {
  const rad = (lat * Math.PI) / 180;
  return (1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2;
}

function activeState(): TerrainRenderState {
  return {
    active: true,
    atlasTexture: null,
    atlasRect: [0, 0, 1, 1],
    atlasSize: [1, 1],
    tessellationRegion: null,
    tessellationTiling: null,
    elevationScale: SCALE,
    liftMeters: 10,
    stepMeters: 100,
    // Node spacing of the terrain mesh (the reference for the step)
    stepGrid: 1 / 2 ** 11 / 128,
    generation: 1,
  };
}

let context: TerrainContext;

/**
 * Sets up a frame with the camera to the south (latitude 35.0) at an altitude of 3000 m
 */
function applyFrame(options: { camera?: readonly [number, number, number] | null } = {}): void {
  context.renderState = activeState();
  setAnchorFrame(context, {
    terrain: createRidgeTerrain(),
    zoom: 11.7,
    elevationScale: SCALE,
    mainMatrix: new Array(16).fill(0),
    offsetUniforms: OFFSET,
    width: 800,
    height: 600,
    cameraMercator:
      options.camera === undefined
        ? [(138.7 + 180) / 360, mercY(35.0), 3000 * SCALE]
        : options.camera,
  });
}

beforeEach(() => {
  context = new TerrainContext();
});

afterEach(() => {
  releaseTerrainContext(context);
});

describe('symbol occlusion test', () => {
  it('judges an anchor behind a ridge as occluded', () => {
    applyFrame();
    // Seen from the camera (latitude 35.0, 3000 m), a point on the far side (latitude 35.40,
    // elevation 0) of the ridge (latitude 35.30 to 35.32, 2000 m)
    expect(isAnchorOccluded(context, 138.7, 35.4)).toBe(true);
    expect(anchorGhostOpacity(context, 138.7, 35.4)).toBe(TERRAIN_GHOST_OPACITY);
  });

  it('does not occlude an anchor in front of the ridge', () => {
    applyFrame();
    expect(isAnchorOccluded(context, 138.7, 35.2)).toBe(false);
    expect(anchorGhostOpacity(context, 138.7, 35.2)).toBe(1);
  });

  it('does not let an anchor on the ridge hide itself', () => {
    applyFrame();
    expect(isAnchorOccluded(context, 138.7, 35.31)).toBe(false);
  });

  it('reports no occlusion when the camera cannot be obtained', () => {
    applyFrame({ camera: null });
    expect(isAnchorOccluded(context, 138.7, 35.4)).toBe(false);
    expect(anchorGhostOpacity(context, 138.7, 35.4)).toBe(1);
  });

  it('reports no occlusion when the terrain is disabled (same as before the terrain)', () => {
    expect(isAnchorOccluded(context, 138.7, 35.4)).toBe(false);
    expect(anchorGhostOpacity(context, 138.7, 35.4)).toBe(1);
  });

  it('reuses the result within a frame (it does not solve the same anchor repeatedly)', () => {
    applyFrame();
    const first = isAnchorOccluded(context, 138.7, 35.4);
    expect(context.occlusionCache.size).toBe(1);
    expect(isAnchorOccluded(context, 138.7, 35.4)).toBe(first);
    expect(context.occlusionCache.size).toBe(1);

    // It is solved again when the frame changes
    applyFrame();
    expect(context.occlusionCache.size).toBe(0);
  });
});
