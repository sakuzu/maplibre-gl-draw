// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for the manager of the datasets
 *
 * They verify the draw order (below-store / above-store and the order of addition) and the
 * front-to-back relations of the hit testing.
 */

import type { ProjectionData } from 'maplibre-gl';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_FEATURE_STYLE_CONFIG } from '../shared/config/feature-style.js';
import type { BoundingBox, Coordinate, Feature } from '../store/types.js';
import { FeatureDrawer } from '../view/renderers/drawer.js';
import type { ImageRenderer } from '../view/renderers/image.js';
import type { RetainedLineBatch } from '../view/renderers/line/line-types.js';
import type { SDFLineRenderer } from '../view/renderers/line/sdf-line.js';
import type { RetainedPointBatch } from '../view/renderers/point/point-instance.js';
import type { PointShapeRenderer } from '../view/renderers/point/point-shape.js';
import type { RetainedPolygonBatch } from '../view/renderers/polygon/sdf-polygon.js';
import type { RetainedRendererSet } from '../view/renderers/retained.js';
import type { DisplayBatchTarget } from './dataset.js';
import { createDatasetManager, type DatasetManager } from './manager.js';
import type { TriangulationScheduler } from './triangulation.js';
import type { DatasetFeatureInput } from './types.js';

const WORLD: BoundingBox = { minX: -180, minY: -85, maxX: 180, maxY: 85 };

function createManager(): DatasetManager {
  return createDatasetManager({
    getViewportBounds: () => WORLD,
    getZoom: () => 10,
    onViewportChange: () => () => {},
    requestRepaint: () => {},
  });
}

/** A stub that records the feature ids in the order they were pushed onto the batch */
function createBatchTarget(): { target: DisplayBatchTarget; log: string[] } {
  const log: string[] = [];
  const target: DisplayBatchTarget = {
    beginFrame: (): void => {},
    processFeature: (feature: Feature): boolean => {
      log.push(feature.id);
      return false;
    },
    endFrame: (): void => {},
  };
  return { target, log };
}

function point(id: string, coord: [number, number] = [0, 0]): DatasetFeatureInput {
  return { id, type: 'Point', coordinates: coord };
}

/** A simple test that counts a matching coordinate as a hit */
const exactHit = (feature: Feature, coordinate: Coordinate): boolean => {
  const coord = feature.coordinates as Coordinate;
  return coord[0] === coordinate[0] && coord[1] === coordinate[1];
};

describe('the draw order of DatasetManager', () => {
  it('it draws each order separately', () => {
    const manager = createManager();
    manager.add({ id: 'below', features: [point('b1')], order: 'below-store' });
    manager.add({ id: 'above', features: [point('a1')], order: 'above-store' });

    const belowTarget = createBatchTarget();
    manager.draw('below-store', belowTarget.target, {} as ProjectionData, 10);
    const aboveTarget = createBatchTarget();
    manager.draw('above-store', aboveTarget.target, {} as ProjectionData, 10);

    expect(belowTarget.log).toEqual(['b1']);
    expect(aboveTarget.log).toEqual(['a1']);
  });

  it('the default of order is below-store', () => {
    const manager = createManager();
    const dataset = manager.add({ id: 'c1', features: [point('a')] });

    expect(dataset.order).toBe('below-store');

    const above = createBatchTarget();
    manager.draw('above-store', above.target, {} as ProjectionData, 10);
    expect(above.log).toEqual([]);
  });

  it('datasets with the same order are drawn in the order they were added', () => {
    const manager = createManager();
    manager.add({ id: 'first', features: [point('f')] });
    manager.add({ id: 'second', features: [point('s')] });
    manager.add({ id: 'third', features: [point('t')] });

    const { target, log } = createBatchTarget();
    manager.draw('below-store', target, {} as ProjectionData, 10);

    expect(log).toEqual(['f', 's', 't']);
  });

  it('the viewport is not looked up when there is no dataset', () => {
    const getViewportBounds = vi.fn(() => WORLD);
    const manager = createDatasetManager({
      getViewportBounds,
      getZoom: () => 10,
      onViewportChange: () => () => {},
      requestRepaint: () => {},
    });

    const { target } = createBatchTarget();
    manager.draw('below-store', target, {} as ProjectionData, 10);

    expect(getViewportBounds).not.toHaveBeenCalled();
  });
});

