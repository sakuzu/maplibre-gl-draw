// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The extent a click finds a row by, on an instance over a Store of rows
 *
 * A row not selected is found by the box it covers as it is drawn, the same box as a feature
 * selected: the box the calculation of its type gives (`bbox` of a type of an extension), and as
 * far as the reach a type registered (`hitPaddingPx`). And the hit test keeps working once the
 * number of a style no row uses any more is taken back.
 */

import type { Point } from 'geojson';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RELEASE_DELAY_MS } from '../../store/draw-store.js';
import type { Store } from '../../store/store.js';
import { createTableStore } from '../../store/table-memory.js';
import type { Feature } from '../../store/types.js';
import { createMapStub, createSyntheticInput } from '../../test-utils.js';
import type { Draw } from '../draw.js';
import type { FeatureTypeDefinition } from '../extension/feature-type.js';
import { createDrawOnEngine } from './create-draw.js';
import type { Engine } from './engine.js';
import { createEngine } from './engine.js';

let engine: Engine;
let draw: Draw;
let store: Store;

/** A type drawn as a box of half a degree each way around its point */
const box: FeatureTypeDefinition = {
  type: 'box',
  geometry: 'Point',
  renderer: { onAdd: () => {}, draw: () => {}, onRemove: () => {} },
  bbox: (feature) => {
    const [x, y] = (feature.geometry as Point).coordinates as [number, number];
    return [x - 0.5, y - 0.5, x + 0.5, y + 0.5];
  },
  hitTest: (feature, ctx) => {
    const [x, y] = (feature.geometry as Point).coordinates as [number, number];
    const [lng, lat] = ctx.lngLat;
    return Math.abs(lng - x) <= 0.5 && Math.abs(lat - y) <= 0.5
      ? { kind: 'feature', id: feature.id, distancePx: 0 }
      : null;
  },
};

/** A type hit 30 pixels around its point (its icon), beyond the tolerance of a click */
const pin: FeatureTypeDefinition = {
  type: 'pin',
  geometry: 'Point',
  hitPaddingPx: 30,
  renderer: { onAdd: () => {}, draw: () => {}, onRemove: () => {} },
  hitTest: (feature, ctx) => {
    const [x, y] = ctx.screen.project((feature.geometry as Point).coordinates as [number, number]);
    const distancePx = Math.hypot(x - ctx.point[0], y - ctx.point[1]);
    return distancePx <= 30 ? { kind: 'feature', id: feature.id, distancePx } : null;
  },
};

function point(id: string, type: string, at: [number, number], style = {}): Feature {
  return {
    id,
    type,
    geometry: { type: 'Point', coordinates: at },
    layerId: 'rows',
    groupId: undefined,
    properties: {},
    style,
    visible: true,
    locked: false,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  store = createTableStore().store;
  store.createLayer({
    id: 'rows',
    name: 'rows',
    visible: true,
    locked: false,
    opacity: 1,
    kind: 'table',
    styleRule: undefined,
    metadata: undefined,
  });
  engine = createEngine(
    createMapStub().map,
    { store, initDefaultLayer: false },
    { deferDefaultMode: true },
  );
  draw = createDrawOnEngine(engine, { store, initDefaultLayer: false });
  draw.extensions.featureTypes.add(box);
  draw.extensions.featureTypes.add(pin);
  engine.enterDefaultMode();
});

afterEach(() => {
  draw.destroy();
  vi.useRealTimers();
});

/** Clears the selection, lets go of the rows held, then clicks at a position */
function clickAfresh(at: [number, number]): readonly string[] {
  const input = createSyntheticInput(engine);
  input.click([3.5, -2.5]);
  vi.advanceTimersByTime(RELEASE_DELAY_MS * 2);
  input.click(at);
  return store.getSelection().ids;
}

describe('the extent a click finds a row by', () => {
  it('is the box the calculation of its type gives, selected or not', () => {
    store.createFeature(point('b', 'box', [1, 1]));
    expect(clickAfresh([1.4, 0.6])).toEqual(['b']);
    // Moved, and let go of: found at the box of its new place
    draw.features.update('b', { geometry: { type: 'Point', coordinates: [2, 1] } });
    expect(clickAfresh([2.4, 1.4])).toEqual(['b']);
    expect(clickAfresh([1.4, 0.6])).toEqual([]);
  });

  it('reaches as far as a type registered', () => {
    store.createFeature(point('p', 'pin', [1, 1]));
    // 20 pixels away (the stub shows 100 pixels per degree)
    expect(clickAfresh([1.2, 1])).toEqual(['p']);
  });
});

describe('the hit test of the rows', () => {
  it('goes on once the number of a style no row uses is taken back', () => {
    store.createFeature(point('p', 'Point', [1, 1], { pointColor: '#ff0000' }));
    store.createFeature(point('q', 'Point', [2, 2], { pointColor: '#00ff00' }));
    const input = createSyntheticInput(engine);
    input.move([1, 1]);
    // The style of p is used by no row any more: its number is taken back
    store.updateFeature('p', { style: { pointColor: '#00ff00' } });
    expect(() => input.move([1, 1])).not.toThrow();
    expect(clickAfresh([1, 1])).toEqual(['p']);
  });
});

describe('the rows a box finds', () => {
  /** The ids of the rows of a scan of a box */
  function scan(bbox: [number, number, number, number], order: 'layer' | 'any'): string[] {
    const tables = store.tables;
    const out: string[] = [];
    const cursor = tables?.scan({ bbox, order });
    for (let batch = cursor?.next(); batch; batch = cursor?.next()) {
      for (const handle of batch) out.push(tables?.getRowId(handle) as string);
    }
    return out;
  }

  function drawn(bbox: [number, number, number, number]): string[] {
    const tables = store.tables;
    const rows = tables?.get('rows')?.listDrawnRows(bbox) ?? new Int32Array(0);
    return [...rows].map((handle) => tables?.getRowId(handle) as string);
  }

  it('are the rows whose boxes as drawn meet it, in the order of the layer', () => {
    store.createFeature(point('b', 'box', [1, 1]));
    store.createFeature(point('p', 'Point', [1.4, 1.4]));
    store.createFeature(point('far', 'Point', [5, 5]));
    // A box over the extent of b (its point is at 1, 1) and over p
    const bbox: [number, number, number, number] = [1.3, 1.3, 1.45, 1.45];
    expect(scan(bbox, 'layer')).toEqual(['b', 'p']);
    expect(scan(bbox, 'any').sort()).toEqual(['b', 'p']);
    expect(drawn(bbox)).toEqual(['b', 'p']);
    // In the order of the layer, whatever it is
    draw.features.move('b', { layerId: 'rows', below: 'p', above: null });
    expect(scan(bbox, 'layer')).toEqual(['p', 'b']);
    expect(drawn(bbox)).toEqual(['p', 'b']);
    // A row hidden is not drawn; a row deleted is not read
    draw.features.update('p', { visible: false });
    expect(drawn(bbox)).toEqual(['b']);
    draw.features.delete('b');
    expect(scan(bbox, 'layer')).toEqual(['p']);
    expect(scan(bbox, 'any')).toEqual(['p']);
  });

  it('finds a row held as a feature by the box of its feature', () => {
    store.createFeature(point('b', 'box', [1, 1]));
    // Selected: held as a feature, then moved
    clickAfresh([1, 1]);
    draw.features.update('b', { geometry: { type: 'Point', coordinates: [2, 1] } });
    expect(scan([2.3, 1.3, 2.45, 1.45], 'any')).toEqual(['b']);
    expect(scan([1.3, 1.3, 1.45, 1.45], 'layer')).toEqual([]);
  });
});
