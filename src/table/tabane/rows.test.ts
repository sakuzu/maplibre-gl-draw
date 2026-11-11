// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/// <reference types="node" />

/**
 * A row block of the Tabane format read as a row block of the tables: the same columns the
 * builder of the blocks of rows makes from the same rows, and the tables take it as it is
 */

import {
  formatTabaneId,
  packTabaneBlock,
  readTabaneBlock,
  readTabaneBlockFile,
  readValue,
  type TabaneRow,
  type TabaneRowBlock,
  tabaneKeysOf,
  tabaneRowSuffixOf,
  tabaneRowsOf,
  type Utf8Column,
  utf8String,
  writeTabaneBlocks,
} from '@sakuzu/tabane';
import type { Polygon } from 'geojson';
import { describe, expect, it } from 'vitest';
import { rowsOfGeoJSON } from '../../api/geojson-rows.js';
import { copyTableStore, type FeatureTables } from '../../api/tables.js';
import {
  type FeatureTablesInternals,
  featureTablesInternals,
} from '../../feature-table/feature-tables.js';
import { compareKeys, keyAfter } from '../../store/order-keys.js';
import { createTableStore } from '../../store/table-memory.js';
import { rowPatch, seededRandom } from '../../test-utils.js';
import { circleRowRings } from '../circle-rings.js';
import {
  geometryColumnOf,
  propertyColumnsOf,
  styleColumnOf,
  typeColumnOf,
} from '../feature-row-columns.js';
import { FEATURE_CACHES } from '../fill-triangles.js';
import { createRowBlockDataBuilder } from '../row-group-builder.js';
import type { RowBlockData, RowBlockDictionary } from '../row-group-types.js';
import { writeTabaneFeatureBlocks } from './blocks.js';
import {
  FEATURE_TABLE_COLUMNS,
  featureRowOfTabane,
  TABANE_FEATURE_COLUMNS,
  type TabaneFeatureRow,
  tabaneRowOf,
} from './columns.js';
import { rowBlockDataOfTabane } from './rows.js';
import { FILL_TRIANGLES_CACHE } from './triangles.js';

const ORIGIN = '1AAAAAAAAAAAA';
const OTHER = 'F000000000001';

