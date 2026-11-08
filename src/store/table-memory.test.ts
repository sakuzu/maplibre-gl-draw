// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The in-memory Store of rows (`createTableStore`)
 *
 * - Its layers and groups are held as rows; its features are rows, read from its tables, and a
 *   row is a feature while it is held (selected, edited)
 * - A write of a feature not held writes its row and is notified as a change of the row; one of a
 *   feature held is notified as a change of the feature. A row is in a notification once, as it
 *   is when the transaction ends: a row created and selected in one transaction is a feature
 *   created
 * - The selection, the editing and the vertices selected hold their rows, and let go of them a
 *   moment later; more than the limit is refused
 * - A row held deleted from elsewhere leaves the selection, in `features.deleted`, never in
 *   `held.removed`
 * - The values in the middle of a drag are shown; the values written from elsewhere meanwhile
 *   are kept for when it ends, and an undone drag shows them
 */

import { utf8String } from '@sakuzu/tabane';
import { describe, expect, it, vi } from 'vitest';
import type { RowField } from '../api/tables.js';
import { featureTablesInternals } from '../feature-table/feature-tables.js';
import { circleRowRings } from '../shared/circle-rings.js';
import { createRowBlockDataBuilder } from '../table/row-group-builder.js';
import { SELECTION_IDS_LIMIT } from './draw-store.js';
import { insertGroup } from './item-lists.js';
import type { Store } from './store.js';
import { createTableStore } from './table-memory.js';
import type { Feature, RowValues, StoreChange } from './types.js';

/** A point of the tests */
function point(id: string, x: number, extra: Partial<Feature> = {}): Feature {
  return {
    id,
    type: 'Point',
    geometry: { type: 'Point', coordinates: [x, 0] },
    layerId: 'layer',
    groupId: undefined,
    properties: { n: x },
    style: {},
    visible: true,
    locked: false,
    ...extra,
  };
}

/** A Store of rows with a layer and points in it, and its notifications gathered */
function setup(count = 5) {
  const { store, writer } = createTableStore();
  store.createLayer({
    id: 'layer',
    name: 'Layer',
    visible: true,
    locked: false,
    opacity: 1,
    items: [],
    metadata: undefined,
    styleRule: undefined,
  });
  for (let i = 0; i < count; i++) store.createFeature(point(`p${i}`, i));
  const notified: StoreChange[] = [];
  store.subscribe((change) => notified.push(change));
  const tables = store.tables;
  if (!tables) throw new Error('a Store of rows has tables');
  return { store, writer, tables, notified };
}

