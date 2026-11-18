// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The work of the writes and the changes of the built-in Store, and the promises it keeps inside
 * the library
 *
 * - A large write in parts of one operation is told part by part, each part writing its rows only
 * - The updates of many groups in one transaction are folded by their ids, a lookup each
 * - The objects the writes of rows make do not grow with their rows
 * - The id of a deleted row is read from its reference after the change (until the document is
 *   cleared), and an operation left open is taken as ended at the next clear
 */

import { describe, expect, it } from 'vitest';
import type { Layer } from '../../api/model.js';
import { countsOf, expectNotProportional, workDuring } from '../../test-utils.js';
import { storeOf } from './create-store.js';
import { openDocument } from './document.js';
import type { FeatureRowField, GeometryColumn, NewRows, Store, StoreChange } from './types.js';

function layer(id: string): Layer {
  return {
    id,
    name: id,
    visible: true,
    locked: false,
    opacity: 1,
    items: [],
    styleRule: undefined,
    metadata: undefined,
  };
}

/** `count` points in a line, as one column */
function points(count: number, from: number): GeometryColumn {
  const coordinates = new Float64Array(count * 2);
  for (let i = 0; i < count; i++) coordinates[i * 2] = (from + i) * 1e-5;
  const starts = Int32Array.from({ length: count + 1 }, (_, i) => i);
  return {
    types: new Uint8Array(count),
    coordinates,
    valuesPerPosition: 2,
    partStarts: starts,
    ringStarts: starts,
    positionStarts: starts,
  };
}

/** `count` new points of the layer `a` from the `from`-th */
function pointRows(count: number, from = 0): NewRows {
  const ids = Array.from({ length: count }, (_, i) => `r${String(from + i).padStart(7, '0')}`);
  return {
    ids,
    fields: new Map<FeatureRowField, unknown[]>([
      ['type', ids.map(() => 'Point')],
      ['parent', ids.map(() => 'a')],
      ['orderKey', ids.map((id) => `k${id}`)],
      ['properties:n', ids.map((_, i) => from + i)],
    ]),
    geometry: points(count, from),
  };
}

/** A Store with the layer `a`, its document, and the changes it tells */
function newStore() {
  const document = openDocument();
  const store = storeOf(document);
  store.createLayer(layer('a'));
  const changes: StoreChange[] = [];
  store.subscribe((change) => changes.push(change));
  return { document, store, changes, counts: countsOf(store) };
}

/**
 * Writes `total` new rows in parts of `size` rows of one operation, the last part ending it:
 * what each part wrote, and the changes told by the time each `transact` returned
 */
function writeInParts(store: Store, changes: StoreChange[], total: number, size: number) {
  const counts = countsOf(store);
  const operationId = store.newOperationId();
  const parts: Array<{ rowsWritten: number; toldBeforeReturn: number }> = [];
  for (let from = 0; from < total; from += size) {
    const hasMoreParts = from + size < total;
    const before = changes.length;
    const work = workDuring(counts, () => {
      store.transact(
        () => store.createRows(pointRows(Math.min(size, total - from), from)),
        'remote',
        { operationId, hasMoreParts },
      );
    });
    parts.push({ rowsWritten: work.rowsWritten, toldBeforeReturn: changes.length - before });
  }
  return { operationId, parts };
}

describe('a large write in parts of one operation', () => {
  it('is told once per part, as each part ends, and each part writes its own rows only', () => {
    const { store, changes, counts } = newStore();
    const before = counts.notifications;
    const { operationId, parts } = writeInParts(store, changes, 100_000, 5_000);
    expect(parts).toHaveLength(20);
    expect(counts.notifications - before).toBe(20);
    for (const part of parts) {
      expect(part.toldBeforeReturn).toBe(1);
      expect(part.rowsWritten).toBeLessThanOrEqual(5_000);
    }
    expect(changes.map((c) => c.hasMoreParts)).toEqual([...new Array(19).fill(true), false]);
    expect(new Set(changes.map((c) => c.operationId))).toEqual(new Set([operationId]));
    expect(changes.every((c) => c.rows?.layers.get('a')?.created.length === 5_000)).toBe(true);
    expect(store.tables.get('a')?.rowCount).toBe(100_000);
  });

  it('writes no more rows in a part, and tells no more changes per part, for more rows', () => {
    expectNotProportional((size) => {
      const { store, changes } = newStore();
      const { parts } = writeInParts(store, changes, size, 500);
      return Math.max(...parts.map((part) => part.rowsWritten));
    }, 'the rows written in one part');
    expectNotProportional((size) => {
      const { store, changes, counts } = newStore();
      const before = counts.notifications;
      const { parts } = writeInParts(store, changes, size, 500);
      return (counts.notifications - before) / parts.length;
    }, 'the changes told per part');
  });
});

