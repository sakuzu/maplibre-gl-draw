// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The boxes of the rows of the types that give theirs (`setRowBoxes`), and the ids a group and a
 * layer take, on the built-in Store and on a Store spread from it
 *
 * - While no box is set, every row has the box of its positions: what the rows drawn, the scan and
 *   the box of a row read
 * - The rows of a type the boxes set give have the box given there; the others keep the box of
 *   their positions. Setting the boxes again makes them again, a row written gets its box again,
 *   and taking them back gives every row the box of its positions. Each moves the revision of the
 *   rows drawn
 * - Tables that are not those of a built-in Store, and boxes without their functions, are refused
 * - A group and a layer take the id of a row the transaction open deleted, whatever the listeners
 *   keep; the row stays deleted, and a token that kept it does not bring it back while a group or
 *   a layer holds its id
 */

import { describe, expect, it } from 'vitest';
import type { Layer, Metadata } from '../../api/model.js';
import { DrawError } from '../../shared/errors.js';
import { createStore } from './create-store.js';
import { setRowBoxes } from './row-boxes.js';
import type {
  FeatureRowField,
  GeometryColumn,
  NewRows,
  Store,
  StoreChange,
  StoreGroup,
} from './types.js';

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

function group(id: string): StoreGroup {
  return { id, layerId: 'a', name: id, visible: true, locked: false, orderKey: `g${id}` };
}

/** Points at the origin, one per row */
function pointsAtOrigin(count: number): GeometryColumn {
  const starts = Int32Array.from({ length: count + 1 }, (_, i) => i);
  return {
    types: new Uint8Array(count),
    coordinates: new Float64Array(count * 2),
    valuesPerPosition: 2,
    partStarts: starts,
    ringStarts: starts,
    positionStarts: starts,
  };
}

/** New rows of the layer `a` at the origin, of the types given, with the attribute `size` 1 */
function newRows(ids: readonly string[], types: readonly string[]): NewRows {
  return {
    ids,
    fields: new Map<FeatureRowField, readonly unknown[]>([
      ['type', types],
      ['parent', ids.map(() => 'a')],
      ['orderKey', ids.map((id) => `k${id}`)],
      ['properties:size', ids.map(() => 1)],
    ]),
    geometry: pointsAtOrigin(ids.length),
  };
}

