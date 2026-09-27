// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for the unified z traversal
 *
 * They verify that it walks the features of the Store and the datasets in
 * a single stacking order and returns the single frontmost thing among those that are
 * visible. The traversal order is above-store -> the stacking order from the end (the
 * front) -> below-store.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatasetManager, type DatasetManager } from '../../dataset/manager.js';
import { MemoryStore } from '../../store/memory.js';
import { RBushSpatialIndex } from '../../store/spatial/spatial-index.js';
import type { BoundingBox, Coordinate, Feature } from '../../store/types.js';
import type { FeatureCompanionProvider } from '../../view/feature-companion.js';
import {
  createFeatureCompanionRegistry,
  type FeatureCompanionRegistry,
} from '../../view/feature-companion.js';
import { HitTestServiceImpl } from './service.js';
import { createTopmostHitTester, type HitTestTopmost, type TopHit } from './topmost.js';

/** Takes the feature out as a dataset hit (narrowing down a TopHit) */
function datasetFeature(top: TopHit | null): Feature | null | undefined {
  return top?.kind === 'dataset' ? top.feature : undefined;
}

const WORLD: BoundingBox = { minX: -180, minY: -85, maxX: 180, maxY: 85 };

/** An unproject that maps longitude/latitude naively and linearly (1 degree = 10px) */
const unproject = (p: { x: number; y: number }): { lng: number; lat: number } => ({
  lng: p.x / 10,
  lat: -p.y / 10,
});

/** A square polygon that contains the center (5,5) */
function polygon(id: string, layerId: string): Feature {
  return {
    id,
    type: 'Polygon',
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          [0, 0],
          [10, 0],
          [10, 10],
          [0, 10],
          [0, 0],
        ],
      ],
    },
    layerId,
    properties: {},
    locked: false,
    visible: true,
    style: {},
  };
}

/** The screen coordinates of the center of the polygon */
const CENTER = { x: 50, y: -50 };
const CENTER_COORD: Coordinate = [5, 5];

let store: MemoryStore;
let spatialIndex: RBushSpatialIndex;
let service: HitTestServiceImpl;
let manager: DatasetManager;

beforeEach(() => {
  store = new MemoryStore();
  spatialIndex = new RBushSpatialIndex();
  service = new HitTestServiceImpl(store, spatialIndex);
  manager = createDatasetManager({
    getViewportBounds: () => WORLD,
    getZoom: () => 10,
    onViewportChange: () => () => {},
    requestRepaint: () => {},
  });
});

function createLayer(id: string): void {
  store.createLayer({ id, name: id, visible: true, locked: false, opacity: 1, order: [] });
}

function createFeature(feature: Feature): void {
  store.createFeature(feature);
  spatialIndex.insert(feature);
}

/** A dataset (it holds one point at the same position as the center) */
function addDataset(
  id: string,
  order: 'below-store' | 'above-store' | 'layer-order',
  interactive = true,
): ReturnType<DatasetManager['add']> {
  return manager.add({
    id,
    features: [{ id: `${id}-f`, type: 'Point', coordinates: CENTER_COORD }],
    interactive,
    order,
  });
}

/** There is one provider of the companion rendering per draw instance */
let companions: FeatureCompanionRegistry = createFeatureCompanionRegistry();

function createTester(withDatasets = true): HitTestTopmost {
  return createTopmostHitTester({
    companions,
    store,
    hitTestService: service,
    unproject,
    toleranceLngLat: () => 0.5,
    datasets: withDatasets ? manager : undefined,
    project: (lngLat: Coordinate) => ({ x: lngLat[0] * 10, y: -lngLat[1] * 10 }),
    getZoom: () => 10,
    clickTolerancePx: 5,
  });
}

