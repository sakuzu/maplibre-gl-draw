// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Many creations and deletions from elsewhere in one commit (`writeOperations`): written with a
 * few writes of the Store, not one each (thousands of groups each with a member, thousands of
 * features), and giving the document of the storage read by the rules (`applyOperations`,
 * `kept.ts`), what is kept aside included
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryStore } from '../../store/memory.js';
import type { Store } from '../../store/store.js';
import { createTableStore, tablesWriterOf } from '../../store/table-memory.js';
import { storedOf, writtenOf } from '../../test-support/random-commits.js';
import { createMapStub } from '../../test-utils.js';
import { createDraw, type Draw } from '../draw.js';
import { CommitValues } from './commit-values.js';
import { readStoredDocument } from './kept.js';
import { writeOperations } from './store-writes.js';
import {
  applyOperations,
  createStoredDocument,
  type FeatureRecord,
  type StoredDocument,
  type ValueOperation,
} from './values.js';

const LAYER = 'maplibre-gl-draw:layerId';
const GROUP = 'maplibre-gl-draw:groupId';

const draws: Draw[] = [];

afterEach(() => {
  for (const d of draws.splice(0)) d.destroy();
});

const KINDS: ReadonlyArray<readonly [string, () => Store]> = [
  ['objects', () => new MemoryStore()],
  ['rows', () => createTableStore().store],
];

function layer(id: string, key: string): ValueOperation {
  return {
    type: 'create',
    kind: 'layer',
    id,
    record: { name: id, visible: true, locked: false, opacity: 1, style: {}, styleRule: null, key },
  };
}

function group(id: string, layerId: string, key: string): ValueOperation {
  return {
    type: 'create',
    kind: 'group',
    id,
    record: { name: id, layerId, parentId: null, visible: true, locked: false, key },
  };
}

function feature(id: string, layerId: string, groupId: string | undefined, key: string) {
  const record: FeatureRecord = {
    geometry: { type: 'Point', coordinates: [1, 2] },
    properties: { [LAYER]: layerId, ...(groupId !== undefined && { [GROUP]: groupId }) },
    key,
  };
  return { type: 'create', kind: 'feature', id, record } satisfies ValueOperation;
}

/** A key of the order of a number, the order of the numbers */
function keyOf(i: number): string {
  return `V${String(i).padStart(5, '0')}`;
}

