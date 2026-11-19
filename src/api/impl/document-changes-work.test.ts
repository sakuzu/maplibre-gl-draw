// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The work of the changes of the document in the words of the features, which does not grow with
 * the number of features
 *
 * Each scene runs on an instance over 1,000 and over 10,000 points. What the notification of a
 * change does is counted from the first subscriber of the layer over the Store to the last: the
 * events of a second emitter connected to the layer between them, with the listeners the scene
 * gives it (the instance itself has none). What goes through the Store the instance was given is
 * counted by the counting Store.
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  createCountedInstance,
  expectNotProportional,
  gridPoints,
  WORK_SIZES,
} from '../../test-utils.js';
import type { DocumentChange } from '../events.js';
import type { Feature, FeatureValues } from '../model.js';
import { connectStoreEvents, createEventHub, type EventHub } from './events.js';
import { type SharedValues, sharedValuesOf } from './feature-values.js';

type Instance = ReturnType<typeof createCountedInstance>;

const instances: Instance[] = [];

afterEach(() => {
  for (const instance of instances.splice(0)) instance.draw.destroy();
});

/** An instance over `size` points, with their IDs */
function instanceOf(size: number): { instance: Instance; ids: string[] } {
  const instance = createCountedInstance();
  instances.push(instance);
  const ids = (instance.draw.features.createMany(gridPoints(size)) as Feature[]).map((f) => f.id);
  return { instance, ids };
}

/**
 * Connects an emitter of its own to the layer over the Store of the instance, between two
 * subscribers that count the objects made while a change is told
 */
function notificationsOf(instance: Instance, listen: (hub: EventHub) => void) {
  const layer = instance.engine.context.store;
  const { counts } = instance;
  let start: number | null = null;
  let made = 0;
  layer.subscribe(() => {
    start = counts.objectsCreated;
  });
  const hub = createEventHub();
  listen(hub);
  connectStoreEvents(hub, layer);
  layer.subscribe(() => {
    if (start !== null) made += counts.objectsCreated - start;
    start = null;
  });
  return {
    hub,
    /** The objects made while the changes were told, since the last call */
    made(): number {
      const out = made;
      made = 0;
      return out;
    },
  };
}

/** What a scene measured, built once per size */
function measured<T>(measure: (size: number) => T): (size: number) => T {
  const results = new Map<number, T>();
  return (size) => {
    let result = results.get(size);
    if (result === undefined) {
      result = measure(size);
      results.set(size, result);
    }
    return result;
  };
}

/** The calls of a method of the Store and its tables while `fn` ran */
function callsDuring(instance: Instance, name: string, fn: () => void): number {
  const before = instance.storeWork.calls.get(name) ?? 0;
  fn();
  return (instance.storeWork.calls.get(name) ?? 0) - before;
}

describe('the notification of one write', () => {
  it('makes as many objects in a document of 10,000 features as in one of 1,000', () => {
    expectNotProportional((size) => {
      const { instance, ids } = instanceOf(size);
      const told = notificationsOf(instance, (hub) => {
        hub.on('document.changed', () => {});
        hub.on('feature.updated', () => {});
        hub.on('feature.moved', () => {});
      });
      instance.draw.features.update(ids[5], { properties: { name: 'one' } });
      return told.made();
    }, 'the objects made by the notification');
  });
});

describe('the notification of a change of every feature', () => {
  const scene = measured((size) => {
    const { instance, ids } = instanceOf(size);
    const quiet = notificationsOf(instance, () => {});
    const patches = ids.map((id) => ({ id, patch: { properties: { name: 'all' } } }));
    instance.draw.features.updateMany(patches);
    const withoutListeners = quiet.made();
    const told = notificationsOf(instance, (hub) => hub.on('document.changed', () => {}));
    let updated = 0;
    told.hub.on('document.changed', (change) => {
      updated = change.features.updated.count();
    });
    instance.draw.features.updateMany(
      ids.map((id) => ({ id, patch: { properties: { name: 'again' } } })),
    );
    return { withoutListeners, withChange: told.made(), updated };
  });

  it('makes no feature without a listener of the events of the features', () => {
    expect(scene(WORK_SIZES.small).withoutListeners).toBe(0);
    expect(scene(WORK_SIZES.large).withoutListeners).toBe(0);
    expectNotProportional((size) => scene(size).withoutListeners, 'the features made', {
      zero: true,
    });
  });

  it('makes as many arrays for the sets of document.changed', () => {
    expect(scene(WORK_SIZES.large).updated).toBe(WORK_SIZES.large);
    expectNotProportional((size) => scene(size).withChange, 'the arrays made for the sets');
  });
});

describe('the notification of a deletion of every feature', () => {
  /**
   * The IDs read from the rows while every feature is deleted, with a listener of
   * `document.changed` and a set of an earlier change still held
   */
  const scene = measured((size) => {
    const { instance, ids } = instanceOf(size);
    const held: DocumentChange[] = [];
    const stop = instance.draw.document.subscribe((change) => held.push(change));
    instance.draw.features.update(ids[5], { properties: { name: 'held' } });
    stop();
    instance.draw.on('document.changed', () => {});
    const read = callsDuring(instance, 'getRowId', () => instance.draw.features.deleteMany(ids));
    return { read, held: [...held[0].features.updated.iterate()], expected: ids[5] };
  });

  it('reads as many IDs from the rows for 10,000 features as for 1,000', () => {
    expectNotProportional((size) => scene(size).read, 'the IDs read from the rows');
  });

  it('keeps the IDs of the set held', () => {
    for (const size of [WORK_SIZES.small, WORK_SIZES.large]) {
      expect(scene(size).held).toEqual([scene(size).expected]);
    }
  });
});

describe('the values before of the subscribers that ask for them', () => {
  /** The bytes of the arrays the values of the subscribers hold, each held once counted once */
  const heldBytes = (subscribers: number): { bytes: number; shared: Set<SharedValues> } => {
    const { instance, ids } = instanceOf(WORK_SIZES.small);
    const values: FeatureValues[] = [];
    for (let i = 0; i < subscribers; i++) {
      instance.draw.document.subscribe(
        (change) => {
          if (change.previousValues) values.push(change.previousValues);
        },
        { previousValues: true },
      );
    }
    instance.draw.features.updateMany(
      ids.map((id) => ({ id, patch: { properties: { name: 'before' } } })),
    );
    const shared = new Set(values.map((value) => sharedValuesOf(value) as SharedValues));
    let bytes = 0;
    for (const one of shared) bytes += one.byteLength;
    expect(values).toHaveLength(subscribers);
    return { bytes, shared };
  };

  it('hold the same arrays for three subscribers as for one', () => {
    const one = heldBytes(1);
    const three = heldBytes(3);
    expect(three.shared.size).toBe(1);
    expect(one.bytes).toBeGreaterThan(0);
    expect(three.bytes / one.bytes).toBeLessThan(2);
  });
});
