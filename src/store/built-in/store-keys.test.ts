// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The keys of the attributes, the keys of the style, the deleted rows found by their ids, and the
 * layers of 3 and 4 values per position, on the built-in Store and on a Store spread from it
 *
 * - `listPropertyKeys` lists the keys of the attributes each once, of the rows given or of all
 * - `style:<key>` reads and writes one key of the style, leaving the other keys, and the change
 *   and the values before name the keys written
 * - `findRow` finds a deleted row while a token keeps it, and not once it is let go of
 * - A layer of 3 or 4 values per position keeps the heights and the measures of its rows
 * - Every string, as a key or as a value, is well-formed, and no value nests more than 32 deep
 * - A deleted row nothing keeps is not there for any read, and a hidden layer draws no row
 * - The work of the keys of the style and of `findRow` does not grow with the rows
 */

import type { Geometry, Position } from 'geojson';
import { describe, expect, it } from 'vitest';
import type { Layer, Metadata } from '../../api/model.js';
import { DrawError } from '../../shared/errors.js';
import { countsOf, expectNotProportional, workDuring } from '../../test-utils.js';
import { createStore } from './create-store.js';
import { createRowPageBuilder } from './pages.js';
import {
  type FeatureRowField,
  GEOMETRY_TYPES,
  type GeometryColumn,
  type NewRows,
  type RowValues,
  type Store,
  type StoreChange,
  type SubscribeOptions,
} from './types.js';
import { validateRowValues } from './validate.js';

// ---------------------------------------------------------------------------------------------
// What the tests write

function layer(id: string, more: Partial<Layer> = {}): Layer {
  return {
    id,
    name: id,
    visible: true,
    locked: false,
    opacity: 1,
    styleRule: undefined,
    metadata: undefined,
    ...more,
  };
}

function point(...position: number[]): Geometry {
  return { type: 'Point', coordinates: position };
}

/** The geometries of rows as one column */
function columnOf(geometries: readonly Geometry[], valuesPerPosition = 2): GeometryColumn {
  const types = new Uint8Array(geometries.length);
  const values: number[] = [];
  const partStarts = [0];
  const ringStarts = [0];
  const positionStarts = [0];
  const addRing = (positions: Position[]) => {
    for (const position of positions) values.push(...position.slice(0, valuesPerPosition));
    positionStarts.push(positionStarts[positionStarts.length - 1] + positions.length);
  };
  geometries.forEach((geometry, i) => {
    types[i] = (GEOMETRY_TYPES as readonly string[]).indexOf(geometry.type);
    if (geometry.type === 'Point') addRing([geometry.coordinates]);
    else if (geometry.type === 'LineString') addRing(geometry.coordinates);
    else throw new Error('a geometry the tests do not write');
    ringStarts.push(ringStarts[ringStarts.length - 1] + 1);
    partStarts.push(ringStarts.length - 1);
  });
  return {
    types,
    coordinates: Float64Array.from(values),
    valuesPerPosition,
    partStarts: Int32Array.from(partStarts),
    ringStarts: Int32Array.from(ringStarts),
    positionStarts: Int32Array.from(positionStarts),
  };
}

