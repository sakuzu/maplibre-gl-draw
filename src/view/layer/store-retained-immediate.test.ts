// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for the immediate-mode drawing of the chunks that are not retained
 */

import type { ProjectionData } from 'maplibre-gl';
import { describe, expect, it } from 'vitest';
import type { CustomRendererDrawContext } from '../../extension/index.js';
import type { Store } from '../../store/store.js';
import type { Feature } from '../../store/types.js';
import { createFeatureCompanionRegistry } from '../feature-companion.js';
import type { RetainedRendererSet } from '../renderers/retained.js';
import { drawFeaturesImmediate, type StoreRetainedDrawDeps } from './store-retained-immediate.js';

function makeFeature(id: string, type: string, visible = true): Feature {
  return {
    id,
    type,
    geometry: { type: 'Point', coordinates: [0, 0] },
    layerId: 'layer-1',
    properties: {},
    locked: false,
    visible,
  } as unknown as Feature;
}

function setup(features: Feature[], hidden: string[] = []) {
  const log: string[] = [];
  const store = {
    getFeature: (id: string) => features.find((f) => f.id === id),
    isLocallyHidden: (id: string) => hidden.includes(id),
    getLocallyHidden: () => new Set(hidden),
  } as unknown as Store;
  let restored = 0;
  const deps: StoreRetainedDrawDeps = {
    renderers: {} as RetainedRendererSet,
    batchManager: {
      beginFrame: () => log.push('begin'),
      processFeature: (feature) => {
        log.push(feature.id);
        return false;
      },
      endFrame: () => log.push('end'),
    },
    customRenderers: new Map([
      ['Custom', { draw: (feature: { id: string }) => log.push(`custom:${feature.id}`) }],
    ]) as unknown as StoreRetainedDrawDeps['customRenderers'],
    customRendererContext: {} as CustomRendererDrawContext,
    companions: createFeatureCompanionRegistry(),
    restoreBlendState: () => {
      restored++;
    },
  };
  return { store, deps, log, restored: () => restored };
}

const PROJECTION = {} as ProjectionData;

describe('drawFeaturesImmediate', () => {
  it('flushes the batch before a custom feature and restores the blend state after it', () => {
    const features = [
      makeFeature('a', 'Point'),
      makeFeature('c', 'Custom'),
      makeFeature('b', 'Point'),
    ];
    const { store, deps, log, restored } = setup(features);

    drawFeaturesImmediate(store, ['a', 'c', 'b'], undefined, PROJECTION, 10, deps);

    expect(log).toEqual(['begin', 'a', 'end', 'custom:c', 'begin', 'b', 'end']);
    expect(restored()).toBe(1);
  });

  it('skips hidden, locally hidden and off-screen features', () => {
    const features = [
      makeFeature('a', 'Point'),
      makeFeature('h', 'Point', false),
      makeFeature('l', 'Point'),
      makeFeature('o', 'Point'),
    ];
    const { store, deps, log } = setup(features, ['l']);

    drawFeaturesImmediate(
      store,
      ['a', 'h', 'l', 'o', 'missing'],
      undefined,
      PROJECTION,
      10,
      deps,
      new Set(['a', 'h', 'l', 'missing']),
    );

    expect(log).toEqual(['begin', 'a', 'end']);
  });
});
