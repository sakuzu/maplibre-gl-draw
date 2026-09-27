// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests of companion rendering and companion hits (feature companion)
 *
 * The first half covers the registry (registration / enumeration / cancellation /
 * generation number). The second half covers the calling convention of rendering, and
 * verifies that "it is called immediately before the feature itself, and the batch frame
 * is closed and reopened around it" and that "for features without companions the frame is
 * not touched at all".
 *
 * core does not interpret the contents of ProjectionData and CustomRendererDrawContext and
 * only passes them straight to the provider, so stubs carrying an identifiable marker are
 * enough.
 */

import type { ProjectionData } from 'maplibre-gl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CustomRendererDrawContext } from '../extension/index.js';
import type { Coordinate, Feature, Layer } from '../store/types.js';
import type {
  CompanionBatchFrame,
  CompanionHit,
  CompanionHitContext,
  FeatureCompanionProvider,
} from './feature-companion.js';
import {
  createFeatureCompanionRegistry,
  drawFeatureCompanionsInFrame,
  type FeatureCompanionRegistry,
  hitTestFeatureCompanions,
  notifyFeatureCompanionClick,
} from './feature-companion.js';

const PROJECTION = { projection: 'stub' } as unknown as ProjectionData;
const DRAW_CONTEXT = { pixelRatio: 2 } as unknown as CustomRendererDrawContext;
const LAYER: Layer = {
  id: 'l1',
  name: 'l1',
  visible: true,
  locked: false,
  opacity: 1,
  items: [],
};

function point(id: string, lng = 0, lat = 0): Feature {
  return {
    id,
    type: 'Point',
    geometry: { type: 'Point', coordinates: [lng, lat] as Coordinate },
    layerId: 'l1',
    properties: {},
    locked: false,
    visible: true,
    style: {},
  };
}

const HIT_CONTEXT: CompanionHitContext = {
  point: { x: 0, y: 0 },
  project: (lngLat: Coordinate) => ({ x: lngLat[0] * 10, y: -lngLat[1] * 10 }),
  unproject: (p: { x: number; y: number }) => ({ lng: p.x / 10, lat: -p.y / 10 }),
  zoom: 10,
  tolerancePx: 5,
};

/** A provider that has companions only for the features with the given IDs */
function stubProvider(
  id: string,
  ownerIds: string[],
  overrides: Partial<FeatureCompanionProvider> = {},
): FeatureCompanionProvider {
  return {
    id,
    has: (feature) => ownerIds.includes(feature.id),
    draw: () => {},
    hitTest: () => null,
    onCompanionClick: () => {},
    ...overrides,
  };
}

/** A batch stub that records the call order of beginFrame / endFrame */
function stubBatch(): CompanionBatchFrame & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    beginFrame: () => calls.push('begin'),
    endFrame: () => calls.push('end'),
  };
}

/**
 * There is one registry per draw instance. It is rebuilt every time in the tests too
 * (it is not a module-level singleton, so state does not leak between tests).
 */
let registry: FeatureCompanionRegistry = createFeatureCompanionRegistry();

beforeEach(() => {
  registry = createFeatureCompanionRegistry();
});

afterEach(() => {
  registry.clear();
});

describe('the registry of companion rendering', () => {
  it('can enumerate the registered providers', () => {
    const provider = stubProvider('p1', []);
    registry.register(provider);

    expect(registry.list()).toEqual([provider]);
    expect(registry.get('p1')).toBe(provider);
    expect(registry.any()).toBe(true);
  });

  it('the "any provider" test is false when nothing is registered', () => {
    expect(registry.any()).toBe(false);
    expect(registry.list()).toEqual([]);
  });

  it('can cancel the registration with the returned function', () => {
    const unregister = registry.register(stubProvider('p1', []));
    unregister();

    expect(registry.list()).toEqual([]);
    expect(registry.get('p1')).toBeUndefined();
  });

  it('re-registering with the same id overwrites', () => {
    registry.register(stubProvider('p1', []));
    const second = stubProvider('p1', []);
    registry.register(second);

    expect(registry.list()).toEqual([second]);
  });

  it('the old cancel function does not remove the provider registered after it', () => {
    const unregisterFirst = registry.register(stubProvider('p1', []));
    const second = stubProvider('p1', []);
    registry.register(second);

    unregisterFirst();

    expect(registry.list()).toEqual([second]);
  });

  it('the generation advances on register and unregister, and stays put otherwise', () => {
    const before = registry.generation();

    const unregister = registry.register(stubProvider('p1', []));
    const afterRegister = registry.generation();
    expect(afterRegister).toBeGreaterThan(before);

    // It does not advance on enumeration or testing
    registry.list();
    registry.has(point('f1'));
    expect(registry.generation()).toBe(afterRegister);

    unregister();
    expect(registry.generation()).toBeGreaterThan(afterRegister);
  });
});

describe('narrowing down with has', () => {
  it('only a feature with a provider whose has is true is true', () => {
    registry.register(stubProvider('p1', ['f1']));

    expect(registry.has(point('f1'))).toBe(true);
    expect(registry.has(point('f2'))).toBe(false);
  });

  it('has is not even called when no provider is registered', () => {
    const has = vi.fn(() => true);
    const unregister = registry.register(stubProvider('p1', [], { has }));
    unregister();

    expect(registry.has(point('f1'))).toBe(false);
    expect(has).not.toHaveBeenCalled();
  });
});

