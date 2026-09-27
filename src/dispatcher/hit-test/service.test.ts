// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for the arbitration of HitTestService
 *
 * The arbitration is decided by the visual stacking order alone. Walking the indices of
 * orderedFeatures in descending order (from the front), the first feature that satisfies
 * test() wins, and the distance is not used. This is an intentional breaking change to the
 * former behavior, which gave priority to the distance
 * (see docs/internals/hit-testing.md).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { coordinatesOf } from '../../shared/utils/coordinates.js';
import { MemoryStore } from '../../store/memory.js';
import { RBushSpatialIndex } from '../../store/spatial/spatial-index.js';
import type { Coordinate, Feature, FeatureType } from '../../store/types.js';
import { HitTestServiceImpl } from './service.js';
import type { HitTestStrategy } from './strategies/base.js';
import { HitTestStrategyRegistry } from './strategies/base.js';
import { LineHitTestStrategy } from './strategies/line.js';
import { PointHitTestStrategy } from './strategies/point.js';
import { PolygonHitTestStrategy } from './strategies/polygon.js';

/** An unproject that maps longitude/latitude naively and linearly (1 degree = 10px) */
const unproject = (p: { x: number; y: number }): { lng: number; lat: number } => ({
  lng: p.x / 10,
  lat: -p.y / 10,
});

function polygon(id: string, rings: Coordinate[][]): Feature {
  return {
    id,
    type: 'Polygon',
    geometry: { type: 'Polygon', coordinates: rings },
    layerId: 'l1',
    properties: {},
    locked: false,
    visible: true,
    style: {},
  };
}

/** A square ring that has only an outer ring */
function square(minX: number, minY: number, size: number): Coordinate[] {
  return [
    [minX, minY],
    [minX + size, minY],
    [minX + size, minY + size],
    [minX, minY + size],
    [minX, minY],
  ];
}

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
let service: HitTestServiceImpl;

beforeEach(() => {
  store = new MemoryStore();
  store.createLayer({ id: 'l1', name: 'l1', visible: true, locked: false, opacity: 1, items: [] });
  spatialIndex = new RBushSpatialIndex();
  // A 5px tolerance (0.5 degrees on the test map) keeps the numbers below round
  service = new HitTestServiceImpl(store, spatialIndex, { clickTolerance: 5 });
});

/** Registers into the Store and the index, and returns the array in draw order (from the
 * back to the front) */
function load(features: Feature[]): Feature[] {
  for (const feature of features) {
    store.createFeature(feature);
    spatialIndex.insert(feature);
  }
  return features;
}

describe('the arbitration of HitTestService (the order takes priority)', () => {
  it('a point laid on top of a polygon wins when it is in front of the polygon', () => {
    // A point is placed at the same position as the center of the polygon. With the
    // distance taking priority the point would always win, but here "the front one wins"
    // is confirmed by swapping the order of the polygon and the point.
    const ordered = load([polygon('poly', [square(0, 0, 10)]), point('pt', [5, 5])]);

    const hit = service.hitTest({ x: 50, y: -50 }, unproject, ordered);

    expect(hit?.feature.id).toBe('pt');
  });

  it('a polygon in front occludes a point behind it', () => {
    // The point is behind (earlier in the array), so the polygon wins. Formerly, with the
    // distance taking priority, the point at distance 0 from the center won.
    const ordered = load([point('pt', [5, 5]), polygon('poly', [square(0, 0, 10)])]);

    const hit = service.hitTest({ x: 50, y: -50 }, unproject, ordered);

    expect(hit?.feature.id).toBe('poly');
  });

  it('a hole lets clicks through (the feature behind is hit)', () => {
    // A polygon with an outer ring of 0..10 and a hole of 3..7 is laid on top of the
    // polygon behind it
    const holed = polygon('holed', [square(0, 0, 10), square(3, 3, 4)]);
    const ordered = load([polygon('back', [square(0, 0, 10)]), holed]);

    // Inside the hole (5,5) the click passes through the polygon in front and hits the one
    // behind
    expect(service.hitTest({ x: 50, y: -50 }, unproject, ordered)?.feature.id).toBe('back');
    // Outside the hole (1,1) it hits the polygon in front
    expect(service.hitTest({ x: 10, y: -10 }, unproject, ordered)?.feature.id).toBe('holed');
  });

  it('the front one wins among overlapping polygons (it follows a reordering)', () => {
    const ordered = load([polygon('a', [square(0, 0, 10)]), polygon('b', [square(0, 0, 10)])]);

    expect(service.hitTest({ x: 50, y: -50 }, unproject, ordered)?.feature.id).toBe('b');

    // Swapping the visual order swaps the result as well
    const reversed = [ordered[1], ordered[0]];
    expect(service.hitTest({ x: 50, y: -50 }, unproject, reversed)?.feature.id).toBe('a');
  });

  it('returns null when there is no hit', () => {
    const ordered = load([polygon('poly', [square(0, 0, 10)])]);

    expect(service.hitTest({ x: 500, y: -500 }, unproject, ordered)).toBeNull();
  });
});

