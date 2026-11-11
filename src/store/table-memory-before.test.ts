// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The values before of the writes of rows that are not features: every way
 * the in-memory Store of rows writes rows of this client (its writes of features, its writer, the
 * writes for this client, the moves of the items, the groups created and deleted) notifies the
 * rows that are not held with the values they had (`previousValues`), and those values written back
 * put the rows back. The place of a row (its layer, group and keys) is told by the changes of the
 * order instead, and a row created has no value before.
 */

import { describe, expect, it } from 'vitest';
import type { FeatureTables, FeatureTablesWriter, RowField } from '../api/tables.js';
import { featureTablesInternals } from '../feature-table/feature-tables.js';
import type { Store } from './store.js';
import { createTableStore } from './table-memory.js';
import type { Feature, ItemMove, RowValues, StoreChange } from './types.js';

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

function layer(id: string) {
  return {
    id,
    name: id,
    visible: true,
    locked: false,
    opacity: 1,
    kind: 'table' as const,
    metadata: undefined,
    styleRule: undefined,
  };
}

function setup(count = 5) {
  const { store, writer } = createTableStore();
  store.createLayer(layer('layer'));
  store.createLayer(layer('other'));
  for (let i = 0; i < count; i++) store.createFeature(point(`p${i}`, i));
  const tables = store.tables as FeatureTables;
  const notified: StoreChange[] = [];
  store.subscribe((change) => notified.push(change));
  return { store, writer, tables, notified };
}

/** The rows of the layers as features, with the ids of each layer in their order */
function stateOf(store: Store, tables: FeatureTables) {
  const out: Record<string, Feature[]> = {};
  for (const layerId of ['layer', 'other']) {
    const view = tables.get(layerId);
    const handles = view?.listRowHandles(0, 1_000) ?? new Int32Array(0);
    out[layerId] = Array.from(handles, (handle) => tables.getRowId(handle) as string)
      .filter((id) => tables.getRowRef(id) !== undefined)
      .map((id) => store.getFeature(id) as Feature);
  }
  return out;
}

/** The values before of the last notification */
function lastBefore(notified: StoreChange[]) {
  return notified[notified.length - 1]?.previousValues as RowValues | undefined;
}

