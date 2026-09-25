// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for the Group API
 *
 * Verifies that addGroup returns the ID of the new group, and null when the Store refuses the
 * write because it is read-only.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { AutoNameGenerator } from '../shared/utils/name-generator.js';
import { MemoryStore } from '../store/memory.js';
import { createGroupApi, type GroupApi } from './group-api.js';

let store: MemoryStore;
let api: GroupApi;
let idSeq: number;

beforeEach(() => {
  store = new MemoryStore();
  store.createLayer({ id: 'l1', name: 'l1', visible: true, locked: false, opacity: 1, order: [] });
  for (const id of ['a', 'b']) {
    store.createFeature({
      id,
      type: 'Point',
      coordinates: [0, 0],
      layerId: 'l1',
      properties: {},
      locked: false,
      visible: true,
    });
  }
  idSeq = 0;
  api = createGroupApi({
    store,
    generateFeatureId: () => `grp-${++idSeq}`,
    autoNameGenerator: { generateGroupName: () => 'Auto group' } as unknown as AutoNameGenerator,
  });
});

describe('GroupApi.addGroup', () => {
  it('returns the ID of the new group and puts it in the layer order', () => {
    const id = api.addGroup(['a', 'b'], 'l1');
    expect(id).toBe('grp-1');
    expect(store.getGroup('grp-1')?.featureIds).toEqual(['a', 'b']);
    expect(store.getLayer('l1')?.order).toEqual(['grp-1']);
  });

  it('returns null and changes nothing while read-only', () => {
    store.setReadOnly(true);
    expect(api.addGroup(['a', 'b'], 'l1', 'refused')).toBeNull();
    expect(store.getAllGroups()).toEqual([]);
    expect(store.getLayer('l1')?.order).toEqual(['a', 'b']);
  });
});
