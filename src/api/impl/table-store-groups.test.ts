// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `groups.create` and `groups.restore` of the internal writes in a layer held as rows: a
 * group needs features in every layer, and a group this client deleted is kept with its rows
 * deleted, by the token of the deletion, and brought back at the place it had.
 */

import { afterEach, describe, expect, it } from 'vitest';

import type { Store } from '../../store/store.js';
import { createTableStore } from '../../store/table-memory.js';
import type { Feature, FeatureValues, StoreChange } from '../../store/types.js';
import { writesOf } from '../../test-support/writes.js';
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

function drawOn(store?: Store, maxSteps?: number): Draw {
  const engine = createEngine(
    createMapStub().map,
    { ...(store && { store }), initDefaultLayer: false },
    { deferDefaultMode: true },
  );
  draw = createDrawOnEngine(engine, {
    ...(store && { store }),
    initDefaultLayer: false,
    ...(maxSteps !== undefined && { history: { maxSteps } }),
  });
  engine.enterDefaultMode();
  return draw;
}

function setup(options: Parameters<typeof createTableStore>[0] = {}, maxSteps?: number) {
  const { store } = createTableStore(options);
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
  const instance = drawOn(store, maxSteps);
  const notified: StoreChange[] = [];
  instance.getStore().subscribe((change) => notified.push(change));
  return { draw: instance, tables, notified };
}

/** The items of the layer in their order: a feature by its id, a group as `id[members]` */
function itemsOf(tables: FeatureTables): string[] {
  const view = tables.get('rows');
  if (!view) return [];
  const items = view.listItems(0, view.itemCount);
  return Array.from(items.handles, (handle, i) => {
    if (items.kinds[i] !== ITEM_GROUP) return tables.getRowId(handle) as string;
    const members = view.listGroupMembers(handle, 0, view.countGroupMembers(handle));
    return `${tables.getGroupId(handle)}[${Array.from(members, (m) => tables.getRowId(m)).join(',')}]`;
  });
}

describe('groups.create in a layer held as rows', () => {
  it('keeps the place of a group created again with features, which join it', () => {
    const { draw, tables, notified } = setup();
    writesOf(draw).groups.create({ id: 'g', featureIds: ['p1'] });
    writesOf(draw).features.delete('p1');
    expect(notified[notified.length - 1].groups?.deleted?.map((group) => group.id)).toEqual(['g']);
    writesOf(draw).groups.create({ id: 'g', featureIds: ['p4'] });
    expect(itemsOf(tables)).toEqual(['p0', 'g[p4]', 'p2', 'p3']);
  });

  it('refuses a group without features, as in a layer of objects, and a layer other than its features', () => {
    const { draw } = setup();
    expect(() => writesOf(draw).groups.create({ featureIds: [] })).toThrow(
      expect.objectContaining({ code: 'invalid-input' }),
    );
    expect(() => writesOf(draw).groups.create({ featureIds: [], layerId: 'rows' })).toThrow(
      expect.objectContaining({ code: 'invalid-input' }),
    );
    expect(() => writesOf(draw).groups.create({ featureIds: ['p1'], layerId: 'other' })).toThrow(
      expect.objectContaining({ code: 'invalid-input' }),
    );
    expect(draw.groups.list()).toEqual([]);
  });

  it('refuses a group without features in a layer of objects', () => {
    const objects = drawOn();
    const layer = writesOf(objects).layers.create({ name: 'objects' });
    expect(() => writesOf(objects).groups.create({ featureIds: [], layerId: layer?.id })).toThrow(
      expect.objectContaining({ code: 'invalid-input' }),
    );
  });
});

