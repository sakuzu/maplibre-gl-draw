// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for draw.groups: the standard methods, the errors, the refusals, the transactions of
 * the Many methods and move
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { MemoryStore } from '../../store/memory.js';
import type { StoreChange } from '../../store/types.js';
import { createResourceDeps } from '../../test-utils.js';
import { DrawError } from '../errors.js';
import type { GroupsCollection } from '../groups.js';
import { createGroups } from './groups.js';

let store: MemoryStore;
let groups: GroupsCollection;
let notifications: StoreChange[];

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    if (error instanceof DrawError) return error.code;
    throw error;
  }
  return undefined;
}

function layer(id: string): void {
  store.createLayer({
    id,
    name: id,
    visible: true,
    locked: false,
    opacity: 1,
    items: [],
    styleRule: undefined,
    metadata: undefined,
  });
}

function addPoint(id: string, layerId = 'l1'): void {
  store.createFeature({
    id,
    type: 'Point',
    geometry: { type: 'Point', coordinates: [0, 0] },
    layerId,
    groupId: undefined,
    properties: {},
    style: {},
    visible: true,
    locked: false,
  });
}

function itemsOf(layerId: string): readonly string[] {
  return store.getLayer(layerId)?.items ?? [];
}

beforeEach(() => {
  store = new MemoryStore();
  layer('l1');
  layer('l2');
  for (const id of ['a', 'b', 'c', 'd']) addPoint(id);
  addPoint('e', 'l2');
  groups = createGroups(createResourceDeps(store));
  notifications = [];
  store.subscribe((changes) => notifications.push(changes));
});

describe('create and reading', () => {
  it('makes a group in the place of its frontmost member, members in stacking order', () => {
    const group = groups.create({ id: 'g', featureIds: ['c', 'a'], name: 'G' });
    expect(group).toEqual({
      id: 'g',
      layerId: 'l1',
      name: 'G',
      featureIds: ['a', 'c'],
      visible: true,
      locked: false,
    });
    expect(group).toBe(store.getGroup('g'));
    expect(itemsOf('l1')).toEqual(['b', 'g', 'd']);
    expect(store.getFeature('a')?.groupId).toBe('g');
  });

  it('gets, lists, filters and counts', () => {
    groups.createMany([
      { id: 'g1', featureIds: ['a'] },
      { id: 'g2', featureIds: ['e'], locked: true },
    ]);
    expect(groups.get('g2')?.layerId).toBe('l2');
    expect(groups.getMany(['g2', 'x']).map((g) => g?.id)).toEqual(['g2', undefined]);
    expect(groups.has('g1')).toBe(true);
    expect(groups.list().map((g) => g.id)).toEqual(['g1', 'g2']);
    expect(groups.list({ layerId: 'l2' }).map((g) => g.id)).toEqual(['g2']);
    expect(groups.count({ locked: false })).toBe(1);
  });

  it('throws the codes of the contract, creating nothing', () => {
    groups.create({ id: 'g', featureIds: ['a'] });
    expect(codeOf(() => groups.create({ featureIds: ['x'] }))).toBe('not-found');
    expect(codeOf(() => groups.create({ featureIds: ['b', 'e'] }))).toBe('invalid-input');
    expect(codeOf(() => groups.create({ featureIds: [] }))).toBe('invalid-input');
    expect(codeOf(() => groups.create({ id: 'g', featureIds: ['b'] }))).toBe('already-exists');
    expect(codeOf(() => groups.create({ id: 'a', featureIds: ['b'] }))).toBe('already-exists');
    expect(
      codeOf(() =>
        groups.createMany([
          { id: 'h', featureIds: ['b'] },
          { id: 'i', featureIds: ['b'] },
        ]),
      ),
    ).toBe('invalid-input');
    expect(groups.count()).toBe(1);
  });

  it('creates several in one notification, and none while read-only', () => {
    groups.createMany([
      { id: 'g1', featureIds: ['a'] },
      { id: 'g2', featureIds: ['b'] },
    ]);
    expect(notifications).toHaveLength(1);
    store.setReadOnly(true);
    expect(groups.create({ featureIds: ['c'] })).toBeNull();
    expect(groups.createMany([{ featureIds: ['c'] }])).toBeNull();
    expect(groups.count()).toBe(2);
  });
});

