// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// The terrain of the editing benchmark, without a map: the address that asks for it and the range
// of its elevations over the grid of the features (`npx vitest run --root bench`)

import { describe, expect, it } from 'vitest';
import { gridOf, MAX_COUNT, terrainFromSearch } from './edit-document';
import { HILL_TOP_METERS, hillElevation } from './edit-terrain';

describe('the terrain from the address', () => {
  it('is there with terrain=1 only', () => {
    expect(terrainFromSearch('')).toEqual({ terrain: false });
    expect(terrainFromSearch('?n=1000')).toEqual({ terrain: false });
    expect(terrainFromSearch('?terrain=0')).toEqual({ terrain: false });
    expect(terrainFromSearch('?n=1000&terrain=1')).toEqual({ terrain: true });
    expect(terrainFromSearch('?terrain=yes')).toHaveProperty('error');
  });
});

describe('the elevations of the terrain', () => {
  it('stay from 0 m to 3,000 m over the grid of the most features, and rise and fall', () => {
    const grid = gridOf(MAX_COUNT);
    let lowest = Number.POSITIVE_INFINITY;
    let highest = Number.NEGATIVE_INFINITY;
    for (let i = 0; i <= 200; i++) {
      for (let j = 0; j <= 200; j++) {
        const lng = grid.west + ((grid.east - grid.west) * i) / 200;
        const lat = grid.south + ((grid.north - grid.south) * j) / 200;
        const elevation = hillElevation(lng, lat);
        lowest = Math.min(lowest, elevation);
        highest = Math.max(highest, elevation);
      }
    }
    expect(lowest).toBeGreaterThanOrEqual(0);
    expect(highest).toBeLessThanOrEqual(HILL_TOP_METERS);
    expect(highest - lowest).toBeGreaterThan(HILL_TOP_METERS / 2);
  });
});
