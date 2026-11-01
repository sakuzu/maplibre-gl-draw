// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The hit testing of the layers held as rows of columns in the unified z traversal
 *
 * A row is hit as it is drawn: the frontmost row, in the order of the layer, of the layers in
 * the stacking order. The hit is a row (`kind: 'row'`) and no feature of the Store is made; a
 * hidden row, a hidden layer and a row out of reach are not hit.
 *
 * A hit asked to hold the row (a click, a drag) makes the row a feature of the Store for a
 * moment (`core:pointer`) and returns it as one; a row held (selected) is hit as a feature of
 * the Store with or without it.
 *
 * The companions of the rows are hit in the order they are drawn, as the companions of the
 * features are: from the front, each row itself, then its companions.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LayerTableView } from '../../api/tables.js';
import {
  createFeatureTablesStore,
  featureTablesInternals,
} from '../../feature-table/feature-tables.js';
import { DrawStore, RELEASE_DELAY_MS } from '../../store/draw-store.js';
import { MemoryContractStore } from '../../store/memory.js';
import { RBushSpatialIndex } from '../../store/spatial/spatial-index.js';
import type { Feature } from '../../store/types.js';
import { createRowBlockDataBuilder } from '../../table/row-group-builder.js';
import { feature, internalsOf, orderKey, rowOfFeature } from '../../test-utils.js';
import {
  createFeatureCompanionRegistry,
  type FeatureCompanionProvider,
  type FeatureCompanionRegistry,
} from '../../view/feature-companion.js';
import { HitTestServiceImpl } from './service.js';
import { createTopmostHitTester, POINTER_HOLD_MS, POINTER_OWNER, type TopHit } from './topmost.js';

const square = (x: number, y: number) => [
  [
    [x, y],
    [x + 10, y],
    [x + 10, y + 10],
    [x, y + 10],
    [x, y],
  ],
];

/** An unproject that maps longitude/latitude naively and linearly (1 degree = 10px) */
const unproject = (p: { x: number; y: number }): { lng: number; lat: number } => ({
  lng: p.x / 10,
  lat: -p.y / 10,
});
const at = (lng: number, lat: number) => ({ x: lng * 10, y: -lat * 10 });

let store: DrawStore;
let tables: ReturnType<typeof createFeatureTablesStore>;

function layer(id: string): void {
  store.createLayer({
    id,
    name: id,
    visible: true,
    locked: false,
    opacity: 1,
    items: [],
    styleRule: undefined,
    metadata: undefined,
  });
}

function adopt(layerId: string, features: Feature[]): void {
  const builder = createRowBlockDataBuilder({ targetRows: 2 });
  features.forEach((f, i) => {
    builder.addRow(rowOfFeature(f, orderKey(i)));
  });
  tables.writer.addRowBlocks(layerId, builder.finish());
  featureTablesInternals(tables.tables)?.addQueuedRowBlocks();
}

beforeEach(() => {
  tables = createFeatureTablesStore();
  const contract = new MemoryContractStore();
  Object.defineProperty(contract, 'tables', { value: tables.tables });
  store = new DrawStore(contract);
});

function tester() {
  const service = new HitTestServiceImpl(store, new RBushSpatialIndex());
  return createTopmostHitTester({
    store,
    hitTestService: service,
    unproject,
    toleranceLngLat: () => 0.5,
    getZoom: () => 3,
  });
}

function rowId(hit: TopHit | null): string | null {
  return hit?.kind === 'row' ? hit.id : null;
}

