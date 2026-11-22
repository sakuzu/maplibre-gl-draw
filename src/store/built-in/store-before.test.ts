// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The values the rows had before and the deleted rows kept, in the changes of a Store without a
 * map (`createStore`), run on the built-in Store and on a Store spread from it with `writeRows`
 * replaced: every test runs on both.
 *
 * - A listener that asks for the values before gets them in its own change, for the sources it
 *   names; one that does not ask gets none. A function is asked once per transaction, and once
 *   per part of an operation
 * - The values before are by layer, the first values of the transaction, and arrays the listeners
 *   share without a copy
 * - A listener that keeps the deleted rows gets a token; the rows stay, readable by their
 *   references, their ids in use, until every token is let go of, and come back where they were
 *   when written with `deleted` 0
 * - The tokens keep nothing after a clear
 */

import { describe, expect, it } from 'vitest';
import type { Layer } from '../../api/model.js';
import { DrawError } from '../../shared/errors.js';
import { createStore } from './create-store.js';
import type {
  FeatureRowField,
  GeometryColumn,
  NewRows,
  RowValues,
  Store,
  StoreChange,
  StoreGroup,
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
    styleRule: undefined,
    metadata: undefined,
  };
}

function group(id: string, layerId: string, orderKey: string): StoreGroup {
  return { id, layerId, orderKey, name: id, visible: true, locked: false };
}

/** Points, one per row, as one column */
function points(positions: ReadonlyArray<readonly [number, number]>): GeometryColumn {
  const starts = Int32Array.from({ length: positions.length + 1 }, (_, i) => i);
  return {
    types: new Uint8Array(positions.length),
    coordinates: Float64Array.from(positions.flat()),
    valuesPerPosition: 2,
    partStarts: starts,
    ringStarts: starts,
    positionStarts: starts,
  };
}

/** New points: an id, a parent, a key and a name each */
function pointRows(
  rows: ReadonlyArray<{ id: string; parent: string; orderKey: string; at: [number, number] }>,
): NewRows {
  return {
    ids: rows.map((row) => row.id),
    fields: new Map<FeatureRowField, unknown[]>([
      ['type', rows.map(() => 'Point')],
      ['parent', rows.map((row) => row.parent)],
      ['orderKey', rows.map((row) => row.orderKey)],
      ['properties:name', rows.map((row) => row.id.toUpperCase())],
    ]),
    geometry: points(rows.map((row) => row.at)),
  };
}

function valuesOf(
  rows: readonly number[],
  fields: ReadonlyArray<[FeatureRowField, unknown[]]>,
  more: { geometry?: GeometryColumn; deleted?: Uint8Array } = {},
): RowValues {
  return { rows: Int32Array.from(rows), fields: new Map(fields), ...more };
}

function refOf(store: Store, id: string): number {
  const ref = store.tables.getRowRef(id);
  if (ref === undefined) throw new Error(`no row ${id}`);
  return ref;
}

function idsOf(store: Store, refs: Int32Array | undefined): string[] {
  return [...(refs ?? [])].map((ref) => store.tables.getRowId(ref) as string);
}

/** The changes a listener is told, as they come */
function record(store: Store, options?: SubscribeOptions): StoreChange[] {
  const changes: StoreChange[] = [];
  store.subscribe((change) => changes.push(change), options);
  return changes;
}

