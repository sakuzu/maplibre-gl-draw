// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What is read after `features.restore`, whoever asked for the values before
 *
 * - The layer and the group of every feature are those of its row in the Store, and the events of
 *   the writing back are the same whether a subscriber asks for the values before it or not
 * - A row the writing back wrote both with its group and as a row reads as it is in the Store
 * - A deleted feature whose row is kept is not told as created when its group moves
 * - The layer and the group a feature was in before, and the position it left, are those before
 *   the change for a feature the layer does not keep made too
 * - The rows read and the objects made are no more than with a subscriber that asks for the values
 *   before of every change
 */

import { afterEach, describe, expect, it } from 'vitest';
import { createStore } from '../../store/built-in/create-store.js';
import type { Store } from '../../store/built-in/types.js';
import { createCountedInstance, createMapStub, gridPoints } from '../../test-utils.js';
import type { DocumentSubscribeOptions } from '../document.js';
import type { Draw } from '../draw.js';
import type { Feature, FeatureValues } from '../model.js';
import { createDraw } from './create-draw.js';

type Asks = DocumentSubscribeOptions['previousValues'];

/** The two subscribers the writing back is compared under: one asks for the values before it too */
const ASKS: readonly [string, Asks][] = [
  ['asking for the changes of every source', true],
  ['asking for the changes of this client', ['local']],
];

let draw: Draw;
let store: Store;
let first: string;
let other: string;

afterEach(() => {
  draw.destroy();
});

const point = (id: string, x = 0) => ({
  id,
  type: 'Point' as const,
  geometry: { type: 'Point' as const, coordinates: [x, 0] },
  properties: { k: 0 },
});

/** An instance of the features given, whose changes of this client give their values */
function start(asks: Asks, ids: readonly string[]): { take(): FeatureValues[] } {
  store = createStore();
  draw = createDraw(createMapStub().map, { store });
  first = draw.layers.list()[0].id;
  other = draw.layers.create({ id: 'other', name: 'other' })?.id as string;
  draw.features.createMany(ids.map((id, i) => point(id, i)));
  const values: FeatureValues[] = [];
  draw.document.subscribe(
    (change) => {
      if (change.source === 'local' && change.previousValues) values.push(change.previousValues);
    },
    { previousValues: asks },
  );
  return { take: () => values.splice(0) };
}

const writeBack = (values: readonly FeatureValues[]) =>
  draw.features.restore(values, { source: 'back' });

type Place = { layerId: string; groupId: string | undefined };

const placeIn = (feature: Pick<Feature, 'layerId' | 'groupId'>): Place => ({
  layerId: feature.layerId,
  groupId: feature.groupId,
});

/** Where the row of a feature is in the Store (undefined: it is not there) */
function rowPlace(id: string): Place | undefined {
  const ref = store.tables.getRowRef(id);
  if (ref === undefined) return undefined;
  const { fields } = store.tables.readValues(Int32Array.of(ref), ['parent']);
  const parent = String(fields.get('parent')?.[0]);
  const group = store.getGroup(parent);
  return group
    ? { layerId: group.layerId, groupId: parent }
    : { layerId: parent, groupId: undefined };
}

/** Every way to read the features gives the places of the rows of the Store */
function expectPlacesOfRows(ids: readonly string[]): void {
  const there = ids.filter((id) => rowPlace(id) !== undefined);
  const expected = new Map(there.map((id) => [id, rowPlace(id)]));
  const listed = (features: Iterable<Feature>) =>
    new Map([...features].map((feature) => [feature.id, placeIn(feature)]));
  expect(listed(there.map((id) => draw.features.get(id) as Feature))).toEqual(expected);
  expect(new Map([...listed(draw.features.iterate())].sort())).toEqual(
    new Map([...expected].sort()),
  );
  expect(new Map([...listed(draw.document.toJSON().features)].sort())).toEqual(
    new Map([...expected].sort()),
  );
  for (const id of ids) {
    if (expected.has(id)) continue;
    expect(draw.features.get(id)).toBeUndefined();
    expect(draw.features.has(id)).toBe(false);
  }
}

/** The events of the features from now on, the position before as its layer and its group */
function listen(): unknown[] {
  const events: unknown[] = [];
  draw.on('feature.created', ({ feature }) => events.push(['created', feature.id]));
  draw.on('feature.deleted', ({ feature }) => events.push(['deleted', feature.id]));
  draw.on('feature.updated', ({ feature, previous }) =>
    events.push(['updated', feature.id, placeIn(previous), placeIn(feature)]),
  );
  draw.on('feature.moved', ({ feature, from, to }) => events.push(['moved', feature.id, from, to]));
  draw.on('document.changed', ({ features }) =>
    events.push([
      'changed',
      [...features.created.iterate()],
      [...features.updated.iterate()],
      [...features.moved.iterate()],
    ]),
  );
  return events;
}

