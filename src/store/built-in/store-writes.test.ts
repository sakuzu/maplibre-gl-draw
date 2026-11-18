// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The contract of the writes, the transactions and the changes of a Store, without a map
 * (`createStore`), run on the built-in Store and on a Store spread from it with one member
 * replaced: every test of the contract runs on both.
 *
 * - Each write returns true when it applies, false when it does not, and throws for an argument
 *   that cannot apply; nothing is written when it is false or throws
 * - A write of many rows applies to all of them or to none, and its rows are those of one layer
 * - The ids of the rows and the groups are unique together, and a layer does not take the id of
 *   a group
 * - A group given another layer takes its members there; a group deleted does not move them
 * - A layer deleted takes its rows and groups; creating and deleting a layer tell the order
 * - A clear tells `reset`, empties the metadata, and a row whose id comes back keeps its reference
 * - The listeners are told once per outermost transaction, in their order, before `transact`
 *   returns; the transactions inside it fold into it or throw `invalidState`
 * - The changes carry no values: the values are read from the tables while they are told
 * - The operations are always closed
 */

import type { Geometry, Position } from 'geojson';
import { describe, expect, it } from 'vitest';
import type { FileData, Layer, Metadata } from '../../api/model.js';
import { DrawError } from '../../shared/errors.js';
import { createStore } from './create-store.js';
import {
  type FeatureRowField,
  GEOMETRY_TYPES,
  type GeometryColumn,
  type NewRows,
  type RowValues,
  type Store,
  type StoreChange,
  type StoreGroup,
} from './types.js';

// ---------------------------------------------------------------------------------------------
// What the tests write

function layer(id: string, more: Partial<Layer> = {}): Layer {
  return {
    id,
    name: id,
    visible: true,
    locked: false,
    opacity: 1,
    items: [],
    styleRule: undefined,
    metadata: undefined,
    ...more,
  };
}

function group(
  id: string,
  layerId: string,
  orderKey: string,
  more: Partial<StoreGroup> = {},
): StoreGroup {
  return { id, layerId, orderKey, name: id, featureIds: [], visible: true, locked: false, ...more };
}

function point(x: number, y: number): Geometry {
  return { type: 'Point', coordinates: [x, y] };
}

function square(x: number, y: number, size = 1): Geometry {
  return {
    type: 'Polygon',
    coordinates: [
      [
        [x, y],
        [x + size, y],
        [x + size, y + size],
        [x, y + size],
        [x, y],
      ],
    ],
  };
}

/** The geometries of rows as one column (null for a row without one) */
function columnOf(geometries: readonly (Geometry | null)[], valuesPerPosition = 2): GeometryColumn {
  const types = new Uint8Array(geometries.length).fill(255);
  const values: number[] = [];
  const partStarts = [0];
  const ringStarts = [0];
  const positionStarts = [0];
  const addRing = (positions: Position[]) => {
    for (const position of positions) values.push(...position.slice(0, valuesPerPosition));
    positionStarts.push(positionStarts[positionStarts.length - 1] + positions.length);
  };
  const addPart = (rings: Position[][]) => {
    for (const ring of rings) addRing(ring);
    ringStarts.push(ringStarts[ringStarts.length - 1] + rings.length);
  };
  geometries.forEach((geometry, i) => {
    if (geometry && geometry.type !== 'GeometryCollection') {
      types[i] = (GEOMETRY_TYPES as readonly string[]).indexOf(geometry.type);
      if (geometry.type === 'Point') addPart([[geometry.coordinates]]);
      else if (geometry.type === 'LineString') addPart([geometry.coordinates]);
      else if (geometry.type === 'Polygon') addPart(geometry.coordinates);
      else if (geometry.type === 'MultiPoint') for (const p of geometry.coordinates) addPart([[p]]);
      else if (geometry.type === 'MultiLineString')
        for (const l of geometry.coordinates) addPart([l]);
      else for (const polygon of geometry.coordinates) addPart(polygon);
    }
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

/** A row as the tests create it */
interface TestRow {
  readonly id: string;
  readonly parent: string;
  readonly orderKey: string;
  readonly type?: string;
  readonly geometry?: Geometry | null;
  readonly visible?: boolean;
  readonly locked?: boolean;
  readonly style?: object;
  readonly properties?: Record<string, unknown>;
}

/** New rows of the rows given, with every field the rows give */
function newRows(rows: readonly TestRow[]): NewRows {
  const fields = new Map<FeatureRowField, unknown[]>([
    ['type', rows.map((row) => row.type ?? row.geometry?.type ?? 'Point')],
    ['parent', rows.map((row) => row.parent)],
    ['orderKey', rows.map((row) => row.orderKey)],
  ]);
  if (rows.some((row) => row.visible !== undefined)) {
    fields.set(
      'visible',
      rows.map((row) => row.visible),
    );
  }
  if (rows.some((row) => row.locked !== undefined)) {
    fields.set(
      'locked',
      rows.map((row) => row.locked),
    );
  }
  if (rows.some((row) => row.style !== undefined)) {
    fields.set(
      'style',
      rows.map((row) => row.style),
    );
  }
  const keys = new Set(rows.flatMap((row) => Object.keys(row.properties ?? {})));
  for (const key of keys) {
    fields.set(
      `properties:${key}`,
      rows.map((row) => row.properties?.[key]),
    );
  }
  return {
    ids: rows.map((row) => row.id),
    fields,
    geometry: columnOf(
      rows.map((row) => (row.geometry === undefined ? point(0, 0) : row.geometry)),
    ),
  };
}

/** `count` points in a line, in the layer or group `parent` */
function pointRows(count: number, parent = 'a', prefix = 'r'): TestRow[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `${prefix}${String(i).padStart(6, '0')}`,
    parent,
    orderKey: `k${String(i).padStart(6, '0')}`,
    geometry: point(i * 0.001, 0),
    properties: { name: `n${i}` },
  }));
}