describe('the extra reach for narrowing down the candidates (registerCandidateReach)', () => {
  /**
   * A Point strategy that counts anything within 3 degrees (= 30px) of the center as a hit
   *
   * It stands in for a type whose test area is wider than clickTolerance (5px), such as an
   * icon.
   */
  const wideStrategy: HitTestStrategy = {
    geometryType: 'Point',
    test: (feature, coordinate) => {
      const [lng, lat] = coordinatesOf(feature) as Coordinate;
      return Math.hypot(coordinate[0] - lng, coordinate[1] - lat) <= 3;
    },
    distance: () => 0,
  };

  it('keeps the search at clickTolerance when unregistered, so a far point misses it', () => {
    service.registerStrategy(wideStrategy);
    const ordered = load([point('pt', [5, 5])]);
    const findNear = vi.spyOn(spatialIndex, 'findNear');

    // 20px (= 2 degrees) to the right of the center. It is inside the test area
    // (3 degrees), but it does not make it into the candidates
    expect(service.hitTest({ x: 70, y: -50 }, unproject, ordered)).toBeNull();
    // The search radius stays at toleranceLngLat (5px = 0.5 degrees) as before
    expect(findNear.mock.calls[0][0]).toEqual([7, 5]);
    expect(findNear.mock.calls[0][1]).toBeCloseTo(0.5, 10);
  });

  it('widens the search when a reach is registered, so even a far point reaches it', () => {
    service.registerStrategy(wideStrategy);
    service.registerCandidateReach('Point', 40);
    const ordered = load([point('pt', [5, 5])]);
    const findNear = vi.spyOn(spatialIndex, 'findNear');

    expect(service.hitTest({ x: 70, y: -50 }, unproject, ordered)?.feature.id).toBe('pt');
    // 0.5 degrees (5px) + 40px x 0.1 degrees/px = 4.5 degrees
    expect(findNear.mock.calls[0][1]).toBeCloseTo(4.5, 10);
  });

  it('can register a reach as a function too, which is evaluated on every query', () => {
    service.registerStrategy(wideStrategy);
    let reach = 0;
    service.registerCandidateReach('Point', () => reach);
    const ordered = load([point('pt', [5, 5])]);

    expect(service.hitTest({ x: 70, y: -50 }, unproject, ordered)).toBeNull();

    reach = 40;
    expect(service.hitTest({ x: 70, y: -50 }, unproject, ordered)?.feature.id).toBe('pt');
  });

  it('widens only the candidates; the semantics of a hit are up to the strategy', () => {
    service.registerStrategy(wideStrategy);
    service.registerCandidateReach('Point', 200);
    const ordered = load([point('pt', [5, 5])]);
    const findNear = vi.spyOn(spatialIndex, 'findNear');

    // 100px (= 10 degrees) to the right of the center. It makes it into the candidates, but
    // it is outside the test area (3 degrees)
    expect(service.hitTest({ x: 150, y: -50 }, unproject, ordered)).toBeNull();
    expect(findNear.mock.calls[0][1]).toBeCloseTo(20.5, 10);
  });

  it('queries once with the single maximum when several types are registered', () => {
    service.registerCandidateReach('Point', 10);
    service.registerCandidateReach('Marker', 64);
    const ordered = load([point('pt', [5, 5])]);
    const findNear = vi.spyOn(spatialIndex, 'findNear');

    service.hitTestAll({ x: 50, y: -50 }, unproject, ordered);

    // 0.5 degrees + 64px x 0.1 degrees/px = 6.9 degrees
    expect(findNear.mock.calls[0][1]).toBeCloseTo(6.9, 10);
  });
});

