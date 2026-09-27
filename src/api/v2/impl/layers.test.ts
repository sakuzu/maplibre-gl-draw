// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for draw.layers: the standard methods, the errors, the refusals, the transactions of
 * the Many methods, reorder and the active layer
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { MemoryStore } from '../../../store/memory.js';
import type { StateChanges } from '../../../store/types.js';
import { createResourceDeps } from '../../../test-utils.js';
import { DrawError } from '../errors.js';
import type { LayersCollection } from '../layers.js';
import { createLayers } from './layers.js';

let store: MemoryStore;
let layers: LayersCollection;
let notifications: StateChanges[];

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    if (error instanceof DrawError) return error.code;
    throw error;
  }
  return undefined;
}

function addPoint(id: string, layerId: string, locked = false): void {
  store.createFeature({
    id,
    type: 'Point',
    geometry: { type: 'Point', coordinates: [0, 0] },
    layerId,
    groupId: undefined,
    properties: {},
    style: {},
    visible: true,
    locked,
  });
}

beforeEach(() => {
  store = new MemoryStore();
  layers = createLayers(createResourceDeps(store));
  notifications = [];
  store.subscribe((changes) => notifications.push(changes));
});

describe('create and reading', () => {
  it('creates a layer with the defaults at the front and returns the stored layer', () => {
    const first = layers.create({ id: 'a', name: 'A' });
    expect(first).toEqual({
      id: 'a',
      name: 'A',
      visible: true,
      locked: false,
      opacity: 1,
      items: [],
      styleRule: undefined,
      metadata: undefined,
    });
    expect(first).toBe(store.getLayer('a'));
    const second = layers.create({ metadata: { owner: 'x' } });
    expect(second?.id).toBe('id-1');
    expect(second?.name).not.toBe('');
    expect(store.getLayerOrder()).toEqual(['a', 'id-1']);
  });

  it('puts a layer at its index of the stacking order', () => {
    layers.createMany([{ id: 'a' }, { id: 'b' }]);
    layers.create({ id: 'c', index: 0 });
    expect(layers.list().map((l) => l.id)).toEqual(['c', 'a', 'b']);
  });

  it('gets, lists in stacking order, filters and counts', () => {
    layers.createMany([{ id: 'a' }, { id: 'b', locked: true }, { id: 'c', visible: false }]);
    expect(layers.get('b')?.locked).toBe(true);
    expect(layers.getMany(['c', 'x']).map((l) => l?.id)).toEqual(['c', undefined]);
    expect(layers.has('a')).toBe(true);
    expect(layers.list({ locked: false }).map((l) => l.id)).toEqual(['a', 'c']);
    expect(layers.count({ visible: false })).toBe(1);
    expect(layers.count()).toBe(3);
  });

  it('throws already-exists and invalid-input, creating nothing', () => {
    layers.create({ id: 'a' });
    expect(codeOf(() => layers.create({ id: 'a' }))).toBe('already-exists');
    expect(codeOf(() => layers.create({ opacity: 2 }))).toBe('invalid-input');
    expect(codeOf(() => layers.create({ styleRule: { kind: 'x' } as never }))).toBe(
      'invalid-input',
    );
    expect(codeOf(() => layers.create({ index: 1.5 }))).toBe('invalid-input');
    expect(codeOf(() => layers.create({ order: [] } as never))).toBe('invalid-input');
    expect(codeOf(() => layers.createMany([{ id: 'b' }, { id: 'b' }]))).toBe('already-exists');
    expect(layers.count()).toBe(1);
  });

  it('creates several in one notification, and none while read-only', () => {
    layers.createMany([{ id: 'a' }, { id: 'b' }]);
    expect(notifications).toHaveLength(1);
    store.setReadOnly(true);
    expect(layers.create({ id: 'c' })).toBeNull();
    expect(layers.createMany([{ id: 'c' }])).toBeNull();
    expect(layers.count()).toBe(2);
  });
});

