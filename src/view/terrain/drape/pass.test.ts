// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Verification of the element supply of the analytic drape
 *
 * The promise about the stacking order is "datasets (below-store) -> the
 * Store's stack -> datasets (above-store)", and inside the stack layers and
 * participating datasets are mixed (the same as view/layer/render.ts).
 */

import { describe, expect, it } from 'vitest';
import type { Feature } from '../../../store/types.js';
import type { RetainedStyleResolver } from '../../renderers/retained.js';
import { drapeSelectionKey } from './binning.js';
import {
  canDrape,
  collectDrapeElements,
  type DrapeDatasetSource,
  drapeLayerSource,
} from './pass.js';
import { DRAPE_MAX_SOURCES } from './renderer.js';

/** Builds a polygon feature */
function polygon(id: string, layerId: string, x = 0): Feature {
  return {
    id,
    type: 'Polygon',
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          [x, 0],
          [x + 1, 0],
          [x + 1, 1],
          [x, 1],
          [x, 0],
        ],
      ],
    },
    properties: {},
    layerId,
    visible: true,
  } as unknown as Feature;
}

/** Builds a point feature (it does not go on the drape) */
function point(id: string, layerId: string): Feature {
  return {
    id,
    type: 'Point',
    geometry: { type: 'Point', coordinates: [0, 0] },
    properties: {},
    layerId,
    visible: true,
  } as unknown as Feature;
}

const styles = {
  getPolygonStyles: () => ({
    fillColor: [1, 0, 0, 1] as [number, number, number, number],
    strokeStyle: {
      color: [0, 0, 0, 1] as [number, number, number, number],
      width: 2,
      opacity: 1,
      lineStyle: 'solid' as const,
    },
  }),
  getLineStringStrokeStyle: () => ({
    color: [0, 0, 0, 1] as [number, number, number, number],
    width: 2,
    opacity: 1,
    lineStyle: 'solid' as const,
  }),
  getPointStyle: () => ({ shape: 'circle' }),
} as unknown as RetainedStyleResolver;

/** A minimal Store */
function fakeStore(
  features: Feature[],
  layerOrder: string[],
  layerIds: Set<string>,
  opacity: Record<string, number> = {},
) {
  return {
    listFeaturesInOrder: () => features,
    isHidden: () => false,
    getLayerOrder: () => layerOrder,
    getLayer: (id: string) =>
      layerIds.has(id) ? { id, visible: true, opacity: opacity[id] ?? 1 } : undefined,
    getGroup: () => undefined,
  } as unknown as Parameters<typeof collectDrapeElements>[0];
}

/** A minimal dataset */
function fakeDataset(
  id: string,
  order: DrapeDatasetSource['order'],
  features: Feature[],
  selectedIds: string[] = [],
): DrapeDatasetSource {
  return {
    id,
    order,
    visible: true,
    drapeRevision: 1,
    drapeFeatures: () => features,
    getSelectedIds: () => selectedIds,
  };
}