describe('the single scan of hitTestAll', () => {
  /** A strategy that counts the calls to the test and the distance computation */
  function createSpyStrategy(geometryType: FeatureType, withTestDistance: boolean) {
    const test = vi.fn((_f: Feature, _c: Coordinate, _t: number) => true);
    const distance = vi.fn((_f: Feature, _c: Coordinate) => 3);
    const testDistance = vi.fn((_f: Feature, _c: Coordinate, _t: number) => 3 as number | null);
    const strategy: HitTestStrategy = withTestDistance
      ? { geometryType, test, distance, testDistance }
      : { geometryType, test, distance };
    return { strategy, test, distance, testDistance };
  }

  it('does not call test / distance for a strategy that has testDistance', () => {
    const spy = createSpyStrategy('Point', true);
    service.registerStrategy(spy.strategy);
    const ordered = load([point('pt', [5, 5])]);

    const results = service.hitTestAll({ x: 50, y: -50 }, unproject, ordered);

    expect(results).toEqual([{ feature: ordered[0], distance: 3 }]);
    expect(spy.testDistance).toHaveBeenCalledTimes(1);
    expect(spy.test).not.toHaveBeenCalled();
    expect(spy.distance).not.toHaveBeenCalled();
  });

  it('leaves it out of the results when testDistance is null', () => {
    const spy = createSpyStrategy('Point', true);
    spy.testDistance.mockReturnValue(null);
    service.registerStrategy(spy.strategy);
    const ordered = load([point('pt', [5, 5])]);

    expect(service.hitTestAll({ x: 50, y: -50 }, unproject, ordered)).toEqual([]);
    expect(spy.distance).not.toHaveBeenCalled();
  });

  it('tests a strategy without testDistance with test + distance', () => {
    const spy = createSpyStrategy('Point', false);
    service.registerStrategy(spy.strategy);
    const ordered = load([point('pt', [5, 5])]);

    const results = service.hitTestAll({ x: 50, y: -50 }, unproject, ordered);

    expect(results).toEqual([{ feature: ordered[0], distance: 3 }]);
    expect(spy.test).toHaveBeenCalledTimes(1);
    expect(spy.distance).toHaveBeenCalledTimes(1);
  });

  it('matches the former test + distance implementation on a mix of features', () => {
    const line: Feature = {
      id: 'line',
      type: 'LineString',
      geometry: {
        type: 'LineString',
        coordinates: [
          [0, 4],
          [10, 4],
        ] as Coordinate[],
      },
      layerId: 'l1',
      properties: {},
      locked: false,
      visible: true,
      style: {},
    };
    const ordered = load([
      polygon('poly', [square(0, 0, 10)]),
      point('pt', [5, 5.9]),
      line,
      polygon('far', [square(100, 100, 10)]),
    ]);

    const screenPoint = { x: 50, y: -55 };
    const results = service.hitTestAll(screenPoint, unproject, ordered);

    // Build the expected value with the former implementation (the double scan of
    // test -> distance)
    const registry = new HitTestStrategyRegistry();
    registry.register(new PointHitTestStrategy());
    registry.register(new LineHitTestStrategy());
    registry.register(new PolygonHitTestStrategy());
    const lngLat = unproject(screenPoint);
    const coordinate: Coordinate = [lngLat.lng, lngLat.lat];
    // The stub unproject is unrotated, so the tolerance is the plain longitude difference
    const toleranceLngLat = Math.abs(
      unproject({ x: screenPoint.x + 5, y: screenPoint.y }).lng - lngLat.lng,
    );
    const expected = ordered
      .filter((f) => {
        const strategy = registry.get(f.type);
        return strategy?.test(f, coordinate, toleranceLngLat) ?? false;
      })
      .map((f) => ({
        feature: f,
        // The filter just above already confirmed that the strategy exists
        distance: registry.get(f.type)!.distance(f, coordinate),
      }))
      .sort((a, b) => a.distance - b.distance);

    expect(expected.length).toBeGreaterThan(1);
    expect(results.map((r) => r.feature.id)).toEqual(expected.map((r) => r.feature.id));
    expect(results.map((r) => r.distance)).toEqual(expected.map((r) => r.distance));
  });
});

