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
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { toleranceDegrees } from '../../dispatcher/hit-test/local-frame.js';
import { createTopmostHitTester, type TopHit } from '../../dispatcher/hit-test/topmost.js';
import { getDisplayFeatures } from '../../store/local-visibility.js';
import type { Feature as StoredFeature } from '../../store/types.js';
import { createMapStub } from '../../test-utils.js';
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
    has: (feature) => feature.properties.lead === true,
    draw() {},
    hitTest(feature, point) {
      const p = screenOf((feature.geometry as Point).coordinates as [number, number]);
      return Math.hypot(point.x - p.x, point.y - p.y) <= radiusPx ? { id: feature.id } : null;
    },
    onCompanionClick: () => true,
  });
  return companions;
}

describe('a hit asked inside a transaction, before its change is told', () => {
  it('answers as the walk over every feature shown answers', () => {
    const companions = leadCompanions(80);
    const tester = testerWith(companions);
    const p = draw.features.create({
      type: 'Point',
      geometry: { type: 'Point', coordinates: [0, 0] },
    });
    if (!p) throw new Error('no feature');
    // The companions are followed from here on
    expect(tester(screenOf([0.5, 0]))).toBeNull();

    let inside: TopHit | null = null;
    let listed: TopHit | null = null;
    draw.transact(() => {
      draw.features.update(p.id, { properties: { lead: true } });
      inside = tester(screenOf([0.5, 0]));
      listed = listedTop(companions, [0.5, 0]);
    });

    expect(inside).toEqual(listed);
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
