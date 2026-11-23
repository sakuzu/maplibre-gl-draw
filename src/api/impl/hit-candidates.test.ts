// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for the hit test that reads the candidates near the pointer, without a feature made of
 * every row
 *
 * The answers are held to the hit test that lists every feature shown and tests them in
 * stacking order, written here: on documents made at random, at random places, and in the
 * scenes where the two could part (a layer off the stacking order, a large marker, the
 * companions, a change not told yet). The map stub projects one degree to one hundred pixels.
 */

import type { Point } from 'geojson';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toleranceDegrees } from '../../dispatcher/hit-test/local-frame.js';
import { HitTestServiceImpl } from '../../dispatcher/hit-test/service.js';
import { createTopmostHitTester, type TopHit } from '../../dispatcher/hit-test/topmost.js';
import type { WorkCounts } from '../../shared/work-counts.js';
import type { FeatureRowField, Store as RowStore } from '../../store/built-in/types.js';
import { FEATURES_KEPT } from '../../store/document-access.js';
import { getDisplayFeatures } from '../../store/local-visibility.js';
import type { SpatialIndex } from '../../store/spatial/spatial-index.js';
import type { Group, Layer, Feature as StoredFeature } from '../../store/types.js';
import {
  createCountedInstance,
  createMapStub,
  createSyntheticInput,
  expectNotProportional,
  rowWrites,
  storeWorkDuring,
  WORK_SCENES,
  workDuring,
} from '../../test-utils.js';
import {
  createFeatureCompanionRegistry,
  type FeatureCompanionRegistry,
  hitTestFeatureCompanions,
} from '../../view/feature-companion.js';
import type { Draw } from '../draw.js';
import { createDrawOnEngine } from './create-draw.js';
import type { Engine } from './engine.js';
import { createEngine } from './engine.js';

let engine: Engine;
let draw: Draw;

beforeEach(() => {
  engine = createEngine(createMapStub().map, {}, { deferDefaultMode: true });
  draw = createDrawOnEngine(engine);
  engine.enterDefaultMode();
  draw.setMode('select');
});

afterEach(() => {
  engine.destroy();
});

const unproject = (p: { x: number; y: number }) => engine.map.unproject([p.x, p.y]);
const screenOf = (lngLat: [number, number]) => {
  const { x, y } = engine.map.project(lngLat);
  return { x, y };
};

/**
 * The hit of the features of the Store as it was found by listing every feature shown: the
 * features shown in stacking order, each tested, and the frontmost of those hit
 */
function listedHit(at: [number, number]): StoredFeature | null {
  const { store, hitTestService } = engine.context;
  const ordered = getDisplayFeatures(store);
  const hits = new Set(
    hitTestService.hitTestFeatures(screenOf(at), unproject, ordered).map((r) => r.feature.id),
  );
  for (let i = ordered.length - 1; i >= 0; i--) if (hits.has(ordered[i].id)) return ordered[i];
  return null;
}

/** A tester of the unified z walk over the Store of the instance, with its own companions */
function testerWith(companions: FeatureCompanionRegistry) {
  const { store, hitTestService } = engine.context;
  return createTopmostHitTester({
    store,
    hitTestService,
    unproject,
    toleranceLngLat: (point) => toleranceDegrees(unproject, point, 6),
    project: (lngLat) => screenOf([lngLat[0], lngLat[1]]),
    getZoom: () => engine.map.getZoom(),
    clickTolerancePx: 6,
    companions,
  });
}

/** The unified z walk as it was found by listing every feature shown (no dataset) */
function listedTop(companions: FeatureCompanionRegistry, at: [number, number]): TopHit | null {
  const { store, hitTestService } = engine.context;
  const point = screenOf(at);
  const ordered = getDisplayFeatures(store);
  const hits = new Set(
    hitTestService.hitTestFeatures(point, unproject, ordered).map((r) => r.feature.id),
  );
  const context = {
    point,
    project: (lngLat: [number, number] | number[]) => screenOf([lngLat[0], lngLat[1]]),
    unproject,
    zoom: engine.map.getZoom(),
    tolerancePx: 6,
  };
  for (let i = ordered.length - 1; i >= 0; i--) {
    if (hits.has(ordered[i].id)) return { kind: 'store', feature: ordered[i] };
    const companion = hitTestFeatureCompanions(companions, ordered[i], context);
    if (companion) return { kind: 'companion', companion };
  }
  return null;
}

