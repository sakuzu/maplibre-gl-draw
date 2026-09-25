// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Verification that the shading of the fill is the same even on different paths
 *
 * There are two paths for laying a polygon fill onto the ground surface:
 * analytic drape (painting it as pixels of the ground surface) and vertex
 * displacement (lifting the vertices of the feature and painting them), and
 * they swap over depending on cost. Since the requirement is that the
 * appearance does not jump at the swap, this file pins down two things:
 *
 * - that the formula producing the brightness coefficient exists in one place
 *   (both GLSL sources include the same body)
 * - that looking at the same terrain under the same light gives the same
 *   gradient even when the samples are taken differently
 *
 * The way samples are taken differs per path (the drape reads the DEM in tile
 * coordinates, while the vertex displacement path reads the DEM atlas in
 * Mercator relative coordinates), so agreement is checked after correcting the
 * units down to meters per meter.
 */

import { describe, expect, it } from 'vitest';
import { TILE_EXTENT } from '../terrain/drape/mesh.js';
import { TERRAIN_SHADE_GLSL } from '../terrain/drape/shared.js';
import { circumferenceAtLatitude, tileCenterLatitude } from '../terrain/metrics.js';
import {
  TERRAIN_SHADE_CORE_GLSL,
  type TerrainShadeLight,
  terrainShadeFactor,
} from '../terrain/shade.js';
import { DEM_SAMPLE_GLSL } from './helpers.js';
import { TERRAIN_SHADE_FRAGMENT_GLSL, TERRAIN_SHADE_VERTEX_GLSL } from './terrain-shade.js';

/**
 * The same light source as the shading default
 * (azimuth 335 degrees, altitude 45 degrees, strength 0.45)
 */
const LIGHT: TerrainShadeLight = (() => {
  const azimuth = (335 * Math.PI) / 180;
  const altitude = (45 * Math.PI) / 180;
  const horizontal = Math.cos(altitude);
  return {
    direction: [Math.sin(azimuth) * horizontal, Math.cos(azimuth) * horizontal, Math.sin(altitude)],
    strength: 0.45,
  };
})();

/**
 * The elevation field (meters, in Mercator coordinates; the gradient is
 * constant, so the difference does not depend on the width)
 */
function field(mx: number, my: number): number {
  return 4.2e5 * mx - 2.7e5 * my + 130;
}

/** The render tile (the place where the shading samples are taken) */
const TILE = { z: 12, x: 3637, y: 1612 };
const TILE_SIZE = 1 / 2 ** TILE.z;
const TILE_LAT = tileCenterLatitude(TILE.y, TILE.z);
/** The ground size of that tile (u_tile_meters in the GLSL) */
const TILE_METERS = circumferenceAtLatitude(TILE_LAT) / 2 ** TILE.z;
/** The dimensions of the DEM (texels) */
const DEM_DIM = 256;

/**
 * The gradient of the analytic drape (the same formula as terrainShade in
 * drape/shared.ts)
 *
 * The samples are taken one texel apart in tile coordinates and divided by the
 * ground size of the tile.
 */
function drapeGradient(tilePosX: number, tilePosY: number): [number, number] {
  const texel = TILE_EXTENT / DEM_DIM;
  const at = (px: number, py: number): number =>
    field(
      TILE.x * TILE_SIZE + (px / TILE_EXTENT) * TILE_SIZE,
      TILE.y * TILE_SIZE + (py / TILE_EXTENT) * TILE_SIZE,
    );
  const span = ((2 * texel) / TILE_EXTENT) * TILE_METERS;
  const dzdEast = (at(tilePosX + texel, tilePosY) - at(tilePosX - texel, tilePosY)) / span;
  const dzdNorth = -(at(tilePosX, tilePosY + texel) - at(tilePosX, tilePosY - texel)) / span;
  return [dzdEast, dzdNorth];
}

/**
 * The gradient of the vertex displacement path (the same formula as
 * terrainFillShade in terrain-shade.ts)
 *
 * The samples are taken one atlas texel apart in Mercator and divided by the
 * ground distance of Mercator 1.0 (the reciprocal of the meters -> Mercator z
 * coefficient). The resolution of the atlas does not match the DEM, so the
 * sample width does not line up with the drape.
 */
function surfaceGradient(mx: number, my: number, atlasTexel: number): [number, number] {
  // The reciprocal of u_elevation_params.x. The same conversion as when the vertex adds
  // the elevation
  const meters = circumferenceAtLatitude(TILE_LAT);
  const dzdEast =
    (field(mx + atlasTexel, my) - field(mx - atlasTexel, my)) / (2 * atlasTexel * meters);
  const dzdNorth =
    -(field(mx, my + atlasTexel) - field(mx, my - atlasTexel)) / (2 * atlasTexel * meters);
  return [dzdEast, dzdNorth];
}

