// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for the preconditions of groupSelection
 *
 * Verifies that even a feature whose groupId is a stale value pointing at a deleted group
 * is treated as unassigned and can be grouped again (self-repair). A feature that belongs
 * to a group that really exists is still rejected as before.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { AutoNameGenerator } from '../shared/utils/name-generator.js';
import { MemoryStore } from '../store/memory.js';
import type { Feature } from '../store/types.js';
import { groupSelection } from './layer-operations.js';

function feature(id: string): Feature {
  return {
    id,
    type: 'Point',
    geometry: { type: 'Point', coordinates: [0, 0] },
    layerId: 'l1',
    groupId: undefined,
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

beforeEach(() => {
  store = new MemoryStore();
  store.createLayer({
    id: 'l1',
    name: 'l1',
    visible: true,
    locked: false,
    opacity: 1,
    items: [],
    styleRule: undefined,
    metadata: undefined,
  });
  idSeq = 0;
  store.createFeature(feature('f1'));
  store.createFeature(feature('f2'));
});

const generateId = () => `grp-${++idSeq}`;

describe('groupSelection', () => {
  it('can group two features that belong to no group', () => {
    store.setSelection('feature', ['f1', 'f2']);

    const groupId = groupSelection(store, generateId, nameGen);

    expect(groupId).toBe('grp-1');
    expect(store.getFeature('f1')?.groupId).toBe('grp-1');
    expect(store.getFeature('f2')?.groupId).toBe('grp-1');
    expect(store.getLayer('l1')?.items).toContain('grp-1');
  });

  it('rejects regrouping a feature that belongs to a group that really exists', () => {
    store.setSelection('feature', ['f1', 'f2']);
    const first = groupSelection(store, generateId, nameGen);
    expect(first).toBe('grp-1');

    // Trying to group f1/f2, which already belong to grp-1, again is rejected
    store.setSelection('feature', ['f1', 'f2']);
    const second = groupSelection(store, generateId, nameGen);
    expect(second).toBeNull();
  });

  it('can regroup a feature with a stale groupId (a deleted group)', () => {
    // Reproduce the broken state by directly setting a stale groupId pointing at a
    // deleted group
    store.updateFeature('f1', { groupId: 'ghost-group' });
    store.updateFeature('f2', { groupId: 'ghost-group' });
    expect(store.getGroup('ghost-group')).toBeUndefined();

    store.setSelection('feature', ['f1', 'f2']);
    const groupId = groupSelection(store, generateId, nameGen);

    // Self-repair: a new group is created and groupId is overwritten with the right value
    expect(groupId).toBe('grp-1');
    expect(store.getFeature('f1')?.groupId).toBe('grp-1');
    expect(store.getFeature('f2')?.groupId).toBe('grp-1');
    expect(store.getLayer('l1')?.items).toContain('grp-1');
  });

  it('adds the group to order even for a stale feature missing from order (orphan)', () => {
    // Set a stale groupId and also drop it from layer.order to create the orphan state
    store.updateFeature('f1', { groupId: 'ghost-group' });
    store.updateFeature('f2', { groupId: 'ghost-group' });
    store.updateLayer('l1', { items: [] });

    store.setSelection('feature', ['f1', 'f2']);
    const groupId = groupSelection(store, generateId, nameGen);

    expect(groupId).toBe('grp-1');
    // The group is not missing from order even when no selected feature is in order
    expect(store.getLayer('l1')?.items).toEqual(['grp-1']);
  });
});