describe('groups.restore of the internal writes', () => {
  it('brings back a group deleted whose rows are kept, at the place it had', () => {
    const { draw, tables, notified } = setup();
    writesOf(draw).groups.create({ id: 'g', featureIds: ['p1', 'p2'], name: 'G' });
    const start = itemsOf(tables);
    expect(start).toEqual(['p0', 'g[p1,p2]', 'p3', 'p4']);
    // Its features deleted: the group goes with them, its rows kept by the deletion
    writesOf(draw).features.deleteMany(['p1', 'p2']);
    const deletion = notified[notified.length - 1];
    expect(deletion.groups?.deleted?.map((group) => group.id)).toEqual(['g']);
    expect(deletion.restoreToken).toBeDefined();
    expect(itemsOf(tables)).toEqual(['p0', 'p3', 'p4']);
    // Something else changes the front meanwhile
    writesOf(draw).features.move('p0', { layerId: 'rows', above: null });
    // Undone: the group brought back, its name written again, then its rows written not deleted
    writesOf(draw).transact(() => {
      expect(writesOf(draw).groups.restore('g')).toMatchObject({ id: 'g', layerId: 'rows' });
      writesOf(draw).groups.update('g', { name: 'G' });
      writesOf(draw).features.restore(deletion.previousValues as FeatureValues);
    });
    expect(itemsOf(tables)).toEqual(['g[p1,p2]', 'p3', 'p4', 'p0']);
    expect(draw.groups.get('g')?.name).toBe('G');
    expect(draw.getStore().getFeature('p1')?.groupId).toBe('g');
  });

  it('brings back a group whose features left it (an ungrouping), kept by the token of its deletion', () => {
    const { draw, tables, notified } = setup();
    writesOf(draw).groups.create({ id: 'g', featureIds: ['p1', 'p2'], name: 'G' });
    writesOf(draw).groups.delete('g');
    const deletion = notified[notified.length - 1];
    expect(deletion.groups?.deleted?.map((group) => group.id)).toEqual(['g']);
    expect(deletion.restoreToken).toBeDefined();
    expect(itemsOf(tables)).toEqual(['p0', 'p1', 'p2', 'p3', 'p4']);
    // Undone: the group brought back at the place it had, and its features moved into it
    writesOf(draw).transact(() => {
      expect(writesOf(draw).groups.restore('g')).toMatchObject({ id: 'g', layerId: 'rows' });
      writesOf(draw).features.moveMany(['p1', 'p2'], { layerId: 'rows', groupId: 'g' });
    });
    expect(itemsOf(tables)).toEqual(['p0', 'g[p1,p2]', 'p3', 'p4']);
  });

  it('brings back a group its last feature left for another place', () => {
    const { draw, tables, notified } = setup();
    writesOf(draw).groups.create({ id: 'g', featureIds: ['p2'] });
    writesOf(draw).features.move('p2', { layerId: 'rows', above: null });
    expect(notified[notified.length - 1].groups?.deleted?.map((group) => group.id)).toEqual(['g']);
    expect(notified[notified.length - 1].restoreToken).toBeDefined();
    writesOf(draw).transact(() => {
      writesOf(draw).groups.restore('g');
      writesOf(draw).features.move('p2', { layerId: 'rows', groupId: 'g' });
    });
    expect(itemsOf(tables)).toEqual(['p0', 'p1', 'g[p2]', 'p3', 'p4']);
  });

  it('lets go of a group kept once the token of its deletion is let go of', () => {
    const { draw, notified } = setup();
    writesOf(draw).groups.create({ id: 'g', featureIds: ['p1'] });
    writesOf(draw).groups.delete('g');
    const token = notified[notified.length - 1].restoreToken;
    expect(token).toBeDefined();
    writesOf(draw).features.releaseRestore(token as NonNullable<typeof token>);
    expect(() => writesOf(draw).groups.restore('g')).toThrow(
      expect.objectContaining({ code: 'not-found' }),
    );
  });

  it('keeps the groups of every deletion until they are let go of, however many', () => {
    // The local undo lets go of what the steps it drops kept: here it has room for every one
    const { draw } = setup({}, 1000);
    // More deletions than the tokens a limit would have kept (100 before there was none)
    for (let i = 0; i < 120; i++) {
      writesOf(draw).groups.create({ id: `g${i}`, featureIds: ['p1'] });
      writesOf(draw).groups.delete(`g${i}`);
    }
    expect(writesOf(draw).groups.restore('g0')).toMatchObject({ id: 'g0' });
    expect(writesOf(draw).groups.restore('g119')).toMatchObject({ id: 'g119' });
  });

  it('keeps no group deleted from elsewhere', () => {
    const { draw, notified } = setup();
    writesOf(draw).groups.create({ id: 'g', featureIds: ['p1'] });
    const store = draw.getStore();
    store.transact(() => {
      writesOf(draw).features.move('p1', { layerId: 'rows', above: null });
    }, 'remote');
    expect(notified[notified.length - 1].groups?.deleted?.map((group) => group.id)).toEqual(['g']);
    expect(notified[notified.length - 1].restoreToken).toBeUndefined();
    expect(() => writesOf(draw).groups.restore('g')).toThrow(
      expect.objectContaining({ code: 'not-found' }),
    );
  });

  it('throws not-found for a group that is not kept, and already-exists for a group there is', () => {
    const { draw } = setup();
    expect(() => writesOf(draw).groups.restore('never')).toThrow(
      expect.objectContaining({ code: 'not-found' }),
    );
    writesOf(draw).groups.create({ id: 'g', featureIds: ['p1'] });
    expect(() => writesOf(draw).groups.restore('g')).toThrow(
      expect.objectContaining({ code: 'already-exists' }),
    );
    expect(() => writesOf(draw).groups.restore(3 as unknown as string)).toThrow(
      expect.objectContaining({ code: 'invalid-input' }),
    );
  });

  it('is refused while read-only', () => {
    const { draw } = setup();
    writesOf(draw).groups.create({ id: 'g', featureIds: ['p1'] });
    writesOf(draw).features.delete('p1');
    draw.setReadOnly(true);
    expect(writesOf(draw).groups.restore('g')).toBeNull();
    expect(draw.groups.has('g')).toBe(false);
  });

  it('always throws not-found on a Store of objects, which keeps no group it deleted', () => {
    const objects = drawOn();
    const layer = writesOf(objects).layers.create({ name: 'objects' });
    const feature = writesOf(objects).features.create({
      type: 'Point',
      geometry: { type: 'Point', coordinates: [0, 0] },
      layerId: layer?.id,
    });
    writesOf(objects).groups.create({ id: 'g', featureIds: [feature?.id as string] });
    writesOf(objects).groups.delete('g');
    expect(() => writesOf(objects).groups.restore('g')).toThrow(
      expect.objectContaining({ code: 'not-found' }),
    );
  });
});

