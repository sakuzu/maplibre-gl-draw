// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * How long the id and the reference of a deleted row last, on the built-in Store and on a Store
 * spread from it
 *
 * - The id of a deleted row nothing keeps is free once the change of its transaction has been
 *   told: a new row and a row of a page take it, with a new reference, a row whose values were
 *   written in place before it was deleted included
 * - While the transaction is under way and while its change is told, the id of a deleted row is
 *   read from its reference; afterwards the row is not found by its id
 * - The id of a row a token keeps is in use until the token is let go of, also when it is let go
 *   of while the change is told
 * - A page of the id of a row the transaction deleted is refused, and nothing is taken in
 * - After a clear, a row whose id comes back keeps its reference, and the ids that did not come
 *   back are free once the operation has ended, in parts too
 * - `listPropertyKeys` gives the keys of the deleted rows kept, and none of a deleted row nothing
 *   keeps
 * - The forgetting does not grow with the rows of the tables, and the numbers of the references
 *   are given again
 */

import type { Geometry } from 'geojson';
import { describe, expect, it } from 'vitest';
import type { Layer, Metadata } from '../../api/model.js';
import { DrawError } from '../../shared/errors.js';
import { countsOf, expectNotProportional, workDuring } from '../../test-utils.js';
import { createStore } from './create-store.js';
import { createRowPageBuilder } from './pages.js';
import type {
  FeatureRowField,
  GeometryColumn,
  NewRows,
  RowPage,
  Store,
  StoreChange,
  SubscribeOptions,
} from './types.js';

// ---------------------------------------------------------------------------------------------
// What the tests write

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

/** New points of the layer `a`, with the attribute `name` */
function newRows(ids: readonly string[]): NewRows {
  return {
    ids,
    fields: new Map<FeatureRowField, readonly unknown[]>([
      ['type', ids.map(() => 'Point')],
      ['parent', ids.map(() => 'a')],
      ['orderKey', ids.map((id) => `k${id}`)],
      ['properties:name', ids.map((id) => id.toUpperCase())],
    ]),
    geometry: pointsOf(ids.length),
  };
}

/** Pages of points of the layer `a` with the ids given */
function pagesOf(ids: readonly string[]): RowPage[] {
  const builder = createRowPageBuilder();
  for (const id of ids) {
    const geometry: Geometry = { type: 'Point', coordinates: [139, 35] };
    builder.addRow({ id, type: 'Point', geometry, orderKey: `k${id}` });
  }
  return builder.finish();
}

function refOf(store: Store, id: string): number {
  const ref = store.tables.getRowRef(id);
  if (ref === undefined) throw new Error(`no row ${id}`);
  return ref;
}

function record(store: Store, options?: SubscribeOptions): StoreChange[] {
  const changes: StoreChange[] = [];
  store.subscribe((change) => changes.push(change), options);
  return changes;
}

/** Deletes rows by their references */
function remove(store: Store, ...refs: number[]): void {
  store.writeRows({
    rows: Int32Array.from(refs),
    fields: new Map(),
    deleted: new Uint8Array(refs.length).fill(1),
  });
}

/** The code a call throws as a `DrawError` ('none' when it does not throw) */
function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    return error instanceof DrawError ? error.code : String(error);
  }
  return 'none';
}

/** The ids of the rows of the layer `a` */
function idsOf(store: Store): string[] {
  const view = store.tables.get('a');
  if (!view) return [];
  return [...view.listRowRefs(0, view.rowCount)].map((ref) => store.tables.getRowId(ref) ?? '');
}

/** A Store with the layer `a` and the rows p, q and r */
function withRows(make: () => Store): Store {
  const store = make();
  store.createLayer(layer('a'));
  store.createRows(newRows(['p', 'q', 'r']));
  return store;
}

// ---------------------------------------------------------------------------------------------

/** The Stores the tests run on */
const STORES: ReadonlyArray<[string, () => Store]> = [
  ['the built-in Store', () => createStore()],
  [
    'a Store spread from the built-in one, with setMetadata replaced',
    () => {
      const base = createStore();
      return {
        ...base,
        setMetadata: (metadata: Partial<Metadata>) => base.setMetadata(metadata),
      };
    },
  ],
];

