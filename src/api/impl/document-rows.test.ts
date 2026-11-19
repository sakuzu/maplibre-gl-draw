// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for the document of an instance kept in a Store of rows: the limits of the lists and the
 * ranges, the reads one at a time, a Store wrapped by the application, read-only and the locks
 * before the Store is written, the writes of the Many methods in one transaction, the groups left
 * empty, the keys of the metadata, and the events of a change written to the Store directly
 */

import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createStore } from '../../store/built-in/create-store.js';
import type { FeatureRowField, Store, StoreChange } from '../../store/built-in/types.js';
import { createMapStub, gridPoints, rowWrites } from '../../test-utils.js';
import type { Draw } from '../draw.js';
import { DrawError } from '../errors.js';
import type { Feature } from '../model.js';
import { createDrawOnEngine } from './create-draw.js';
import { createEngine } from './engine.js';

const instances: Draw[] = [];

/** An instance over the Store given, on a map stub, with the IDs `id-1`, `id-2` and so on */
function instanceOver(store: Store = createStore()): { draw: Draw; store: Store } {
  vi.useFakeTimers();
  let seq = 0;
  const options = { store, generateId: () => `id-${++seq}` };
  const engine = createEngine(createMapStub().map, options, { deferDefaultMode: true });
  const draw = createDrawOnEngine(engine, options);
  engine.enterDefaultMode();
  instances.push(draw);
  return { draw, store };
}

afterEach(() => {
  for (const draw of instances.splice(0)) draw.destroy();
  vi.useRealTimers();
});

/** The code of the DrawError `fn` throws */
function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    if (error instanceof DrawError) return error.code;
    throw error;
  }
  return undefined;
}

function point(id: string, coordinates: [number, number] = [0, 0]) {
  return { id, type: 'Point' as const, geometry: { type: 'Point' as const, coordinates } };
}

