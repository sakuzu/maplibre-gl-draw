// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The features kept of rows (`feature-cache.ts`)
 *
 * - A row read again while it is not written gives the feature kept, through the Store and the
 *   view of its layer alike; a write of it makes it again
 * - A row written in the transaction under way is made every time it is read in it, and kept
 *   once the transaction ends
 * - A row held as a feature is not kept
 * - At most 1,024 features are kept, the one used longest ago going first; the features of the
 *   rows selected are kept besides, made when they are selected, and found by their ids
 * - A row deleted, read in another group, or gone with the rows, gives no feature kept
 * - The reads of many rows one after the other give what is kept and keep nothing more, and so
 *   does a build of every box of the rows
 * - A row tested as a feature by the hit testing is made once for the test and its distance
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDraw } from '../api/draw.js';
import type { Store as PublicStore } from '../api/extension/store.js';
import type { FeatureTables } from '../api/tables.js';
import { HitTestServiceImpl } from '../dispatcher/hit-test/service.js';
import { createTopmostHitTester } from '../dispatcher/hit-test/topmost.js';
import type { DrawStore } from '../store/draw-store.js';
import { featuresInOrder } from '../store/feature-stream.js';
import { RBushSpatialIndex } from '../store/spatial/spatial-index.js';
import { createTableStore } from '../store/table-memory.js';
import type { Feature } from '../store/types.js';
import { createMapStub } from '../test-utils.js';
import { type FeatureTablesInternals, featureTablesInternals } from './feature-tables.js';

function point(i: number): Feature {
  return {
    id: `p${i}`,
    type: 'Point',
    geometry: { type: 'Point', coordinates: [i * 0.001, 1] },
    layerId: 'a',
    groupId: undefined,
    properties: { n: i },
    style: {},
    visible: true,
    locked: false,
  };
}