describe('the in-memory Store of rows', () => {
  it('holds its layers as rows, and reads its features from the rows', () => {
    const { store, tables } = setup();
    expect(store.getLayer('layer')?.kind).toBe('table');
    expect(store.getLayer('layer')).not.toHaveProperty('items');
    expect(store.getFeature('p2')?.geometry).toEqual({ type: 'Point', coordinates: [2, 0] });
    // A row not held is made a feature once until it is written (feature-cache.ts)
    const read = store.getFeature('p2');
    expect(store.getFeature('p2')).toBe(read);
    store.updateFeature('p2', { properties: { n: 20 } });
    expect(store.getFeature('p2')).not.toBe(read);
    expect(() => store.listFeatures()).toThrow();
    expect(() => store.listFeaturesInOrder()).toThrow();
    const view = tables.get('layer');
    const order = Array.from(view?.listRowHandles(0, 10) ?? [], (h) => tables.getRowId(h));
    expect(order).toEqual(['p0', 'p1', 'p2', 'p3', 'p4']);
  });

  it('notifies the writes of rows not held as changes of rows', () => {
    const { store, tables, notified } = setup();
    store.updateFeature('p1', { properties: { n: 10 } });
    store.deleteFeature('p2');
    expect(notified).toHaveLength(2);
    const handle = (id: string) => tables.findRow(id) ?? -1;
    expect(notified[0].features).toBeUndefined();
    expect(Array.from(notified[0].rows?.layers.get('layer')?.updated ?? [])).toEqual([
      handle('p1'),
    ]);
    expect(notified[1].rows?.layers.get('layer')?.deleted.length).toBe(1);
    expect(store.getFeature('p1')?.properties).toEqual({ n: 10 });
    expect(store.getFeature('p2')).toBeUndefined();
  });

  it('notifies the writes of the rows selected as changes of rows, the features read again', () => {
    const { store, tables, notified } = setup();
    store.setSelection('feature', ['p1', 'p3']);
    expect(notified[notified.length - 1]?.features).toBeUndefined();
    const p1 = store.getFeature('p1');
    expect(store.getFeature('p1')).toBe(p1);
    notified.length = 0;
    store.updateFeature('p1', { geometry: { type: 'Point', coordinates: [9, 9] } });
    expect(notified).toHaveLength(1);
    expect(notified[0].features).toBeUndefined();
    expect(Array.from(notified[0].rows?.layers.get('layer')?.updated ?? [])).toEqual([
      tables.findRow('p1'),
    ]);
    expect((notified[0].previousValues as RowValues | undefined)?.fields.get('geometry')).toEqual([
      p1?.geometry,
    ]);
    const after = store.getFeature('p1');
    expect(after).not.toBe(p1);
    expect(after?.geometry).toEqual({ type: 'Point', coordinates: [9, 9] });
    store.setSelection(null, []);
    expect(store.getFeature('p1')).toBe(after);
  });

  it('notifies a feature created and selected in one transaction as a row created', () => {
    const { store, tables, notified } = setup();
    store.transact(() => {
      store.createFeature(point('n', 50));
      store.setSelection('feature', ['n']);
    });
    expect(notified).toHaveLength(1);
    expect(notified[0].features).toBeUndefined();
    expect(Array.from(notified[0].rows?.layers.get('layer')?.created ?? [])).toEqual([
      tables.findRow('n'),
    ]);
    expect(notified[0].selection?.ids).toEqual(['n']);
  });

  it('takes a row selected deleted from elsewhere out of the selection, as a row deleted', () => {
    const { store, writer, tables, notified } = setup();
    store.setSelection('feature', ['p2']);
    notified.length = 0;
    const handle = tables.findRow('p2') ?? -1;
    store.transact(() => {
      writer.apply({
        handles: Int32Array.of(handle),
        fields: new Map(),
        deleted: Uint8Array.of(1),
      });
    }, 'remote');
    expect(notified).toHaveLength(1);
    expect(notified[0].source).toBe('remote');
    expect(notified[0].features).toBeUndefined();
    expect(Array.from(notified[0].rows?.layers.get('layer')?.deleted ?? [])).toEqual([handle]);
    expect(store.getSelection().ids).toEqual([]);
  });

  it('selects more rows than the limit in bulk, and lists them up to the limit', () => {
    const { store } = setup(0);
    const ids: string[] = [];
    store.transact(() => {
      for (let i = 0; i <= SELECTION_IDS_LIMIT; i++) {
        store.createFeature(point(`q${i}`, i));
        ids.push(`q${i}`);
      }
    });
    store.setSelection('feature', ids);
    expect(store.getSelection().ids).toEqual([]);
    expect(store.getSelection().bulk?.count).toBe(SELECTION_IDS_LIMIT + 1);
    store.setSelection('feature', ids.slice(0, SELECTION_IDS_LIMIT));
    expect(store.getSelection().ids).toHaveLength(SELECTION_IDS_LIMIT);
    expect(store.getSelection().bulk).toBeUndefined();
  });

  it('reads the members of a group selected from their rows', () => {
    const { store } = setup(0);
    store.createGroup({
      id: 'g',
      layerId: 'layer',
      name: 'G',
      visible: true,
      locked: false,
      kind: 'table',
    });
    store.createFeature(point('a', 1, { groupId: 'g' }));
    store.createFeature(point('b', 2, { groupId: 'g' }));
    store.createFeature(point('c', 3));
    store.setSelection('group', ['g']);
    const rows = store.rowsOfSelection();
    expect(
      Array.from(rows?.handles ?? [], (handle) => store.tables?.getRowId(handle)).sort(),
    ).toEqual(['a', 'b']);
  });
});