describe('the writes of the features of rows not held', () => {
  it('notify the values before of an update, and the values written back put the row back', () => {
    const { store, tables, notified } = setup();
    const start = stateOf(store, tables);
    store.updateFeature('p1', {
      geometry: { type: 'Point', coordinates: [9, 9] },
      properties: { n: 10, m: 'new' },
      style: { pointColor: '#ff0000' },
      visible: false,
      locked: true,
    });
    const before = lastBefore(notified);
    expect(before).toBeDefined();
    expect(Array.from(before?.handles ?? [])).toEqual([tables.getRowRef('p1')]);
    expect(before?.fields.get('geometry')).toEqual([{ type: 'Point', coordinates: [1, 0] }]);
    expect(before?.fields.get('properties:m')).toEqual([undefined]);
    expect(store.restoreRows(before as NonNullable<typeof before>)).not.toBeNull();
    expect(stateOf(store, tables)).toEqual(start);
  });

  it('leave the place to the changes of the order', () => {
    const { store, tables, notified } = setup();
    const start = stateOf(store, tables);
    store.updateFeature('p1', { layerId: 'other', properties: { n: 5 } });
    const change = notified[notified.length - 1];
    expect([...((change.previousValues as RowValues | undefined)?.fields.keys() ?? [])]).toEqual([
      'properties:n',
    ]);
    const moves = (change.order ?? []) as ItemMove[];
    expect(moves.map((move) => move.itemId)).toEqual(['p1']);
    // Put back: the values, then the item where it was
    store.transact(() => {
      const before = change.previousValues as RowValues | undefined;
      if (before) store.restoreRows(before);
      const from = moves[0].from;
      if (from) store.moveItem('p1', from);
    });
    expect(stateOf(store, tables)).toEqual(start);
  });

  it('notify a deletion with the row not deleted before', () => {
    const { store, tables, notified } = setup();
    const start = stateOf(store, tables);
    store.deleteFeature('p2');
    const before = lastBefore(notified);
    expect(Array.from(before?.deleted ?? [])).toEqual([0]);
    store.restoreRows(before as NonNullable<typeof before>);
    expect(stateOf(store, tables)).toEqual(start);
  });

  it('notify the rows of a layer deleted, which come back with the layer', () => {
    const { store, tables, notified } = setup();
    const start = stateOf(store, tables);
    store.deleteLayer('layer');
    const before = lastBefore(notified);
    expect(before?.handles.length).toBe(5);
    store.transact(() => {
      store.createLayer(layer('layer'));
      store.setLayerOrder(['layer', 'other']);
      store.restoreRows(before as NonNullable<typeof before>);
    });
    expect(stateOf(store, tables)).toEqual(start);
  });

  it('give a row created no value before: deleting it puts the rows back', () => {
    const { store, tables, notified } = setup();
    const start = stateOf(store, tables);
    store.createFeature(point('q', 7));
    const change = notified[notified.length - 1];
    expect(change.previousValues as RowValues | undefined).toBeUndefined();
    const created = change.rows?.layers.get('layer')?.created ?? new Int32Array(0);
    expect(Array.from(created, (handle) => tables.getRowId(handle))).toEqual(['q']);
    store.restoreRows({ handles: created, fields: new Map(), deleted: new Uint8Array(1).fill(1) });
    expect(stateOf(store, tables)).toEqual(start);
  });

  it('keep the values a row had when the transaction began', () => {
    const { store, tables, notified } = setup();
    const start = stateOf(store, tables);
    store.transact(() => {
      store.updateFeature('p1', { properties: { n: 10 } });
      store.updateFeature('p1', { properties: { n: 20 }, style: { pointColor: '#00ff00' } });
      store.updateFeature('p3', { geometry: { type: 'Point', coordinates: [3, 3] } });
      store.deleteFeature('p3');
    });
    const before = lastBefore(notified);
    expect(notified).toHaveLength(1);
    const handles = Array.from(before?.handles ?? []);
    const at = handles.indexOf(tables.getRowRef('p1') as number);
    expect(before?.fields.get('properties:n')?.[at]).toBe(1);
    expect(before?.fields.get('style')?.[at]).toEqual({});
    store.restoreRows(before as NonNullable<typeof before>);
    expect(stateOf(store, tables)).toEqual(start);
  });

  it('give the values before of a row selected, as of any row', () => {
    const { store, tables, notified } = setup();
    const start = stateOf(store, tables);
    store.setSelection('feature', ['p1']);
    store.transact(() => {
      store.updateFeature('p1', { properties: { n: 10 }, style: { pointColor: '#0000ff' } });
    });
    const change = notified[notified.length - 1];
    expect(change.features?.updated ?? []).toEqual([]);
    const before = change.previousValues as RowValues | undefined;
    expect(before?.fields.get('properties:n')).toEqual([1]);
    store.restoreRows(before as NonNullable<typeof before>);
    expect(stateOf(store, tables)).toEqual(start);
  });
});

describe('the writes of rows through the writer of the Store', () => {
  function patchOf(tables: FeatureTables) {
    return {
      handles: Int32Array.from(['p0', 'p4'], (id) => tables.getRowRef(id) as number),
      fields: new Map<RowField, unknown[]>([
        ['properties:n', [100, 400]],
        ['hidden', [true, true]],
      ]),
    };
  }

  it('notify the values before of a write of this client', () => {
    const { store, writer, tables, notified } = setup();
    const start = stateOf(store, tables);
    store.transact(() => writer.writeRows(patchOf(tables)));
    const before = lastBefore(notified);
    expect(before?.fields.get('properties:n')).toEqual([0, 4]);
    store.restoreRows(before as NonNullable<typeof before>);
    expect(stateOf(store, tables)).toEqual(start);
    // Outside a transaction too
    writer.writeRows(patchOf(tables));
    expect(lastBefore(notified)?.fields.get('hidden')).toEqual([false, false]);
  });

  it('notify no values before of a write from elsewhere', () => {
    const { store, writer, tables, notified } = setup();
    store.transact(() => writer.writeRows(patchOf(tables)), 'remote');
    expect(notified[notified.length - 1].previousValues as RowValues | undefined).toBeUndefined();
  });

  it('fold the writes of a transaction that write other fields of other rows', () => {
    const { store, writer, tables, notified } = setup();
    const start = stateOf(store, tables);
    const h = (id: string) => tables.getRowRef(id) as number;
    store.transact(() => {
      store.restoreRows({
        handles: Int32Array.of(h('p0'), h('p1')),
        fields: new Map([['properties:n', [10, 11]]]),
      });
      writer.writeRows({
        handles: Int32Array.of(h('p1'), h('p2')),
        fields: new Map<RowField, unknown[]>([
          ['geometry', [null, null].map((_, i) => ({ type: 'Point', coordinates: [i, 5] }))],
          ['properties:n', [21, 22]],
        ]),
      });
      store.deleteFeature('p3');
    });
    const before = lastBefore(notified);
    expect(Array.from(before?.handles ?? []).map((handle) => tables.getRowId(handle))).toEqual([
      'p0',
      'p1',
      'p2',
      'p3',
    ]);
    // The first value read of each row, and the value of the fields not written of a row
    expect(before?.fields.get('properties:n')).toEqual([0, 1, 2, 3]);
    expect(before?.fields.get('geometry')).toEqual([0, 1, 2, 3].map((x) => point('', x).geometry));
    expect(Array.from(before?.deleted ?? [])).toEqual([0, 0, 0, 0]);
    store.restoreRows(before as NonNullable<typeof before>);
    expect(stateOf(store, tables)).toEqual(start);
  });
});

