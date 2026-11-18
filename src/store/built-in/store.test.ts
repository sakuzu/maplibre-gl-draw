// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The read side of the built-in Store, without a map (`createStore`)
 *
 * - The layers, the groups, the stacking order, the files and the metadata read what was written
 * - The view of the rows of a layer reads each value of a row without making a feature, and leaves
 *   out the rows of other layers
 * - `readValues` reads only the fields asked, the geometries as columns of parts, rings and
 *   positions, and refuses rows of more than one layer, a key of the style and a field that is not
 *   one of a row
 * - `scan` reads the rows a batch at a time, by layer and by box
 * - The items of a layer are in the order of their keys, and of their ids (as bytes) for equal keys
 * - The arrays read are new each time, and the reference of a row stays when the row moves
 * - The work of a read does not grow with the rows of the table
 *
 * The rows are written straight into the tables of the document, as the writes of the Store will
 * (the writes are not part of this read side).
 */

import { createPageBuilder, type TableColumns } from '@sakuzu/kasane';
import { listPages } from '@sakuzu/kasane/render';
import type { Geometry } from 'geojson';
import { describe, expect, it } from 'vitest';
import type { FeatureStyle, FileData, Layer, Metadata } from '../../api/model.js';
import { DrawError } from '../../shared/errors.js';
import { countsOf, expectNotProportional, workDuring } from '../../test-utils.js';
import { createStore, storeOf } from './create-store.js';
import {
  dimensionsOfPositions,
  type LayerPositions,
  openDocument,
  positionsOf,
  ROW_COLUMNS,
  type StoreDocument,
} from './document.js';
import {
  GEOMETRY_TYPES,
  type GeometryColumn,
  type RowSpatialIndexing,
  type StoreGroup,
} from './types.js';

// ---------------------------------------------------------------------------------------------
// Writing the document directly

/** A row as the tests write it */
interface TestRow {
  readonly id: string;
  readonly orderKey: string;
  readonly geometry?: Geometry | null;
  readonly type?: string;
  readonly groupId?: string;
  readonly style?: Readonly<FeatureStyle>;
  readonly properties?: Readonly<Record<string, unknown>>;
  readonly visible?: boolean;
  readonly locked?: boolean;
}

/** The depth of the shape of each type of geometry */
const DEPTHS: ReadonlyMap<string, number> = new Map([
  ['Point', 0],
  ['LineString', 1],
  ['MultiPoint', 1],
  ['Polygon', 2],
  ['MultiLineString', 2],
  ['MultiPolygon', 3],
]);

/** The shape of the tables of a GeoJSON geometry */
function shapeOf(geometry: Geometry) {
  if (geometry.type === 'GeometryCollection') throw new Error('not a geometry of a row');
  return { name: geometry.type, depth: DEPTHS.get(geometry.type), points: geometry.coordinates };
}

/** A new document with its own references for the groups */
function newDocument(
  spatialIndexing?: RowSpatialIndexing,
): StoreDocument & { groupRefs: Map<string, number> } {
  return Object.assign(openDocument(spatialIndexing), { groupRefs: new Map<string, number>() });
}

type TestDocument = ReturnType<typeof newDocument>;

function addLayer(
  document: TestDocument,
  id: string,
  positions?: LayerPositions,
  layer: Partial<Layer> = {},
): Layer {
  const stored: Layer = Object.freeze({
    id,
    name: id,
    visible: true,
    locked: false,
    opacity: 1,
    items: Object.freeze([]),
    styleRule: undefined,
    metadata: undefined,
    ...layer,
  });
  document.layers.set(id, stored);
  if (positions) document.layerPositions.set(id, Object.freeze(positions));
  document.layerOrder = Object.freeze([...document.layerOrder, id]);
  return stored;
}

function addGroup(
  document: TestDocument,
  group: Pick<StoreGroup, 'id' | 'layerId' | 'orderKey'> & Partial<StoreGroup>,
): StoreGroup {
  const stored: StoreGroup = Object.freeze({
    name: group.id,
    featureIds: Object.freeze([]),
    visible: true,
    locked: false,
    ...group,
  });
  document.groups.set(stored.id, stored);
  const ref = document.groupRefs.size + 1;
  document.groupRefs.set(stored.id, ref);
  document.rowWrites.writeGroups({
    groups: Int32Array.of(ref),
    fields: new Map<string, unknown[]>([
      ['id', [stored.id]],
      ['parent', [stored.layerId]],
      ['key', [stored.orderKey]],
      ['hidden', [!stored.visible]],
    ]),
  });
  return stored;
}