/** Values written to rows */
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

function idsOf(store: Store, refs: Int32Array | readonly number[] | undefined): string[] {
  return [...(refs ?? [])].map((ref) => store.tables.getRowId(ref) as string);
}

/** The changes a Store tells, as they come */
function record(store: Store): StoreChange[] {
  const changes: StoreChange[] = [];
  store.subscribe((change) => changes.push(change));
  return changes;
}

/** Everything a Store holds, read: what a write that did not apply leaves as it was */
function snapshot(store: Store) {
  const fields: FeatureRowField[] = [
    'type',
    'visible',
    'locked',
    'style',
    'parent',
    'orderKey',
    'properties:name',
    'geometry',
  ];
  const rows: Record<string, unknown> = {};
  for (const { id } of store.listLayers()) {
    const view = store.tables.get(id);
    if (!view) continue;
    const refs = view.listRowRefs(0, view.rowCount);
    const values = store.tables.readValues(refs, fields);
    rows[id] = {
      ids: idsOf(store, refs),
      fields: [...values.fields],
      geometry: values.geometry && {
        types: [...values.geometry.types],
        coordinates: [...values.geometry.coordinates],
      },
    };
  }
  return {
    layers: store.listLayers(),
    groups: store.listGroups(),
    files: store.listFiles(),
    metadata: store.getMetadata(),
    order: [...store.getLayerOrder()],
    rows,
  };
}