/** A Store of rows with points in a layer `a` */
function storeWith(count: number) {
  const { store, writer } = createTableStore();
  store.createLayer({
    id: 'a',
    name: 'a',
    visible: true,
    locked: false,
    opacity: 1,
    kind: 'table',
    styleRule: undefined,
    metadata: undefined,
  });
  store.createFeatures(Array.from({ length: count }, (_, i) => point(i)));
  const tables = store.tables as FeatureTables;
  const internals = featureTablesInternals(tables) as FeatureTablesInternals;
  internals.addQueuedRowBlocks();
  internals.flushVersions();
  const cache = internals.featureCache;
  cache.clear();
  const rowOf = (id: string): Feature | undefined =>
    tables.get('a')?.getRow(tables.findRow(id) as number);
  return { store: store as DrawStore, writer, tables, internals, cache, rowOf };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the features kept of rows', () => {
  it('gives the feature kept while its row is not written, and makes it again after a write', () => {
    const { store, cache, rowOf } = storeWith(3);
    const read = store.getFeature('p1');
    expect(store.getFeature('p1')).toBe(read);
    // The view of the layer reads the same rows
    expect(rowOf('p1')).toBe(read);
    expect(cache.size).toBe(1);
    store.updateFeature('p1', { properties: { n: 10 } });
    const again = store.getFeature('p1');
    expect(again).not.toBe(read);
    expect(again?.properties).toEqual({ n: 10 });
    expect(store.getFeature('p1')).toBe(again);
    // A write of another row leaves it
    store.updateFeature('p2', { properties: { n: 20 } });
    expect(store.getFeature('p1')).toBe(again);
  });

  it('makes a row written in the transaction under way every time, and keeps it after', () => {
    const { store } = storeWith(3);
    const other = store.getFeature('p2');
    let last: Feature | undefined;
    store.transact(() => {
      store.updateFeature('p1', { properties: { n: 10 } });
      const first = store.getFeature('p1');
      expect(store.getFeature('p1')).not.toBe(first);
      // Written again under the same mark: the second value is read
      store.updateFeature('p1', { properties: { n: 11 } });
      last = store.getFeature('p1');
      expect(last?.properties).toEqual({ n: 11 });
      // A row not written in it is kept as before
      expect(store.getFeature('p2')).toBe(other);
    });
    const after = store.getFeature('p1');
    expect(after).not.toBe(last);
    expect(after?.properties).toEqual({ n: 11 });
    expect(store.getFeature('p1')).toBe(after);
  });

  it('gives the feature of a row selected as of any row', () => {
    const { store, rowOf } = storeWith(3);
    store.setSelection('feature', ['p1']);
    const read = store.getFeature('p1');
    expect(store.getFeature('p1')).toBe(read);
    expect(rowOf('p1')).toBe(read);
  });

  it('keeps 1,024 features at most, the one used longest ago going first', () => {
    const { store, cache } = storeWith(1100);
    const first = store.getFeature('p0');
    const second = store.getFeature('p1');
    for (let i = 2; i < 1024; i++) store.getFeature(`p${i}`);
    expect(cache.size).toBe(1024);
    // p0 used again: p1 is the one used longest ago
    expect(store.getFeature('p0')).toBe(first);
    store.getFeature('p1024');
    expect(cache.size).toBe(1024);
    expect(store.getFeature('p0')).toBe(first);
    const made = store.getFeature('p1');
    expect(made).not.toBe(second);
    expect(made).toEqual(second);
  });

  it('keeps the features of the rows selected besides the 1,024, while they are selected', () => {
    const { store, cache } = storeWith(3100);
    const ids = Array.from({ length: 2000 }, (_, i) => `p${i}`);
    // Made when they are selected
    store.setSelection('feature', ids);
    expect(cache.size).toBe(2000);
    const read = ids.map((id) => store.getFeature(id));
    // Other reads do not push them out
    for (let i = 2000; i < 3100; i++) store.getFeature(`p${i}`);
    expect(cache.size).toBe(2000 + 1024);
    ids.forEach((id, i) => {
      expect(store.getFeature(id)).toBe(read[i]);
    });
    // No longer selected: they go into the order of use, as used last
    store.setSelection('feature', ['p2500']);
    expect(cache.size).toBe(1 + 1024);
    expect(store.getFeature('p1999')).toBe(read[1999]);
    expect(store.getFeature('p0')).not.toBe(read[0]);
    store.setSelection(null, []);
    expect(cache.size).toBe(1024);
  });

  it('finds a row selected by its id while its row has the version it was made of', () => {
    const { store, internals } = storeWith(5);
    store.setSelection('feature', ['p1', 'p2', 'p3']);
    const read = store.getFeature('p1');
    expect(store.getFeature('p1')).toBe(read);
    // Written: made again, and kept as before once the write is over
    store.updateFeature('p1', { properties: { n: 10 } });
    const written = store.getFeature('p1');
    expect(written).not.toBe(read);
    expect(written?.properties).toEqual({ n: 10 });
    expect(store.getFeature('p1')).toBe(written);
    // Written in the transaction under way: the value written is read each time
    store.transact(() => {
      store.updateFeature('p2', { properties: { n: 20 } });
      expect(store.getFeature('p2')?.properties).toEqual({ n: 20 });
      store.updateFeature('p2', { properties: { n: 21 } });
      expect(store.getFeature('p2')?.properties).toEqual({ n: 21 });
    });
    expect(store.getFeature('p2')?.properties).toEqual({ n: 21 });
    // Put into the delta: the same values
    const before = store.getFeature('p3');
    store.transact(() => internals.toDelta([internals.ids.handleOf('p3')]));
    expect(store.getFeature('p3')).toEqual(before);
    // Deleted: none
    store.deleteFeature('p3');
    expect(store.getFeature('p3')).toBeUndefined();
    expect(store.tables?.findRow('p3')).toBeUndefined();
    // Created again under the same id: the row made now
    store.createFeature({ ...point(3), properties: { n: 30 } });
    expect(store.getFeature('p3')?.properties).toEqual({ n: 30 });
  });

  it('gives the same value of a selection listed by IDs until the IDs or the rows change', () => {
    const { store } = storeWith(5);
    const draw = createDraw(createMapStub().map, {
      store: store as unknown as PublicStore,
      initDefaultLayer: false,
    });
    store.updateFeature('p4', { visible: false });
    // Checked on the rows: an unknown ID throws, a hidden feature is not selected
    expect(() => draw.selection.set('feature', ['p1', 'missing'])).toThrow();
    expect(draw.selection.set('feature', ['p4'])).toBe(false);
    expect(draw.selection.set('feature', ['p2', 'p1', 'p4'])).toBe(true);
    const value = draw.selection.value;
    expect(value).toMatchObject({ count: 2, ids: ['p2', 'p1'], layerIds: ['a'] });
    expect(value.bbox).toEqual([0.001, 1, 0.002, 1]);
    expect(draw.selection.value).toBe(value);
    // A row of another feature written: the same value
    store.updateFeature('p3', { properties: { n: 30 } });
    const after = draw.selection.value;
    expect(after).toEqual(value);
    expect(draw.selection.value).toBe(after);
    // A feature selected moved: its extent
    store.updateFeature('p2', { geometry: { type: 'Point', coordinates: [5, 6] } });
    expect(draw.selection.value.bbox).toEqual([0.001, 1, 5, 6]);
    // Another selection of the same IDs reads the same
    draw.selection.set('feature', ['p2', 'p1']);
    expect(draw.selection.value).toMatchObject({ count: 2, bbox: [0.001, 1, 5, 6] });
    store.deleteFeature('p1');
    expect(draw.selection.value).toMatchObject({ count: 1, ids: ['p2'], bbox: [5, 6, 5, 6] });
    draw.destroy();
  });

  it('gives nothing kept for a row deleted, read in another group, or gone with the rows', () => {
    const { store, writer, internals, cache } = storeWith(3);
    store.getFeature('p0');
    store.deleteFeature('p0');
    expect(store.getFeature('p0')).toBeUndefined();
    // Put into the delta without a write of values (no mark raised): forgotten
    const read = store.getFeature('p1');
    store.transact(() => internals.toDelta([internals.ids.handleOf('p1')]));
    const inDelta = store.getFeature('p1');
    expect(inDelta).not.toBe(read);
    expect(inDelta).toEqual(read);
    expect(store.getFeature('p1')).toBe(inDelta);
    // Taken into the next version of its group, with the mark it had
    internals.flushVersions();
    const inGroup = store.getFeature('p1');
    expect(inGroup).not.toBe(inDelta);
    expect(inGroup).toEqual(read);
    // The rows gone, and rows of the same ids (the same handles) written again
    store.getFeature('p2');
    writer.clear();
    expect(cache.size).toBe(0);
    expect(store.getFeature('p2')).toBeUndefined();
    store.createFeature({ ...point(2), properties: { n: 200 } });
    expect(store.getFeature('p2')?.properties).toEqual({ n: 200 });
  });

  it('gives what is kept to the reads of many rows, which keep nothing more', () => {
    const { store, cache } = storeWith(2000);
    const draw = createDraw(createMapStub().map, {
      store: store as unknown as PublicStore,
      initDefaultLayer: false,
    });
    const kept = draw.features.get('p5');
    expect(draw.features.getMany(['p6', 'p7'])).toEqual([
      store.getFeature('p6'),
      store.getFeature('p7'),
    ]);
    expect(cache.size).toBe(3);
    let after: string | undefined;
    let listed = 0;
    for (;;) {
      const page = draw.features.list(undefined, { limit: 500, after });
      listed += page.length;
      if (page.some((feature) => feature.id === 'p5')) {
        expect(page.find((feature) => feature.id === 'p5')).toBe(kept);
      }
      if (page.length < 500) break;
      after = page[page.length - 1].id;
    }
    expect(listed).toBe(2000);
    expect(cache.size).toBe(3);
    let read = 0;
    for (const feature of featuresInOrder(store)) {
      read++;
      if (feature.id === 'p5') expect(feature).toBe(kept);
    }
    expect(read).toBe(2000);
    expect(cache.size).toBe(3);
    draw.destroy();
  });

  it('keeps none of the features a build of every box makes, and the one of a row marked', () => {
    const { store, internals, cache } = storeWith(10);
    const calculated: Feature[] = [];
    internals.setRowBoxCalculator('Point', (feature) => {
      calculated.push(feature);
      const [x, y] = (feature.geometry as { coordinates: number[] }).coordinates;
      return { minX: x - 1, minY: y - 1, maxX: x + 1, maxY: y + 1 };
    });
    expect(internals.rowBoxIndexSize().rows).toBe(10);
    expect(calculated).toHaveLength(10);
    expect(cache.size).toBe(0);
    // A row written is marked, and its box read alone: its feature is kept
    store.updateFeature('p3', { properties: { n: 30 } });
    internals.rowBoxIndexSize();
    expect(cache.size).toBe(1);
    expect(store.getFeature('p3')).toBe(calculated[calculated.length - 1]);
  });

  it('marks no box a write of the attributes of a row leaves as it is', () => {
    const { store, internals } = storeWith(10);
    const boxes = (internals as unknown as { rowBoxes: { mark(): void; markOne(): void } })
      .rowBoxes;
    expect(internals.rowBoxIndexSize().rows).toBe(10);
    const marks = [vi.spyOn(boxes, 'mark'), vi.spyOn(boxes, 'markOne')];
    const marked = () => marks.reduce((n, spy) => n + spy.mock.calls.length, 0);
    store.updateFeature('p3', { properties: { n: 30 } });
    expect(marked()).toBe(0);
    store.updateFeature('p3', {
      geometry: { type: 'Point', coordinates: [50, 50] },
    });
    expect(marked()).toBeGreaterThan(0);
    // The box of a type is told of the attributes it may read
    const seen: number[] = [];
    internals.setRowBoxCalculator('Point', (feature) => {
      seen.push(feature.properties.n as number);
      const [x, y] = (feature.geometry as { coordinates: number[] }).coordinates;
      return { minX: x - 1, minY: y - 1, maxX: x + 1, maxY: y + 1 };
    });
    internals.rowBoxIndexSize();
    seen.length = 0;
    store.updateFeature('p3', { properties: { n: 31 } });
    internals.rowBoxIndexSize();
    expect(seen).toEqual([31]);
  });

  it('makes a row tested as a feature once, for the test and for its distance', () => {
    const { store, cache } = storeWith(0);
    store.createFeature({
      ...point(0),
      id: 'line',
      type: 'LineString',
      geometry: {
        type: 'LineString',
        coordinates: [
          [0, 0],
          [10, 0],
        ],
      },
    });
    // The distance of a feature is measured through the spatial index of the features
    const index = new RBushSpatialIndex();
    vi.spyOn(index, 'findNear').mockReturnValue(['line']);
    const service = new HitTestServiceImpl(store, index);
    const seen: Feature[] = [];
    // A strategy of the type: the row is tested as a feature, not by its shape
    service.registerStrategy({
      geometryType: 'LineString',
      test: (feature, at) => {
        seen.push(feature);
        return Math.abs(at[1]) < 0.5;
      },
      distance: (feature, at) => {
        seen.push(feature);
        return Math.abs(at[1]);
      },
    });
    const hitTest = createTopmostHitTester({
      store,
      hitTestService: service,
      unproject: (p) => ({ lng: p.x / 10, lat: -p.y / 10 }),
      toleranceLngLat: () => 0.5,
      getZoom: () => 3,
    });
    const hit = hitTest({ x: 50, y: -2 });
    if (hit?.kind !== 'row') throw new Error('a row');
    expect(hit.distancePx()).toBeGreaterThan(0);
    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(new Set(seen).size).toBe(1);
    expect(store.getFeature('line')).toBe(seen[0]);
    expect(cache.size).toBe(1);
  });
});
