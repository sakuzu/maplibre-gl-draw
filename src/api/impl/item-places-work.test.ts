// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The rows the operations that make, take apart and replace groups and features read from the
 * Store, which do not grow with the number of the items of the layer
 *
 * Each scene runs on an instance whose Store counts what goes through it, and what one
 * operation read (the mean of its runs) must grow less than twice from the smaller document to
 * the larger one. No listener of `feature.moved` is set: the orders before a move are then not
 * kept.
 */

import { afterEach, describe, it } from 'vitest';
import {
  createCountedInstance,
  expectNotProportional,
  gridPoints,
  storeWorkDuring,
  WORK_SIZES,
} from '../../test-utils.js';
import type { Feature, Group } from '../model.js';

const instances: ReturnType<typeof createCountedInstance>[] = [];

afterEach(() => {
  for (const instance of instances.splice(0)) instance.draw.destroy();
});

type Instance = ReturnType<typeof createCountedInstance>;

/** How many times each operation runs, its mean being compared */
const RUNS = 10;

/**
 * The rows read from the Store while `fn` ran: those the instance read through it, and those
 * the Store touched for it (the items of an order read included)
 */
function rowsRead(instance: Instance, fn: () => void): number {
  const touched = instance.counts.rowsTouched;
  const { featuresRead } = storeWorkDuring(instance.storeWork, fn);
  return featuresRead + instance.counts.rowsTouched - touched;
}

/** What a scene measured, built once per size */
function measured(measure: (size: number) => number): (size: number) => number {
  const results = new Map<number, number>();
  return (size) => {
    let result = results.get(size);
    if (result === undefined) {
      result = measure(size);
      results.set(size, result);
    }
    return result;
  };
}

/** An instance over `count` points, with their IDs from the back */
function withPoints(count: number): { instance: Instance; ids: string[] } {
  const instance = createCountedInstance();
  instances.push(instance);
  const ids = (instance.draw.features.createMany(gridPoints(count)) as Feature[]).map((f) => f.id);
  return { instance, ids };
}

/** A square area of a hundredth of a degree at a point */
function square([x, y]: [number, number]) {
  return {
    type: 'Polygon' as const,
    geometry: {
      type: 'Polygon' as const,
      coordinates: [
        [
          [x, y],
          [x + 0.01, y],
          [x + 0.01, y + 0.01],
          [x, y + 0.01],
          [x, y],
        ],
      ],
    },
  };
}

/** The mean of the rows read by the runs of an operation */
function meanOf(instance: Instance, runs: number, run: (i: number) => void): number {
  let total = 0;
  for (let i = 0; i < runs; i++) total += rowsRead(instance, () => run(i));
  return total / runs;
}

describe('groups made of two features each', () => {
  /** The groups of the two sizes compared */
  const groupsAt = (size: number): number => (size === WORK_SIZES.small ? 1_000 : 5_000);

  const createMany = measured((size) => {
    const groups = groupsAt(size);
    const { instance, ids } = withPoints(groups * 2);
    const inputs = Array.from({ length: groups }, (_, i) => ({
      featureIds: [ids[2 * i], ids[2 * i + 1]],
    }));
    let made: Group[] | null = null;
    const read = rowsRead(instance, () => {
      made = instance.draw.groups.createMany(inputs);
    });
    if (made === null || (made as Group[]).length !== groups) throw new Error('no groups made');
    return read / groups;
  });

  // The 5,000 groups take several seconds: the time is not what is measured
  it('with groups.createMany read as many rows per group', () => {
    expectNotProportional(createMany, 'the rows read per group');
  }, 120_000);

  const createOneByOne = measured((size) => {
    const groups = groupsAt(size);
    const { instance, ids } = withPoints(groups * 2);
    let read = 0;
    for (let i = 0; i < groups; i++) {
      read += rowsRead(instance, () => {
        if (!instance.draw.groups.create({ featureIds: [ids[2 * i], ids[2 * i + 1]] })) {
          throw new Error('no group made');
        }
      });
    }
    return read / groups;
  });

  it('with groups.create one by one read as many rows per group', () => {
    expectNotProportional(createOneByOne, 'the rows read per group');
  }, 120_000);
});

describe('an operation on the items of a layer', () => {
  it('selection.group of three features reads as many rows', () => {
    expectNotProportional(
      measured((size) => {
        const { instance, ids } = withPoints(size);
        const step = Math.floor(size / (RUNS * 3));
        return meanOf(instance, RUNS, (i) => {
          const at = i * 3 * step;
          instance.draw.selection.set('feature', [ids[at], ids[at + step], ids[at + 2 * step]]);
          if (!instance.draw.selection.group()) throw new Error('no group made');
        });
      }),
      'the rows read per group',
    );
  });

  it('a feature taken out of its group reads as many rows', () => {
    expectNotProportional(
      measured((size) => {
        const { instance, ids } = withPoints(size);
        const step = Math.floor(size / (RUNS * 2));
        const members = Array.from({ length: RUNS }, (_, i) => [ids[i * step], ids[i * step + 1]]);
        for (const featureIds of members) instance.draw.groups.create({ featureIds });
        return meanOf(instance, RUNS, (i) => {
          instance.draw.selection.set('feature', [members[i][0]]);
          if (!instance.draw.selection.ungroup()) throw new Error('nothing taken out');
        });
      }),
      'the rows read per feature taken out',
    );
  });

  it('a group dissolved reads as many rows', () => {
    expectNotProportional(
      measured((size) => {
        const { instance, ids } = withPoints(size);
        const step = Math.floor(size / (RUNS * 2));
        const groups = Array.from(
          { length: RUNS },
          (_, i) =>
            instance.draw.groups.create({
              featureIds: [ids[i * step], ids[i * step + 1]],
            }) as Group,
        );
        return meanOf(instance, RUNS, (i) => {
          instance.draw.selection.set('group', [groups[i].id]);
          if (!instance.draw.selection.ungroup()) throw new Error('nothing dissolved');
        });
      }),
      'the rows read per group dissolved',
    );
  });

  it('a union of two areas reads as many rows', () => {
    expectNotProportional(
      measured((size) => {
        const instance = createCountedInstance();
        instances.push(instance);
        const ids = (
          instance.draw.features.createMany(
            gridPoints(size).map((input) => square(input.geometry.coordinates)),
          ) as Feature[]
        ).map((f) => f.id);
        const step = Math.floor(size / (RUNS * 2));
        return meanOf(instance, RUNS, (i) => {
          if (!instance.draw.features.union([ids[i * step], ids[i * step + 1]])) {
            throw new Error('no union');
          }
        });
      }),
      'the rows read per union',
    );
  });

  it('a feature moved within its layer reads as many rows', () => {
    expectNotProportional(
      measured((size) => {
        const { instance, ids } = withPoints(size);
        const layerId = instance.draw.layers.list()[0].id;
        const step = Math.floor(size / RUNS);
        return meanOf(instance, RUNS, (i) => {
          const to = { layerId, index: Math.floor(size / 2) };
          if (!instance.draw.features.move(ids[i * step], to)) throw new Error('not moved');
        });
      }),
      'the rows read per move',
    );
  });
});