function sorted<T>(map: ReadonlyMap<string, T>): Array<[string, T]> {
  return [...map].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/** A Store from elsewhere, and the storage it follows */
function setUp(makeStore: () => Store) {
  const store = makeStore();
  const d = createDraw(createMapStub().map, { store, initDefaultLayer: false });
  draws.push(d);
  const values = new CommitValues(store);
  store.subscribe((changes) => {
    const reading = values.readChange(changes, Number.POSITIVE_INFINITY, false);
    if (!reading) return;
    reading.step(Number.POSITIVE_INFINITY);
    reading.release();
  });
  const storage: StoredDocument = createStoredDocument();
  const write = (operations: readonly ValueOperation[]) => {
    applyOperations(storage, operations);
    const { failed } = store.transact(() => writeOperations(store, values, operations), 'remote');
    expect(failed).toEqual([]);
  };
  const same = () => {
    const read = readStoredDocument(storage);
    expect(writtenOf(d.document.toJSON())).toEqual(storedOf(read.shown));
    expect({
      features: sorted(values.kept.features),
      groups: sorted(values.kept.groups),
      placements: sorted(values.kept.placements),
    }).toEqual({
      features: sorted(read.kept.features),
      groups: sorted(read.kept.groups),
      placements: sorted(read.kept.placements),
    });
  };
  return { store, write, same };
}

describe('many creations and deletions from elsewhere in one commit', () => {
  for (const [kind, makeStore] of KINDS) {
    it(`give the document of the storage, what is kept aside included (${kind})`, () => {
      const { write, same } = setUp(makeStore);
      write([layer('a', 'V'), layer('b', 'W'), layer('c', 'X')]);
      // Features of a layer then deleted, which name groups made later: kept, then shown in them
      write(Array.from({ length: 50 }, (_, i) => feature(`k${i}`, 'c', `g${i * 7}`, keyOf(i))));
      write([{ type: 'delete', kind: 'layer', ids: ['c'] }]);
      same();
      const run: ValueOperation[] = [];
      for (let i = 0; i < 1500; i++) {
        // Some members come before their group, some groups with no member
        if (i % 5 === 0) run.push(feature(`m${i}`, 'b', `g${i}`, 'V'));
        run.push(group(`g${i}`, 'b', keyOf(1500 - i)));
        if (i % 5 !== 0 && i % 9 !== 0) run.push(feature(`m${i}`, 'b', `g${i}`, keyOf(i)));
        // A second member, in another layer by its key
        if (i % 11 === 0) run.push(feature(`n${i}`, 'a', `g${i}`, keyOf(i)));
        // Features of a layer, among the groups of another, and one of a layer not there
        if (i % 3 === 0) run.push(feature(`f${i}`, i % 2 === 0 ? 'a' : 'b', undefined, keyOf(i)));
        if (i % 500 === 0) run.push(feature(`z${i}`, 'gone', undefined, keyOf(i)));
      }
      // One made twice: the first stays
      run.push(feature('f0', 'b', undefined, keyOf(9)));
      write(run);
      same();
      // A feature into a group shown, and one into a group kept with no member
      write([feature('p1', 'b', 'g1', keyOf(3)), feature('p2', 'b', 'g9', keyOf(4))]);
      same();
      // The groups deleted in one operation: their members stay in their own layers, at their keys
      const groups = Array.from({ length: 1500 }, (_, i) => `g${1499 - i}`).filter(
        (id) => id !== 'g700',
      );
      write([{ type: 'delete', kind: 'group', ids: [...groups, 'nothing'] }]);
      same();
      // The features deleted in one operation, some kept and some not there
      const features = Array.from({ length: 1500 }, (_, i) => `m${i}`).concat('k7', 'z0', 'none');
      write([{ type: 'delete', kind: 'feature', ids: features }]);
      same();
      // Created again in one run (the rows deleted are made again)
      write(Array.from({ length: 300 }, (_, i) => feature(`m${i}`, 'a', undefined, keyOf(i))));
      same();
    });

    it(`are written with a few writes of the Store (${kind})`, () => {
      const { store, write, same } = setUp(makeStore);
      write([layer('a', 'V'), layer('b', 'W')]);
      write(Array.from({ length: 200 }, (_, i) => feature(`e${i}`, 'b', undefined, keyOf(i * 20))));
      const rows = tablesWriterOf(store);
      const objects = rows ? null : (store as unknown as { moveItems: Store['moveItems'] });
      const writes = rows ? vi.spyOn(rows, 'writeRows') : vi.spyOn(objects as Store, 'moveItems');
      const run: ValueOperation[] = [];
      for (let i = 0; i < 2000; i++) {
        run.push(group(`g${i}`, 'b', keyOf(i * 2 + 1)));
        run.push(feature(`m${i}`, 'b', `g${i}`, keyOf(i)));
        run.push(feature(`f${i}`, 'a', undefined, keyOf(i)));
      }
      write(run);
      // Rows: the rows created in each layer, then their places; objects: the groups and the
      // features put in their layers, a run between two items there at a time (the 200 there are
      // among the groups)
      expect(writes.mock.calls.length).toBeLessThanOrEqual(rows ? 3 : 205);
      same();
      writes.mockClear();
      write([
        { type: 'delete', kind: 'group', ids: Array.from({ length: 2000 }, (_, i) => `g${i}`) },
      ]);
      expect(writes.mock.calls.length).toBeLessThanOrEqual(rows ? 2 : 205);
      same();
      writes.mockClear();
      write([
        { type: 'delete', kind: 'feature', ids: Array.from({ length: 2000 }, (_, i) => `m${i}`) },
      ]);
      expect(writes.mock.calls.length).toBeLessThanOrEqual(rows ? 1 : 0);
      same();
    });
  }
});
