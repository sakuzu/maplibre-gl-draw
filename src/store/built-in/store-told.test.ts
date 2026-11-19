// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What is called once the built-in Store has told a change (`onChangeTold`)
 *
 * - It is called after every listener of the Store, once per change told, and not for a
 *   transaction that told nothing
 * - It is called after the ids of the deleted rows nothing keeps have been forgotten
 * - It may write: the write is a new transaction, whose change is told as well
 * - Once stopped, it is not called; tables that are not those of a built-in Store are refused
 */

import { describe, expect, it } from 'vitest';
import type { Layer } from '../../api/model.js';
import { DrawError } from '../../shared/errors.js';
import { onChangeTold } from './changes.js';
import { createStore } from './create-store.js';
import type { FeatureRowField, GeometryColumn, NewRows, Store } from './types.js';

function layer(id: string): Layer {
  return {
    id,
    name: id,
    visible: true,
    locked: false,
    opacity: 1,
    styleRule: undefined,
    metadata: undefined,
  };
}

/** The points of rows as one column, one point each */
function pointsOf(count: number): GeometryColumn {
  const coordinates = new Float64Array(count * 2);
  for (let i = 0; i < count; i++) {
    coordinates[i * 2] = 139 + i * 1e-4;
    coordinates[i * 2 + 1] = 35;
  }
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

/** New points of the layer `a` */
function newRows(ids: readonly string[]): NewRows {
  return {
    ids,
    fields: new Map<FeatureRowField, readonly unknown[]>([
      ['type', ids.map(() => 'Point')],
      ['parent', ids.map(() => 'a')],
      ['orderKey', ids.map((id) => `k${id}`)],
    ]),
    geometry: pointsOf(ids.length),
  };
}

/** A built-in Store with the layer `a` */
function storeWithLayer(): Store {
  const store = createStore();
  store.transact(() => store.createLayer(layer('a')), 'remote');
  return store;
}

/** Deletes a row by its id */
function deleteRow(store: Store, id: string): void {
  const ref = store.tables.getRowRef(id) as number;
  store.writeRows({ rows: Int32Array.of(ref), fields: new Map(), deleted: Uint8Array.of(1) });
}

describe('onChangeTold', () => {
  it('is called after every listener, once per change told, and not when nothing was told', () => {
    const store = storeWithLayer();
    const calls: string[] = [];
    store.subscribe(() => calls.push('first listener'));
    onChangeTold(store.tables, () => calls.push('told'));
    store.subscribe(() => calls.push('second listener'));

    store.transact(() => {
      store.createRows(newRows(['p']));
      store.createRows(newRows(['q']));
    }, 'remote');
    expect(calls).toEqual(['first listener', 'second listener', 'told']);

    calls.length = 0;
    store.createRows(newRows(['r']));
    deleteRow(store, 'r');
    expect(calls).toEqual([
      'first listener',
      'second listener',
      'told',
      'first listener',
      'second listener',
      'told',
    ]);

    calls.length = 0;
    store.transact(() => {}, 'remote');
    expect(calls).toEqual([]);
  });

  it('is called once the ids of the deleted rows nothing keeps are forgotten', () => {
    const store = storeWithLayer();
    store.createRows(newRows(['p']));
    const ref = store.tables.getRowRef('p') as number;
    const seen: Array<string | undefined> = [];
    store.subscribe(() => seen.push(store.tables.getRowId(ref)));
    onChangeTold(store.tables, () =>
      seen.push(store.tables.findRow('p')?.ref === undefined ? undefined : 'p'),
    );
    deleteRow(store, 'p');
    expect(seen).toEqual(['p', undefined]);
  });

  it('may write, and what it writes is told as a new change', () => {
    const store = storeWithLayer();
    const created: string[][] = [];
    store.subscribe((change) => {
      const rows = change.rows?.layers.get('a');
      if (rows && rows.created.length > 0) {
        created.push(Array.from(rows.created, (ref) => store.tables.getRowId(ref) ?? ''));
      }
    });
    let deleted = false;
    onChangeTold(store.tables, () => {
      if (!deleted) return;
      deleted = false;
      // A deleted row's id is free here, and the write is a transaction of its own
      expect(store.createRows(newRows(['p']))).toBe(true);
    });
    store.createRows(newRows(['p']));
    deleted = true;
    deleteRow(store, 'p');
    expect(created).toEqual([['p'], ['p']]);
    expect(store.tables.getRowRef('p')).toBeTypeOf('number');
  });

  it('is not called once stopped', () => {
    const store = storeWithLayer();
    let calls = 0;
    const stop = onChangeTold(store.tables, () => {
      calls += 1;
    });
    store.createRows(newRows(['p']));
    stop();
    store.createRows(newRows(['q']));
    expect(calls).toBe(1);
  });

  it('is reached from a Store spread from the built-in one', () => {
    const base = createStore();
    const store: Store = { ...base };
    let calls = 0;
    onChangeTold(store.tables, () => {
      calls += 1;
    });
    store.transact(() => store.createLayer(layer('a')), 'remote');
    expect(calls).toBe(1);
  });

  it('refuses tables that are not those of a built-in Store', () => {
    const fake = { ...createStore().tables };
    for (const tables of [fake, {}, null, undefined]) {
      try {
        onChangeTold(tables, () => {});
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(DrawError);
        expect((error as DrawError).code).toBe('invalidInput');
      }
    }
  });
});
