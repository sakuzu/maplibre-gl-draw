// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What the undo of a Store of rows relies on: the rows a deletion of this client deletes are kept
 * by the token of the notification until it is let go of, a deleted row written not deleted is back
 * where it was, the values of rows read and written back through the Store (`restoreRows`) put the
 * rows back, a layer deleted and created again gets its rows back, and the ids of the rows deleted
 * that nothing keeps are forgotten (a handle is given again), with no growth over a long run of
 * imports and deletions
 */

import { describe, expect, it } from 'vitest';
import type { FeatureTables, FeatureTablesWriter, RowField } from '../api/tables.js';
import { featureTablesInternals } from '../feature-table/feature-tables.js';
import { createTableStore, REMOTE_DELETED_KEPT } from './table-memory.js';
import type { Feature, RestoreToken, StoreChange } from './types.js';

function point(id: string, x: number, layerId = 'layer'): Feature {
  return {
    id,
    type: 'Point',
    geometry: { type: 'Point', coordinates: [x, 0] },
    layerId,
    groupId: undefined,
    properties: { n: x },
    style: {},
    visible: true,
    locked: false,
  };
}

function setup(count = 6, options: Parameters<typeof createTableStore>[0] = {}) {
  const { store, writer } = createTableStore(options);
  store.createLayer({
    id: 'layer',
    name: 'Layer',
    visible: true,
    locked: false,
    opacity: 1,
    kind: 'table',
    metadata: undefined,
    styleRule: undefined,
  });
  for (let i = 0; i < count; i++) store.createFeature(point(`p${i}`, i));
  const tables = store.tables as FeatureTables;
  const notified: StoreChange[] = [];
  store.subscribe((change) => notified.push(change));
  return { store, writer, tables, notified, internals: featureTablesInternals(tables) };
}

/** The ids of the rows of a layer in their order, the deleted ones included until dropped */
function rowsOf(tables: FeatureTables, layerId = 'layer'): string[] {
  const view = tables.get(layerId);
  return Array.from(view?.listRowHandles(0, 1_000_000) ?? [], (h) => tables.getRowId(h) as string);
}

/** The ids of the rows not deleted of a layer */
function liveOf(tables: FeatureTables, layerId = 'layer'): string[] {
  const out: string[] = [];
  const cursor = tables.scan({ layerIds: [layerId] });
  for (let batch = cursor.next(); batch; batch = cursor.next()) {
    for (const handle of batch) out.push(tables.getRowId(handle) as string);
  }
  return out;
}