describe('the stacking order of collectDrapeElements', () => {
  it('lays them out in the order below-store -> the stack -> above-store', () => {
    const storeFeature = polygon('store-1', 'layer-1');
    const store = fakeStore([storeFeature], ['layer-1'], new Set(['layer-1']));
    const below = fakeDataset('below', 'below-store', [polygon('b-1', 'below')]);
    const above = fakeDataset('above', 'above-store', [polygon('a-1', 'above')]);

    const result = collectDrapeElements(store, styles, 1, 1, [above, below]);
    expect(result.elements).toHaveLength(3);
    // The source number tells which dataset or layer it came from (datasets first,
    // then the Store layers)
    expect(result.elements.map((e) => e.source)).toEqual([2, 3, 1]);
    expect([...result.layerSources]).toEqual([['layer-1', 3]]);
  });

  it('holds the start of each stack entry and of the part above (interval render index)', () => {
    const store = fakeStore(
      [polygon('store-1', 'layer-1'), polygon('store-2', 'layer-2')],
      ['layer-1', 'ext:x', 'layer-2'],
      new Set(['layer-1', 'layer-2']),
    );
    const below = fakeDataset('below', 'below-store', [polygon('b-1', 'below')]);
    const above = fakeDataset('above', 'above-store', [polygon('a-1', 'above')]);

    const result = collectDrapeElements(store, styles, 1, 1, [below, above]);
    // The stack begins after the single below-store element. A break (ext:x) has a position
    // too
    expect(result.entryStarts.get('layer-1')).toBe(1);
    expect(result.entryStarts.get('ext:x')).toBe(2);
    expect(result.entryStarts.get('layer-2')).toBe(2);
    expect(result.aboveStoreStart).toBe(3);
    expect(result.elements).toHaveLength(4);
  });

  it('puts a dataset taking part in the stack at the position of the stack', () => {
    const store = fakeStore(
      [polygon('store-1', 'layer-1'), polygon('store-2', 'layer-2')],
      ['layer-1', 'coll', 'layer-2'],
      new Set(['layer-1', 'layer-2']),
    );
    const coll = fakeDataset('coll', 'layer-order', [polygon('c-1', 'coll')]);

    const result = collectDrapeElements(store, styles, 1, 1, [coll]);
    expect(result.elements.map((e) => e.source)).toEqual([2, 1, 3]);
  });

  it('makes a Store feature that does not go on the drape excluded', () => {
    const store = fakeStore(
      [polygon('store-1', 'layer-1'), point('point-1', 'layer-1')],
      ['layer-1'],
      new Set(['layer-1']),
    );
    const result = collectDrapeElements(store, styles, 1, 1, []);
    expect(result.elements).toHaveLength(1);
    expect([...result.excluded]).toEqual(['point-1']);
  });

  it('does not put a hidden dataset on', () => {
    const store = fakeStore([], [], new Set());
    const hidden: DrapeDatasetSource = {
      ...fakeDataset('hidden', 'above-store', [polygon('h-1', 'hidden')]),
      visible: false,
    };
    const result = collectDrapeElements(store, styles, 1, 1, [hidden]);
    expect(result.elements).toHaveLength(0);
    expect(result.drapedDatasets.size).toBe(0);
  });

  it('puts a dataset that was put on into drapedDatasets', () => {
    const store = fakeStore([], [], new Set());
    const coll = fakeDataset('coll', 'above-store', [polygon('c-1', 'coll')]);
    const result = collectDrapeElements(store, styles, 1, 1, [coll]);
    expect([...result.drapedDatasets]).toEqual(['coll']);
  });
});

describe('canDrape', () => {
  it('can be used when the vertices fit within the budget', () => {
    expect(canDrape({ vertexCount: 1_100_000 })).toBe(true);
  });

  it('degrades once the vertices exceed the budget', () => {
    expect(canDrape({ vertexCount: 40_000_000 })).toBe(false);
  });
});

describe('the types put on the drape', () => {
  /** A freehand line (the same shape as a polyline) */
  function freehand(id: string, layerId: string): Feature {
    return {
      id,
      type: 'Freehand',
      geometry: {
        type: 'LineString',
        coordinates: [
          [0, 0],
          [1, 1],
          [2, 0],
        ],
      },
      properties: {},
      layerId,
      visible: true,
    } as unknown as Feature;
  }

  it('puts a freehand line on the drape too (a feature painted as ground pixels)', () => {
    const feature = freehand('fh-1', 'layer-1');
    const store = fakeStore([feature], ['layer-1'], new Set(['layer-1']));

    const { elements, excluded } = collectDrapeElements(store, styles, 1, 1, []);

    expect(elements).toHaveLength(1);
    // It goes on as a line (kind 1)
    expect(elements[0].kind).toBe(1);
    expect(excluded.has('fh-1')).toBe(false);
  });
});

describe('the breaks in the stacking order (images)', () => {
  /** An image feature (it does not go on the drape, but its position is remembered as a
   * break) */
  function image(id: string, layerId: string): Feature {
    return {
      id,
      type: 'Image',
      geometry: { type: 'Point', coordinates: [0, 0] },
      properties: {},
      layerId,
      visible: true,
    } as unknown as Feature;
  }

  it('makes an Image excluded and remembers the break position in the stacking order', () => {
    const store = fakeStore(
      [polygon('under', 'layer-1'), image('img-1', 'layer-1'), polygon('over', 'layer-1')],
      ['layer-1'],
      new Set(['layer-1']),
    );
    const result = collectDrapeElements(store, styles, 1, 1, []);

    expect(result.elements).toHaveLength(2);
    expect(result.excluded.has('img-1')).toBe(true);
    // The position with one polygon piled below it (= above under, below over)
    expect(result.quadBreaks).toEqual([{ featureId: 'img-1', afterElements: 1 }]);
  });

  it('has no break when there is no image', () => {
    const store = fakeStore([polygon('p-1', 'layer-1')], ['layer-1'], new Set(['layer-1']));
    const result = collectDrapeElements(store, styles, 1, 1, []);
    expect(result.quadBreaks).toEqual([]);
  });
});