describe('update', () => {
  beforeEach(() => {
    layers.createMany([
      { id: 'a', styleRule: { kind: 'single', color: '#ff0000' } },
      { id: 'b', locked: true },
    ]);
  });

  it('changes the keys given and removes the style rule given as undefined', () => {
    const updated = layers.update('a', { name: 'New', opacity: 0.5, styleRule: undefined });
    expect(updated).toMatchObject({ name: 'New', opacity: 0.5, styleRule: undefined });
    expect(updated).toBe(store.getLayer('a'));
  });

  it('throws not-found and invalid-input', () => {
    expect(codeOf(() => layers.update('x', { name: 'x' }))).toBe('not-found');
    expect(codeOf(() => layers.update('a', { items: [] } as never))).toBe('invalid-input');
    expect(codeOf(() => layers.update('a', { name: 3 } as never))).toBe('invalid-input');
  });

  it('refuses a change of a locked layer but lets its lock and visibility change', () => {
    expect(layers.update('b', { name: 'x' })).toBeNull();
    expect(layers.update('b', { visible: false })?.visible).toBe(false);
    store.setReadOnly(true);
    expect(layers.update('a', { name: 'x' })).toBeNull();
  });

  it('changes several in one notification, or none', () => {
    notifications.length = 0;
    expect(
      layers.updateMany([
        { id: 'a', patch: { name: 'A' } },
        { id: 'b', patch: { name: 'B' } },
      ]),
    ).toBeNull();
    expect(layers.get('a')?.name).not.toBe('A');
    expect(
      layers.updateMany([
        { id: 'a', patch: { name: 'A' } },
        { id: 'b', patch: { locked: false } },
      ]),
    ).toHaveLength(2);
    expect(notifications).toHaveLength(1);
  });
});

describe('delete and deleteMany', () => {
  beforeEach(() => {
    layers.createMany([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
    addPoint('p', 'a');
    addPoint('q', 'b', true);
  });

  it('deletes a layer with its features', () => {
    expect(layers.delete('a')).toBe(true);
    expect(store.getFeature('p')).toBeUndefined();
  });

  it('throws not-found, and refuses a layer that holds a lock and read-only', () => {
    expect(codeOf(() => layers.delete('x'))).toBe('not-found');
    expect(layers.delete('b')).toBe(false);
    store.setReadOnly(true);
    expect(layers.delete('a')).toBe(false);
    expect(layers.count()).toBe(3);
  });

  it('deletes several in one notification, or none', () => {
    expect(codeOf(() => layers.deleteMany(['a', 'x']))).toBe('not-found');
    expect(layers.deleteMany(['a', 'b'])).toBe(false);
    notifications.length = 0;
    expect(layers.deleteMany(['a', 'c'])).toBe(true);
    expect(layers.list().map((l) => l.id)).toEqual(['b']);
    expect(notifications).toHaveLength(1);
  });
});

describe('reorder', () => {
  beforeEach(() => {
    layers.createMany([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
  });

  it('changes the stacking order and keeps the entries from outside the document', () => {
    store.setLayerOrder(['a', 'dataset', 'b', 'c']);
    expect(layers.reorder(['c', 'b', 'a'])).toBe(true);
    expect(store.getLayerOrder()).toEqual(['c', 'dataset', 'b', 'a']);
  });

  it('throws unless every layer is listed once', () => {
    expect(codeOf(() => layers.reorder(['a', 'b']))).toBe('invalid-input');
    expect(codeOf(() => layers.reorder(['a', 'b', 'b']))).toBe('invalid-input');
    expect(codeOf(() => layers.reorder(['a', 'b', 'x']))).toBe('not-found');
  });

  it('refuses while read-only', () => {
    store.setReadOnly(true);
    expect(layers.reorder(['c', 'b', 'a'])).toBe(false);
    expect(store.getLayerOrder()).toEqual(['a', 'b', 'c']);
  });
});

describe('the active layer', () => {
  it('is null without layers, then the first layer until another is set', () => {
    expect(layers.getActive()).toBeNull();
    layers.createMany([{ id: 'a' }, { id: 'b' }, { id: 'c', locked: true }]);
    expect(layers.getActive()?.id).toBe('a');
    expect(layers.setActive('b')).toBe(true);
    expect(layers.getActive()?.id).toBe('b');
  });

  it('throws not-found and refuses a locked layer', () => {
    layers.createMany([{ id: 'a' }, { id: 'c', locked: true }]);
    expect(codeOf(() => layers.setActive('x'))).toBe('not-found');
    expect(layers.setActive('c')).toBe(false);
    expect(layers.getActive()?.id).toBe('a');
  });
});
