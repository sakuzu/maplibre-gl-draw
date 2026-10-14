// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `draw.groups.create` in a layer held as rows (13.4 of the design): a group without features at
 * the front of its layer, and a group deleted whose rows are kept created again at the place it
 * had, as an undo of a deletion puts it back with the rows written not deleted.
 */

import { afterEach, describe, expect, it } from 'vitest';

import type { Store } from '../../store/store.js';
import { createTableMemoryStore } from '../../store/table-memory.js';
import type { Feature, RowValuesSnapshot, StoreChange } from '../../store/types.js';
import { createMapStub } from '../../test-utils.js';
import type { Draw } from '../draw.js';
import { type FeatureTables, ITEM_GROUP } from '../tables.js';
import { createDrawOnEngine } from './create-draw.js';
import { createEngine } from './engine.js';

let draw: Draw | undefined;

afterEach(() => {
  draw?.destroy();
  draw = undefined;
});

function point(id: string, x: number): Feature {
  return {
    id,
    type: 'Point',
    geometry: { type: 'Point', coordinates: [x, 0] },
    layerId: 'rows',
    groupId: undefined,
    properties: {},
    style: {},
    visible: true,
    locked: false,
  };
}

function drawOn(store?: Store): Draw {
  const engine = createEngine(
    createMapStub().map,
    { ...(store && { store }), initDefaultLayer: false },
    { deferDefaultMode: true },
  );
  draw = createDrawOnEngine(engine, { ...(store && { store }), initDefaultLayer: false });
  engine.enterDefaultMode();
  return draw;
}

function setup() {
  const { store } = createTableMemoryStore();
  store.createLayer({
    id: 'rows',
    name: 'rows',
    visible: true,
    locked: false,
    opacity: 1,
    kind: 'table',
    styleRule: undefined,
    metadata: undefined,
  });
  for (let i = 0; i < 5; i++) store.createFeature(point(`p${i}`, i));
  const tables = store.tables as FeatureTables;
  const instance = drawOn(store);
  const notified: StoreChange[] = [];
  instance.getStore().subscribe((change) => notified.push(change));
  return { draw: instance, tables, notified };
}

/** The items of the layer in their order: a feature by its id, a group as `id[members]` */
function itemsOf(tables: FeatureTables): string[] {
  const view = tables.layer('rows');
  if (!view) return [];
  const items = view.itemsInOrder(0, view.itemCount);
  return Array.from(items.handles, (handle, i) => {
    if (items.kinds[i] !== ITEM_GROUP) return tables.idOf(handle) as string;
    const members = view.groupMembersInOrder(handle, 0, view.groupMemberCount(handle));
    return `${tables.groupIdOf(handle)}[${Array.from(members, (m) => tables.idOf(m)).join(',')}]`;
  });
}

describe('draw.groups.create in a layer held as rows', () => {
  it('creates a group without features at the front, which features are moved into', () => {
    const { draw, tables } = setup();
    const group = draw.groups.create({ id: 'g', featureIds: [], layerId: 'rows' });
    expect(group).toMatchObject({ id: 'g', layerId: 'rows' });
    expect(draw.features.move('p1', { layerId: 'rows', groupId: 'g' })).toBe(true);
    expect(draw.features.move('p3', { layerId: 'rows', groupId: 'g', below: 'p1' })).toBe(true);
    expect(itemsOf(tables)).toEqual(['p0', 'p2', 'p4', 'g[p1,p3]']);
  });

  it('creates a group deleted whose rows are kept again at the place it had', () => {
    const { draw, tables, notified } = setup();
    draw.groups.create({ id: 'g', featureIds: ['p1', 'p2'], name: 'G' });
    const start = itemsOf(tables);
    expect(start).toEqual(['p0', 'g[p1,p2]', 'p3', 'p4']);
    // Its features deleted: the group goes with them, its rows kept by the deletion
    draw.features.deleteMany(['p1', 'p2']);
    const deletion = notified[notified.length - 1];
    expect(deletion.groups?.deleted?.map((group) => group.id)).toEqual(['g']);
    expect(deletion.retain).toBeDefined();
    expect(itemsOf(tables)).toEqual(['p0', 'p3', 'p4']);
    // Something else changes the front meanwhile
    draw.features.move('p0', { layerId: 'rows', above: null });
    // Undone: the group created again, then its rows written not deleted
    draw.transact(() => {
      draw?.groups.create({ id: 'g', featureIds: [], layerId: 'rows', name: 'G' });
      draw?.tables.applyRows(deletion.rows?.before as RowValuesSnapshot);
    });
    expect(itemsOf(tables)).toEqual(['g[p1,p2]', 'p3', 'p4', 'p0']);
    expect(draw.groups.get('g')?.name).toBe('G');
    expect(draw.getStore().getFeature('p1')?.groupId).toBe('g');
  });

  it('keeps the place of a group created again with features, which join it', () => {
    const { draw, tables, notified } = setup();
    draw.groups.create({ id: 'g', featureIds: ['p1'] });
    draw.features.delete('p1');
    expect(notified[notified.length - 1].groups?.deleted?.map((group) => group.id)).toEqual(['g']);
    draw.groups.create({ id: 'g', featureIds: ['p4'] });
    expect(itemsOf(tables)).toEqual(['p0', 'g[p4]', 'p2', 'p3']);
  });

  it('refuses a group without features without a layer, in a missing layer, or in another layer than its features', () => {
    const { draw } = setup();
    expect(() => draw.groups.create({ featureIds: [] })).toThrow(
      expect.objectContaining({ code: 'invalid-input' }),
    );
    expect(() => draw.groups.create({ featureIds: [], layerId: 'none' })).toThrow(
      expect.objectContaining({ code: 'not-found' }),
    );
    expect(() => draw.groups.create({ featureIds: ['p1'], layerId: 'other' })).toThrow(
      expect.objectContaining({ code: 'invalid-input' }),
    );
    expect(draw.groups.list()).toEqual([]);
  });

  it('refuses a group without features in a layer of objects', () => {
    const objects = drawOn();
    const layer = objects.layers.create({ name: 'objects' });
    expect(() => objects.groups.create({ featureIds: [], layerId: layer?.id })).toThrow(
      expect.objectContaining({ code: 'invalid-input' }),
    );
  });
});