describe('the line width convention', () => {
  /** A feature with a createdZoom (it preserves the appearance it had when it was made) */
  function withCreatedZoom(feature: Feature, createdZoom: number): Feature {
    return {
      ...feature,
      properties: { ...feature.properties, 'maplibre-gl-draw:createdZoom': createdZoom },
    } as Feature;
  }

  it('puts a Store feature with a createdZoom on with a zoom-linked width', () => {
    // The retained batch path draws with width * 2^(zoom - createdZoom). If the drape put it
    // on with a fixed width, the same feature would change thickness at a zoom boundary
    const feature = withCreatedZoom(polygon('store-1', 'layer-1'), 12);
    const store = fakeStore([feature], ['layer-1'], new Set(['layer-1']));

    const { elements } = collectDrapeElements(store, styles, 2, 2, []);

    expect(elements[0].widthZoom).toBe(12);
    // The device pixel ratio is applied to a zoom-linked width, and the rendering scale is not
    // (the same convention as the retained batch path)
    expect(elements[0].strokeWidthPx).toBe(4);
  });

  it('puts a Store feature without a createdZoom on fixed in screen pixels', () => {
    const feature = polygon('store-1', 'layer-1');
    const store = fakeStore([feature], ['layer-1'], new Set(['layer-1']));

    const { elements } = collectDrapeElements(store, styles, 2, 2, []);

    expect(elements[0].widthZoom).toBe(-1);
    expect(elements[0].strokeWidthPx).toBe(4);
  });
});

describe('the key of the selection highlight', () => {
  it('gives a dataset element a key of the dataset ID and the feature ID', () => {
    const store = fakeStore([], [], new Set());
    const dataset = fakeDataset('c1', 'above-store', [polygon('a-1', 'c1')]);

    const { elements } = collectDrapeElements(store, styles, 1, 1, [dataset]);

    expect(elements.map((e) => e.selectionKey)).toEqual([drapeSelectionKey('c1', 'a-1')]);
  });

  it('gives a Store feature no key (because the selection UI expresses the selection)', () => {
    const feature = polygon('store-1', 'layer-1');
    const store = fakeStore([feature], ['layer-1'], new Set(['layer-1']));

    const { elements } = collectDrapeElements(store, styles, 1, 1, []);

    expect(elements.map((e) => e.selectionKey)).toEqual(['']);
  });
});

describe('the opacity of the Store layers on the drape', () => {
  it('gives each layer a source of its own and leaves its colors alone', () => {
    const store = fakeStore([polygon('store-1', 'layer-1')], ['layer-1'], new Set(['layer-1']), {
      'layer-1': 0.5,
    });
    const result = collectDrapeElements(store, styles, 1, 1, []);
    expect(result.layerSources.get('layer-1')).toBe(1);
    expect(result.elements[0].fill[3]).toBe(1);
    expect(drapeLayerSource(0, 0)).toBe(1);
  });

  it('bakes the opacity into the colors of a layer past the capacity of the sources', () => {
    const layerIds: string[] = [];
    const features: Feature[] = [];
    for (let i = 0; i < DRAPE_MAX_SOURCES; i++) {
      layerIds.push(`layer-${i}`);
      features.push(polygon(`f-${i}`, `layer-${i}`, i));
    }
    const last = layerIds[layerIds.length - 1];
    const store = fakeStore(features, layerIds, new Set(layerIds), { [last]: 0.5 });
    const result = collectDrapeElements(store, styles, 1, 1, []);

    expect(drapeLayerSource(DRAPE_MAX_SOURCES - 1, 0)).toBe(0);
    expect(result.layerSources.has(last)).toBe(false);
    const element = result.elements[result.elements.length - 1];
    expect(element.source).toBe(0);
    expect(element.fill[3]).toBe(0.5);
    expect(element.stroke[3]).toBe(0.5);
  });
});
