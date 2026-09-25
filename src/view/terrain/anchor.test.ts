// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for the position computation of UI anchors
 *
 * There is one thing to protect: on terrain, "where a point or handle is drawn" and "where it
 * can be grabbed" must come out of the same computation. Previously this was split across two
 * places, and only points and vertex handles dropped to sea level 0 and became impossible to
 * grab.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createCoordinateTransform, setAnchorProjector } from '../../shared/math/index.js';
import type { OffsetUniforms } from '../shaders/helpers.js';
import {
  anchorElevationMeters,
  clearAnchorFrame,
  getAnchorElevationGeneration,
  installAnchorProjector,
  isAnchorActive,
  projectAnchor,
  setAnchorFrame,
  uninstallAnchorProjector,
} from './anchor.js';
import { TerrainContext } from './context.js';
import type { TerrainLike } from './detect.js';

/** The terrain state of the draw instance under test */
const context = new TerrainContext();

/**
 * A terrain stand-in that only returns an elevation
 *
 * `getElevationForLngLatZoom` is the same function MapLibre calls inside `map.project`.
 * Replacing it here makes it possible to observe only how the CPU-side projection uses the
 * elevation.
 */
function createTerrain(
  elevation: number,
  tiles: Array<{ x: number; y: number; z: number }> = [{ x: 0, y: 0, z: 0 }],
): TerrainLike & { calls: number } {
  const terrain = {
    calls: 0,
    getTerrainData: () => null,
    getElevationForLngLatZoom(_lngLat: { lng: number; lat: number }, _zoom: number): number {
      terrain.calls++;
      return elevation;
    },
    // The shape getRenderableTerrainTiles reads (the tileManager of v6)
    tileManager: {
      getRenderableTiles: () => tiles.map((t) => ({ tileID: { canonical: { ...t } } })),
    },
  };
  return terrain as unknown as TerrainLike & { calls: number };
}

/** A simple offset uniform with the center placed at the origin */
const OFFSET: OffsetUniforms = {
  centerLngLat: [0, 0],
  centerLngLat64: [0, 0],
  centerMercator: [0.5, 0.5],
  projectionCenter: [0, 0, 0, 1],
  unitsPerDegree: [1, 1, 1],
  unitsPerDegree2: [0, 0, 0],
};

/**
 * The identity matrix with only the term "elevation moves the screen upward" added
 * (column-major)
 *
 * m[9] is the coefficient with which z affects clip y. Unless it is given a non-zero value,
 * adding an elevation does not change the projected result and the test protects nothing.
 */
function matrixWithElevationTerm(zToY: number): number[] {
  const m = new Array(16).fill(0);
  m[0] = 1; // x → clip x
  m[5] = 1; // y → clip y
  m[9] = zToY; // z → clip y
  m[10] = 1;
  m[15] = 1;
  return m;
}

function applyFrame(terrain: TerrainLike, zToY = 4): void {
  setAnchorFrame(context, {
    terrain,
    zoom: 14, // The offset mode branch (>= 12)
    elevationScale: 1e-3,
    mainMatrix: matrixWithElevationTerm(zToY),
    offsetUniforms: OFFSET,
    width: 800,
    height: 600,
  });
}

/** A map stand-in used as the target of the anchor projector injection */
const PROJECTOR_MAP = {} as never;

afterEach(() => {
  uninstallAnchorProjector(PROJECTOR_MAP);
  clearAnchorFrame(context);
  setAnchorProjector(PROJECTOR_MAP, null);
});