/** Whether two values are the same, numbers by their bits */
function same(a: unknown, b: unknown): boolean {
  if (typeof a === 'number' && typeof b === 'number') {
    if (Number.isNaN(a) && Number.isNaN(b)) return true;
    return Object.is(a, b);
  }
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return a === b;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a as object).sort();
  const kb = Object.keys(b as object).sort();
  if (ka.length !== kb.length || ka.some((k, i) => k !== kb[i])) return false;
  return ka.every((k) =>
    same((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
  );
}

/** A polygon of buildings: a ring of 5 to 12 corners around a point, coordinates of 9 digits */
function building(random: () => number, x: number, y: number): Polygon {
  const corners = 5 + Math.floor(random() * 8);
  const ring: number[][] = [];
  for (let k = 0; k < corners; k++) {
    const a = (k / corners) * Math.PI * 2;
    const r = 0.0001 + random() * 0.0002;
    ring.push([
      Math.round((x + Math.cos(a) * r) * 1e9) / 1e9,
      Math.round((y + Math.sin(a) * r) * 1e9) / 1e9,
    ]);
  }
  ring.push([...ring[0]]);
  return { type: 'Polygon', coordinates: [ring] };
}

/** Rows like the buildings of a city: polygons, a few attributes of strings */
function buildings(count: number, seed = 1, from = 1): TabaneFeatureRow[] {
  const random = seededRandom(seed);
  const kinds = ['普通建物', '堅ろう建物', '普通無壁舎'];
  return Array.from({ length: count }, (_, i) => ({
    id: formatTabaneId({ origin: ORIGIN, number: from + i }),
    type: 'Polygon',
    geometry: building(random, 139.7 + random() * 0.1, 35.6 + random() * 0.1),
    properties: {
      fid: `20260625-${50000 + i}`,
      type: kinds[Math.floor(random() * kinds.length)],
      ...(i % 3 === 0 && { floors: 1 + Math.floor(random() * 10) }),
    },
  }));
}

/** Rows of every geometry type, value and flag */
function variety(): TabaneFeatureRow[] {
  const id = (n: number) => formatTabaneId({ origin: ORIGIN, number: n });
  return [
    {
      id: id(1),
      type: 'Point',
      geometry: { type: 'Point', coordinates: [139.767125, 35.681236] },
      properties: { name: '東京駅', rank: 1, ratio: 0.1 + 0.2, flag: true, none: null },
      style: { color: '#ff0000', size: 3 },
    },
    {
      id: id(2),
      type: 'LineString',
      geometry: {
        type: 'LineString',
        coordinates: [
          [0.1 + 0.2, -0],
          [1e-300, 123456789.123],
          [-180, 90],
        ],
      },
      properties: { name: '線', nested: { a: [1, 2, { b: null }], z: 'x' }, rank: -(2 ** 60) },
      deleted: true,
    },
    {
      id: id(3),
      type: 'Polygon',
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [0, 0],
            [10, 0],
            [10, 10],
            [0, 10],
            [0, 0],
          ],
          [
            [2, 2],
            [4, 2],
            [4, 4],
            [2, 2],
          ],
        ],
      },
      properties: { name: '面', flag: false, ratio: -0 },
      style: { color: '#00ff00' },
    },
    {
      id: id(4),
      type: 'MultiPoint',
      geometry: {
        type: 'MultiPoint',
        coordinates: [
          [1.5, 2.5],
          [3.25, 4.125],
        ],
      },
    },
    {
      id: id(5),
      type: 'MultiLineString',
      geometry: {
        type: 'MultiLineString',
        coordinates: [
          [
            [0, 0],
            [1, 1],
          ],
          [
            [2, 2],
            [3, 3],
            [4, 5],
          ],
        ],
      },
      properties: { name: '線' },
    },
    {
      id: id(6),
      type: 'MultiPolygon',
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
              [5, 5],
              [6, 5],
              [6, 6],
              [5, 6],
              [5, 5],
            ],
          ],
        ],
      },
      style: { color: '#00ff00' },
    },
    { id: formatTabaneId({ origin: OTHER, number: 7 }), type: 'Marker', geometry: null },
    {
      id: formatTabaneId({ origin: OTHER, number: 8 }),
      type: 'Circle',
      geometry: { type: 'Point', coordinates: [139.7, 35.6] },
      properties: { radius: 100 },
    },
  ];
}

/** The key of row `i` of the first block of a run that follows the key `V` */
const numberedKey = (i: number) => `V${tabaneRowSuffixOf(0)}${tabaneRowSuffixOf(i)}`;

/** The texts of a column of `n` entries */
function textsOf(column: Utf8Column, n: number): string[] {
  return Array.from({ length: n }, (_, r) => utf8String(column, r));
}

/** A row block of rows, the first block of a run that follows the key `V` */
function rowBlockOf(rows: readonly TabaneRow[]): TabaneRowBlock {
  const [block] = writeTabaneBlocks({
    parent: 'l',
    head: 'V',
    columns: TABANE_FEATURE_COLUMNS,
    rows,
  });
  return readTabaneBlock(block.content)[0];
}

/** Points numbered from `from`, one for each key (without one, a row has the key of its place) */
function pointsOf(keys: readonly (string | undefined)[], from = 1): TabaneRow[] {
  return keys.map((key, i) => ({
    ...tabaneRowOf({
      id: formatTabaneId({ origin: ORIGIN, number: from + i }),
      type: 'Point',
      geometry: { type: 'Point', coordinates: [from + i, 0] },
    }),
    ...(key !== undefined && { key }),
  }));
}