function square(id: string, x: number) {
  return {
    id,
    type: 'Polygon' as const,
    geometry: {
      type: 'Polygon' as const,
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
  };
}

describe('the limit of 10,000', () => {
  it('lists 10,000 features and throws tooManyItems for 10,001', () => {
    const { draw } = instanceOver();
    draw.features.createMany(gridPoints(10_000));
    expect(draw.features.list()).toHaveLength(10_000);
    draw.features.create(point('one-more'));
    expect(codeOf(() => draw.features.list())).toBe('tooManyItems');
    // The filter narrows what counts
    expect(draw.features.list({ type: 'Polygon' })).toEqual([]);
  });

  it('lists 10,000 groups and throws tooManyItems for 10,001', () => {
    const { draw, store } = instanceOver();
    const layerId = draw.layers.list()[0].id;
    const writeGroups = (from: number, to: number) =>
      store.transact(() => {
        for (let i = from; i < to; i++) {
          store.createGroup({
            id: `g${i}`,
            name: `G${i}`,
            layerId,
            visible: true,
            locked: false,
            orderKey: `a${String(i).padStart(6, '0')}`,
          });
        }
      }, 'remote');
    writeGroups(0, 10_000);
    expect(draw.groups.list()).toHaveLength(10_000);
    writeGroups(10_000, 10_001);
    expect(codeOf(() => draw.groups.list())).toBe('tooManyItems');
    expect(draw.groups.count()).toBe(10_001);
  });

  it('returns a range of 10,000 items of a layer and throws tooManyItems for 10,001', () => {
    const { draw } = instanceOver();
    draw.features.createMany(gridPoints(10_001));
    const layerId = draw.layers.list()[0].id;
    expect(draw.layers.listItemIds(layerId, { start: 0, end: 10_000 })).toHaveLength(10_000);
    expect(draw.layers.listItemIds(layerId, { start: 1, end: 10_001 })).toHaveLength(10_000);
    expect(codeOf(() => draw.layers.listItemIds(layerId, { start: 0, end: 10_001 }))).toBe(
      'tooManyItems',
    );
  });

  it('returns a range of 10,000 features of a group and throws tooManyItems for 10,001', () => {
    const { draw } = instanceOver();
    const ids = (draw.features.createMany(gridPoints(10_001)) as Feature[]).map((f) => f.id);
    const group = draw.groups.create({ featureIds: ids });
    if (!group) throw new Error('no group');
    expect(draw.groups.listFeatureIds(group.id, { start: 0, end: 10_000 })).toEqual(
      ids.slice(0, 10_000),
    );
    expect(codeOf(() => draw.groups.listFeatureIds(group.id, { start: 0, end: 10_001 }))).toBe(
      'tooManyItems',
    );
  });
});

describe('the reads one at a time', () => {
  it('iterates the features that matched when it started, through writes and deletions', () => {
    const { draw } = instanceOver();
    draw.features.createMany([point('a'), point('b'), point('c'), point('d')]);
    const iterator = draw.features.iterate();
    expect(iterator.next().value?.id).toBe('a');
    // A feature written before the iterator reaches it is read as it is then
    draw.features.update('b', { properties: { n: 2 } });
    // A feature deleted before it is reached is skipped, one created after the start is not read
    draw.features.delete('c');
    draw.features.create(point('e'));
    const rest = [...iterator];
    expect(rest.map((f) => f.id)).toEqual(['b', 'd']);
    expect(rest[0].properties).toEqual({ n: 2 });
  });

  it('lets the state of an iterator left before its end go with it', async () => {
    const { draw } = instanceOver();
    vi.useRealTimers();
    draw.features.createMany(gridPoints(3));
    // The weak references the instance makes, kept by the test to see what they hold
    const made: Array<{ deref(): unknown }> = [];
    const Weak = (
      globalThis as unknown as { WeakRef: new (target: object) => { deref(): unknown } }
    ).WeakRef;
    const spied = vi.spyOn(globalThis as unknown as { WeakRef: typeof Weak }, 'WeakRef');
    spied.mockImplementation(function made_(this: unknown, target: object) {
      const held = new Weak(target);
      made.push(held);
      return held;
    } as never);
    (() => {
      const iterator = draw.features.iterate();
      iterator.next();
    })();
    spied.mockRestore();
    expect(made).toHaveLength(1);
    // Collected once nothing but the instance holds it
    setFlagsFromString('--expose-gc');
    const gc = runInNewContext('gc') as () => void;
    await new Promise((resolve) => setImmediate(resolve));
    gc();
    await new Promise((resolve) => setImmediate(resolve));
    expect(made[0].deref()).toBeUndefined();
    // The instance goes on: a deletion and a new iterator read as before
    draw.features.delete(draw.features.list()[0].id);
    expect([...draw.features.iterate()]).toHaveLength(2);
  });

  it('reads one attribute of a feature, and throws notFound for an ID that names none', () => {
    const { draw } = instanceOver();
    draw.features.create({ ...point('a'), properties: { kind: 'x', n: 1 } });
    expect(draw.features.getProperty('a', 'kind')).toBe('x');
    expect(draw.features.getProperty('a', 'missing')).toBeUndefined();
    expect(codeOf(() => draw.features.getProperty('nothing', 'kind'))).toBe('notFound');
  });

  it('reads an attribute of a feature written to the Store directly', () => {
    const { draw, store } = instanceOver();
    draw.features.create({ ...point('a'), properties: { kind: 'x' } });
    store.transact(() => {
      store.writeRows({
        rows: Int32Array.of(store.tables.getRowRef('a') as number),
        fields: new Map<FeatureRowField, unknown[]>([['properties:kind', ['y']]]),
      });
    }, 'remote');
    expect(draw.features.getProperty('a', 'kind')).toBe('y');
  });

  it('counts the groups and the features outside them as the items of a layer', () => {
    const { draw } = instanceOver();
    draw.features.createMany([point('a'), point('b'), point('c'), point('d')]);
    const layerId = draw.layers.list()[0].id;
    const group = draw.groups.create({ featureIds: ['b', 'c'] });
    if (!group) throw new Error('no group');
    expect(draw.layers.countItems(layerId)).toBe(3);
    expect(draw.layers.listItemIds(layerId, { start: 0, end: 3 })).toEqual(['a', group.id, 'd']);
    expect(draw.groups.countFeatures(group.id)).toBe(2);
    expect(draw.groups.listFeatureIds(group.id, { start: 0, end: 2 })).toEqual(['b', 'c']);
  });
});

/** The same edits, from features.create to groups.move, on the instance given */
function edit(draw: Draw): void {
  const layerId = draw.layers.list()[0].id;
  const other = draw.layers.create({ id: 'other', name: 'Other' });
  if (!other) throw new Error('no layer');
  draw.features.create(point('a', [0, 0]));
  draw.features.createMany([point('b', [1, 0]), square('c', 2), square('d', 3)]);
  draw.features.update('a', { properties: { n: 1 }, style: { pointColor: '#123456' } });
  draw.features.updateMany([{ id: 'b', patch: { visible: false } }]);
  draw.features.move('a', { layerId: other.id });
  draw.features.moveMany(['b'], { layerId, index: 0 });
  draw.features.union(['c', 'd']);
  draw.metadata.update({ title: 'Edited' });
  draw.layers.update(other.id, { name: 'Renamed' });
  draw.layers.reorder([other.id, layerId]);
  const group = draw.groups.create({ id: 'g', featureIds: ['b'] });
  if (!group) throw new Error('no group');
  draw.groups.update(group.id, { name: 'The group' });
  draw.groups.move(group.id, { layerId: other.id });
  draw.features.delete('a');
}

/** The writes of a Store, recorded as they are called */
const WRITES = [
  'createRows',
  'createRowsFromPages',
  'writeRows',
  'clear',
  'createLayer',
  'updateLayer',
  'deleteLayer',
  'setLayerOrder',
  'createGroup',
  'updateGroup',
  'deleteGroup',
  'createFile',
  'deleteFile',
  'setMetadata',
] as const;

/** The built-in Store spread into an object of its own, with every write taken over and recorded */
function recordingStore(): { store: Store; calls: string[] } {
  const base = createStore();
  const calls: string[] = [];
  const store: Store = { ...base };
  for (const name of WRITES) {
    const write = base[name] as (...args: unknown[]) => unknown;
    (store as unknown as Record<string, unknown>)[name] = (...args: unknown[]) => {
      calls.push(name);
      return write.apply(base, args);
    };
  }
  return { store, calls };
}

describe('a Store spread from the built-in one', () => {
  it('reads and writes as the built-in Store does, with its writes taken over', () => {
    const { store, calls } = recordingStore();
    const built = instanceOver().draw;
    const spread = instanceOver(store).draw;
    edit(built);
    edit(spread);
    expect(spread.document.toJSON()).toEqual(built.document.toJSON());
    expect(spread.features.list()).toEqual(built.features.list());
    expect(spread.groups.list()).toEqual(built.groups.list());
    expect(spread.layers.list()).toEqual(built.layers.list());
    for (const name of [
      'createRows',
      'writeRows',
      'createLayer',
      'updateLayer',
      'setLayerOrder',
      'createGroup',
      'updateGroup',
      'setMetadata',
    ]) {
      expect(calls, name).toContain(name);
    }
  });
});

describe('read-only and the locks', () => {
  it('calls no write of the Store while the document is read-only', async () => {
    const { store, calls } = recordingStore();
    const { draw } = instanceOver(store);
    const layerId = draw.layers.list()[0].id;
    draw.features.createMany([point('a'), point('b'), square('c', 0), square('d', 0.5)]);
    draw.features.create({
      id: 'line',
      type: 'LineString',
      geometry: {
        type: 'LineString',
        coordinates: [
          [0.5, -1],
          [0.5, 2],
        ],
      },
    });
    const group = draw.groups.create({ id: 'g', featureIds: ['b'] });
    if (!group) throw new Error('no group');
    draw.setReadOnly(true);
    calls.length = 0;

    expect(draw.features.create(point('x'))).toBeNull();
    expect(draw.features.createMany([point('y')])).toBeNull();
    expect(draw.features.update('a', { properties: { n: 1 } })).toBeNull();
    expect(draw.features.updateMany([{ id: 'a', patch: { visible: false } }])).toBeNull();
    expect(draw.features.delete('a')).toBe(false);
    expect(draw.features.deleteMany(['a'])).toBe(false);
    expect(draw.features.move('a', { groupId: 'g' })).toBe(false);
    expect(draw.features.moveMany(['a'], { layerId, index: 0 })).toBe(false);
    expect(draw.features.union(['c', 'd'])).toBeNull();
    expect(draw.features.difference('c', ['d'])).toBeNull();
    expect(draw.features.intersection(['c', 'd'])).toBeNull();
    expect(draw.features.split('c', 'line')).toBeNull();
    expect(draw.features.buffer(['a'], { distanceMeters: 10 })).toBeNull();
    expect(draw.layers.create({ name: 'New' })).toBeNull();
    expect(draw.layers.update(layerId, { name: 'Renamed' })).toBeNull();
    expect(draw.layers.reorder([layerId])).toBe(false);
    expect(draw.layers.delete(layerId)).toBe(false);
    expect(draw.groups.create({ featureIds: ['a'] })).toBeNull();
    expect(draw.groups.update('g', { name: 'Renamed' })).toBeNull();
    expect(draw.groups.move('g', { layerId, index: 0 })).toBe(false);
    expect(draw.groups.delete('g')).toBe(false);
    draw.selection.set('feature', ['a', 'c']);
    expect(draw.selection.group()).toBeNull();
    expect(draw.selection.move({ groupId: 'g' })).toBe(false);
    expect(draw.selection.delete()).toBe(false);
    draw.selection.set('group', ['g']);
    expect(draw.selection.ungroup()).toBe(false);
    expect(draw.metadata.update({ title: 'Renamed' })).toBeNull();
    expect(
      await draw.document.load({
        type: 'FeatureCollection',
        features: [{ type: 'Feature', properties: {}, geometry: point('z').geometry }],
      }),
    ).toBeNull();

    expect(calls).toEqual([]);
  });

  it('calls no write of the Store for a locked feature, unless the locks are ignored', () => {
    const { store, calls } = recordingStore();
    const { draw } = instanceOver(store);
    draw.features.create({ ...point('a'), locked: true });
    calls.length = 0;
    expect(draw.features.update('a', { properties: { n: 1 } })).toBeNull();
    expect(draw.features.delete('a')).toBe(false);
    expect(calls).toEqual([]);
    draw.transact(() => draw.features.update('a', { properties: { n: 1 } }), {
      ignoreLocks: true,
    });
    expect(calls).toContain('writeRows');
    expect(draw.features.getProperty('a', 'n')).toBe(1);
  });
});

describe('the Many methods', () => {
  /** The changes the Store tells while `fn` runs */
  function changesDuring(store: Store, fn: () => void): StoreChange[] {
    const changes: StoreChange[] = [];
    const stop = store.subscribe((change) => changes.push(change));
    fn();
    stop();
    return changes;
  }

  it('creates every feature in one transaction, or none', () => {
    const { draw, store } = instanceOver();
    expect(
      changesDuring(store, () => draw.features.createMany([point('a'), point('b')])),
    ).toHaveLength(1);
    expect(codeOf(() => draw.features.createMany([point('c'), point('a')]))).toBe('alreadyExists');
    expect(draw.features.has('c')).toBe(false);
  });

  it('updates every feature in one transaction, or none', () => {
    const { draw, store } = instanceOver();
    draw.features.createMany([point('a'), point('b')]);
    expect(
      changesDuring(store, () =>
        draw.features.updateMany([
          { id: 'a', patch: { properties: { n: 1 } } },
          { id: 'b', patch: { properties: { n: 2 } } },
        ]),
      ),
    ).toHaveLength(1);
    expect(
      codeOf(() =>
        draw.features.updateMany([
          { id: 'a', patch: { properties: { n: 3 } } },
          { id: 'missing', patch: { properties: { n: 4 } } },
        ]),
      ),
    ).toBe('notFound');
    expect(draw.features.getProperty('a', 'n')).toBe(1);
    draw.features.update('b', { locked: true });
    expect(
      draw.features.updateMany([
        { id: 'a', patch: { properties: { n: 5 } } },
        { id: 'b', patch: { properties: { n: 6 } } },
      ]),
    ).toBeNull();
    expect(draw.features.getProperty('a', 'n')).toBe(1);
  });

  it('moves every feature in one transaction, or none', () => {
    const { draw, store } = instanceOver();
    draw.features.createMany([point('a'), point('b'), point('c')]);
    const other = draw.layers.create({ id: 'other', name: 'Other' });
    if (!other) throw new Error('no layer');
    expect(
      changesDuring(store, () => draw.features.moveMany(['a', 'b'], { layerId: other.id })),
    ).toHaveLength(1);
    expect(draw.layers.listItemIds(other.id, { start: 0, end: 2 })).toEqual(['a', 'b']);
    draw.features.update('c', { locked: true });
    expect(draw.features.moveMany(['a', 'c'], { layerId: draw.layers.list()[0].id })).toBe(false);
    expect(draw.features.get('a')?.layerId).toBe(other.id);
  });
});

describe('the groups left empty', () => {
  it('deletes the group the instance takes its last feature out of', () => {
    const { draw } = instanceOver();
    draw.features.createMany([point('a'), point('b')]);
    draw.groups.create({ id: 'g', featureIds: ['a', 'b'] });
    draw.features.move('a', { groupId: null });
    expect(draw.groups.has('g')).toBe(true);
    draw.features.delete('b');
    expect(draw.groups.has('g')).toBe(false);
  });

  it('keeps the group a change written to the Store directly leaves empty', () => {
    const { draw, store } = instanceOver();
    draw.features.createMany([point('a'), point('b')]);
    draw.groups.create({ id: 'g', featureIds: ['a', 'b'] });
    store.transact(() => {
      const rows = rowWrites(store);
      rows.deleteFeature('a');
      rows.deleteFeature('b');
    }, 'remote');
    expect(store.getGroup('g')).toBeDefined();
    expect(draw.groups.has('g')).toBe(true);
    expect(draw.groups.countFeatures('g')).toBe(0);
  });
});

describe('the IDs of features deleted and created again in one transaction', () => {
  /** A document of two layers, a group and features with attributes */
  function drawn(draw: Draw) {
    const front = draw.layers.create({ id: 'front', name: 'Front' });
    if (!front) throw new Error('no layer');
    draw.features.create({ ...square('parcel-1', 0), layerId: 'front', properties: { n: 1 } });
    draw.features.create({ ...square('parcel-2', 2), layerId: 'front', properties: { n: 2 } });
    draw.features.create({ ...point('pin'), layerId: 'front', properties: { label: 'A' } });
    draw.groups.create({ id: 'pair', featureIds: ['parcel-1', 'parcel-2'] });
  }

  it('loads the document saved, replacing the one with the same IDs', async () => {
    const { draw } = instanceOver();
    drawn(draw);
    const saved = draw.document.toJSON();
    // Changed after it was saved: an attribute more, one less, a feature deleted
    draw.features.update('parcel-1', { properties: { n: 10, extra: true } });
    draw.features.update('pin', { properties: {} });
    draw.features.delete('parcel-2');
    const changes: StoreChange[] = [];
    draw.getStore().subscribe((change) => changes.push(change));
    await draw.document.load(saved);
    expect(draw.document.toJSON()).toEqual(saved);
    expect(draw.features.get('parcel-1')?.properties).toEqual({ n: 1 });
    expect(draw.features.get('pin')?.properties).toEqual({ label: 'A' });
    expect(draw.groups.listFeatureIds('pair', { start: 0, end: 10 })).toEqual([
      'parcel-1',
      'parcel-2',
    ]);
    // One change, in which the rows of the IDs there were come back as written
    expect(changes).toHaveLength(1);
    const rows = changes[0].rows?.layers.get('front');
    const refOf = (id: string) => draw.getStore().tables.getRowRef(id) as number;
    expect([...(rows?.updated ?? [])]).toEqual(
      expect.arrayContaining([refOf('parcel-1'), refOf('pin')]),
    );
    expect([...(rows?.created ?? [])]).toContain(refOf('parcel-2'));
  });

  it('creates a feature with the ID of one deleted before it, with its own values only', () => {
    const { draw } = instanceOver();
    draw.features.create({
      ...point('a', [1, 1]),
      properties: { old: 1 },
      style: { pointColor: '#f00' },
    });
    draw.transact(() => {
      draw.features.delete('a');
      draw.features.create({ ...point('a', [2, 2]), properties: { fresh: 2 } });
    });
    expect(draw.features.get('a')).toMatchObject({
      geometry: { type: 'Point', coordinates: [2, 2] },
      properties: { fresh: 2 },
      style: {},
    });
    expect(draw.features.getProperty('a', 'old')).toBeUndefined();
    expect(draw.features.count()).toBe(1);
  });

  it('writes nothing of a createMany refused for an ID in use', () => {
    const { draw, store } = instanceOver();
    draw.features.create(point('a'));
    const before = draw.document.toJSON();
    const writes = vi.spyOn(store, 'createRows');
    expect(codeOf(() => draw.features.createMany([point('b'), point('a')]))).toBe('alreadyExists');
    expect(writes).not.toHaveBeenCalled();
    expect(draw.document.toJSON()).toEqual(before);
  });
});

describe('the keys of the metadata', () => {
  it('writes key by key, deletes a key given undefined, and refuses a value JSON cannot hold', () => {
    const { draw, store } = instanceOver();
    draw.metadata.update({ title: 'A', 'example:author': { id: 1 }, note: 'kept' } as never);
    draw.metadata.update({ title: 'B' });
    expect(store.getMetadata()).toEqual({ title: 'B', 'example:author': { id: 1 }, note: 'kept' });
    draw.metadata.update({ note: undefined } as never);
    expect(store.getMetadata()).toEqual({ title: 'B', 'example:author': { id: 1 } });
    expect(codeOf(() => draw.metadata.update({ 'example:bad': () => 1 } as never))).toBe(
      'invalidInput',
    );
    expect(codeOf(() => draw.metadata.update({ 'example:bad': Number.NaN } as never))).toBe(
      'invalidInput',
    );
    expect(draw.metadata.get()).toEqual({ title: 'B', 'example:author': { id: 1 } });
  });

  it('keeps the keys with a prefix and those without one through toJSON and a load', async () => {
    const { draw } = instanceOver();
    draw.metadata.update({ title: 'T', 'example:author': { id: 1 }, plain: [1, 2] } as never);
    const saved = draw.document.toJSON();
    expect(saved.metadata).toEqual({ title: 'T', 'example:author': { id: 1 }, plain: [1, 2] });
    const reopened = instanceOver().draw;
    await reopened.document.load(saved);
    expect(reopened.metadata.get()).toEqual(saved.metadata);
    expect(reopened.document.toJSON().metadata).toEqual(saved.metadata);
  });
});

describe('an Image created without its size on the map', () => {
  it('holds the zoom of the map now, and keeps the zoom it is given', () => {
    const { draw } = instanceOver();
    const image = (id: string, more: Record<string, unknown> = {}) => ({
      id,
      type: 'Image' as const,
      geometry: { type: 'Point' as const, coordinates: [0, 0] },
      properties: {
        'maplibre-gl-draw:imageWidth': 20,
        'maplibre-gl-draw:imageHeight': 10,
        ...more,
      } as never,
    });
    expect(draw.features.create(image('a'))?.properties['maplibre-gl-draw:createdZoom']).toBe(10);
    draw.features.create(image('b', { 'maplibre-gl-draw:createdZoom': 3 }));
    expect(draw.features.get('b')?.properties['maplibre-gl-draw:createdZoom']).toBe(3);
    expect(
      codeOf(() => draw.features.create(image('c', { 'maplibre-gl-draw:imageWidth': 0 }))),
    ).toBe('invalidInput');
  });
});

describe('a key of the style of an extension', () => {
  it('holds a boolean, null, an array and an object, written alone and kept through a load', async () => {
    const { draw, store } = instanceOver();
    const values: unknown[] = [true, null, [4, 2], { width: 2, dashed: false }];
    draw.features.createMany(
      values.map((value, i) => ({
        ...point(`p${i}`, [i, 0]),
        style: { fillColor: '#f00', 'example:dashed': value } as never,
      })),
    );
    for (const [i, value] of values.entries()) {
      expect(draw.features.get(`p${i}`)?.style).toEqual({
        fillColor: '#f00',
        'example:dashed': value,
      });
    }
    // Updated, the change holds the style it had before; the key is read alone
    const changes: StoreChange[] = [];
    store.subscribe((change) => changes.push(change), { previousValues: true });
    draw.features.update('p0', {
      style: { fillColor: '#f00', 'example:dashed': [false] } as never,
    });
    const ref = store.tables.getRowRef('p0') as number;
    expect(store.tables.readValues(Int32Array.of(ref), ['style:example:dashed']).fields).toEqual(
      new Map([['style:example:dashed', [[false]]]]),
    );
    const layerId = draw.features.get('p0')?.layerId ?? '';
    expect(changes[changes.length - 1]?.previousValues?.get(layerId)?.fields.get('style')).toEqual([
      { fillColor: '#f00', 'example:dashed': true },
    ]);
    // One key written alone to the Store
    store.transact(() => {
      store.writeRows({
        rows: Int32Array.of(store.tables.getRowRef('p1') as number),
        fields: new Map([['style:example:dashed', [{ on: true }]]]),
      });
    }, 'remote');
    expect(draw.features.get('p1')?.style).toEqual({
      fillColor: '#f00',
      'example:dashed': { on: true },
    });
    // Saved and loaded, every value is the same
    const saved = draw.document.toJSON();
    const reopened = instanceOver().draw;
    await reopened.document.load(saved);
    const styles = ['p0', 'p1', 'p2', 'p3'].map((id) => draw.features.get(id)?.style);
    expect(['p0', 'p1', 'p2', 'p3'].map((id) => reopened.features.get(id)?.style)).toEqual(styles);
    expect(styles.map((style) => (style as Record<string, unknown>)['example:dashed'])).toEqual([
      [false],
      { on: true },
      [4, 2],
      { width: 2, dashed: false },
    ]);
  });
});

describe('the events of a change written to the Store directly', () => {
  it('lets a listener update features and write to the Store, and reads what it wrote', () => {
    const { draw, store } = instanceOver();
    draw.features.createMany([point('a'), point('b')]);
    let ran = false;
    draw.on('feature.updated', ({ feature }) => {
      if (feature.id !== 'a' || ran) return;
      ran = true;
      draw.features.update('b', { properties: { from: 'listener' } });
      store.transact(() => {
        store.writeRows({
          rows: Int32Array.of(store.tables.getRowRef('b') as number),
          fields: new Map<FeatureRowField, unknown[]>([['properties:store', [true]]]),
        });
      }, 'remote');
    });
    expect(() =>
      store.transact(() => {
        store.writeRows({
          rows: Int32Array.of(store.tables.getRowRef('a') as number),
          fields: new Map<FeatureRowField, unknown[]>([['properties:n', [1]]]),
        });
      }, 'remote'),
    ).not.toThrow();
    expect(ran).toBe(true);
    expect(draw.features.get('b')?.properties).toEqual({ from: 'listener', store: true });
    expect(draw.features.getProperty('a', 'n')).toBe(1);
  });

  it('lets a listener create a new feature with the ID of a deleted one', () => {
    const { draw, store } = instanceOver();
    draw.features.create(point('a', [1, 1]));
    let created: Feature | null = null;
    draw.on('feature.deleted', ({ feature }) => {
      created = draw.features.create(point(feature.id, [2, 2]));
    });
    store.transact(() => rowWrites(store).deleteFeature('a'), 'remote');
    expect(created).not.toBeNull();
    expect(draw.features.get('a')?.geometry).toEqual({ type: 'Point', coordinates: [2, 2] });
  });
});
