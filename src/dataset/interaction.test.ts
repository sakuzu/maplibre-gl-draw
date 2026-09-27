// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for the hit test interception
 *
 * They verify the firing of click / hover and the dispatching decided by the result of the
 * unified z scan (nothing is dispatched when a feature of the Store is in front; a dataset
 * that only blocks fires nothing). The order of the scan itself is verified in
 * dispatcher/hit-test/topmost.test.ts.
 */

import { describe, expect, it, vi } from 'vitest';
import type { TopHit } from '../dispatcher/hit-test/topmost.js';
import type { MouseNormalizedEvent } from '../dispatcher/types.js';
import { coordinatesOf } from '../shared/utils/coordinates.js';
import type { BoundingBox, Coordinate, Feature } from '../store/types.js';
import { toRow } from '../test-utils.js';
import { createDisplayInteractions, type DisplayInteractions } from './interaction.js';
import { createDatasetManager, type DatasetManager } from './manager.js';
import type {
  DatasetClickEventPayload,
  DatasetClickPayload,
  DatasetHoverPayload,
  DatasetRow,
} from './types.js';

const WORLD: BoundingBox = { minX: -180, minY: -85, maxX: 180, maxY: 85 };

function point(id: string, coord: [number, number]): DatasetRow {
  return toRow({ id, type: 'Point', coordinates: coord });
}

function mouseEvent(lng: number, lat: number): MouseNormalizedEvent {
  return {
    type: 'click',
    point: { x: 100, y: 100 },
    lngLat: { lng, lat },
    originalEvent: {} as MouseEvent,
    modifiers: { shift: false, ctrl: false, alt: false, meta: false },
  };
}

/** A simple test that counts a matching coordinate as a hit */
const exactHit = (feature: Feature, coordinate: Coordinate): boolean => {
  const coord = coordinatesOf(feature) as Coordinate;
  return coord[0] === coordinate[0] && coord[1] === coordinate[1];
};

/** The hit returned when a feature of the Store is in front */
const STORE_FEATURE: Feature = {
  id: 'store-1',
  type: 'Point',
  geometry: { type: 'Point', coordinates: [0, 0] },
  layerId: 'l1',
  properties: {},
  locked: false,
  visible: true,
  style: {},
};

function setup(): {
  manager: DatasetManager;
  interactions: DisplayInteractions;
  setStoreHit: (value: boolean) => void;
  topmostCalls: () => number;
} {
  const manager = createDatasetManager({
    getViewportBounds: () => WORLD,
    getZoom: () => 10,
    onViewportChange: () => () => {},
    requestRepaint: () => {},
  });

  let storeHit = false;
  let topmostCalls = 0;

  // A reduced version of the unified z scan. It returns store when a feature of the Store is in
  // front, and otherwise the datasets from the front (above-store → below-store).
  const interactions = createDisplayInteractions({
    manager,
    hitTestTopmost: (event): TopHit | null => {
      topmostCalls++;
      if (storeHit) return { kind: 'store', feature: STORE_FEATURE };

      const coordinate: Coordinate = [event.lngLat.lng, event.lngLat.lat];
      const hit =
        manager.hitTestSide('above-store', coordinate, 0.1, exactHit) ??
        manager.hitTestSide('below-store', coordinate, 0.1, exactHit);
      return hit
        ? { kind: 'dataset', dataset: hit.dataset, feature: hit.feature, row: hit.row }
        : null;
    },
  });

  return {
    manager,
    interactions,
    setStoreHit: (value: boolean) => {
      storeHit = value;
    },
    topmostCalls: () => topmostCalls,
  };
}

