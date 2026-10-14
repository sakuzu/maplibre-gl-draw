// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What reads every feature of a Store of rows without listing them: `features.list` up to a
 * limit, `features.count`, the lock checked when a layer is deleted, and the numbers of the
 * names generated (10.1 and 10.2 of the design). Each answer is compared with the one of an
 * in-memory Store of objects holding the same features.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { AutoNameGenerator } from '../../shared/utils/name-generator.js';
import { featuresInOrder } from '../../store/feature-stream.js';
import { MemoryStore } from '../../store/memory.js';
import type { Store } from '../../store/store.js';
import { createTableStore } from '../../store/table-memory.js';
import type { Feature, Group, Layer } from '../../store/types.js';
import { createResourceDeps } from '../../test-utils.js';
import { DrawError } from '../errors.js';
import type { FeaturesCollection } from '../features.js';
import type { FeatureFilter } from '../model.js';
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
    expect(codeOf(() => fromRows.list())).toBe('invalid-state');
    expect(codeOf(() => fromRows.list({ layerId: 'l1' }))).toBe('invalid-state');
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

  it('throws not-found for a feature to read after that is not there', () => {
    expect(codeOf(() => fromRows.list(undefined, { limit: 2, after: 'nothing' }))).toBe(
      'not-found',
    );
    expect(codeOf(() => fromObjects.list(undefined, { limit: 2, after: 'nothing' }))).toBe(
      'not-found',
    );
    rows.deleteFeature('c');
    objects.deleteFeature('c');
    expect(codeOf(() => fromRows.list(undefined, { limit: 2, after: 'c' }))).toBe('not-found');
    expect(codeOf(() => fromObjects.list(undefined, { limit: 2, after: 'c' }))).toBe('not-found');
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

  it('checks the limit and the filter', () => {
    for (const limit of [-1, 1.5, Number.NaN, '3']) {
      expect(codeOf(() => fromRows.list(undefined, { limit } as never))).toBe('invalid-input');
      expect(codeOf(() => fromObjects.list(undefined, { limit } as never))).toBe('invalid-input');
    }
    expect(codeOf(() => fromRows.list(undefined, { limit: 1, other: 1 } as never))).toBe(
      'invalid-input',
    );
    expect(codeOf(() => fromRows.list(undefined, { limit: 1, after: 3 } as never))).toBe(
      'invalid-input',
    );
    expect(codeOf(() => fromObjects.list(undefined, { limit: 1, after: 3 } as never))).toBe(
      'invalid-input',
    );
    expect(codeOf(() => fromRows.count({ name: 'x' } as never))).toBe('invalid-input');
    expect(codeOf(() => fromRows.count({ shown: 'yes' } as never))).toBe('invalid-input');
    expect(codeOf(() => fromRows.count({ bbox: [0, 0, 1] } as never))).toBe('invalid-input');
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