describe('the hit testing of the rows held as columns', () => {
  it('returns the frontmost row as a row, with its handle', () => {
    layer('l');
    adopt('l', [
      feature('back', 'Polygon', square(0, 0)),
      feature('middle', 'Polygon', square(5, 5)),
      feature('front', 'Polygon', square(8, 8)),
    ]);
    const hit = tester()(at(9, 9));
    expect(hit?.kind).toBe('row');
    expect(rowId(hit)).toBe('front');
    if (hit?.kind !== 'row') throw new Error('row');
    expect(hit.layerId).toBe('l');
    expect(hit.handle).toBe(tables.tables.findRow('front'));
    expect(hit.locked).toBe(false);
    expect(rowId(tester()(at(6, 6)))).toBe('middle');
    expect(tester()(at(30, 30))).toBeNull();
  });

  it('follows the stacking order of the layers', () => {
    layer('below');
    layer('above');
    adopt('below', [feature('b', 'Polygon', square(0, 0))]);
    adopt('above', [feature('a', 'Polygon', square(0, 0))]);
    expect(rowId(tester()(at(5, 5)))).toBe('a');
    store.setLayerOrder(['above', 'below']);
    expect(rowId(tester()(at(5, 5)))).toBe('b');
  });

  it('does not hit a hidden row, nor the rows of a hidden layer', () => {
    layer('l');
    adopt('l', [
      feature('back', 'Polygon', square(0, 0)),
      feature('front', 'Polygon', square(0, 0), { visible: false }),
    ]);
    expect(rowId(tester()(at(5, 5)))).toBe('back');
    const internals = featureTablesInternals(tables.tables);
    internals?.states.setHidden(Int32Array.of(tables.tables.findRow('back') as number), true);
    expect(tester()(at(5, 5))).toBeNull();
    internals?.states.setHidden(Int32Array.of(tables.tables.findRow('back') as number), false);
    store.setLocallyHidden('l', true);
    expect(tester()(at(5, 5))).toBeNull();
  });

  it('tells a locked row, and a row of a locked layer', () => {
    layer('l');
    adopt('l', [feature('p', 'Polygon', square(0, 0), { locked: true })]);
    const hit = tester()(at(5, 5));
    expect(hit?.kind === 'row' && hit.locked).toBe(true);
  });

  it('makes no feature of the Store for a row', () => {
    layer('l');
    adopt('l', [feature('p', 'Polygon', square(0, 0))]);
    tester()(at(5, 5));
    expect(store.getFeature('p')).toBeUndefined();
  });

  it('measures the distance of a row hit from the row', () => {
    layer('l');
    adopt('l', [
      feature('line', 'LineString', [
        [0, 0],
        [10, 0],
      ]),
    ]);
    const hit = tester()(at(5, 0.2));
    expect(hit?.kind).toBe('row');
    if (hit?.kind !== 'row') throw new Error('row');
    // 0.2 degrees at 10 px per degree (a latitude difference counts a little more by cos φ)
    expect(hit.distancePx()).toBeCloseTo(2, 3);
  });
});

describe('the hit testing that holds the row hit', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('makes the row hit a feature of the Store for a moment', () => {
    layer('l');
    adopt('l', [feature('p', 'Polygon', square(0, 0))]);
    const hit = tester()(at(5, 5), { hold: true });
    expect(hit?.kind).toBe('store');
    const held = internalsOf(tables.tables).getOpenedFeature('p');
    expect(held).toBeDefined();
    expect(hit?.kind === 'store' && hit.feature).toBe(held);
    // The selection holds it before the moment is over
    store.setSelection('feature', ['p']);
    vi.advanceTimersByTime(POINTER_HOLD_MS);
    expect(internalsOf(tables.tables).getOpenedFeature('p')).toBe(held);
    store.setSelection(null, []);
    // Let go a moment after the selection lets go of it
    vi.advanceTimersByTime(RELEASE_DELAY_MS);
    expect(internalsOf(tables.tables).getOpenedFeature('p')).toBeUndefined();
    // Without the selection it is let go after the moment
    tester()(at(5, 5), { hold: true });
    expect(internalsOf(tables.tables).getOpenedFeature('p')).toBeDefined();
    vi.advanceTimersByTime(POINTER_HOLD_MS);
    expect(internalsOf(tables.tables).getOpenedFeature('p')).toBeUndefined();
  });

  it('returns a row held as a feature of the Store, held or not by the hit', () => {
    layer('l');
    adopt('l', [feature('p', 'Polygon', square(0, 0))]);
    internalsOf(tables.tables).open(POINTER_OWNER, []);
    store.setSelection('feature', ['p']);
    const hit = tester()(at(5, 5));
    expect(hit?.kind).toBe('store');
    expect(hit?.kind === 'store' && hit.feature).toBe(
      internalsOf(tables.tables).getOpenedFeature('p'),
    );
  });
});