describe('the click of a dataset', () => {
  it('it fires for a feature of an interactive dataset', () => {
    const { manager, interactions } = setup();
    const dataset = manager.add({
      id: 'c1',
      rows: [point('a', [1, 1])],
      interactive: true,
    });
    const handler = vi.fn<(payload: DatasetClickPayload) => void>();
    dataset.on('click', handler);

    interactions.handleClick(mouseEvent(1, 1));

    expect(handler).toHaveBeenCalledTimes(1);
    const payload = handler.mock.calls[0][0];
    expect(payload.datasetId).toBe('c1');
    expect(payload.feature.id).toBe('a');
    expect(payload.lngLat).toEqual([1, 1]);
  });

  it('a non-interactive one only blocks and fires nothing', () => {
    const { manager, interactions } = setup();
    const dataset = manager.add({ id: 'c1', rows: [point('a', [1, 1])] });
    const handler = vi.fn();
    dataset.on('click', handler);

    interactions.handleClick(mouseEvent(1, 1));

    expect(handler).not.toHaveBeenCalled();
  });

  it('nothing is scanned when there is not a single dataset', () => {
    const { interactions, topmostCalls } = setup();

    interactions.handleClick(mouseEvent(1, 1));
    interactions.handleMouseMove(mouseEvent(1, 1));

    expect(topmostCalls()).toBe(0);
  });

  it('nothing fires when a feature of the Store is in front', () => {
    const { manager, interactions, setStoreHit } = setup();
    const dataset = manager.add({
      id: 'c1',
      rows: [point('a', [1, 1])],
      interactive: true,
    });
    const handler = vi.fn();
    dataset.on('click', handler);

    setStoreHit(true);
    interactions.handleClick(mouseEvent(1, 1));
    expect(handler).not.toHaveBeenCalled();

    setStoreHit(false);
    interactions.handleClick(mouseEvent(1, 1));
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('nothing fires when nothing at all is hit', () => {
    const { manager, interactions } = setup();
    const dataset = manager.add({
      id: 'c1',
      rows: [point('a', [1, 1])],
      interactive: true,
    });
    const handler = vi.fn();
    dataset.on('click', handler);

    interactions.handleClick(mouseEvent(50, 50));

    expect(handler).not.toHaveBeenCalled();
  });

  it('the return value of on cancels the subscription', () => {
    const { manager, interactions } = setup();
    const dataset = manager.add({
      id: 'c1',
      rows: [point('a', [1, 1])],
      interactive: true,
    });
    const handler = vi.fn();
    const unsubscribe = dataset.on('click', handler);

    unsubscribe();
    interactions.handleClick(mouseEvent(1, 1));

    expect(handler).not.toHaveBeenCalled();
  });

  it('off cancels the subscription too', () => {
    const { manager, interactions } = setup();
    const dataset = manager.add({
      id: 'c1',
      rows: [point('a', [1, 1])],
      interactive: true,
    });
    const handler = vi.fn();
    dataset.on('click', handler);
    dataset.off('click', handler);

    interactions.handleClick(mouseEvent(1, 1));

    expect(handler).not.toHaveBeenCalled();
  });

  it('removing the dataset stops it from firing', () => {
    const { manager, interactions } = setup();
    const dataset = manager.add({
      id: 'c1',
      rows: [point('a', [1, 1])],
      interactive: true,
    });
    const handler = vi.fn();
    dataset.on('click', handler);

    manager.remove('c1');
    interactions.handleClick(mouseEvent(1, 1));

    expect(handler).not.toHaveBeenCalled();
  });

  it('an exception in a handler is isolated', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { manager, interactions } = setup();
    const dataset = manager.add({
      id: 'c1',
      rows: [point('a', [1, 1])],
      interactive: true,
    });
    const second = vi.fn();
    dataset.on('click', () => {
      throw new Error('boom');
    });
    dataset.on('click', second);

    interactions.handleClick(mouseEvent(1, 1));

    expect(second).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });
});

describe('the hover of a dataset', () => {
  it('it fires only when the target changes', () => {
    const { manager, interactions } = setup();
    const dataset = manager.add({
      id: 'c1',
      rows: [point('a', [1, 1]), point('b', [2, 2])],
      interactive: true,
    });
    const handler = vi.fn<(payload: DatasetHoverPayload) => void>();
    dataset.on('hover', handler);

    interactions.handleMouseMove(mouseEvent(1, 1));
    interactions.handleMouseMove(mouseEvent(1, 1));

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0].feature?.id).toBe('a');

    interactions.handleMouseMove(mouseEvent(2, 2));

    // The notification of leaving the previous feature (feature: null) and the new feature
    expect(handler.mock.calls.map((c) => c[0].feature?.id ?? null)).toEqual(['a', null, 'b']);
  });

  it('leaving the target is reported with feature: null', () => {
    const { manager, interactions } = setup();
    const dataset = manager.add({
      id: 'c1',
      rows: [point('a', [1, 1])],
      interactive: true,
    });
    const handler = vi.fn<(payload: DatasetHoverPayload) => void>();
    dataset.on('hover', handler);

    interactions.handleMouseMove(mouseEvent(1, 1));
    interactions.handleMouseMove(mouseEvent(50, 50));

    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler.mock.calls[1][0].feature).toBeNull();
    expect(handler.mock.calls[1][0].lngLat).toEqual([50, 50]);
  });

  it('the hover is left once a feature of the Store comes to the front', () => {
    const { manager, interactions, setStoreHit } = setup();
    const dataset = manager.add({
      id: 'c1',
      rows: [point('a', [1, 1])],
      interactive: true,
    });
    const handler = vi.fn<(payload: DatasetHoverPayload) => void>();
    dataset.on('hover', handler);

    interactions.handleMouseMove(mouseEvent(1, 1));
    setStoreHit(true);
    interactions.handleMouseMove(mouseEvent(1, 1));

    expect(handler.mock.calls.map((c) => c[0].feature?.id ?? null)).toEqual(['a', null]);
  });

  it('crossing to another dataset reports the leave to the previous dataset', () => {
    const { manager, interactions } = setup();
    const below = manager.add({
      id: 'below',
      rows: [point('b', [1, 1])],
      interactive: true,
    });
    const above = manager.add({
      id: 'above',
      rows: [point('a', [2, 2])],
      interactive: true,
      order: 'above-store',
    });
    const belowHandler = vi.fn<(payload: DatasetHoverPayload) => void>();
    const aboveHandler = vi.fn<(payload: DatasetHoverPayload) => void>();
    below.on('hover', belowHandler);
    above.on('hover', aboveHandler);

    interactions.handleMouseMove(mouseEvent(1, 1));
    interactions.handleMouseMove(mouseEvent(2, 2));

    expect(belowHandler.mock.calls.map((c) => c[0].feature?.id ?? null)).toEqual(['b', null]);
    expect(aboveHandler.mock.calls.map((c) => c[0].feature?.id ?? null)).toEqual(['a']);
  });

  it('no hover fires over a dataset that is not interactive', () => {
    const { manager, interactions } = setup();
    const dataset = manager.add({ id: 'c1', rows: [point('a', [1, 1])] });
    const handler = vi.fn();
    dataset.on('hover', handler);

    interactions.handleMouseMove(mouseEvent(1, 1));

    expect(handler).not.toHaveBeenCalled();
  });

  it('a non-interactive dataset in front blocks the hover of the one behind', () => {
    const { manager, interactions } = setup();
    const below = manager.add({
      id: 'below',
      rows: [point('b', [1, 1])],
      interactive: true,
    });
    manager.add({
      id: 'above',
      rows: [point('a', [1, 1])],
      order: 'above-store',
    });
    const handler = vi.fn<(payload: DatasetHoverPayload) => void>();
    below.on('hover', handler);

    interactions.handleMouseMove(mouseEvent(1, 1));

    expect(handler).not.toHaveBeenCalled();
  });

  it('reset initializes the hover state', () => {
    const { manager, interactions } = setup();
    const dataset = manager.add({
      id: 'c1',
      rows: [point('a', [1, 1])],
      interactive: true,
    });
    const handler = vi.fn<(payload: DatasetHoverPayload) => void>();
    dataset.on('hover', handler);

    interactions.handleMouseMove(mouseEvent(1, 1));
    interactions.reset();
    interactions.handleMouseMove(mouseEvent(1, 1));

    // After reset, even the same feature fires as a new hover
    expect(handler.mock.calls.map((c) => c[0].feature?.id ?? null)).toEqual(['a', 'a']);
  });
});