describe('the calling convention of rendering', () => {
  it('closes the batch before drawing and reopens it once drawing is done', () => {
    const draw = vi.fn();
    registry.register(stubProvider('p1', ['f1'], { draw }));
    const batch = stubBatch();

    const drawn = drawFeatureCompanionsInFrame(
      registry,
      point('f1'),
      batch,
      PROJECTION,
      12,
      LAYER,
      DRAW_CONTEXT,
    );

    expect(drawn).toBe(true);
    expect(batch.calls).toEqual(['end', 'begin']);
    expect(draw).toHaveBeenCalledTimes(1);
  });

  it('draw receives the feature, projectionData, zoom and the shared renderer context', () => {
    const draw = vi.fn<FeatureCompanionProvider['draw']>();
    registry.register(stubProvider('p1', ['f1'], { draw }));
    const feature = point('f1');

    drawFeatureCompanionsInFrame(
      registry,
      feature,
      stubBatch(),
      PROJECTION,
      12,
      LAYER,
      DRAW_CONTEXT,
    );

    expect(draw).toHaveBeenCalledWith(feature, PROJECTION, 12, DRAW_CONTEXT);
  });

  it('does not touch the frame for a feature without companions (batching stays efficient)', () => {
    const draw = vi.fn();
    registry.register(stubProvider('p1', ['f1'], { draw }));
    const batch = stubBatch();

    const drawn = drawFeatureCompanionsInFrame(
      registry,
      point('other'),
      batch,
      PROJECTION,
      12,
      LAYER,
      DRAW_CONTEXT,
    );

    expect(drawn).toBe(false);
    expect(batch.calls).toEqual([]);
    expect(draw).not.toHaveBeenCalled();
  });

  it('does not touch the frame when no provider is registered', () => {
    const batch = stubBatch();

    expect(
      drawFeatureCompanionsInFrame(
        registry,
        point('f1'),
        batch,
        PROJECTION,
        12,
        LAYER,
        DRAW_CONTEXT,
      ),
    ).toBe(false);
    expect(batch.calls).toEqual([]);
  });

  it('the frame opens and closes only once even with several providers (drawn in order)', () => {
    const order: string[] = [];
    registry.register(stubProvider('p1', ['f1'], { draw: () => order.push('p1') }));
    registry.register(stubProvider('p2', ['f1'], { draw: () => order.push('p2') }));
    const batch = stubBatch();

    drawFeatureCompanionsInFrame(registry, point('f1'), batch, PROJECTION, 12, LAYER, DRAW_CONTEXT);

    expect(order).toEqual(['p1', 'p2']);
    expect(batch.calls).toEqual(['end', 'begin']);
  });

  it('restores the blend state only when something was drawn', () => {
    const restoreBlendState = vi.fn();
    registry.register(stubProvider('p1', ['f1']));

    drawFeatureCompanionsInFrame(
      registry,
      point('other'),
      stubBatch(),
      PROJECTION,
      12,
      LAYER,
      DRAW_CONTEXT,
      restoreBlendState,
    );
    expect(restoreBlendState).not.toHaveBeenCalled();

    drawFeatureCompanionsInFrame(
      registry,
      point('f1'),
      stubBatch(),
      PROJECTION,
      12,
      LAYER,
      DRAW_CONTEXT,
      restoreBlendState,
    );
    expect(restoreBlendState).toHaveBeenCalledTimes(1);
  });
});

describe('dispatching hits and handing clicks back', () => {
  const HIT: CompanionHit = { id: 'c1' };

  it('asks hitTest only of the providers whose has is true', () => {
    const hitTest = vi.fn(() => null);
    registry.register(stubProvider('p1', ['f1'], { hitTest }));

    expect(hitTestFeatureCompanions(registry, point('other'), HIT_CONTEXT)).toBeNull();
    expect(hitTest).not.toHaveBeenCalled();

    expect(hitTestFeatureCompanions(registry, point('f1'), HIT_CONTEXT)).toBeNull();
    expect(hitTest).toHaveBeenCalledTimes(1);
  });

  it('a hit is accompanied by the provider ID and the feature ID', () => {
    registry.register(stubProvider('p1', ['f1'], { hitTest: () => HIT }));

    expect(hitTestFeatureCompanions(registry, point('f1'), HIT_CONTEXT)).toEqual({
      providerId: 'p1',
      featureId: 'f1',
      hit: HIT,
    });
  });

  it('hitTest receives the tested point and the context', () => {
    const hitTest = vi.fn<FeatureCompanionProvider['hitTest']>(() => null);
    registry.register(stubProvider('p1', ['f1'], { hitTest }));
    const feature = point('f1');

    hitTestFeatureCompanions(registry, feature, HIT_CONTEXT);

    expect(hitTest).toHaveBeenCalledWith(feature, HIT_CONTEXT.point, HIT_CONTEXT);
  });

  it('the provider that hits first wins (registration order)', () => {
    const second = vi.fn(() => ({ id: 'c2' }));
    registry.register(stubProvider('p1', ['f1'], { hitTest: () => HIT }));
    registry.register(stubProvider('p2', ['f1'], { hitTest: second }));

    expect(hitTestFeatureCompanions(registry, point('f1'), HIT_CONTEXT)?.providerId).toBe('p1');
    expect(second).not.toHaveBeenCalled();
  });

  it('a consumed click goes back to the original provider', () => {
    const onCompanionClick = vi.fn();
    registry.register(stubProvider('p1', ['f1'], { onCompanionClick }));

    notifyFeatureCompanionClick(registry, { providerId: 'p1', featureId: 'f1', hit: HIT });

    expect(onCompanionClick).toHaveBeenCalledWith('f1', HIT);
  });

  it('handing a click back to an unregistered provider is ignored', () => {
    const onCompanionClick = vi.fn();
    const unregister = registry.register(stubProvider('p1', ['f1'], { onCompanionClick }));
    unregister();

    notifyFeatureCompanionClick(registry, { providerId: 'p1', featureId: 'f1', hit: HIT });

    expect(onCompanionClick).not.toHaveBeenCalled();
  });
});