/** A companion hit within `radiusPx` of the position of a point that names `lead` */
function leadCompanions(radiusPx: number): FeatureCompanionRegistry {
  const companions = createFeatureCompanionRegistry();
  companions.register({
    id: 'lead',
    has: (feature) => feature.properties.lead === true && feature.geometry.type === 'Point',
    draw() {},
    hitTest(feature, point) {
      const p = screenOf((feature.geometry as Point).coordinates as [number, number]);
      return Math.hypot(point.x - p.x, point.y - p.y) <= radiusPx ? { id: feature.id } : null;
    },
    onCompanionClick: () => true,
  });
  return companions;
}

describe('a companion asked inside a transaction, before its change is told', () => {
  it('keeps the answer from before the transaction, and is hit once the change is told', () => {
    const companions = leadCompanions(80);
    const tester = testerWith(companions);
    const p = draw.features.create({
      type: 'Point',
      geometry: { type: 'Point', coordinates: [0, 0] },
    });
    if (!p) throw new Error('no feature');
    // The companions are followed from here on
    expect(tester(screenOf([0.5, 0]))).toBeNull();

    let inside: TopHit | null = { kind: 'store', feature: p as StoredFeature };
    draw.transact(() => {
      draw.features.update(p.id, { properties: { lead: true } });
      inside = tester(screenOf([0.5, 0]));
    });

    // The transaction that wrote the feature still has the answer from before it
    expect(inside).toBeNull();
    // Once the change is told, the companion is hit
    expect(tester(screenOf([0.5, 0]))).toEqual({
      kind: 'companion',
      companion: { providerId: 'lead', featureId: p.id, hit: { id: p.id } },
    });
  });
});

describe('a hit of a feature itself asked inside a transaction, before its change is told', () => {
  it('answers as the walk over every feature shown answers', () => {
    const p = draw.features.create({
      type: 'Point',
      geometry: { type: 'Point', coordinates: [0, 0] },
    });
    if (!p) throw new Error('no feature');
    let inside: StoredFeature | null = null;
    let listed: StoredFeature | null = null;
    draw.transact(() => {
      draw.features.update(p.id, { geometry: { type: 'Point', coordinates: [0.5, 0] } });
      inside =
        engine.context.hitTestService.hitTest(screenOf([0.5, 0]), unproject)?.feature ?? null;
      listed = listedHit([0.5, 0]);
    });
    expect(inside).toEqual(listed);
    expect((inside as StoredFeature | null)?.id).toBe(p.id);
  });
});

// ============================================================================
// Documents made at random
// ============================================================================