describe('the hit testing of the companions of the rows held as columns', () => {
  let companions: FeatureCompanionRegistry;

  beforeEach(() => {
    companions = createFeatureCompanionRegistry();
  });

  function companionTester() {
    const service = new HitTestServiceImpl(store, new RBushSpatialIndex());
    return createTopmostHitTester({
      store,
      hitTestService: service,
      unproject,
      toleranceLngLat: () => 0.5,
      getZoom: () => 3,
      project: ([lng, lat]) => at(lng, lat),
      clickTolerancePx: 5,
      companions,
    });
  }

  /**
   * A provider of a line drawn for each feature it names, along the latitude it gives, from
   * longitude 0 to 100 (a callout away from its feature), answered from the rows when `rows`
   */
  function registerLines(lines: Record<string, number>, options: { rows?: boolean } = {}) {
    const has = vi.fn((f: Feature) => f.id in lines);
    const hitTest = vi.fn<FeatureCompanionProvider['hitTest']>((f, point, context) => {
      const lat = lines[f.id];
      if (lat === undefined) return null;
      const from = context.project([0, lat]);
      const to = context.project([100, lat]);
      const on =
        Math.abs(point.y - from.y) <= context.tolerancePx &&
        point.x >= from.x - context.tolerancePx &&
        point.x <= to.x + context.tolerancePx;
      return on ? { id: `line-of-${f.id}` } : null;
    });
    const onCompanionClick = vi.fn<FeatureCompanionProvider['onCompanionClick']>();
    companions.register({
      id: 'lines',
      has,
      ...(options.rows && {
        hasRow: (_view: LayerTableView, handle: number) => {
          const id = tables.tables.getRowId(handle);
          return id !== undefined && id in lines;
        },
      }),
      draw: () => {},
      hitTest,
      onCompanionClick,
    });
    return { has, hitTest, onCompanionClick };
  }

  it('hits the companion of a row on its line, as a companion of the feature of the row', () => {
    layer('l');
    adopt('l', [feature('a', 'Polygon', square(0, 0)), feature('b', 'Polygon', square(20, 0))]);
    registerLines({ a: 50 });
    const hit = companionTester()(at(60, 50));
    expect(hit).toEqual({
      kind: 'companion',
      companion: { providerId: 'lines', featureId: 'a', hit: { id: 'line-of-a' } },
    });
    expect(companionTester()(at(60, 40))).toBeNull();
  });

  it('asks only the rows with a companion, and makes no feature for the others', () => {
    layer('l');
    adopt('l', [
      feature('a', 'Polygon', square(0, 0)),
      feature('b', 'Polygon', square(20, 0)),
      feature('c', 'Polygon', square(40, 0)),
    ]);
    const { has, hitTest } = registerLines({ b: 50 }, { rows: true });
    expect(companionTester()(at(60, 50))?.kind).toBe('companion');
    expect(has.mock.calls.map(([f]) => f.id)).toEqual(['b']);
    expect(hitTest.mock.calls.map(([f]) => f.id)).toEqual(['b']);
    expect(internalsOf(tables.tables).getOpenedFeature('b')).toBeUndefined();
  });

  it('asks a provider that answers from the features only on the features', () => {
    layer('l');
    adopt('l', [feature('a', 'Polygon', square(0, 0)), feature('b', 'Polygon', square(20, 0))]);
    const { hitTest } = registerLines({ a: 50 });
    expect(companionTester()(at(60, 50))?.kind).toBe('companion');
    expect(hitTest.mock.calls.map(([f]) => f.id)).toEqual(['a']);
  });

  it('lets a row win over its own companion, and over the companions behind it', () => {
    layer('l');
    adopt('l', [
      feature('back', 'Polygon', square(0, 0)),
      feature('front', 'Polygon', square(0, 40)),
    ]);
    // The line of the row behind passes under the row in front
    registerLines({ back: 45, front: 45 });
    expect(rowId(companionTester()(at(5, 45)))).toBe('front');
    expect(rowId(companionTester()(at(5, 5)))).toBe('back');
  });

  it('lets the companion of a row in front win over the rows behind it', () => {
    layer('l');
    adopt('l', [
      feature('back', 'Polygon', square(0, 0)),
      feature('front', 'Polygon', square(20, 20)),
    ]);
    registerLines({ front: 5 });
    const hit = companionTester()(at(5, 5));
    expect(hit?.kind === 'companion' && hit.companion.featureId).toBe('front');
  });

  it('lets a row in front of a layer win over the companions of the layer behind', () => {
    layer('below');
    layer('above');
    adopt('below', [feature('b', 'Polygon', square(20, 20))]);
    adopt('above', [feature('a', 'Polygon', square(0, 0))]);
    registerLines({ b: 5 });
    expect(rowId(companionTester()(at(5, 5)))).toBe('a');
    const hit = companionTester()(at(15, 5));
    expect(hit?.kind === 'companion' && hit.companion.featureId).toBe('b');
  });

  it('does not ask the companions of a hidden row, nor of the rows of a hidden layer', () => {
    layer('l');
    adopt('l', [
      feature('a', 'Polygon', square(0, 0)),
      feature('hidden', 'Polygon', square(20, 0), { visible: false }),
    ]);
    const { hitTest } = registerLines({ a: 50, hidden: 60 }, { rows: true });
    expect(companionTester()(at(60, 60))).toBeNull();
    expect(hitTest.mock.calls.map(([f]) => f.id)).toEqual(['a']);
    store.setLocallyHidden('l', true);
    expect(companionTester()(at(60, 50))).toBeNull();
    store.setLocallyHidden('l', false);
    store.updateLayer('l', { visible: false });
    expect(companionTester()(at(60, 50))).toBeNull();
  });

  it('does not hold the row of a companion hit, even when asked to hold', () => {
    layer('l');
    adopt('l', [feature('a', 'Polygon', square(0, 0))]);
    registerLines({ a: 50 });
    expect(companionTester()(at(60, 50), { hold: true })?.kind).toBe('companion');
    expect(internalsOf(tables.tables).getOpenedFeature('a')).toBeUndefined();
  });
});