describe('a group or a layer selected over a Store of rows', () => {
  it('is read by the rows of its features: listed, counted, changed and given as a value', () => {
    const { draw } = setup();
    writesOf(draw).groups.create({ id: 'g', featureIds: ['p1', 'p3'] });
    draw.selection.set('group', ['g']);
    expect(draw.selection.features().map((feature) => feature.id)).toEqual(['p1', 'p3']);
    expect(draw.selection.count()).toBe(2);
    expect(draw.selection.value).toEqual({
      type: 'group',
      count: 2,
      ids: ['g'],
      layerIds: ['rows'],
      bbox: [1, 0, 3, 0],
    });
    expect(writesOf(draw).selection.update({ style: { pointColor: '#ff0000' } })).toBe(true);
    expect(writesOf(draw).features.get('p3')?.style).toEqual({ pointColor: '#ff0000' });
    expect(writesOf(draw).features.get('p2')?.style).toEqual({});

    draw.selection.set('layer', ['rows']);
    expect(draw.selection.count()).toBe(5);
    // In the stacking order of the layer, the members of the group at its place
    const all = draw.selection.features().map((feature) => feature.id);
    expect([...all].sort()).toEqual(['p0', 'p1', 'p2', 'p3', 'p4']);
    expect(draw.selection.features({ type: 'Point' }, { limit: 2 }).map((f) => f.id)).toEqual(
      all.slice(0, 2),
    );
    expect(draw.selection.value).toMatchObject({ type: 'layer', count: 5, ids: ['rows'] });
  });
});
