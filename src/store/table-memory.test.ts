// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The in-memory Store of rows (`createTableMemoryStore`)
 *
 * - Its layers and groups are held as rows; its features are rows, read from its tables, and a
 *   row is a feature while it is held (selected, edited)
 * - A write of a feature not held writes its row and is notified as a change of the row; one of a
 *   feature held is notified as a change of the feature. A row is in a notification once, as it
 *   is when the transaction ends: a row created and selected in one transaction is a feature
 *   created
 * - The selection, the editing and the vertices selected hold their rows, and let go of them a
 *   moment later; more than the limit is refused
 * - A row held deleted from elsewhere leaves the selection, in `features.deleted`, never in
 *   `held.removed`
 * - The values in the middle of a drag are shown; the values written from elsewhere meanwhile
 *   are kept for when it ends, and an undone drag shows them
 */

import { describe, expect, it, vi } from 'vitest';
import type { RowField } from '../api/tables.js';
import { HOLD_LIMIT, RELEASE_DELAY_MS } from './draw-store.js';
import { createTableMemoryStore } from './table-memory.js';
import type { Feature, StoreChange } from './types.js';

/** A point of the tests */
function point(id: string, x: number, extra: Partial<Feature> = {}): Feature {
  return {
    id,
    type: 'Point',
    geometry: { type: 'Point', coordinates: [x, 0] },
    layerId: 'layer',
    groupId: undefined,
    properties: { n: x },
    style: {},
    visible: true,
    locked: false,
    ...extra,
  };
}

/** A Store of rows with a layer and points in it, and its notifications gathered */
function setup(count = 5) {
  const { store, writer } = createTableMemoryStore();
  store.createLayer({
    id: 'layer',
    name: 'Layer',
    visible: true,
    locked: false,
    opacity: 1,
    items: [],
    metadata: undefined,
    styleRule: undefined,
  });
  for (let i = 0; i < count; i++) store.createFeature(point(`p${i}`, i));
  const notified: StoreChange[] = [];
  store.subscribe((change) => notified.push(change));
  const tables = store.tables;
  if (!tables) throw new Error('a Store of rows has tables');
  return { store, writer, tables, notified };
}

