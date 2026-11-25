// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The order of the rows drawn from the delta of a layer
 *
 * After operations made at random (features made, written, deleted, put into groups, groups moved to
 * another layer and within theirs, with frames drawn in between some of them), the rows of
 * `deltaInserts` are in the order of the table of their layer, the deleted ones too, and the ones
 * not deleted are in the order the Store lists the rows of the layer in. A row deleted whose id is
 * forgotten names its group while the delta holds it, also after the group has left the layer.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { drawnRowsOf } from '../../store/built-in/drawn-rows.js';
import { createCountedInstance } from '../../test-utils.js';

type Instance = ReturnType<typeof createCountedInstance>;

const instances: Instance[] = [];

afterEach(() => {
  for (const instance of instances.splice(0)) instance.draw.destroy();
});

/** Numbers from 0 to 1, the same for a seed */
function randomOf(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The operations made at random */
const STEPS = 60;

describe('the rows drawn from the delta of a layer', () => {
  for (let seed = 1; seed <= 100; seed++) {
    it(`are in the order of its table (seed ${seed})`, () => {
      const random = randomOf(seed);
      const instance = createCountedInstance();
      instances.push(instance);
      const { draw, map, store } = instance;
      const rows = drawnRowsOf(instance.engine.context.store.getTables());
      if (!rows) throw new Error('the instance draws no rows');
      const layers = [0, 1, 2].map((i) => draw.layers.create({ name: `l${i}` })?.id as string);
      const pick = <T>(list: readonly T[]): T | undefined =>
        list[Math.floor(random() * list.length)];
      const line = () => ({
        type: 'LineString',
        coordinates: Array.from({ length: 2 + Math.floor(random() * 4) }, () => [
          random(),
          random(),
        ]),
      });
      const make = (count: number, layerId: string): void => {
        draw.features.createMany(
          Array.from({ length: count }, () => ({
            type: 'LineString',
            layerId,
            geometry: line(),
          })) as never,
        );
      };
      /** A feature, with a chance one of a group */
      const featureOf = (inGroup: number) => {
        const group = random() < inGroup ? pick(draw.groups.list()) : undefined;
        const features = draw.features.list();
        return pick(group ? features.filter((f) => f.groupId === group.id) : features);
      };

      const operations: (() => void)[] = [
        () => make(1 + Math.floor(random() * 3), pick(layers) as string),
        () => {
          for (let k = 0; k < 4; k++) {
            const feature = featureOf(0.6);
            if (feature) draw.features.update(feature.id, { geometry: line() } as never);
          }
        },
        () => {
          const feature = featureOf(0.7);
          if (feature) draw.features.delete(feature.id);
        },
        () => {
          const layerId = pick(layers);
          const free = draw.features.list().filter((f) => f.layerId === layerId && !f.groupId);
          const ids = new Set(Array.from({ length: 4 }, () => pick(free)?.id));
          ids.delete(undefined);
          if (ids.size < 2) return;
          draw.groups.create({ name: 'g', featureIds: [...ids] as string[] });
        },
        () => {
          const group = pick(draw.groups.list());
          if (!group) return;
          const free = draw.features
            .list()
            .filter((f) => f.layerId === group.layerId && !f.groupId);
          const feature = pick(free);
          if (feature) draw.features.move(feature.id, { groupId: group.id });
        },
        () => {
          const group = pick(draw.groups.list());
          if (!group) return;
          const layerId = pick(layers.filter((id) => id !== group.layerId)) as string;
          draw.groups.move(group.id, random() < 0.5 ? { layerId, index: 0 } : { layerId });
        },
        () => {
          const group = pick(draw.groups.list());
          if (!group) return;
          const index = Math.floor(random() * 20);
          draw.groups.move(group.id, { layerId: group.layerId, index });
        },
        // A frame alone
        () => {},
      ];
      // The operations that make the rows of the delta leave their table come more often
      const weighted = [0, 1, 1, 2, 2, 3, 4, 5, 6, 7];

      let inserted = 0;
      const expectOrder = (what: string): void => {
        for (const layerId of layers) {
          const table = rows.table(layerId);
          if (!table) continue;
          const drawn: number[] = [];
          for (const { rows: group, from, to } of rows.deltaInserts(table)) {
            for (let row = from; row < to; row++) drawn.push(group.data.rows[row]);
          }
          inserted += drawn.length;
          const refs = new Set(drawn);
          const ordered = [...table.rowOrder().handles].filter((ref) => refs.has(ref));
          expect(drawn, what).toEqual(ordered);
          // The references of the rows of a layer leave out the deleted ones
          const view = store.tables.get(layerId);
          const listed = [...(view?.listRowRefs(0, view.rowCount) ?? [])];
          const live = new Set(listed);
          expect(
            drawn.filter((ref) => live.has(ref)),
            what,
          ).toEqual(listed.filter((ref) => refs.has(ref)));
        }
      };

      for (const layerId of layers) make(70, layerId);
      for (let frame = 0; frame < 20; frame++) map.render();
      for (let step = 0; step < STEPS; step++) {
        const operation = pick(weighted) as number;
        operations[operation]();
        if (random() < 0.4) map.render();
        expectOrder(`operation ${operation}, step ${step}`);
      }
      expect(inserted).toBeGreaterThan(0);
    });
  }
});