/** A generator of numbers from 0 to 1, the same for the same seed */
function random(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A layer of the document, by its ID */
function layerOf(id: string): Layer {
  return {
    id,
    name: id,
    visible: true,
    locked: false,
    opacity: 1,
    styleRule: undefined,
    metadata: undefined,
  };
}

/**
 * Fills the document with features at random: several layers (one off the stacking order) and
 * groups, features of every kind (points with large markers, an Image, a Circle, features across
 * the antimeridian), hidden and locked ones, ones hidden on this client, rows written with the
 * same key as another, and a marker written from outside the instance
 *
 * @returns The places to click: near each feature, and across the antimeridian
 */
function fillAtRandom(next: () => number): Array<[number, number]> {
  const { store } = engine.context;
  const raw = draw.getStore() as RowStore;
  const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)];
  const name = () => `f-${Math.floor(next() * 1e9).toString(36)}`;
  const layerIds = ['A', 'B', 'C', 'OFF'];
  for (const id of layerIds) store.createLayer(layerOf(id));
  store.setLayerOrder(store.getLayerOrder().filter((id) => id !== 'OFF'));
  if (next() < 0.5) store.updateLayer('B', { visible: false });
  if (next() < 0.5) store.setLocallyHidden('C', true);
  if (next() < 0.5) store.updateLayer('A', { locked: true });
  const groups: Array<{ id: string; layerId: string }> = [];
  for (const layerId of layerIds) {
    for (let g = 0; g < 2; g++) {
      const id = `g-${layerId}-${g}`;
      store.createGroup({
        id,
        layerId,
        name: id,
        locked: next() < 0.2,
        visible: next() > 0.2,
      } as Group);
      if (next() < 0.15) store.setLocallyHidden(id, true);
      groups.push({ id, layerId });
    }
  }
  const at = (): [number, number] => [next() * 2 - 1, next() * 2 - 1];
  const places: Array<[number, number]> = [];
  const created: StoredFeature[] = [];
  for (let i = 0; i < 60; i++) {
    const layerId = pick(layerIds);
    const inGroup = next() < 0.4 ? pick(groups.filter((g) => g.layerId === layerId)) : undefined;
    const [x, y] = at();
    const kind = Math.floor(next() * 8);
    const base = {
      id: name(),
      layerId,
      groupId: inGroup?.id,
      properties: (next() < 0.2 ? { lead: true } : {}) as Record<string, unknown>,
      locked: next() < 0.15,
      visible: next() > 0.1,
      style: {} as Record<string, unknown>,
    };
    let feature: StoredFeature;
    if (kind === 0 || kind === 1) {
      if (next() < 0.5) base.style.pointRadius = 5 + next() * 40;
      if (next() < 0.3) base.style.pointStrokeWidth = next() * 10;
      feature = { ...base, type: 'Point', geometry: { type: 'Point', coordinates: [x, y] } };
    } else if (kind === 2) {
      feature = {
        ...base,
        type: 'MultiPoint',
        geometry: {
          type: 'MultiPoint',
          coordinates: [
            [x, y],
            [x + 0.3, y - 0.2],
          ],
        },
      };
    } else if (kind === 3) {
      feature = {
        ...base,
        type: 'LineString',
        geometry: {
          type: 'LineString',
          coordinates: [
            [x, y],
            [x + 0.4, y + 0.1],
            [x + 0.5, y - 0.3],
          ],
        },
      };
    } else if (kind === 4) {
      const s = 0.1 + next() * 0.5;
      feature = {
        ...base,
        type: 'Polygon',
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [x, y],
              [x + s, y],
              [x + s, y + s],
              [x, y + s],
              [x, y],
            ],
          ],
        },
      };
    } else if (kind === 5) {
      feature = {
        ...base,
        type: 'Circle',
        geometry: { type: 'Point', coordinates: [x, y] },
        properties: {
          ...base.properties,
          'maplibre-gl-draw:radiusMeters': 5_000 + next() * 20_000,
        },
      };
    } else if (kind === 6) {
      feature = {
        ...base,
        type: 'Image',
        geometry: { type: 'Point', coordinates: [x, y] },
        properties: {
          ...base.properties,
          'maplibre-gl-draw:imageFileId': 'file-1',
          'maplibre-gl-draw:imageWidth': 200 + Math.floor(next() * 400),
          'maplibre-gl-draw:imageHeight': 200 + Math.floor(next() * 400),
          'maplibre-gl-draw:createdZoom': 10,
        },
      };
    } else {
      // Across the antimeridian: a point on either side, or a line on the west side
      const lat = y;
      feature =
        next() < 0.5
          ? {
              ...base,
              type: 'Point',
              geometry: { type: 'Point', coordinates: [next() < 0.5 ? -179.97 : 179.97, lat] },
            }
          : {
              ...base,
              type: 'LineString',
              geometry: {
                type: 'LineString',
                coordinates: [
                  [-179.98, lat],
                  [-179.9, lat + 0.05],
                ],
              },
            };
      places.push([179.98 + next() * 0.06, lat + (next() - 0.5) * 0.1]);
    }
    if (!store.createFeature(feature)) throw new Error(`${feature.id} not created`);
    created.push(feature);
    if (next() < 0.08) store.setLocallyHidden(feature.id, true);
    const c = feature.type === 'Polygon' ? [x + 0.05, y + 0.05] : [x, y];
    if (kind !== 7) {
      places.push([c[0] + (next() - 0.5) * 0.2, c[1] + (next() - 0.5) * 0.2]);
      places.push([c[0] + (next() - 0.5) * 0.6, c[1] + (next() - 0.5) * 0.6]);
    }
  }
  // Rows written with the key of another row of the same place, from outside the instance
  for (let k = 0; k < 8; k++) {
    const a = pick(created);
    const b = pick(created.filter((f) => f.id !== a.id && f.layerId === a.layerId));
    if (!b || a.groupId !== b.groupId) continue;
    const refA = raw.tables.getRowRef(a.id);
    const refB = raw.tables.getRowRef(b.id);
    if (refA === undefined || refB === undefined) continue;
    const key = raw.tables
      .readValues(Int32Array.of(refA), ['orderKey'])
      .fields.get('orderKey')?.[0];
    raw.writeRows({
      rows: Int32Array.of(refB),
      fields: new Map<FeatureRowField, unknown[]>([['orderKey', [key]]]),
    });
  }
  // A large marker written from outside the instance
  const point = created.find((f) => f.type === 'Point');
  const ref = point ? raw.tables.getRowRef(point.id) : undefined;
  if (ref !== undefined) {
    raw.writeRows({
      rows: Int32Array.of(ref),
      fields: new Map<FeatureRowField, unknown[]>([['style:pointRadius', [55]]]),
    });
  }
  return places;
}