describe('the moves of the items and the groups', () => {
  it('leave the rows moved to the changes of the order, which put them back', () => {
    const { store, tables, notified } = setup();
    const start = stateOf(store, tables);
    store.moveItems(['p0', 'p1'], { layerId: 'other', below: null });
    const change = notified[notified.length - 1];
    expect(change.previousValues as RowValues | undefined).toBeUndefined();
    const moves = (change.order ?? []).filter((move): move is ItemMove => move.kind === 'item');
    expect(moves.map((move) => move.itemId).sort()).toEqual(['p0', 'p1']);
    store.transact(() => {
      for (const move of [...moves].reverse())
        if (move.from) store.moveItem(move.itemId, move.from);
    });
    expect(stateOf(store, tables)).toEqual(start);
  });

  it('leave the members of a group created and deleted to the changes of the order', () => {
    const { store, tables, notified } = setup();
    store.createGroup({
      id: 'g',
      layerId: 'layer',
      name: 'g',
      featureIds: ['p1', 'p3'],
      visible: true,
      locked: false,
    });
    expect(notified[notified.length - 1].previousValues as RowValues | undefined).toBeUndefined();
    expect(notified[notified.length - 1].order?.length).toBeGreaterThan(0);
    store.deleteGroup('g');
    expect(notified[notified.length - 1].previousValues as RowValues | undefined).toBeUndefined();
    expect(store.getFeature('p1')?.groupId).toBeUndefined();
    expect(tables.get('layer')?.itemCount).toBe(5);
  });
});

describe('the rows of a layer of z', () => {
  it('give the values before with their z, and are moved without being made features', () => {
    const { store, writer } = createTableStore({ dimensionsOf: () => 'xyz' });
    store.createLayer(layer('layer'));
    const tables = store.tables as FeatureTables;
    const ids = ['z0', 'z1'];
    const handles = writer.allocateHandles({
      offsets: Int32Array.of(0, 2, 4),
      bytes: new TextEncoder().encode(ids.join('')),
    });
    store.transact(
      () =>
        writer.writeRows({
          handles,
          fields: new Map<RowField, unknown[]>([
            ['type', ['Point', 'Point']],
            ['parent', ['layer', 'layer']],
            ['geometry', ids.map((_, i) => ({ type: 'Point', coordinates: [i, 0, 10 + i] }))],
            ['key', ['a', 'b']],
          ]),
        }),
      'remote',
    );
    featureTablesInternals(tables)?.flushVersions();
    const notified: StoreChange[] = [];
    store.subscribe((change) => notified.push(change));
    writeGeometry(writer, store, handles);
    const before = lastBefore(notified);
    expect(before?.fields.get('geometry')).toEqual([
      { type: 'Point', coordinates: [0, 0, 10] },
      { type: 'Point', coordinates: [1, 0, 11] },
    ]);
    store.restoreRows(before as NonNullable<typeof before>);
    const now = tables.readValues({ handles, fields: new Map([['geometry', []]]) });
    expect(now.fields.get('geometry')).toEqual(before?.fields.get('geometry'));
    // Moved and deleted: the values before are read from the rows
    store.moveItems(['z1'], { layerId: 'layer', below: null });
    expect(Array.from(tables.get('layer')?.listRowHandles(0, 2) ?? [])).toEqual([
      handles[1],
      handles[0],
    ]);
    store.deleteFeature('z0');
    expect(Array.from(lastBefore(notified)?.deleted ?? [])).toEqual([0]);
  });
});

function writeGeometry(writer: FeatureTablesWriter, store: Store, handles: Int32Array): void {
  store.transact(() =>
    writer.writeRows({
      handles,
      fields: new Map<RowField, unknown[]>([
        [
          'geometry',
          [
            { type: 'Point', coordinates: [5, 5, 50] },
            { type: 'Point', coordinates: [6, 6, 60] },
          ],
        ],
      ]),
    }),
  );
}