describe('the formula for the shading of the fill', () => {
  it('has only one place holding the body that produces the brightness coefficient', () => {
    // Both the analytic drape and the vertex displacement path pull in the same body
    expect(TERRAIN_SHADE_GLSL).toContain(TERRAIN_SHADE_CORE_GLSL);
    expect(TERRAIN_SHADE_FRAGMENT_GLSL).toContain(TERRAIN_SHADE_CORE_GLSL);
    // Only the shared function produces the coefficient; the path side merely hands over
    // the gradient
    expect(TERRAIN_SHADE_GLSL).toContain('terrainShadeFromGradient(dzdEast, dzdNorth)');
    expect(TERRAIN_SHADE_FRAGMENT_GLSL).toContain('terrainShadeFromGradient(dzdEast, dzdNorth)');
  });

  it('reads the DEM in the vertex displacement path the same way as the elevation', () => {
    // It shares the same function the vertex uses for lifting (dem_elevation_meters)
    expect(TERRAIN_SHADE_FRAGMENT_GLSL).toContain(DEM_SAMPLE_GLSL);
    // The sample position is handed over from the vertex (the varying name matches in
    // both stages)
    expect(TERRAIN_SHADE_VERTEX_GLSL).toContain('out vec2 v_shade_offset;');
    expect(TERRAIN_SHADE_FRAGMENT_GLSL).toContain('in vec2 v_shade_offset;');
  });

  it('gives a coefficient of 1.0 on flat ground (no shading is applied)', () => {
    expect(terrainShadeFactor(0, 0, LIGHT)).toBeCloseTo(1, 12);
  });

  it('makes slopes facing the light bright and slopes turned away dark', () => {
    // The light comes from the north-west (azimuth 335 degrees). A slope descending to the
    // north (whose normal faces north) catches the light, and a slope ascending to the
    // north falls into shade
    const lit = terrainShadeFactor(0, -0.3, LIGHT);
    const shaded = terrainShadeFactor(0, 0.3, LIGHT);
    expect(lit).toBeGreaterThan(1);
    expect(shaded).toBeLessThan(1);
  });

  it('keeps the coefficient within the range determined by the strength', () => {
    for (const dzdEast of [-40, -1, 0, 1, 40]) {
      for (const dzdNorth of [-40, -1, 0, 1, 40]) {
        const factor = terrainShadeFactor(dzdEast, dzdNorth, LIGHT);
        expect(factor).toBeGreaterThanOrEqual(1 - LIGHT.strength);
        expect(factor).toBeLessThanOrEqual(1 + LIGHT.strength * 0.5);
      }
    }
  });

  it('gives 1.0 for any gradient when unshaded (strength 0)', () => {
    const off: TerrainShadeLight = { direction: LIGHT.direction, strength: 0 };
    expect(terrainShadeFactor(3, -2, off)).toBe(1);
  });
});

describe('agreement when looking at the same terrain under the same light', () => {
  // Representative points inside the tile (the center, and points pushed to the tile boundary)
  const spots: Array<[number, number]> = [
    [TILE_EXTENT / 2, TILE_EXTENT / 2],
    [TILE_EXTENT / 4, (TILE_EXTENT * 3) / 4],
    [0, TILE_EXTENT],
  ];

  it('agrees on the gradient (meters per meter) even with a different sample width', () => {
    for (const [px, py] of spots) {
      const mx = TILE.x * TILE_SIZE + (px / TILE_EXTENT) * TILE_SIZE;
      const my = TILE.y * TILE_SIZE + (py / TILE_EXTENT) * TILE_SIZE;
      const drape = drapeGradient(px, py);
      // The resolution of the atlas does not match the DEM of the drape (the result is the
      // same even when the width is changed)
      for (const atlasTexel of [TILE_SIZE / 256, TILE_SIZE / 128, TILE_SIZE / 512]) {
        const surface = surfaceGradient(mx, my, atlasTexel);
        expect(surface[0]).toBeCloseTo(drape[0], 9);
        expect(surface[1]).toBeCloseTo(drape[1], 9);
      }
    }
  });

  it('produces the same coefficient for the same samples', () => {
    for (const [px, py] of spots) {
      const mx = TILE.x * TILE_SIZE + (px / TILE_EXTENT) * TILE_SIZE;
      const my = TILE.y * TILE_SIZE + (py / TILE_EXTENT) * TILE_SIZE;
      const [de, dn] = drapeGradient(px, py);
      const [se, sn] = surfaceGradient(mx, my, TILE_SIZE / 128);
      expect(terrainShadeFactor(se, sn, LIGHT)).toBeCloseTo(terrainShadeFactor(de, dn, LIGHT), 9);
    }
  });
});
