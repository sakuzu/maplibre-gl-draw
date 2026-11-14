// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What reads every feature of a Store of rows without listing them: `features.list` up to a
 * limit, `features.count`, the lock checked when a layer is deleted, and the numbers of the
 * names generated. Each answer is compared with the one of an
 * in-memory Store of objects holding the same features.
 */

import { TablesStore } from '@sakuzu/kasane/render';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AutoNameGenerator } from '../../shared/utils/name-generator.js';
import { featuresInOrder } from '../../store/feature-stream.js';
import { MemoryStore } from '../../store/memory.js';
import type { Store } from '../../store/store.js';
import { createTableStore } from '../../store/table-memory.js';
import type { Feature, Group, Layer } from '../../store/types.js';
import { FEATURE_TABLE_COLUMNS } from '../../table/tabane/columns.js';
import {
  featureRowDataBuilder as createPageDataBuilder,
  createResourceDeps,
} from '../../test-utils.js';
import { DrawError } from '../errors.js';
import type { FeatureFilter } from '../model.js';
import type { FeatureResource as FeaturesCollection } from './feature-resource.js';
import { createFeatures } from './features.js';
import { createLayers } from './layers.js';

function layerOf(id: string, table: boolean, extra: Partial<Layer> = {}): Layer {
  const base = {
    id,
    name: id,
    visible: true,
    locked: false,
    opacity: 1,
    styleRule: undefined,
    metadata: undefined,
  };
  return (table ? { ...base, kind: 'table', ...extra } : { ...base, items: [], ...extra }) as Layer;
}

function groupOf(id: string, layerId: string, table: boolean, extra: Partial<Group> = {}): Group {
  const base = { id, layerId, name: id, visible: true, locked: false };
  return (
    table ? { ...base, kind: 'table', ...extra } : { ...base, featureIds: [], ...extra }
  ) as Group;
}

function featureOf(
  id: string,
  x: number,
  extra: Partial<Feature> & { layerId?: string } = {},
): Feature {
  const type = extra.type ?? 'Point';
  const geometry =
    type === 'Point'
      ? { type: 'Point' as const, coordinates: [x, x] }
      : {
          type: 'Polygon' as const,
          coordinates: [
            [
              [x, x],
              [x + 1, x],
              [x + 1, x + 1],
              [x, x + 1],
              [x, x],
            ],
          ],
        };
  return {
    id,
    type,
    geometry,
    layerId: 'l1',
    groupId: undefined,
    properties: {},
    style: {},
    visible: true,
    locked: false,
    ...extra,
  } as Feature;
}

/** The same document, built in a Store */
function fill(store: Store, table: boolean): void {
  store.createLayer(layerOf('l1', table));
  store.createLayer(layerOf('l2', table, { visible: false }));
  store.createGroup(groupOf('g', 'l1', table));
  store.createGroup(groupOf('hidden', 'l1', table, { visible: false }));
  store.createFeature(featureOf('a', 0));
  store.createFeature(featureOf('b', 2, { type: 'Polygon', locked: true }));
  store.createFeature(featureOf('c', 4, { groupId: 'g' }));
  store.createFeature(featureOf('d', 6, { groupId: 'hidden', type: 'Polygon' }));
  store.createFeature(featureOf('e', 8, { visible: false }));
  store.createFeature(featureOf('f', 10, { layerId: 'l2' }));
  store.createFeature(featureOf('h', 12, { groupId: 'g', type: 'Polygon' }));
}

let rows: Store;
let objects: Store;
let fromRows: FeaturesCollection;
let fromObjects: FeaturesCollection;

beforeEach(() => {
  rows = createTableStore().store;
  objects = new MemoryStore();
  fill(rows, true);
  fill(objects, false);
  fromRows = createFeatures(createResourceDeps(rows));
  fromObjects = createFeatures(createResourceDeps(objects));
});

/** Runs fn and returns the code of the DrawError it throws */
function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    if (error instanceof DrawError) return error.code;
    throw error;
  }
  return undefined;
}