describe('the in-memory Store of rows', () => {
  it('holds its layers as rows, and reads its features from the rows', () => {
    const { store, tables } = setup();
    expect(store.getLayer('layer')?.kind).toBe('table');
    expect(store.getLayer('layer')).not.toHaveProperty('items');
    expect(store.getFeature('p2')?.geometry).toEqual({ type: 'Point', coordinates: [2, 0] });
    // A row not held is read anew every time
    expect(store.getFeature('p2')).not.toBe(store.getFeature('p2'));
    expect(() => store.listFeatures()).toThrow();
    expect(() => store.listFeaturesInOrder()).toThrow();
    const view = tables.layer('layer');
    const order = Array.from(view?.rowsInOrder(0, 10) ?? [], (h) => tables.idOf(h));
    expect(order).toEqual(['p0', 'p1', 'p2', 'p3', 'p4']);
  });

  it('notifies the writes of rows not held as changes of rows', () => {
    const { store, tables, notified } = setup();
    store.updateFeature('p1', { properties: { n: 10 } });
    store.deleteFeature('p2');
    expect(notified).toHaveLength(2);
    const handle = (id: string) => tables.handleOf(id) ?? -1;
    expect(notified[0].features).toBeUndefined();
    expect(Array.from(notified[0].rows?.layers.get('layer')?.updated ?? [])).toEqual([
      handle('p1'),
    ]);
    expect(notified[1].rows?.layers.get('layer')?.deleted.length).toBe(1);
    expect(store.getFeature('p1')?.properties).toEqual({ n: 10 });
    expect(store.getFeature('p2')).toBeUndefined();
  });

  it('holds the rows selected, and notifies the writes of them as changes of features', () => {
    const { store, notified } = setup();
    store.setSelection('feature', ['p1', 'p3']);
    const held = notified[notified.length - 1]?.held;
    expect(held?.added.map((f) => f.id)).toEqual(['p1', 'p3']);
    const p1 = store.getFeature('p1');
    expect(store.getFeature('p1')).toBe(p1);
    notified.length = 0;
    store.updateFeature('p1', { geometry: { type: 'Point', coordinates: [9, 9] } });
    expect(notified).toHaveLength(1);
    expect(notified[0].rows).toBeUndefined();
    expect(notified[0].features?.updated?.map((e) => e.id)).toEqual(['p1']);
    expect(notified[0].features?.updated?.[0].previous).toBe(p1);
    vi.useFakeTimers();
    store.setSelection(null, []);
    // Let go a moment later (a quick click elsewhere and back makes no feature again)
    expect(store.getFeature('p1')).toBe(store.getFeature('p1'));
    vi.advanceTimersByTime(RELEASE_DELAY_MS);
    vi.useRealTimers();
    expect(notified[notified.length - 1]?.held).toEqual({ added: [], removed: ['p1', 'p3'] });
    expect(store.getFeature('p1')?.geometry).toEqual({ type: 'Point', coordinates: [9, 9] });
  });

  it('keeps a row let go of held when it is selected again within a moment', () => {
    const { store, notified } = setup();
    vi.useFakeTimers();
    store.setSelection('feature', ['p1']);
    const p1 = store.getFeature('p1');
    store.setSelection('feature', ['p2']);
    store.setSelection('feature', ['p1']);
    expect(store.getFeature('p1')).toBe(p1);
    vi.advanceTimersByTime(RELEASE_DELAY_MS);
    vi.useRealTimers();
    expect(store.getFeature('p1')).toBe(p1);
    const removed = notified.flatMap((change) => change.held?.removed ?? []);
    expect(removed).toEqual(['p2']);
  });

  it('notifies a feature created and selected in one transaction as a feature created', () => {
    const { store, notified } = setup();
    store.transact(() => {
      store.createFeature(point('n', 50));
      store.setSelection('feature', ['n']);
    });
    expect(notified).toHaveLength(1);
    expect(notified[0].rows).toBeUndefined();
    expect(notified[0].features?.created?.map((f) => f.id)).toEqual(['n']);
    expect(notified[0].held?.added ?? []).toEqual([]);
    expect(notified[0].selection?.ids).toEqual(['n']);
  });

  it('takes a row held deleted from elsewhere out of the selection, as a feature deleted', () => {
    const { store, writer, tables, notified } = setup();
    store.setSelection('feature', ['p2']);
    notified.length = 0;
    store.transact(() => {
      writer.apply({
        handles: Int32Array.of(tables.handleOf('p2') ?? -1),
        fields: new Map(),
        deleted: Uint8Array.of(1),
      });
    }, 'remote');
    expect(notified).toHaveLength(1);
    expect(notified[0].source).toBe('remote');
    expect(notified[0].features?.deleted?.map((f) => f.id)).toEqual(['p2']);
    expect(notified[0].held?.removed ?? []).toEqual([]);
    expect(notified[0].rows).toBeUndefined();
    expect(store.getSelection().ids).toEqual([]);
  });

  it('shows a drag in its middle, and an undone drag shows what others wrote meanwhile', () => {
    const { store, writer, tables } = setup();
    store.setSelection('feature', ['p3']);
    const at = (x: number) => ({ type: 'Point' as const, coordinates: [x, 3] });
    store.updateFeature('p3', { geometry: at(30) }, { isIntermediate: true });
    expect(store.getFeature('p3')?.geometry).toEqual(at(30));
    // Another moves it and colors it meanwhile
    store.transact(() => {
      writer.apply({
        handles: Int32Array.of(tables.handleOf('p3') ?? -1),
        fields: new Map<RowField, unknown[]>([
          ['geometry', [at(-3)]],
          ['style', [{ pointColor: '#00ff00' }]],
        ]),
      });
    }, 'remote');
    expect(store.getFeature('p3')?.geometry).toEqual(at(30));
    expect(store.getFeature('p3')?.style).toEqual({ pointColor: '#00ff00' });
    // The drag writes the values it started from and is undone
    store.updateFeature('p3', { geometry: at(3) }, { isIntermediate: true });
    store.abortIntermediateUpdates?.(['p3']);
    expect(store.getFeature('p3')?.geometry).toEqual(at(-3));
    expect(store.getFeature('p3')?.style).toEqual({ pointColor: '#00ff00' });
  });

  it('writes the end of a drag over what others wrote meanwhile', () => {
    const { store, writer, tables } = setup();
    store.setSelection('feature', ['p3']);
    const at = (x: number) => ({ type: 'Point' as const, coordinates: [x, 3] });
    store.updateFeature('p3', { geometry: at(30) }, { isIntermediate: true });
    store.transact(() => {
      writer.apply({
        handles: Int32Array.of(tables.handleOf('p3') ?? -1),
        fields: new Map<RowField, unknown[]>([['geometry', [at(-3)]]]),
      });
    }, 'remote');
    store.updateFeature('p3', { geometry: at(31) });
    store.setSelection(null, []);
    expect(store.getFeature('p3')?.geometry).toEqual(at(31));
  });

  it('refuses a selection of more rows than the limit', () => {
    const { store } = setup(0);
    const ids: string[] = [];
    store.transact(() => {
      for (let i = 0; i <= HOLD_LIMIT; i++) {
        store.createFeature(point(`q${i}`, i));
        ids.push(`q${i}`);
      }
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    store.setSelection('feature', ids);
    expect(store.getSelection().ids).toEqual([]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
    store.setSelection('feature', ids.slice(0, HOLD_LIMIT));
    expect(store.getSelection().ids).toHaveLength(HOLD_LIMIT);
  });

  it('holds the members of a group selected', () => {
    const { store, notified } = setup(0);
    store.createGroup({
      id: 'g',
      layerId: 'layer',
      name: 'G',
      visible: true,
      locked: false,
      kind: 'table',
    });
    store.createFeature(point('a', 1, { groupId: 'g' }));
    store.createFeature(point('b', 2, { groupId: 'g' }));
    store.createFeature(point('c', 3));
    notified.length = 0;
    store.setSelection('group', ['g']);
    expect(notified[notified.length - 1]?.held?.added.map((f) => f.id)).toEqual(['a', 'b']);
  });
});