describe('a row block as a row block of the tables', () => {
  /** Every column the builder of the blocks makes of the same rows, compared */
  function expectSameBlock(a: RowBlockData, b: RowBlockData): void {
    expect(a.length).toBe(b.length);
    expect(a.ids).toEqual(b.ids);
    expect(a.idHashes).toEqual(b.idHashes);
    expect(a.keys).toEqual(b.keys);
    expect(a.groups).toEqual(b.groups);
    expect(a.flags).toEqual(b.flags);
    expect(typeColumnOf(a).indexes).toEqual(typeColumnOf(b).indexes);
    expect(typeColumnOf(a).values).toEqual(typeColumnOf(b).values);
    expect(geometryColumnOf(a)!).toEqual(geometryColumnOf(b)!);
    expect(a.rowBounds).toEqual(b.rowBounds);
    expect(a.caches).toEqual(b.caches);
    expect(a.vertexCount).toBe(b.vertexCount);
    for (let r = 0; r < a.length; r++) {
      const sa = styleColumnOf(a).dictionary as NonNullable<RowBlockDictionary['dictionary']>;
      const sb = styleColumnOf(b).dictionary as NonNullable<RowBlockDictionary['dictionary']>;
      expect(utf8String(sa, styleColumnOf(a).indexes[r])).toBe(
        utf8String(sb, styleColumnOf(b).indexes[r]),
      );
      const read = (block: RowBlockData) =>
        Object.fromEntries(
          propertyColumnsOf(block)
            .keys.map((key, k) => [key, readValue(propertyColumnsOf(block).columns[k], r)])
            .filter(([, v]) => v !== undefined),
        );
      expect(same(read(a), read(b))).toBe(true);
    }
  }

  it('holds the columns the builder makes of the same rows', () => {
    const flagged = buildings(50, 6).map((r, i) => ({
      ...r,
      ...(i % 3 === 0 && { visible: false }),
      ...(i % 4 === 0 && { locked: true }),
    }));
    // Circles only: fills written that hold no triangle, and the rings of the circles
    const circles = buildings(3, 9).map((r, i) => ({
      ...r,
      type: 'Circle',
      geometry: { type: 'Point' as const, coordinates: [i, i] },
      properties: { 'maplibre-gl-draw:radiusMeters': 25 + i },
    }));
    for (const rows of [buildings(1000, 3), variety(), flagged, circles]) {
      const [written] = writeTabaneFeatureBlocks({ parent: 'p', head: 'V', rows });
      const builder = createRowBlockDataBuilder({
        columns: FEATURE_TABLE_COLUMNS,
        targetRows: 1000,
        rings: circleRowRings,
        caches: FEATURE_CACHES,
      });
      rows.forEach((row, i) => {
        builder.addRow({
          id: row.id,
          type: row.type,
          geometry: row.geometry,
          // Block 0 follows the key `V` and the suffix of 0
          key: `V${tabaneRowSuffixOf(0)}${tabaneRowSuffixOf(i)}`,
          style: row.style,
          properties: row.properties,
          deleted: row.deleted,
          hidden: row.visible === false,
          locked: row.locked,
        });
      });
      const [built] = builder.finish();
      // The triangles copied from the cache of the file, and made without it
      const file = readTabaneBlockFile(packTabaneBlock(written.block, undefined, written.caches));
      expect(file.rowBlocks).toHaveLength(1);
      expectSameBlock(rowBlockDataOfTabane(file.rowBlocks[0], { caches: file.caches }), built);
      expectSameBlock(rowBlockDataOfTabane(readTabaneBlock(written.block.content)[0]), built);
    }
  });

  it('holds the columns the builder makes of rows of keys of their own', () => {
    const rows = buildings(30, 7);
    // Keys no head gives, then keys of the head and numbers that do not follow each other
    const keys = rows.map((_, i) => (i < 20 ? `A${tabaneRowSuffixOf(i * 7)}` : numberedKey(i * 2)));
    const rowBlock = rowBlockOf(rows.map((row, i) => ({ ...tabaneRowOf(row), key: keys[i] })));
    expect(rowBlock.keys).toEqual(keys);
    const builder = createRowBlockDataBuilder({
      columns: FEATURE_TABLE_COLUMNS,
      targetRows: 1000,
      caches: FEATURE_CACHES,
    });
    rows.forEach((row, i) => {
      builder.addRow({ ...row, key: keys[i] });
    });
    expectSameBlock(rowBlockDataOfTabane(rowBlock), builder.finish()[0]);
  });

  it('keeps the triangles of the polygons in a cache of the file, which the name does not depend on', () => {
    const rows = [...buildings(30, 2), ...variety()];
    const [written] = writeTabaneFeatureBlocks({ parent: 'p', head: 'V', rows });
    expect(written.caches.map((c) => [c.part, c.name])).toEqual([[1, FILL_TRIANGLES_CACHE]]);
    // The content is the one written without the triangles
    const [plain] = writeTabaneBlocks({
      parent: 'p',
      head: 'V',
      columns: TABANE_FEATURE_COLUMNS,
      rows: rows.map(tabaneRowOf),
    });
    expect(written.block.content).toEqual(plain.content);
    // No cache for a row block without a polygon
    expect(
      writeTabaneFeatureBlocks({ parent: 'p', head: 'V', rows: variety().slice(0, 2) })[0].caches,
    ).toEqual([]);
  });

  it('makes the triangles again when the cache does not fit the rows', () => {
    const rows = buildings(40, 4);
    const [written] = writeTabaneFeatureBlocks({ parent: 'p', head: 'V', rows });
    const rowBlock = readTabaneBlock(written.block.content)[0];
    const made = rowBlockDataOfTabane(rowBlock);
    const cache = written.caches[0];
    // The cache of other rows, bytes cut short, an index past the vertices, a cache of another name
    const other = writeTabaneFeatureBlocks({ parent: 'p', head: 'V', rows: buildings(40, 9) })[0]
      .caches[0];
    const cut = { ...cache, content: cache.content.subarray(0, cache.content.length - 3) };
    const past = { ...cache, content: cache.content.slice() };
    past.content[past.content.length - 1] = 0x7f;
    const renamed = { ...cache, name: 'other' };
    for (const c of [other, cut, past, renamed]) {
      expect(rowBlockDataOfTabane(rowBlock, { caches: [c] }).caches).toEqual(made.caches);
    }
    // A cache that fits is copied: an index changed within the vertices is read as it is
    expect(rowBlockDataOfTabane(rowBlock, { caches: [cache] }).caches).toEqual(made.caches);
    const changed = { ...cache, content: cache.content.slice() };
    changed.content[changed.content.length - 1] = 0;
    const copied = rowBlockDataOfTabane(rowBlock, { caches: [changed] }).caches[0].numbers;
    expect(copied[copied.length - 1]).toBe(0);
    expect(made.caches[0].numbers[copied.length - 1]).not.toBe(0);
  });

  it('is taken by the tables as it is, and read back as features', () => {
    const rows = buildings(1500, 5).map((r, i) => ({
      ...r,
      ...(i === 999 && { visible: false }),
      ...(i === 1000 && { locked: true }),
    }));
    const { store, writer } = createTableStore();
    store.createLayer({
      id: 'l',
      name: 'l',
      visible: true,
      locked: false,
      opacity: 1,
      kind: 'table',
      metadata: undefined,
      styleRule: undefined,
    });
    const [written] = writeTabaneFeatureBlocks({ parent: 'l', head: 'V', rows });
    const file = readTabaneBlockFile(packTabaneBlock(written.block, undefined, written.caches));
    writer.addRowBlocks(
      'l',
      file.rowBlocks.map((g, k) =>
        rowBlockDataOfTabane(g, { caches: file.caches.filter((c) => c.part === k + 1) }),
      ),
    );
    featureTablesInternals(store.tables as FeatureTables)?.addQueuedRowBlocks();
    for (const k of [0, 999, 1000, 1499]) {
      const feature = store.getFeature(rows[k].id);
      expect(feature?.geometry).toEqual(rows[k].geometry);
      expect(feature?.properties).toEqual(rows[k].properties);
      expect(feature?.visible).toBe(rows[k].visible ?? true);
      expect(feature?.locked).toBe(rows[k].locked ?? false);
    }
  });
});

