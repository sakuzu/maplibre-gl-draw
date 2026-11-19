// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The work of the reads and the writes of a few features over a document of rows, which does
 * not grow with the number of features
 *
 * Each scene runs on an instance over 1,000 and over 10,000 points, and what it counts (the
 * marks of the Store and of the instance, and what goes through the Store the instance was
 * given) must grow less than twice.
 */

import { afterEach, describe, expect, it } from 'vitest';
import type { WorkCounts } from '../../shared/work-counts.js';
import {
  createCountedInstance,
  expectNotProportional,
  gridPoints,
  storeWorkDuring,
  WORK_SIZES,
  workDuring,
} from '../../test-utils.js';
import type { Feature } from '../model.js';

const instances: ReturnType<typeof createCountedInstance>[] = [];

afterEach(() => {
  for (const instance of instances.splice(0)) instance.draw.destroy();
});

type Instance = ReturnType<typeof createCountedInstance>;

/** An instance over `size` points, with their IDs in the order they were created */
function instanceOf(size: number): { instance: Instance; ids: string[]; layerId: string } {
  const instance = createCountedInstance();
  instances.push(instance);
  const ids = (instance.draw.features.createMany(gridPoints(size)) as Feature[]).map((f) => f.id);
  return { instance, ids, layerId: instance.draw.layers.list()[0].id };
}