/** The style a row is written with when it gives none (shared by the rows) */
const NO_STYLE: Readonly<FeatureStyle> = Object.freeze({});

function addRows(document: TestDocument, layerId: string, rows: readonly TestRow[]): void {
  const groups = [...document.groups.values()]
    .filter((g) => g.layerId === layerId)
    .map((g) => ({ group: document.groupRefs.get(g.id) as number, id: g.id, key: g.orderKey }));
  const builder = createPageBuilder({
    columns: ROW_COLUMNS as TableColumns,
    dimensions: dimensionsOfPositions(positionsOf(document, layerId)),
    groups,
  });
  for (const row of rows) {
    const geometry = row.geometry === undefined ? point(0, 0) : row.geometry;
    builder.add({
      id: row.id,
      key: row.orderKey,
      ...(row.groupId !== undefined && { group: document.groupRefs.get(row.groupId) }),
      values: {
        type: row.type ?? geometry?.type ?? 'Point',
        ...(geometry && { geometry: shapeOf(geometry) }),
        style: row.style ?? NO_STYLE,
        ...(row.properties && { properties: row.properties }),
        ...(row.visible === false && { hidden: true }),
        ...(row.locked && { locked: true }),
      },
    });
  }
  document.rowWrites.addPages(layerId, builder.build());
  listPages(document.rows).addQueuedPages();
}

/** Writes the place of a row: its parent (a layer or a group) and its key */
function moveRow(document: TestDocument, ref: number, parent: string, orderKey: string): void {
  document.rowWrites.writeRows({
    rows: Int32Array.of(ref),
    fields: new Map<string, unknown[]>([
      ['parent', [parent]],
      ['key', [orderKey]],
    ]),
  });
  listPages(document.rows).addQueuedPages();
}

function point(x: number, y: number, ...more: number[]): Geometry {
  return { type: 'Point', coordinates: [x, y, ...more] };
}

/** The rows of a layer, `count` points in a line */
function pointRows(count: number, prefix = 'r'): TestRow[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `${prefix}${String(i).padStart(6, '0')}`,
    orderKey: `k${String(i).padStart(6, '0')}`,
    geometry: point(i * 0.001, 0),
    properties: { name: `n${i}`, height: i },
  }));
}

function refOf(store: ReturnType<typeof storeOf>, id: string): number {
  const ref = store.tables.getRowRef(id);
  if (ref === undefined) throw new Error(`no row ${id}`);
  return ref;
}

