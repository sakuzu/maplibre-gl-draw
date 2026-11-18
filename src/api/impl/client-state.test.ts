// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for the state of this client held by the instance: the selection, the editing marks, the
 * mode, read-only, the interaction lock and the hidden items live in the instance, whatever Store
 * it is given, and keep their rules when the Store changes from elsewhere; the sets of IDs the
 * instance hands out; and the work of changing that state, which does not grow with the document
 */

import type { Map as MapLibreMap } from 'maplibre-gl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EngineModeContext, EngineModeHandler } from '../../modes/handler.js';
import { ModeManagerImpl } from '../../modes/manager.js';
import { ClientState } from '../../store/memory/ui-state.js';
import { MemoryContractStore } from '../../store/memory.js';
import {
  createCountedInstance,
  createMapStub,
  createSyntheticInput,
  expectNotProportional,
  gridPoints,
  storeWorkDuring,
  WORK_SCENES,
  workDuring,
} from '../../test-utils.js';
import { createRenderCoordinator } from '../../view/coordinator.js';
import { createDraw, type Draw } from '../draw.js';
import { DrawError } from '../errors.js';
import type { DrawEvents } from '../events.js';
import type { Store } from '../extension/store.js';
import type { Feature, IdSet } from '../model.js';
import { createIdSet } from '../model.js';
import { createDrawOnEngine } from './create-draw.js';
import { createEngine } from './engine.js';

/** The members of the state of this client the Store of the published version had */
const CLIENT_MEMBERS = [
  'getSelection',
  'getEditingIds',
  'getVertexSelection',
  'getMode',
  'isReadOnly',
  'isInteractionLocked',
  'isHidden',
  'listHidden',
  'setSelection',
  'startEditing',
  'endEditing',
  'setSelectedVertices',
  'setMode',
  'setReadOnly',
  'setInteractionLock',
  'setLocallyHidden',
] as const;

/**
 * A Store of the application: the in-memory Store of the main entry, wrapped by spreading its
 * members into an object of its own, with the members of the state of this client of the
 * published version added as spies that must never be called
 */
function wrappedStore() {
  const inner = new MemoryContractStore();
  const members: Record<string, unknown> = {};
  let proto: object | null = Object.getPrototypeOf(inner);
  while (proto && proto !== Object.prototype) {
    for (const name of Object.getOwnPropertyNames(proto)) {
      const value = (inner as unknown as Record<string, unknown>)[name];
      if (name !== 'constructor' && typeof value === 'function' && !(name in members)) {
        members[name] = (value as (...args: unknown[]) => unknown).bind(inner);
      }
    }
    proto = Object.getPrototypeOf(proto);
  }
  const spies = Object.fromEntries(CLIENT_MEMBERS.map((name) => [name, vi.fn()]));
  const store = { ...members, ...spies } as unknown as Store;
  return { store, spies };
}

const point = (id: string, lng = 0, lat = 0) => ({
  id,
  type: 'Point' as const,
  geometry: { type: 'Point' as const, coordinates: [lng, lat] },
});

const draws: Draw[] = [];
beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  for (const draw of draws.splice(0)) draw.destroy();
  vi.useRealTimers();
});

describe('the state of this client with a Store of the application', () => {
  it('lives in the instance: the selection, the mode, read-only and the hidden items work, and no member of the state of this client of the Store is called', () => {
    const { store, spies } = wrappedStore();
    const engine = createEngine(createMapStub().map, { store }, { deferDefaultMode: true });
    const draw = createDrawOnEngine(engine, { store });
    engine.enterDefaultMode();
    draws.push(draw);
    draw.features.create(point('a'));
    draw.features.create(point('b', 1, 1));

    // A click of the user selects through the select mode
    createSyntheticInput(engine).click([1, 1]);
    expect(draw.selection.get()).toEqual({ type: 'feature', ids: ['b'] });
    draw.selection.set('feature', ['a', 'b']);
    expect(draw.selection.get()).toEqual({ type: 'feature', ids: ['a', 'b'] });
    draw.vertexSelection.clear();
    expect(draw.setMode('drawPoint')).toBe(true);
    expect(draw.getMode()).toBe('drawPoint');
    draw.setMode('select');
    // A drawing mode clears the selection as it is entered
    expect(draw.selection.get()).toEqual({ type: null, ids: [] });
    draw.selection.set('feature', ['a', 'b']);
    draw.hidden.add('b');
    expect(draw.hidden.has('b')).toBe(true);
    // Hiding a selected feature takes it out of the selection
    expect(draw.selection.get()).toEqual({ type: 'feature', ids: ['a'] });
    draw.editingFeatures.add(['a']);
    expect(draw.editingFeatures.get().toArray()).toEqual(['a']);
    draw.setInteractionLocked(true);
    expect(draw.isInteractionLocked()).toBe(true);
    draw.setInteractionLocked(false);
    draw.setReadOnly(true);
    expect(draw.isReadOnly()).toBe(true);
    // Read-only refuses the writes of the document
    expect(draw.features.create(point('c'))).toBeNull();
    expect(store.getFeature('c')).toBeUndefined();
    draw.setReadOnly(false);
    expect(draw.features.create(point('c'))).not.toBeNull();

    for (const [name, spy] of Object.entries(spies)) {
      expect(spy, `the Store was asked ${name}`).not.toHaveBeenCalled();
    }
  });

  it('loses the features a change made outside the instance deleted: from the selection, the editing marks and the hidden items', () => {
    const { store } = wrappedStore();
    const draw = createDraw(createMapStub().map, { store });
    draws.push(draw);
    for (const id of ['a', 'b', 'c']) draw.features.create(point(id));
    draw.selection.set('feature', ['a', 'b']);
    draw.editingFeatures.add(['a', 'c']);
    draw.hidden.add('c');
    const hidden: string[][] = [];
    const editing: string[][] = [];
    draw.on('hidden.changed', ({ ids }) => hidden.push(ids.toArray()));
    draw.on('editingFeatures.changed', ({ ids }) => editing.push(ids.toArray()));

    store.transact(() => {
      store.deleteFeature('a');
      store.deleteFeature('c');
    }, 'remote');

    expect(draw.selection.get()).toEqual({ type: 'feature', ids: ['b'] });
    expect(draw.editingFeatures.get().toArray()).toEqual([]);
    expect(draw.hidden.list().toArray()).toEqual([]);
    expect(hidden).toEqual([[]]);
    expect(editing).toEqual([[]]);
  });
});