/** What the marks counted and what went through the Store while `fn` ran */
function workOf(
  instance: Instance,
  fn: () => void,
): WorkCounts & { featuresRead: number; featuresWritten: number } {
  let counted: WorkCounts | undefined;
  const through = storeWorkDuring(instance.storeWork, () => {
    counted = workDuring(instance.counts, fn);
  });
  return { ...(counted as WorkCounts), ...through };
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

/**
 * An instance over `size` points, then 1,024 points more in a layer in front of theirs: the
 * features the instance keeps made are then those of the 1,024, so that the points of the
 * first layer are read from their rows (`ids` are the IDs of the first layer)
 */
function instanceWithout(size: number) {
  const made = instanceOf(size);
  const front = made.instance.draw.layers.create({ name: 'Front' });
  if (!front) throw new Error('no layer');
  made.instance.draw.features.createMany(
    gridPoints(1_024).map((input) => ({ ...input, layerId: front.id })),
  );
  return made;
}

/** The calls of a method of the Store and its tables while `fn` ran */
function callsDuring(instance: Instance, name: string, fn: () => void): number {
  const before = instance.storeWork.calls.get(name) ?? 0;
  fn();
  return (instance.storeWork.calls.get(name) ?? 0) - before;
}

describe('features.get of one feature', () => {
  const scene = measured((size) => {
    const { instance, ids } = instanceWithout(size);
    return workOf(instance, () => instance.draw.features.get(ids[0]));
  });

  it('touches as many rows', () => {
    expectNotProportional((size) => scene(size).rowsTouched + scene(size).featuresRead, 'rows');
  });

  it('makes as many features', () => {
    expectNotProportional((size) => scene(size).objectsCreated, 'the objects made');
  });
});

describe('features.getProperty of one feature', () => {
  const scene = measured((size) => {
    const { instance, ids } = instanceWithout(size);
    let keysRead = 0;
    const work = workOf(instance, () => {
      // Making a feature reads the keys of the attributes of its row
      keysRead = callsDuring(instance, 'listPropertyKeys', () =>
        instance.draw.features.getProperty(ids[0], 'name'),
      );
    });
    return { ...work, keysRead };
  });

  it('makes no feature', () => {
    expect(scene(WORK_SIZES.small).keysRead).toBe(0);
    expect(scene(WORK_SIZES.large).keysRead).toBe(0);
  });

  it('touches as many rows', () => {
    expectNotProportional((size) => scene(size).rowsTouched + scene(size).featuresRead, 'rows');
  });
});

describe('the items of a layer', () => {
  const scene = measured((size) => {
    const { instance, layerId } = instanceOf(size);
    const count = workOf(instance, () => instance.draw.layers.countItems(layerId));
    const range = workOf(instance, () =>
      instance.draw.layers.listItemIds(layerId, { start: 0, end: 100 }),
    );
    return { count, range };
  });

  it('are counted touching as many rows', () => {
    expectNotProportional(
      (size) => scene(size).count.rowsTouched + scene(size).count.featuresRead,
      'rows',
      { zero: true },
    );
  });

  it('are listed by a range of 100 touching as many rows', () => {
    expectNotProportional(
      (size) => scene(size).range.rowsTouched + scene(size).range.featuresRead,
      'rows',
      { zero: true },
    );
  });
});

describe('features.iterate', () => {
  const scene = measured((size) => {
    const { instance, ids } = instanceWithout(size);
    let first: Feature | undefined;
    let keysRead = 0;
    const work = workOf(instance, () => {
      keysRead = callsDuring(instance, 'listPropertyKeys', () => {
        first = instance.draw.features.iterate().next().value;
      });
    });
    if (first?.id !== ids[0]) throw new Error('the first feature is not the first one created');
    return { ...work, keysRead };
  });

  it('makes one feature before it returns the first', () => {
    // The values of one row are read, and the keys of its attributes once
    for (const size of [WORK_SIZES.small, WORK_SIZES.large]) {
      expect(scene(size).featuresRead).toBe(1);
      expect(scene(size).keysRead).toBe(1);
    }
  });
});

describe('the automatic name of a new feature', () => {
  const scene = measured((size) => {
    const { instance } = instanceOf(size);
    instance.draw.setMode('drawPoint');
    // The first name counts the names there are; the next ones do not
    instance.input.click([0.031, 0.031]);
    // The mode goes back to select once a point is drawn
    instance.draw.setMode('drawPoint');
    const work = workOf(instance, () => instance.input.click([0.351, 0.351]));
    const named = [...instance.draw.features.iterate()].filter((f) => f.properties.name);
    if (named.length !== 2) throw new Error('the points were not named');
    return work;
  });

  it('touches as many rows from the second one', () => {
    expectNotProportional((size) => scene(size).rowsTouched + scene(size).featuresRead, 'rows');
  });
});

describe('features.update of one feature', () => {
  const scene = measured((size) => {
    const { instance, ids } = instanceWithout(size);
    return workOf(instance, () =>
      instance.draw.features.update(ids[5], { properties: { changed: true } }),
    );
  });

  it('writes one row, and notifies once', () => {
    expect(scene(1_000).rowsWritten).toBe(1);
    expect(scene(10_000).rowsWritten).toBe(1);
    expect(scene(1_000).notifications).toBe(1);
    expect(scene(10_000).notifications).toBe(1);
  });

  it('makes as many objects', () => {
    expectNotProportional((size) => scene(size).objectsCreated, 'the objects made');
  });
});

describe('features.move of one feature', () => {
  const scene = measured((size) => {
    const { instance, ids, layerId } = instanceWithout(size);
    return workOf(instance, () => instance.draw.features.move(ids[5], { layerId, index: 3 }));
  });

  it('writes as many rows', () => {
    expectNotProportional(
      (size) => scene(size).rowsWritten + scene(size).featuresWritten,
      'the rows written',
    );
  });

  it('touches as many rows to make the key of its place', () => {
    expectNotProportional((size) => scene(size).rowsTouched + scene(size).featuresRead, 'rows');
  });
});

describe('features.delete of the last feature of a group', () => {
  const scene = measured((size) => {
    const { instance, ids } = instanceWithout(size);
    const group = instance.draw.groups.create({ featureIds: [ids[5]] });
    if (!group) throw new Error('no group');
    const work = workOf(instance, () => instance.draw.features.delete(ids[5]));
    if (instance.draw.groups.has(group.id)) throw new Error('the group was left');
    return work;
  });

  it('touches as many rows to delete the group', () => {
    expectNotProportional((size) => scene(size).rowsTouched + scene(size).featuresRead, 'rows');
  });
});

describe('features.createMany', () => {
  it('reads as many rows per feature for 10,000 features as for 1,000', () => {
    expectNotProportional((size) => {
      const instance = createCountedInstance();
      instances.push(instance);
      const work = workOf(instance, () => instance.draw.features.createMany(gridPoints(size)));
      return (work.rowsTouched + work.featuresRead) / size;
    }, 'the rows read per feature');
  });
});