/**
 * The ids the Store of objects lists for a filter, in the stacking order of the Store of rows
 * (the two place a feature created in a group differently)
 */
function expectedIds(filter: FeatureFilter | undefined): string[] {
  const listed = new Set(fromObjects.list(filter).map((feature) => feature.id));
  return [...featuresInOrder(rows)].map((feature) => feature.id).filter((id) => listed.has(id));
}

const FILTERS: Array<FeatureFilter | undefined> = [
  undefined,
  {},
  { layerId: 'l1' },
  { layerId: 'l2' },
  { layerId: 'none' },
  { groupId: 'g' },
  { groupId: 'none' },
  { type: 'Polygon' },
  { type: 'Point', layerId: 'l1' },
  { visible: false },
  { locked: true },
  { locked: false, type: 'Polygon' },
  { shown: true },
  { shown: false },
  { visible: true, shown: false },
  { bbox: [3.5, 3.5, 7.5, 7.5] },
  { bbox: [3.5, 3.5, 7.5, 7.5], type: 'Polygon' },
];

describe('features.list and features.count over a Store of rows', () => {
  it('refuses to list without a limit, and makes no feature to count', () => {
    expect(codeOf(() => fromRows.list())).toBe('invalidState');
    expect(codeOf(() => fromRows.list({ layerId: 'l1' }))).toBe('invalidState');
    expect(fromRows.count()).toBe(7);
  });

  it('lists and counts as a Store of objects holding the same features does, in stacking order', () => {
    expect([...featuresInOrder(rows)].map((feature) => feature.id)).toEqual([
      'a',
      'c',
      'h',
      'd',
      'b',
      'e',
      'f',
    ]);
    for (const filter of FILTERS) {
      const expected = expectedIds(filter);
      const page = fromRows.list(filter, { limit: 100 });
      expect(
        page.map((feature) => feature.id),
        JSON.stringify(filter),
      ).toEqual(expected);
      expect(fromRows.count(filter), JSON.stringify(filter)).toBe(expected.length);
      expect(fromObjects.count(filter)).toBe(expected.length);
    }
  });

  it('makes only the features within the limit, as an array', () => {
    const all = expectedIds(undefined);
    for (const limit of [0, 1, 3, all.length - 1, all.length, all.length + 1]) {
      const page = fromRows.list(undefined, { limit });
      expect(page.map((feature) => feature.id)).toEqual(all.slice(0, limit));
      expect(fromObjects.list(undefined, { limit })).toEqual(fromObjects.list().slice(0, limit));
    }
    const polygons = fromRows.list({ type: 'Polygon' }, { limit: 2 });
    expect(polygons.map((feature) => feature.id)).toEqual(['h', 'd']);
  });

  it('reads on after a feature read before, a page at a time, in both kinds of Store', () => {
    for (const filter of [undefined, ...FILTERS]) {
      for (const features of [fromRows, fromObjects]) {
        const expected =
          features === fromRows
            ? expectedIds(filter)
            : fromObjects.list(filter).map((feature) => feature.id);
        const read: string[] = [];
        let after: string | undefined;
        for (;;) {
          const page = features.list(filter, { limit: 2, ...(after !== undefined && { after }) });
          read.push(...page.map((feature) => feature.id));
          if (page.length < 2) break;
          after = page[page.length - 1].id;
        }
        expect(read, JSON.stringify(filter)).toEqual(expected);
      }
    }
    // After a feature the filter leaves out: from its place in the stacking order
    const rowsOrder = expectedIds(undefined);
    expect(fromRows.list({ type: 'Polygon' }, { limit: 10, after: 'c' }).map((f) => f.id)).toEqual(
      expectedIds({ type: 'Polygon' }).filter(
        (id) => rowsOrder.indexOf(id) > rowsOrder.indexOf('c'),
      ),
    );
    const objectsOrder = fromObjects.list().map((feature) => feature.id);
    expect(
      fromObjects.list({ type: 'Polygon' }, { limit: 10, after: 'c' }).map((f) => f.id),
    ).toEqual(
      fromObjects
        .list({ type: 'Polygon' })
        .map((f) => f.id)
        .filter((id) => objectsOrder.indexOf(id) > objectsOrder.indexOf('c')),
    );
  });

  it('reads each row once over the pages: a page reads on from the row it starts after', () => {
    const store = createTableStore().store;
    store.createLayer(layerOf('l1', true));
    store.createLayer(layerOf('l2', true));
    for (let i = 0; i < 60; i++) {
      store.createFeature(featureOf(`p${i}`, i, { layerId: i < 30 ? 'l1' : 'l2' }));
    }
    const features = createFeatures(createResourceDeps(store));
    const tables = store.tables;
    if (!tables) throw new Error('no tables');
    const scan = TablesStore.prototype.scan;
    // The first row each scan of the tables reads
    const firsts: string[] = [];
    const spy = vi.spyOn(TablesStore.prototype, 'scan').mockImplementation(function (
      this: TablesStore,
      options,
      after,
    ) {
      const cursor = scan.call(this, options, after);
      let first = true;
      return {
        next: () => {
          const batch = cursor.next();
          if (first && batch) firsts.push(tables.getRowId(batch[0]) as string);
          first = false;
          return batch;
        },
      };
    });
    const ids: string[] = [];
    let after: string | undefined;
    try {
      for (;;) {
        const page = features.list(undefined, { limit: 7, ...(after !== undefined && { after }) });
        ids.push(...page.map((feature) => feature.id));
        if (page.length < 7) break;
        after = page[page.length - 1].id;
      }
    } finally {
      spy.mockRestore();
    }
    expect(ids).toEqual(Array.from({ length: 60 }, (_, i) => `p${i}`));
    // Each page starts reading at its first row, in the layer of the row before it or the next
    expect(firsts).toEqual(Array.from({ length: 9 }, (_, i) => `p${i * 7}`));
  });

  describe('a page after a row, over two layers', () => {
    let store: Store;
    let features: FeaturesCollection;
    beforeEach(() => {
      store = createTableStore().store;
      store.createLayer(layerOf('l1', true));
      store.createLayer(layerOf('l2', true));
      store.createGroup(groupOf('g', 'l1', true));
      for (let i = 0; i < 40; i++) {
        store.createFeature(
          featureOf(`p${i}`, i, {
            layerId: i < 20 ? 'l1' : 'l2',
            ...(i < 20 && i % 3 === 0 && { groupId: 'g' }),
          }),
        );
      }
      features = createFeatures(createResourceDeps(store));
    });

    /** Every feature a filter lists, read a page of `limit` at a time */
    const pages = (filter: FeatureFilter, limit: number): string[] => {
      const ids: string[] = [];
      let after: string | undefined;
      for (;;) {
        const page = features.list(filter, { limit, ...(after !== undefined && { after }) });
        ids.push(...page.map((feature) => feature.id));
        if (page.length < limit) return ids;
        after = page[page.length - 1].id;
      }
    };

    it('reads the rows a box finds on into the next layer', () => {
      const filter: FeatureFilter = { bbox: [10.5, 10.5, 30.5, 30.5] };
      const all = features.list(filter, { limit: 100 }).map((feature) => feature.id);
      const inBox = new Set(Array.from({ length: 20 }, (_, i) => `p${i + 11}`));
      const order = [...featuresInOrder(store)].map((feature) => feature.id);
      expect(all).toEqual(order.filter((id) => inBox.has(id)));
      for (const limit of [1, 3, 4, 9]) expect(pages(filter, limit)).toEqual(all);
    });

    it('reads the members of a group a page at a time', () => {
      const all = features.list({ groupId: 'g' }, { limit: 100 }).map((feature) => feature.id);
      expect(all).toHaveLength(7);
      for (const limit of [1, 2, 3]) expect(pages({ groupId: 'g' }, limit)).toEqual(all);
    });

    it('reads on from the place of the row it starts after, when the row moved to another layer', () => {
      const before = [...featuresInOrder(store)].map((feature) => feature.id);
      const first = features.list(undefined, { limit: 10 }).map((feature) => feature.id);
      expect(first).toEqual(before.slice(0, 10));
      const last = first[9];
      store.updateFeature(last, { layerId: 'l2' });
      const order = [...featuresInOrder(store)].map((feature) => feature.id);
      expect(order.indexOf(last)).toBeGreaterThanOrEqual(20);
      const next = features.list(undefined, { limit: 100, after: last }).map((f) => f.id);
      expect(next).toEqual(order.slice(order.indexOf(last) + 1));
      // The rows of the first layer after its place before are not read
      expect(next).not.toContain(before[10]);
    });
  });

  it('throws notFound for a feature to read after that is not there', () => {
    expect(codeOf(() => fromRows.list(undefined, { limit: 2, after: 'nothing' }))).toBe('notFound');
    expect(codeOf(() => fromObjects.list(undefined, { limit: 2, after: 'nothing' }))).toBe(
      'notFound',
    );
    rows.deleteFeature('c');
    objects.deleteFeature('c');
    expect(codeOf(() => fromRows.list(undefined, { limit: 2, after: 'c' }))).toBe('notFound');
    expect(codeOf(() => fromObjects.list(undefined, { limit: 2, after: 'c' }))).toBe('notFound');
  });

  it('gives the features of the rows as the Store reads them', () => {
    const page = fromRows.list({ layerId: 'l1' }, { limit: 1 });
    expect(page[0]).toEqual(rows.getFeature('a'));
  });

  it('leaves out the deleted rows, and counts a row created after', () => {
    rows.deleteFeature('b');
    expect(fromRows.count()).toBe(6);
    expect(fromRows.list({ type: 'Polygon' }, { limit: 10 }).map((f) => f.id)).toEqual(['h', 'd']);
    rows.createFeature(featureOf('k', 14));
    expect(fromRows.count({ layerId: 'l1' })).toBe(6);
  });

  it('counts every feature, or the features of a layer or a group, without reading the rows, the deleted ones left out', () => {
    rows.deleteFeature('c');
    objects.deleteFeature('c');
    const tables = rows.tables as NonNullable<Store['tables']>;
    const scan = vi.spyOn(tables, 'scan');
    expect(fromRows.count()).toBe(fromObjects.count());
    expect(fromRows.count({})).toBe(fromObjects.count({}));
    expect(fromRows.count()).toBe(6);
    const filters: FeatureFilter[] = [
      { layerId: 'l1' },
      { layerId: 'l2' },
      { layerId: 'none' },
      { groupId: 'g' },
      { groupId: 'hidden' },
      { groupId: 'none' },
      { layerId: 'l1', groupId: 'g' },
      { layerId: 'l2', groupId: 'g' },
    ];
    for (const filter of filters) {
      expect(fromRows.count(filter)).toBe(fromObjects.count(filter));
    }
    expect(fromRows.count({ layerId: 'l1' })).toBe(5);
    expect(fromRows.count({ groupId: 'g' })).toBe(1);
    expect(scan).not.toHaveBeenCalled();
    // Another key of the filter reads the rows
    expect(fromRows.count({ layerId: 'l1', type: 'Polygon' })).toBe(
      fromObjects.count({ layerId: 'l1', type: 'Polygon' }),
    );
    expect(scan).toHaveBeenCalled();
  });

  it('checks the limit and the filter', () => {
    for (const limit of [-1, 1.5, Number.NaN, '3']) {
      expect(codeOf(() => fromRows.list(undefined, { limit } as never))).toBe('invalidInput');
      expect(codeOf(() => fromObjects.list(undefined, { limit } as never))).toBe('invalidInput');
    }
    expect(codeOf(() => fromRows.list(undefined, { limit: 1, other: 1 } as never))).toBe(
      'invalidInput',
    );
    expect(codeOf(() => fromRows.list(undefined, { limit: 1, after: 3 } as never))).toBe(
      'invalidInput',
    );
    expect(codeOf(() => fromObjects.list(undefined, { limit: 1, after: 3 } as never))).toBe(
      'invalidInput',
    );
    expect(codeOf(() => fromRows.count({ name: 'x' } as never))).toBe('invalidInput');
    expect(codeOf(() => fromRows.count({ shown: 'yes' } as never))).toBe('invalidInput');
    expect(codeOf(() => fromRows.count({ bbox: [0, 0, 1] } as never))).toBe('invalidInput');
  });
});