describe('draw.editingFeatures', () => {
  function instance(): Draw {
    const draw = createDraw(createMapStub().map);
    draws.push(draw);
    return draw;
  }

  it('adds, removes and reads the marks, and tells each change with the whole set', () => {
    const draw = instance();
    for (const id of ['a', 'b', 'c']) draw.features.create(point(id));
    const told: string[][] = [];
    draw.on('editingFeatures.changed', ({ ids }) => told.push(ids.toArray()));

    draw.editingFeatures.add(['a', 'b']);
    draw.editingFeatures.add(['b', 'c']);
    draw.editingFeatures.remove(['a', 'x']);
    draw.editingFeatures.remove(['x']);

    expect(draw.editingFeatures.get().toArray()).toEqual(['b', 'c']);
    expect(told).toEqual([
      ['a', 'b'],
      ['a', 'b', 'c'],
      ['b', 'c'],
    ]);
  });

  it('marks none when one of the IDs is not a feature', () => {
    const draw = instance();
    draw.features.create(point('a'));
    const group = draw.groups.create({ featureIds: ['a'] });
    expect(() => draw.editingFeatures.add(['a', 'missing'])).toThrow(
      expect.objectContaining({ code: 'notFound' }),
    );
    expect(() => draw.editingFeatures.add([group?.id ?? ''])).toThrow(DrawError);
    expect(draw.editingFeatures.get().count()).toBe(0);
  });

  it('tells the marked features to the plugins as created, and takes the marks off, when the select mode is entered', () => {
    const draw = instance();
    for (const id of ['a', 'b']) draw.features.create(point(id));
    const committed: string[] = [];
    draw.extensions.plugins.add({
      name: 'commit-probe',
      onAdd() {},
      interaction: {
        onDrawCommit(feature: Feature) {
          committed.push(feature.id);
        },
      },
    });
    draw.setMode('drawLine');
    draw.editingFeatures.add(['a', 'b']);
    expect(committed).toEqual([]);

    draw.setMode('select');

    expect(committed).toEqual(['a', 'b']);
    expect(draw.editingFeatures.get().count()).toBe(0);
  });
});

describe('IdSet', () => {
  it('counts, answers has, iterates and gives an array, in the order given, each ID once', () => {
    const set = createIdSet(['b', 'a', 'b', 'c']);
    expect(set.count()).toBe(3);
    expect(set.has('a')).toBe(true);
    expect(set.has('d')).toBe(false);
    expect([...set.iterate()]).toEqual(['b', 'a', 'c']);
    expect(set.toArray()).toEqual(['b', 'a', 'c']);
  });

  it('is the set as it was given: changing what it was made from or the array it gave changes nothing', () => {
    const ids = ['a', 'b'];
    const set = createIdSet(ids);
    ids.push('c');
    set.toArray().push('d');
    expect(set.toArray()).toEqual(['a', 'b']);
    expect(set.has('c')).toBe(false);
  });

  it('throws tooManyItems for an array of more than 10,000 IDs, and still iterates them', () => {
    const many = createIdSet(Array.from({ length: 10_001 }, (_, i) => `f${i}`));
    expect(() => many.toArray()).toThrow(expect.objectContaining({ code: 'tooManyItems' }));
    expect(many.count()).toBe(10_001);
    let read = 0;
    for (const _ of many.iterate()) read++;
    expect(read).toBe(10_001);
    expect(createIdSet(Array.from({ length: 10_000 }, (_, i) => `f${i}`)).toArray()).toHaveLength(
      10_000,
    );
  });

  it('given by hidden.list and hidden.changed, stays as it was when it was given', () => {
    const draw = createDraw(createMapStub().map);
    draws.push(draw);
    for (const id of ['a', 'b']) draw.features.create(point(id));
    const told: IdSet[] = [];
    draw.on('hidden.changed', ({ ids }: DrawEvents['hidden.changed']) => told.push(ids));
    draw.hidden.add('a');
    const listed = draw.hidden.list();

    draw.hidden.add('b');
    draw.hidden.remove('a');

    expect(listed.toArray()).toEqual(['a']);
    expect(listed.count()).toBe(1);
    expect(told.map((ids) => ids.toArray())).toEqual([['a'], ['a', 'b'], ['b']]);
    expect(draw.hidden.list().toArray()).toEqual(['b']);
  });
});

