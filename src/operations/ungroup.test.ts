// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Behavior tests for ungroupSelection / ungroupGroup (following Felt)
 *
 * - a group selected -> the group is broken up (the children are expanded in place)
 * - a member feature selected -> only that feature leaves (the group is kept, and is
 *   deleted automatically when it becomes empty)
 * - ungroupGroup(id) -> the given group is broken up
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { AutoNameGenerator } from '../shared/utils/name-generator.js';
import { MemoryStore } from '../store/memory.js';
import type { Feature } from '../store/types.js';
import { groupSelection, ungroupGroup, ungroupSelection } from './layer-operations.js';

function feature(id: string): Feature {
  return {
    id,
    type: 'Point',
    geometry: { type: 'Point', coordinates: [0, 0] },
    layerId: 'l1',
    properties: {},
    locked: false,
    visible: true,
    style: {},
  };
}

let store: MemoryStore;
let idSeq: number;
const nameGen = {
  generateGroupName: () => '自動グループ',
} as unknown as AutoNameGenerator;
const generateId = () => `grp-${++idSeq}`;

beforeEach(() => {
  store = new MemoryStore();
  store.createLayer({ id: 'l1', name: 'l1', visible: true, locked: false, opacity: 1, order: [] });
  idSeq = 0;
  store.createFeature(feature('f1'));
  store.createFeature(feature('f2'));
  store.createFeature(feature('f3'));
});

// Groups f1+f2 to make grp-1. The order becomes [f3, grp-1].
function makeGroup(): string {
  store.setSelection('feature', ['f1', 'f2']);
  const id = groupSelection(store, generateId, nameGen);
  if (!id) throw new Error('group not created');
  store.setSelection(null, []);
  return id;
}

describe('ungroupSelection', () => {
  it('breaks up the group and expands the children in place for a group selection', () => {
    const gid = makeGroup();
    store.setSelection('group', [gid]);

    ungroupSelection(store);

    expect(store.getGroup(gid)).toBeUndefined();
    expect(store.getFeature('f1')?.groupId).toBeUndefined();
    expect(store.getFeature('f2')?.groupId).toBeUndefined();
    // f1 and f2 are expanded at the position the group had (the front, where f1,f2 were)
    expect(store.getLayer('l1')?.order).toEqual(['f1', 'f2', 'f3']);
  });

  it('lets only that feature leave and keeps the group for a member feature selection', () => {
    const gid = makeGroup();
    store.setSelection('feature', ['f1']);

    ungroupSelection(store);

    // The group survives (with f2 as the remaining member)
    expect(store.getGroup(gid)?.featureIds).toEqual(['f2']);
    expect(store.getFeature('f2')?.groupId).toBe(gid);
    // The departed f1 loses its groupId and is placed right after the group
    expect(store.getFeature('f1')?.groupId).toBeUndefined();
    expect(store.getLayer('l1')?.order).toEqual([gid, 'f1', 'f3']);
  });

  it('keeps the group even when a member selection leaves only one member', () => {
    const gid = makeGroup();
    store.setSelection('feature', ['f1']);
    ungroupSelection(store);

    // The group is not removed even with only one member (f2)
    expect(store.getGroup(gid)?.featureIds).toEqual(['f2']);
  });

  it('empties the group and deletes it automatically when every member is removed', () => {
    const gid = makeGroup();
    store.setSelection('feature', ['f1', 'f2']);

    ungroupSelection(store);

    expect(store.getGroup(gid)).toBeUndefined();
    expect(store.getFeature('f1')?.groupId).toBeUndefined();
    expect(store.getFeature('f2')?.groupId).toBeUndefined();
  });

  it('does nothing for a selection of a feature that belongs to no group', () => {
    makeGroup();
    const before = store.getLayer('l1')?.order;
    store.setSelection('feature', ['f3']); // f3 belongs to no group

    ungroupSelection(store);

    expect(store.getLayer('l1')?.order).toEqual(before);
    expect(store.getFeature('f3')?.groupId).toBeUndefined();
  });

  it('does nothing when there is no selection', () => {
    const gid = makeGroup();

    ungroupSelection(store);

    expect(store.getGroup(gid)).toBeDefined();
  });
});

describe('ungroupGroup', () => {
  it('breaks up the given group (independently of the selection)', () => {
    const gid = makeGroup();
    // Even with a different selection (none), the given grp can be broken up
    store.setSelection(null, []);

    ungroupGroup(store, gid);

    expect(store.getGroup(gid)).toBeUndefined();
    expect(store.getFeature('f1')?.groupId).toBeUndefined();
    expect(store.getFeature('f2')?.groupId).toBeUndefined();
    expect(store.getLayer('l1')?.order).toEqual(['f1', 'f2', 'f3']);
  });
});
