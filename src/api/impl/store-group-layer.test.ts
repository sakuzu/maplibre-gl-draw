// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A group put in another layer by a write to the Store directly (`updateGroup` with `layerId`),
 * as a change made outside the instance is written: its members go with it, and the instance
 * reads them and tells them as `groups.move` does when it moves the group to the same place
 */

import { describe, expect, it } from 'vitest';
import { createStore } from '../../store/built-in/create-store.js';
import type { Store } from '../../store/built-in/types.js';
import { createMapStub } from '../../test-utils.js';
import type { DocumentSubscribeOptions } from '../document.js';
import type { Draw } from '../draw.js';
import type { DrawEvents } from '../events.js';
import type { Feature } from '../model.js';
import { createDraw } from './create-draw.js';

const EVENTS = [
  'feature.created',
  'feature.updated',
  'feature.deleted',
  'feature.moved',
  'group.moved',
  'group.created',
  'group.updated',
  'group.deleted',
  'layer.updated',
  'document.changed',
] as const satisfies readonly (keyof DrawEvents)[];

/** A value with its keys in order, the sets of IDs as lists, without the source */
function plain(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(plain);
  const object = value as Record<string, unknown>;
  if (typeof object.iterate === 'function') return [...object.iterate()];
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(object).sort()) {
    if (object[key] !== undefined && key !== 'source') out[key] = plain(object[key]);
  }
  return out;
}

const point = (id: string, layerId: string) => ({
  id,
  type: 'Point' as const,
  geometry: { type: 'Point' as const, coordinates: [0, 0] },
  layerId,
});

/** The layers `l1` and `l2`, the feature p1 and the group g1 of p2 and p3 in `l1` */
function setUp(others = 0): { draw: Draw; store: Store; told: unknown[] } {
  const store = createStore();
  const draw = createDraw(createMapStub().map, {
    store,
    initDefaultLayer: false,
  });
  draw.layers.create({ id: 'l1', name: 'l1' });
  draw.layers.create({ id: 'l2', name: 'l2' });
  draw.features.createMany(['p1', 'p2', 'p3'].map((id) => point(id, 'l1')));
  draw.groups.create({ id: 'g1', featureIds: ['p2', 'p3'] });
  draw.features.create(point('q', 'l2'));
  if (others > 0) {
    draw.layers.create({ id: 'others', name: 'others' });
    const ids = Array.from({ length: others }, (_, i) => `z${i}`);
    draw.features.createMany(ids.map((id) => point(id, 'others')));
    // Reading them lets go of the features made before
    for (const id of ids) draw.features.get(id);
  }
  const told: unknown[] = [];
  for (const name of EVENTS) draw.on(name, (payload) => told.push([name, plain(payload)]));
  return { draw, store, told };
}

/** What the instance reads of the layer and the group of a feature, however it is read */
function placesOf(draw: Draw, id: string) {
  const got = draw.features.get(id);
  const iterated = [...draw.features.iterate()].find((feature) => feature.id === id);
  const json = draw.document.toJSON().features.find((feature) => feature.id === id);
  return [got, iterated, json].map((feature) => ({
    layerId: feature?.layerId,
    groupId: feature?.groupId,
  }));
}

/** The events of `groups.move` putting g1 at the front of `l2` */
function toldByMove(): unknown[] {
  const { draw, told } = setUp();
  draw.groups.move('g1', { layerId: 'l2', index: 0 });
  draw.destroy();
  return told;
}

describe('a group put in another layer in the Store', () => {
  for (const source of ['remote', 'local'] as const) {
    it(`moves its members with it, written with the source ${source}`, () => {
      const { draw, store, told } = setUp();
      store.transact(() => store.updateGroup('g1', { layerId: 'l2', orderKey: 'A' }), source);
      for (const id of ['p2', 'p3']) {
        expect(placesOf(draw, id)).toEqual(Array(3).fill({ layerId: 'l2', groupId: 'g1' }));
      }
      expect(placesOf(draw, 'p1')).toEqual(Array(3).fill({ layerId: 'l1', groupId: undefined }));
      expect(draw.layers.listItemIds('l2', { start: 0, end: 10 })).toEqual(['g1', 'q']);
      expect(draw.groups.listFeatureIds('g1', { start: 0, end: 10 })).toEqual(['p2', 'p3']);
      const moved = told.filter((event) => (event as [string])[0] === 'feature.moved');
      expect(moved.map((event) => (event as [string, { feature: Feature }])[1].feature.id)).toEqual(
        ['p2', 'p3'],
      );
      const changed = told.find((event) => (event as [string])[0] === 'document.changed') as [
        string,
        { features: { moved: string[] } },
      ];
      expect(changed[1].features.moved).toEqual(['p2', 'p3']);
      // As `groups.move` tells the same move
      expect(told).toEqual(toldByMove());
      // As another instance over the Store reads it
      const another = createDraw(createMapStub().map, { store });
      expect([...another.features.iterate()]).toEqual([...draw.features.iterate()]);
      another.destroy();
      draw.destroy();
    });
  }

  it('given another key only, tells no member as moved', () => {
    const { draw, store, told } = setUp();
    store.transact(() => store.updateGroup('g1', { orderKey: 'A' }), 'remote');
    const names = told.map((event) => (event as [string])[0]);
    expect(names).not.toContain('feature.moved');
    expect(names).not.toContain('feature.updated');
    const changed = told.find((event) => (event as [string])[0] === 'document.changed') as [
      string,
      { features: { moved: string[]; updated: string[] } },
    ];
    expect(changed?.[1].features.moved ?? []).toEqual([]);
    expect(changed?.[1].features.updated ?? []).toEqual([]);
    expect(placesOf(draw, 'p2')).toEqual(Array(3).fill({ layerId: 'l1', groupId: 'g1' }));
    draw.destroy();
  });

  // The members are not kept made, in a document of more features than the layer keeps
  for (const asks of [null, true, ['local']] as (
    | DocumentSubscribeOptions['previousValues']
    | null
  )[]) {
    it(`tells the layer its members were in, not kept made, ${JSON.stringify(asks)} asked`, () => {
      const { draw, store, told } = setUp(1_100);
      if (asks !== null) draw.document.subscribe(() => {}, { previousValues: asks });
      store.transact(() => store.updateGroup('g1', { layerId: 'l2', orderKey: 'A' }), 'remote');
      const updated = told
        .filter((event) => (event as [string])[0] === 'feature.updated')
        .map((event) => (event as [string, { feature: Feature; previous: Feature }])[1]);
      expect(
        updated.map(({ feature, previous }) => [feature.id, previous.layerId, previous.groupId]),
      ).toEqual([
        ['p2', 'l1', 'g1'],
        ['p3', 'l1', 'g1'],
      ]);
      expect(updated.every(({ feature }) => feature.layerId === 'l2')).toBe(true);
      const moved = told
        .filter((event) => (event as [string])[0] === 'feature.moved')
        .map((event) => (event as [string, { feature: Feature; from: unknown }])[1]);
      expect(moved.map(({ feature, from }) => [feature.id, from])).toEqual([
        ['p2', { groupId: 'g1', index: 0 }],
        ['p3', { groupId: 'g1', index: 1 }],
      ]);
      for (const id of ['p2', 'p3']) {
        expect(placesOf(draw, id)).toEqual(Array(3).fill({ layerId: 'l2', groupId: 'g1' }));
      }
      draw.destroy();
    });
  }
});