describe('update', () => {
  beforeEach(() => {
    groups.createMany([
      { id: 'g', featureIds: ['a'] },
      { id: 'h', featureIds: ['b'], locked: true },
    ]);
    notifications.length = 0;
  });

  it('changes the keys given', () => {
    expect(groups.update('g', { name: 'New', visible: false })).toMatchObject({
      name: 'New',
      visible: false,
    });
  });

  it('throws not-found and invalid-input', () => {
    expect(codeOf(() => groups.update('x', { name: 'x' }))).toBe('not-found');
    expect(codeOf(() => groups.update('g', { featureIds: [] } as never))).toBe('invalid-input');
  });

  it('refuses a change of a locked group but lets its lock change', () => {
    expect(groups.update('h', { name: 'x' })).toBeNull();
    expect(groups.update('h', { locked: false })?.locked).toBe(false);
    store.setReadOnly(true);
    expect(groups.update('g', { name: 'x' })).toBeNull();
  });

  it('changes several in one notification, or none', () => {
    expect(
      groups.updateMany([
        { id: 'g', patch: { name: 'G' } },
        { id: 'h', patch: { name: 'H' } },
      ]),
    ).toBeNull();
    expect(groups.get('g')?.name).not.toBe('G');
    expect(
      groups.updateMany([
        { id: 'g', patch: { name: 'G' } },
        { id: 'h', patch: { visible: false } },
      ]),
    ).toHaveLength(2);
    expect(notifications).toHaveLength(1);
  });
});

describe('delete and deleteMany', () => {
  beforeEach(() => {
    groups.createMany([
      { id: 'g', featureIds: ['a', 'b'] },
      { id: 'h', featureIds: ['c'] },
      { id: 'k', featureIds: ['d'], locked: true },
    ]);
    notifications.length = 0;
  });

  it('deletes a group and keeps its features where it was', () => {
    expect(groups.delete('g')).toBe(true);
    expect(itemsOf('l1')).toEqual(['a', 'b', 'h', 'k']);
    expect(store.getFeature('a')?.groupId).toBeUndefined();
  });

  it('throws not-found, and refuses a locked group and read-only', () => {
    expect(codeOf(() => groups.delete('x'))).toBe('not-found');
    expect(groups.delete('k')).toBe(false);
    store.setReadOnly(true);
    expect(groups.delete('g')).toBe(false);
    expect(groups.count()).toBe(3);
  });

  it('deletes several in one notification, or none', () => {
    expect(codeOf(() => groups.deleteMany(['g', 'x']))).toBe('not-found');
    expect(groups.deleteMany(['g', 'k'])).toBe(false);
    expect(groups.deleteMany(['g', 'h'])).toBe(true);
    expect(groups.list().map((g) => g.id)).toEqual(['k']);
    expect(notifications).toHaveLength(1);
  });
});

describe('move and moveMany', () => {
  beforeEach(() => {
    groups.createMany([
      { id: 'g', featureIds: ['a'] },
      { id: 'h', featureIds: ['c'] },
    ]);
    notifications.length = 0;
  });

  it('moves a group to another layer with its features', () => {
    expect(groups.move('g', { layerId: 'l2', index: 0 })).toBe(true);
    expect(itemsOf('l2')).toEqual(['g', 'e']);
    expect(itemsOf('l1')).toEqual(['b', 'h', 'd']);
    expect(store.getGroup('g')?.layerId).toBe('l2');
    expect(store.getFeature('a')?.layerId).toBe('l2');
  });

  it('reorders a group within its layer', () => {
    groups.move('g', { layerId: 'l1' });
    expect(itemsOf('l1')).toEqual(['b', 'h', 'd', 'g']);
  });

  it('moves several in one notification, keeping their order', () => {
    expect(groups.moveMany(['h', 'g'], { layerId: 'l2' })).toBe(true);
    expect(itemsOf('l2')).toEqual(['e', 'g', 'h']);
    expect(notifications).toHaveLength(1);
  });

  it('throws for a missing group or layer and for a group as the target', () => {
    expect(codeOf(() => groups.move('x', { layerId: 'l2' }))).toBe('not-found');
    expect(codeOf(() => groups.moveMany(['g', 'x'], { layerId: 'l2' }))).toBe('not-found');
    expect(codeOf(() => groups.move('g', { layerId: 'x' }))).toBe('not-found');
    expect(codeOf(() => groups.move('g', { groupId: 'h' }))).toBe('invalid-input');
    expect(codeOf(() => groups.move('g', { groupId: null }))).toBe('invalid-input');
    expect(store.getGroup('g')?.layerId).toBe('l1');
  });

  it('refuses read-only, a locked group and a locked layer', () => {
    store.updateLayer('l2', { locked: true });
    expect(groups.move('g', { layerId: 'l2' })).toBe(false);
    store.updateGroup('h', { locked: true });
    expect(groups.moveMany(['g', 'h'], { layerId: 'l1', index: 0 })).toBe(false);
    store.setReadOnly(true);
    expect(groups.move('g', { layerId: 'l1', index: 0 })).toBe(false);
    expect(itemsOf('l1')).toEqual(['g', 'b', 'h', 'd']);
  });
});