describe('the hit testing of DatasetManager', () => {
  /** Looks from the front across the sides (above-store → below-store) */
  function hitTest(manager: DatasetManager) {
    return (
      manager.hitTestSide('above-store', [1, 1], 0.1, exactHit) ??
      manager.hitTestSide('below-store', [1, 1], 0.1, exactHit)
    );
  }

  it('a dataset that is not interactive blocks too (feature is null)', () => {
    const manager = createManager();
    manager.add({ id: 'c1', features: [point('a', [1, 1])] });

    const hit = hitTest(manager);
    expect(hit?.dataset.id).toBe('c1');
    expect(hit?.feature).toBeNull();
  });

  it('it returns the feature of an interactive dataset', () => {
    const manager = createManager();
    manager.add({ id: 'c1', features: [point('a', [1, 1])], interactive: true });

    expect(manager.hasAny()).toBe(true);
    const hit = hitTest(manager);
    expect(hit?.feature?.id).toBe('a');
    expect(hit?.dataset.id).toBe('c1');
  });

  it('above-store takes precedence over below-store', () => {
    const manager = createManager();
    manager.add({
      id: 'above',
      features: [point('a', [1, 1])],
      interactive: true,
      order: 'above-store',
    });
    manager.add({ id: 'below', features: [point('b', [1, 1])], interactive: true });

    expect(hitTest(manager)?.feature?.id).toBe('a');
  });

  it('within the same order, the one added later takes precedence', () => {
    const manager = createManager();
    manager.add({ id: 'c1', features: [point('old', [1, 1])], interactive: true });
    manager.add({ id: 'c2', features: [point('new', [1, 1])], interactive: true });

    expect(hitTest(manager)?.feature?.id).toBe('new');
  });

  it('within a dataset, the back of the draw order (the front) takes precedence', () => {
    const manager = createManager();
    manager.add({
      id: 'c1',
      features: [point('back', [1, 1]), point('front', [1, 1])],
      interactive: true,
    });

    expect(hitTest(manager)?.feature?.id).toBe('front');
  });

  it('removing it stops it from being hit', () => {
    const manager = createManager();
    manager.add({ id: 'c1', features: [point('a', [1, 1])], interactive: true });

    manager.remove('c1');

    expect(manager.hasAny()).toBe(false);
    expect(hitTest(manager)).toBeNull();
  });

  it('a feature outside the tolerance is not a candidate', () => {
    const manager = createManager();
    const test = vi.fn(() => true);
    manager.add({ id: 'c1', features: [point('far', [50, 50])], interactive: true });

    expect(manager.hitTestSide('below-store', [1, 1], 0.1, test)).toBeNull();
    // It is dropped by the spatial index, so the precise test is not called
    expect(test).not.toHaveBeenCalled();
  });

  it('it returns the feature carrying the color of the style rule', () => {
    const manager = createManager();
    manager.add({
      id: 'c1',
      features: [point('a', [1, 1])],
      interactive: true,
      styleRule: { kind: 'single', color: '#ff0000' },
    });

    expect(hitTest(manager)?.feature?.style?.pointColor).toBe('#ff0000');
  });

  it('hasAny does not count hidden datasets', () => {
    const manager = createManager();
    const dataset = manager.add({ id: 'c1', features: [point('a', [1, 1])] });

    expect(manager.hasAny()).toBe(true);
    dataset.setVisible(false);
    expect(manager.hasAny()).toBe(false);
  });
});

