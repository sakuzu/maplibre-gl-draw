// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A write of a transaction checked against a Store that has not changed since is made at its
 * commit as it was checked; one whose Store changed in between is checked again, and what it
 * named that is gone leaves it out
 */

import { afterEach, describe, expect, it } from 'vitest';
import { createTableStore } from '../store/table-memory.js';
import { writesOf } from '../test-support/writes.js';
import { createMapStub } from '../test-utils.js';
import type { Draw } from './draw.js';
import { createDraw } from './draw.js';

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
