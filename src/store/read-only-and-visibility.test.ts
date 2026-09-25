// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests of read-only and local visibility
 *
 * - read-only: the methods that write to the shared data become no-ops, while local
 *   states get through
 * - local visibility: the 3-step cascade, the exclusion in getDisplayFeatures,
 *   getOrderedFeatures staying unchanged, clearing the selection of what was hidden, and
 *   the cleanup that follows a deletion
 */

import { describe, expect, it } from 'vitest';
import { getDisplayFeatures, isLocallyHidden } from './local-visibility.js';
import { MemoryStore } from './memory.js';
import type { Feature, Group, Layer } from './types.js';

function makeFeature(id: string, layerId: string, groupId?: string): Feature {
  return {
    id,
    type: 'Point',
    coordinates: [0, 0],
    layerId,
    groupId,
    properties: {},
    locked: false,
    visible: true,
  };
}

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
  store.createLayer(layer);
  return store;
}

describe('read-only', () => {
  it('makes updateFeature a no-op while read-only', () => {
    const store = makeStore();
    store.createFeature(makeFeature('f1', 'l1'));
    store.setReadOnly(true);
    store.updateFeature('f1', { coordinates: [10, 10] });
    expect(store.getFeature('f1')?.coordinates).toEqual([0, 0]);
  });

  it('makes createFeature / deleteFeature / setMetadata no-ops while read-only', () => {
    const store = makeStore();
    store.createFeature(makeFeature('f1', 'l1'));
    store.setReadOnly(true);
    store.createFeature(makeFeature('f2', 'l1'));
    store.deleteFeature('f1');
    store.setMetadata({ description: 'x' });
    expect(store.getFeature('f2')).toBeUndefined();
    expect(store.getFeature('f1')).toBeDefined();
    expect(store.getMetadata().description).toBeUndefined();
  });

  it('lets the selection, the mode and local visibility through even while read-only', () => {
    const store = makeStore();
    store.createFeature(makeFeature('f1', 'l1'));
    store.setReadOnly(true);
    store.setSelection('feature', ['f1']);
    expect(store.getSelection()).toEqual({ type: 'feature', ids: ['f1'] });
    store.setMode('draw_point');
    expect(store.getMode()).toBe('draw_point');
    store.setLocallyHidden('f1', true);
    expect(store.isLocallyHidden('f1')).toBe(true);
  });

  it('lets writes through once read-only is turned off', () => {
    const store = makeStore();
    store.createFeature(makeFeature('f1', 'l1'));
    store.setReadOnly(true);
    store.setReadOnly(false);
    store.updateFeature('f1', { coordinates: [5, 5] });
    expect(store.getFeature('f1')?.coordinates).toEqual([5, 5]);
  });
});

describe('the interaction lock', () => {
  it('has the basic behavior of setInteractionLock / isInteractionLocked', () => {
    const store = makeStore();
    expect(store.isInteractionLocked()).toBe(false);
    store.setInteractionLock(true);
    expect(store.isInteractionLocked()).toBe(true);
    store.setInteractionLock(false);
    expect(store.isInteractionLocked()).toBe(false);
  });

  it('lets Store writes through while the interaction lock is on (orthogonal to readOnly)', () => {
    const store = makeStore();
    store.createFeature(makeFeature('f1', 'l1'));
    store.setInteractionLock(true);
    // Writes are not gated by the interaction lock (that is the job of readOnly).
    store.createFeature(makeFeature('f2', 'l1'));
    store.updateFeature('f1', { coordinates: [10, 10] });
    store.setMetadata({ description: 'x' });
    expect(store.getFeature('f2')).toBeDefined();
    expect(store.getFeature('f1')?.coordinates).toEqual([10, 10]);
    expect(store.getMetadata().description).toBe('x');
  });

  it('toggles the interaction lock independently of readOnly', () => {
    const store = makeStore();
    store.setInteractionLock(true);
    expect(store.isReadOnly()).toBe(false);
    store.setReadOnly(true);
    store.setInteractionLock(false);
    expect(store.isReadOnly()).toBe(true);
    expect(store.isInteractionLocked()).toBe(false);
  });
});

describe('local visibility', () => {
  it('decides isLocallyHidden by 3 steps: the feature itself / its group / its layer', () => {
    const store = makeStore();
    store.createFeature(makeFeature('f1', 'l1'));
    const feature = store.getFeature('f1') as Feature;

    expect(isLocallyHidden(feature, store)).toBe(false);
    store.setLocallyHidden('l1', true);
    expect(isLocallyHidden(feature, store)).toBe(true);
    store.setLocallyHidden('l1', false);
    expect(isLocallyHidden(feature, store)).toBe(false);
    store.setLocallyHidden('f1', true);
    expect(isLocallyHidden(feature, store)).toBe(true);
  });

  it('removes the features under a group from the display list when the group is hidden', () => {
    const store = makeStore();
    const group: Group = { id: 'g1', name: 'g', featureIds: [], locked: false, visible: true };
    store.createGroup(group);
    store.createFeature(makeFeature('f1', 'l1', 'g1'));
    store.createFeature(makeFeature('f2', 'l1'));
    // Arrange the group g1 and the feature f2 in the layer order.
    store.updateLayer('l1', { order: ['g1', 'f2'] });

    store.setLocallyHidden('g1', true);
    const displayed = getDisplayFeatures(store).map((f) => f.id);
    expect(displayed).toEqual(['f2']);
    // getOrderedFeatures (the shared source of truth) does not change
    expect(
      store
        .getOrderedFeatures()
        .map((f) => f.id)
        .sort(),
    ).toEqual(['f1', 'f2']);
  });

  it('drops a hidden feature from the selection', () => {
    const store = makeStore();
    store.createFeature(makeFeature('f1', 'l1'));
    store.createFeature(makeFeature('f2', 'l1'));
    store.setSelection('feature', ['f1', 'f2']);
    store.setLocallyHidden('f1', true);
    expect(store.getSelection()).toEqual({ type: 'feature', ids: ['f2'] });
  });

  it('removes it from the local hidden set too when the feature is deleted', () => {
    const store = makeStore();
    store.createFeature(makeFeature('f1', 'l1'));
    store.setLocallyHidden('f1', true);
    store.deleteFeature('f1');
    expect(store.isLocallyHidden('f1')).toBe(false);
  });
});
