// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for a Store of the application: the instance reaches it only through the members of the
 * public Store, and keeps the state of this client itself (the Store holds the document)
 *
 * The Store of the application is the built-in Store spread into an object of its own.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore } from '../../store/built-in/create-store.js';
import type { Store, StoreChange } from '../../store/built-in/types.js';
import { createMapStub, createSyntheticInput, rowWrites } from '../../test-utils.js';
import type { Draw } from '../draw.js';
import type { Feature } from '../model.js';
import { createDrawOnEngine } from './create-draw.js';
import type { Engine } from './engine.js';
import { createEngine } from './engine.js';

/** Every member of the public Store */
const CONTRACT: ReadonlySet<string> = new Set<keyof Store>([
  'tables',
  'getLayer',
  'listLayers',
  'getLayerOrder',
  'getGroup',
  'listGroups',
  'getFile',
  'listFiles',
  'getMetadata',
  'listPropertyKeys',
  'subscribe',
  'transact',
  'createRows',
  'createRowsFromPages',
  'writeRows',
  'releaseDeletedRows',
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
  'newOperationId',
]);

/**
 * A Store of the application with the members of the public Store only: reaching any other
 * member fails the test, and the calls of the writes are recorded
 */
function contractOnly(): { store: Store; calls: string[]; strays: string[] } {
  const inner: Store = { ...createStore() };
  const calls: string[] = [];
  const strays: string[] = [];
  const store = new Proxy(inner, {
    get(target, key) {
      if (typeof key !== 'string' || !CONTRACT.has(key)) {
        if (typeof key === 'string' && key !== 'then') strays.push(key);
        return undefined;
      }
      const value = Reflect.get(target, key, target) as unknown;
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        if (/^(set|start|end|create|update|delete|reorder)/.test(key)) calls.push(key);
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  }) as unknown as Store;
  return { store, calls, strays };
}

let engine: Engine;
let draw: Draw;
let host: ReturnType<typeof contractOnly>;

beforeEach(() => {
  vi.useFakeTimers();
  host = contractOnly();
  engine = createEngine(createMapStub().map, { store: host.store }, { deferDefaultMode: true });
  draw = createDrawOnEngine(engine, { store: host.store });
  engine.enterDefaultMode();
});

afterEach(() => {
  draw.destroy();
  vi.useRealTimers();
});

describe('a Store of the application', () => {
  it('is reached through the members of the public Store only', async () => {
    const line = draw.features.create({
      type: 'LineString',
      geometry: {
        type: 'LineString',
        coordinates: [
          [0, 0],
          [1, 1],
        ],
      },
    }) as Feature;
    const point = draw.features.create({
      type: 'Point',
      geometry: { type: 'Point', coordinates: [0.5, 0.5] },
    }) as Feature;
    draw.selection.set('feature', [line.id]);
    draw.vertexSelection.set(line.id, [{ ring: 0, index: 1 }]);
    draw.hidden.add(point.id);
    draw.groups.create({ featureIds: [line.id] });
    draw.setMode('drawLine');
    const input = createSyntheticInput(engine);
    input.click([0.2, 0.2]);
    input.click([0.4, 0.2]);
    input.key('Escape');
    draw.setMode('select');
    draw.setInteractionLocked(true);
    draw.setInteractionLocked(false);
    draw.setReadOnly(true);
    draw.setReadOnly(false);
    await draw.document.load({
      type: 'FeatureCollection',
      features: [
        { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [1, 2] } },
      ],
    });
    draw.features.delete(point.id);
    draw.document.toJSON();

    expect(host.strays).toEqual([]);
  });

  it('keeps the writes of the state of this client in the instance, not in the contract', () => {
    const feature = draw.features.create({
      type: 'Point',
      geometry: { type: 'Point', coordinates: [0, 0] },
    }) as Feature;
    host.calls.length = 0;
    draw.selection.set('feature', [feature.id]);
    draw.hidden.add(feature.id);
    draw.setMode('drawPoint');
    draw.setMode('select');
    draw.setInteractionLocked(true);
    draw.setReadOnly(true);

    // The Store holds the document only: none of these writes reaches it (CHANGES 119)
    const clientWrites = [
      'setSelection',
      'setLocallyHidden',
      'setMode',
      'setInteractionLock',
      'setReadOnly',
    ];
    expect(host.calls.filter((call) => clientWrites.includes(call))).toEqual([]);
    expect(draw.hidden.has(feature.id)).toBe(true);
    expect(draw.isReadOnly()).toBe(true);
    expect(draw.isInteractionLocked()).toBe(true);
    // Hiding the selected feature took it out of the selection, in the instance
    expect(draw.selection.get()).toEqual({ type: null, ids: [] });
  });
});