describe('the visibility lookup of HitTestService', () => {
  it('looks a layer or a group up only once per container within one hit test', () => {
    // Looking the layer up for every feature makes one hit test O(N^2) on a store where
    // reading a layer costs time proportional to the feature count. Many features are
    // placed in the candidate set, and the queries to the store are checked to level off
    // at the number of containers rather than the number of features.
    store.createGroup({
      id: 'g1',
      layerId: 'l1',
      name: 'g1',
      featureIds: [],
      locked: false,
      visible: true,
    });
    const features: Feature[] = [];
    for (let i = 0; i < 200; i++) {
      const f = point(`p${i}`, [5, 5]);
      if (i % 2 === 0) f.groupId = 'g1';
      features.push(f);
    }
    const ordered = load(features);
    const getLayer = vi.spyOn(store, 'getLayer');
    const getGroup = vi.spyOn(store, 'getGroup');

    const hits = service.hitTestAll({ x: 50, y: -50 }, unproject, ordered);

    expect(hits.length).toBe(200);
    expect(getLayer).toHaveBeenCalledTimes(1);
    expect(getGroup).toHaveBeenCalledTimes(1);
  });

  it('rebuilds the lookup per hit test (a visibility change affects the next one)', () => {
    const ordered = load([point('pt', [5, 5])]);
    expect(service.hitTest({ x: 50, y: -50 }, unproject, ordered)?.feature.id).toBe('pt');
    store.updateLayer('l1', { visible: false });
    expect(service.hitTest({ x: 50, y: -50 }, unproject, ordered)).toBeNull();
  });
});

describe('cancelling the registrations', () => {
  it('puts back the built-in strategy a custom strategy replaced', () => {
    const builtIn = new PointHitTestStrategy();
    const custom: HitTestStrategy = { geometryType: 'Point', test: () => true, distance: () => 0 };
    const registry = new HitTestStrategyRegistry();
    registry.register(builtIn);

    const cancel = registry.register(custom);
    expect(registry.get('Point')).toBe(custom);
    cancel();
    expect(registry.get('Point')).toBe(builtIn);
  });

  it('keeps a later registration when an earlier one is cancelled', () => {
    const cancelReach = service.registerCandidateReach('Point', 40);
    service.registerCandidateReach('Point', 10);
    cancelReach();
    const ordered = load([point('pt', [5, 5])]);
    const findNear = vi.spyOn(spatialIndex, 'findNear');

    service.hitTestAll({ x: 50, y: -50 }, unproject, ordered);

    // 0.5 degrees + 10px x 0.1 degrees/px
    expect(findNear.mock.calls[0][1]).toBeCloseTo(1.5, 10);
  });
});