/** The values of a geometry column, as plain arrays */
function plain(column: GeometryColumn | undefined) {
  if (!column) throw new Error('no geometry');
  return {
    types: [...column.types],
    coordinates: [...column.coordinates],
    valuesPerPosition: column.valuesPerPosition,
    partStarts: [...column.partStarts],
    ringStarts: [...column.ringStarts],
    positionStarts: [...column.positionStarts],
  };
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

// ---------------------------------------------------------------------------------------------

describe('a Store made without a map', () => {
  it('starts empty, and reads as a plain object spread into another', () => {
    const base = createStore();
    const store = { ...base };
    expect(store.listLayers()).toEqual([]);
    expect(store.listGroups()).toEqual([]);
    expect(store.listFiles()).toEqual([]);
    expect(store.getLayerOrder()).toEqual([]);
    expect(store.getMetadata()).toEqual({});
    expect(store.getLayer('a')).toBeUndefined();
    expect(store.getGroup('g')).toBeUndefined();
    expect(store.getFile('f')).toBeUndefined();
    expect(store.tables.get('a')).toBeUndefined();
    expect(store.tables.getRowRef('r')).toBeUndefined();
    expect(store.tables.findRow('r')).toBeUndefined();
    expect(store.tables.getValuesPerPosition('a')).toBeUndefined();
    expect(store.tables.scan().next()).toBeNull();
  });

  it('holds the numbers of its work, which a Store spread from it does not', () => {
    const base = createStore();
    expect(countsOf(base).rowsTouched).toBe(0);
    expect(() => countsOf({ ...base })).toThrow();
  });
});

describe('the layers, the groups, the files and the metadata', () => {
  it('read what was written', () => {
    const document = newDocument();
    const a = addLayer(document, 'a');
    const b = addLayer(document, 'b', { valuesPerPosition: 3, thirdValue: 'measure' });
    const g = addGroup(document, { id: 'g', layerId: 'a', orderKey: 'm', name: 'Group' });
    const file: FileData = Object.freeze({ id: 'f', mimeType: 'image/png', dataURL: 'data:,' });
    document.files.set(file.id, file);
    const metadata: Metadata = Object.freeze({ title: 'Title', description: 'About' });
    document.metadata = metadata;
    const store = storeOf(document);
    expect(store.getLayer('a')).toBe(a);
    expect(store.listLayers()).toEqual([a, b]);
    expect(store.getLayerOrder()).toEqual(['a', 'b']);
    expect(store.getGroup('g')).toBe(g);
    expect(store.getGroup('g')?.orderKey).toBe('m');
    expect(store.listGroups()).toEqual([g]);
    expect(store.getFile('f')).toBe(file);
    expect(store.listFiles()).toEqual([file]);
    expect(store.getMetadata()).toBe(metadata);
    expect(store.tables.getValuesPerPosition('a')).toBe(2);
    expect(store.tables.getValuesPerPosition('b')).toBe(3);
    expect(store.tables.findGroup('g')).toBe(document.groupRefs.get('g'));
    expect(store.tables.getGroupId(document.groupRefs.get('g') as number)).toBe('g');
    expect(store.tables.findGroup('nope')).toBeUndefined();
  });

  it('read the third value of the positions of a layer', () => {
    const document = newDocument();
    addLayer(document, 'xy');
    addLayer(document, 'z', { valuesPerPosition: 3, thirdValue: 'height' });
    addLayer(document, 'm', { valuesPerPosition: 3, thirdValue: 'measure' });
    addLayer(document, 'zm', { valuesPerPosition: 4, thirdValue: 'measure' });
    const tables = storeOf(document).tables;
    expect(tables.getThirdValue('xy')).toBeUndefined();
    expect(tables.getThirdValue('z')).toBe('height');
    expect(tables.getThirdValue('m')).toBe('measure');
    expect(tables.getThirdValue('zm')).toBe('height');
    expect(tables.getThirdValue('none')).toBeUndefined();
  });
});

describe('the view of the rows of a layer', () => {
  /** Two layers: three rows in `a` (one in a group), one in `b` */
  function twoLayers() {
    const document = newDocument();
    addLayer(document, 'a');
    addLayer(document, 'b');
    addGroup(document, { id: 'g', layerId: 'a', orderKey: 'k1' });
    const red: Readonly<FeatureStyle> = Object.freeze({ fillColor: '#f00' });
    addRows(document, 'a', [
      { id: 'p', orderKey: 'k0', geometry: point(1, 2), style: red, properties: { name: 'P' } },
      {
        id: 'line',
        orderKey: 'k2',
        geometry: {
          type: 'LineString',
          coordinates: [
            [10, 10],
            [12, 14],
          ],
        },
        style: red,
      },
      { id: 'member', orderKey: 'a', groupId: 'g', geometry: point(5, 5), type: 'Circle' },
    ]);
    addRows(document, 'b', [{ id: 'other', orderKey: 'k0', geometry: point(1, 2) }]);
    return { document, store: storeOf(document), red };
  }

  it('reads each value of a row of the layer, and nothing of a row of another layer', () => {
    const { store, red } = twoLayers();
    const view = store.tables.get('a');
    if (!view) throw new Error('no view');
    const p = refOf(store, 'p');
    const line = refOf(store, 'line');
    const member = refOf(store, 'member');
    const other = refOf(store, 'other');
    expect(view.layerId).toBe('a');
    expect(view.rowCount).toBe(3);
    expect(view.getRowType(p)).toBe('Point');
    expect(view.getRowType(member)).toBe('Circle');
    expect(view.getRowType(other)).toBeNull();
    expect(view.getPointPosition(p)).toEqual([1, 2]);
    expect(view.getPointPosition(line)).toBeNull();
    expect(view.getPointPosition(other)).toBeNull();
    expect(view.getRowProperty(p, 'name')).toBe('P');
    expect(view.getRowProperty(p, 'none')).toBeUndefined();
    expect(view.getRowProperty(other, 'name')).toBeUndefined();
    expect(view.getRowBBox(line)).toEqual([10, 10, 12, 14]);
    expect(view.getRowBBox(other)).toBeNull();
    // One frozen object for the rows of the same style, read without a copy
    expect(view.getRowStyle(p)).toEqual(red);
    expect(view.getRowStyle(line)).toBe(view.getRowStyle(p));
    expect(Object.isFrozen(view.getRowStyle(p))).toBe(true);
    expect(view.getRowStyle(other)).toBeUndefined();
    expect(store.tables.getRowId(p)).toBe('p');
    expect(store.tables.findRow('p')).toEqual({ ref: p, deleted: false });
  });

  it('lists the rows, the items and the members of a group in the order of the layer', () => {
    const { store, document } = twoLayers();
    const view = store.tables.get('a');
    if (!view) throw new Error('no view');
    const ids = (refs: Int32Array) => [...refs].map((ref) => store.tables.getRowId(ref));
    expect(ids(view.listRowRefs(0, 10))).toEqual(['p', 'member', 'line']);
    expect(ids(view.listRowRefs(1, 1))).toEqual(['member']);
    expect(view.itemCount).toBe(3);
    const items = view.listItemRefs(0, 10);
    expect([...items.kinds]).toEqual([0, 1, 0]);
    expect(store.tables.getRowId(items.refs[0])).toBe('p');
    expect(store.tables.getGroupId(items.refs[1])).toBe('g');
    expect(store.tables.getRowId(items.refs[2])).toBe('line');
    const g = document.groupRefs.get('g') as number;
    expect(view.countGroupMembers(g)).toBe(1);
    expect(ids(view.listGroupMembers(g, 0, 10))).toEqual(['member']);
  });

  it('lists the rows drawn in a box, leaving out a row and a group that are not visible', () => {
    const document = newDocument();
    addLayer(document, 'a');
    addGroup(document, { id: 'shown', layerId: 'a', orderKey: 'k5' });
    addGroup(document, { id: 'hidden', layerId: 'a', orderKey: 'k6', visible: false });
    addRows(document, 'a', [
      { id: 'in', orderKey: 'k0', geometry: point(1, 1) },
      { id: 'out', orderKey: 'k1', geometry: point(50, 50) },
      { id: 'invisible', orderKey: 'k2', geometry: point(1, 1), visible: false },
      { id: 'inShown', orderKey: 'a', groupId: 'shown', geometry: point(2, 2) },
      { id: 'inHidden', orderKey: 'a', groupId: 'hidden', geometry: point(2, 2) },
    ]);
    const store = storeOf(document);
    const view = store.tables.get('a');
    if (!view) throw new Error('no view');
    const drawn = [...view.listDrawnRows([0, 0, 10, 10])].map((r) => store.tables.getRowId(r));
    expect(drawn).toEqual(['in', 'inShown']);
    expect(store.tables.readValues(Int32Array.of(refOf(store, 'invisible')), ['visible'])).toEqual(
      expect.objectContaining({ fields: new Map([['visible', [false]]]) }),
    );
    // A row hidden changes the revision of the rows drawn
    const revision = view.getDrawnRowsRevision();
    document.rowWrites.writeRows({
      rows: Int32Array.of(refOf(store, 'in')),
      fields: new Map([['hidden', [true]]]),
    });
    expect(view.getDrawnRowsRevision()).not.toBe(revision);
    expect([...view.listDrawnRows([0, 0, 10, 10])].map((r) => store.tables.getRowId(r))).toEqual([
      'inShown',
    ]);
  });
});

describe('readValues', () => {
  /** A layer of each kind of geometry, in the order of their keys */
  function geometries() {
    const document = newDocument();
    addLayer(document, 'a');
    addLayer(document, 'b');
    addRows(document, 'a', [
      { id: 'pt', orderKey: 'k0', geometry: point(1, 2), properties: { name: 'A', n: 1 } },
      {
        id: 'ls',
        orderKey: 'k1',
        geometry: {
          type: 'LineString',
          coordinates: [
            [0, 0],
            [1, 1],
            [2, 0],
          ],
        },
      },
      {
        id: 'pg',
        orderKey: 'k2',
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [0, 0],
              [4, 0],
              [4, 4],
              [0, 0],
            ],
            [
              [1, 1],
              [2, 1],
              [2, 2],
              [1, 1],
            ],
          ],
        },
      },
      {
        id: 'mpt',
        orderKey: 'k3',
        geometry: {
          type: 'MultiPoint',
          coordinates: [
            [7, 7],
            [8, 8],
          ],
        },
      },
      {
        id: 'mls',
        orderKey: 'k4',
        geometry: {
          type: 'MultiLineString',
          coordinates: [
            [
              [0, 0],
              [1, 0],
            ],
            [
              [5, 5],
              [6, 5],
              [6, 6],
            ],
          ],
        },
      },
      {
        id: 'mpg',
        orderKey: 'k5',
        geometry: {
          type: 'MultiPolygon',
          coordinates: [
            [
              [
                [0, 0],
                [1, 0],
                [1, 1],
                [0, 0],
              ],
            ],
            [
              [
                [3, 3],
                [5, 3],
                [5, 5],
                [3, 3],
              ],
              [
                [4, 4],
                [4.5, 4],
                [4.5, 4.5],
                [4, 4],
              ],
            ],
          ],
        },
      },
      { id: 'none', orderKey: 'k6', geometry: null, type: 'Custom' },
    ]);
    addRows(document, 'b', [{ id: 'elsewhere', orderKey: 'k0', geometry: point(0, 0) }]);
    const store = storeOf(document);
    const ids = ['pt', 'ls', 'pg', 'mpt', 'mls', 'mpg', 'none'];
    return { store, refs: Int32Array.from(ids.map((id) => refOf(store, id))) };
  }

  it('reads only the fields asked', () => {
    const { store, refs } = geometries();
    const values = store.tables.readValues(refs.subarray(0, 2), ['type', 'properties:name']);
    expect([...values.fields.keys()]).toEqual(['type', 'properties:name']);
    expect(values.fields.get('type')).toEqual(['Point', 'LineString']);
    expect(values.fields.get('properties:name')).toEqual(['A', undefined]);
    expect(values.geometry).toBeUndefined();
    expect(values.deleted).toBeUndefined();
    expect([...values.rows]).toEqual([...refs.subarray(0, 2)]);
    const all = store.tables.readValues(refs.subarray(0, 1), [
      'visible',
      'locked',
      'style',
      'parent',
      'orderKey',
    ]);
    expect(Object.fromEntries([...all.fields].map(([field, [value]]) => [field, value]))).toEqual({
      visible: true,
      locked: false,
      style: {},
      parent: 'a',
      orderKey: 'k0',
    });
    const withDeleted = store.tables.readValues(refs.subarray(0, 1), ['type'], { deleted: true });
    expect([...(withDeleted.deleted ?? [])]).toEqual([0]);
  });

  it('reads the geometries as parts made of rings made of positions', () => {
    const { store, refs } = geometries();
    const values = store.tables.readValues(refs, ['geometry']);
    expect([...values.fields.keys()]).toEqual([]);
    expect(plain(values.geometry)).toEqual({
      // Point, LineString, Polygon, MultiPoint, MultiLineString, MultiPolygon, none
      types: [0, 1, 2, 3, 4, 5, 255],
      coordinates: [
        ...[1, 2],
        ...[0, 0, 1, 1, 2, 0],
        ...[0, 0, 4, 0, 4, 4, 0, 0, 1, 1, 2, 1, 2, 2, 1, 1],
        ...[7, 7, 8, 8],
        ...[0, 0, 1, 0, 5, 5, 6, 5, 6, 6],
        ...[0, 0, 1, 0, 1, 1, 0, 0, 3, 3, 5, 3, 5, 5, 3, 3, 4, 4, 4.5, 4, 4.5, 4.5, 4, 4],
      ],
      valuesPerPosition: 2,
      // A part per row, but a part per member for the Multi geometries, and none for no geometry
      partStarts: [0, 1, 2, 3, 5, 7, 9, 9],
      // The rings of each part: one, but the two of the polygon with a hole, and of the second
      // polygon of the MultiPolygon
      ringStarts: [0, 1, 2, 4, 5, 6, 7, 8, 9, 11],
      positionStarts: [0, 1, 4, 8, 12, 13, 14, 16, 19, 23, 27, 31],
    });
    expect(GEOMETRY_TYPES[values.geometry?.types[5] as number]).toBe('MultiPolygon');
  });

  it('reads the positions of a layer of three and of four values', () => {
    const document = newDocument();
    addLayer(document, 'z', { valuesPerPosition: 3, thirdValue: 'height' });
    addLayer(document, 'm', { valuesPerPosition: 3, thirdValue: 'measure' });
    addLayer(document, 'zm', { valuesPerPosition: 4, thirdValue: 'height' });
    addRows(document, 'z', [
      {
        id: 'z1',
        orderKey: 'k0',
        geometry: {
          type: 'LineString',
          coordinates: [
            [0, 0, 10],
            [1, 1, 20],
          ],
        },
      },
    ]);
    addRows(document, 'm', [{ id: 'm1', orderKey: 'k0', geometry: point(3, 4, 7) }]);
    addRows(document, 'zm', [{ id: 'zm1', orderKey: 'k0', geometry: point(3, 4, 5, 6) }]);
    const store = storeOf(document);
    const read = (id: string) =>
      plain(store.tables.readValues(Int32Array.of(refOf(store, id)), ['geometry']).geometry);
    expect(read('z1')).toEqual({
      types: [1],
      coordinates: [0, 0, 10, 1, 1, 20],
      valuesPerPosition: 3,
      partStarts: [0, 1],
      ringStarts: [0, 1],
      positionStarts: [0, 2],
    });
    expect(read('m1').coordinates).toEqual([3, 4, 7]);
    expect(read('m1').valuesPerPosition).toBe(3);
    expect(read('zm1').coordinates).toEqual([3, 4, 5, 6]);
    expect(read('zm1').valuesPerPosition).toBe(4);
    expect(store.tables.get('zm')?.getPointPosition(refOf(store, 'zm1'))).toEqual([3, 4]);
  });

  it('refuses rows of more than one layer, a key of the style and a field that is not one of a row', () => {
    const { store, refs } = geometries();
    const elsewhere = refOf(store, 'elsewhere');
    expectCode(
      () => store.tables.readValues(Int32Array.of(refs[0], elsewhere), ['type']),
      'invalidInput',
    );
    expectCode(
      () => store.tables.readValues(Int32Array.of(refs[0], elsewhere), ['geometry']),
      'invalidInput',
    );
    expectCode(() => store.tables.readValues(refs, ['style:fillColor']), 'invalidInput');
    expectCode(
      () => store.tables.readValues(refs, ['hidden' as unknown as 'type']),
      'invalidInput',
    );
    expectCode(() => store.tables.readValues(refs, ['properties:']), 'invalidInput');
    // A row that is not there takes no layer
    expect(
      store.tables.readValues(Int32Array.of(refs[0], 99_999), ['type'], { deleted: true }),
    ).toEqual(
      expect.objectContaining({
        fields: new Map([['type', ['Point', undefined]]]),
        deleted: Uint8Array.of(0, 1),
      }),
    );
  });
});