describe('the updates of many groups in one transaction', () => {
  it('are folded into one entry per group, with a lookup per update', () => {
    const lookups = (size: number) => {
      const { store, changes, counts } = newStore();
      store.transact(() => {
        for (let i = 0; i < size; i++) {
          store.createGroup({
            id: `g${i}`,
            layerId: 'a',
            orderKey: `k${i}`,
            name: '',
            featureIds: [],
            visible: true,
            locked: false,
          });
        }
      }, 'local');
      const work = workDuring(counts, () => {
        store.transact(() => {
          for (let round = 0; round < 2; round++) {
            for (let i = 0; i < size; i++) store.updateGroup(`g${i}`, { name: `n${round}` });
          }
        }, 'local');
      });
      const updated = changes[changes.length - 1].groups?.updated ?? [];
      expect(updated).toHaveLength(size);
      expect(updated[size - 1]).toEqual(
        expect.objectContaining({
          id: `g${size - 1}`,
          group: expect.objectContaining({ name: 'n1' }),
          previous: expect.objectContaining({ name: '' }),
        }),
      );
      // The lookups of the fold for each update
      return work.changeLookups / (2 * size);
    };
    const comparison = expectNotProportional(lookups, 'the lookups of the fold per update');
    expect(comparison.large).toBe(1);
  });
});

describe('the writes of rows', () => {
  it('make no more objects of their own for more rows', () => {
    expectNotProportional((size) => {
      const { store, counts } = newStore();
      return workDuring(counts, () => store.createRows(pointRows(size))).objectsCreated;
    }, 'the objects a creation of rows makes');
    expectNotProportional((size) => {
      const { store, counts } = newStore();
      store.createRows(pointRows(size));
      const view = store.tables.get('a');
      if (!view) throw new Error('no rows');
      const rows = view.listRowRefs(0, size);
      const visible = new Array<unknown>(size).fill(false);
      const names = Array.from({ length: size }, (_, i) => `m${i}`);
      return workDuring(counts, () =>
        store.writeRows({
          rows,
          fields: new Map<FeatureRowField, unknown[]>([
            ['visible', visible],
            ['properties:name', names],
          ]),
          geometry: points(size, 1),
        }),
      ).objectsCreated;
    }, 'the objects a write of rows makes');
  });
});

describe('the promises inside the library', () => {
  it('read the id of a deleted row from its reference after the change, until the document is cleared', () => {
    const { store } = newStore();
    store.createRows(pointRows(3));
    const ref = store.tables.getRowRef('r0000001') as number;
    let deleted: Int32Array | undefined;
    store.subscribe((change) => {
      deleted = change.rows?.layers.get('a')?.deleted;
    });
    store.writeRows({ rows: Int32Array.of(ref), fields: new Map(), deleted: Uint8Array.of(1) });
    // After the change was told, as the selection of the instance reads it
    expect([...(deleted ?? [])]).toEqual([ref]);
    expect(store.tables.getRowRef('r0000001')).toBeUndefined();
    expect(store.tables.getRowId(ref)).toBe('r0000001');
    store.createRows(pointRows(1, 10));
    store.updateLayer('a', { name: 'A' });
    expect(store.tables.getRowId(ref)).toBe('r0000001');
  });

  it('take an operation left open as ended at the next clear, and close one by its last part', () => {
    const { document, store } = newStore();
    const open = document.changes.openOperations;
    const left = store.newOperationId();
    store.transact(() => store.createRows(pointRows(2)), 'remote', {
      operationId: left,
      hasMoreParts: true,
    });
    expect([...open]).toEqual([left]);
    // A replacement in parts: the clear in its first part does not end it
    const replacement = store.newOperationId();
    store.transact(() => store.clear(), 'load', { operationId: replacement, hasMoreParts: true });
    expect([...open]).toEqual([replacement]);
    store.transact(() => {}, 'load', { operationId: replacement });
    expect([...open]).toEqual([]);
  });
});