describe('a row block that writes the key of each row', () => {
  const id = (number: number) => formatTabaneId({ origin: ORIGIN, number });

  /** A Store of rows with one layer `l` */
  function setup() {
    const { store, writer } = createTableStore();
    store.createLayer({
      id: 'l',
      name: 'l',
      visible: true,
      locked: false,
      opacity: 1,
      kind: 'table',
      metadata: undefined,
      styleRule: undefined,
    });
    const tables = store.tables as FeatureTables;
    const internals = featureTablesInternals(tables) as FeatureTablesInternals;
    /** Takes in row blocks as the tables read them */
    const add = (...rowBlocks: readonly TabaneRowBlock[]) => {
      const blocks = rowBlocks.map((rowBlock) => rowBlockDataOfTabane(rowBlock));
      writer.addRowBlocks('l', blocks);
      internals.addQueuedRowBlocks();
      return blocks;
    };
    const handleOf = (number: number) => tables.findRow(id(number)) as number;
    /** The keys of the rows of numbers, as the tables read them */
    const keysOf = (...numbers: readonly number[]) =>
      tables
        .readValues(
          rowPatch(numbers.map(handleOf), {
            key: numbers.map(() => 0),
          }),
        )
        .fields.get('key');
    return {
      store,
      writer,
      tables,
      internals,
      add,
      handleOf,
      keysOf,
      items: () => itemsOf(tables),
    };
  }

  /** The ids of the items of the layer `l` in their order */
  function itemsOf(tables: FeatureTables): (string | undefined)[] {
    const view = tables.get('l');
    if (!view) return [];
    const refs = view.listItems(0, view.itemCount);
    return Array.from(refs.handles, (h, i) =>
      refs.kinds[i] === 0 ? tables.getRowId(h) : tables.getGroupId(h),
    );
  }

  it('reads the key of each row, and the key its place gives a row without one', () => {
    const rowBlock = rowBlockOf(
      pointsOf(['A5', undefined, numberedKey(3), numberedKey(9), 'a-b', 'あ']),
    );
    const keys = ['A5', numberedKey(1), numberedKey(3), numberedKey(9), 'a-b', 'あ'];
    expect(rowBlock.keys).toEqual(keys);
    const data = rowBlockDataOfTabane(rowBlock);
    expect(textsOf(data.keys, 6)).toEqual(keys);
    expect(Array.from(data.groups)).toEqual([-1, -1, -1, -1, -1, -1]);
  });

  it('leaves the keys of rows that follow each other to the head and the number of the first', () => {
    const rowBlock = rowBlockOf(pointsOf([numberedKey(5), numberedKey(6), numberedKey(7)]));
    expect(rowBlock.keys).toBe(null);
    expect(rowBlock.place.firstIndex).toBe(5);
    const data = rowBlockDataOfTabane(rowBlock);
    expect(textsOf(data.keys, 3)).toEqual([numberedKey(5), numberedKey(6), numberedKey(7)]);
    expect(textsOf(data.keys, 3)).toEqual(tabaneKeysOf(rowBlock));
  });

  it('is taken as it is when its rows are in the order of their keys', () => {
    const { add, internals, handleOf, items, keysOf } = setup();
    const [data] = add(rowBlockOf(pointsOf(['A5', numberedKey(3), numberedKey(9), 'a-b', 'あ'])));
    expect(items()).toEqual([1, 2, 3, 4, 5].map(id));
    for (const number of [1, 2, 3, 4, 5]) {
      expect(internals.placeOf(handleOf(number))?.group.data).toBe(data);
    }
    expect(keysOf(1, 3, 5)).toEqual(['A5', numberedKey(9), 'あ']);
  });

  it('puts rows out of the order of their keys at the places of their keys', () => {
    const { add, internals, items, keysOf } = setup();
    add(rowBlockOf(pointsOf(['q7', 'A5', 'Z'])));
    expect(items()).toEqual([id(2), id(3), id(1)]);
    internals.flushVersions();
    expect(items()).toEqual([id(2), id(3), id(1)]);
    expect(keysOf(1, 2, 3)).toEqual(['q7', 'A5', 'Z']);
  });

  it('orders rows of the same key by their ids', () => {
    const { add, items } = setup();
    add(rowBlockOf(pointsOf(['m', 'm']).reverse()));
    expect(items()).toEqual([id(1), id(2)]);
  });

  it('is put among other row blocks by the keys of its rows, with those of a head', () => {
    const { add, internals, items } = setup();
    const first = pointsOf(['c1', 'e1'], 1);
    const before = pointsOf(['a1', 'b1'], 3);
    const within = pointsOf(['d1', 'f1'], 5);
    const follows = rowBlockOf(pointsOf([undefined, undefined], 7));
    expect(follows.keys).toBe(null);
    add(rowBlockOf(first), rowBlockOf(before), rowBlockOf(within), follows);
    // The keys of a head (`V`) come before the small letters
    const order = [7, 8, 3, 4, 1, 5, 2, 6].map(id);
    expect(items()).toEqual(order);
    internals.flushVersions();
    expect(items()).toEqual(order);
  });

  it('is compared with the keys of the groups of features', () => {
    const { store, add, tables, writer, internals, items, keysOf } = setup();
    add(rowBlockOf(pointsOf(['A5', 'G1', 'G2', 'q7'])));
    store.createGroup({
      id: 'g',
      layerId: 'l',
      name: 'g',
      featureIds: [id(2), id(3)],
      visible: true,
      locked: false,
    });
    internals.flushVersions();
    // The group takes the key of its first member
    const group = tables.findGroup('g') as number;
    expect(writer.getGroupOrder(group)).toBe('G1');
    expect(items()).toEqual([id(1), 'g', id(4)]);
    // A key before the key of the group, the same key (then the ids decide) and a key after it
    add(rowBlockOf(pointsOf(['B1', 'G1', 'H1'], 5)));
    const order = [id(1), id(5), id(6), 'g', id(7), id(4)];
    expect(items()).toEqual(order);
    internals.flushVersions();
    expect(items()).toEqual(order);
    // The group moved past the last row: its members move, their keys (among the members) do not
    const members = keysOf(2, 3);
    store.moveItem('g', { layerId: 'l', above: null });
    internals.flushVersions();
    expect(items()).toEqual([id(1), id(5), id(6), id(7), id(4), 'g']);
    expect(writer.getGroupOrder(group)).toBe(keyAfter('q7'));
    expect(keysOf(2, 3)).toEqual(members);
  });

  it('keeps the keys of its rows when they are read and written back', () => {
    const { add, tables, writer, internals, handleOf, items, keysOf } = setup();
    const [data] = add(rowBlockOf(pointsOf(['A5', 'G1', numberedKey(9), 'q7'])));
    const handles = [1, 2, 3, 4].map(handleOf);
    const read = tables.readValues(rowPatch(handles, { key: [0, 0, 0, 0] }));
    // The same keys move no row
    writer.apply(read);
    expect(internals.placeOf(handleOf(2))?.group.data).toBe(data);
    expect(items()).toEqual([1, 2, 3, 4].map(id));
    // Moved, and put back by the keys read before
    writer.apply(rowPatch([handleOf(4)], { key: ['A1'] }));
    expect(items()).toEqual([4, 1, 2, 3].map(id));
    writer.apply(read);
    expect(items()).toEqual([1, 2, 3, 4].map(id));
    internals.flushVersions();
    expect(items()).toEqual([1, 2, 3, 4].map(id));
    expect(keysOf(1, 2, 3, 4)).toEqual(['A5', 'G1', numberedKey(9), 'q7']);
  });

  it('keeps the key of a row written, in the next versions of the rows', () => {
    const { add, writer, internals, handleOf, items, keysOf } = setup();
    add(rowBlockOf(pointsOf(['A5', 'G1', numberedKey(9), 'q7'])));
    writer.apply(rowPatch([handleOf(2)], { 'properties:name': ['x'] }));
    internals.flushVersions();
    expect(items()).toEqual([1, 2, 3, 4].map(id));
    expect(keysOf(1, 2, 3, 4)).toEqual(['A5', 'G1', numberedKey(9), 'q7']);
    const place = internals.placeOf(handleOf(2));
    expect(place && utf8String(place.group.data.keys, place.row)).toBe('G1');
  });

  it('makes a key between two keys of rows', () => {
    const { store, add, items, keysOf } = setup();
    add(rowBlockOf(pointsOf(['A5', 'G1', 'q7'])));
    store.moveItem(id(3), { layerId: 'l', above: id(2) });
    expect(items()).toEqual([1, 3, 2].map(id));
    const [below, moved, above] = keysOf(1, 3, 2) as string[];
    expect(compareKeys(below, moved)).toBeLessThan(0);
    expect(compareKeys(moved, above)).toBeLessThan(0);
  });

  it('keeps the keys of its rows in a copy of the Store', () => {
    const { store, add, items, keysOf } = setup();
    add(rowBlockOf(pointsOf(['A5', 'G1', numberedKey(9), 'q7'])));
    const copy = copyTableStore(store);
    while (copy.copyNext());
    const tables = copy.store.tables as FeatureTables;
    featureTablesInternals(tables)?.addQueuedRowBlocks();
    expect(itemsOf(tables)).toEqual(items());
    const handles = [1, 2, 3, 4].map((n) => tables.findRow(id(n)) as number);
    expect(tables.readValues(rowPatch(handles, { key: [0, 0, 0, 0] })).fields.get('key')).toEqual(
      keysOf(1, 2, 3, 4),
    );
  });

  it('keeps the keys of its rows written again as rows of another head', () => {
    const keys = ['A5', numberedKey(3), numberedKey(9), 'q7'];
    const [block] = writeTabaneBlocks({
      parent: 'l',
      head: 'W',
      columns: TABANE_FEATURE_COLUMNS,
      rows: tabaneRowsOf(rowBlockOf(pointsOf(keys))),
    });
    const data = rowBlockDataOfTabane(readTabaneBlock(block.content)[0]);
    expect(textsOf(data.keys, 4)).toEqual(keys);
  });
});

