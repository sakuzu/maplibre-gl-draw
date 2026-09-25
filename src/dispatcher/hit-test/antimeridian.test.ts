// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for hit testing across the antimeridian
 *
 * The features are stored with longitudes in [-180, 180]. A view across the antimeridian draws
 * the features stored on the other side of the line as a second copy, 360 degrees away, and a
 * click there unprojects to the unwrapped longitude of the view (above 180). The click is tested
 * on the copies of the world it can reach, so it hits the copy that is drawn under it.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { MemoryStore } from '../../store/memory.js';
import { RBushSpatialIndex } from '../../store/spatial/spatial-index.js';
import type { Coordinate, Feature } from '../../store/types.js';
import { clickCopies } from './local-frame.js';
import { HitTestServiceImpl } from './service.js';

/** An unproject around a click: 1 px = 0.001 degrees, x = 0 at `originLng` */
function unprojectFrom(originLng: number) {
  return (p: { x: number; y: number }): { lng: number; lat: number } => ({
    lng: originLng + p.x * 0.001,
    lat: -p.y * 0.001,
  });
}

function point(id: string, coord: Coordinate): Feature {
  return {
    id,
    type: 'Point',
    coordinates: coord,
    layerId: 'l1',
    properties: {},
    locked: false,
    visible: true,
  };
}

function line(id: string, coords: Coordinate[]): Feature {
  return { ...point(id, [0, 0]), type: 'LineString', coordinates: coords };
}

let store: MemoryStore;
let spatialIndex: RBushSpatialIndex;
let service: HitTestServiceImpl;

beforeEach(() => {
  store = new MemoryStore();
  store.createLayer({ id: 'l1', name: 'l1', visible: true, locked: false, opacity: 1, order: [] });
  spatialIndex = new RBushSpatialIndex();
  service = new HitTestServiceImpl(store, spatialIndex);
});

function load(features: Feature[]): Feature[] {
  for (const feature of features) {
    store.createFeature(feature);
    spatialIndex.insert(feature);
  }
  return store.getOrderedFeatures();
}

describe('clickCopies', () => {
  it('returns the click unchanged away from the antimeridian', () => {
    const click: Coordinate = [139.7, 35.7];
    expect(clickCopies(click, 0.01)).toEqual([click]);
    expect(clickCopies(click, 0.01)[0]).toBe(click);
  });

  it('brings an unwrapped click into [-180, 180]', () => {
    const [copy] = clickCopies([180.1, 0], 0.01);
    expect(copy[0]).toBeCloseTo(-179.9);
  });

  it('adds the neighbouring copy when the reach runs past 180', () => {
    const copies = clickCopies([179.995, 0], 0.01);
    expect(copies).toHaveLength(2);
    expect(copies[1][0]).toBeCloseTo(-180.005);
  });
});

describe('hit testing the copy on the other side of the antimeridian', () => {
  it('hits a point stored at -179.9 with a click at 180.1', () => {
    const ordered = load([point('west', [-179.9, 0]), point('east', [179.9, 0])]);
    // The click is at x = 0 of an unproject whose origin is 180.1 (unwrapped)
    const hit = service.hitTest({ x: 0, y: 0 }, unprojectFrom(180.1), ordered);
    expect(hit?.feature.id).toBe('west');
  });

  it('hits the point just across the line from a click within the tolerance', () => {
    const ordered = load([point('west', [-179.999, 0])]);
    // 179.999 is 0.002 degrees from -179.999 across the line (the tolerance is 3 px =
    // 0.003 degrees)
    const hit = service.hitTest({ x: 0, y: 0 }, unprojectFrom(179.999), ordered);
    expect(hit?.feature.id).toBe('west');
  });

  it('hits a line stored on the other side with a click on its drawn copy', () => {
    const ordered = load([
      line('west', [
        [-179.95, -0.01],
        [-179.85, 0.01],
      ]),
    ]);
    const hit = service.hitTest({ x: 0, y: 0 }, unprojectFrom(180.1), ordered);
    expect(hit?.feature.id).toBe('west');
  });

  it('does not change a click away from the antimeridian', () => {
    const ordered = load([point('a', [139.7, 0]), point('far', [-40.3, 0])]);
    expect(service.hitTest({ x: 0, y: 0 }, unprojectFrom(139.7), ordered)?.feature.id).toBe('a');
    expect(service.hitTest({ x: 0, y: 0 }, unprojectFrom(319.7), ordered)?.feature.id).toBe('far');
  });
});