describe('the spatial indexing given', () => {
  it('makes the boxes of the rows written', () => {
    // The boxes of the plane moved 1,000 degrees east
    const spatialIndexing: RowSpatialIndexing = {
      rowBox(coordinates, valuesPerPosition, from, to, out, at) {
        let minX = Number.POSITIVE_INFINITY;
        let minY = Number.POSITIVE_INFINITY;
        let maxX = Number.NEGATIVE_INFINITY;
        let maxY = Number.NEGATIVE_INFINITY;
        for (let p = from; p < to; p++) {
          const x = coordinates[p * valuesPerPosition] + 1000;
          const y = coordinates[p * valuesPerPosition + 1];
          minX = Math.min(minX, x);
          minY = Math.min(minY, y);
          maxX = Math.max(maxX, x);
          maxY = Math.max(maxY, y);
        }
        out.set(from < to ? [minX, minY, maxX, maxY] : [NaN, NaN, NaN, NaN], at);
      },
    };
    const document = newDocument(spatialIndexing);
    addLayer(document, 'a');
    addRows(document, 'a', [{ id: 'p', orderKey: 'k0', geometry: point(0, 0) }]);
    const store = storeOf(document);
    const ref = refOf(store, 'p');
    // The tables make the box of a geometry they are given
    document.rowWrites.writeRows({
      rows: Int32Array.of(ref),
      fields: new Map([['geometry', [shapeOf(point(1, 2))]]]),
    });
    const view = store.tables.get('a');
    expect(view?.getRowBBox(ref)).toEqual([1001, 2, 1001, 2]);
    expect([...(view?.listDrawnRows([1000, 0, 1002, 3]) ?? [])]).toEqual([ref]);
    expect([...(view?.listDrawnRows([0, 0, 2, 3]) ?? [])]).toEqual([]);
  });
});