describe('the hit test on documents made at random', () => {
  it('finds the frontmost hit, and every hit, as the walk over every feature shown finds them', {
    timeout: 60_000,
  }, () => {
    let found = 0;
    let companionsHit = 0;
    for (let seed = 1; seed <= 40; seed++) {
      engine.destroy();
      engine = createEngine(createMapStub().map, {}, { deferDefaultMode: true });
      draw = createDrawOnEngine(engine);
      engine.enterDefaultMode();
      const places = fillAtRandom(random(seed));
      const { hitTestService, store } = engine.context;
      const companions = leadCompanions(30);
      const tester = testerWith(companions);
      for (const at of places) {
        const top = tester(screenOf(at));
        expect({ seed, at, top }).toEqual({ seed, at, top: listedTop(companions, at) });
        if (top?.kind === 'companion') companionsHit += 1;
        const point = screenOf(at);
        const hit = hitTestService.hitTest(point, unproject)?.feature.id ?? null;
        const listed = listedHit(at)?.id ?? null;
        expect({ seed, at, hit }).toEqual({ seed, at, hit: listed });
        const every = hitTestService.hitTestAll(point, unproject);
        const listedEvery = hitTestService.hitTestFeatures(
          point,
          unproject,
          getDisplayFeatures(store),
        );
        expect(every.map((r) => [r.feature.id, r.distance])).toEqual(
          listedEvery.map((r) => [r.feature.id, r.distance]),
        );
        if (hit !== null) found += 1;
      }
    }
    // The places hit something often enough for the comparison to hold something
    expect(found).toBeGreaterThan(500);
    expect(companionsHit).toBeGreaterThan(20);
  });
});

// ============================================================================
// The scenes where the two could part
// ============================================================================

/** What a click at a place selects */
function clicked(at: [number, number]): readonly string[] {
  draw.selection.clear();
  createSyntheticInput(engine).click(at, { snap: false });
  return draw.selection.get().ids.toArray();
}

describe('a feature of a layer off the stacking order', () => {
  it('is not hit, and is hit once its layer is in the order again', () => {
    const { store } = engine.context;
    store.createLayer(layerOf('off'));
    const order = store.getLayerOrder().filter((id) => id !== 'off');
    store.setLayerOrder(order);
    const p = draw.features.create({
      type: 'Point',
      geometry: { type: 'Point', coordinates: [0, 0] },
      layerId: 'off',
    });
    if (!p) throw new Error('no feature');
    expect(clicked([0, 0])).toEqual([]);
    expect(engine.context.hitTestService.hitTest(screenOf([0, 0]), unproject)).toBeNull();

    store.setLayerOrder([...order, 'off']);
    expect(clicked([0, 0])).toEqual([p.id]);
  });
});

