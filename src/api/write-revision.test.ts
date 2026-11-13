// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A write of a transaction checked against a Store that has not changed since is made at its
 * commit as it was checked; one whose Store changed in between is checked again, and what it
 * named that is gone leaves it out
 */

import { afterEach, describe, expect, it } from 'vitest';
import { TableSelection } from '../feature-table/selection.js';
import { writeKindsInSlices } from '../operations/bulk-sliced.js';
import { createTableStore } from '../store/table-memory.js';
import { writesOf } from '../test-support/writes.js';
import { createMapStub } from '../test-utils.js';
import type { Draw } from './draw.js';
import { createDraw } from './draw.js';
import { DrawError } from './errors.js';

const draws: Draw[] = [];

afterEach(() => {
  for (const draw of draws.splice(0)) draw.destroy();
});

const point = (i: number) => ({
  type: 'Feature' as const,
  id: `f${i}`,
  geometry: { type: 'Point' as const, coordinates: [i, 0] },
  properties: {},
});

for (const [kind, store] of [
  ['objects', () => undefined],
  ['rows', () => createTableStore().store],
] as const) {
  describe(`tx.groups.create over a Store of ${kind}`, () => {
    function open(): Draw {
      const given = store();
      const draw = createDraw(createMapStub().map, given ? { store: given } : {});
      draws.push(draw);
      if (given) writesOf(draw).layers.create({ id: 'l', name: 'l' });
      return draw;
    }

    it('makes a group checked against a document that has not changed since', async () => {
      const draw = open();
      await draw.write(async (tx) => {
        for (let i = 0; i < 3; i++) await tx.features.create(point(i));
      });
      const group = await draw.write((tx) => tx.groups.create({ members: ['f2', 'f0'] }));
      expect(draw.groups.listMembers(group.id, { limit: 10 })).toEqual(['f0', 'f2']);
    });

    it('checks it again when the document changed between its check and its commit', async () => {
      const draw = open();
      await draw.write(async (tx) => {
        for (let i = 0; i < 3; i++) await tx.features.create(point(i));
      });
      const write = draw.write((tx) => tx.groups.create({ members: ['f0', 'f1'] }));
      // Before the commit: a member goes (as a write from elsewhere would take it)
      writesOf(draw).features.delete('f1');
      const result = await write.result;
      expect(result.skipped).toBe(1);
      expect(draw.groups.count()).toBe(0);
    });
  });
}

describe('a group checked before a write it does not see', () => {
  it('is checked again after a write from elsewhere applied before its commit', async () => {
    const store = createTableStore().store;
    const draw = createDraw(createMapStub().map, { store, initDefaultLayer: false });
    draws.push(draw);
    writesOf(draw).layers.create({ id: 'l', name: 'l' });
    await draw.write(async (tx) => {
      for (let i = 0; i < 3; i++) await tx.features.create(point(i));
    });
    const write = draw.write((tx) => tx.groups.create({ members: ['f0', 'f1'] }));
    // Received before the commit: a member goes
    store.transact(() => store.deleteFeature('f1'), 'remote');
    expect((await write.result).skipped).toBe(1);
    expect(draw.groups.count()).toBe(0);
  });

  it('is checked again after the rest of a write over several tasks queued before it', async () => {
    const store = createTableStore().store;
    const draw = createDraw(createMapStub().map, { store, initDefaultLayer: false });
    draws.push(draw);
    writesOf(draw).layers.create({ id: 'l', name: 'l' });
    writesOf(draw).features.createMany(
      Array.from({ length: 600 }, (_, i) => ({
        id: `f${i}`,
        type: 'Point',
        geometry: { type: 'Point', coordinates: [i * 0.001, 0] },
        layerId: 'l',
        properties: {},
      })) as never,
    );
    // A deletion of every row over several tasks, under way: its first step made
    const handles = Array.from(
      { length: 600 },
      (_, i) => store.tables?.getRowRef(`f${i}`) as number,
    );
    let t = 0;
    writeKindsInSlices(
      store as never,
      TableSelection.of(handles),
      [{ rows: handles, op: { kind: 'delete' } as never }],
      { onDone: () => {}, budgetMs: 1, schedule: () => {}, now: () => (t += 1) },
    );
    expect(store.slicedWritePending).toBe(true);
    // Checked now, against the rows not deleted yet; committed after the rest of the deletion
    const write = draw.write((tx) => tx.groups.create({ members: ['f598', 'f599'] }));
    expect((await write.result).skipped).toBe(1);
    expect(draw.groups.count()).toBe(0);
  });
});

describe('an import and a group of one transaction', () => {
  for (const [kind, store] of [
    ['objects', () => undefined],
    ['rows', () => createTableStore().store],
  ] as const) {
    it(`refuse the ID of the group the import makes, and write nothing, over a Store of ${kind}`, async () => {
      const given = store();
      const draw = createDraw(createMapStub().map, given ? { store: given } : {});
      draws.push(draw);
      if (given) writesOf(draw).layers.create({ id: 'l', name: 'l' });
      await draw.write(async (tx) => {
        for (let i = 0; i < 2; i++) await tx.features.create(point(i));
      });
      const collection = {
        type: 'FeatureCollection' as const,
        features: [
          {
            type: 'Feature' as const,
            geometry: { type: 'Point' as const, coordinates: [5, 5] },
            properties: {},
          },
        ],
      };
      const write = draw.write(async (tx) => {
        await tx.import(collection, { group: { id: 'g' } });
        await tx.groups.create({ id: 'g', members: ['f0', 'f1'] });
      });
      const error = await write.catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(DrawError);
      expect((error as DrawError).code).toBe('alreadyExists');
      expect(draw.features.count()).toBe(2);
      expect(draw.groups.count()).toBe(0);
    });
  }

  it('gives the features it reads no ID another write of the transaction creates', async () => {
    const draw = createDraw(createMapStub().map);
    draws.push(draw);
    const collection = {
      type: 'FeatureCollection' as const,
      features: [
        {
          type: 'Feature' as const,
          id: 'x',
          geometry: { type: 'Point' as const, coordinates: [5, 5] },
          properties: {},
        },
      ],
    };
    await draw.write(async (tx) => {
      await tx.import(collection);
      await tx.features.create({ ...point(9), id: 'x' });
    });
    expect(draw.features.count()).toBe(2);
    expect(draw.features.get('x')?.geometry).toEqual({ type: 'Point', coordinates: [9, 0] });
  });
});
