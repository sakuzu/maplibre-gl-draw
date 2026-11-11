// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The places a Store of rows puts rows and groups in, and the writes it refuses before anything
 * is written
 *
 * - A group moved to a layer whose rows have fewer dimensions than its members is refused, and the
 *   group, its members and the tables stay as they were
 * - The parent of a row written from elsewhere is a layer of the Store or a group: any other id is
 *   refused (`not-found`), and no table of that id is made
 * - A layer and a group are named in one space: a layer whose id is a group's, or a group whose id
 *   is a layer's, is refused, in the Store of rows and in the Store of objects
 */

import { utf8ColumnFromStrings } from '@sakuzu/tabane';
import { describe, expect, it } from 'vitest';
import { createFeatureTables } from '../api/tables.js';
import { featureTablesInternals } from '../feature-table/feature-tables.js';
import { rowPatch } from '../test-utils.js';
import { MemoryContractStore } from './memory.js';
import { createTableStore } from './table-memory.js';
import type { Feature, Group, Layer } from './types.js';

/** A layer held as rows, or a layer of objects (`objects`) */
const layer = (id: string, objects = false): Layer =>
  ({
    id,
    name: id,
    visible: true,
    locked: false,
    opacity: 1,
    ...(objects ? { items: [] } : { kind: 'table' }),
    metadata: undefined,
    styleRule: undefined,
  }) as Layer;

const point = (id: string, layerId: string, coordinates: number[]): Feature => ({
  id,
  type: 'Point',
  geometry: { type: 'Point', coordinates },
  layerId,
  groupId: undefined,
  properties: {},
  style: {},
  visible: true,
  locked: false,
});

const group = (id: string, layerId: string, featureIds: string[] = []): Group =>
  ({ id, layerId, name: id, featureIds, visible: true, locked: false }) as Group;

describe('a group moved to a layer of fewer dimensions', () => {
  it('is refused before anything is written', () => {
    const { store, writer } = createTableStore({
      dimensionsOf: (id) => (id === 'z' ? 'xyz' : 'xy'),
    });
    store.createLayer(layer('z'));
    store.createLayer(layer('a'));
    store.createGroup(group('g', 'z'));
    const [h] = writer.allocateHandles(utf8ColumnFromStrings(['f']));
    store.transact(
      () =>
        writer.writeRows(
          rowPatch([h as number], {
            type: ['Point'],
            geometry: [{ type: 'Point', coordinates: [1, 2, 3] }],
            parent: ['g'],
            key: ['k'],
          }),
        ),
      'remote',
    );
    const tables = store.tables;
    if (!tables) throw new Error('a Store of rows has tables');
    const handle = tables.findGroup('g') as number;
    expect(() => store.moveItems?.(['g'], { layerId: 'a', below: null })).toThrow(
      /coordinates of xyz/,
    );
    expect(store.getGroup('g')?.layerId).toBe('z');
    expect(featureTablesInternals(tables)?.groups.tableOf(handle)).toBe('z');
    expect(tables.get('z')?.countGroupMembers(handle)).toBe(1);
    expect(tables.get('a')).toBeUndefined();
  });
});

describe('the parent of a row written from elsewhere', () => {
  it('is a layer of the Store or a group, and nothing else', () => {
    const { store, writer } = createTableStore();
    store.createLayer(layer('a'));
    store.createLayer(layer('b'));
    store.createFeature(point('f', 'a', [1, 2]));
    store.createGroup(group('g', 'b'));
    const tables = store.tables;
    if (!tables) throw new Error('a Store of rows has tables');
    const h = tables.getRowRef('f') as number;
    const write = (parent: string) =>
      store.transact(() => writer.writeRows(rowPatch([h], { parent: [parent] })), 'remote');
    expect(() => write('nogroup')).toThrow(expect.objectContaining({ code: 'not-found' }));
    expect(store.getFeature('f')?.layerId).toBe('a');
    expect(tables.get('nogroup')).toBeUndefined();
    write('g');
    expect(store.getFeature('f')).toMatchObject({ layerId: 'b', groupId: 'g' });
    write('a');
    expect(store.getFeature('f')).toMatchObject({ layerId: 'a' });
    expect(store.getFeature('f')?.groupId).toBeUndefined();
  });

  it('may name a new table when the tables have no Store', () => {
    const { tables, writer } = createFeatureTables();
    const [h] = writer.allocateHandles(utf8ColumnFromStrings(['r']));
    writer.writeRows(
      rowPatch([h as number], {
        type: ['Point'],
        geometry: [{ type: 'Point', coordinates: [1, 2] }],
        parent: ['anything'],
        key: ['V'],
      }),
    );
    expect(tables.get('anything')?.rowCount).toBe(1);
  });
});

describe('a layer and a group', () => {
  it('are named in one space in the Store of rows', () => {
    const { store } = createTableStore();
    store.createLayer(layer('a'));
    store.createLayer(layer('x'));
    expect(() => store.createGroup(group('x', 'a'))).toThrow(/already exists/);
    expect(() => store.createGroups?.([group('x', 'a')])).toThrow(/already exists/);
    store.createGroup(group('g', 'a'));
    expect(() => store.createLayer(layer('g'))).toThrow(/already exists/);
    expect(store.getGroup('x')).toBeUndefined();
    expect(store.getLayer('g')).toBeUndefined();
  });

  it('are named in one space in the Store of objects', () => {
    const store = new MemoryContractStore();
    store.createLayer(layer('a', true));
    store.createLayer(layer('x', true));
    expect(() => store.createGroup(group('x', 'a'))).toThrow(/already exists/);
    store.createGroup(group('g', 'a'));
    expect(() => store.createLayer(layer('g', true))).toThrow(/already exists/);
    expect(store.getGroup('x')).toBeUndefined();
    expect(store.getLayer('g')).toBeUndefined();
  });
});