describe('the deletion of a layer held as rows', () => {
  it('is refused while the layer holds a locked row or a locked group, as for objects', () => {
    for (const store of [rows, objects]) {
      const layers = createLayers(createResourceDeps(store));
      store.createLayer(layerOf('l3', store === rows));
      // l1 holds the locked row b
      expect(layers.delete('l1')).toBe(false);
      store.updateFeature('b', { locked: false });
      store.updateGroup('g', { locked: true });
      expect(layers.delete('l1')).toBe(false);
      store.updateGroup('g', { locked: false });
      expect(layers.delete('l1')).toBe(true);
      expect(store.getLayer('l1')).toBeUndefined();
    }
  });
});

describe('the names generated over a Store of rows', () => {
  it('numbers after the largest number of the names of the rows, read without listing them', () => {
    rows.updateFeature('a', { properties: { name: 'Point 7' } });
    rows.updateFeature('c', { properties: { name: 'Point 3' } });
    rows.updateFeature('b', { properties: { name: 'Point 40' } });
    const names = new AutoNameGenerator(rows);
    expect(names.generateName('Point')).toBe('Point 8');
    expect(names.generateName('Polygon')).toBe('Polygon 1');
    names.dispose();
  });

  it('takes in the names of the rows of pages taken in, of the types of the rows', () => {
    const { store, writer } = createTableStore();
    store.createLayer(layerOf('blocks', true));
    const names = new AutoNameGenerator(store);
    expect(names.generateName('Point')).toBe('Point 1');
    expect(names.generateName('Polygon')).toBe('Polygon 1');
    const builder = createPageDataBuilder({ columns: FEATURE_TABLE_COLUMNS, targetRows: 64 });
    for (let i = 0; i < 300; i++) {
      const point = i % 3 !== 0;
      builder.addRow({
        id: `b${i}`,
        type: point ? 'Point' : 'Polygon',
        geometry: point
          ? { type: 'Point', coordinates: [i, 0] }
          : {
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
        key: `k${String(i).padStart(4, '0')}`,
        // A name of the other type, a name that is not a number, and no name at all are passed over
        properties:
          i === 120
            ? { name: 'Point 77' }
            : i === 150
              ? { name: 'Polygon 40' }
              : i === 151
                ? { name: 'Point 900' }
                : i === 200
                  ? { name: 'Point x' }
                  : {},
      });
    }
    writer.addPages('blocks', builder.finish());
    expect(names.generateName('Point')).toBe('Point 901');
    // Row 120 is a Polygon (120 % 3 === 0): its name 'Point 77' is not of its type
    expect(names.generateName('Polygon')).toBe('Polygon 41');
    names.dispose();
  });

  it('takes in the names of the rows created and renamed after the first number', () => {
    const names = new AutoNameGenerator(rows);
    expect(names.generateName('Point')).toBe('Point 1');
    rows.createFeature(featureOf('k', 14, { properties: { name: 'Point 20' } }));
    expect(names.generateName('Point')).toBe('Point 21');
    rows.updateFeature('a', { properties: { name: 'Point 30' } });
    expect(names.generateName('Point')).toBe('Point 31');
    names.dispose();
  });
});