describe('the order of the unified z traversal', () => {
  beforeEach(() => {
    createLayer('l1');
    createFeature(polygon('f1', 'l1'));
  });

  it('returns a feature of the Store when there is no dataset', () => {
    expect(createTester()(CENTER)).toEqual({ kind: 'store', feature: store.getFeature('f1') });
  });

  it('places an above-store dataset in front of every layer', () => {
    addDataset('above', 'above-store');

    const top = createTester()(CENTER);

    expect(top?.kind).toBe('dataset');
    expect(datasetFeature(top)?.id).toBe('above-f');
  });

  it('places a below-store dataset behind every layer', () => {
    addDataset('below', 'below-store');

    expect(createTester()(CENTER)?.kind).toBe('store');
  });

  it('a dataset inserted into the order wins or loses by its position in it', () => {
    createLayer('l2');
    createFeature(polygon('f2', 'l2'));
    addDataset('middle', 'layer-order');

    // l1 -> middle -> l2: the frontmost one is the feature of l2
    store.setLayerOrder(['l1', 'middle', 'l2']);
    expect(createTester()(CENTER)).toEqual({ kind: 'store', feature: store.getFeature('f2') });

    // l1 -> l2 -> middle: the frontmost one is the dataset
    store.setLayerOrder(['l1', 'l2', 'middle']);
    const top = createTester()(CENTER);
    expect(top?.kind).toBe('dataset');
    expect(datasetFeature(top)?.id).toBe('middle-f');
  });

  it('does not let a layer-order dataset that is not in the order occlude anything', () => {
    addDataset('orphan', 'layer-order');

    expect(createTester()(CENTER)?.kind).toBe('store');
  });

  it('skips an unknown ID in the order', () => {
    addDataset('middle', 'layer-order');
    store.setLayerOrder(['l1', 'unknown-entry', 'middle']);

    const top = createTester()(CENTER);

    expect(top?.kind).toBe('dataset');
    expect(datasetFeature(top)?.id).toBe('middle-f');
  });

  it('does not let a hidden dataset occlude anything', () => {
    const dataset = addDataset('above', 'above-store');
    dataset.setVisible(false);

    expect(createTester()(CENTER)?.kind).toBe('store');
  });

  it('returns null when nothing is hit', () => {
    addDataset('above', 'above-store');

    expect(createTester()({ x: 5000, y: -5000 })).toBeNull();
  });
});

describe('the meaning of interactive', () => {
  beforeEach(() => {
    createLayer('l1');
    createFeature(polygon('f1', 'l1'));
  });

  it('lets a dataset with interactive: false occlude too (feature is null)', () => {
    addDataset('above', 'above-store', false);

    const top = createTester()(CENTER);

    expect(top?.kind).toBe('dataset');
    expect(datasetFeature(top)).toBeNull();
    // The traversal ends the moment something occludes, so the feature of the Store behind
    // it is not returned
    expect(top?.kind === 'dataset' && top.dataset.id).toBe('above');
  });

  it('does not descend to the dataset behind even with interactive: false', () => {
    addDataset('below', 'below-store');
    addDataset('above', 'above-store', false);

    const top = createTester()(CENTER);
    expect(top?.kind === 'dataset' && top.dataset.id).toBe('above');
  });
});

describe('the short circuit when there is no dataset', () => {
  it('does not walk the order without a visible dataset (same cost as the old path)', () => {
    createLayer('l1');
    createFeature(polygon('f1', 'l1'));
    const getLayerOrder = vi.spyOn(store, 'getLayerOrder');

    // There is a manager, but not a single dataset
    const top = createTester()(CENTER);

    expect(top?.kind).toBe('store');
    expect(getLayerOrder).not.toHaveBeenCalled();
    getLayerOrder.mockRestore();
  });

  it('works with the Store alone even without a manager', () => {
    createLayer('l1');
    createFeature(polygon('f1', 'l1'));

    expect(createTester(false)(CENTER)?.kind).toBe('store');
  });

  it('returns to the short circuit when a dataset is hidden', () => {
    createLayer('l1');
    createFeature(polygon('f1', 'l1'));
    const dataset = addDataset('above', 'above-store');
    const getLayerOrder = vi.spyOn(store, 'getLayerOrder');

    dataset.setVisible(false);
    createTester()(CENTER);

    expect(getLayerOrder).not.toHaveBeenCalled();
    getLayerOrder.mockRestore();
  });
});

describe('passing orderedFeatures in', () => {
  it('uses the list that was passed in as it is (it does not fetch from the Store again)', () => {
    createLayer('l1');
    createFeature(polygon('f1', 'l1'));
    addDataset('below', 'below-store');

    const orderedFeatures = [store.getFeature('f1') as Feature];
    const top = createTester()(CENTER, { orderedFeatures });

    expect(top).toEqual({ kind: 'store', feature: orderedFeatures[0] });
  });
});