describe('a point with a large marker', () => {
  /** A point at a place, with the radius of its marker */
  const pointWith = (at: [number, number], pointRadius?: number) => {
    const p = draw.features.create({
      type: 'Point',
      geometry: { type: 'Point', coordinates: at },
      ...(pointRadius !== undefined && { style: { pointRadius } }),
    });
    if (!p) throw new Error('no feature');
    return p;
  };

  it('is hit on its marker away from its position, from when it is created', () => {
    const p = pointWith([0, 0], 40);
    // 42 px from its position: on the marker (40 px with an outline of 2 px) with the tolerance
    expect(clicked([0.45, 0])).toEqual([p.id]);
    // Beyond the marker and the tolerance
    expect(clicked([0.5, 0])).toEqual([]);
  });

  it('is hit on its marker once its style is written', () => {
    const p = pointWith([2, 0]);
    expect(clicked([2.6, 0])).toEqual([]);
    draw.features.update(p.id, { style: { pointRadius: 60 } });
    expect(clicked([2.6, 0])).toEqual([p.id]);
  });

  it('is hit on its marker once its style is written from outside the instance', () => {
    const p = pointWith([-2, 0]);
    const raw = draw.getStore() as RowStore;
    expect(clicked([-2.8, 0])).toEqual([]);
    raw.writeRows({
      rows: Int32Array.of(raw.tables.getRowRef(p.id) as number),
      fields: new Map<FeatureRowField, unknown[]>([['style:pointRadius', [80]]]),
    });
    expect(clicked([-2.8, 0])).toEqual([p.id]);
  });

  it('is hit on its marker after the whole document is replaced', () => {
    pointWith([0, 0], 70);
    const raw = draw.getStore() as RowStore;
    raw.transact(() => {
      raw.clear();
      raw.createLayer(layerOf('next'));
      rowWrites(raw).createFeature({
        id: 'big',
        type: 'Point',
        geometry: { type: 'Point', coordinates: [1, 1] },
        properties: {},
        layerId: 'next',
        groupId: undefined,
        style: { pointRadius: 50 },
        visible: true,
        locked: false,
      });
    }, 'remote');
    expect(clicked([1.5, 1])).toEqual(['big']);
    expect(clicked([1.6, 1])).toEqual([]);
  });
});

describe('the companions of the features', () => {
  /** A companion hit within 100 px of the position of a point that names `lead` */
  const addLead = (clicks: string[]) =>
    draw.extensions.companionProviders.add({
      name: 'lead',
      has: (feature) => feature.properties.lead === true,
      draw() {},
      hitTest(feature, ctx) {
        const [x, y] = ctx.screen.project((feature.geometry as Point).coordinates);
        const distancePx = Math.hypot(ctx.point[0] - x, ctx.point[1] - y);
        return distancePx <= 100
          ? { kind: 'companion', id: `lead-${feature.id}`, featureId: feature.id, distancePx }
          : null;
      },
      onClick(feature) {
        clicks.push(feature.id);
        return true;
      },
    });

  /** A point that names `lead` */
  const lead = (at: [number, number]) => {
    const p = draw.features.create({
      type: 'Point',
      geometry: { type: 'Point', coordinates: at },
      properties: { lead: true },
    });
    if (!p) throw new Error('no feature');
    return p;
  };

  it('hits a companion far from the box of its feature', () => {
    const clicks: string[] = [];
    addLead(clicks);
    const p = lead([0, 0]);
    clicked([0.8, 0]);
    expect(clicks).toEqual([p.id]);
  });

  it('does not hit it once its provider is taken away', () => {
    const clicks: string[] = [];
    const remove = addLead(clicks);
    lead([0, 0]);
    remove();
    clicked([0.8, 0]);
    expect(clicks).toEqual([]);
  });

  it('does not hit it once the values of its feature say it has none', () => {
    const clicks: string[] = [];
    addLead(clicks);
    const p = lead([0, 0]);
    // Asked once, so that the companions are followed
    clicked([0.8, 0]);
    draw.features.update(p.id, { properties: { lead: false } });
    clicked([0.8, 0]);
    expect(clicks).toEqual([p.id]);
  });
});

describe('the points tested on the screen', () => {
  it('reads no point when the projection of the anchors is unusable (no terrain)', () => {
    const { store } = engine.context;
    for (let i = 0; i < 20; i++) {
      draw.features.create({
        type: 'Point',
        geometry: { type: 'Point', coordinates: [i / 10, 0] },
      });
    }
    const listShownPoints = vi.spyOn(store, 'listShownPoints');
    const project = vi.fn(() => null);
    const service = new HitTestServiceImpl(store, engine.context.spatialIndex as SpatialIndex, {
      anchorScreen: { project },
    });

    expect(service.hitTestAll(screenOf([0, 0]), unproject).map((r) => r.feature.type)).toEqual([
      'Point',
    ]);
    // The click alone is projected
    expect(project).toHaveBeenCalledTimes(1);
    expect(listShownPoints).not.toHaveBeenCalled();

    // The instance has no terrain: a click reads no point either
    clicked([0, 0]);
    expect(listShownPoints).not.toHaveBeenCalled();
  });
});

