// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests of the effective lock decision
 *
 * A lock is inherited top-down: if the feature itself, the group it belongs to, or the
 * layer it belongs to is locked, it is regarded as not operable.
 */

import { describe, expect, it } from 'vitest';
import { isFeatureLocked, isGroupLocked, isInteractionBlocked } from './lock.js';
import { MemoryStore } from './memory.js';
import type { Feature, Group, Layer } from './types.js';

function makeStore(): MemoryStore {
  const store = new MemoryStore();
  const layer: Layer = {
    id: 'l1',
    name: 'l1',
    visible: true,
    locked: false,
    opacity: 1,
    order: [],
  };
  const lockedLayer: Layer = {
    id: 'lLocked',
    name: 'x',
    visible: true,
    locked: true,
    opacity: 1,
    order: [],
  };
  store.createLayer(layer);
  store.createLayer(lockedLayer);
  return store;
}

function makeFeature(id: string, layerId: string, locked = false): Feature {
  return {
    id,
    type: 'Point',
    coordinates: [0, 0],
    layerId,
    properties: {},
    locked,
    visible: true,
  };
}

describe('isFeatureLocked', () => {
  it('is true if the feature itself is locked', () => {
    const store = makeStore();
    store.createFeature(makeFeature('f1', 'l1', true));
    expect(isFeatureLocked(store.getFeature('f1') as Feature, store)).toBe(true);
  });

  it('is true if the layer it belongs to is locked', () => {
    const store = makeStore();
    store.createFeature(makeFeature('f1', 'lLocked'));
    expect(isFeatureLocked(store.getFeature('f1') as Feature, store)).toBe(true);
  });

  it('is true if the group it belongs to is locked', () => {
    const store = makeStore();
    store.createFeature(makeFeature('f1', 'l1'));
    const group: Group = { id: 'g1', name: 'g', featureIds: ['f1'], locked: true, visible: true };
    store.createGroup(group);
    expect(isFeatureLocked(store.getFeature('f1') as Feature, store)).toBe(true);
  });

  it('is false if none of the feature/the group/the layer is locked', () => {
    const store = makeStore();
    store.createFeature(makeFeature('f1', 'l1'));
    const group: Group = { id: 'g1', name: 'g', featureIds: ['f1'], locked: false, visible: true };
    store.createGroup(group);
    expect(isFeatureLocked(store.getFeature('f1') as Feature, store)).toBe(false);
  });
});

describe('isInteractionBlocked', () => {
  it('is false if none of the states is set', () => {
    const store = makeStore();
    store.createFeature(makeFeature('f1', 'l1'));
    expect(isInteractionBlocked(store.getFeature('f1') as Feature, store)).toBe(false);
  });

  it('is true when readOnly', () => {
    const store = makeStore();
    store.createFeature(makeFeature('f1', 'l1'));
    store.setReadOnly(true);
    expect(isInteractionBlocked(store.getFeature('f1') as Feature, store)).toBe(true);
  });

  it('is true when the interaction lock is on', () => {
    const store = makeStore();
    store.createFeature(makeFeature('f1', 'l1'));
    store.setInteractionLock(true);
    expect(isInteractionBlocked(store.getFeature('f1') as Feature, store)).toBe(true);
  });

  it('is true when the feature is effectively locked (itself/its group/its layer)', () => {
    const store = makeStore();
    store.createFeature(makeFeature('f1', 'l1', true));
    store.createFeature(makeFeature('f2', 'lLocked'));
    expect(isInteractionBlocked(store.getFeature('f1') as Feature, store)).toBe(true);
    expect(isInteractionBlocked(store.getFeature('f2') as Feature, store)).toBe(true);
  });
});

describe('isGroupLocked', () => {
  const findLayerOfGroup = (store: MemoryStore) => (groupId: string) =>
    store.getAllLayers().find((l) => l.order.includes(groupId));

  it('is true if the group itself is locked', () => {
    const store = makeStore();
    const group: Group = { id: 'g1', name: 'g', featureIds: [], locked: true, visible: true };
    expect(isGroupLocked(group, findLayerOfGroup(store))).toBe(true);
  });

  it('is true if the layer it belongs to is locked', () => {
    const store = makeStore();
    store.updateLayer('lLocked', { order: ['g1'] });
    const group: Group = { id: 'g1', name: 'g', featureIds: [], locked: false, visible: true };
    expect(isGroupLocked(group, findLayerOfGroup(store))).toBe(true);
  });

  it('is false if neither the group nor the layer is locked', () => {
    const store = makeStore();
    store.updateLayer('l1', { order: ['g1'] });
    const group: Group = { id: 'g1', name: 'g', featureIds: [], locked: false, visible: true };
    expect(isGroupLocked(group, findLayerOfGroup(store))).toBe(false);
  });
});