describe('the stacking order of DatasetManager (layer-order)', () => {
  it('a layer-order dataset is not drawn by the drawing of a side', () => {
    const manager = createManager();
    manager.add({ id: 'entry', features: [point('e')], order: 'layer-order' });
    manager.add({ id: 'below', features: [point('b')] });
    manager.add({ id: 'above', features: [point('a')], order: 'above-store' });

    const below = createBatchTarget();
    manager.draw('below-store', below.target, {} as ProjectionData, 10);
    const above = createBatchTarget();
    manager.draw('above-store', above.target, {} as ProjectionData, 10);

    expect(below.log).toEqual(['b']);
    expect(above.log).toEqual(['a']);
  });

  it('drawOne draws only the layer-order datasets', () => {
    const manager = createManager();
    manager.add({ id: 'entry', features: [point('e')], order: 'layer-order' });
    manager.add({ id: 'below', features: [point('b')] });

    const { target, log } = createBatchTarget();
    expect(manager.drawOne('entry', target, {} as ProjectionData, 10)).toBe(true);
    expect(manager.drawOne('below', target, {} as ProjectionData, 10)).toBe(false);
    expect(manager.drawOne('missing', target, {} as ProjectionData, 10)).toBe(false);

    expect(log).toEqual(['e']);
  });

  it('hitTestEntry looks only at the layer-order datasets', () => {
    const manager = createManager();
    manager.add({
      id: 'entry',
      features: [point('e', [1, 1])],
      interactive: true,
      order: 'layer-order',
    });
    manager.add({ id: 'below', features: [point('b', [1, 1])], interactive: true });

    expect(manager.hitTestEntry('entry', [1, 1], 0.1, exactHit)?.feature?.id).toBe('e');
    expect(manager.hitTestEntry('below', [1, 1], 0.1, exactHit)).toBeNull();
    expect(manager.hitTestEntry('missing', [1, 1], 0.1, exactHit)).toBeNull();
  });

  it('the scan of a side does not include layer-order', () => {
    const manager = createManager();
    manager.add({
      id: 'entry',
      features: [point('e', [1, 1])],
      interactive: true,
      order: 'layer-order',
    });

    expect(manager.hitTestSide('below-store', [1, 1], 0.1, exactHit)).toBeNull();
    expect(manager.hitTestSide('above-store', [1, 1], 0.1, exactHit)).toBeNull();
  });

  it('move can put it on the order and take it off again', () => {
    const manager = createManager();
    const dataset = manager.add({ id: 'c1', features: [point('a')] });

    expect(manager.move('c1', { order: 'layer-order' })).toBe(true);
    expect(dataset.order).toBe('layer-order');
    const inList = createBatchTarget();
    manager.draw('below-store', inList.target, {} as ProjectionData, 10);
    expect(inList.log).toEqual([]);
    expect(manager.drawOne('c1', createBatchTarget().target, {} as ProjectionData, 10)).toBe(true);

    manager.move('c1', { order: 'below-store' });
    expect(dataset.order).toBe('below-store');
    const back = createBatchTarget();
    manager.draw('below-store', back.target, {} as ProjectionData, 10);
    expect(back.log).toEqual(['a']);
  });

  it('the order of the sides does not break with a dataset of the order mixed in', () => {
    const manager = createManager();
    manager.add({ id: 'b1', features: [point('b1')] });
    manager.add({ id: 'e1', features: [point('e1')], order: 'layer-order' });
    manager.add({ id: 'b2', features: [point('b2')] });
    manager.add({ id: 'a1', features: [point('a1')], order: 'above-store' });
    manager.add({ id: 'e2', features: [point('e2')], order: 'layer-order' });
    manager.add({ id: 'a2', features: [point('a2')], order: 'above-store' });

    const below = createBatchTarget();
    manager.draw('below-store', below.target, {} as ProjectionData, 10);
    const above = createBatchTarget();
    manager.draw('above-store', above.target, {} as ProjectionData, 10);

    expect(below.log).toEqual(['b1', 'b2']);
    expect(above.log).toEqual(['a1', 'a2']);
    expect(manager.list().map((c) => c.id)).toEqual(['b1', 'b2', 'e1', 'e2', 'a1', 'a2']);
  });
});