// ============================================================================
// The work that does not grow with the number of features
// ============================================================================

describe(WORK_SCENES.firstPointerAfterChange, () => {
  const instances: ReturnType<typeof createCountedInstance>[] = [];
  afterEach(() => {
    for (const instance of instances.splice(0)) instance.draw.destroy();
  });

  type Instance = ReturnType<typeof createCountedInstance>;
  /** What the marks counted and what went through the Store while `fn` ran */
  const workOf = (instance: Instance, fn: () => void) => {
    let counted: WorkCounts | undefined;
    const through = storeWorkDuring(instance.storeWork, () => {
      counted = workDuring(instance.counts, fn);
    });
    const work = counted as WorkCounts;
    return { objects: work.objectsCreated, rows: work.rowsTouched + through.featuresRead };
  };

  /**
   * `count` points: 400 of them 0.05 degrees apart around the place the pointer goes to, the
   * others 100 degrees away, so that as many features are near the pointer at every size
   */
  const around = (count: number) =>
    Array.from({ length: count }, (_, i) => {
      const coordinates: [number, number] =
        i < 400
          ? [-0.5 + (i % 20) * 0.05, -0.5 + Math.floor(i / 20) * 0.05]
          : [100 + (i % 100) * 0.05, Math.floor(i / 100) * 0.05];
      return { type: 'Point' as const, geometry: { type: 'Point' as const, coordinates } };
    });

  /**
   * An instance over `size` points and one more, drawn until the drawing has no work left, and
   * the pointer moved once: then the style of the one more written, the first and the next moves,
   * another write, and the first and the next clicks, each counted
   */
  const scene = (() => {
    const results = new Map<number, Record<string, { objects: number; rows: number }>>();
    return (size: number) => {
      const known = results.get(size);
      if (known) return known;
      const instance = createCountedInstance();
      instances.push(instance);
      const { draw: d, input } = instance;
      if (!d.features.createMany(around(size))) throw new Error('not created');
      const one = d.features.create({
        type: 'Point',
        geometry: { type: 'Point', coordinates: [0.013, 0.017] },
      });
      if (!one) throw new Error('no feature');
      // 1,024 points more far away: the features the instance keeps made are then those, so
      // that the points near the pointer are read from their rows at both sizes
      const far = Array.from({ length: FEATURES_KEPT }, (_, i) => ({
        type: 'Point' as const,
        geometry: { type: 'Point' as const, coordinates: [-100 - (i % 32) * 0.05, i * 0.001] },
      }));
      if (!d.features.createMany(far)) throw new Error('not created');
      for (let frame = 0; frame < 20 && d.hasPendingWork(); frame++) instance.map.render();
      const at: [number, number] = [0.013, 0.017];
      const away: [number, number] = [0.5, 0.5];
      input.move(away);
      const marker = workOf(instance, () => {
        d.features.update(one.id, { style: { pointRadius: 12 } });
      });
      const firstMove = workOf(instance, () => input.move(at));
      const nextMove = workOf(instance, () => input.move(away));
      d.features.update(one.id, { properties: { changed: true } });
      const firstClick = workOf(instance, () => input.click(at));
      const nextClick = workOf(instance, () => input.click(at));
      if (d.selection.get().ids.toArray()[0] !== one.id) throw new Error('not selected');
      const result = { marker, firstMove, nextMove, firstClick, nextClick };
      results.set(size, result);
      return result;
    };
  })();

  for (const step of ['firstMove', 'firstClick', 'nextMove', 'nextClick'] as const) {
    it(`makes as many objects and reads as many rows for ${step}`, () => {
      expectNotProportional((size) => scene(size)[step].objects, 'the objects made', {
        zero: true,
      });
      expectNotProportional((size) => scene(size)[step].rows, 'the rows read', { zero: true });
    });
  }

  it('raises the largest marker of the points by the row written alone', () => {
    expectNotProportional((size) => scene(size).marker.objects, 'the objects made', {
      zero: true,
    });
    expectNotProportional((size) => scene(size).marker.rows, 'the rows read', { zero: true });
  });
});