describe.each(STORES)('%s', (_name, make) => {
  describe('the id of a deleted row nothing keeps', () => {
    it('is taken by a new row once the change is told, with a new reference, a row written in place included', () => {
      const store = withRows(make);
      const q = refOf(store, 'q');
      // A value written in place, then the row deleted
      store.writeRows({ rows: Int32Array.of(q), fields: new Map([['properties:name', ['Z']]]) });
      remove(store, q);
      const changes = record(store);
      expect(store.createRows(newRows(['q']))).toBe(true);
      const again = refOf(store, 'q');
      const rows = changes[0].rows?.layers.get('a');
      expect([...(rows?.created ?? [])]).toEqual([again]);
      expect([...(rows?.updated ?? [])]).toEqual([]);
      expect(store.tables.findRow('q')).toEqual({ ref: again, deleted: false });
      expect(store.tables.get('a')?.getRowProperty(again, 'name')).toBe('Q');
      expect(idsOf(store).sort()).toEqual(['p', 'q', 'r']);
      // Deleted and made again many times over
      for (let i = 0; i < 5; i++) {
        store.writeRows({
          rows: Int32Array.of(refOf(store, 'q')),
          fields: new Map([['properties:name', [`Z${i}`]]]),
        });
        remove(store, refOf(store, 'q'));
        expect(store.createRows(newRows(['q']))).toBe(true);
      }
      expect(idsOf(store).sort()).toEqual(['p', 'q', 'r']);
    });

    it('is taken by a row of a page once the change is told, a row written in place included', () => {
      const store = withRows(make);
      const r = refOf(store, 'r');
      store.writeRows({ rows: Int32Array.of(r), fields: new Map([['properties:name', ['Z']]]) });
      remove(store, r);
      const changes = record(store);
      expect(store.createRowsFromPages('a', pagesOf(['r', 's']))).toBe(true);
      const again = refOf(store, 'r');
      expect([...(changes[0].rows?.layers.get('a')?.created ?? [])].sort()).toEqual(
        [again, refOf(store, 's')].sort(),
      );
      expect(store.tables.get('a')?.getRowProperty(again, 'name')).toBeUndefined();
      expect(idsOf(store).sort()).toEqual(['p', 'q', 'r', 's']);
    });

    it('is read from the reference while the transaction is under way and while the change is told, and not found after', () => {
      const store = withRows(make);
      const q = refOf(store, 'q');
      const told: Array<string | undefined> = [];
      store.subscribe((change) => {
        const deleted = change.rows?.layers.get('a')?.deleted;
        if (deleted) told.push(store.tables.getRowId(deleted[0]));
      });
      store.transact(() => {
        remove(store, q);
        expect(store.tables.getRowId(q)).toBe('q');
      }, 'remote');
      expect(told).toEqual(['q']);
      expect(store.tables.findRow('q')).toBeUndefined();
      expect(store.tables.getRowRef('q')).toBeUndefined();
    });

    it('is taken by createRows in the transaction that deleted the row, with its reference', () => {
      const store = withRows(make);
      const q = refOf(store, 'q');
      const changes = record(store);
      store.transact(() => {
        remove(store, q);
        expect(store.createRows(newRows(['q']))).toBe(true);
      }, 'remote');
      expect(refOf(store, 'q')).toBe(q);
      expect([...(changes[0].rows?.layers.get('a')?.updated ?? [])]).toEqual([q]);
    });

    it('is refused to a page in the transaction that deleted the row, and nothing is taken in', () => {
      const store = withRows(make);
      const q = refOf(store, 'q');
      const changes = record(store);
      let code = 'none';
      store.transact(() => {
        remove(store, q);
        code = codeOf(() => store.createRowsFromPages('a', pagesOf(['s', 'q', 't'])));
      }, 'remote');
      expect(code).toBe('alreadyExists');
      expect(idsOf(store).sort()).toEqual(['p', 'r']);
      const rows = changes[0].rows?.layers.get('a');
      expect([...(rows?.created ?? [])]).toEqual([]);
      expect([...(rows?.deleted ?? [])]).toEqual([q]);
      // Once the change is told, the page is taken in
      expect(store.createRowsFromPages('a', pagesOf(['s', 'q', 't']))).toBe(true);
      expect(idsOf(store).sort()).toEqual(['p', 'q', 'r', 's', 't']);
    });
  });

  describe('the id of a deleted row a token keeps', () => {
    it('is in use until the token is let go of, and taken by a new row after', () => {
      const store = withRows(make);
      const q = refOf(store, 'q');
      const keeping = record(store, { keepDeletedRows: true });
      remove(store, q);
      const token = keeping[0].deletedRowsToken as NonNullable<StoreChange['deletedRowsToken']>;
      expect(store.createRows(newRows(['q']))).toBe(false);
      expect(codeOf(() => store.createRowsFromPages('a', pagesOf(['q'])))).toBe('alreadyExists');
      expect(store.tables.findRow('q')).toEqual({ ref: q, deleted: true });
      store.releaseDeletedRows(token);
      expect(store.tables.findRow('q')).toBeUndefined();
      expect(store.createRows(newRows(['q']))).toBe(true);
      expect(store.tables.findRow('q')?.deleted).toBe(false);
    });

    it('is taken by a page once the token is let go of', () => {
      const store = withRows(make);
      const q = refOf(store, 'q');
      const keeping = record(store, { keepDeletedRows: true });
      remove(store, q);
      store.releaseDeletedRows(
        keeping[0].deletedRowsToken as NonNullable<StoreChange['deletedRowsToken']>,
      );
      expect(store.createRowsFromPages('a', pagesOf(['q']))).toBe(true);
      expect(store.tables.findRow('q')?.deleted).toBe(false);
    });

    it('is read while the change is told when the token is let go of in a listener, and free after', () => {
      const store = withRows(make);
      const q = refOf(store, 'q');
      const read: Array<string | undefined> = [];
      store.subscribe(
        (change) => {
          if (change.deletedRowsToken === undefined) return;
          store.releaseDeletedRows(change.deletedRowsToken);
          read.push(store.tables.getRowId(q));
        },
        { keepDeletedRows: true },
      );
      // A listener told after the token was let go of
      store.subscribe((change) => {
        if (change.rows?.layers.get('a')?.deleted.length) read.push(store.tables.getRowId(q));
      });
      remove(store, q);
      expect(read).toEqual(['q', 'q']);
      expect(store.tables.findRow('q')).toBeUndefined();
      expect(store.createRows(newRows(['q']))).toBe(true);
    });

    it('is free after a token let go of in a transaction once its change is told', () => {
      const store = withRows(make);
      const q = refOf(store, 'q');
      const keeping = record(store, { keepDeletedRows: true });
      remove(store, q);
      const token = keeping[0].deletedRowsToken as NonNullable<StoreChange['deletedRowsToken']>;
      let page = 'none';
      store.transact(() => {
        store.releaseDeletedRows(token);
        page = codeOf(() => store.createRowsFromPages('a', pagesOf(['q'])));
      }, 'remote');
      expect(page).toBe('alreadyExists');
      expect(store.createRowsFromPages('a', pagesOf(['q']))).toBe(true);
    });
  });

  describe('the rows a clear takes out', () => {
    it('keep their references when their ids come back in the operation, and are free after it', () => {
      const store = withRows(make);
      const p = refOf(store, 'p');
      const gone = [refOf(store, 'q'), refOf(store, 'r')];
      store.transact(() => {
        store.clear();
        store.createLayer(layer('a'));
        store.createRows(newRows(['p']));
      }, 'load');
      expect(refOf(store, 'p')).toBe(p);
      // The references of the rows whose ids did not come back are let go of: a new row is given
      // one of their numbers
      store.createRows(newRows(['z']));
      expect(gone).toContain(refOf(store, 'z'));
      // The id that did not come back is a new row: created, not brought back
      const changes = record(store);
      expect(store.createRows(newRows(['q']))).toBe(true);
      expect([...(changes[0].rows?.layers.get('a')?.created ?? [])]).toEqual([refOf(store, 'q')]);
      expect([...(changes[0].rows?.layers.get('a')?.updated ?? [])]).toEqual([]);
      expect(store.tables.findRow('q')?.deleted).toBe(false);
      expect(store.tables.get('a')?.getRowProperty(refOf(store, 'q'), 'name')).toBe('Q');
    });

    it('keep their references when their ids come back in a later part, and are free once the operation ends', () => {
      const store = withRows(make);
      const p = refOf(store, 'p');
      const q = refOf(store, 'q');
      const r = refOf(store, 'r');
      const operationId = store.newOperationId();
      store.transact(
        () => {
          store.clear();
          store.createLayer(layer('a'));
        },
        'load',
        { operationId, hasMoreParts: true },
      );
      store.transact(() => store.createRows(newRows(['p'])), 'load', {
        operationId,
        hasMoreParts: true,
      });
      store.transact(() => store.createRowsFromPages('a', pagesOf(['r'])), 'load', {
        operationId,
      });
      expect(refOf(store, 'p')).toBe(p);
      expect(refOf(store, 'r')).toBe(r);
      // The reference of the row whose id did not come back is let go of: a new row is given its
      // number, and a page takes the id
      store.createRows(newRows(['z']));
      expect(refOf(store, 'z')).toBe(q);
      expect(store.createRowsFromPages('a', pagesOf(['q']))).toBe(true);
      expect(idsOf(store).sort()).toEqual(['p', 'q', 'r', 'z']);
    });

    it('are free once an operation that stopped ends', () => {
      const store = withRows(make);
      const gone = [refOf(store, 'p'), refOf(store, 'q'), refOf(store, 'r')];
      const operationId = store.newOperationId();
      store.transact(
        () => {
          store.clear();
          store.createLayer(layer('a'));
        },
        'load',
        { operationId, hasMoreParts: true },
      );
      // The operation stops without its last part
      store.transact(() => {}, 'load', { operationId, stopped: true });
      store.createRows(newRows(['z']));
      expect(gone).toContain(refOf(store, 'z'));
      expect(store.createRowsFromPages('a', pagesOf(['p', 'q']))).toBe(true);
      expect(idsOf(store).sort()).toEqual(['p', 'q', 'z']);
    });
  });

  describe('the keys of the attributes of deleted rows', () => {
    it('are given for the rows kept, and not for a deleted row nothing keeps', () => {
      const store = withRows(make);
      const p = refOf(store, 'p');
      const q = refOf(store, 'q');
      let whileTold: string[] | undefined;
      store.subscribe((change) => {
        if (change.rows?.layers.get('a')?.deleted.length) {
          whileTold = store.listPropertyKeys(Int32Array.of(p));
        }
      });
      remove(store, p);
      expect(whileTold).toEqual([]);
      expect(store.listPropertyKeys(Int32Array.of(p))).toEqual([]);
      const keeping = record(store, { keepDeletedRows: true });
      remove(store, q);
      expect(store.listPropertyKeys(Int32Array.of(q))).toEqual(['name']);
      expect(store.listPropertyKeys(Int32Array.of(q, refOf(store, 'r')))).toEqual(['name']);
      // Every row that is not deleted, when the rows are left out
      store.writeRows({
        rows: Int32Array.of(refOf(store, 'r')),
        fields: new Map([['properties:name', [undefined]]]),
      });
      expect(store.listPropertyKeys()).toEqual([]);
      store.releaseDeletedRows(
        keeping[0].deletedRowsToken as NonNullable<StoreChange['deletedRowsToken']>,
      );
      expect(store.listPropertyKeys(Int32Array.of(q))).toEqual([]);
    });
  });
});