/** New points of one parent, with the fields given besides */
function newRows(
  ids: readonly string[],
  parent: string,
  more: ReadonlyArray<[FeatureRowField, unknown[]]> = [],
  geometry: GeometryColumn = columnOf(ids.map((_, i) => point(i, 0))),
): NewRows {
  return {
    ids,
    fields: new Map<FeatureRowField, readonly unknown[]>([
      ['type', ids.map(() => 'Point')],
      ['parent', ids.map(() => parent)],
      ['orderKey', ids.map((_, i) => `k${String(i).padStart(6, '0')}`)],
      ...more,
    ]),
    geometry,
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

/** The values of the fields read, as a plain object */
function fieldsOf(values: RowValues): Record<string, unknown> {
  return Object.fromEntries(values.fields);
}

/**
 * A Store with the layer `a` and the rows p, q (style `{ fillColor: '#f00', strokeWidth: 2 }`,
 * attributes) and r (no style, no attribute)
 */
function withRows(make: () => Store): Store {
  const store = make();
  store.createLayer(layer('a'));
  const style = { fillColor: '#f00', strokeWidth: 2 };
  store.createRows(
    newRows(['p', 'q', 'r'], 'a', [
      ['style', [style, style, undefined]],
      ['properties:name', ['P', 'Q', undefined]],
      ['properties:height', [10, undefined, undefined]],
    ]),
  );
  return store;
}

/** The lone surrogate, as a string */
const LONE = '\uD800';

/** A value of arrays nested `depth` deep */
function nested(depth: number): unknown {
  let value: unknown = 1;
  for (let i = 0; i < depth; i++) value = [value];
  return value;
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
  describe('the keys of the attributes', () => {
    it('are listed each once, of every row or of the rows given', () => {
      const store = withRows(make);
      expect(store.listPropertyKeys().sort()).toEqual(['height', 'name']);
      expect(store.listPropertyKeys(Int32Array.of(refOf(store, 'q')))).toEqual(['name']);
      expect(store.listPropertyKeys(Int32Array.of(refOf(store, 'r')))).toEqual([]);
      // A key taken off is not listed
      store.writeRows(valuesOf([refOf(store, 'p')], [['properties:height', [undefined]]]));
      expect(store.listPropertyKeys()).toEqual(['name']);
      expectCode(() => store.listPropertyKeys([1] as unknown as Int32Array), 'invalidInput');
    });
  });

  describe('the keys of the style', () => {
    it('are written one at a time, leaving the other keys, and taken off with undefined', () => {
      const store = withRows(make);
      const p = refOf(store, 'p');
      const q = refOf(store, 'q');
      const r = refOf(store, 'r');
      const changes = record(store);
      store.writeRows(valuesOf([p, r], [['style:fillColor', ['#0f0', '#00f']]]));
      const view = store.tables.get('a');
      expect(view?.getRowStyle(p)).toEqual({ fillColor: '#0f0', strokeWidth: 2 });
      expect(view?.getRowStyle(q)).toEqual({ fillColor: '#f00', strokeWidth: 2 });
      expect(view?.getRowStyle(r)).toEqual({ fillColor: '#00f' });
      expect(changes[0].rows?.layers.get('a')?.fields).toEqual(new Set(['style:fillColor']));
      store.writeRows(
        valuesOf(
          [p],
          [
            ['style:strokeWidth', [undefined]],
            ['style:pointShape', ['square']],
          ],
        ),
      );
      expect(view?.getRowStyle(p)).toEqual({ fillColor: '#0f0', pointShape: 'square' });
      expect(changes[1].rows?.layers.get('a')?.fields).toEqual(
        new Set(['style:strokeWidth', 'style:pointShape']),
      );
    });

    it('are read one at a time, undefined for a row without the key', () => {
      const store = withRows(make);
      const rows = Int32Array.of(refOf(store, 'p'), refOf(store, 'r'));
      const values = store.tables.readValues(rows, ['style:strokeWidth', 'style:fillColor']);
      expect(fieldsOf(values)).toEqual({
        'style:strokeWidth': [2, undefined],
        'style:fillColor': ['#f00', undefined],
      });
      // Read with the whole style as well
      expect(fieldsOf(store.tables.readValues(rows, ['style', 'style:fillColor']))).toEqual({
        style: [{ fillColor: '#f00', strokeWidth: 2 }, {}],
        'style:fillColor': ['#f00', undefined],
      });
      // An attribute is read alone by its key; a key of the style is not an attribute
      expect(store.tables.get('a')?.getRowProperty(refOf(store, 'p'), 'name')).toBe('P');
      expect(store.tables.get('a')?.getRowProperty(refOf(store, 'p'), 'fillColor')).toBe(undefined);
    });

    it('are written to new rows, from no style', () => {
      const store = make();
      store.createLayer(layer('a'));
      store.createRows(newRows(['n', 'o'], 'a', [['style:fillColor', ['#123', undefined]]]));
      const view = store.tables.get('a');
      expect(view?.getRowStyle(refOf(store, 'n'))).toEqual({ fillColor: '#123' });
      expect(view?.getRowStyle(refOf(store, 'o'))).toEqual({});
    });

    it('carry the values before of the keys written, which write the rows back', () => {
      const store = withRows(make);
      const p = refOf(store, 'p');
      const r = refOf(store, 'r');
      const changes = record(store, { previousValues: true });
      store.writeRows(valuesOf([p, r], [['style:fillColor', ['#0f0', '#00f']]]));
      const before = changes[0].previousValues?.get('a');
      if (!before) throw new Error('no values before');
      expect([...before.fields.keys()]).toEqual(['style:fillColor']);
      expect(fieldsOf(before)).toEqual({ 'style:fillColor': ['#f00', undefined] });
      store.writeRows(before);
      const view = store.tables.get('a');
      expect(view?.getRowStyle(p)).toEqual({ fillColor: '#f00', strokeWidth: 2 });
      expect(view?.getRowStyle(r)).toEqual({});
      // The whole style written: its values before are the whole style
      store.writeRows(valuesOf([p], [['style', [{ fillColor: '#fff' }]]]));
      expect([...(changes[2].previousValues?.get('a')?.fields.keys() ?? [])]).toEqual(['style']);
      expect(changes[2].rows?.layers.get('a')?.fields).toEqual(new Set(['style']));
    });

    it('share one new style between the rows of one style given one value', () => {
      const store = withRows(make);
      const p = refOf(store, 'p');
      const q = refOf(store, 'q');
      store.writeRows(valuesOf([p, q], [['style:fillColor', ['#0f0', '#0f0']]]));
      const view = store.tables.get('a');
      expect(view?.getRowStyle(p)).toBe(view?.getRowStyle(q));
    });

    it('are refused with the whole style in one write, and for a value that is not one', () => {
      const store = withRows(make);
      const p = refOf(store, 'p');
      for (const fields of [
        [
          ['style', [{}]],
          ['style:fillColor', ['#000']],
        ],
        [['style:fillColor', [true]]],
        [['style:fillColor', [Number.NaN]]],
        [['style:fillColor', [`a${LONE}`]]],
        [[`style:fill${LONE}`, ['#000']]],
      ] as Array<Array<[FeatureRowField, unknown[]]>>) {
        expectCode(() => store.writeRows(valuesOf([p], fields)), 'invalidInput');
        expectCode(
          () =>
            store.createRows(
              newRows(
                ['x'],
                'a',
                fields.map(([f, v]) => [f, v]),
              ),
            ),
          'invalidInput',
        );
      }
      expect(store.tables.get('a')?.getRowStyle(p)).toEqual({ fillColor: '#f00', strokeWidth: 2 });
      expect(store.tables.getRowRef('x')).toBeUndefined();
    });
  });

  describe('the deleted rows found by their ids', () => {
    it('are found while a token keeps them, and not once it is let go of', () => {
      const store = withRows(make);
      const q = refOf(store, 'q');
      const keeping = record(store, { keepDeletedRows: true });
      expect(store.tables.findRow('q')).toEqual({ ref: q, deleted: false });
      store.writeRows(valuesOf([q], [], { deleted: Uint8Array.of(1) }));
      expect(store.tables.findRow('q')).toEqual({ ref: q, deleted: true });
      expect(store.tables.getRowRef('q')).toBeUndefined();
      store.releaseDeletedRows(
        keeping[0].deletedRowsToken as NonNullable<StoreChange['deletedRowsToken']>,
      );
      expect(store.tables.findRow('q')).toBeUndefined();
      expect(store.tables.findRow('none')).toBeUndefined();
    });

    it('are not there for any read when nothing keeps them', () => {
      const store = withRows(make);
      const p = refOf(store, 'p');
      store.writeRows(valuesOf([p], [], { deleted: Uint8Array.of(1) }));
      const view = store.tables.get('a');
      expect(store.tables.findRow('p')).toBeUndefined();
      expect(view?.getRowType(p)).toBeNull();
      expect(view?.getPointPosition(p)).toBeNull();
      expect(view?.getRowBBox(p)).toBeNull();
      expect(view?.getRowProperty(p, 'name')).toBeUndefined();
      expect(view?.getRowStyle(p)).toBeUndefined();
      expect(
        fieldsOf(store.tables.readValues(Int32Array.of(p), ['type', 'style:fillColor'])),
      ).toEqual({ type: [undefined], 'style:fillColor': [undefined] });
    });
  });

  describe('the layers of 3 and 4 values per position', () => {
    it('keep the heights and the measures of their rows', () => {
      const store = make();
      store.createLayer(layer('z'), { valuesPerPosition: 3 });
      store.createLayer(layer('m'), { valuesPerPosition: 3, thirdValue: 'measure' });
      store.createLayer(layer('zm'), { valuesPerPosition: 4 });
      expect(store.tables.getValuesPerPosition('z')).toBe(3);
      expect(store.tables.getThirdValue('z')).toBe('height');
      expect(store.tables.getThirdValue('m')).toBe('measure');
      expect(store.tables.getValuesPerPosition('zm')).toBe(4);
      expect(store.tables.getThirdValue('zm')).toBe('height');
      expect(store.tables.getValuesPerPosition('none')).toBeUndefined();
      store.createRows(newRows(['z1'], 'z', [], columnOf([point(1, 2, 30)], 3)));
      store.createRows(newRows(['m1'], 'm', [], columnOf([point(1, 2, 7)], 3)));
      store.createRows(newRows(['zm1'], 'zm', [], columnOf([point(1, 2, 30, 7)], 4)));
      const read = (id: string) =>
        store.tables.readValues(Int32Array.of(refOf(store, id)), ['geometry']).geometry;
      expect([...(read('z1')?.coordinates ?? [])]).toEqual([1, 2, 30]);
      expect([...(read('m1')?.coordinates ?? [])]).toEqual([1, 2, 7]);
      expect([...(read('zm1')?.coordinates ?? [])]).toEqual([1, 2, 30, 7]);
      expect(read('zm1')?.valuesPerPosition).toBe(4);
      // Written again, and moved between the two layers of 3 values
      const z1 = refOf(store, 'z1');
      store.writeRows(valuesOf([z1], [], { geometry: columnOf([point(5, 6, 40)], 3) }));
      expect([...(read('z1')?.coordinates ?? [])]).toEqual([5, 6, 40]);
      expect(store.tables.get('z')?.getPointPosition(z1)).toEqual([5, 6]);
    });

    it('refuse geometries of another number of values per position', () => {
      const store = make();
      store.createLayer(layer('a'));
      store.createLayer(layer('z'), { valuesPerPosition: 3 });
      expectCode(
        () => store.createRows(newRows(['x'], 'z', [], columnOf([point(1, 2)], 2))),
        'invalidInput',
      );
      expectCode(
        () => store.createRows(newRows(['x'], 'a', [], columnOf([point(1, 2, 3)], 3))),
        'invalidInput',
      );
      store.createRows(newRows(['z1'], 'z', [], columnOf([point(1, 2, 3)], 3)));
      expectCode(
        () =>
          store.writeRows(
            valuesOf([refOf(store, 'z1')], [], { geometry: columnOf([point(1, 2, 3, 4)], 4) }),
          ),
        'invalidInput',
      );
      expect(store.tables.getRowRef('x')).toBeUndefined();
    });

    it('take the pages built for them, and refuse the pages of another third value', () => {
      const store = make();
      store.createLayer(layer('m'), { valuesPerPosition: 3, thirdValue: 'measure' });
      store.createLayer(layer('z'), { valuesPerPosition: 3 });
      const build = (thirdValue: 'height' | 'measure', id: string) => {
        const builder = createRowPageBuilder({ valuesPerPosition: 3, thirdValue });
        builder.addRow({ id, type: 'Point', geometry: point(1, 2, 9), orderKey: 'k1' });
        return builder.finish();
      };
      expectCode(() => store.createRowsFromPages('m', build('height', 'h1')), 'invalidInput');
      expectCode(() => store.createRowsFromPages('z', build('measure', 'm0')), 'invalidInput');
      expect(store.createRowsFromPages('m', build('measure', 'm1'))).toBe(true);
      expect(store.createRowsFromPages('z', build('height', 'z1'))).toBe(true);
      const read = (id: string) => [
        ...(store.tables.readValues(Int32Array.of(refOf(store, id)), ['geometry']).geometry
          ?.coordinates ?? []),
      ];
      expect(read('m1')).toEqual([1, 2, 9]);
      expect(read('z1')).toEqual([1, 2, 9]);
    });
  });

  describe('the strings and the nesting of the values', () => {
    it('refuse a lone surrogate in an id, a key or a value, and a value nested more than 32 deep', () => {
      const store = withRows(make);
      const p = refOf(store, 'p');
      expectCode(() => store.createRows(newRows([`x${LONE}`], 'a')), 'invalidInput');
      for (const fields of [
        [['type', [`Point${LONE}`]]],
        [['orderKey', [`k${LONE}`]]],
        [['style', [{ [`fill${LONE}`]: '#000' }]]],
        [['style', [{ fillColor: `#${LONE}` }]]],
        [[`properties:n${LONE}`, [1]]],
        [['properties:name', [`P${LONE}`]]],
        [['properties:name', [{ [`a${LONE}`]: 1 }]]],
        [['properties:name', [[`a${LONE}`]]]],
        [['properties:name', [nested(33)]]],
      ] as Array<Array<[FeatureRowField, unknown[]]>>) {
        expectCode(() => store.writeRows(valuesOf([p], fields)), 'invalidInput');
        expect(validateRowValues(valuesOf([p], fields), 2)).not.toBeNull();
      }
      // 32 deep, and a pair of surrogates, are values
      store.writeRows(valuesOf([p], [['properties:name', [nested(32)]]]));
      store.writeRows(valuesOf([p], [['properties:emoji', ['😀']]]));
      expect(store.tables.get('a')?.getRowProperty(p, 'emoji')).toBe('😀');
      expect(store.tables.getRowRef(`x${LONE}`)).toBeUndefined();
    });

    it('refuse them in the rows of a page builder', () => {
      const builder = createRowPageBuilder();
      const row = { id: 'x', type: 'Point', geometry: point(0, 0), orderKey: 'k1' };
      for (const bad of [
        { id: `x${LONE}` },
        { type: `Point${LONE}` },
        { orderKey: `k${LONE}` },
        { style: { fillColor: `#${LONE}` } },
        { properties: { [`n${LONE}`]: 1 } },
        { properties: { n: nested(33) } },
      ]) {
        expectCode(() => builder.addRow({ ...row, ...bad }), 'invalidInput');
      }
      expect(builder.length).toBe(0);
      expectCode(
        () => createRowPageBuilder({ groups: [{ id: `g${LONE}`, orderKey: 'k1' }] }),
        'invalidInput',
      );
    });
  });

  describe('the rows drawn', () => {
    it('leave out the rows of a hidden layer, and their revision changes when it is hidden or shown', () => {
      const store = withRows(make);
      const view = store.tables.get('a');
      const box: [number, number, number, number] = [-1, -1, 10, 1];
      expect(view?.listDrawnRows(box).length).toBe(3);
      const revision = view?.getDrawnRowsRevision();
      store.updateLayer('a', { visible: false });
      expect(view?.listDrawnRows(box).length).toBe(0);
      const hidden = view?.getDrawnRowsRevision();
      expect(hidden).not.toBe(revision);
      store.updateLayer('a', { visible: true });
      expect(view?.listDrawnRows(box).length).toBe(3);
      expect(view?.getDrawnRowsRevision()).not.toBe(hidden);
    });
  });

  describe('a group moved to another layer', () => {
    it('gives its members their parent in the values before', () => {
      const store = make();
      store.createLayer(layer('a'));
      store.createLayer(layer('b'));
      store.createGroup({
        id: 'g',
        layerId: 'a',
        orderKey: 'k5',
        name: 'g',
        visible: true,
        locked: false,
      });
      store.createRows(newRows(['m'], 'g'));
      const changes = record(store, { previousValues: true });
      store.updateGroup('g', { layerId: 'b' });
      const rows = changes[0].rows?.layers.get('b');
      expect(rows?.fields).toEqual(new Set(['parent']));
      const before = changes[0].previousValues?.get('b');
      expect(before && fieldsOf(before)).toEqual({ parent: ['g'] });
      expect([...(before?.rows ?? [])]).toEqual([refOf(store, 'm')]);
    });
  });
});

// ---------------------------------------------------------------------------------------------
// The work

/** A Store with the layer `a` and `size` points of one style */
function storeOfOneStyle(size: number) {
  const store = createStore();
  store.createLayer(layer('a'));
  const ids = Array.from({ length: size }, (_, i) => `r${String(i).padStart(6, '0')}`);
  const style = { fillColor: '#f00', strokeWidth: 2 };
  store.createRows(
    newRows(ids, 'a', [['style', ids.map(() => style)]], {
      ...columnOf([point(0, 0)]),
      types: new Uint8Array(size),
      coordinates: new Float64Array(size * 2),
      partStarts: Int32Array.from({ length: size + 1 }, (_, i) => i),
      ringStarts: Int32Array.from({ length: size + 1 }, (_, i) => i),
      positionStarts: Int32Array.from({ length: size + 1 }, (_, i) => i),
    }),
  );
  const view = store.tables.get('a');
  if (!view) throw new Error('no rows');
  return { store, rows: view.listRowRefs(0, size), counts: countsOf(store) };
}

describe('the work of the keys of the style', () => {
  it('makes no more objects for more rows of one style given one value of a key', () => {
    expectNotProportional((size) => {
      const { store, rows, counts } = storeOfOneStyle(size);
      const values = new Array<unknown>(size).fill('#0f0');
      return workDuring(counts, () =>
        store.writeRows({ rows, fields: new Map([['style:fillColor', values]]) }),
      ).objectsCreated;
    }, 'the objects a write of a key of the style makes');
  });

  it('makes no object per row when one key of the style of every row is read', () => {
    expectNotProportional((size) => {
      const { store, rows, counts } = storeOfOneStyle(size);
      return workDuring(counts, () => store.tables.readValues(rows, ['style:fillColor']))
        .objectsCreated;
    }, 'the objects a read of a key of the style makes');
  });
});

describe('the work of findRow', () => {
  it('finds one deleted row with the same work whatever the number of rows kept', () => {
    const comparison = expectNotProportional((size) => {
      const { store, rows, counts } = storeOfOneStyle(size);
      store.subscribe(() => {}, { keepDeletedRows: true });
      store.writeRows({ rows, fields: new Map(), deleted: new Uint8Array(size).fill(1) });
      const id = store.tables.getRowId(rows[size >> 1]) as string;
      return workDuring(counts, () => {
        expect(store.tables.findRow(id)?.deleted).toBe(true);
      }).rowsTouched;
    }, 'the rows findRow touches');
    expect(comparison.large).toBe(1);
  });
});
