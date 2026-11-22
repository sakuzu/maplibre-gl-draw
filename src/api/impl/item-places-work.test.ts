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

import { afterEach, describe, expect, it } from 'vitest';
import {
  createCountedInstance,
  expectNotProportional,
  gridPoints,
  storeWorkDuring,
  WORK_SIZES,
} from '../../test-utils.js';
import type { DrawDocument, Feature, Group } from '../model.js';

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

/** The writes of a Store */
const WRITES = [
  'createRows',
  'writeRows',
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
];

/**
 * A document of the library with one layer of `pairs` groups of one feature each and, when they
 * alternate, a feature in no group after each group
 */
function documentOf(pairs: number, alternate: boolean): DrawDocument {
  const at = (i: number): [number, number] => [(i % 100) / 50 - 1, Math.floor(i / 100) / 50 - 1];
  const point = (id: string, i: number, groupId?: string): Feature => ({
    id,
    type: 'Point',
    geometry: { type: 'Point', coordinates: at(i) },
    layerId: 'l',
    groupId,
    properties: {},
    style: {},
    visible: true,
    locked: false,
  });
  const ids = Array.from({ length: pairs }, (_, i) => i);
  return {
    version: '3.0.0',
    layerOrder: ['l'],
    layers: [
      {
        id: 'l',
        name: 'L',
        visible: true,
        locked: false,
        opacity: 1,
        items: ids.flatMap((i) => (alternate ? [`g${i}`, `s${i}`] : [`g${i}`])),
        styleRule: undefined,
        metadata: undefined,
      },
    ],
    groups: ids.map((i) => ({
      id: `g${i}`,
      layerId: 'l',
      name: `G ${i}`,
      featureIds: [`m${i}`],
      visible: true,
      locked: false,
    })),
    features: ids.flatMap((i) => [
      point(`m${i}`, 2 * i, `g${i}`),
      ...(alternate ? [point(`s${i}`, 2 * i + 1)] : []),
    ]),
  };
}

describe('a document of the library loaded', () => {
  /** The pairs of the two sizes compared */
  const SIZES = [1_000, 4_000] as const;

  /** What the calls of the writes of the Store counted, in all */
  const writesOf = (instance: Instance, names: readonly string[]): number =>
    names.reduce((n, name) => n + (instance.storeWork.calls.get(name) ?? 0), 0);

  /**
   * The writes of the Store and the rows read per pair, and the writes of rows of the whole load,
   * at a size
   */
  async function loadWork(pairs: number, alternate: boolean) {
    const instance = createCountedInstance();
    instances.push(instance);
    const data = documentOf(pairs, alternate);
    const writes = writesOf(instance, WRITES);
    const rowWrites = writesOf(instance, ['createRows', 'writeRows']);
    const touched = instance.counts.rowsTouched;
    const read = instance.storeWork.featuresRead;
    const result = await instance.draw.document.load(data);
    if (!result) throw new Error('not loaded');
    const rows = instance.storeWork.featuresRead - read + instance.counts.rowsTouched - touched;
    return {
      writes: (writesOf(instance, WRITES) - writes) / pairs,
      rows: rows / pairs,
      rowWrites: writesOf(instance, ['createRows', 'writeRows']) - rowWrites,
    };
  }

  it.each([
    { what: 'groups and features one after another', alternate: true },
    { what: 'groups one after another', alternate: false },
  ])(
    'with $what writes and reads as much per item at both sizes',
    async ({ alternate }) => {
      const small = await loadWork(SIZES[0], alternate);
      const large = await loadWork(SIZES[1], alternate);
      expect(large.writes / small.writes).toBeLessThan(2);
      expect(large.rows / small.rows).toBeLessThan(2);
      // The features of a layer are written at once, however many groups part them
      expect(large.rowWrites / small.rowWrites).toBeLessThan(2);
    },
    60_000,
  );
});
