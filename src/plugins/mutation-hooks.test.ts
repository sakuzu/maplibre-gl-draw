// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for the mutation hooks fired from the Store notification
 */

import { describe, expect, it, vi } from 'vitest';
import { MemoryStore } from '../store/memory.js';
import type { Feature } from '../store/types.js';
import { subscribeMutationHooks } from './mutation-hooks.js';
import type { Plugin } from './plugin.js';
import { createPluginManager } from './plugin-manager.js';

function point(id: string): Feature {
  return {
    id,
    type: 'Point',
    geometry: { type: 'Point', coordinates: [0, 0] },
    layerId: 'l',
    properties: {},
    locked: false,
    visible: true,
    style: {},
  };
}

function setup(plugin: Plugin) {
  const store = new MemoryStore();
  store.createLayer({ id: 'l', name: 'l', visible: true, locked: false, opacity: 1, items: [] });
  const manager = createPluginManager(() => ({}) as never, { registerMode: vi.fn() } as never);
  manager.register(plugin);
  const stop = subscribeMutationHooks(store, manager);
  return { store, stop };
}

describe('the mutation hooks', () => {
  it('fire for a write made on the Store directly (a mode, a drag, import)', () => {
    const afterCreate = vi.fn();
    const afterUpdate = vi.fn();
    const afterDelete = vi.fn();
    const { store } = setup({
      name: 'p',
      hooks: {
        'feature:afterCreate': afterCreate,
        'feature:afterUpdate': afterUpdate,
        'feature:afterDelete': afterDelete,
      },
    });

    store.createFeature(point('a'));
    store.updateFeature('a', { geometry: { type: 'Point', coordinates: [1, 1] } });
    store.deleteFeature('a');

    expect(afterCreate).toHaveBeenCalledWith(
      [expect.objectContaining({ id: 'a' })],
      expect.objectContaining({ source: 'local' }),
    );
    expect(afterUpdate).toHaveBeenCalledWith(
      [expect.objectContaining({ geometry: { type: 'Point', coordinates: [1, 1] } })],
      [expect.objectContaining({ geometry: { type: 'Point', coordinates: [0, 0] } })],
      expect.anything(),
    );
    expect(afterDelete).toHaveBeenCalledWith(
      [expect.objectContaining({ id: 'a' })],
      expect.anything(),
    );
  });

  it('do not report the intermediate updates of an edit in progress', () => {
    const afterUpdate = vi.fn();
    const { store } = setup({ name: 'p', hooks: { 'feature:afterUpdate': afterUpdate } });
    store.createFeature(point('a'));

    store.updateFeature(
      'a',
      { geometry: { type: 'Point', coordinates: [1, 1] } },
      { isIntermediate: true },
    );
    expect(afterUpdate).not.toHaveBeenCalled();

    store.updateFeature('a', { geometry: { type: 'Point', coordinates: [2, 2] } });
    expect(afterUpdate).toHaveBeenCalledTimes(1);
  });

  it('share the source and the batchId of one transaction', () => {
    const contexts: unknown[] = [];
    const { store } = setup({
      name: 'p',
      hooks: {
        'feature:afterCreate': (_features, ctx) => contexts.push(ctx),
        'layer:afterCreate': (_layer, ctx) => contexts.push(ctx),
      },
    });

    store.transact(() => {
      store.createLayer({
        id: 'm',
        name: 'm',
        visible: true,
        locked: false,
        opacity: 1,
        items: [],
      });
      store.createFeature({ ...point('a'), layerId: 'm' });
    }, 'import');

    expect(contexts).toHaveLength(2);
    expect(contexts[0]).toEqual(contexts[1]);
    expect(contexts[0]).toMatchObject({ source: 'import' });
  });

  it('fire for groups, layers and the selection', () => {
    const calls: string[] = [];
    const { store } = setup({
      name: 'p',
      hooks: {
        'group:afterCreate': () => calls.push('group:create'),
        'layer:afterUpdate': () => calls.push('layer:update'),
        'selection:afterChange': (ids, previous) =>
          calls.push(`selection:${previous.join()}>${ids.join()}`),
      },
    });
    store.createFeature(point('a'));
    calls.length = 0;

    store.createGroup({
      id: 'g',
      layerId: 'l',
      name: 'g',
      visible: true,
      locked: false,
      featureIds: ['a'],
    });
    store.setSelection('feature', ['a']);

    expect(calls).toContain('group:create');
    expect(calls).toContain('layer:update');
    expect(calls).toContain('selection:>a');
  });

  it('fire nothing for a write the read-only Store refused', () => {
    const afterCreate = vi.fn();
    const { store } = setup({ name: 'p', hooks: { 'feature:afterCreate': afterCreate } });
    store.setReadOnly(true);
    store.createFeature(point('a'));
    expect(afterCreate).not.toHaveBeenCalled();
  });

  it('stop firing after the subscription is stopped', () => {
    const afterCreate = vi.fn();
    const { store, stop } = setup({ name: 'p', hooks: { 'feature:afterCreate': afterCreate } });
    stop();
    store.createFeature(point('a'));
    expect(afterCreate).not.toHaveBeenCalled();
  });
});