describe('the subscribers of the state of this client', () => {
  /** A handler that records its start and its stop */
  function handler(log: string[], name: string): EngineModeHandler {
    return {
      onStart: () => {
        log.push(`start ${name}`);
      },
      onStop: () => {
        log.push(`stop ${name}`);
      },
    } as unknown as EngineModeHandler;
  }

  it('the mode manager switches the handler when the mode of the state changes, with no Store', () => {
    const client = new ClientState();
    const manager = new ModeManagerImpl({ client });
    manager.setContext({} as EngineModeContext);
    const log: string[] = [];
    manager.registerMode('select', () => handler(log, 'select'));
    manager.registerMode('drawLine', () => handler(log, 'drawLine'));
    manager.start();

    client.setMode('drawLine');
    expect(manager.getMode()).toBe('drawLine');
    client.setMode('select');

    expect(log).toEqual([
      'start select',
      'stop select',
      'start drawLine',
      'stop drawLine',
      'start select',
    ]);
    manager.stop();
  });

  it('the rendering asks for a frame when only the selection changes, with no notification of the Store', () => {
    const client = new ClientState();
    const triggerRepaint = vi.fn();
    const coordinator = createRenderCoordinator({
      map: { triggerRepaint } as unknown as MapLibreMap,
      store: { client, subscribe: () => () => {} },
    });
    coordinator.start();

    client.setSelection('feature', ['a']);
    expect(triggerRepaint).toHaveBeenCalledTimes(1);
    client.setMode('drawLine');
    expect(triggerRepaint).toHaveBeenCalledTimes(1);
    coordinator.stop();
    client.setSelection(null, []);
    expect(triggerRepaint).toHaveBeenCalledTimes(1);
  });
});

describe('the work of the state of this client, for 1,000 and 10,000 features', () => {
  const instances: ReturnType<typeof createCountedInstance>[] = [];
  afterEach(() => {
    for (const instance of instances.splice(0)) instance.draw.destroy();
  });

  /** An instance over `size` points */
  function instanceOf(size: number) {
    const instance = createCountedInstance();
    instance.draw.features.createMany(gridPoints(size));
    instances.push(instance);
    return instance;
  }

  /** What changing the state for one feature counts, at a size */
  function measure(size: number, change: (draw: Draw, id: string) => void) {
    const instance = instanceOf(size);
    const id = instance.draw.features.list()[5].id;
    let counted = workDuring(instance.counts, () => {});
    const read = storeWorkDuring(instance.storeWork, () => {
      counted = workDuring(instance.counts, () => change(instance.draw, id));
    });
    return { ...counted, featuresRead: read.featuresRead };
  }

  const scenes: [string, (draw: Draw, id: string) => void, (draw: Draw, id: string) => boolean][] =
    [
      [
        WORK_SCENES.select,
        (draw, id) => draw.selection.set('feature', [id]),
        (draw, id) => draw.selection.get().ids.includes(id),
      ],
      ['hide one feature', (draw, id) => draw.hidden.add(id), (draw, id) => draw.hidden.has(id)],
      [
        'mark one feature as being edited',
        (draw, id) => draw.editingFeatures.add([id]),
        (draw, id) => draw.editingFeatures.get().has(id),
      ],
    ];

  for (const [name, change, done] of scenes) {
    describe(name, () => {
      const results = new Map<number, ReturnType<typeof measure>>();
      const at = (size: number) => {
        let result = results.get(size);
        if (!result) {
          result = measure(size, (draw, id) => {
            change(draw, id);
            if (!done(draw, id)) throw new Error(`${name} did not change the state`);
          });
          results.set(size, result);
        }
        return result;
      };

      it('reads as many features through the Store', () => {
        expectNotProportional((size) => at(size).featuresRead, 'the features read');
      });

      it('makes no feature', () => {
        expectNotProportional((size) => at(size).objectsCreated, 'the features made', {
          zero: true,
        });
      });

      it('notifies as often', () => {
        expectNotProportional((size) => at(size).notifications, 'the notifications');
      });
    });
  }
});
