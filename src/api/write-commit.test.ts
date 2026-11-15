// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for `draw.write`: when the commit is made, what the transaction gives and refuses, the
 * shape of the features read and written, and the local undo
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTableStore } from '../store/table-memory.js';
import { createMapStub } from '../test-utils.js';
import type { Draw } from './draw.js';
import { createDraw } from './draw.js';
import { DrawError } from './errors.js';
import type { Change } from './events.js';
import { readFeature } from './model.js';

let draw: Draw;
let changes: Change[];

const point = (x: number, properties: Record<string, unknown> = {}) => ({
  type: 'Feature' as const,
  geometry: { type: 'Point' as const, coordinates: [x, 0] },
  properties,
});

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'done';
  } catch (error) {
    if (error instanceof DrawError) return error.code;
    throw error;
  }
}

for (const [kind, store] of [
  ['objects', () => undefined],
  ['rows', () => createTableStore().store],
] as const) {
  describe(`draw.write over a Store of ${kind}`, () => {
    let given: ReturnType<typeof store>;

    beforeEach(() => {
      let next = 0;
      given = store();
      draw = createDraw(createMapStub().map, {
        ...(given && { store: given }),
        generateId: () => `n${++next}`,
      });
      changes = [];
      draw.on('change', (change) => changes.push(change));
    });

    afterEach(() => {
      draw.destroy();
    });

    it('commits after it returns, once, and the promise settles once it is made', async () => {
      const write = draw.write((tx) => tx.features.create(point(1)));
      // Not awaited: the document is as it was, however small the write
      expect(draw.features.count()).toBe(0);
      expect(changes).toHaveLength(0);
      const feature = await write;
      expect(draw.features.get(feature.id)).toEqual(feature);
      expect(changes).toHaveLength(1);
      expect(changes[0].commit).toBe(write.id);
      expect(changes[0].source).toBe('local');
      expect((await write.result).skipped).toBe(0);
    });

    it('gives a GeoJSON Feature, the values of the library under the keys of properties', async () => {
      const layerId = draw.layers.getActive()?.id as string;
      const feature = await draw.write((tx) =>
        tx.features.create({
          ...point(1, { name: 'one' }),
          id: 7,
          properties: { name: 'one', 'maplibre-gl-draw:locked': true },
        }),
      );
      expect(feature).toEqual({
        type: 'Feature',
        id: '7',
        geometry: { type: 'Point', coordinates: [1, 0] },
        properties: {
          name: 'one',
          'maplibre-gl-draw:layerId': layerId,
          'maplibre-gl-draw:locked': true,
        },
      });
      expect(JSON.parse(JSON.stringify(draw.features.get('7')))).toEqual(feature);
      expect(readFeature(feature)).toMatchObject({
        featureType: 'Point',
        layerId,
        groupId: null,
        visible: true,
        locked: true,
        style: {},
      });
      // A new copy each time
      expect(draw.features.get('7')).not.toBe(draw.features.get('7'));
    });

    it('puts the rings of an area in the right-hand rule as it writes them', async () => {
      const clockwise = [
        [0, 0],
        [0, 1],
        [1, 1],
        [1, 0],
        [0, 0],
      ];
      const area = await draw.write((tx) =>
        tx.features.create({
          type: 'Feature',
          geometry: { type: 'Polygon', coordinates: [clockwise] },
          properties: {},
        }),
      );
      expect(draw.features.get(area.id)?.geometry).toEqual({
        type: 'Polygon',
        coordinates: [[...clockwise].reverse()],
      });
    });

    it('fails the whole transaction when one write fails, even when its error is caught', async () => {
      const code = await codeOf(
        draw.write(async (tx) => {
          await tx.features.create(point(1));
          await tx.features.update('nothing', { properties: { n: 1 } }).catch(() => {});
        }),
      );
      expect(code).toBe('notFound');
      expect(draw.features.count()).toBe(0);
      expect(changes).toHaveLength(0);
    });

    it('refuses with notEditable and locked rather than null and false', async () => {
      const feature = await draw.write((tx) =>
        tx.features.create({ ...point(1), properties: { 'maplibre-gl-draw:locked': true } }),
      );
      expect(
        await codeOf(draw.write((tx) => tx.features.update(feature.id, { properties: { n: 1 } }))),
      ).toBe('locked');
      draw.setReadOnly(true);
      expect(await codeOf(draw.write((tx) => tx.features.create(point(2))))).toBe('notEditable');
      draw.setReadOnly(false);
    });

    it('refuses a patch that removes nothing by name, and a key of the place', async () => {
      const feature = await draw.write((tx) => tx.features.create(point(1, { n: 1 })));
      for (const patch of [
        {},
        { properties: {} },
        { properties: { n: undefined } },
        { properties: { 'maplibre-gl-draw:layerId': 'x' } },
      ]) {
        expect(
          await codeOf(draw.write((tx) => tx.features.update(feature.id, patch as never))),
        ).toBe('invalidInput');
      }
      await draw.write((tx) => tx.features.update(feature.id, { unset: { properties: ['n'] } }));
      expect(draw.features.get(feature.id)?.properties.n).toBeUndefined();
    });

    it('throws nestedWrite for a write in the synchronous part of another', async () => {
      let thrown: unknown;
      await draw.write(() => {
        try {
          void draw.write(() => undefined);
        } catch (error) {
          thrown = error;
        }
      });
      expect((thrown as DrawError).code).toBe('nestedWrite');
    });

    it('closes the transaction once its function ends', async () => {
      let kept: Parameters<Parameters<Draw['write']>[0]>[0] | undefined;
      await draw.write((tx) => {
        kept = tx;
      });
      expect(await codeOf(kept?.features.create(point(1)) as Promise<unknown>)).toBe(
        'transactionClosed',
      );
    });

    it('reads what it wrote of a feature by its ID, and nothing else before the commit', async () => {
      await draw.write(async (tx) => {
        const made = await tx.features.create(point(1));
        expect(tx.features.get(made.id)).toEqual(made);
        expect(draw.features.get(made.id)).toBeUndefined();
        const changed = await tx.features.update(made.id, { properties: { n: 2 } });
        expect(changed.properties.n).toBe(2);
      });
    });

    it('writes nothing when its signal stops it before the commit', async () => {
      const controller = new AbortController();
      const write = draw.write(
        async (tx) => {
          await tx.features.create(point(1));
          controller.abort();
        },
        { signal: controller.signal },
      );
      expect(await codeOf(write)).toBe('aborted');
      expect(draw.features.count()).toBe(0);
    });

    it('commits in the order the functions end, after the writes queued before', async () => {
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const slow = draw.write(async (tx) => {
        await gate;
        return tx.features.create(point(1, { name: 'slow' }));
      });
      const fast = draw.write((tx) => tx.features.create(point(2, { name: 'fast' })));
      await fast;
      release();
      await slow;
      expect(changes.map((change) => change.commit)).toEqual([fast.id, slow.id]);
    });

    it('takes a commit back and makes it again, as commits of their own', async () => {
      const a = await draw.write((tx) => tx.features.create(point(1)));
      await draw.write((tx) => tx.features.update(a.id, { properties: { n: 1 } }));
      await draw.undo();
      expect(draw.features.get(a.id)?.properties.n).toBeUndefined();
      await draw.undo();
      expect(draw.features.has(a.id)).toBe(false);
      expect(await codeOf(draw.undo())).toBe('invalidState');
      await draw.redo();
      await draw.redo();
      expect(draw.features.get(a.id)?.properties.n).toBe(1);
      expect(await codeOf(draw.redo())).toBe('invalidState');
      expect(changes.slice(2).map((change) => change.source)).toEqual([
        'undo',
        'undo',
        'redo',
        'redo',
      ]);
    });

    it('makes no step of a commit written with undo: false', async () => {
      await draw.write((tx) => tx.features.create(point(1)), { undo: false });
      expect(await codeOf(draw.undo())).toBe('invalidState');
    });

    it('tells the Store a commit written with undo: false as one a recorder of steps leaves out', async () => {
      // The Store of objects is made by the instance: the Store of rows is the one given
      if (given === undefined) return;
      const told: Array<string | undefined> = [];
      given.subscribe((change) => told.push(change.source));
      await draw.write((tx) => tx.features.create(point(1)));
      await draw.write((tx) => tx.features.create(point(2)), { undo: false });
      expect(told).toEqual(['local', 'silent']);
      // The change of the instance says local for both
      expect(changes.map((change) => change.source)).toEqual(['local', 'local']);
    });

    it('adds GeoJSON with tx.import, in one commit with the rest', async () => {
      await draw.write(async (tx) => {
        await tx.features.create(point(1));
        await tx.import({ type: 'FeatureCollection', features: [point(2), point(3)] });
      });
      expect(draw.features.count()).toBe(3);
      expect(changes).toHaveLength(1);
      await draw.undo();
      expect(draw.features.count()).toBe(0);
    });

    it('gives a taken ID of an import a new one, or refuses it with duplicateIds refuse', async () => {
      const a = await draw.write((tx) => tx.features.create({ ...point(1), id: 'a' }));
      const collection = {
        type: 'FeatureCollection' as const,
        features: [
          { ...point(2), id: 'a' },
          { ...point(3), id: 'b' },
          { ...point(4), id: 'b' },
        ],
      };
      const renewed = await draw.write((tx) => tx.import(collection));
      // The ID the document holds and the one the source holds twice are new
      expect(renewed).toMatchObject({ count: 3, renewed: 2 });
      expect(draw.features.get(a.id)?.geometry).toEqual({ type: 'Point', coordinates: [1, 0] });
      expect(draw.features.count()).toBe(4);
      const before = changes.length;
      const refused = draw.write((tx) => tx.import(collection, { duplicateIds: 'refuse' }));
      await expect(refused).rejects.toMatchObject({ code: 'alreadyExists' });
      await expect(refused).rejects.toMatchObject({ ids: ['a', 'b'] });
      expect(draw.features.count()).toBe(4);
      expect(changes).toHaveLength(before);
      // An ID the same transaction creates first is held by the document at the commit
      const later = draw.write(async (tx) => {
        await tx.features.create({ ...point(5), id: 'c' });
        await tx.import(
          { type: 'FeatureCollection', features: [{ ...point(6), id: 'c' }] },
          { duplicateIds: 'refuse' },
        );
      });
      expect(await codeOf(later)).toBe('alreadyExists');
      expect(draw.features.has('c')).toBe(false);
      expect(
        await codeOf(
          draw.write((tx) => tx.import(collection, { duplicateIds: 'replace' as never })),
        ),
      ).toBe('invalidInput');
    });

    it('takes the same ID for taken in a renew and a refuse, the ID no part takes left out', async () => {
      await draw.write((tx) => tx.features.create({ ...point(1), id: 'a' }));
      await draw.write((tx) => tx.features.create({ ...point(1), id: '7' }));
      // The parts of a GeometryCollection get IDs of their own: the ID of the input is no one's
      const parts = {
        type: 'FeatureCollection' as const,
        features: [
          {
            type: 'Feature' as const,
            id: 'a',
            geometry: {
              type: 'GeometryCollection' as const,
              geometries: [
                { type: 'Point' as const, coordinates: [5, 5] },
                {
                  type: 'LineString' as const,
                  coordinates: [
                    [0, 0],
                    [1, 1],
                  ],
                },
              ],
            },
            properties: {},
          },
        ],
      };
      expect(await draw.write((tx) => tx.import(parts))).toMatchObject({ count: 2, renewed: 0 });
      expect(await draw.write((tx) => tx.import(parts, { duplicateIds: 'refuse' }))).toMatchObject({
        count: 2,
        renewed: 0,
      });
      // A number is the ID of its digits: taken in both
      const numbered = { type: 'FeatureCollection' as const, features: [{ ...point(2), id: 7 }] };
      expect(await draw.write((tx) => tx.import(numbered))).toMatchObject({
        count: 1,
        renewed: 1,
      });
      expect(
        await codeOf(draw.write((tx) => tx.import(numbered, { duplicateIds: 'refuse' }))),
      ).toBe('alreadyExists');
    });

    it('puts the features of an import into a group of the document, in its layer', async () => {
      const layer = await draw.write((tx) => tx.layers.create({ name: 'other' }));
      const group = await draw.write(async (tx) => {
        const [first] = await tx.features.create([{ ...point(1), id: 'g1' }]);
        await tx.features.place(first as string, { layerId: layer.id });
        return tx.groups.create({ members: ['g1'] });
      });
      const result = await draw.write((tx) =>
        tx.import(
          { type: 'FeatureCollection', features: [point(2), point(3)] },
          { group: group.id },
        ),
      );
      expect(result).toMatchObject({ count: 2, layerId: layer.id, renewed: 0 });
      const members = draw.features.list(undefined, { limit: 10 }).filter((f) => f.id !== 'g1');
      expect(members).toHaveLength(2);
      for (const feature of members) {
        expect(readFeature(feature)).toMatchObject({ layerId: layer.id, groupId: group.id });
      }
      // A group the same transaction creates is taken too
      const both = await draw.write(async (tx) => {
        await tx.features.create({ ...point(5), id: 'g2' });
        const made = await tx.groups.create({ members: ['g2'] });
        const read = await tx.import(
          { type: 'FeatureCollection', features: [point(6)] },
          { group: made.id },
        );
        return { made, read };
      });
      expect(both.read.count).toBe(1);
      expect(draw.groups.get(both.made.id)).toBeDefined();
      expect(
        draw.features
          .list(undefined, { limit: 10 })
          .filter((f) => readFeature(f).groupId === both.made.id),
      ).toHaveLength(2);
      expect(
        await codeOf(
          draw.write((tx) =>
            tx.import({ type: 'FeatureCollection', features: [] }, { group: 'none' }),
          ),
        ),
      ).toBe('notFound');
      expect(
        await codeOf(
          draw.write((tx) =>
            tx.import(
              { type: 'FeatureCollection', features: [point(4)] },
              {
                group: group.id,
                layer: 'default-layer-x',
              },
            ),
          ),
        ),
      ).toBe('invalidInput');
    });

    it('writes the document out with GeoJSON features and opens it again as it was', async () => {
      await draw.write(async (tx) => {
        await tx.features.create(point(1, { name: 'a' }));
        await tx.features.create({
          ...point(2),
          properties: { 'maplibre-gl-draw:visible': false },
        });
      });
      const written = draw.document.toJSON();
      expect(written.version).toBe('4.0.0');
      expect(written.features.every((feature) => feature.type === 'Feature')).toBe(true);
      const other = createDraw(createMapStub().map);
      await other.open(written);
      expect(other.features.list(undefined, { limit: 10 })).toEqual(
        draw.features.list(undefined, { limit: 10 }),
      );
      other.destroy();
    });

    it('replaces the features with draw.open, and drops the steps', async () => {
      await draw.write((tx) => tx.features.create(point(1)));
      const opened = await draw.open({ type: 'FeatureCollection', features: [point(5)] });
      expect(opened.features).toBe(1);
      expect(draw.features.count()).toBe(1);
      expect(changes[changes.length - 1]?.source).toBe('open');
      expect(await codeOf(draw.undo())).toBe('invalidState');
    });
  });
}