describe('a feature as a row of Tabane', () => {
  it('is read back as it was written', () => {
    const rows = [
      ...variety(),
      {
        id: formatTabaneId({ origin: ORIGIN, number: 20 }),
        type: 'Point',
        geometry: { type: 'Point' as const, coordinates: [1, 2] },
        visible: false,
        locked: true,
      },
    ];
    const [written] = writeTabaneFeatureBlocks({ parent: 'p', head: 'V', rows });
    const back = readTabaneBlock(written.block.content).flatMap((g) =>
      tabaneRowsOf(g).map(featureRowOfTabane),
    );
    rows.forEach((row, i) => {
      expect(back[i].id).toBe(row.id);
      expect(back[i].type).toBe(row.type);
      expect(same(back[i].geometry, row.geometry)).toBe(true);
      expect(back[i].style).toEqual(row.style ?? {});
      expect(same(back[i].properties, row.properties ?? {})).toBe(true);
      expect(back[i].visible).toBe(row.visible ?? true);
      expect(back[i].locked).toBe(row.locked ?? false);
      expect(back[i].deleted ?? false).toBe(row.deleted ?? false);
    });
  });

  it('writes a row not shown as a flag of the rows hidden', () => {
    const row = {
      id: formatTabaneId({ origin: ORIGIN, number: 1 }),
      type: 'Point',
      geometry: null,
    };
    expect(tabaneRowOf({ ...row, visible: false }).values?.hidden).toBe(true);
    expect(tabaneRowOf(row).values?.hidden).toBe(false);
    const [written] = writeTabaneFeatureBlocks({ parent: 'p', head: 'V', rows: [row] });
    const rowBlock = readTabaneBlock(written.block.content)[0];
    // A flag no row has is not written
    expect(rowBlock.columns.map((c) => c.name)).toEqual(['style', 'type']);
  });

  it('is refused with a column that is not one of a feature, or of another kind', () => {
    const write = (
      columns: Record<string, 'shape' | 'flag' | 'whole' | 'keyed'>,
      values: Record<string, unknown>,
    ) =>
      readTabaneBlock(
        writeTabaneBlocks({
          parent: 'p',
          head: 'V',
          columns,
          rows: [{ id: formatTabaneId({ origin: ORIGIN, number: 1 }), values }],
        })[0].content,
      )[0] as TabaneRowBlock;
    const other = write({ type: 'whole', name: 'whole' }, { type: 'Point', name: 'x' });
    expect(() => rowBlockDataOfTabane(other)).toThrow(/not one of a feature/);
    const kind = write({ type: 'whole', locked: 'whole' }, { type: 'Point', locked: true });
    expect(() => rowBlockDataOfTabane(kind)).toThrow(/of the kind whole/);
    const shape = write(
      { type: 'whole', geometry: 'shape' },
      { type: 'Point', geometry: { name: 'Polygon', depth: 1, points: [[0, 0]] } },
    );
    expect(() => rowBlockDataOfTabane(shape)).toThrow(/a shape Polygon of the depth 1/);
    expect(() => featureRowOfTabane(tabaneRowsOf(other)[0])).toThrow(/not one of a feature/);
  });
});

