// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for box selection
 *
 * As with the click hit test, queryFeaturesInBox excludes hidden features and features on
 * hidden or locked layers from the selection targets.
 */

import { describe, expect, it } from 'vitest';
import { PointBoxSelectionStrategy } from '../../dispatcher/hit-test/box-strategies.js';
import { MemoryStore } from '../../store/memory.js';
import { StoreSpatialIndex } from '../../store/spatial/store-spatial-index.js';
import type { BoxSelection, Feature } from '../../store/types.js';
import { createSelectionScope } from '../../view/ui/selection-scope.js';
import type { ModeContext } from '../handler.js';
import { boxRects, queryFeaturesInBox } from './box-selection.js';

function point(id: string, layerId: string, coord: [number, number], visible = true): Feature {
  return {
    id,
    type: 'Point',
    geometry: { type: 'Point', coordinates: coord },
    layerId,
    properties: {},
    locked: false,
    visible,
    style: {},
  };
}

describe('queryFeaturesInBox filtering', () => {
  it('excludes hidden features and features on locked or hidden layers', () => {
    const store = new MemoryStore();
    store.createLayer({
      id: 'l1',
      name: 'l1',
      visible: true,
      locked: false,
      opacity: 1,
      items: [],
    });
    store.createLayer({
      id: 'lLocked',
      name: 'x',
      visible: true,
      locked: true,
      opacity: 1,
      items: [],
    });
    store.createLayer({
      id: 'lHidden',
      name: 'x',
      visible: false,
      locked: false,
      opacity: 1,
      items: [],
    });

    store.createFeature(point('f1', 'l1', [0, 0])); // selectable
    store.createFeature(point('f2', 'l1', [1, 1], false)); // hidden feature
    store.createFeature(point('f3', 'lLocked', [2, 2])); // locked layer
    store.createFeature(point('f4', 'lHidden', [3, 3])); // hidden layer

    const context = {
      store,
      spatialIndex: { findInBounds: () => ['f1', 'f2', 'f3', 'f4'] },
      boxSelectionRegistry: {
        get: (t: string) => (t === 'Point' ? new PointBoxSelectionStrategy() : undefined),
      },
      selectionScope: createSelectionScope(),
    } as unknown as ModeContext;

    const boxSelection = { startPoint: [-10, -10], endPoint: [10, 10] } as unknown as BoxSelection;
    const result = queryFeaturesInBox(boxSelection, context);

    expect(result).toEqual(['f1']);
  });

  it('excludes locked features and features in a locked group', () => {
    const store = new MemoryStore();
    store.createLayer({
      id: 'l1',
      name: 'l1',
      visible: true,
      locked: false,
      opacity: 1,
      items: [],
    });

    store.createFeature(point('f1', 'l1', [0, 0])); // selectable
    store.createFeature({ ...point('f2', 'l1', [1, 1]), locked: true }); // locked feature
    store.createFeature(point('f3', 'l1', [2, 2])); // belongs to a locked group
    store.createGroup({
      id: 'g1',
      layerId: 'l1',
      name: 'g',
      featureIds: ['f3'],
      locked: true,
      visible: true,
    });

    const context = {
      store,
      spatialIndex: { findInBounds: () => ['f1', 'f2', 'f3'] },
      boxSelectionRegistry: {
        get: (t: string) => (t === 'Point' ? new PointBoxSelectionStrategy() : undefined),
      },
      selectionScope: createSelectionScope(),
    } as unknown as ModeContext;

    const boxSelection = { startPoint: [-10, -10], endPoint: [10, 10] } as unknown as BoxSelection;
    const result = queryFeaturesInBox(boxSelection, context);

    expect(result).toEqual(['f1']);
  });
});

describe('boxRects across the antimeridian', () => {
  it('keeps a box within [-180, 180] as one rectangle', () => {
    expect(boxRects([10, 20], [-10, -20])).toEqual([{ minX: -10, minY: -20, maxX: 10, maxY: 20 }]);
  });

  it('splits a box drawn across the line into both sides, keeping the box as drawn', () => {
    expect(boxRects([170, 0], [190, 10])).toEqual([
      { minX: 170, minY: 0, maxX: 180, maxY: 10 },
      { minX: -180, minY: 0, maxX: -170, maxY: 10 },
      { minX: 170, minY: 0, maxX: 190, maxY: 10 },
    ]);
    expect(boxRects([-190, 0], [-170, 10])).toEqual([
      { minX: 170, minY: 0, maxX: 180, maxY: 10 },
      { minX: -180, minY: 0, maxX: -170, maxY: 10 },
      { minX: -190, minY: 0, maxX: -170, maxY: 10 },
    ]);
  });

  it('covers every longitude for a box as wide as the world', () => {
    expect(boxRects([-200, 0], [200, 10])).toEqual([{ minX: -180, minY: 0, maxX: 180, maxY: 10 }]);
  });

  it('selects the features on both sides of the line', () => {
    const store = new MemoryStore();
    store.createLayer({
      id: 'l1',
      name: 'l1',
      visible: true,
      locked: false,
      opacity: 1,
      items: [],
    });
    store.createFeature(point('east', 'l1', [175, 5]));
    store.createFeature(point('west', 'l1', [-175, 5]));
    store.createFeature(point('far', 'l1', [0, 5]));
    const context = {
      store,
      spatialIndex: new StoreSpatialIndex(store),
      boxSelectionRegistry: {
        get: (t: string) => (t === 'Point' ? new PointBoxSelectionStrategy() : undefined),
      },
      selectionScope: createSelectionScope(),
    } as unknown as ModeContext;

    const boxSelection = { startPoint: [170, 0], endPoint: [190, 10] } as unknown as BoxSelection;

    expect(queryFeaturesInBox(boxSelection, context).sort()).toEqual(['east', 'west']);
  });
});
