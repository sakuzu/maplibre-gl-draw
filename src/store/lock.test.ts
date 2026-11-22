// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests of the effective lock decision
 *
 * A lock is inherited top-down: if the feature itself, the group it belongs to, or the
 * layer it belongs to is locked, it is regarded as not operable.
 */

import { describe, expect, it } from 'vitest';
import { createTestDocument } from '../test-utils.js';
import type { InstanceDocument } from './document-access.js';
import { isFeatureLocked, isGroupLocked, isInteractionBlocked } from './lock.js';
import type { Feature, Group, Layer } from './types.js';

function makeStore(): InstanceDocument {
  const store = createTestDocument();
  const layer: Layer = {
    id: 'l1',
    name: 'l1',
    visible: true,
    locked: false,
    opacity: 1,
    styleRule: undefined,
    metadata: undefined,
  };
  const lockedLayer: Layer = {
    id: 'lLocked',
    name: 'x',
    visible: true,
    locked: true,
    opacity: 1,
    styleRule: undefined,
    metadata: undefined,
  };
  store.createLayer(layer);
  store.createLayer(lockedLayer);
  return store;
}

function makeFeature(id: string, layerId: string, locked = false): Feature {
  return {
    groupId: undefined,
    id,
    type: 'Point',
    geometry: { type: 'Point', coordinates: [0, 0] },
    layerId,
    properties: {},
    locked,
    visible: true,
    style: {},
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
    const group: Group = {
      id: 'g1',
      layerId: 'l1',
      name: 'g',
      locked: true,
      visible: true,
    };
    store.createGroupWith(group, ['f1']);
    expect(isFeatureLocked(store.getFeature('f1') as Feature, store)).toBe(true);
  });

  it('is false if none of the feature/the group/the layer is locked', () => {
    const store = makeStore();
    store.createFeature(makeFeature('f1', 'l1'));
    const group: Group = {
      id: 'g1',
      layerId: 'l1',
      name: 'g',
      locked: false,
      visible: true,
    };
    store.createGroupWith(group, ['f1']);
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
  const findLayerOfGroup = (store: InstanceDocument) => (groupId: string) => {
    const group = store.getGroup(groupId);
    return group === undefined ? undefined : store.getLayer(group.layerId);
  };

  it('is true if the group itself is locked', () => {
    const store = makeStore();
    const group: Group = {
      id: 'g1',
      layerId: 'l1',
      name: 'g',
      locked: true,
      visible: true,
    };
    expect(isGroupLocked(group, findLayerOfGroup(store))).toBe(true);
  });

  it('is true if the layer it belongs to is locked', () => {
    const store = makeStore();
    const group: Group = {
      id: 'g1',
      layerId: 'lLocked',
      name: 'g',
      locked: false,
      visible: true,
    };
    store.createGroup(group);
    expect(isGroupLocked(group, findLayerOfGroup(store))).toBe(true);
  });

  it('is false if neither the group nor the layer is locked', () => {
    const store = makeStore();
    const group: Group = {
      id: 'g1',
      layerId: 'l1',
      name: 'g',
      locked: false,
      visible: true,
    };
    store.createGroup(group);
    expect(isGroupLocked(group, findLayerOfGroup(store))).toBe(false);
  });
});