describe('the hit testing of a hidden dataset', () => {
  it('click does not fire while it is hidden and fires again once it is shown', () => {
    const { manager, interactions } = setup();
    const dataset = manager.add({
      id: 'c1',
      rows: [point('a', [1, 1])],
      interactive: true,
    });
    const handler = vi.fn<(payload: DatasetClickPayload) => void>();
    dataset.on('click', handler);

    dataset.setVisible(false);
    interactions.handleClick(mouseEvent(1, 1));

    expect(handler).not.toHaveBeenCalled();

    dataset.setVisible(true);
    interactions.handleClick(mouseEvent(1, 1));

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('hover does not fire while it is hidden', () => {
    const { manager, interactions } = setup();
    const dataset = manager.add({
      id: 'c1',
      rows: [point('a', [1, 1])],
      interactive: true,
    });
    const handler = vi.fn<(payload: DatasetHoverPayload) => void>();
    dataset.on('hover', handler);

    dataset.setVisible(false);
    interactions.handleMouseMove(mouseEvent(1, 1));

    expect(handler).not.toHaveBeenCalled();
  });

  it('a hidden dataset is skipped and the one behind is hit', () => {
    const { manager, interactions } = setup();
    const below = manager.add({
      id: 'below',
      rows: [point('b', [1, 1])],
      interactive: true,
    });
    const above = manager.add({
      id: 'above',
      rows: [point('a', [1, 1])],
      interactive: true,
      order: 'above-store',
    });
    const belowHandler = vi.fn<(payload: DatasetClickPayload) => void>();
    below.on('click', belowHandler);

    above.setVisible(false);
    interactions.handleClick(mouseEvent(1, 1));

    expect(belowHandler).toHaveBeenCalledTimes(1);
    expect(belowHandler.mock.calls[0][0].feature.id).toBe('b');
  });
});

describe('the notification of the resolved click (the source of draw.dataset.click)', () => {
  function setupWithNotify() {
    const manager = createDatasetManager({
      getViewportBounds: () => WORLD,
      getZoom: () => 10,
      onViewportChange: () => () => {},
      requestRepaint: () => {},
    });
    let storeHit = false;
    const notified: DatasetClickEventPayload[] = [];
    const interactions = createDisplayInteractions({
      manager,
      hitTestTopmost: (event) => {
        if (storeHit) return { kind: 'store', feature: STORE_FEATURE };
        const coordinate: Coordinate = [event.lngLat.lng, event.lngLat.lat];
        const hit =
          manager.hitTestSide('above-store', coordinate, 0.1, exactHit) ??
          manager.hitTestSide('below-store', coordinate, 0.1, exactHit);
        return hit
          ? { kind: 'dataset', dataset: hit.dataset, feature: hit.feature, row: hit.row }
          : null;
      },
      notifyClick: (payload) => notified.push(payload),
    });
    return {
      manager,
      interactions,
      notified,
      setStoreHit: (value: boolean) => {
        storeHit = value;
      },
    };
  }

  it('a hit on a feature is reported with the dataset id and the feature', () => {
    const { manager, interactions, notified } = setupWithNotify();
    manager.add({ id: 'c1', rows: [point('a', [1, 1])], interactive: true });

    interactions.handleClick(mouseEvent(1, 1));

    expect(notified).toHaveLength(1);
    expect(notified[0].datasetId).toBe('c1');
    expect(notified[0].feature?.id).toBe('a');
  });

  it('nothing hit is reported as null (the source of clearing on an empty click)', () => {
    const { manager, interactions, notified } = setupWithNotify();
    manager.add({ id: 'c1', rows: [point('a', [1, 1])], interactive: true });

    interactions.handleClick(mouseEvent(5, 5));

    expect(notified).toHaveLength(1);
    expect(notified[0].datasetId).toBeNull();
    expect(notified[0].feature).toBeNull();
    expect(notified[0].lngLat).toEqual([5, 5]);
  });

  it('a mere block by a non-interactive dataset is reported as null too', () => {
    const { manager, interactions, notified } = setupWithNotify();
    manager.add({ id: 'c1', rows: [point('a', [1, 1])], interactive: false });

    interactions.handleClick(mouseEvent(1, 1));

    expect(notified).toHaveLength(1);
    expect(notified[0].datasetId).toBeNull();
  });

  it('nothing is reported when a feature of the Store is in front (the domain of the Store selection)', () => {
    const { manager, interactions, notified, setStoreHit } = setupWithNotify();
    manager.add({ id: 'c1', rows: [point('a', [1, 1])], interactive: true });
    setStoreHit(true);

    interactions.handleClick(mouseEvent(1, 1));

    expect(notified).toHaveLength(0);
  });

  it('nothing is reported when there is not a single dataset', () => {
    const { interactions, notified } = setupWithNotify();

    interactions.handleClick(mouseEvent(1, 1));

    expect(notified).toHaveLength(0);
  });
});