describe('the lifecycle of DatasetManager', () => {
  it('the displayed range is subscribed to only while a dataset has a provider', () => {
    let subscribed = 0;
    const manager = createDatasetManager({
      getViewportBounds: () => WORLD,
      getZoom: () => 10,
      onViewportChange: () => {
        subscribed++;
        return () => {
          subscribed--;
        };
      },
      requestRepaint: () => {},
    });

    manager.add({ id: 'static', features: [point('a')] });
    expect(subscribed).toBe(0);

    manager.add({ id: 'dynamic', provider: async () => [] });
    expect(subscribed).toBe(1);

    manager.remove('dynamic');
    expect(subscribed).toBe(0);
  });

  it('destroy disposes every dataset', () => {
    const manager = createManager();
    manager.add({ id: 'c1', features: [point('a')] });
    manager.add({ id: 'c2', features: [point('b')], interactive: true });

    manager.destroy();

    expect(manager.list()).toEqual([]);
    expect(manager.hasAny()).toBe(false);
    const { target, log } = createBatchTarget();
    manager.draw('below-store', target, {} as ProjectionData, 10);
    expect(log).toEqual([]);
  });

  it('list returns the display order (from the back to the front)', () => {
    const manager = createManager();
    manager.add({ id: 'a', features: [] });
    manager.add({ id: 'b', features: [] });

    expect(manager.list().map((c) => c.id)).toEqual(['a', 'b']);
  });

  it('list returns the below-store group and then the above-store group', () => {
    const manager = createManager();
    manager.add({ id: 'above1', features: [], order: 'above-store' });
    manager.add({ id: 'below1', features: [] });
    manager.add({ id: 'above2', features: [], order: 'above-store' });
    manager.add({ id: 'below2', features: [] });

    // Regardless of the order of addition, they go from the back (the head of below) to the
    // front (the tail of above)
    expect(manager.list().map((c) => c.id)).toEqual(['below1', 'below2', 'above1', 'above2']);
  });

  it('a dataset removed from list drops out', () => {
    const manager = createManager();
    manager.add({ id: 'a', features: [] });
    manager.add({ id: 'b', features: [] });
    manager.add({ id: 'c', features: [] });

    manager.remove('b');

    expect(manager.list().map((x) => x.id)).toEqual(['a', 'c']);
  });
});