describe('a change of places written back', () => {
  const scenes: readonly [string, () => unknown][] = [
    ['making a group', () => draw.groups.create({ id: 'g', featureIds: ['a', 'b'] })],
    ['taking a group apart', () => draw.groups.delete('h')],
    ['moving features to another layer', () => draw.features.moveMany(['a'], { layerId: other })],
    ['moving a feature into a group', () => draw.features.move('a', { groupId: 'h' })],
    ['deleting features', () => draw.features.deleteMany(['a', 'c'])],
    ['moving a group to another layer', () => draw.groups.move('h', { layerId: other })],
  ];

  for (const [name, edit] of scenes) {
    it(`reads as the Store after ${name}, with the same events whoever asks`, async () => {
      const told: unknown[][] = [];
      for (const [, asks] of ASKS) {
        draw?.destroy();
        const values = start(asks, ['a', 'b', 'c', 'd']);
        draw.groups.create({ id: 'h', featureIds: ['c', 'd'] });
        values.take();
        const before = new Map(['a', 'b', 'c', 'd'].map((id) => [id, rowPlace(id)]));
        await edit();
        const taken = values.take();
        expect(taken.length).toBe(1);
        const events = listen();
        await writeBack(taken);
        expect(new Map(['a', 'b', 'c', 'd'].map((id) => [id, rowPlace(id)]))).toEqual(before);
        expectPlacesOfRows(['a', 'b', 'c', 'd']);
        expect(events.length).toBeGreaterThan(1);
        told.push(events);
      }
      expect(told[1]).toEqual(told[0]);
    });
  }
});

for (const [name, asks] of ASKS) {
  describe(`a row written with its group and as a row in one writing back, ${name}`, () => {
    it('reads as the Store after a group made and moved', async () => {
      const values = start(asks, ['a', 'b', 'c']);
      draw.groups.create({ id: 'g', featureIds: ['a', 'b'] });
      draw.groups.move('g', { layerId: other });
      await writeBack(values.take());
      expect(rowPlace('a')).toEqual({ layerId: first, groupId: undefined });
      expectPlacesOfRows(['a', 'b', 'c']);
      expect(JSON.stringify(draw.document.toJSON())).not.toContain('"groupId":"g"');
    });

    it('reads nothing of a feature it deleted after its group moved', async () => {
      const values = start(asks, ['a', 'b']);
      draw.groups.create({ id: 'g', featureIds: ['a', 'b'] });
      values.take();
      draw.features.create({ ...point('c'), groupId: 'g' });
      draw.groups.move('g', { layerId: other });
      await writeBack(values.take());
      expect(rowPlace('c')).toBeUndefined();
      expect(rowPlace('a')).toEqual({ layerId: first, groupId: 'g' });
      expectPlacesOfRows(['a', 'b', 'c']);
    });

    it('reads the place of a row written into a group the writing back deletes', async () => {
      const values = start(asks, ['a', 'b', 'c']);
      draw.groups.create({ id: 'g', featureIds: ['a', 'b'] });
      const made = values.take();
      draw.features.move('c', { groupId: 'g' });
      values.take();
      draw.features.move('c', { layerId: other });
      await writeBack([...made, ...values.take()]);
      expect(rowPlace('c')).toEqual({ layerId: first, groupId: undefined });
      expectPlacesOfRows(['a', 'b', 'c']);
    });

    it('reads the values of a row of a group the writing back deletes', async () => {
      const values = start(asks, ['a', 'b', 'c']);
      draw.groups.create({ id: 'g', featureIds: ['a', 'b'] });
      const made = values.take();
      draw.features.move('c', { groupId: 'g' });
      values.take();
      draw.features.update('c', { properties: { k: 5 } });
      await writeBack([...made, ...values.take()]);
      expect(rowPlace('c')).toEqual({ layerId: first, groupId: undefined });
      expectPlacesOfRows(['a', 'b', 'c']);
      expect(draw.features.get('c')?.properties.k).toBe(0);
    });

    it('counts the position before from the place before the first write', async () => {
      const values = start(asks, ['a', 'b', 'c', 'd']);
      draw.features.createMany([
        { ...point('x'), layerId: other },
        { ...point('y'), layerId: other },
      ]);
      values.take();
      draw.features.move('a', { layerId: first, index: 2 });
      draw.features.move('a', { layerId: other, index: 1 });
      const moved: unknown[] = [];
      draw.on('feature.moved', ({ feature, from, to }) => moved.push([feature.id, from, to]));
      await writeBack(values.take());
      expectPlacesOfRows(['a', 'b', 'c', 'd', 'x', 'y']);
      expect(moved).toEqual([['a', { layerId: other, index: 1 }, { layerId: first, index: 0 }]]);
    });
  });

  describe(`a group moved with a deleted feature whose row is kept, ${name}`, () => {
    /** A group of three, one of them deleted, whose values keep its row */
    async function deletedInGroup() {
      const values = start(asks, ['a', 'b', 'c']);
      draw.groups.create({ id: 'g', featureIds: ['a', 'b', 'c'] });
      values.take();
      draw.groups.move('g', { layerId: other });
      const moved = values.take();
      await draw.features.deleteMany(['c']);
      return { moved, kept: values.take() };
    }

    it('tells nothing of the deleted feature when the group moves', async () => {
      const { kept } = await deletedInGroup();
      const events = listen();
      draw.groups.move('g', { layerId: first });
      expect(kept.length).toBe(1);
      expect(JSON.stringify(events)).not.toContain('"c"');
      expect(events[events.length - 1]).toEqual(['changed', [], [], ['a', 'b']]);
      expectPlacesOfRows(['a', 'b', 'c']);
    });

    it('reads nothing of the deleted feature when the move is written back', async () => {
      const { moved } = await deletedInGroup();
      const events = listen();
      await writeBack(moved);
      expect(rowPlace('a')).toEqual({ layerId: first, groupId: 'g' });
      expect(JSON.stringify(events)).not.toContain('"c"');
      expectPlacesOfRows(['a', 'b', 'c']);
    });
  });

  describe(`the place before of a feature that is not kept made, ${name}`, () => {
    const many = Array.from({ length: 2000 }, (_, i) => `z${i}`);

    /** The moves and the places before of what is written back, the features not kept made */
    async function writtenBack(edit: () => unknown) {
      const values = start(asks, ['a', 'b', ...many]);
      edit();
      const taken = values.take();
      for (const id of many) draw.features.get(id);
      const from = new Map<string, unknown>();
      const previous = new Map<string, Place>();
      draw.on('feature.moved', (event) => from.set(event.feature.id, event.from));
      draw.on('feature.updated', (event) =>
        previous.set(event.feature.id, placeIn(event.previous)),
      );
      await writeBack(taken);
      return { from, previous };
    }

    it('is the layer and the position it was moved to', async () => {
      const { from, previous } = await writtenBack(() =>
        draw.features.moveMany(['a', 'b'], { layerId: other }),
      );
      expect(from.get('a')).toEqual({ layerId: other, index: 0 });
      expect(from.get('b')).toEqual({ layerId: other, index: 1 });
      expect(previous.get('a')).toEqual({ layerId: other, groupId: undefined });
      expectPlacesOfRows(['a', 'b', ...many]);
    });

    it('is the group that is gone with the writing back', async () => {
      const { from, previous } = await writtenBack(() =>
        draw.groups.create({ id: 'g', featureIds: ['a', 'b'] }),
      );
      expect(from.get('a')).toEqual({ groupId: 'g', index: 0 });
      expect(from.get('b')).toEqual({ groupId: 'g', index: 1 });
      expect(previous.get('a')).toEqual({ layerId: first, groupId: 'g' });
      expectPlacesOfRows(['a', 'b', ...many]);
    });
  });
}