/** A Store with the layer `a` and `size` rows */
function storeOf(size: number) {
  const store = createStore();
  store.createLayer(layer('a'));
  store.createRows(
    newRows(Array.from({ length: size }, (_, i) => `r${String(i).padStart(6, '0')}`)),
  );
  return { store, counts: countsOf(store) };
}

describe('the work of the forgetting', () => {
  it('touches the rows a transaction deleted, not the rows of the tables', () => {
    expectNotProportional((size) => {
      const { store, counts } = storeOf(size);
      const ref = refOf(store, 'r000000');
      const forgetting = workDuring(counts, () => remove(store, ref));
      const writing = workDuring(counts, () =>
        store.writeRows({
          rows: Int32Array.of(refOf(store, 'r000001')),
          fields: new Map([['properties:name', ['x']]]),
        }),
      );
      return forgetting.rowsTouched - writing.rowsTouched;
    }, 'the rows the forgetting of the ids of one deleted row touches');
  });

  it('gives the numbers of the references again to the rows made and deleted one at a time', () => {
    expectNotProportional((size) => {
      const store = createStore();
      store.createLayer(layer('a'));
      let largest = 0;
      for (let i = 0; i < size / 10; i++) {
        store.createRows(newRows([`t${i}`]));
        const ref = refOf(store, `t${i}`);
        largest = Math.max(largest, ref);
        remove(store, ref);
      }
      return largest;
    }, 'the largest reference after rows made and deleted one at a time');
  });
});