describe('the reordering of DatasetManager', () => {
  /** Takes the draw order of the below-store side and of the above-store side */
  function drawnIds(manager: DatasetManager): { below: string[]; above: string[] } {
    const below = createBatchTarget();
    manager.draw('below-store', below.target, {} as ProjectionData, 10);
    const above = createBatchTarget();
    manager.draw('above-store', above.target, {} as ProjectionData, 10);
    return { below: below.log, above: above.log };
  }

  it('an id that does not exist returns false', () => {
    const manager = createManager();

    expect(manager.move('missing', { order: 'above-store' })).toBe(false);
  });

  it('order changes the side and the order property follows it', () => {
    const manager = createManager();
    const dataset = manager.add({ id: 'c1', features: [point('a')] });

    expect(dataset.order).toBe('below-store');
    expect(manager.move('c1', { order: 'above-store' })).toBe(true);

    expect(dataset.order).toBe('above-store');
    expect(drawnIds(manager)).toEqual({ below: [], above: ['a'] });
  });

  it('it can go to the other side and back again', () => {
    const manager = createManager();
    const dataset = manager.add({ id: 'c1', features: [point('a')] });

    manager.move('c1', { order: 'above-store' });
    manager.move('c1', { order: 'below-store' });

    expect(dataset.order).toBe('below-store');
    expect(drawnIds(manager)).toEqual({ below: ['a'], above: [] });
  });

  it('giving only the side puts it at the front of the destination', () => {
    const manager = createManager();
    manager.add({ id: 'a1', features: [point('a1')], order: 'above-store' });
    manager.add({ id: 'a2', features: [point('a2')], order: 'above-store' });
    manager.add({ id: 'b1', features: [point('b1')] });

    manager.move('b1', { order: 'above-store' });

    expect(drawnIds(manager).above).toEqual(['a1', 'a2', 'b1']);
  });

  it('index changes the position within the same side (0 is the backmost)', () => {
    const manager = createManager();
    manager.add({ id: 'c1', features: [point('a')] });
    manager.add({ id: 'c2', features: [point('b')] });
    manager.add({ id: 'c3', features: [point('c')] });

    manager.move('c3', { index: 0 });

    expect(drawnIds(manager).below).toEqual(['c', 'a', 'b']);
    expect(manager.list().map((x) => x.id)).toEqual(['c3', 'c1', 'c2']);
  });

  it('omitting index keeps the position within the same side', () => {
    const manager = createManager();
    manager.add({ id: 'c1', features: [point('a')] });
    manager.add({ id: 'c2', features: [point('b')] });
    manager.add({ id: 'c3', features: [point('c')] });

    manager.move('c2', {});
    manager.move('c2', { order: 'below-store' });

    expect(drawnIds(manager).below).toEqual(['a', 'b', 'c']);
  });

  it('an out-of-range index is clamped', () => {
    const manager = createManager();
    manager.add({ id: 'c1', features: [point('a')] });
    manager.add({ id: 'c2', features: [point('b')] });
    manager.add({ id: 'c3', features: [point('c')] });

    manager.move('c1', { index: 99 });
    expect(drawnIds(manager).below).toEqual(['b', 'c', 'a']);

    manager.move('c1', { index: -5 });
    expect(drawnIds(manager).below).toEqual(['a', 'b', 'c']);
  });

  it('the side and index can be given together', () => {
    const manager = createManager();
    manager.add({ id: 'a1', features: [point('a1')], order: 'above-store' });
    manager.add({ id: 'a2', features: [point('a2')], order: 'above-store' });
    manager.add({ id: 'b1', features: [point('b1')] });

    manager.move('b1', { order: 'above-store', index: 1 });

    expect(drawnIds(manager)).toEqual({ below: [], above: ['a1', 'b1', 'a2'] });
    expect(manager.list().map((x) => x.id)).toEqual(['a1', 'b1', 'a2']);
  });

  it('the precedence of the hit testing follows the reordering', () => {
    const manager = createManager();
    manager.add({ id: 'c1', features: [point('a', [1, 1])], interactive: true });
    manager.add({ id: 'c2', features: [point('b', [1, 1])], interactive: true });
    const topmost = () =>
      manager.hitTestSide('above-store', [1, 1], 0.1, exactHit) ??
      manager.hitTestSide('below-store', [1, 1], 0.1, exactHit);

    expect(topmost()?.feature?.id).toBe('b');

    // Bringing it to the front within the same side makes it win
    manager.move('c1', { index: 1 });
    expect(topmost()?.feature?.id).toBe('a');

    // Raising the side makes it win regardless of the order within a side
    manager.move('c2', { order: 'above-store' });
    expect(topmost()?.feature?.id).toBe('b');

    // Lowering it again brings the precedence back
    manager.move('c2', { order: 'below-store', index: 0 });
    expect(topmost()?.feature?.id).toBe('a');
  });

  it('the visibility is not affected by the reordering', () => {
    const manager = createManager();
    const dataset = manager.add({
      id: 'c1',
      features: [point('a', [1, 1])],
      interactive: true,
    });
    dataset.setVisible(false);

    manager.move('c1', { order: 'above-store' });

    expect(dataset.visible).toBe(false);
    expect(drawnIds(manager)).toEqual({ below: [], above: [] });
    expect(manager.hitTestSide('above-store', [1, 1], 0.1, exactHit)).toBeNull();

    dataset.setVisible(true);
    expect(drawnIds(manager).above).toEqual(['a']);
  });

  it('the features held and interactive do not change', () => {
    const manager = createManager();
    const dataset = manager.add({ id: 'c1', features: [point('a')], interactive: true });
    const before = dataset.getFeatures();

    manager.move('c1', { order: 'above-store', index: 0 });

    expect(dataset.getFeatures()).toBe(before);
    expect(dataset.interactive).toBe(true);
    expect(manager.hasAny()).toBe(true);
  });

  it('the reordering requests a repaint', () => {
    const requestRepaint = vi.fn();
    const manager = createDatasetManager({
      getViewportBounds: () => WORLD,
      getZoom: () => 10,
      onViewportChange: () => () => {},
      requestRepaint,
    });
    manager.add({ id: 'c1', features: [point('a')] });
    requestRepaint.mockClear();

    manager.move('c1', { order: 'above-store' });

    expect(requestRepaint).toHaveBeenCalled();
  });

  it('the subscription of a provider does not change with the reordering', () => {
    let subscribed = 0;
    const manager = createDatasetManager({
      getViewportBounds: () => WORLD,
      getZoom: () => 10,
      onViewportChange: () => {
        subscribed++;
        return () => {
          subscribed--;
        };
      },
      requestRepaint: () => {},
    });
    manager.add({ id: 'dynamic', provider: async () => [] });

    manager.move('dynamic', { order: 'above-store' });

    expect(subscribed).toBe(1);
  });
});

describe('a destroyed DatasetManager', () => {
  it('refuses to add a dataset, which nothing would release', () => {
    const manager = createManager();
    manager.destroy();
    expect(() => manager.add({ id: 'late', features: [point('a')] })).toThrow(/destroyed/);
    expect(manager.list()).toHaveLength(0);
  });
});

