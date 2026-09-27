// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Screen space hit testing of symbols (points)
 *
 * There are two things to protect.
 *
 * 1. When the terrain is enabled, a point is hit through the path "project the anchor to
 *    screen coordinates with the same projection as the rendering, and compare it directly
 *    with the screen coordinates of the click". A point behind the terrain is far away
 *    from the longitude/latitude obtained by unprojecting the click, but as long as it is
 *    visible it is hit
 * 2. When the anchor projection is unusable (the terrain is disabled), the conventional
 *    longitude/latitude path works as before (zero regression)
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { MemoryStore } from '../../store/memory.js';
import { RBushSpatialIndex } from '../../store/spatial/spatial-index.js';
import type { Coordinate, Feature } from '../../store/types.js';
import { HitTestServiceImpl } from './service.js';

/** An unproject that maps longitude/latitude naively and linearly (1 degree = 10px) */
const unproject = (p: { x: number; y: number }): { lng: number; lat: number } => ({
  lng: p.x / 10,
  lat: -p.y / 10,
});

function point(id: string, coord: Coordinate): Feature {
  return {
    id,
    type: 'Point',
    geometry: { type: 'Point', coordinates: coord },
    layerId: 'l1',
    properties: {},
    locked: false,
    visible: true,
    style: {},
  };
}

let store: MemoryStore;
let spatialIndex: RBushSpatialIndex;

beforeEach(() => {
  store = new MemoryStore();
  store.createLayer({ id: 'l1', name: 'l1', visible: true, locked: false, opacity: 1, order: [] });
  spatialIndex = new RBushSpatialIndex();
});

function load(features: Feature[]): Feature[] {
  for (const feature of features) {
    store.createFeature(feature);
    spatialIndex.insert(feature);
  }
  return features;
}

describe('screen space hit testing of symbols', () => {
  it('hits a point behind the terrain at the screen position where it is visible', () => {
    // When the terrain is enabled, the longitude/latitude obtained by unprojecting the
    // click lands on the ridge in front. Here the situation created is "the unprojection
    // of the click (100, 0) is longitude 10, but the point sits at longitude 40 and is
    // projected onto the screen near (100, 0)".
    const target = point('behind-ridge', [40, 0]);
    const features = load([target]);

    const service = new HitTestServiceImpl(store, spatialIndex, {
      anchorScreen: {
        // Only the point at longitude 40 is projected right under the click (it is
        // assumed to be lifted up by the elevation)
        project: (coord: Coordinate) =>
          coord[0] === 40 ? { x: 102, y: 1 } : { x: coord[0] * 10, y: -coord[1] * 10 },
      },
    });

    const results = service.hitTestAll({ x: 100, y: 0 }, unproject, features);
    expect(results.map((r) => r.feature.id)).toEqual([target.id]);

    // Check that the longitude/latitude path (the spatial index) does not reach it. If it
    // did reach it, this test would be protecting nothing
    const legacy = new HitTestServiceImpl(store, spatialIndex);
    expect(legacy.hitTestAll({ x: 100, y: 0 }, unproject, features)).toEqual([]);
  });

  it('does not hit a point that is far on screen (even when it is near in degrees)', () => {
    const target = point('near-in-degrees', [10, 0]);
    const features = load([target]);

    const service = new HitTestServiceImpl(store, spatialIndex, {
      anchorScreen: {
        // On screen it is projected far away (it went around to the other side of a
        // mountain, for instance)
        project: () => ({ x: 600, y: 600 }),
      },
    });

    expect(service.hitTestAll({ x: 100, y: 0 }, unproject, features)).toEqual([]);
  });

  it('falls back when the anchor projection is unusable (no terrain, zero regression)', () => {
    const target = point('on-ground', [10, 0]);
    const features = load([target]);

    const withProjector = new HitTestServiceImpl(store, spatialIndex, {
      anchorScreen: { project: () => null },
    });
    const legacy = new HitTestServiceImpl(store, spatialIndex);

    const a = withProjector.hitTestAll({ x: 100, y: 0 }, unproject, features);
    const b = legacy.hitTestAll({ x: 100, y: 0 }, unproject, features);
    expect(a.map((r) => r.feature.id)).toEqual([target.id]);
    expect(a.map((r) => r.feature.id)).toEqual(b.map((r) => r.feature.id));
  });

  it('does not hit a hidden point through the screen space path either', () => {
    const target = { ...point('hidden', [40, 0]), visible: false };
    const features = load([target]);

    const service = new HitTestServiceImpl(store, spatialIndex, {
      anchorScreen: { project: () => ({ x: 100, y: 0 }) },
    });

    expect(service.hitTestAll({ x: 100, y: 0 }, unproject, features)).toEqual([]);
  });

  it('polygons and lines skip the screen space path (ground-draped, depth-occluded)', () => {
    const line: Feature = {
      id: 'line',
      type: 'LineString',
      geometry: {
        type: 'LineString',
        coordinates: [
          [10, 0],
          [10.5, 0],
        ],
      },
      layerId: 'l1',
      properties: {},
      locked: false,
      visible: true,
      style: {},
    };
    const features = load([line]);

    const service = new HitTestServiceImpl(store, spatialIndex, {
      // Only symbols go through this path, so it has no effect on a line
      anchorScreen: { project: () => ({ x: 100, y: 0 }) },
    });

    const results = service.hitTestAll({ x: 100, y: 0 }, unproject, features);
    expect(results.map((r) => r.feature.id)).toEqual(['line']);
  });
});
