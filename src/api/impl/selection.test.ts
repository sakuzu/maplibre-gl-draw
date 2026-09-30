// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for draw.selection and draw.vertexSelection
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { MemoryStore } from '../../store/memory.js';
import { createResourceDeps } from '../../test-utils.js';
import { DrawError } from '../errors.js';
import type { SelectionResource, VertexSelectionResource } from '../selection.js';
import { createFeatures } from './features.js';
import { createGroups } from './groups.js';
import { createSelection, createVertexSelection } from './selection.js';

let store: MemoryStore;
let selection: SelectionResource;
let vertices: VertexSelectionResource;

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

beforeEach(() => {
  store = new MemoryStore();
  layer('l1');
  layer('l2');
  const deps = createResourceDeps(store);
  const features = createFeatures(deps);
  const groups = createGroups(deps);
  features.createMany([
    { id: 'a', type: 'Point', geometry: { type: 'Point', coordinates: [0, 0] } },
    { id: 'b', type: 'Point', geometry: { type: 'Point', coordinates: [1, 1] } },
    {
      id: 'line',
      type: 'LineString',
      geometry: {
        type: 'LineString',
        coordinates: [
          [0, 0],
          [1, 0],
          [2, 0],
        ],
      },
    },
    {
      id: 'hidden',
      type: 'Point',
      geometry: { type: 'Point', coordinates: [0, 0] },
      visible: false,
    },
  ]);
  groups.create({ id: 'g', featureIds: ['b'] });
  selection = createSelection(deps, { features, groups });
  vertices = createVertexSelection(deps);
});

describe('draw.selection', () => {
  it('sets, adds, removes and clears', () => {
    expect(selection.set('feature', ['a'])).toBe(true);
    expect(selection.get()).toEqual({ type: 'feature', ids: ['a'] });
    expect(selection.add(['line', 'a'])).toBe(true);
    expect(selection.get().ids).toEqual(['a', 'line']);
    expect(selection.add(['a'])).toBe(false);
    expect(selection.remove(['a', 'x'])).toBe(true);
    expect(selection.remove(['a'])).toBe(false);
    expect(selection.get().ids).toEqual(['line']);
    selection.clear();
    expect(selection.get()).toEqual({ type: null, ids: [] });
  });

  it('takes the type of the first ID when adding to nothing', () => {
    expect(selection.add(['g'])).toBe(true);
    expect(selection.get()).toEqual({ type: 'group', ids: ['g'] });
  });

  it('throws not-found for an ID of another type and invalid-input for a wrong type', () => {
    expect(codeOf(() => selection.set('feature', ['g']))).toBe('not-found');
    expect(codeOf(() => selection.set('thing' as never, ['a']))).toBe('invalid-input');
    selection.set('feature', ['a']);
    expect(codeOf(() => selection.add(['l1']))).toBe('not-found');
    expect(selection.get().ids).toEqual(['a']);
  });

  it('returns false when nothing given can be selected, and changes nothing', () => {
    selection.set('feature', ['a']);
    expect(selection.set('feature', ['hidden'])).toBe(false);
    expect(selection.get().ids).toEqual(['a']);
  });

  it('lists the selected features, and the features of a selected group or layer', () => {
    selection.set('group', ['g']);
    expect(selection.features().map((f) => f.id)).toEqual(['b']);
    selection.set('layer', ['l1']);
    expect(selection.features().map((f) => f.id)).toEqual(['a', 'b', 'line', 'hidden']);
    selection.set('feature', ['line']);
    expect(selection.features().map((f) => f.id)).toEqual(['line']);
  });

  it('deletes what is selected, and refuses read-only, the interaction lock and nothing', () => {
    expect(selection.delete()).toBe(false);
    selection.set('feature', ['a']);
    store.setInteractionLock(true);
    expect(selection.delete()).toBe(false);
    store.setInteractionLock(false);
    store.setReadOnly(true);
    expect(selection.delete()).toBe(false);
    store.setReadOnly(false);
    expect(selection.delete()).toBe(true);
    expect(store.getFeature('a')).toBeUndefined();
  });

  it('groups the selected features and ungroups the selected groups', () => {
    selection.set('feature', ['a', 'line']);
    const group = selection.group();
    expect(group?.featureIds).toEqual(['a', 'line']);
    selection.set('group', [group?.id ?? '']);
    expect(selection.ungroup()).toBe(true);
    expect(store.getGroup(group?.id ?? '')).toBeUndefined();
    selection.set('feature', ['a']);
    expect(selection.ungroup()).toBe(false);
    store.setReadOnly(true);
    selection.set('feature', ['a', 'line']);
    expect(selection.group()).toBeNull();
  });

  it('moves the selected features or groups', () => {
    selection.set('feature', ['a']);
    expect(selection.move({ layerId: 'l2' })).toBe(true);
    expect(store.getFeature('a')?.layerId).toBe('l2');
    selection.set('group', ['g']);
    expect(selection.move({ layerId: 'l2', index: 0 })).toBe(true);
    expect(store.getLayer('l2')?.items).toEqual(['g', 'a']);
    expect(codeOf(() => selection.move({ layerId: 'x' }))).toBe('not-found');
    selection.clear();
    expect(selection.move({ layerId: 'l1' })).toBe(false);
  });
});

describe('draw.vertexSelection', () => {
  it('sets, reads and clears the selected vertices', () => {
    expect(vertices.get()).toBeNull();
    expect(vertices.set('line', [{ ring: 0, index: 2 }])).toBe(true);
    expect(vertices.get()).toEqual({ featureId: 'line', vertices: [{ ring: 0, index: 2 }] });
    vertices.clear();
    expect(vertices.get()).toBeNull();
  });

  it('throws not-found for a missing feature or vertex, and invalid-input for a wrong vertex', () => {
    expect(codeOf(() => vertices.set('x', [{ ring: 0, index: 0 }]))).toBe('not-found');
    expect(codeOf(() => vertices.set('line', [{ ring: 0, index: 3 }]))).toBe('not-found');
    expect(codeOf(() => vertices.set('a', [{ ring: 0, index: 0 }]))).toBe('not-found');
    expect(codeOf(() => vertices.set('line', [{ ring: -1, index: 0 }]))).toBe('invalid-input');
    expect(vertices.get()).toBeNull();
  });

  it('refuses the vertices of a locked feature', () => {
    store.updateFeature('line', { locked: true });
    expect(vertices.set('line', [{ ring: 0, index: 0 }])).toBe(false);
  });

  it('deletes the selected vertices, and refuses read-only and nothing selected', () => {
    expect(vertices.delete()).toBe(false);
    vertices.set('line', [{ ring: 0, index: 1 }]);
    store.setReadOnly(true);
    expect(vertices.delete()).toBe(false);
    store.setReadOnly(false);
    expect(vertices.delete()).toBe(true);
    expect(store.getFeature('line')?.geometry).toEqual({
      type: 'LineString',
      coordinates: [
        [0, 0],
        [2, 0],
      ],
    });
    expect(vertices.get()).toBeNull();
  });
});