describe('scan', () => {
  it('reads the references a batch at a time, by layer and by box', () => {
    const document = newDocument();
    addLayer(document, 'a');
    addLayer(document, 'b');
    addRows(document, 'a', pointRows(5, 'a'));
    addRows(document, 'b', [{ id: 'far', orderKey: 'k0', geometry: point(80, 80) }]);
    const store = storeOf(document);
    const batches = (options?: Parameters<typeof store.tables.scan>[0]) => {
      const cursor = store.tables.scan(options);
      const out: string[][] = [];
      for (let batch = cursor.next(); batch !== null; batch = cursor.next()) {
        out.push([...batch].map((ref) => store.tables.getRowId(ref) as string));
      }
      return out;
    };
    expect(batches({ batchSize: 2, layerIds: ['a'] })).toEqual([
      ['a000000', 'a000001'],
      ['a000002', 'a000003'],
      ['a000004'],
    ]);
    expect(batches({ layerIds: ['b', 'a'] }).flat()).toEqual([
      'far',
      'a000000',
      'a000001',
      'a000002',
      'a000003',
      'a000004',
    ]);
    expect(batches({ bbox: [0.0015, -1, 0.0035, 1] }).flat()).toEqual(['a000002', 'a000003']);
    expect(batches().flat()).toHaveLength(6);
  });
});