describe('the order of the in-memory Store of rows', () => {
  /** The ids of the items of the layer in their order */
  const items = (tables: NonNullable<ReturnType<typeof setup>['tables']>, store: Store) => {
    const view = tables.get('layer');
    if (!view) return [];
    const refs = view.listItems(0, view.itemCount);
    return Array.from(refs.handles, (h, i) =>
      refs.kinds[i] === 0
        ? tables.getRowId(h)
        : store
            .listGroups()
            .find((g) => featureTablesInternals(tables)?.groups.handleOfId(g.id) === h)?.id,
    );
  };

  it('puts 2,000 items in one place with keys of 64 characters at most', () => {
    const { store, tables } = setup(2100);
    const ids = Array.from({ length: 2000 }, (_, i) => `p${i + 50}`);
    // Between the first two items, again and again
    for (let round = 0; round < 3; round++) {
      expect(store.moveItems(ids, { layerId: 'layer', below: 'p0' })).toBe(true);
    }
    const order = items(tables, store);
    expect(order.slice(0, 2002)).toEqual(['p0', ...ids, 'p1']);
    const internals = featureTablesInternals(tables);
    for (const id of ids) {
      const place = internals?.placeOf(tables.findRow(id) as number);
      const key = place ? utf8String(place.group.data.itemKeys, place.row) : '';
      expect(key.length).toBeLessThanOrEqual(64);
    }
  });

  it('creates a feature deleted again at the place it had', () => {
    const { store, tables } = setup();
    store.deleteFeature('p2');
    expect(items(tables, store)).toEqual(['p0', 'p1', 'p3', 'p4']);
    store.createFeature(point('p2', 2));
    expect(items(tables, store)).toEqual(['p0', 'p1', 'p2', 'p3', 'p4']);
  });

  it('deletes a group its last member leaves, and creates it again at the place it had', () => {
    const { store, tables, notified } = setup();
    store.createGroup({
      id: 'g',
      layerId: 'layer',
      name: 'g',
      featureIds: ['p1', 'p2'],
      visible: true,
      locked: false,
    });
    expect(items(tables, store)).toEqual(['p0', 'g', 'p3', 'p4']);
    notified.length = 0;
    store.transact(() => {
      store.deleteFeature('p1');
      store.deleteFeature('p2');
    });
    expect(store.getGroup('g')).toBeUndefined();
    expect(notified).toHaveLength(1);
    expect(notified[0].groups?.deleted?.map((g) => g.id)).toEqual(['g']);
    // Made again with the same ids: at the place they had
    store.transact(() => {
      store.createGroup({
        id: 'g',
        layerId: 'layer',
        name: 'g',
        kind: 'table',
        visible: true,
        locked: false,
      });
      store.createFeature(point('p1', 1, { groupId: 'g' }));
      store.createFeature(point('p2', 2, { groupId: 'g' }));
    });
    expect(items(tables, store)).toEqual(['p0', 'g', 'p3', 'p4']);
    expect(store.getFeature('p1')?.groupId).toBe('g');
  });

  it('puts the members of a group deleted at its place, in their order', () => {
    const { store, tables } = setup();
    store.createGroup({
      id: 'g',
      layerId: 'layer',
      name: 'g',
      featureIds: ['p3', 'p1'],
      visible: true,
      locked: false,
    });
    expect(items(tables, store)).toEqual(['p0', 'p2', 'g', 'p4']);
    store.deleteGroup('g');
    expect(items(tables, store)).toEqual(['p0', 'p2', 'p3', 'p1', 'p4']);
    expect(store.getFeature('p3')?.groupId).toBeUndefined();
  });

  it('puts the members of a new group in it in one write, the ones held too', () => {
    const { store, writer, tables, notified } = setup(8);
    store.setSelection('feature', ['p5']);
    notified.length = 0;
    const apply = vi.spyOn(writer, 'apply');
    store.transact(() =>
      insertGroup(store, {
        id: 'g',
        layerId: 'layer',
        name: 'g',
        featureIds: ['p1', 'p3', 'p5'],
        visible: true,
        locked: false,
      }),
    );
    // One write of the rows of the members, in one notification
    expect(apply).toHaveBeenCalledTimes(1);
    expect(Array.from(apply.mock.calls[0][0].handles, (h) => tables.getRowId(h))).toEqual([
      'p1',
      'p3',
      'p5',
    ]);
    expect(notified).toHaveLength(1);
    apply.mockRestore();
    // At the place of the frontmost member, the members in their order
    expect(items(tables, store)).toEqual(['p0', 'p2', 'p4', 'g', 'p6', 'p7']);
    const view = tables.get('layer');
    const handle = featureTablesInternals(tables)?.groups.handleOfId('g') ?? -1;
    expect(
      Array.from(view?.listGroupMembers(handle, 0, 3) ?? [], (h) => tables.getRowId(h)),
    ).toEqual(['p1', 'p3', 'p5']);
    for (const id of ['p1', 'p3', 'p5']) expect(store.getFeature(id)?.groupId).toBe('g');
  });

  it('leaves no work behind when rows spread over the layer are grouped and ungrouped again and again', () => {
    const { store, writer } = createTableStore();
    store.createLayer({
      id: 'layer',
      name: 'Layer',
      visible: true,
      locked: false,
      opacity: 1,
      items: [],
      metadata: undefined,
      styleRule: undefined,
    });
    // 10,000 rows in groups of the target size; 50 members spread over the first half of them
    const builder = createRowBlockDataBuilder();
    for (let i = 0; i < 10_000; i++) {
      builder.addRow({
        id: `r${i}`,
        type: 'Point',
        geometry: { type: 'Point', coordinates: [i * 1e-4, 0] },
        order: `k${String(i).padStart(6, '0')}`,
        style: {},
        properties: { n: i },
      });
    }
    writer.addRowBlocks('layer', builder.finish());
    const internals = featureTablesInternals(store.tables);
    if (!internals) throw new Error('a Store of rows has tables');
    internals.addQueuedRowBlocks();
    const layer = internals.layerTable('layer');
    const members = Array.from({ length: 50 }, (_, k) => `r${k * 100}`);
    const apply = vi.spyOn(writer, 'apply');
    const work: string[] = [];
    for (let rep = 0; rep < 40; rep++) {
      apply.mockClear();
      const swapped = internals.versionStats().swapped;
      if (rep % 2 === 0) {
        // As `draw.groups.create` makes it: in one transaction
        store.transact(() =>
          insertGroup(store, {
            id: 'g',
            layerId: 'layer',
            name: 'g',
            featureIds: members,
            visible: true,
            locked: false,
          }),
        );
      } else {
        store.deleteGroup('g');
      }
      // Each change writes the rows of the members once
      expect(apply).toHaveBeenCalledTimes(1);
      internals.flushVersions();
      expect(internals.hasPendingWork).toBe(false);
      expect(internals.deltaRowCount()).toBe(0);
      // What a change leaves: the versions it made, the row groups of the layer, the longest key
      // of the members
      let longest = 0;
      for (const id of members) {
        const place = internals.placeOf(store.tables?.findRow(id) as number);
        const data = place?.group.data;
        if (!data || !place) continue;
        const keys = [utf8String(data.itemKeys, place.row), utf8String(data.memberKeys, place.row)];
        for (const key of keys) longest = Math.max(longest, key.length);
      }
      work.push(
        `${rep % 2}:${internals.versionStats().swapped - swapped}:${layer?.groupCount}:${longest}`,
      );
    }
    apply.mockRestore();
    // After the first round, every grouping and every ungrouping does and leaves what the one
    // before did
    for (let rep = 3; rep < work.length; rep++) expect(work[rep]).toBe(work[rep - 2]);
  });
});