describe('the deletions of this client kept', () => {
  it('keep the rows deleted through the next versions until the token is let go of', () => {
    const { store, writer, tables, notified, internals } = setup();
    const handle = tables.getRowRef('p2') as number;
    store.deleteFeature('p2');
    const retain = notified[0].restoreToken as RestoreToken;
    expect(retain).toBeDefined();
    expect(writer.lookup('p2')).toEqual({ handle, deleted: true });
    internals?.flushVersions();
    expect(rowsOf(tables)).toContain('p2');
    // Written not deleted, it is back where it was
    store.transact(() =>
      writer.writeRows({
        handles: Int32Array.of(handle),
        fields: new Map(),
        deleted: Uint8Array.of(0),
      }),
    );
    expect(liveOf(tables)).toEqual(['p0', 'p1', 'p2', 'p3', 'p4', 'p5']);
    // Deleted again and let go of: the next version leaves it out, and its id is forgotten
    store.deleteFeature('p2');
    const again = notified[notified.length - 1].restoreToken as RestoreToken;
    tables.release(again);
    tables.release(retain);
    internals?.flushVersions();
    expect(rowsOf(tables)).not.toContain('p2');
    expect(writer.lookup('p2')).toBeUndefined();
    // The handle is given again to a new id
    const [next] = writer.allocateHandles({
      offsets: Int32Array.of(0, 3),
      bytes: new TextEncoder().encode('new'),
    });
    expect(next).toBe(handle);
  });

  it('keep a feature selected deleted, with the token in the notification of its row deleted', () => {
    const { store, tables, notified, internals } = setup();
    store.setSelection('feature', ['p3']);
    notified.length = 0;
    store.deleteFeature('p3');
    const deleted = [...(notified[0].rows?.layers.values() ?? [])].flatMap((rows) =>
      Array.from(rows.deleted, (handle) => tables.getRowId(handle)),
    );
    expect(deleted).toEqual(['p3']);
    expect(notified[0].restoreToken).toBeDefined();
    expect(store.getSelection().ids).toEqual([]);
    internals?.flushVersions();
    expect(rowsOf(tables)).toContain('p3');
  });

  it('keep every deletion until its token is let go of, however many', () => {
    const { store, tables, internals, notified } = setup(8);
    notified.length = 0;
    for (let i = 0; i < 6; i++) store.deleteFeature(`p${i}`);
    internals?.flushVersions();
    expect(rowsOf(tables)).toEqual(['p0', 'p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7']);
    // Let go of, the rows of the first three go with the next version
    for (const change of notified.slice(0, 3)) {
      tables.release(change.restoreToken as NonNullable<typeof change.restoreToken>);
    }
    internals?.flushVersions();
    expect(rowsOf(tables)).toEqual(['p3', 'p4', 'p5', 'p6', 'p7']);
  });

  it('give a layer deleted and created again its rows and groups back where they were', () => {
    const { store, writer, tables, notified, internals } = setup();
    store.createGroup({
      id: 'g',
      layerId: 'layer',
      name: 'g',
      featureIds: ['p1', 'p2'],
      visible: true,
      locked: false,
    });
    const layer = store.getLayer('layer');
    const handles = Array.from(['p0', 'p1', 'p2', 'p3'], (id) => tables.getRowRef(id) as number);
    notified.length = 0;
    store.deleteLayer('layer');
    expect(store.getLayer('layer')).toBeUndefined();
    expect(notified[0].restoreToken).toBeDefined();
    const deleted = [...(notified[0].rows?.layers.get('layer')?.deleted ?? [])];
    internals?.flushVersions();
    // Undone: the layer, its group, and its rows not deleted
    store.transact(() => {
      store.createLayer(layer as NonNullable<typeof layer>);
      store.createGroup({
        id: 'g',
        layerId: 'layer',
        name: 'g',
        kind: 'table',
        visible: true,
        locked: false,
      });
      store.restoreRows({
        handles: Int32Array.from(deleted),
        fields: new Map(),
        deleted: new Uint8Array(deleted.length),
      });
    });
    expect(liveOf(tables)).toEqual(['p0', 'p1', 'p2', 'p3', 'p4', 'p5']);
    expect(Array.from(['p0', 'p1', 'p2', 'p3'], (id) => tables.getRowRef(id))).toEqual(handles);
    expect(store.getFeature('p1')?.groupId).toBe('g');
    expect(writer.lookup('p1')?.deleted).toBe(false);
  });
});

describe('the rows written for this client through the Store', () => {
  it('read the values before, notify them, and put the rows back when written back', () => {
    const { store, tables, notified } = setup();
    const handles = Int32Array.from(['p1', 'p3'], (id) => tables.getRowRef(id) as number);
    const patch = {
      handles,
      fields: new Map<RowField, unknown[]>([
        ['style', [{ pointColor: '#ff0000' }, { pointColor: '#00ff00' }]],
        ['properties:n', [10, 30]],
        ['geometry', [{ type: 'Point', coordinates: [9, 9] }, undefined]],
      ]),
    };
    notified.length = 0;
    const before = store.restoreRows(patch);
    expect(before?.fields.get('properties:n')).toEqual([1, 3]);
    expect(before?.fields.get('style')).toEqual([{}, {}]);
    expect(notified).toHaveLength(1);
    expect(notified[0].previousValues).toBe(before);
    expect(store.getFeature('p1')?.properties).toEqual({ n: 10 });
    expect(store.getFeature('p1')?.geometry).toEqual({ type: 'Point', coordinates: [9, 9] });
    // Written back
    store.restoreRows(before as NonNullable<typeof before>);
    expect(store.getFeature('p1')?.properties).toEqual({ n: 1 });
    expect(store.getFeature('p1')?.style).toEqual({});
    expect(store.getFeature('p1')?.geometry).toEqual({ type: 'Point', coordinates: [1, 0] });
    expect(store.getFeature('p3')?.properties).toEqual({ n: 3 });
  });

  it('are refused while read-only', () => {
    const { store, tables } = setup();
    store.setReadOnly(true);
    const handle = tables.getRowRef('p1') as number;
    expect(
      store.restoreRows({
        handles: Int32Array.of(handle),
        fields: new Map([['properties:n', [5]]]),
      }),
    ).toBeNull();
    expect(store.getFeature('p1')?.properties).toEqual({ n: 1 });
  });

  it('put rows in a place with keys made at once, and new rows after them', () => {
    const { store, tables } = setup();
    const handles = Int32Array.from(['p4', 'p5'], (id) => tables.getRowRef(id) as number);
    store.applyRows({
      patch: { handles: new Int32Array(0), fields: new Map() },
      created: {
        ids: { offsets: Int32Array.of(0, 2), bytes: new TextEncoder().encode('q0') },
        fields: new Map<RowField, unknown[]>([
          ['type', ['Point']],
          ['geometry', [{ type: 'Point', coordinates: [7, 7] }]],
        ]),
      },
      place: { rows: handles, to: { layerId: 'layer', below: 'p0' } },
      before: { handles: new Int32Array(0), fields: new Map() },
    });
    expect(liveOf(tables)).toEqual(['p0', 'p4', 'p5', 'q0', 'p1', 'p2', 'p3']);
  });
});

