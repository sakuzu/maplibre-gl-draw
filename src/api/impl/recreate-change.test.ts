// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A feature, a layer or a group deleted and created again with the same ID in one write, as the
 * subscribers of the Store and of `change` are told it, over a Store of objects and a Store of rows
 *
 * It was there before the commit and is there after it: it is told as updated, from what it was to
 * what it is, and not as created nor deleted. One created and deleted again in one write was there
 * neither before nor after, and is not told at all. Both Stores tell the same.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { MemoryStore } from '../../store/memory.js';
import type { Store } from '../../store/store.js';
import { createTableStore } from '../../store/table-memory.js';
import type { RowField } from '../../store/types.js';
import { createMapStub } from '../../test-utils.js';
import type { Draw } from '../draw.js';
import { createDraw } from '../draw.js';
import type { Change, DocumentChange } from '../events.js';
import type { Feature, FeatureInput } from '../model.js';

const opened: Draw[] = [];
afterEach(() => {
  for (const draw of opened.splice(0)) draw.destroy();
});

/** An instance over a Store of objects or of rows, with two layers, and what it tells */
function open(kind: 'objects' | 'rows') {
  const store: Store = kind === 'rows' ? createTableStore().store : new MemoryStore();
  for (const id of ['a', 'b']) {
    store.createLayer({
      id,
      name: id,
      visible: true,
      locked: false,
      opacity: 1,
      ...(kind === 'rows' ? { kind: 'table' as const } : { items: [] }),
      styleRule: undefined,
      metadata: undefined,
    });
  }
  const draw = createDraw(createMapStub().map, { store, initDefaultLayer: false });
  opened.push(draw);
  const told: DocumentChange[] = [];
  const changes: Change[] = [];
  // What each feature updated was before the commit, read while the change is delivered
  const before: Array<Record<string, Feature | undefined>> = [];
  draw.getStore().subscribe((change) => told.push(change));
  draw.on('change', (change) => {
    changes.push(change);
    const read: Record<string, Feature | undefined> = {};
    for (const id of change.features.updated) read[id] = change.previous(id);
    before.push(read);
  });
  return { draw, store, told, changes, before };
}

const point = (
  id: string,
  layerId: string,
  properties: Record<string, string | number>,
): FeatureInput => ({
  type: 'Feature',
  id,
  geometry: { type: 'Point', coordinates: [1, 1] },
  properties: { ...properties, 'maplibre-gl-draw:layerId': layerId },
});

/** The IDs of the features a notification tells, by what it tells of them, over either Store */
function featuresTold(store: Store, change: DocumentChange) {
  const out = { created: [] as string[], updated: [] as string[], deleted: [] as string[] };
  const ids = (handles: Int32Array) =>
    Array.from(handles, (handle) => store.tables?.getRowId(handle) ?? `#${handle}`);
  for (const feature of change.features?.created ?? []) out.created.push(feature.id);
  for (const { id } of change.features?.updated ?? []) out.updated.push(id);
  for (const feature of change.features?.deleted ?? []) out.deleted.push(feature.id);
  for (const rows of change.rows?.layers.values() ?? []) {
    out.created.push(...ids(rows.created));
    out.updated.push(...ids(rows.updated));
    out.deleted.push(...ids(rows.deleted));
  }
  return out;
}

/** The fields a notification tells written for the rows it updated, in every layer */
function rowFieldsTold(change: DocumentChange): Set<RowField> {
  const fields = new Set<RowField>();
  for (const rows of change.rows?.layers.values() ?? []) {
    if (rows.updated.length > 0) for (const field of rows.fields) fields.add(field);
  }
  return fields;
}