describe('the work of writing back a move to another layer', () => {
  /** What writing back `count` features moved reads and makes */
  async function workOf(count: number, asks: Asks, listening: boolean) {
    const instance = createCountedInstance();
    ({ draw, store } = instance);
    first = draw.layers.list()[0].id;
    other = draw.layers.create({ id: 'other', name: 'other' })?.id as string;
    const ids = (draw.features.createMany(gridPoints(count)) as Feature[]).map(({ id }) => id);
    const values: FeatureValues[] = [];
    draw.document.subscribe(
      (change) => {
        if (change.source === 'local' && change.previousValues) values.push(change.previousValues);
      },
      { previousValues: asks },
    );
    if (listening) {
      for (const name of [
        'feature.created',
        'feature.updated',
        'feature.deleted',
        'feature.moved',
        'group.moved',
        'document.changed',
      ] as const) {
        draw.on(name, () => {});
      }
    }
    draw.features.moveMany(ids, { layerId: other });
    const before = { ...instance.counts };
    await writeBack(values);
    const work = {
      rows: instance.counts.rowsTouched - before.rowsTouched,
      objects: instance.counts.objectsCreated - before.objectsCreated,
    };
    expect(draw.features.get(ids[0])?.layerId).toBe(first);
    expect(draw.features.get(ids[count - 1])?.layerId).toBe(first);
    return work;
  }

  // The parts of a large edit are split by time, and what is made for each part with them
  for (const [count, margin] of [
    [1_000, 1],
    [10_000, 1.02],
  ] as const) {
    for (const listening of [false, true]) {
      it(`is no more without the values before it, for ${count} ${listening ? 'listened to' : ''}`, async () => {
        const asked = await workOf(count, true, listening);
        draw.destroy();
        const notAsked = await workOf(count, ['local'], listening);
        expect(notAsked.rows).toBeLessThanOrEqual(asked.rows * margin);
        expect(notAsked.objects).toBeLessThanOrEqual(asked.objects * margin);
        // The work with the values before it, which reading them by the layer did not change
        if (count === 1_000 && !listening) expect(asked).toEqual({ rows: 12_001, objects: 30_203 });
      });
    }
  }
});