function expectCode(fn: () => unknown, code: string): DrawError {
  let thrown: unknown;
  try {
    fn();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(DrawError);
  expect((thrown as DrawError).code).toBe(code);
  return thrown as DrawError;
}

/** Runs a write that does not apply: it returns false or throws, and nothing changes or is told */
function expectNothingWritten(store: Store, write: () => unknown): void {
  const before = snapshot(store);
  const changes = record(store);
  try {
    expect(write()).toBe(false);
  } catch (error) {
    expect(error).toBeInstanceOf(DrawError);
  }
  expect(changes).toEqual([]);
  expect(snapshot(store)).toEqual(before);
}

/** A Store with the layers `a` and `b`, the group `g` in `a`, and three rows */
function withRows(make: () => Store): Store {
  const store = make();
  store.createLayer(layer('a'));
  store.createLayer(layer('b'));
  store.createGroup(group('g', 'a', 'k5'));
  store.createRows(
    newRows([
      { id: 'p', parent: 'a', orderKey: 'k1', geometry: point(1, 2), properties: { name: 'P' } },
      { id: 'q', parent: 'a', orderKey: 'k2', geometry: square(3, 3) },
      { id: 'm', parent: 'g', orderKey: 'k1', geometry: point(5, 5) },
    ]),
  );
  return store;
}

// ---------------------------------------------------------------------------------------------

/** The Stores the contract runs on */
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
  describe('the writes of the rows', () => {
    it('create rows of a layer and of a group, with the values of a new feature for the rest', () => {
      const store = make();
      store.createLayer(layer('a'));
      store.createGroup(group('g', 'a', 'k5'));
      expect(
        store.createRows(
          newRows([
            { id: 'p', parent: 'a', orderKey: 'k1', geometry: point(1, 2) },
            { id: 'm', parent: 'g', orderKey: 'k1', geometry: square(0, 0), locked: true },
          ]),
        ),
      ).toBe(true);
      const view = store.tables.get('a');
      expect(view?.rowCount).toBe(2);
      const values = store.tables.readValues(Int32Array.of(refOf(store, 'p'), refOf(store, 'm')), [
        'type',
        'visible',
        'locked',
        'style',
        'parent',
        'orderKey',
        'geometry',
      ]);
      expect(values.fields).toEqual(
        new Map<string, unknown[]>([
          ['type', ['Point', 'Polygon']],
          ['visible', [true, true]],
          ['locked', [false, true]],
          ['style', [{}, {}]],
          ['parent', ['a', 'g']],
          ['orderKey', ['k1', 'k1']],
        ]),
      );
      expect([...(values.geometry?.coordinates ?? [])]).toEqual([
        1, 2, 0, 0, 1, 0, 1, 1, 0, 1, 0, 0,
      ]);
      const groupRef = store.tables.findGroup('g') as number;
      expect(idsOf(store, view?.listGroupMembers(groupRef, 0, 10))).toEqual(['m']);
    });

    it('do not create rows whose ids are in use, or given twice', () => {
      const store = withRows(make);
      for (const id of ['p', 'g', 'new']) {
        expectNothingWritten(store, () =>
          store.createRows(
            newRows([
              { id: 'x', parent: 'a', orderKey: 'k9' },
              { id, parent: 'a', orderKey: 'k9' },
              ...(id === 'new' ? [{ id: 'new', parent: 'a', orderKey: 'k9' }] : []),
            ]),
          ),
        );
      }
    });

    it('throw for rows that cannot be created, and create none of them', () => {
      const store = withRows(make);
      const good = newRows(pointRows(3));
      const cases: Array<[string, () => unknown]> = [
        ['invalidInput', () => store.createRows({ ...good, fields: new Map() })],
        [
          'invalidInput',
          () =>
            store.createRows({
              ...good,
              fields: new Map([...good.fields, ['style:fillColor', ['#f00', '#f00', '#f00']]]),
            }),
        ],
        [
          'invalidInput',
          () =>
            store.createRows({
              ...good,
              fields: new Map([...good.fields, ['hidden' as FeatureRowField, [1, 1, 1]]]),
            }),
        ],
        ['invalidInput', () => store.createRows({ ...good, geometry: columnOf([point(0, 0)]) })],
        [
          'invalidInput',
          () => store.createRows({ ...good, geometry: columnOf([null, null, null]) }),
        ],
        [
          'invalidInput',
          () =>
            store.createRows({
              ...good,
              geometry: columnOf([point(0, 0), point(0, 0), point(0, 0)], 3),
            }),
        ],
        ['invalidInput', () => store.createRows(newRows([{ id: 'x', parent: 'a', orderKey: '' }]))],
        ['notFound', () => store.createRows(newRows([{ id: 'x', parent: 'none', orderKey: 'k' }]))],
      ];
      for (const [code, write] of cases) {
        const before = snapshot(store);
        expectCode(write, code);
        expect(snapshot(store)).toEqual(before);
      }
    });

    it('write the fields given and the geometry of rows there are, and move them', () => {
      const store = withRows(make);
      const p = refOf(store, 'p');
      const q = refOf(store, 'q');
      expect(
        store.writeRows(
          valuesOf(
            [p, q],
            [
              ['visible', [false, true]],
              ['style', [{ fillColor: '#f00' }, {}]],
              ['properties:name', ['P2', undefined]],
            ],
            { geometry: columnOf([point(9, 9), null]) },
          ),
        ),
      ).toBe(true);
      const values = store.tables.readValues(Int32Array.of(p, q), [
        'visible',
        'style',
        'properties:name',
        'geometry',
      ]);
      expect(values.fields.get('visible')).toEqual([false, true]);
      expect(values.fields.get('style')).toEqual([{ fillColor: '#f00' }, {}]);
      expect(values.fields.get('properties:name')).toEqual(['P2', undefined]);
      // A row given no geometry (255) keeps its own
      expect([...(values.geometry?.coordinates ?? [])].slice(0, 4)).toEqual([9, 9, 3, 3]);
      // Into another layer, and into a group
      expect(store.writeRows(valuesOf([p], [['parent', ['b']]]))).toBe(true);
      expect(store.tables.get('b')?.getRowType(p)).toBe('Point');
      expect(store.tables.get('a')?.getRowType(p)).toBeNull();
      expect(
        store.writeRows(
          valuesOf(
            [q],
            [
              ['parent', ['g']],
              ['orderKey', ['k0']],
            ],
          ),
        ),
      ).toBe(true);
      const groupRef = store.tables.findGroup('g') as number;
      expect(idsOf(store, store.tables.get('a')?.listGroupMembers(groupRef, 0, 10))).toEqual([
        'q',
        'm',
      ]);
      // Deleted
      expect(store.writeRows(valuesOf([q], [], { deleted: Uint8Array.of(1) }))).toBe(true);
      expect(store.tables.getRowRef('q')).toBeUndefined();
      expect(store.tables.get('a')?.rowCount).toBe(1);
    });

    it('throw for rows that cannot be written, and write none of them', () => {
      const store = withRows(make);
      const p = refOf(store, 'p');
      const q = refOf(store, 'q');
      store.writeRows(valuesOf([refOf(store, 'm')], [], { deleted: Uint8Array.of(1) }));
      const m = store.tables.findRow('m')?.ref as number;
      expect(store.tables.findRow('m')?.deleted).toBe(true);
      const cases: Array<[string, () => unknown]> = [
        ['notFound', () => store.writeRows(valuesOf([p, 9999], [['visible', [false, false]]]))],
        // A deleted row that nothing keeps
        ['notFound', () => store.writeRows(valuesOf([p, m], [['visible', [false, false]]]))],
        ['invalidInput', () => store.writeRows(valuesOf([p, q], [['visible', [false, 1]]]))],
        ['invalidInput', () => store.writeRows(valuesOf([p, q], [['visible', [false]]]))],
        ['invalidInput', () => store.writeRows(valuesOf([p, q], [['type', ['', 'Point']]]))],
        ['invalidInput', () => store.writeRows(valuesOf([p], [['style:fillColor', ['#f00']]]))],
        ['invalidInput', () => store.writeRows(valuesOf([p], [['geometry', [null]]]))],
        ['invalidInput', () => store.writeRows(valuesOf([p], [['properties:f', [() => 1]]]))],
        ['notFound', () => store.writeRows(valuesOf([p], [['parent', ['none']]]))],
        [
          'invalidInput',
          () =>
            store.writeRows(
              valuesOf([p, q], [], { geometry: columnOf([point(0, 0), point(1, 1)], 3) }),
            ),
        ],
        ['invalidInput', () => store.writeRows(valuesOf([p], [], { deleted: new Uint8Array(2) }))],
      ];
      for (const [code, write] of cases) {
        const before = snapshot(store);
        expectCode(write, code);
        expect(snapshot(store)).toEqual(before);
      }
    });

    it('refuse rows of more than one layer, in a creation and in a write, writing none', () => {
      const store = withRows(make);
      expectNothingWritten(store, () =>
        store.createRows(
          newRows([
            { id: 'x', parent: 'a', orderKey: 'k9' },
            { id: 'y', parent: 'b', orderKey: 'k9' },
          ]),
        ),
      );
      store.createRows(newRows([{ id: 'o', parent: 'b', orderKey: 'k1' }]));
      const error = expectCode(
        () =>
          store.writeRows(
            valuesOf([refOf(store, 'p'), refOf(store, 'o')], [['visible', [false, false]]]),
          ),
        'invalidInput',
      );
      expect(error.message).toMatch(/more than one layer/);
      // The rows of a group are in the layer of the group
      expect(
        store.writeRows(
          valuesOf([refOf(store, 'p'), refOf(store, 'm')], [['visible', [false, false]]]),
        ),
      ).toBe(true);
    });

    it('write all of many rows or none of them, for one wrong value', () => {
      const store = make();
      store.createLayer(layer('a'));
      const rows = pointRows(1_000);
      const wrong = rows.map((row, i) =>
        i === 700 ? { ...row, properties: { name: Number.NaN } } : row,
      );
      expectNothingWritten(store, () => store.createRows(newRows(wrong)));
      const unclosed = newRows(rows);
      const geometries = rows.map((row, i) =>
        i === 999
          ? ({
              type: 'Polygon',
              coordinates: [
                [
                  [0, 0],
                  [1, 0],
                  [1, 1],
                ],
              ],
            } as Geometry)
          : (row.geometry as Geometry),
      );
      expectNothingWritten(store, () =>
        store.createRows({ ...unclosed, geometry: columnOf(geometries) }),
      );
      expect(store.createRows(newRows(rows))).toBe(true);
      const refs = rows.map((row) => refOf(store, row.id));
      const names = rows.map((_, i) => (i === 500 ? { f: () => 1 } : `m${i}`));
      expectNothingWritten(store, () =>
        store.writeRows(valuesOf(refs, [['properties:name', names]])),
      );
      const styles = rows.map((_, i) => (i === 10 ? { fillColor: Number.POSITIVE_INFINITY } : {}));
      expectNothingWritten(store, () => store.writeRows(valuesOf(refs, [['style', styles]])));
    });
  });

  describe('the ids', () => {
    it('of the rows and the groups are unique together, and a layer does not take the id of a group', () => {
      const store = withRows(make);
      expectNothingWritten(store, () => store.createGroup(group('p', 'a', 'k9')));
      expectNothingWritten(store, () => store.createGroup(group('g', 'a', 'k9')));
      expectNothingWritten(store, () => store.createGroup(group('a', 'a', 'k9')));
      expectNothingWritten(store, () => store.createLayer(layer('g')));
      expectNothingWritten(store, () => store.createLayer(layer('a')));
      expectNothingWritten(store, () =>
        store.createRows(newRows([{ id: 'g', parent: 'a', orderKey: 'k9' }])),
      );
      // A row and a layer do not share the space of the ids
      expect(store.createRows(newRows([{ id: 'b', parent: 'a', orderKey: 'k9' }]))).toBe(true);
      // The id of a deleted row is free again
      store.writeRows(valuesOf([refOf(store, 'q')], [], { deleted: Uint8Array.of(1) }));
      expect(store.createGroup(group('q', 'a', 'k9'))).toBe(true);
    });
  });

  describe('the layers', () => {
    it('are created at the front of the order, and the change tells the order', () => {
      const store = make();
      const changes = record(store);
      expect(store.createLayer(layer('a'))).toBe(true);
      store.setLayerOrder(['a', 'dataset']);
      expect(store.createLayer(layer('dataset'), { valuesPerPosition: 2 })).toBe(true);
      expect(store.createLayer(layer('b'), { thirdValue: 'height' })).toBe(true);
      expect(store.getLayerOrder()).toEqual(['a', 'dataset', 'b']);
      expect(changes[0].layers).toEqual({
        created: [store.getLayer('a')],
        orderChanged: { order: ['a'], previous: [] },
      });
      // Also when the order held the id
      expect(changes[2].layers?.orderChanged).toEqual({
        order: ['a', 'dataset'],
        previous: ['a', 'dataset'],
      });
      expect(store.tables.getValuesPerPosition('b')).toBe(2);
    });

    it('refuse other numbers of values per position until the tables hold them', () => {
      const store = make();
      for (const valuesPerPosition of [3, 4] as const) {
        expectNothingWritten(store, () => store.createLayer(layer('a'), { valuesPerPosition }));
      }
      expectNothingWritten(store, () =>
        store.createLayer(layer('a'), { thirdValue: 'other' as 'height' }),
      );
      expectNothingWritten(store, () => store.createLayer({ ...layer('a'), id: '' }));
    });

    it('are updated, and an update of a layer not there throws', () => {
      const store = make();
      store.createLayer(layer('a', { metadata: { n: 1 } }));
      const before = store.getLayer('a');
      const changes = record(store);
      expect(
        store.updateLayer('a', { name: 'A', id: 'other', metadata: null as unknown as undefined }),
      ).toBe(true);
      expect(store.getLayer('a')).toEqual(layer('a', { name: 'A' }));
      expect(Object.isFrozen(store.getLayer('a'))).toBe(true);
      expect(before?.name).toBe('a');
      expect(changes[0].layers?.updated).toEqual([
        { id: 'a', layer: store.getLayer('a'), previous: before },
      ]);
      expectNothingWritten(store, () => store.updateLayer('none', { name: 'x' }));
    });

    it('deleted take their rows and groups, and the change tells the order', () => {
      const store = withRows(make);
      const rows = [refOf(store, 'p'), refOf(store, 'q'), refOf(store, 'm')];
      const changes = record(store);
      expect(store.deleteLayer('a')).toBe(true);
      expect(store.getLayer('a')).toBeUndefined();
      expect(store.getGroup('g')).toBeUndefined();
      expect(store.tables.get('a')?.rowCount ?? 0).toBe(0);
      expect(store.getLayerOrder()).toEqual(['b']);
      const [change] = changes;
      expect([...(change.rows?.layers.get('a')?.deleted ?? [])].sort()).toEqual(rows.sort());
      expect(change.groups?.deleted?.map((g) => g.id)).toEqual(['g']);
      expect(change.layers?.deleted?.map((l) => l.id)).toEqual(['a']);
      expect(change.layers?.orderChanged).toEqual({ order: ['b'], previous: ['a', 'b'] });
      // Also when the order did not hold the id
      store.setLayerOrder([]);
      store.deleteLayer('b');
      expect(changes[2].layers?.orderChanged).toEqual({ order: [], previous: [] });
      expectNothingWritten(store, () => store.deleteLayer('a'));
    });

    it('take an order of entries that are not layers, without the ones that cannot be entries', () => {
      const store = make();
      expect(store.setLayerOrder(['x', '', 'y', 'x', 3 as unknown as string])).toBe(true);
      expect(store.getLayerOrder()).toEqual(['x', 'y']);
      expect(Object.isFrozen(store.getLayerOrder())).toBe(true);
      expectNothingWritten(store, () => store.setLayerOrder('x' as unknown as string[]));
    });
  });

  describe('the groups', () => {
    it('are created in a layer there is, and updated', () => {
      const store = make();
      store.createLayer(layer('a'));
      expectNothingWritten(store, () => store.createGroup(group('g', 'none', 'k1')));
      expectNothingWritten(store, () => store.createGroup(group('g', 'a', '')));
      expect(store.createGroup(group('g', 'a', 'k1'))).toBe(true);
      expect(store.updateGroup('g', { name: 'G', visible: false })).toBe(true);
      expect(store.getGroup('g')).toEqual(group('g', 'a', 'k1', { name: 'G', visible: false }));
      expectNothingWritten(store, () => store.updateGroup('none', { name: 'x' }));
      expectNothingWritten(store, () => store.updateGroup('g', { layerId: 'none' }));
    });

    it('given another layer take their members there, told as rows updated', () => {
      const store = withRows(make);
      const m = refOf(store, 'm');
      const changes = record(store);
      expect(store.updateGroup('g', { layerId: 'b' })).toBe(true);
      expect(store.tables.get('b')?.getRowType(m)).toBe('Point');
      expect(store.tables.get('a')?.getRowType(m)).toBeNull();
      const [change] = changes;
      expect([...(change.rows?.layers.get('b')?.updated ?? [])]).toEqual([m]);
      expect(change.rows?.layers.get('b')?.fields).toEqual(new Set(['parent']));
      expect(change.rows?.layers.has('a')).toBe(false);
      expect(change.groups?.updated?.map((u) => [u.previous.layerId, u.group.layerId])).toEqual([
        ['a', 'b'],
      ]);
    });

    it('and the rows are put in other places by their new keys', () => {
      const store = withRows(make);
      const view = store.tables.get('a');
      if (!view) throw new Error('no rows');
      const order = () => {
        const items = view.listItemRefs(0, 10);
        return [...items.kinds].map((kind, i) =>
          kind === 0
            ? store.tables.getRowId(items.refs[i])
            : store.tables.getGroupId(items.refs[i]),
        );
      };
      expect(order()).toEqual(['p', 'q', 'g']);
      expect(store.updateGroup('g', { orderKey: 'k0' })).toBe(true);
      expect(order()).toEqual(['g', 'p', 'q']);
      expect(store.writeRows(valuesOf([refOf(store, 'q')], [['orderKey', ['a']]]))).toBe(true);
      expect(order()).toEqual(['q', 'g', 'p']);
    });

    it('deleted do not move their members, and are not deleted while a row names them', () => {
      const store = withRows(make);
      const m = refOf(store, 'm');
      expectNothingWritten(store, () => store.deleteGroup('g'));
      expect(store.writeRows(valuesOf([m], [['parent', ['a']]]))).toBe(true);
      const changes = record(store);
      expect(store.deleteGroup('g')).toBe(true);
      expect(store.getGroup('g')).toBeUndefined();
      expect(changes[0].rows).toBeUndefined();
      expect(changes[0].groups?.deleted?.map((g) => g.id)).toEqual(['g']);
      expect(store.tables.readValues(Int32Array.of(m), ['parent']).fields.get('parent')).toEqual([
        'a',
      ]);
      expectNothingWritten(store, () => store.deleteGroup('g'));
      // A group whose last member was deleted stays
      store.createGroup(group('h', 'a', 'k7'));
      store.writeRows(valuesOf([m], [['parent', ['h']]]));
      store.writeRows(valuesOf([m], [], { deleted: Uint8Array.of(1) }));
      expect(store.getGroup('h')).toBeDefined();
      expect(store.deleteGroup('h')).toBe(true);
    });
  });

  describe('the files and the metadata', () => {
    it('create and delete files', () => {
      const store = make();
      const file: FileData = { id: 'f', mimeType: 'image/png', dataURL: 'data:,' };
      expect(store.createFile(file)).toBe(true);
      expect(store.getFile('f')).toEqual(file);
      expectNothingWritten(store, () => store.createFile(file));
      expectNothingWritten(store, () =>
        store.createFile({ ...file, id: 'g', dataURL: 1 } as never),
      );
      const changes = record(store);
      expect(store.deleteFile('f')).toBe(true);
      expect(changes[0].files).toEqual({ deleted: [file] });
      expectNothingWritten(store, () => store.deleteFile('f'));
    });

    it('take a key off given as undefined, and tell the keys written', () => {
      const store = make();
      store.setMetadata({ title: 'T', description: 'D' });
      const changes = record(store);
      expect(store.setMetadata({ description: undefined, 'app:n': 1 } as Partial<Metadata>)).toBe(
        true,
      );
      expect(store.getMetadata()).toEqual({ title: 'T', 'app:n': 1 });
      expect(changes[0].metadata).toEqual({
        metadata: { title: 'T', 'app:n': 1 },
        previous: { title: 'T', description: 'D' },
        keys: ['description', 'app:n'],
      });
      expectNothingWritten(store, () => store.setMetadata(null as unknown as Metadata));
    });

    it('keep a key without a prefix as it is', () => {
      const store = make();
      const metadata = { title: 'T', author: 'A', tags: ['x'] } as Partial<Metadata>;
      expect(store.setMetadata(metadata)).toBe(true);
      expect(store.getMetadata()).toEqual({ title: 'T', author: 'A', tags: ['x'] });
    });

    it('fold the writes of one transaction into one change of the metadata', () => {
      const store = make();
      store.setMetadata({ title: 'A' });
      const changes = record(store);
      store.transact(() => {
        store.setMetadata({ title: 'B' });
        store.setMetadata({ description: 'D' });
        store.setMetadata({ title: 'C' });
      }, 'local');
      expect(changes).toHaveLength(1);
      expect(changes[0].metadata).toEqual({
        metadata: { title: 'C', description: 'D' },
        previous: { title: 'A' },
        keys: ['title', 'description'],
      });
    });
  });

  describe('clear', () => {
    it('takes everything out, with a change that has reset and the metadata {}', () => {
      const store = withRows(make);
      store.createFile({ id: 'f', mimeType: 'image/png', dataURL: 'data:,' });
      store.setMetadata({ title: 'T' });
      const rows = [refOf(store, 'p'), refOf(store, 'q'), refOf(store, 'm')];
      const changes = record(store);
      store.clear();
      expect(store.listLayers()).toEqual([]);
      expect(store.listGroups()).toEqual([]);
      expect(store.listFiles()).toEqual([]);
      expect(store.getLayerOrder()).toEqual([]);
      expect(store.getMetadata()).toEqual({});
      expect(store.tables.getRowRef('p')).toBeUndefined();
      expect(changes).toHaveLength(1);
      const [change] = changes;
      expect(change.reset).toBe(true);
      expect([...(change.rows?.layers.get('a')?.deleted ?? [])].sort()).toEqual(rows.sort());
      expect(change.layers?.deleted?.map((l) => l.id).sort()).toEqual(['a', 'b']);
      expect(change.layers?.orderChanged).toEqual({ order: [], previous: ['a', 'b'] });
      expect(change.groups?.deleted?.map((g) => g.id)).toEqual(['g']);
      expect(change.files?.deleted?.map((f) => f.id)).toEqual(['f']);
      expect(change.metadata).toEqual({ metadata: {}, previous: { title: 'T' }, keys: ['title'] });
    });

    it('tells what is written after it in its transaction as created', () => {
      const store = withRows(make);
      const p = refOf(store, 'p');
      const changes = record(store);
      store.transact(() => {
        store.clear();
        store.createLayer(layer('a'));
        store.createRows(newRows([{ id: 'p', parent: 'a', orderKey: 'k1' }]));
      }, 'load');
      const [change] = changes;
      expect(change.reset).toBe(true);
      expect(change.layers?.created?.map((l) => l.id)).toEqual(['a']);
      expect(change.layers?.deleted?.map((l) => l.id).sort()).toEqual(['a', 'b']);
      const rows = change.rows?.layers.get('a');
      expect([...(rows?.created ?? [])]).toEqual([p]);
      expect(rows?.deleted).toContain(p);
    });

    it('leaves the reference of a row whose id comes back', () => {
      const store = withRows(make);
      const p = refOf(store, 'p');
      store.clear();
      store.createLayer(layer('a'));
      store.createRows(newRows([{ id: 'p', parent: 'a', orderKey: 'k1' }]));
      expect(refOf(store, 'p')).toBe(p);
    });
  });

  describe('the transactions and the listeners', () => {
    it('tell one change per outermost transaction, to the listeners in their order, before transact returns', () => {
      const store = make();
      const told: string[] = [];
      store.subscribe((change) =>
        told.push(`first ${change.source} ${change.layers?.created?.length}`),
      );
      store.subscribe((change) =>
        told.push(`second ${change.source} ${change.layers?.created?.length}`),
      );
      const result = store.transact(() => {
        store.createLayer(layer('a'));
        store.transact(() => store.createLayer(layer('b')), 'local');
        told.push('inside');
        return 7;
      }, 'local');
      told.push('returned');
      expect(result).toBe(7);
      expect(told).toEqual(['inside', 'first local 2', 'second local 2', 'returned']);
    });

    it('tell a write outside a transaction with the source remote, and give each change a number', () => {
      const store = make();
      const changes = record(store);
      store.createLayer(layer('a'));
      store.transact(() => store.createLayer(layer('b')), 'local');
      expect(changes.map((c) => c.source)).toEqual(['remote', 'local']);
      expect(changes[0].operationId).not.toBe(changes[1].operationId);
      expect(changes[0]).toEqual(
        expect.objectContaining({ hasMoreParts: false, stopped: false, reset: false }),
      );
      // A number given is never given again
      const ids = new Set([...changes.map((c) => c.operationId), store.newOperationId()]);
      expect(ids.size).toBe(3);
    });

    it('throw for a transaction inside one of another source, writing nothing', () => {
      const store = make();
      const changes = record(store);
      store.transact(() => {
        store.createLayer(layer('a'));
        expectCode(
          () => store.transact(() => store.createLayer(layer('b')), 'remote'),
          'invalidState',
        );
      }, 'local');
      expect(store.getLayer('b')).toBeUndefined();
      expect(changes).toHaveLength(1);
      expect(changes[0].layers?.created?.map((l) => l.id)).toEqual(['a']);
    });

    it('throw for a transaction inside another given options, writing nothing', () => {
      const store = make();
      const operationId = store.newOperationId();
      const changes = record(store);
      store.transact(() => {
        expectCode(
          () => store.transact(() => store.createLayer(layer('b')), 'local', { operationId }),
          'invalidState',
        );
        expectCode(
          () => store.transact(() => store.createLayer(layer('b')), 'local', {}),
          'invalidState',
        );
      }, 'local');
      expect(store.getLayer('b')).toBeUndefined();
      expect(changes).toEqual([]);
    });

    it('tell the writes made before fn threw as one change, then throw again', () => {
      const store = make();
      const changes = record(store);
      const failure = new Error('stop');
      expect(() =>
        store.transact(() => {
          store.createLayer(layer('a'));
          store.createLayer(layer('b'));
          throw failure;
        }, 'local'),
      ).toThrow(failure);
      expect(changes).toHaveLength(1);
      expect(changes[0].layers?.created?.map((l) => l.id)).toEqual(['a', 'b']);
      expect(store.getLayer('b')).toBeDefined();
    });

    it('throw for a write while a listener is told, and take it after the change was told', async () => {
      const store = make();
      store.createLayer(layer('a'));
      const thrown: unknown[] = [];
      let wrote: Promise<boolean> | undefined;
      const unsubscribe = store.subscribe((change) => {
        if (!change.layers?.updated) return;
        for (const write of [
          () => store.createLayer(layer('b')),
          () => store.transact(() => store.createLayer(layer('b')), 'remote'),
          () => store.setMetadata({ title: 'x' }),
          () => store.clear(),
        ]) {
          try {
            write();
          } catch (error) {
            thrown.push(error);
          }
        }
        wrote = new Promise((resolve) => {
          queueMicrotask(() => resolve(store.createLayer(layer('c'))));
        });
      });
      store.updateLayer('a', { name: 'A' });
      unsubscribe();
      expect(thrown.map((e) => (e as DrawError).code)).toEqual([
        'invalidState',
        'invalidState',
        'invalidState',
        'invalidState',
      ]);
      expect(store.getLayer('b')).toBeUndefined();
      expect(store.getMetadata()).toEqual({});
      expect(await wrote).toBe(true);
      expect(store.getLayer('c')).toBeDefined();
    });

    it('take the source as it is given, and throw for options of the wrong kind', () => {
      const store = make();
      expectCode(() => store.transact(() => 1, undefined as unknown as string), 'invalidInput');
      expectCode(
        () => store.transact(() => 1, 'local', { operationId: 'x' as unknown as number }),
        'invalidInput',
      );
      expectCode(
        () => store.transact(() => 1, 'local', { hasMoreParts: 1 as unknown as boolean }),
        'invalidInput',
      );
      const changes = record(store);
      store.transact(() => store.createLayer(layer('a')), 'my-extension');
      expect(changes[0].source).toBe('my-extension');
    });
  });

  describe('the operations', () => {
    it('tell each part with the number, and the last part even when it writes nothing', () => {
      const store = make();
      store.createLayer(layer('a'));
      const changes = record(store);
      const operationId = store.newOperationId();
      store.transact(() => store.createRows(newRows(pointRows(2, 'a', 'x'))), 'remote', {
        operationId,
        hasMoreParts: true,
      });
      // A part in the middle that writes nothing is not told
      store.transact(() => {}, 'remote', { operationId, hasMoreParts: true });
      store.transact(() => {}, 'remote', { operationId });
      expect(changes.map((c) => [c.operationId, c.hasMoreParts, c.stopped])).toEqual([
        [operationId, true, false],
        [operationId, false, false],
      ]);
      expect(changes[1].rows).toBeUndefined();
      // An operation that stopped
      const stopped = store.newOperationId();
      store.transact(() => {}, 'remote', { operationId: stopped, stopped: true });
      expect(changes[2]).toEqual(
        expect.objectContaining({ operationId: stopped, hasMoreParts: false, stopped: true }),
      );
    });

    it('tell a transaction without options that writes nothing as no change', () => {
      const store = make();
      const changes = record(store);
      store.transact(() => {}, 'local');
      expect(changes).toEqual([]);
    });
  });

  describe('the changes of the rows', () => {
    it('carry no values: the listeners read the values after the change from the tables', () => {
      const store = withRows(make);
      const p = refOf(store, 'p');
      const read: unknown[] = [];
      store.subscribe((change) => {
        const rows = change.rows?.layers.get('a');
        read.push(Object.keys(change), [...(rows?.fields ?? [])]);
        const values = store.tables.readValues(rows?.updated ?? new Int32Array(0), [
          'properties:name',
          'visible',
        ]);
        read.push(values.fields.get('properties:name'), values.fields.get('visible'));
      });
      store.transact(() => {
        store.writeRows(valuesOf([p], [['properties:name', ['first']]]));
        store.writeRows(
          valuesOf(
            [p],
            [
              ['properties:name', ['last']],
              ['visible', [false]],
            ],
          ),
        );
      }, 'local');
      expect(read).toEqual([
        ['source', 'operationId', 'hasMoreParts', 'stopped', 'reset', 'rows'],
        ['properties:name', 'visible'],
        ['last'],
        [false],
      ]);
    });

    it('let the ids of the rows deleted be read while the change is told', () => {
      const store = withRows(make);
      const ids: string[] = [];
      store.subscribe((change) => {
        ids.push(...idsOf(store, change.rows?.layers.get('a')?.deleted));
      });
      store.writeRows(
        valuesOf([refOf(store, 'p'), refOf(store, 'q')], [], {
          deleted: new Uint8Array(2).fill(1),
        }),
      );
      store.deleteLayer('a');
      expect(ids).toEqual(['p', 'q', 'm']);
    });

    it('tell what one transaction did to each row as a whole', () => {
      const store = withRows(make);
      const p = refOf(store, 'p');
      const q = refOf(store, 'q');
      const changes = record(store);
      store.transact(() => {
        // Created and deleted again: not told
        store.createRows(newRows([{ id: 'tmp', parent: 'a', orderKey: 'k8' }]));
        store.writeRows(valuesOf([refOf(store, 'tmp')], [], { deleted: Uint8Array.of(1) }));
        // Created, then written: created
        store.createRows(newRows([{ id: 'new', parent: 'a', orderKey: 'k9' }]));
        store.writeRows(valuesOf([refOf(store, 'new')], [['visible', [false]]]));
        // Written, then moved to another layer: updated there only
        store.writeRows(valuesOf([p], [['visible', [false]]]));
        store.writeRows(valuesOf([p], [['parent', ['b']]]));
        // Deleted, then created again with its id: updated
        store.writeRows(valuesOf([q], [], { deleted: Uint8Array.of(1) }));
        store.createRows(newRows([{ id: 'q', parent: 'a', orderKey: 'k2' }]));
      }, 'local');
      const layers = changes[0].rows?.layers;
      const a = layers?.get('a');
      const b = layers?.get('b');
      expect(idsOf(store, a?.created)).toEqual(['new']);
      expect(idsOf(store, a?.updated)).toEqual(['q']);
      expect(idsOf(store, a?.deleted)).toEqual([]);
      expect(idsOf(store, b?.updated)).toEqual(['p']);
      expect(idsOf(store, b?.created)).toEqual([]);
    });

    it('name the keys of the style that changed', () => {
      const store = withRows(make);
      const p = refOf(store, 'p');
      store.writeRows(valuesOf([p], [['style', [{ fillColor: '#f00', strokeWidth: 2 }]]]));
      const changes = record(store);
      store.writeRows(valuesOf([p], [['style', [{ fillColor: '#0f0', strokeWidth: 2 }]]]));
      expect(changes[0].rows?.layers.get('a')?.fields).toEqual(
        new Set(['style', 'style:fillColor']),
      );
    });

    it('fold the updates of a layer and of a group into one entry per id', () => {
      const store = withRows(make);
      const layerBefore = store.getLayer('a');
      const groupBefore = store.getGroup('g');
      const changes = record(store);
      store.transact(() => {
        store.updateLayer('a', { name: 'A1' });
        store.updateGroup('g', { name: 'G1' });
        store.updateLayer('a', { name: 'A2' });
        store.updateGroup('g', { name: 'G2' });
      }, 'local');
      expect(changes[0].layers?.updated).toEqual([
        { id: 'a', layer: store.getLayer('a'), previous: layerBefore },
      ]);
      expect(changes[0].groups?.updated).toEqual([
        { id: 'g', group: store.getGroup('g'), previous: groupBefore },
      ]);
    });
  });
});