describe.each(['objects', 'rows'] as const)('one write over a Store of %s', (kind) => {
  it('tells a feature deleted and created again with its id as updated, with its new values', async () => {
    const { draw, store, told, changes, before } = open(kind);
    await draw.write((tx) => tx.features.create(point('f', 'a', { name: 'before', old: 1 })));
    const was = draw.features.get('f');
    told.length = 0;
    changes.length = 0;
    before.length = 0;
    await draw.write(async (tx) => {
      await tx.features.delete('f');
      await tx.features.create(point('f', 'a', { name: 'after' }));
    });
    expect(told).toHaveLength(1);
    expect(featuresTold(store, told[0])).toEqual({ created: [], updated: ['f'], deleted: [] });
    if (kind === 'objects') {
      const [update] = told[0].features?.updated ?? [];
      expect(update.previous.properties).toEqual({ name: 'before', old: 1 });
      expect(update.feature.properties).toEqual({ name: 'after' });
    } else {
      // The fields of the row written: the ones it has, and the ones it no longer has
      const fields = rowFieldsTold(told[0]);
      expect(fields.has('properties:name')).toBe(true);
      expect(fields.has('properties:old')).toBe(true);
    }
    expect(changes).toHaveLength(1);
    expect(changes[0].features.created).toEqual([]);
    expect(changes[0].features.updated).toEqual(['f']);
    expect(changes[0].features.deleted).toEqual([]);
    expect(before[0].f).toEqual(was);
    expect(draw.features.get('f')?.properties).toEqual({
      name: 'after',
      'maplibre-gl-draw:layerId': 'a',
    });
  });

  it('takes a feature deleted and created again back with undo, and makes it again with redo', async () => {
    const { draw } = open(kind);
    await draw.write((tx) => tx.features.create(point('f', 'a', { name: 'before', old: 1 })));
    const was = draw.features.get('f');
    await draw.write(async (tx) => {
      await tx.features.delete('f');
      await tx.features.create(point('f', 'a', { name: 'after' }));
    });
    const now = draw.features.get('f');
    await draw.undo();
    expect(draw.features.get('f')).toEqual(was);
    await draw.redo();
    expect(draw.features.get('f')).toEqual(now);
  });

  it('takes a layer deleted and created again back with undo, with the features it held', async () => {
    const { draw } = open(kind);
    await draw.write((tx) => tx.features.create(point('old', 'b', { name: 'before' })));
    await draw.write(async (tx) => {
      await tx.layers.delete('b');
      await tx.layers.create({ id: 'b', name: 'again' });
      await tx.features.create(point('new', 'b', { name: 'after' }));
    });
    await draw.undo();
    expect(draw.layers.get('b')?.name).toBe('b');
    expect(draw.features.get('old')?.properties.name).toBe('before');
    expect(draw.features.get('new')).toBeUndefined();
  });

  it('tells a feature deleted and created again in another layer as updated there', async () => {
    const { draw, store, told, changes } = open(kind);
    await draw.write((tx) => tx.features.create(point('f', 'a', { name: 'before' })));
    told.length = 0;
    changes.length = 0;
    await draw.write(async (tx) => {
      await tx.features.delete('f');
      await tx.features.create(point('f', 'b', { name: 'after' }));
    });
    expect(featuresTold(store, told[0])).toEqual({ created: [], updated: ['f'], deleted: [] });
    if (kind === 'rows') {
      // Updated in the layer it is in, and not deleted from the one it was in
      expect(Array.from(told[0].rows?.layers.get('b')?.updated ?? [])).toHaveLength(1);
      expect(Array.from(told[0].rows?.layers.get('a')?.deleted ?? [])).toEqual([]);
    }
    expect(changes[0].features.updated).toEqual(['f']);
    expect(changes[0].features.created).toEqual([]);
    expect(changes[0].features.deleted).toEqual([]);
    expect(draw.features.get('f')?.properties['maplibre-gl-draw:layerId']).toBe('b');
  });

  it('tells a feature updated, deleted, created again and updated as one update', async () => {
    const { draw, store, told } = open(kind);
    await draw.write((tx) => tx.features.create(point('f', 'a', { name: 'first' })));
    told.length = 0;
    await draw.write(async (tx) => {
      await tx.features.update('f', { properties: { name: 'second' } });
      await tx.features.delete('f');
      await tx.features.create(point('f', 'a', { name: 'third' }));
      await tx.features.update('f', { properties: { name: 'last' } });
    });
    expect(featuresTold(store, told[0])).toEqual({ created: [], updated: ['f'], deleted: [] });
    if (kind === 'objects') {
      const updates = told[0].features?.updated ?? [];
      expect(updates).toHaveLength(1);
      expect(updates[0].previous.properties).toEqual({ name: 'first' });
      expect(updates[0].feature.properties).toEqual({ name: 'last' });
    }
    expect(draw.features.get('f')?.properties.name).toBe('last');
  });

  it('tells a feature deleted, created again and deleted as deleted', async () => {
    const { draw, store, told, changes } = open(kind);
    await draw.write((tx) => tx.features.create(point('f', 'a', { name: 'first' })));
    told.length = 0;
    changes.length = 0;
    await draw.write(async (tx) => {
      await tx.features.delete('f');
      await tx.features.create(point('f', 'a', { name: 'again' }));
      await tx.features.delete('f');
    });
    expect(featuresTold(store, told[0])).toEqual({ created: [], updated: [], deleted: ['f'] });
    if (kind === 'objects') {
      expect(told[0].features?.deleted?.[0].properties).toEqual({ name: 'first' });
    }
    expect(changes[0].features.deleted).toEqual(['f']);
    expect(draw.features.get('f')).toBeUndefined();
  });

  it('tells a feature created and deleted again not at all, nor one created, deleted and created as more than created', async () => {
    const { draw, store, told } = open(kind);
    await draw.write((tx) => tx.features.create(point('x', 'a', {})));
    told.length = 0;
    await draw.write(async (tx) => {
      await tx.features.create(point('gone', 'a', {}));
      await tx.features.delete('gone');
      await tx.features.create(point('kept', 'a', { name: 'first' }));
      await tx.features.delete('kept');
      await tx.features.create(point('kept', 'a', { name: 'again' }));
    });
    expect(featuresTold(store, told[0])).toEqual({ created: ['kept'], updated: [], deleted: [] });
    if (kind === 'objects') {
      expect(told[0].features?.created?.[0].properties).toEqual({ name: 'again' });
    }
  });

  it('tells a layer deleted and created again with its id as updated, with the features made in it', async () => {
    const { draw, store, told, changes } = open(kind);
    await draw.write((tx) => tx.features.create(point('old', 'b', { name: 'before' })));
    told.length = 0;
    changes.length = 0;
    await draw.write(async (tx) => {
      await tx.layers.delete('b');
      await tx.layers.create({ id: 'b', name: 'again' });
      await tx.features.create(point('new', 'b', { name: 'after' }));
    });
    expect(told).toHaveLength(1);
    const layers = told[0].layers;
    expect(layers?.created).toBeUndefined();
    expect(layers?.deleted).toBeUndefined();
    expect(
      layers?.updated?.map(({ id, layer, previous }) => [id, layer.name, previous.name]),
    ).toEqual([['b', 'again', 'b']]);
    expect(featuresTold(store, told[0])).toEqual({
      created: ['new'],
      updated: [],
      deleted: ['old'],
    });
    expect(changes[0].layers.created).toEqual([]);
    expect(changes[0].layers.deleted).toEqual([]);
    expect(changes[0].layers.updated).toEqual(['b']);
  });

  it('tells a group deleted and created again with its id as updated', async () => {
    const { draw, told, changes } = open(kind);
    const ids = await draw.write(async (tx) => {
      const made: string[] = [];
      for (const n of [1, 2, 3]) made.push((await tx.features.create(point(`m${n}`, 'a', {}))).id);
      const group = await tx.groups.create({ name: 'before', members: made.slice(0, 2) });
      return { features: made, group: group.id };
    });
    told.length = 0;
    changes.length = 0;
    await draw.write(async (tx) => {
      await tx.groups.delete(ids.group, { members: 'keep' });
      await tx.groups.create({ id: ids.group, name: 'after', members: ids.features.slice(1) });
    });
    expect(told).toHaveLength(1);
    const groups = told[0].groups;
    expect(groups?.created).toBeUndefined();
    expect(groups?.deleted).toBeUndefined();
    expect(
      groups?.updated?.map(({ id, group, previous }) => [id, group.name, previous.name]),
    ).toEqual([[ids.group, 'after', 'before']]);
    expect(changes[0].groups.created).toEqual([]);
    expect(changes[0].groups.deleted).toEqual([]);
    expect(changes[0].groups.updated).toEqual([ids.group]);
    expect(draw.groups.listMembers(ids.group)).toEqual(ids.features.slice(1));
  });

  it('takes a group deleted and created again with other members back with undo, and makes it again with redo', async () => {
    const { draw } = open(kind);
    const ids = await draw.write(async (tx) => {
      const made: string[] = [];
      for (const n of [1, 2, 3]) made.push((await tx.features.create(point(`m${n}`, 'a', {}))).id);
      const group = await tx.groups.create({ name: 'before', members: made.slice(0, 2) });
      return { features: made, group: group.id };
    });
    const [m1, m2, m3] = ids.features;
    await draw.write(async (tx) => {
      await tx.groups.delete(ids.group, { members: 'keep' });
      await tx.groups.create({ id: ids.group, name: 'after', members: [m2, m3] });
    });
    expect(draw.layers.listItems('a')).toEqual([m1, ids.group]);
    for (let round = 0; round < 2; round++) {
      await draw.undo();
      expect(draw.groups.get(ids.group)?.name).toBe('before');
      expect(draw.groups.listMembers(ids.group)).toEqual([m1, m2]);
      expect(draw.layers.listItems('a')).toEqual([ids.group, m3]);
      await draw.redo();
      expect(draw.groups.get(ids.group)?.name).toBe('after');
      expect(draw.groups.listMembers(ids.group)).toEqual([m2, m3]);
      expect(draw.layers.listItems('a')).toEqual([m1, ids.group]);
    }
  });

  it('takes a group deleted with its members and created again around a new feature back with undo', async () => {
    const { draw } = open(kind);
    const ids = await draw.write(async (tx) => {
      const made: string[] = [];
      for (const n of [1, 2, 3]) made.push((await tx.features.create(point(`m${n}`, 'a', {}))).id);
      const group = await tx.groups.create({ name: 'before', members: made.slice(0, 2) });
      return { features: made, group: group.id };
    });
    const [m1, m2, m3] = ids.features;
    await draw.write(async (tx) => {
      await tx.groups.delete(ids.group, { members: 'delete' });
      const made = await tx.features.create(point('new', 'a', {}));
      await tx.groups.create({ id: ids.group, name: 'after', members: [made.id] });
    });
    expect(draw.groups.listMembers(ids.group)).toEqual(['new']);
    await draw.undo();
    expect(draw.groups.get(ids.group)?.name).toBe('before');
    expect(draw.groups.listMembers(ids.group)).toEqual([m1, m2]);
    expect(draw.layers.listItems('a')).toEqual([ids.group, m3]);
    expect(draw.features.get('new')).toBeUndefined();
  });

  it('tells a layer and a group created and deleted again not at all', async () => {
    const { draw, told } = open(kind);
    await draw.write(async (tx) => {
      await tx.layers.create({ id: 'tmp', name: 'tmp' });
      await tx.layers.delete('tmp');
      const f = await tx.features.create(point('f', 'a', {}));
      const group = await tx.groups.create({ id: 'g', name: 'g', members: [f.id] });
      await tx.groups.delete(group.id, { members: 'keep' });
    });
    expect(told).toHaveLength(1);
    expect(told[0].layers?.created).toBeUndefined();
    expect(told[0].layers?.updated).toBeUndefined();
    expect(told[0].layers?.deleted).toBeUndefined();
    expect(told[0].groups).toBeUndefined();
  });
});