describe('the rows deleted from elsewhere', () => {
  it('are not kept by a token, whether a feature or a layer is deleted through the Store', () => {
    const { store, writer, notified } = setup();
    store.transact(() => store.deleteFeature('p1'), 'remote');
    expect(notified[notified.length - 1].restoreToken).toBeUndefined();
    store.createLayer({
      id: 'other',
      name: 'Other',
      visible: true,
      locked: false,
      opacity: 1,
      kind: 'table',
      metadata: undefined,
      styleRule: undefined,
    });
    store.createFeature(point('q', 0, 'other'));
    store.transact(() => store.deleteLayer('other'), 'remote');
    expect(notified[notified.length - 1].restoreToken).toBeUndefined();
    // Nothing keeps them: their ids can be forgotten
    const handles = ['p1', 'q'].map((id) => writer.lookup(id)?.handle as number);
    writer.forget(Int32Array.from(handles));
    expect(writer.lookup('p1')).toBeUndefined();
    expect(writer.lookup('q')).toBeUndefined();
    // A deletion of this client is kept
    store.deleteFeature('p2');
    expect(notified[notified.length - 1].restoreToken).toBeDefined();
    writer.forget(Int32Array.of(writer.lookup('p2')?.handle as number));
    expect(writer.lookup('p2')).toMatchObject({ deleted: true });
  });

  it('have their ids forgotten past the most kept, the handles given again', () => {
    const { store, writer, tables, internals } = setup(0);
    const write = (fn: (w: FeatureTablesWriter) => void) =>
      store.transact(() => fn(writer), 'remote');
    let live = 0;
    for (let round = 0; round < 6; round++) {
      // An import of others, then its deletion
      const ids = Array.from({ length: 4000 }, (_, i) => `r${round}-${i}`);
      const encoder = new TextEncoder();
      const parts = ids.map((id) => encoder.encode(id));
      const offsets = new Int32Array(ids.length + 1);
      for (let i = 0; i < parts.length; i++) offsets[i + 1] = offsets[i] + parts[i].length;
      const bytes = new Uint8Array(offsets[ids.length]);
      parts.forEach((part, i) => {
        bytes.set(part, offsets[i]);
      });
      const handles = writer.allocateHandles({ offsets, bytes });
      write((w) =>
        w.writeRows({
          handles,
          fields: new Map<RowField, unknown[]>([
            ['type', ids.map(() => 'Point')],
            ['parent', ids.map(() => 'layer')],
            ['geometry', ids.map((_, i) => ({ type: 'Point', coordinates: [i / 1000, round] }))],
            ['key', ids.map((_, i) => `V${round}${String(i).padStart(5, '0')}`)],
          ]),
        }),
      );
      internals?.flushVersions();
      write((w) =>
        w.writeRows({
          handles,
          fields: new Map(),
          deleted: new Uint8Array(handles.length).fill(1),
        }),
      );
      internals?.flushVersions();
      live = internals?.ids.live ?? 0;
    }
    expect(liveOf(tables)).toEqual([]);
    // The ids kept are the last ones deleted, at most the number kept
    expect(live).toBeLessThanOrEqual(REMOTE_DELETED_KEPT);
    expect(internals?.ids.size ?? 0).toBeLessThanOrEqual(REMOTE_DELETED_KEPT + 4000);
  });
});