function expectCode(fn: () => unknown, code: string): void {
  let thrown: unknown;
  try {
    fn();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(DrawError);
  expect((thrown as DrawError).code).toBe(code);
}

/** The rows of a layer as a plain object: ids, fields and positions */
function plain(store: Store, values: RowValues | undefined) {
  if (!values) return undefined;
  return {
    ids: idsOf(store, values.rows),
    fields: Object.fromEntries(values.fields),
    ...(values.geometry && {
      types: [...values.geometry.types],
      coordinates: [...values.geometry.coordinates],
    }),
    ...(values.deleted && { deleted: [...values.deleted] }),
  };
}

/** A Store with the layers `a` and `b`, the group `g` in `a`, and the points p, q (in a) and m (in g) */
function withRows(make: () => Store): Store {
  const store = make();
  store.createLayer(layer('a'));
  store.createLayer(layer('b'));
  store.createGroup(group('g', 'a', 'k5'));
  store.createRows(
    pointRows([
      { id: 'p', parent: 'a', orderKey: 'k1', at: [1, 2] },
      { id: 'q', parent: 'a', orderKey: 'k2', at: [3, 4] },
    ]),
  );
  store.createRows(pointRows([{ id: 'm', parent: 'g', orderKey: 'k1', at: [5, 6] }]));
  return store;
}

/** Deletes rows by their ids */
function deleteRows(store: Store, ...ids: string[]): void {
  const refs = ids.map((id) => refOf(store, id));
  store.writeRows(valuesOf(refs, [], { deleted: new Uint8Array(refs.length).fill(1) }));
}

// ---------------------------------------------------------------------------------------------

/** The Stores the tests run on */
const STORES: ReadonlyArray<[string, () => Store]> = [
  ['the built-in Store', () => createStore()],
  [
    'a Store spread from the built-in one, with writeRows replaced',
    () => {
      const base = createStore();
      return { ...base, writeRows: (values: RowValues) => base.writeRows(values) };
    },
  ],
];

describe.each(STORES)('%s', (_name, make) => {
  describe('the values before', () => {
    it('go to the listeners that ask for them, each in its own change, and to no other', () => {
      const store = withRows(make);
      const asking = record(store, { previousValues: true });
      const other = record(store);
      const again = record(store, { previousValues: true });
      store.writeRows(valuesOf([refOf(store, 'p')], [['properties:name', ['P2']]]));
      expect(other[0].previousValues).toBeUndefined();
      expect(other[0].deletedRowsToken).toBeUndefined();
      expect(plain(store, asking[0].previousValues?.get('a'))).toEqual({
        ids: ['p'],
        fields: { 'properties:name': ['P'] },
      });
      expect(asking[0]).not.toBe(again[0]);
      expect(asking[0].previousValues).not.toBe(again[0].previousValues);
      expect(asking[0].previousValues?.get('a')).not.toBe(again[0].previousValues?.get('a'));
      // The rest of the change is the one every listener is told
      expect({ ...asking[0], previousValues: undefined }).toEqual({
        ...other[0],
        previousValues: undefined,
      });
    });

    it('go only with the changes of the sources asked for', () => {
      const store = withRows(make);
      const p = refOf(store, 'p');
      const named = record(store, { previousValues: ['local', 'other'] });
      const except = record(store, { previousValues: { except: ['remote'] } });
      const write = (source: string, name: string) =>
        store.transact(() => store.writeRows(valuesOf([p], [['properties:name', [name]]])), source);
      write('remote', 'R');
      write('local', 'L');
      write('mine', 'M');
      write('other', 'O');
      const carried = (changes: StoreChange[]) =>
        changes.map((change) => [
          change.source,
          change.previousValues?.get('a')?.fields.get('properties:name')?.[0],
        ]);
      expect(carried(named)).toEqual([
        ['remote', undefined],
        ['local', 'R'],
        ['mine', undefined],
        ['other', 'M'],
      ]);
      expect(carried(except)).toEqual([
        ['remote', undefined],
        ['local', 'R'],
        ['mine', 'L'],
        ['other', 'M'],
      ]);
    });

    it('are asked of a function once per transaction, and once per part of an operation', () => {
      const store = withRows(make);
      const p = refOf(store, 'p');
      const q = refOf(store, 'q');
      const asked: Array<{ source: string; operationId: number }> = [];
      const mine = store.newOperationId();
      const changes = record(store, {
        previousValues: (change) => {
          asked.push({ ...change });
          return change.operationId !== mine;
        },
      });
      // One transaction of several writes: asked once, before it writes
      store.transact(() => {
        store.writeRows(valuesOf([p], [['properties:name', ['1']]]));
        store.writeRows(valuesOf([q], [['properties:name', ['2']]]));
      }, 'remote');
      expect(asked).toHaveLength(1);
      expect(asked[0].source).toBe('remote');
      expect(asked[0].operationId).toBe(changes[0].operationId);
      expect(changes[0].previousValues?.get('a')).toBeDefined();
      // An operation of three parts: asked once per part, with its number
      const other = store.newOperationId();
      for (const [i, hasMoreParts] of [true, true, false].entries()) {
        store.transact(
          () => store.writeRows(valuesOf([p], [['properties:name', [`part${i}`]]])),
          'remote',
          { operationId: other, hasMoreParts },
        );
      }
      expect(asked.slice(1)).toEqual([
        { source: 'remote', operationId: other },
        { source: 'remote', operationId: other },
        { source: 'remote', operationId: other },
      ]);
      // The changes of the operation the function answers no for carry none
      store.transact(() => store.writeRows(valuesOf([p], [['properties:name', ['x']]])), 'remote', {
        operationId: mine,
      });
      expect(asked).toHaveLength(5);
      expect(changes.map((change) => change.previousValues !== undefined)).toEqual([
        true,
        true,
        true,
        true,
        false,
      ]);
    });

    it('are not written while the function is asked', () => {
      const store = withRows(make);
      let thrown: unknown;
      store.subscribe(() => {}, {
        previousValues: () => {
          try {
            store.setMetadata({ title: 'x' });
          } catch (error) {
            thrown = error;
          }
          return true;
        },
      });
      store.setMetadata({ title: 'y' });
      expect(thrown).toBeInstanceOf(DrawError);
      expect((thrown as DrawError).code).toBe('invalidState');
      expect(store.getMetadata().title).toBe('y');
    });

    it('are by layer, the values before the first write of the transaction', () => {
      const store = withRows(make);
      const p = refOf(store, 'p');
      const q = refOf(store, 'q');
      const m = refOf(store, 'm');
      const changes = record(store, { previousValues: true });
      store.transact(() => {
        // p written twice: the values before the first write
        store.writeRows(
          valuesOf([p, q], [['properties:name', ['P1', 'Q1']]], {
            geometry: points([
              [10, 20],
              [30, 40],
            ]),
          }),
        );
        store.writeRows(
          valuesOf([p], [['properties:name', ['P2']]], { geometry: points([[11, 21]]) }),
        );
        // m moved out of its group to the layer b, to another place
        store.writeRows(
          valuesOf(
            [m],
            [
              ['parent', ['b']],
              ['orderKey', ['k0']],
            ],
          ),
        );
        // a row created by the transaction has none
        store.createRows(pointRows([{ id: 'n', parent: 'a', orderKey: 'k9', at: [0, 0] }]));
        store.writeRows(valuesOf([refOf(store, 'n')], [['properties:name', ['N1']]]));
      }, 'local');
      const before = changes[0].previousValues;
      expect([...(before?.keys() ?? [])].sort()).toEqual(['a', 'b']);
      expect(plain(store, before?.get('a'))).toEqual({
        ids: ['p', 'q'],
        fields: {
          'properties:name': ['P', 'Q'],
          parent: ['a', 'a'],
          orderKey: ['k1', 'k2'],
        },
        types: [0, 0],
        coordinates: [1, 2, 3, 4],
      });
      expect(plain(store, before?.get('b'))).toEqual({
        ids: ['m'],
        fields: { 'properties:name': ['M'], parent: ['g'], orderKey: ['k1'] },
        types: [0],
        coordinates: [5, 6],
      });
      // Written back, they put the rows back as they were
      const values = before?.get('a');
      if (!values) throw new Error('no values before');
      store.writeRows(values);
      expect(
        store.tables.readValues(Int32Array.of(p, q), ['properties:name', 'geometry']).geometry
          ?.coordinates,
      ).toEqual(Float64Array.of(1, 2, 3, 4));
    });

    it('carry the deletion of the rows deleted and brought back', () => {
      const store = withRows(make);
      const p = refOf(store, 'p');
      const q = refOf(store, 'q');
      const changes = record(store, { previousValues: true, keepDeletedRows: true });
      store.transact(() => {
        store.writeRows(valuesOf([p], [['properties:name', ['P1']]]));
        deleteRows(store, 'q');
      }, 'local');
      expect(plain(store, changes[0].previousValues?.get('a'))).toEqual({
        ids: ['p', 'q'],
        fields: { 'properties:name': ['P', 'Q'] },
        deleted: [0, 0],
      });
      store.writeRows(valuesOf([q], [], { deleted: Uint8Array.of(0) }));
      expect(idsOf(store, changes[1].rows?.layers.get('a')?.updated)).toEqual(['q']);
      expect(plain(store, changes[1].previousValues?.get('a'))).toEqual({
        ids: ['q'],
        fields: {},
        deleted: [1],
      });
      // A write that neither deletes nor brings back carries no deletion
      store.writeRows(valuesOf([p], [['properties:name', ['P2']]]));
      expect(changes[2].previousValues?.get('a')?.deleted).toBeUndefined();
    });

    it('share their arrays between the listeners, without a copy', () => {
      const store = withRows(make);
      const q = refOf(store, 'q');
      const first = record(store, { previousValues: true, keepDeletedRows: true });
      const second = record(store, { previousValues: true, keepDeletedRows: true });
      store.transact(() => {
        store.writeRows(
          valuesOf([refOf(store, 'p')], [['properties:name', ['P1']]], {
            geometry: points([[9, 9]]),
          }),
        );
        deleteRows(store, 'q');
      }, 'local');
      const a = first[0].previousValues?.get('a');
      const b = second[0].previousValues?.get('a');
      expect(a).not.toBe(b);
      expect(a?.rows).toBe(b?.rows);
      expect(a?.fields).not.toBe(b?.fields);
      expect(a?.fields.get('properties:name')).toBe(b?.fields.get('properties:name'));
      expect(a?.geometry?.coordinates).toBe(b?.geometry?.coordinates);
      expect(a?.deleted).toBe(b?.deleted);
      // Each has its own token; the rows stay until both are let go of
      const one = first[0].deletedRowsToken;
      const two = second[0].deletedRowsToken;
      if (one === undefined || two === undefined) throw new Error('no tokens');
      expect(one).not.toBe(two);
      store.releaseDeletedRows(one);
      store.releaseDeletedRows(one);
      expect(
        store.createRows(pointRows([{ id: 'q', parent: 'a', orderKey: 'k3', at: [0, 0] }])),
      ).toBe(false);
      expect(
        store.tables.readValues(Int32Array.of(q), ['properties:name'], { deleted: true }),
      ).toEqual(expect.objectContaining({ fields: new Map([['properties:name', ['Q']]]) }));
      store.releaseDeletedRows(two);
      expect(
        store.tables.readValues(Int32Array.of(q), ['properties:name'], { deleted: true }),
      ).toEqual(
        expect.objectContaining({
          fields: new Map([['properties:name', [undefined]]]),
          deleted: Uint8Array.of(1),
        }),
      );
      expect(
        store.createRows(pointRows([{ id: 'q', parent: 'a', orderKey: 'k3', at: [0, 0] }])),
      ).toBe(true);
    });

    it('are refused in options of another kind', () => {
      const store = make();
      const listener = () => {};
      for (const options of [
        'yes',
        { previousValues: 'local' },
        { previousValues: [1] },
        { previousValues: { except: 'remote' } },
        { keepDeletedRows: 'yes' },
      ]) {
        expectCode(() => store.subscribe(listener, options as SubscribeOptions), 'invalidInput');
      }
    });
  });

  describe('the deleted rows kept', () => {
    it('are kept for a listener that asks, with a token, their ids in use until it lets go', () => {
      const store = withRows(make);
      const q = refOf(store, 'q');
      const keeping = record(store, { keepDeletedRows: true });
      const other = record(store);
      // No token for a change that deletes nothing
      store.writeRows(valuesOf([q], [['properties:name', ['Q1']]]));
      expect(keeping[0].deletedRowsToken).toBeUndefined();
      deleteRows(store, 'q');
      const token = keeping[1].deletedRowsToken;
      expect(token).toBeTypeOf('number');
      expect(other[1].deletedRowsToken).toBeUndefined();
      // The id stays in use: as a row, and as a group
      expect(store.tables.getRowRef('q')).toBeUndefined();
      expect(
        store.createRows(pointRows([{ id: 'q', parent: 'a', orderKey: 'k3', at: [0, 0] }])),
      ).toBe(false);
      expect(store.createGroup(group('q', 'a', 'k8'))).toBe(false);
      // The deleted row is read by its reference, with the values it had when it was deleted
      const read = store.tables.readValues(Int32Array.of(q), ['properties:name', 'geometry'], {
        deleted: true,
      });
      expect(plain(store, read)).toEqual({
        ids: ['q'],
        fields: { 'properties:name': ['Q1'] },
        types: [0],
        coordinates: [3, 4],
        deleted: [1],
      });
      store.releaseDeletedRows(token as never);
      expect(
        store.createRows(pointRows([{ id: 'q', parent: 'a', orderKey: 'k3', at: [7, 7] }])),
      ).toBe(true);
    });

    it('are not there when nothing keeps them', () => {
      const store = withRows(make);
      const q = refOf(store, 'q');
      deleteRows(store, 'q');
      expect(
        plain(
          store,
          store.tables.readValues(Int32Array.of(q), ['properties:name', 'geometry'], {
            deleted: true,
          }),
        ),
      ).toEqual({
        ids: ['q'],
        fields: { 'properties:name': [undefined] },
        types: [255],
        coordinates: [],
        deleted: [1],
      });
      expectCode(
        () => store.writeRows(valuesOf([q], [], { deleted: Uint8Array.of(0) })),
        'notFound',
      );
      expect(
        store.createRows(pointRows([{ id: 'q', parent: 'a', orderKey: 'k3', at: [0, 0] }])),
      ).toBe(true);
    });

    it('come back with their values and at their places, with their references', () => {
      const store = withRows(make);
      const m = refOf(store, 'm');
      const p = refOf(store, 'p');
      const keeping = record(store, { keepDeletedRows: true });
      deleteRows(store, 'm', 'p');
      const view = store.tables.get('a');
      expect(view?.rowCount).toBe(1);
      expect(idsOf(store, view?.listRowRefs(0, 10))).toEqual(['q']);
      store.writeRows(valuesOf([m], [], { deleted: Uint8Array.of(0) }));
      expect(store.tables.getRowRef('m')).toBe(m);
      expect(idsOf(store, keeping[1].rows?.layers.get('a')?.updated)).toEqual(['m']);
      expect(keeping[1].rows?.layers.get('a')?.created).toHaveLength(0);
      expect(
        Object.fromEntries(
          store.tables.readValues(Int32Array.of(m), ['parent', 'orderKey', 'properties:name'])
            .fields,
        ),
      ).toEqual({ parent: ['g'], orderKey: ['k1'], 'properties:name': ['M'] });
      expect(idsOf(store, view?.listRowRefs(0, 10))).toEqual(['q', 'm']);
      expect(view?.countGroupMembers(store.tables.findGroup('g') as number)).toBe(1);
      // A row kept is written only to be brought back
      expectCode(() => store.writeRows(valuesOf([p], [['properties:name', ['x']]])), 'notFound');
      expectCode(
        () => store.writeRows(valuesOf([p], [], { deleted: Uint8Array.of(1) })),
        'notFound',
      );
      // Let go of, it does not come back
      store.releaseDeletedRows(keeping[0].deletedRowsToken as never);
      expectCode(
        () => store.writeRows(valuesOf([p], [], { deleted: Uint8Array.of(0) })),
        'notFound',
      );
      expect(store.tables.getRowRef('m')).toBe(m);
    });

    it('come back under the parent given when their group is gone, and not without one', () => {
      const store = withRows(make);
      const m = refOf(store, 'm');
      const keeping = record(store, { keepDeletedRows: true });
      deleteRows(store, 'm');
      // The next change deletes the group the row was in
      store.deleteGroup('g');
      expect(store.getGroup('g')).toBeUndefined();
      const written = keeping.length;
      expectCode(
        () => store.writeRows(valuesOf([m], [], { deleted: Uint8Array.of(0) })),
        'notFound',
      );
      expect(keeping).toHaveLength(written);
      expect(store.tables.getRowRef('m')).toBeUndefined();
      store.writeRows(
        valuesOf(
          [m],
          [
            ['parent', ['a']],
            ['orderKey', ['k9']],
          ],
          { deleted: Uint8Array.of(0) },
        ),
      );
      expect(store.tables.getRowRef('m')).toBe(m);
      expect(
        Object.fromEntries(
          store.tables.readValues(Int32Array.of(m), ['parent', 'orderKey', 'properties:name'])
            .fields,
        ),
      ).toEqual({ parent: ['a'], orderKey: ['k9'], 'properties:name': ['M'] });
      expect(idsOf(store, store.tables.get('a')?.listRowRefs(0, 10))).toEqual(['p', 'q', 'm']);
    });

    it('are kept with the rows of a layer deleted, and come back once the layer is there again', () => {
      const store = withRows(make);
      const p = refOf(store, 'p');
      const keeping = record(store, { keepDeletedRows: true });
      store.deleteLayer('a');
      expect(keeping[0].deletedRowsToken).toBeTypeOf('number');
      expect(idsOf(store, keeping[0].rows?.layers.get('a')?.deleted).sort()).toEqual([
        'm',
        'p',
        'q',
      ]);
      store.createLayer(layer('a'));
      store.writeRows(valuesOf([p], [], { deleted: Uint8Array.of(0) }));
      expect(store.tables.getRowRef('p')).toBe(p);
      expect(store.tables.get('a')?.rowCount).toBe(1);
    });

    it('keep nothing after a clear, and a change with reset has no token', () => {
      const store = withRows(make);
      const q = refOf(store, 'q');
      const keeping = record(store, { keepDeletedRows: true });
      deleteRows(store, 'q');
      const token = keeping[0].deletedRowsToken;
      expect(token).toBeTypeOf('number');
      store.clear();
      expect(keeping[1].reset).toBe(true);
      expect(keeping[1].deletedRowsToken).toBeUndefined();
      expectCode(
        () => store.writeRows(valuesOf([q], [], { deleted: Uint8Array.of(0) })),
        'notFound',
      );
      store.releaseDeletedRows(token as never);
      store.createLayer(layer('a'));
      expect(
        store.createRows(pointRows([{ id: 'q', parent: 'a', orderKey: 'k1', at: [0, 0] }])),
      ).toBe(true);
      expect(store.tables.getRowRef('q')).toBe(q);
    });

    it('do nothing for a token let go of, or one the Store does not know', () => {
      const store = withRows(make);
      const before = store.tables.readValues(Int32Array.of(refOf(store, 'p')), ['properties:name']);
      store.releaseDeletedRows(12345 as never);
      store.releaseDeletedRows('x' as never);
      expect(
        store.tables.readValues(Int32Array.of(refOf(store, 'p')), ['properties:name']),
      ).toEqual(before);
    });

    it('are left out of the references of the rows of a layer', () => {
      const store = make();
      store.createLayer(layer('a'));
      const rows = Array.from({ length: 2_000 }, (_, i) => ({
        id: `r${String(i).padStart(4, '0')}`,
        parent: 'a',
        orderKey: `k${String(i).padStart(4, '0')}`,
        at: [i, 0] as [number, number],
      }));
      store.createRows(pointRows(rows));
      // Every third row deleted: the first ones kept, the others not
      const gone = rows.filter((_, i) => i % 3 === 0).map((row) => row.id);
      const unsubscribe = store.subscribe(() => {}, { keepDeletedRows: true });
      deleteRows(store, ...gone.slice(0, 300));
      unsubscribe();
      deleteRows(store, ...gone.slice(300));
      const view = store.tables.get('a');
      if (!view) throw new Error('no rows');
      const left = rows.map((row) => row.id).filter((id) => !gone.includes(id));
      expect(view.rowCount).toBe(left.length);
      expect(idsOf(store, view.listRowRefs(0, view.rowCount))).toEqual(left);
      expect(idsOf(store, view.listRowRefs(1_500, 10))).toEqual(left.slice(1_500, 1_510));
      expect(idsOf(store, view.listRowRefs(left.length - 2, 10))).toEqual(left.slice(-2));
    });
  });
});