describe('the add and remove notifications of DatasetManager', () => {
  function createNotifyingManager() {
    const log: string[] = [];
    const manager = createDatasetManager({
      getViewportBounds: () => WORLD,
      getZoom: () => 10,
      onViewportChange: () => () => {},
      requestRepaint: () => {},
      onDatasetAdd: (id) => {
        // The dataset is already listed when the notification arrives
        log.push(`add ${id} ${manager.get(id) === undefined ? 'missing' : 'listed'}`);
      },
      onDatasetRemove: (id) => {
        // ... and no longer listed when the removal arrives
        log.push(`remove ${id} ${manager.get(id) === undefined ? 'gone' : 'listed'}`);
      },
    });
    return { manager, log };
  }

  it('notifies an addition once the dataset is listed', () => {
    const { manager, log } = createNotifyingManager();
    manager.add({ id: 'a', features: [point('p')] });
    manager.add({ id: 'b', provider: async () => [] });

    expect(log).toEqual(['add a listed', 'add b listed']);
  });

  it('notifies a removal by the manager and by the dataset itself, once each', () => {
    const { manager, log } = createNotifyingManager();
    const a = manager.add({ id: 'a', features: [] });
    manager.add({ id: 'b', features: [] });
    log.length = 0;

    manager.remove('b');
    a.remove();
    a.remove();
    manager.remove('b');
    manager.remove('missing');

    expect(log).toEqual(['remove b gone', 'remove a gone']);
  });

  it('notifies neither a refused addition, a move nor a destroy', () => {
    const { manager, log } = createNotifyingManager();
    manager.add({ id: 'a', features: [] });
    log.length = 0;

    expect(() => manager.add({ id: 'a', features: [] })).toThrow();
    manager.move('a', { order: 'above-store' });
    manager.destroy();

    expect(log).toEqual([]);
  });

  it('notifies a dataset rebuilt under the same id as a removal and then an addition', () => {
    const { manager, log } = createNotifyingManager();
    const first = manager.add({ id: 'a', features: [] });
    manager.remove('a');
    const second = manager.add({ id: 'a', features: [] });

    expect(second).not.toBe(first);
    expect(log).toEqual(['add a listed', 'remove a gone', 'add a listed']);
  });
});

describe('the reorder notification of DatasetManager', () => {
  function createReorderingManager() {
    const orders: string[][] = [];
    const manager = createDatasetManager({
      getViewportBounds: () => WORLD,
      getZoom: () => 10,
      onViewportChange: () => () => {},
      requestRepaint: () => {},
      onDatasetsReorder: (order) => {
        // The list already reflects the move when the notification arrives
        expect(manager.list().map((c) => c.id)).toEqual(order);
        orders.push(order);
      },
    });
    manager.add({ id: 'a', features: [] });
    manager.add({ id: 'b', features: [] });
    manager.add({ id: 'c', features: [] });
    return { manager, orders };
  }

  it('notifies a move within the side with the new order', () => {
    const { manager, orders } = createReorderingManager();

    manager.move('c', { index: 0 });
    manager.move('c', { index: 99 });

    expect(orders).toEqual([
      ['c', 'a', 'b'],
      ['a', 'b', 'c'],
    ]);
  });

  it('notifies a change of side even when the list keeps its sequence', () => {
    const { manager, orders } = createReorderingManager();

    // c is already the last, so the list reads the same, but it now draws above the Store
    manager.move('c', { order: 'above-store' });

    expect(manager.get('c')?.order).toBe('above-store');
    expect(orders).toEqual([['a', 'b', 'c']]);
  });

  it('notifies nothing for a move that leaves everything where it was', () => {
    const { manager, orders } = createReorderingManager();

    manager.move('b', {});
    manager.move('b', { index: 1 });
    manager.move('c', { index: 5 });
    manager.move('a', { order: 'below-store', index: 0 });
    manager.move('missing', { index: 0 });

    expect(orders).toEqual([]);
  });

  it('notifies neither an addition nor a removal', () => {
    const { manager, orders } = createReorderingManager();

    manager.add({ id: 'd', features: [] });
    manager.remove('a');

    expect(orders).toEqual([]);
  });
});