describe('the order of the items', () => {
  it('is the order of the keys, and of the ids as bytes for equal keys', () => {
    const document = newDocument();
    addLayer(document, 'a');
    // U+FF5A comes before U+1F600 as bytes of UTF-8, after it as units of UTF-16
    const ids = ['b', 'a', 'B', '\u{1F600}', 'ｚ'];
    addRows(document, 'a', [
      { id: 'last', orderKey: 'z' },
      ...ids.map((id) => ({ id, orderKey: 'm' })),
      { id: 'first', orderKey: 'a' },
    ]);
    const store = storeOf(document);
    const view = store.tables.get('a');
    if (!view) throw new Error('no view');
    const items = view.listItemRefs(0, 100);
    expect([...items.refs].map((ref) => store.tables.getRowId(ref))).toEqual([
      'first',
      'B',
      'a',
      'b',
      'ｚ',
      '\u{1F600}',
      'last',
    ]);
  });
});

describe('what the tables hand out', () => {
  it('is a new array at each read', () => {
    const document = newDocument();
    addLayer(document, 'a');
    addGroup(document, { id: 'g', layerId: 'a', orderKey: 'k9' });
    addRows(document, 'a', [...pointRows(3), { id: 'm', orderKey: 'a', groupId: 'g' }]);
    const store = storeOf(document);
    const view = store.tables.get('a');
    if (!view) throw new Error('no view');
    const g = document.groupRefs.get('g') as number;
    const refs = view.listRowRefs(0, 10);
    const twice = <T>(read: () => T): [T, T] => [read(), read()];
    const reads: Array<[unknown, unknown]> = [
      twice(() => view.listRowRefs(0, 10)),
      twice(() => view.listDrawnRows([-1, -1, 1, 1])),
      twice(() => view.listItemRefs(0, 10).refs),
      twice(() => view.listItemRefs(0, 10).kinds),
      twice(() => view.listGroupMembers(g, 0, 10)),
      twice(() => view.getRowBBox(refs[0])),
      twice(() => store.tables.readValues(refs, ['type']).fields.get('type')),
      twice(() => store.tables.readValues(refs, ['visible']).fields.get('visible')),
      twice(() => store.tables.readValues(refs, ['type']).rows),
      twice(() => store.tables.readValues(refs, ['geometry']).geometry?.coordinates),
      twice(() => store.tables.scan().next()),
    ];
    for (const [first, second] of reads) {
      expect(first).toEqual(second);
      expect(first).not.toBe(second);
    }
  });

  it('names a row by the same reference after it moved to a group and to another layer', () => {
    const document = newDocument();
    addLayer(document, 'a');
    addLayer(document, 'b');
    addGroup(document, { id: 'g', layerId: 'a', orderKey: 'k5' });
    addRows(document, 'a', pointRows(3));
    const store = storeOf(document);
    const ref = refOf(store, 'r000001');
    moveRow(document, ref, 'g', 'a');
    expect(store.tables.getRowRef('r000001')).toBe(ref);
    expect(store.tables.readValues(Int32Array.of(ref), ['parent']).fields.get('parent')).toEqual([
      'g',
    ]);
    moveRow(document, ref, 'b', 'k0');
    expect(store.tables.getRowRef('r000001')).toBe(ref);
    expect(store.tables.getRowId(ref)).toBe('r000001');
    expect(store.tables.get('b')?.getRowType(ref)).toBe('Point');
    expect(store.tables.get('a')?.getRowType(ref)).toBeNull();
    expect([...(store.tables.get('b')?.listRowRefs(0, 10) ?? [])]).toEqual([ref]);
  });
});

