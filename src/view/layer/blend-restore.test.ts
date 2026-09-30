// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for the ownership of the blend state (alpha blending)
 *
 * The blend state of a frame is a single contract that CustomLayer establishes, and it must
 * still hold after control has been handed to an external renderer (a custom feature type or a
 * layer-aware overlay). If it does not hold, everything drawn later in that frame (the layers
 * that follow and the datasets) is drawn with the wrong blending.
 *
 * A bug that actually happened: the renderer of a custom feature type switched to
 * `blendFunc(ONE, ONE_MINUS_SRC_ALPHA)` (premultiplied alpha) and never switched back, so the
 * polygon fills of the data drawn after it (which output a color not premultiplied by alpha)
 * saturated and turned light blue. The symptom appeared or not depending on whether a feature of
 * that custom type was on screen, which made it look like a zoom-dependent rendering bug.
 */

import type { ProjectionData } from 'maplibre-gl';
import { describe, expect, it } from 'vitest';
import { createDatasetManager } from '../../dataset/manager.js';
import type {
  FeatureTypeHandler,
  FrameDrawContext,
  LayeredOverlayRenderer,
} from '../../extension/index.js';
import { geometryFromCoordinates } from '../../shared/utils/coordinates.js';
import type { Store } from '../../store/store.js';
import type { BoundingBox, Feature, Layer } from '../../store/types.js';
import { toRow } from '../../test-utils.js';
import { createFeatureCompanionRegistry } from '../feature-companion.js';
import { renderLayers } from './render.js';
import type { Renderers } from './renderers.js';

/**
 * Stand-in for the blend state. The contract is 'core', an external renderer changes it to
 * 'foreign'
 */
type BlendState = 'core' | 'foreign';

/** Viewport covering the whole globe */
const WORLD: BoundingBox = { minX: -180, minY: -85, maxX: 180, maxY: 85 };

function makeFeature(id: string, type: Feature['type'], layerId: string): Feature {
  return {
    groupId: undefined,
    id,
    type,
    geometry: geometryFromCoordinates(type, [0, 0]),
    layerId,
    properties: {},
    locked: false,
    visible: true,
    style: {},
  };
}

function makeLayer(id: string): Layer {
  return {
    id,
    name: id,
    visible: true,
    locked: false,
    opacity: 1,
    items: [],
    styleRule: undefined,
    metadata: undefined,
  } as Layer;
}

/**
 * A renderLayers call that records "the blend state at that moment" on every paint
 *
 * @returns The paint log (`id@state`)
 */
function run(options: {
  features: Feature[];
  layerOrder: string[];
  /** Whether to re-establish the state after an external renderer (false = before the fix) */
  restore: boolean;
  layerAware?: boolean;
  /** Whether to put a dataset at above-store */
  dataset?: boolean;
}): string[] {
  const paintLog: string[] = [];
  let blend: BlendState = 'core';
  let pending: string[] = [];

  const batchManager = {
    beginFrame: (): void => {
      pending = [];
    },
    processFeature: (feature: Feature): boolean => {
      pending.push(feature.id);
      return false;
    },
    endFrame: (): void => {
      for (const id of pending) paintLog.push(`${id}@${blend}`);
      pending = [];
    },
    // The dataset does not use retained mode (draw it via the immediate path)
    getRetainedRenderers: (): undefined => undefined,
  };

  const r = {
    batchManager,
    tentativeRenderer: { drawGeometry: (): void => {} },
  } as unknown as Renderers;

  const store = {
    getLayerOrder: (): string[] => options.layerOrder,
    getLayer: (id: string): Layer | undefined =>
      options.layerOrder.includes(id) ? makeLayer(id) : undefined,
    getTentative: (): null => null,
  } as unknown as Store;

  // The renderer of a custom type (as an external renderer may do) rewrites
  // the blend state
  const customRenderers = new Map<string, FeatureTypeHandler['renderer']>();
  customRenderers.set('Marker', {
    draw: (feature: { id: string }): void => {
      paintLog.push(`${feature.id}@${blend}`);
      blend = 'foreign';
    },
  } as unknown as FeatureTypeHandler['renderer']);

  const layerAwareRenderers: LayeredOverlayRenderer[] = options.layerAware
    ? [
        {
          drawForLayer: (): void => {
            blend = 'foreign';
          },
        } as unknown as LayeredOverlayRenderer,
      ]
    : [];

  const manager = options.dataset
    ? createDatasetManager({
        requestRepaint: (): void => {},
        getViewportBounds: () => WORLD,
        getZoom: () => 14,
        onViewportChange: () => () => {},
      })
    : undefined;
  manager?.add({
    id: 'data',
    order: 'above-store',
    rows: [toRow({ id: 'data-1', type: 'Point', coordinates: [0, 0] })],
  });

  renderLayers(
    r,
    store,
    options.features,
    new Set<string>(),
    {} as unknown as ProjectionData,
    14,
    customRenderers,
    {} as unknown as FrameDrawContext,
    createFeatureCompanionRegistry(),
    layerAwareRenderers,
    manager,
    undefined,
    options.restore
      ? (): void => {
          blend = 'core';
        }
      : undefined,
  );

  return paintLog;
}

describe('ownership of the blend state (renderLayers)', () => {
  it('after a custom type renderer, the rest of the layer is drawn with the contract', () => {
    const features = [
      makeFeature('marker', 'Marker', 'layer-1'),
      makeFeature('after', 'Point', 'layer-1'),
    ];
    const log = run({ features, layerOrder: ['layer-1'], restore: true });
    expect(log).toEqual(['marker@core', 'after@core']);
  });

  it('without re-establishing, the rest is drawn with the external blend state', () => {
    const features = [
      makeFeature('marker', 'Marker', 'layer-1'),
      makeFeature('after', 'Point', 'layer-1'),
    ];
    const log = run({ features, layerOrder: ['layer-1'], restore: false });
    expect(log).toEqual(['marker@core', 'after@foreign']);
  });

  it('after a layer-aware overlay, the next layer is drawn with the contract state', () => {
    const features = [makeFeature('a', 'Point', 'layer-1'), makeFeature('b', 'Point', 'layer-2')];
    const log = run({
      features,
      layerOrder: ['layer-1', 'layer-2'],
      layerAware: true,
      restore: true,
    });
    expect(log).toEqual(['a@core', 'b@core']);
  });

  it('a dataset (above-store) is drawn with the contract state', () => {
    const features = [makeFeature('marker', 'Marker', 'layer-1')];
    const log = run({
      features,
      layerOrder: ['layer-1'],
      restore: true,
      dataset: true,
    });
    expect(log).toEqual(['marker@core', 'data-1@core']);
  });

  it('without re-establishing, a dataset uses the external state', () => {
    const features = [makeFeature('marker', 'Marker', 'layer-1')];
    const log = run({
      features,
      layerOrder: ['layer-1'],
      restore: false,
      dataset: true,
    });
    expect(log).toEqual(['marker@core', 'data-1@foreign']);
  });
});
