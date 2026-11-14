// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Every row taken out of the tables to come back (`FeatureTablesWriter.clear`: a version put back
 * and the document read again from the start)
 *
 * - The rows opened as features, the features shown in place and the features selected in bulk are
 *   let go of; it is told as a replacement of the document with the rows opened no longer
 * - The next versions and the work given to the Worker are dropped: what the Worker gives back
 *   afterwards is not taken in
 * - The ids keep their handles: the rows that come back get them again, the features selected are
 *   opened again when they are selected again, and the ids that do not come back are forgotten
 * - The groups of features and the dimensions of the layers stay
 */

import type { GroupEntry } from '@sakuzu/kasane';
import type { TableWorkBudget } from '@sakuzu/kasane/render';
import { describe, expect, it } from 'vitest';
import type { FeatureTablesWorker } from '../api/tables.js';
import { featureTablesInternals } from '../feature-table/feature-tables.js';
import { circleRowRings } from '../table/circle-rings.js';
import { FEATURE_TABLE_COLUMNS } from '../table/tabane/columns.js';
import { tablesBuilderOptionsOf } from '../table/tables-values.js';
import {
  featureRowBuilder as createPageBuilder,
  featureRowDataBuilder as createPageDataBuilder,
} from '../test-utils.js';
import { createTableStore } from './table-memory.js';
import type { Feature, Layer, RestoreToken, StoreChange } from './types.js';

const UNBOUNDED: TableWorkBudget = {
  canStep: () => true,
  step: (work) => work(Number.POSITIVE_INFINITY),
};

const layer = (id: string): Layer =>
  ({
    id,
    name: id,
    visible: true,
    locked: false,
    opacity: 1,
    styleRule: undefined,
    metadata: undefined,
    kind: 'table',
  }) as Layer;

const point = (id: string, x: number, layerId = 'a', z?: number): Feature => ({
  id,
  type: 'Point',
  geometry: { type: 'Point', coordinates: z === undefined ? [x, 0] : [x, 0, z] },
  layerId,
  groupId: undefined,
  properties: { n: x },
  style: {},
  visible: true,
  locked: false,
});

const key = (i: number): string => `k${String(i).padStart(6, '0')}`;

function setup(worker?: FeatureTablesWorker) {
  const { store, writer } = createTableStore({
    selectionIdsLimit: 3,
    ...(worker && { worker }),
    dimensionsOf: (id) => (id === 'z' ? 'xyz' : 'xy'),
  });
  store.transact(() => {
    store.createLayer(layer('a'));
    store.createLayer(layer('z'));
    for (let i = 0; i < 10; i++) store.createFeature(point(`a${i}`, i));
    store.createFeature(point('high', 0, 'z', 40));
  });
  store.createGroup({
    id: 'g',
    name: 'g',
    layerId: 'a',
    visible: true,
    locked: false,
    featureIds: ['a3', 'a4'],
  } as never);
  const tables = store.tables;
  const internals = featureTablesInternals(tables);
  if (!tables || !internals) throw new Error('a Store of rows has tables');
  internals.flushVersions();
  const notified: StoreChange[] = [];
  store.subscribe((change) => notified.push(change));
  return { store, writer, tables, internals, notified };
}

/** The rows of layer `a` built again, as a Worker builds them from the records that come back */
function rowsBack(
  setupOf: ReturnType<typeof setup>,
  ids: readonly string[],
): ReturnType<ReturnType<typeof createPageBuilder>['finish']> {
  const { tables } = setupOf;
  const group = tables.getGroupRef('g') as number;
  const groups: GroupEntry[] = [
    { group: group, id: 'g', key: tables.getGroupKey(group) as string },
  ];
  const builder = createPageBuilder({ columns: FEATURE_TABLE_COLUMNS, groups, targetRows: 4 });
  ids.forEach((id) => {
    const i = Number(id.slice(1));
    const inGroup = id === 'a3' || id === 'a4';
    builder.addRow({
      id,
      type: 'Point',
      geometry: { type: 'Point', coordinates: [i, 0] },
      key: inGroup ? (tables.getGroupKey(group) as string) : key(i * 10),
      ...(inGroup && { group, member: key(i) }),
      properties: { n: i * 100 },
    });
  });
  return builder.finish();
}

