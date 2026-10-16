// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The copy of a document held as rows into a new Store of rows (`copyTableStore`; 13.7 of the
 * design of the tables: a print and a thumbnail read the document into a Store of rows with
 * `addRowBlocks`, without making its features)
 *
 * - The layers, the groups at their places, the stacking order with its entries from outside the
 *   document, the metadata and the files are copied at once
 * - The rows a block at a time, in their order, as they are read (a value written in place
 *   included), without the deleted rows, in the groups they are in, with the dimensions of their
 *   layer
 * - No feature is made of the rows
 */

import { describe, expect, it } from 'vitest';
import { DrawError } from '../api/errors.js';
import { featureTablesInternals } from '../feature-table/feature-tables.js';
import { MemoryStore } from './memory.js';
import type { Store } from './store.js';
import { copyTableStore } from './table-copy.js';
import { createTableStore } from './table-memory.js';
import type { Feature, Layer } from './types.js';

const layer = (id: string): Layer =>
  ({
    id,
    name: `Layer ${id}`,
    visible: true,
    locked: false,
    opacity: 0.5,
    styleRule: undefined,
    metadata: { note: id },
    kind: 'table',
  }) as Layer;

function square(id: string, x: number, layerId: string, extra: Partial<Feature> = {}): Feature {
  return {
    id,
    type: 'Polygon',
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          [x, 0],
          [x + 1, 0],
          [x + 1, 1],
          [x, 1],
          [x, 0],
        ],
      ],
    },
    layerId,
    groupId: undefined,
    properties: { n: x, name: `${id}` },
    style: { fillColor: x % 2 === 0 ? '#ff0000' : '#00ff00' },
    visible: x !== 3,
    locked: false,
    ...extra,
  };
}

/** The rows of a layer of a Store, in their order, as features */
function rowsOf(store: Store, layerId: string): Feature[] {
  const tables = store.tables;
  const view = tables?.get(layerId);
  if (!tables || !view) return [];
  return Array.from(view.listRowHandles(0, view.rowCountWithDeleted))
    .filter((handle) => tables.findRow(tables.getRowId(handle) as string) !== undefined)
    .map((handle) => view.getRow(handle) as Feature);
}

function source() {
  const { store, writer } = createTableStore();
  store.transact(() => {
    store.createLayer(layer('a'));
    store.createLayer(layer('b'));
    store.setLayerOrder(['b', 'dataset-1', 'a']);
    for (let i = 0; i < 12; i++) store.createFeature(square(`a${i}`, i, 'a'));
    for (let i = 0; i < 3; i++) store.createFeature(square(`b${i}`, i * 3, 'b'));
    store.setMetadata({ title: 'A map', description: 'Of squares' });
  });
  // A group of three features of the layer a
  store.createGroup({
    id: 'g',
    name: 'Group',
    layerId: 'a',
    visible: true,
    locked: false,
    featureIds: ['a4', 'a5', 'a6'],
  } as never);
  // A row written in place and a row deleted
  store.updateFeature('a2', { properties: { n: 200, name: 'written' } });
  store.deleteFeature('a7');
  return { store, writer };
}

describe('the copy of a document held as rows', () => {
  it('copies the layers, the groups, the order, the metadata and the rows as they are', () => {
    const { store } = source();
    const copy = copyTableStore(store, { blockRows: 4 });
    // The layers, the order and the metadata at once
    expect(copy.store.getLayerOrder()).toEqual(['b', 'dataset-1', 'a']);
    expect(copy.store.getLayer('a')).toEqual(store.getLayer('a'));
    expect(copy.store.getMetadata()).toEqual(store.getMetadata());
    expect(copy.store.getGroup('g')).toEqual(store.getGroup('g'));
    // The rows a block at a time
    let steps = 0;
    while (copy.copyNext()) steps++;
    expect(steps).toBeGreaterThan(2);
    featureTablesInternals(copy.store.tables)?.flushVersions();
    for (const id of ['a', 'b']) expect(rowsOf(copy.store, id)).toEqual(rowsOf(store, id));
    expect(copy.store.getFeature('a2')?.properties).toEqual({ n: 200, name: 'written' });
    expect(copy.store.getFeature('a7')).toBeUndefined();
    expect(copy.store.getFeature('a5')?.groupId).toBe('g');
    // The items of the layer: the group at its place
    const items = (s: Store) => {
      const view = s.tables?.get('a');
      const handles = view?.listItems(0, view.itemCount);
      return Array.from(handles?.handles ?? [], (h, i) =>
        handles?.kinds[i] === 1 ? s.tables?.getGroupId(h) : s.tables?.getRowId(h),
      );
    };
    expect(items(copy.store)).toEqual(items(store));
  });

  it('makes no feature of the rows', () => {
    const { store } = source();
    const copy = copyTableStore(store);
    while (copy.copyNext());
    featureTablesInternals(copy.store.tables)?.flushVersions();
    expect(featureTablesInternals(copy.store.tables)?.heldCount).toBe(0);
    expect(() => copy.store.listFeatures()).toThrow();
  });

  it('keeps the dimensions of the coordinates of a layer', () => {
    const { store, writer } = createTableStore({
      dimensionsOf: (id) => (id === 'z' ? 'xyz' : 'xy'),
    });
    store.createLayer(layer('z'));
    store.createFeature({
      ...square('high', 0, 'z'),
      geometry: { type: 'Point', coordinates: [1, 2, 30] },
      type: 'Point',
    });
    const copy = copyTableStore(store);
    while (copy.copyNext());
    featureTablesInternals(copy.store.tables)?.flushVersions();
    const read = (s: Store) =>
      s.tables
        ?.readValues({
          handles: Int32Array.of(s.tables?.findRow('high') ?? -1),
          fields: new Map([['geometry', []]]),
        })
        .fields.get('geometry');
    expect(read(copy.store)).toEqual(read(store));
    expect(read(copy.store)).toEqual([{ type: 'Point', coordinates: [1, 2, 30] }]);
    expect(writer).toBeDefined();
  });

  it('refuses a Store that does not hold its features as rows', () => {
    expect(() => copyTableStore(new MemoryStore())).toThrow(DrawError);
  });
});