describe('a Store of the application that holds names with numbers', () => {
  it('numbers a new layer and a drawn point after them', () => {
    // The Store holds a layer and a point whose names carry numbers before the instance is made
    const store: Store = { ...createStore() };
    store.transact(() => {
      store.createLayer({
        id: 'held',
        name: 'Layer 6',
        visible: true,
        locked: false,
        opacity: 1,
        styleRule: undefined,
        metadata: undefined,
      });
      rowWrites(store).createFeature({
        id: 'held-point',
        type: 'Point',
        geometry: { type: 'Point', coordinates: [0.6, 0.6] },
        layerId: 'held',
        groupId: undefined,
        properties: { name: 'Point 20' },
        style: {},
        visible: true,
        locked: false,
      });
    }, 'remote');
    const own = createEngine(createMapStub().map, { store }, { deferDefaultMode: true });
    const ownDraw = createDrawOnEngine(own, { store });
    own.enterDefaultMode();

    const layer = ownDraw.layers.create({});
    ownDraw.layers.setActive(layer?.id as string);
    ownDraw.setMode('drawPoint');
    createSyntheticInput(own).click([0.2, 0.2]);

    expect(store.listLayers().map((l) => l.name)).toContain('Layer 7');
    expect(ownDraw.features.list().map((feature) => feature.properties.name)).toContain('Point 21');
    ownDraw.destroy();
  });
});

/** Undoes a change of the document in one transaction of the Store, from what it carries */
function undo(store: Store, change: StoreChange): void {
  store.transact(() => {
    for (const rows of change.rows?.layers.values() ?? []) {
      if (rows.created.length === 0) continue;
      store.writeRows({
        rows: rows.created,
        fields: new Map(),
        deleted: new Uint8Array(rows.created.length).fill(1),
      });
    }
    for (const group of change.groups?.created ?? []) store.deleteGroup(group.id);
    for (const layer of change.layers?.created ?? []) store.deleteLayer(layer.id);
    for (const { id, previous } of change.layers?.updated ?? []) {
      if (store.getLayer(id)) store.updateLayer(id, previous);
    }
    const order = change.layers?.orderChanged;
    if (order) store.setLayerOrder(order.previous);
  }, 'remote');
}

describe('a load into a Store of the application', () => {
  it('writes the new layers and group of loadMany as one change, undone at once', async () => {
    const collection = (...ids: string[]) => ({
      type: 'FeatureCollection' as const,
      features: ids.map((id, i) => ({
        type: 'Feature' as const,
        id,
        properties: {},
        geometry: { type: 'Point' as const, coordinates: [i, i] },
      })),
    });
    const before = draw.document.toJSON();
    const changes: StoreChange[] = [];
    const unsubscribe = host.store.subscribe((change) => changes.push(change));
    const results = await draw.document.loadMany([
      { source: collection('a'), options: { layer: { name: 'roads.geojson' } } },
      {
        source: collection('b', 'c'),
        options: { layer: { name: 'shops.geojson' }, group: { name: 'town' } },
      },
    ]);
    expect(changes).toHaveLength(1);
    const [roads, shops] = results ?? [];
    expect(draw.features.get('a')?.layerId).toBe(roads?.layerId);
    expect(draw.groups.get(shops?.groupId ?? '')).toMatchObject({
      name: 'town',
      layerId: shops?.layerId,
    });
    expect(draw.groups.listFeatureIds(shops?.groupId ?? '', { start: 0, end: 2 })).toEqual([
      'b',
      'c',
    ]);
    expect(draw.features.get('b')).toMatchObject({
      layerId: shops?.layerId,
      groupId: shops?.groupId,
    });

    undo(host.store, changes[0]);
    unsubscribe();
    expect(changes).toHaveLength(2);
    expect(draw.document.toJSON()).toEqual(before);
  });
});