// ---------------------------------------------------------------------------------------------
// The work of the reads

/** The objects reachable from a value, typed arrays left out (they hold numbers only) */
function countObjects(value: unknown, seen = new Set<object>()): number {
  if (typeof value !== 'object' || value === null || seen.has(value)) return 0;
  seen.add(value);
  if (ArrayBuffer.isView(value)) return 0;
  let n = 1;
  const children =
    value instanceof Map ? [...value.keys(), ...value.values()] : Object.values(value);
  for (const child of children) n += countObjects(child, seen);
  return n;
}

/**
 * A Store of `size` rows of polygons and points in one layer, whose tables count the rows each
 * read asks them for
 */
function storeOfSize(size: number) {
  const document = newDocument();
  addLayer(document, 'a');
  addRows(
    document,
    'a',
    pointRows(size).map((row, i) =>
      i % 2 === 0
        ? row
        : {
            ...row,
            geometry: {
              type: 'Polygon',
              coordinates: [
                [
                  [i, 0],
                  [i + 1, 0],
                  [i + 1, 1],
                  [i, 0],
                ],
              ],
            },
          },
    ),
  );
  const asked = { rows: 0 };
  const tables = document.rows;
  document.rows = {
    ...tables,
    readValues: (rows, fields, options) => {
      asked.rows += rows.length;
      return tables.readValues(rows, fields, options);
    },
  };
  const store = storeOf(document);
  const view = store.tables.get('a');
  if (!view) throw new Error('no view');
  return { store, view, asked, all: view.listRowRefs(0, size) };
}

describe('the work of the reads', () => {
  it('makes no object per row when it reads the geometries or one attribute of every row', () => {
    for (const fields of [['geometry'], ['properties:name']] as const) {
      expectNotProportional(
        (size) => {
          const { store, all } = storeOfSize(size);
          const counts = countsOf(store);
          let values: unknown;
          const work = workDuring(counts, () => {
            values = store.tables.readValues(all, [...fields]);
          });
          return work.objectsCreated + countObjects(values);
        },
        `the objects of readValues(rows, ${JSON.stringify(fields)})`,
      );
    }
  });

  it('reads one attribute of one row with the same work in a table of any size', () => {
    for (const measure of ['marks', 'rows asked of the tables'] as const) {
      expectNotProportional((size) => {
        const { store, view, asked, all } = storeOfSize(size);
        const counts = countsOf(store);
        const before = asked.rows;
        const work = workDuring(counts, () => {
          expect(view.getRowProperty(all[size - 1], 'name')).toBe(`n${size - 1}`);
        });
        return measure === 'marks' ? work.rowsTouched + work.objectsCreated : asked.rows - before;
      }, `the work of getRowProperty (${measure})`);
    }
  });
});