describe('the z order and the consumption of the companions (feature companion)', () => {
  /** A polygon at a position away from the center (the test of the feature itself always
   * fails) */
  function awayPolygon(id: string, layerId: string): Feature {
    return {
      id,
      type: 'Polygon',
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [100, 100],
            [110, 100],
            [110, 110],
            [100, 110],
            [100, 100],
          ],
        ],
      },
      layerId,
      properties: {},
      locked: false,
      visible: true,
      style: {},
    };
  }

  /** A provider that gives the features with the given IDs a companion that is always hit */
  function registerCompanion(ownerIds: string[], id = 'p1'): FeatureCompanionProvider {
    const provider: FeatureCompanionProvider = {
      id,
      has: (feature) => ownerIds.includes(feature.id),
      draw: () => {},
      hitTest: () => ({ id: `companion-of-${id}` }),
      onCompanionClick: () => {},
    };
    companions.register(provider);
    return provider;
  }

  beforeEach(() => {
    companions = createFeatureCompanionRegistry();
  });

  it('returns a feature of the Store as before when there is no provider', () => {
    createLayer('l1');
    createFeature(polygon('f1', 'l1'));

    expect(createTester(false)(CENTER)).toEqual({ kind: 'store', feature: store.getFeature('f1') });
  });

  it('lets the feature itself win over its own companions when the feature itself is hit', () => {
    createLayer('l1');
    createFeature(polygon('f1', 'l1'));
    registerCompanion(['f1']);

    expect(createTester(false)(CENTER)?.kind).toBe('store');
  });

  it('picks up the companions of a feature whose own test failed', () => {
    createLayer('l1');
    createFeature(awayPolygon('f1', 'l1'));
    registerCompanion(['f1']);

    const top = createTester(false)(CENTER);

    expect(top?.kind).toBe('companion');
    expect(top?.kind === 'companion' && top.companion).toEqual({
      providerId: 'p1',
      featureId: 'f1',
      hit: { id: 'companion-of-p1' },
    });
  });

  it('companions of a front feature beat the feature behind it (they sit one z below)', () => {
    createLayer('back');
    createLayer('front');
    createFeature(polygon('back-f', 'back'));
    createFeature(awayPolygon('front-f', 'front'));
    store.setLayerOrder(['back', 'front']);
    registerCompanion(['front-f']);

    expect(createTester(false)(CENTER)?.kind).toBe('companion');
  });

  it('lets the companions of a feature behind lose to the feature in front of it', () => {
    createLayer('back');
    createLayer('front');
    createFeature(awayPolygon('back-f', 'back'));
    createFeature(polygon('front-f', 'front'));
    store.setLayerOrder(['back', 'front']);
    registerCompanion(['back-f']);

    expect(createTester(false)(CENTER)).toEqual({
      kind: 'store',
      feature: store.getFeature('front-f'),
    });
  });

  it('picks them up in the same order on the path with datasets (stacking order)', () => {
    createLayer('l1');
    createFeature(awayPolygon('f1', 'l1'));
    addDataset('below', 'below-store');
    registerCompanion(['f1']);

    expect(createTester()(CENTER)?.kind).toBe('companion');
  });

  it('lets a dataset in front win over the companions', () => {
    createLayer('l1');
    createFeature(awayPolygon('f1', 'l1'));
    addDataset('above', 'above-store');
    registerCompanion(['f1']);

    expect(createTester()(CENTER)?.kind).toBe('dataset');
  });

  it('does not ask for the companions of a feature on a hidden layer', () => {
    store.createLayer({
      id: 'l1',
      name: 'l1',
      visible: false,
      locked: false,
      opacity: 1,
      order: [],
    });
    createFeature(awayPolygon('f1', 'l1'));
    const hitTest = vi.fn(() => ({ id: 'c1' }));
    companions.register({
      id: 'p1',
      has: () => true,
      draw: () => {},
      hitTest,
      onCompanionClick: () => {},
    });

    expect(createTester(false)(CENTER)).toBeNull();
    expect(hitTest).not.toHaveBeenCalled();
  });

  it('does not perform the companion hits when no projection was passed in', () => {
    createLayer('l1');
    createFeature(awayPolygon('f1', 'l1'));
    const hitTest = vi.fn(() => ({ id: 'c1' }));
    companions.register({
      id: 'p1',
      has: () => true,
      draw: () => {},
      hitTest,
      onCompanionClick: () => {},
    });

    const tester = createTopmostHitTester({
      store,
      hitTestService: service,
      unproject,
      toleranceLngLat: () => 0.5,
    });

    expect(tester(CENTER)).toBeNull();
    expect(hitTest).not.toHaveBeenCalled();
  });

  it('passes the test point in screen px, the zoom and the tolerance to hitTest', () => {
    createLayer('l1');
    createFeature(awayPolygon('f1', 'l1'));
    const hitTest = vi.fn<FeatureCompanionProvider['hitTest']>(() => null);
    companions.register({
      id: 'p1',
      has: () => true,
      draw: () => {},
      hitTest,
      onCompanionClick: () => {},
    });

    createTester(false)(CENTER);

    expect(hitTest).toHaveBeenCalledTimes(1);
    const [feature, point, context] = hitTest.mock.calls[0];
    expect(feature.id).toBe('f1');
    expect(point).toEqual(CENTER);
    expect(context.zoom).toBe(10);
    expect(context.tolerancePx).toBe(5);
    expect(context.project([1, 2])).toEqual({ x: 10, y: -20 });
    expect(context.unproject({ x: 10, y: -20 })).toEqual({ lng: 1, lat: 2 });
  });
});