describe('features of GeoJSON written as blocks', () => {
  it('keep the z and the m of their positions, in a layer raised to them', () => {
    const read = rowsOfGeoJSON([
      { type: 'Feature', geometry: { type: 'Point', coordinates: [1, 2] }, properties: {} },
      {
        type: 'Feature',
        geometry: {
          type: 'LineString',
          coordinates: [
            [0, 0, 5],
            [1, 1],
          ],
        },
        properties: {},
      },
      {
        type: 'Feature',
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [0, 0, 1, 10],
              [4, 0, 2, 11],
              [4, 4, 3, 12],
              [0, 0, 1, 10],
            ],
          ],
        },
        properties: {},
      },
    ]);
    expect(read.dimensions).toBe('xyzm');
    const rows = read.rows.map((row, i) => ({
      id: formatTabaneId({ origin: ORIGIN, number: i + 1 }),
      type: row.type,
      geometry: row.geometry,
      style: row.style,
      properties: row.properties,
      visible: row.visible,
      locked: row.locked,
    }));
    const { store, writer } = createTableStore({ dimensionsOf: () => read.dimensions });
    store.createLayer({
      id: 'l',
      name: 'l',
      visible: true,
      locked: false,
      opacity: 1,
      kind: 'table',
      metadata: undefined,
      styleRule: undefined,
    });
    const [written] = writeTabaneFeatureBlocks({
      parent: 'l',
      head: 'V',
      rows,
      dimensions: read.dimensions,
    });
    const file = readTabaneBlockFile(packTabaneBlock(written.block, undefined, written.caches));
    writer.addRowBlocks(
      'l',
      file.rowBlocks.map((g, k) =>
        rowBlockDataOfTabane(g, {
          dimensions: read.dimensions,
          caches: file.caches.filter((c) => c.part === k + 1),
        }),
      ),
    );
    featureTablesInternals(store.tables as FeatureTables)?.addQueuedRowBlocks();
    const handles = rows.map((row) => store.tables?.findRow(row.id) as number);
    const geometries = store.tables
      ?.readValues(rowPatch(handles, { geometry: [0, 0, 0] }))
      .fields.get('geometry');
    expect(geometries).toEqual([
      { type: 'Point', coordinates: [1, 2] },
      {
        type: 'LineString',
        coordinates: [
          [0, 0, 5],
          [1, 1],
        ],
      },
      rows[2].geometry,
    ]);
  });
});