function refOf(store: Store, id: string): number {
  const ref = store.tables.getRowRef(id);
  if (ref === undefined) throw new Error(`no row ${id}`);
  return ref;
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

/** The ids of the rows whose box meets a box: those drawn, and those the scan reads */
function idsIn(store: Store, bbox: [number, number, number, number]) {
  const drawn = [...(store.tables.get('a')?.listDrawnRows(bbox) ?? [])].map((ref) =>
    store.tables.getRowId(ref),
  );
  const scanned: (string | undefined)[] = [];
  const cursor = store.tables.scan({ bbox });
  for (let batch = cursor.next(); batch !== null; batch = cursor.next()) {
    for (const ref of batch) scanned.push(store.tables.getRowId(ref));
  }
  return { drawn: drawn.sort(), scanned: scanned.sort() };
}

/** Away from the origin, within the box given */
const AWAY: [number, number, number, number] = [0.5, 0.5, 0.6, 0.6];

/**
 * A Store with the layer `a`, an Image `img` and a Point `pt` at the origin, and boxes that give
 * the rows of the Image a square of the side of twice their `size`
 */
function withRows(make: () => Store) {
  const store = make();
  store.createLayer(layer('a'));
  store.createRows(newRows(['img', 'pt'], ['Image', 'Point']));
  let asked = 0;
  const boxes = {
    gives: (type: string) => type === 'Image',
    boxOf: (ref: number, out: Float64Array) => {
      asked += 1;
      const size = store.tables.get('a')?.getRowProperty(ref, 'size') as number;
      out.set([-size, -size, size, size]);
      return true;
    },
  };
  return { store, boxes, asked: () => asked };
}

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
  describe('the boxes of the rows', () => {
    it('are those of their positions while no box is set', () => {
      const { store } = withRows(make);
      expect(idsIn(store, AWAY)).toEqual({ drawn: [], scanned: [] });
      expect(idsIn(store, [-0.1, -0.1, 0.1, 0.1])).toEqual({
        drawn: ['img', 'pt'],
        scanned: ['img', 'pt'],
      });
      expect(store.tables.get('a')?.getRowBBox(refOf(store, 'img'))).toEqual([0, 0, 0, 0]);
    });

    it('are the boxes set for the rows of a type that gives them, and those of their positions for the others', () => {
      const { store, boxes } = withRows(make);
      setRowBoxes(store.tables, boxes);
      expect(idsIn(store, AWAY)).toEqual({ drawn: ['img'], scanned: ['img'] });
      const view = store.tables.get('a');
      expect(view?.getRowBBox(refOf(store, 'img'))).toEqual([-1, -1, 1, 1]);
      expect(view?.getRowBBox(refOf(store, 'pt'))).toEqual([0, 0, 0, 0]);
    });

    it('are made again when a row is written, and when the boxes are set again, which moves the revision', () => {
      const { store, boxes } = withRows(make);
      setRowBoxes(store.tables, boxes);
      const view = store.tables.get('a');
      const far: [number, number, number, number] = [2.5, 2.5, 2.6, 2.6];
      expect(idsIn(store, far).drawn).toEqual([]);
      store.writeRows({
        rows: Int32Array.of(refOf(store, 'img')),
        fields: new Map([['properties:size', [3]]]),
      });
      expect(idsIn(store, far)).toEqual({ drawn: ['img'], scanned: ['img'] });

      // What the boxes depend on changes outside the rows: the same boxes, set again
      let side = 3;
      const outside = {
        gives: boxes.gives,
        boxOf: (_ref: number, out: Float64Array) => {
          out.set([-side, -side, side, side]);
          return true;
        },
      };
      setRowBoxes(store.tables, outside);
      side = 10;
      const before = view?.getDrawnRowsRevision() as number;
      setRowBoxes(store.tables, outside);
      expect(view?.getDrawnRowsRevision()).toBeGreaterThan(before);
      expect(idsIn(store, [9.5, 9.5, 9.6, 9.6])).toEqual({ drawn: ['img'], scanned: ['img'] });
    });

    it('are those of their positions again once the boxes are taken back, which moves the revision', () => {
      const { store, boxes } = withRows(make);
      const takeBack = setRowBoxes(store.tables, boxes);
      expect(idsIn(store, AWAY).drawn).toEqual(['img']);
      const view = store.tables.get('a');
      const before = view?.getDrawnRowsRevision() as number;
      takeBack();
      expect(view?.getDrawnRowsRevision()).toBeGreaterThan(before);
      expect(idsIn(store, AWAY)).toEqual({ drawn: [], scanned: [] });

      // Taking back boxes others replaced does nothing
      const takeBackAgain = setRowBoxes(store.tables, boxes);
      setRowBoxes(store.tables, { ...boxes });
      takeBackAgain();
      expect(idsIn(store, AWAY).drawn).toEqual(['img']);
    });

    it('find a hidden row and leave out a deleted one in the scan', () => {
      const { store, boxes } = withRows(make);
      setRowBoxes(store.tables, boxes);
      const img = refOf(store, 'img');
      store.writeRows({ rows: Int32Array.of(img), fields: new Map([['visible', [false]]]) });
      expect(idsIn(store, AWAY)).toEqual({ drawn: [], scanned: ['img'] });
      store.writeRows({ rows: Int32Array.of(img), fields: new Map(), deleted: Uint8Array.of(1) });
      expect(idsIn(store, AWAY)).toEqual({ drawn: [], scanned: [] });
    });

    it('are asked only of the rows of the types that give them', () => {
      const { store, boxes, asked } = withRows(make);
      setRowBoxes(store.tables, boxes);
      idsIn(store, AWAY);
      expect(asked()).toBe(1);
    });
  });

  it('refuses tables that are not those of a built-in Store, and boxes without their functions', () => {
    const { store, boxes } = withRows(make);
    expect(codeOf(() => setRowBoxes({}, boxes))).toBe('invalidInput');
    expect(codeOf(() => setRowBoxes(undefined, boxes))).toBe('invalidInput');
    expect(
      codeOf(() => setRowBoxes(store.tables, { gives: boxes.gives } as unknown as typeof boxes)),
    ).toBe('invalidInput');
  });

  describe.each([
    ['without a listener that keeps the deleted rows', false],
    ['with a listener that keeps the deleted rows', true],
  ])('the id of a row the transaction open deleted, %s', (_keeping, keep) => {
    /** A Store with the rows `img` and `pt`, and what its listener was told */
    function deleting() {
      const { store } = withRows(make);
      const changes: StoreChange[] = [];
      store.subscribe((change) => changes.push(change), { keepDeletedRows: keep });
      const deleteRow = (id: string) =>
        store.writeRows({
          rows: Int32Array.of(refOf(store, id)),
          fields: new Map(),
          deleted: Uint8Array.of(1),
        });
      return { store, changes, deleteRow };
    }

    it('is taken by a group, and the row stays deleted', () => {
      const { store, deleteRow } = deleting();
      store.transact(() => {
        deleteRow('pt');
        expect(store.createGroup(group('pt'))).toBe(true);
      }, 'remote');
      expect(store.getGroup('pt')?.id).toBe('pt');
      expect(store.tables.getRowRef('pt')).toBeUndefined();
      expect(store.tables.get('a')?.rowCount).toBe(1);
    });

    it('is taken by a layer, and the row stays deleted', () => {
      const { store, deleteRow } = deleting();
      store.transact(() => {
        deleteRow('pt');
        expect(store.createLayer(layer('pt'))).toBe(true);
      }, 'remote');
      expect(store.getLayer('pt')?.id).toBe('pt');
      expect(store.tables.getRowRef('pt')).toBeUndefined();
    });

    it('is in use for a group once the transaction has ended while a token keeps the row', () => {
      const { store, deleteRow } = deleting();
      store.transact(() => deleteRow('pt'), 'remote');
      expect(store.createGroup(group('pt'))).toBe(!keep);
    });
  });

  describe('a row a token keeps, whose id a group or a layer took', () => {
    for (const taker of ['group', 'layer'] as const) {
      it(`is not brought back while a ${taker} holds its id`, () => {
        const { store } = withRows(make);
        const changes: StoreChange[] = [];
        store.subscribe((change) => changes.push(change), { keepDeletedRows: true });
        const pt = refOf(store, 'pt');
        store.transact(() => {
          store.writeRows({
            rows: Int32Array.of(pt),
            fields: new Map(),
            deleted: Uint8Array.of(1),
          });
          if (taker === 'group') store.createGroup(group('pt'));
          else store.createLayer(layer('pt'));
        }, 'remote');
        expect(changes[changes.length - 1]?.deletedRowsToken).toBeDefined();
        expect(store.tables.findRow('pt')).toEqual({ ref: pt, deleted: true });

        const back = store.writeRows({
          rows: Int32Array.of(pt),
          fields: new Map(),
          deleted: Uint8Array.of(0),
        });
        expect(back).toBe(false);
        expect(store.tables.getRowRef('pt')).toBeUndefined();
        expect(store.tables.findRow('pt')).toEqual({ ref: pt, deleted: true });
      });
    }

    it('is brought back once the group that held its id is deleted', () => {
      const { store } = withRows(make);
      store.subscribe(() => {}, { keepDeletedRows: true });
      const pt = refOf(store, 'pt');
      store.transact(() => {
        store.writeRows({ rows: Int32Array.of(pt), fields: new Map(), deleted: Uint8Array.of(1) });
        store.createGroup(group('pt'));
      }, 'remote');
      store.deleteGroup('pt');
      const back = store.writeRows({
        rows: Int32Array.of(pt),
        fields: new Map(),
        deleted: Uint8Array.of(0),
      });
      expect(back).toBe(true);
      expect(store.tables.getRowRef('pt')).toBe(pt);
    });
  });
});