describe('the pending work of DatasetManager', () => {
  /** Renderers without GPU resources (every build succeeds) */
  function createRenderers(): RetainedRendererSet {
    return {
      polygon: {
        buildRetained: () => ({}) as RetainedPolygonBatch,
        drawRetained: (): void => {},
        disposeRetained: (): void => {},
      },
      line: {
        buildRetainedBatch: () => ({}) as RetainedLineBatch,
        drawRetainedBatch: (): void => {},
        disposeRetainedBatch: (): void => {},
      },
      point: {
        buildRetained: () => ({}) as RetainedPointBatch,
        drawRetained: (): void => {},
        disposeRetained: (): void => {},
      },
      styles: new FeatureDrawer({
        gl: {
          createBuffer: (): object => ({}),
          createVertexArray: (): object => ({}),
          bindBuffer: (): void => {},
          bindVertexArray: (): void => {},
          enableVertexAttribArray: (): void => {},
          vertexAttribPointer: (): void => {},
        } as unknown as WebGL2RenderingContext,
        map: {} as never,
        sdfLineRenderer: {} as SDFLineRenderer,
        pointShapeRenderer: {} as PointShapeRenderer,
        imageRenderer: {} as ImageRenderer,
        featureStyle: DEFAULT_FEATURE_STYLE_CONFIG,
      }),
      viewport: (): [number, number] => [1920, 1080],
    };
  }

  /** Points spread so that they fall into several chunks */
  const SPREAD = Array.from({ length: 400 }, (_, i) => point(`p${i}`, [i * 0.1, (i % 20) * 0.1]));

  /** Draws one frame into retained renderers */
  function drawFrame(manager: DatasetManager, renderers: RetainedRendererSet): void {
    const target: DisplayBatchTarget = {
      ...createBatchTarget().target,
      getRetainedRenderers: () => renderers,
    };
    manager.beginFrame(10);
    manager.draw('below-store', target, {} as ProjectionData, 10);
  }

  function managerWith(options: Partial<Parameters<typeof createDatasetManager>[0]> = {}) {
    return createDatasetManager({
      getViewportBounds: () => WORLD,
      getZoom: () => 10,
      onViewportChange: () => () => {},
      requestRepaint: () => {},
      ...options,
    });
  }

  it('the chunks a frame left unbuilt are pending, until a frame builds them', () => {
    // Every look at the clock is past the budget: one chunk per frame
    let clock = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => (clock += 100));
    try {
      const manager = managerWith();
      const renderers = createRenderers();
      manager.add({ id: 'c1', features: SPREAD });

      drawFrame(manager, renderers);
      expect(manager.hasPendingWork()).toBe(true);
      for (let frame = 0; frame < 20 && manager.hasPendingWork(); frame++) {
        drawFrame(manager, renderers);
      }
      expect(manager.hasPendingWork()).toBe(false);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('a dataset that is not drawn has no pending work', () => {
    let clock = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => (clock += 100));
    try {
      const manager = managerWith();
      const renderers = createRenderers();
      const dataset = manager.add({ id: 'c1', features: SPREAD });
      drawFrame(manager, renderers);
      expect(manager.hasPendingWork()).toBe(true);

      dataset.setVisible(false);
      expect(manager.hasPendingWork()).toBe(false);

      // A frame that does not draw it (another side) leaves nothing of it pending either
      dataset.setVisible(true);
      manager.move('c1', { order: 'above-store' });
      manager.beginFrame(10);
      expect(manager.hasPendingWork()).toBe(false);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('without time slicing a frame builds every chunk in view', () => {
    let clock = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => (clock += 100));
    try {
      const manager = managerWith({ timeSlicing: false });
      manager.add({ id: 'c1', features: SPREAD });
      drawFrame(manager, createRenderers());
      expect(manager.hasPendingWork()).toBe(false);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('a huge polygon being triangulated is pending', () => {
    const scheduler = { pendingCount: 1 } as TriangulationScheduler;
    const manager = managerWith({ triangulationScheduler: scheduler });
    expect(manager.hasPendingWork()).toBe(true);
  });

  it('a provider call waiting for its debounce or its response is pending', async () => {
    vi.useFakeTimers();
    try {
      let resolve: (features: DatasetFeatureInput[]) => void = () => {};
      const manager = managerWith({ providerDebounceMs: 50 });
      manager.add({
        id: 'c1',
        provider: () =>
          new Promise((done) => {
            resolve = done;
          }),
      });
      expect(manager.hasPendingWork()).toBe(true);

      vi.advanceTimersByTime(50);
      // The response has not arrived
      expect(manager.hasPendingWork()).toBe(true);

      resolve([point('a')]);
      await vi.runAllTimersAsync();
      expect(manager.hasPendingWork()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