describe('the rows of a layer of z and m in the in-memory Store of rows', () => {
  it('give the values before and take them back with their z and m, as an undo writes them', () => {
    const { store, writer } = createTableStore({ dimensionsOf: () => 'xyzm' });
    store.createLayer({
      id: 'layer',
      name: 'Layer',
      visible: true,
      locked: false,
      opacity: 1,
      items: [],
      metadata: undefined,
      styleRule: undefined,
    });
    const line = {
      type: 'LineString' as const,
      coordinates: [
        [0, 0, 10, 1.7e12],
        [1, 1, Number.NaN, 1.7e12 + 1],
        [2, 2, 12],
      ],
    };
    const builder = createRowBlockDataBuilder({ dimensions: 'xyzm', rings: circleRowRings });
    builder.addRow({ id: 'l', type: 'LineString', geometry: line, order: 'k1' });
    writer.addRowBlocks('layer', builder.finish());
    const tables = store.tables;
    if (!tables) throw new Error('a Store of rows has tables');
    featureTablesInternals(tables)?.addQueuedRowBlocks();
    const handle = tables.findRow('l') as number;
    const geometryOf = () =>
      tables
        .readValues({ handles: Int32Array.of(handle), fields: new Map([['geometry', [0]]]) })
        .fields.get('geometry')?.[0];
    const notified: StoreChange[] = [];
    store.subscribe((change) => notified.push(change));
    // A write of this client with the values before, as an edit writes it
    const patch = {
      handles: Int32Array.of(handle),
      fields: new Map<RowField, unknown[]>([
        [
          'geometry',
          [
            {
              type: 'LineString',
              coordinates: [
                [5, 5, 1],
                [6, 6],
              ],
            },
          ],
        ],
      ]),
    };
    const before = tables.readValues(patch);
    expect(store.applyRows?.({ patch, before })).toBe(true);
    expect(
      (notified[notified.length - 1]?.previousValues as RowValues | undefined)?.fields.get(
        'geometry',
      )?.[0],
    ).toEqual(line);
    expect(geometryOf()).toEqual({
      type: 'LineString',
      coordinates: [
        [5, 5, 1],
        [6, 6],
      ],
    });
    // The values before written back
    store.applyRows?.({
      patch: { handles: before.handles, fields: before.fields },
      before: tables.readValues(patch),
    });
    expect(geometryOf()).toEqual(line);
    // A row of it is not a feature
    expect(() => store.getFeature('l')).toThrow(/is not a feature/);
  });
});
