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
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createFeatureTablesStore,
  featureTablesInternals,
} from '../../feature-table/feature-tables.js';
import { DrawStore, RELEASE_DELAY_MS } from '../../store/draw-store.js';
import { MemoryContractStore } from '../../store/memory.js';
import { RBushSpatialIndex } from '../../store/spatial/spatial-index.js';
import type { Feature } from '../../store/types.js';
import { createRowGroupBuilder } from '../../table/row-group-builder.js';
import { feature, internalsOf, orderKey, rowOfFeature } from '../../test-utils.js';
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
  const builder = createRowGroupBuilder({ targetRows: 2 });
  features.forEach((f, i) => {
    builder.addRow(rowOfFeature(f, orderKey(i)));
  });
  tables.writer.adopt(layerId, builder.finish());
  featureTablesInternals(tables.tables)?.flushAdoption();
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
    expect(hit.handle).toBe(tables.tables.handleOf('front'));
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
    internals?.states.setHidden(Int32Array.of(tables.tables.handleOf('back') as number), true);
    expect(tester()(at(5, 5))).toBeNull();
    internals?.states.setHidden(Int32Array.of(tables.tables.handleOf('back') as number), false);
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
    const held = internalsOf(tables.tables).heldFeature('p');
    expect(held).toBeDefined();
    expect(hit?.kind === 'store' && hit.feature).toBe(held);
    // The selection holds it before the moment is over
    store.setSelection('feature', ['p']);
    vi.advanceTimersByTime(POINTER_HOLD_MS);
    expect(internalsOf(tables.tables).heldFeature('p')).toBe(held);
    store.setSelection(null, []);
    // Let go a moment after the selection lets go of it
    vi.advanceTimersByTime(RELEASE_DELAY_MS);
    expect(internalsOf(tables.tables).heldFeature('p')).toBeUndefined();
    // Without the selection it is let go after the moment
    tester()(at(5, 5), { hold: true });
    expect(internalsOf(tables.tables).heldFeature('p')).toBeDefined();
    vi.advanceTimersByTime(POINTER_HOLD_MS);
    expect(internalsOf(tables.tables).heldFeature('p')).toBeUndefined();
  });

  it('returns a row held as a feature of the Store, held or not by the hit', () => {
    layer('l');
    adopt('l', [feature('p', 'Polygon', square(0, 0))]);
    internalsOf(tables.tables).hold(POINTER_OWNER, []);
    store.setSelection('feature', ['p']);
    const hit = tester()(at(5, 5));
    expect(hit?.kind).toBe('store');
    expect(hit?.kind === 'store' && hit.feature).toBe(internalsOf(tables.tables).heldFeature('p'));
  });
});