describe('anchor position computation', () => {
  it('is inactive while there is no frame, and the elevation becomes 0', () => {
    clearAnchorFrame(context);

    expect(isAnchorActive(context)).toBe(false);
    expect(projectAnchor(context, 1, 1)).toBeNull();
    expect(anchorElevationMeters(context, 1, 1)).toBe(0);
  });

  it('lets the elevation affect the projection (height changes the screen position)', () => {
    applyFrame(createTerrain(1000));
    const high = projectAnchor(context, 0, 0);

    applyFrame(createTerrain(0));
    const flat = projectAnchor(context, 0, 0);

    expect(high).not.toBeNull();
    expect(flat).not.toBeNull();
    // Elevation 1000 m x elevationScale 1e-3 x m[9] 4 = clip y +4 -> the screen goes up
    // (y decreases)
    expect(high?.y).toBeLessThan(flat?.y ?? 0);
    // It does not move in the longitude direction (in this matrix z does not affect x)
    expect(high?.x).toBeCloseTo(flat?.x ?? 0, 10);
  });

  it('drops elevation 0 at the center onto the screen center (a projection sanity check)', () => {
    applyFrame(createTerrain(0));

    const center = projectAnchor(context, 0, 0);
    expect(center?.x).toBeCloseTo(400, 6);
    expect(center?.y).toBeCloseTo(300, 6);
  });

  it('looks the elevation of the same point up only once within a frame', () => {
    const terrain = createTerrain(500);
    applyFrame(terrain);

    anchorElevationMeters(context, 10, 20);
    anchorElevationMeters(context, 10, 20);
    anchorElevationMeters(context, 10, 20);
    expect(terrain.calls).toBe(1);

    // It is looked up again when the frame changes (the DEM may arrive and change the value)
    applyFrame(terrain);
    anchorElevationMeters(context, 10, 20);
    expect(terrain.calls).toBe(2);
  });

  it('returns 0 for terrain with no elevation (the same result as before the terrain)', () => {
    const terrain = { getTerrainData: () => null } as unknown as TerrainLike;
    applyFrame(terrain);

    expect(anchorElevationMeters(context, 1, 1)).toBe(0);
  });

  it('advances the generation when the DEM coverage changes (rebuilds baked elevations)', () => {
    applyFrame(createTerrain(100, [{ x: 0, y: 0, z: 0 }]));
    const first = getAnchorElevationGeneration(context);

    // It does not advance for the same coverage
    applyFrame(createTerrain(100, [{ x: 0, y: 0, z: 0 }]));
    expect(getAnchorElevationGeneration(context)).toBe(first);

    // It advances once tiles are added
    applyFrame(
      createTerrain(100, [
        { x: 0, y: 0, z: 0 },
        { x: 1, y: 0, z: 1 },
      ]),
    );
    expect(getAnchorElevationGeneration(context)).toBe(first + 1);
  });
});

describe('injection into hit testing', () => {
  /** A minimal map stand-in that only uses map.project */
  function createMap(): { project: ReturnType<typeof vi.fn>; unproject: ReturnType<typeof vi.fn> } {
    return {
      project: vi.fn(() => ({ x: 111, y: 222 })),
      unproject: vi.fn(() => ({ lng: 1, lat: 2 })),
    };
  }

  it('uses MapLibre project when there is no injection (zero regression without terrain)', () => {
    const map = createMap();
    const transform = createCoordinateTransform(map as never);

    expect(transform.project([10, 20])).toEqual({ x: 111, y: 222 });
    expect(map.project).toHaveBeenCalledTimes(1);
  });

  it('goes through the same anchor projection as rendering when the terrain is enabled', () => {
    const map = createMap();
    installAnchorProjector(map as never, context);
    applyFrame(createTerrain(1000));

    const transform = createCoordinateTransform(map as never);
    const viaTransform = transform.project([0, 0]);
    const viaAnchor = projectAnchor(context, 0, 0);

    // The coordinates hit testing returns are identical to the anchor projection rendering uses
    expect(viaTransform).toEqual(viaAnchor);
    // MapLibre's project (several hundred us per point when the terrain is enabled) is not
    // called
    expect(map.project).not.toHaveBeenCalled();
  });

  it('falls back to MapLibre project once the terrain is removed', () => {
    const map = createMap();
    installAnchorProjector(map as never, context);
    applyFrame(createTerrain(1000));
    clearAnchorFrame(context);

    const transform = createCoordinateTransform(map as never);
    expect(transform.project([0, 0])).toEqual({ x: 111, y: 222 });
  });
});