describe('every row taken out of the tables', () => {
  it('lets go of the rows, told as a replacement of the document', () => {
    const s = setup();
    const { store, writer, tables, notified } = s;
    const a1 = tables.getRowRef('a1') as number;
    store.setSelection('feature', ['a1']);
    notified.length = 0;
    writer.clear();
    expect(tables.getRowRef('a1')).toBeUndefined();
    expect(tables.get('a')).toBeUndefined();
    expect(store.getFeature('a1')).toBeUndefined();
    const change = notified[notified.length - 1];
    expect(change.reset).toBe(true);
    // The id keeps its reference, its row gone
    expect(writer.lookup('a1')).toEqual({ row: a1, deleted: true });
    // The features selected stay selected, the groups and the layers stay
    expect(store.getSelection().ids).toEqual(['a1']);
    expect(store.getGroup('g')).toBeDefined();
    expect(store.getLayer('a')).toBeDefined();
  });

  it('gives the rows that come back their handles again, the selected read again', () => {
    const s = setup();
    const { store, writer, tables, internals } = s;
    const handles = new Map(
      Array.from({ length: 10 }, (_, i) => [`a${i}`, tables.getRowRef(`a${i}`) as number]),
    );
    store.setSelection('feature', ['a1']);
    writer.clear();
    // Every row but a5 comes back, with new values
    const ids = Array.from({ length: 10 }, (_, i) => `a${i}`).filter((id) => id !== 'a5');
    store.transact(() => writer.addPages('a', rowsBack(s, ids)), 'remote');
    internals.flushVersions();
    for (const id of ids) expect(tables.getRowRef(id)).toBe(handles.get(id));
    expect(store.getFeature('a2')?.properties).toEqual({ n: 200 });
    expect(store.getFeature('a3')?.groupId).toBe('g');
    // The feature selected is read from its row again
    expect(store.getSelection().ids).toEqual(['a1']);
    expect(store.getFeature('a1')?.properties).toEqual({ n: 100 });
    // The id that did not come back is forgotten by the Store
    writer.forget(Int32Array.of(handles.get('a5') as number));
    expect(writer.lookup('a5')).toBeUndefined();
  });

  it('lets go of the features selected in bulk and the rows the deletions kept', () => {
    const s = setup();
    const { store, writer, tables, internals, notified } = s;
    store.deleteFeature('a9');
    const token = notified[notified.length - 1].restoreToken as RestoreToken;
    expect(token).toBeDefined();
    store.setSelection('feature', ['a0', 'a1', 'a2', 'a6', 'a7']);
    expect(store.getSelection().bulk?.count).toBe(5);
    writer.clear();
    expect(store.getSelection().bulk).toBeUndefined();
    expect(store.getSelection().ids).toEqual([]);
    expect(internals.states.bulkHandles().size).toBe(0);
    // The token keeps nothing any more
    expect(() => tables.release(token)).not.toThrow();
  });

  it('drops the work given to the Worker: what it gives back is not taken in', async () => {
    let release: (() => void) | null = null;
    const worker: FeatureTablesWorker = {
      merge: () => Promise.reject(new Error('no merge')),
      build: (rows, options) =>
        new Promise((resolve) => {
          release = () => {
            const builder = createPageDataBuilder({
              columns: FEATURE_TABLE_COLUMNS,
              ...tablesBuilderOptionsOf(options),
              rings: circleRowRings,
            });
            for (const row of rows) builder.addRow(structuredClone(row));
            resolve(builder.finish());
          };
        }),
    };
    const s = setup(worker);
    const { store, writer, tables, internals } = s;
    // A run of new rows after every row of the layer: built into blocks of their own, in the Worker
    const ids = Array.from({ length: 300 }, (_, i) => `r${i}`);
    const encoder = new TextEncoder();
    const parts = ids.map((id) => encoder.encode(id));
    const offsets = new Int32Array(ids.length + 1);
    parts.forEach((part, i) => {
      offsets[i + 1] = offsets[i] + part.length;
    });
    const bytes = new Uint8Array(offsets[ids.length]);
    parts.forEach((part, i) => {
      bytes.set(part, offsets[i]);
    });
    store.transact(() => {
      writer.writeRows({
        rows: writer.allocateRowRefs({ offsets, bytes }),
        fields: new Map<never, unknown[]>([
          ['type' as never, ids.map(() => 'Point')],
          ['parent' as never, ids.map(() => 'a')],
          ['geometry' as never, ids.map((_, i) => ({ type: 'Point', coordinates: [100 + i, 0] }))],
          ['key' as never, ids.map((_, i) => `zz${String(i).padStart(4, '0')}`)],
        ]),
      });
    }, 'remote');
    expect(internals.deltaRowCount()).toBe(0);
    for (let i = 0; i < 6; i++) internals.rebuild(UNBOUNDED);
    expect(release).not.toBeNull();
    writer.clear();
    (release as unknown as () => void)();
    await Promise.resolve();
    await Promise.resolve();
    internals.advanceQueuedBlocks(UNBOUNDED);
    internals.flushVersions();
    expect(tables.getRowRef('r10')).toBeUndefined();
    expect(tables.get('a')).toBeUndefined();
    expect(internals.hasPendingWork).toBe(false);
  });

  it('keeps the dimensions of the coordinates of a layer for the rows that come back', () => {
    const { store, writer, tables, internals } = setup();
    writer.clear();
    expect(internals.readContext.dimensionsOf('z')).toBe('xyz');
    const builder = createPageBuilder({ columns: FEATURE_TABLE_COLUMNS, dimensions: 'xyz' });
    builder.addRow({
      id: 'high',
      type: 'Point',
      geometry: { type: 'Point', coordinates: [1, 2, 30] },
      key: key(1),
    });
    store.transact(() => writer.addPages('z', builder.finish()), 'remote');
    internals.flushVersions();
    expect(
      tables
        .readValues({
          rows: Int32Array.of(tables.getRowRef('high') as number),
          fields: new Map([['geometry', []]]),
        })
        .fields.get('geometry'),
    ).toEqual([{ type: 'Point', coordinates: [1, 2, 30] }]);
  });
});
