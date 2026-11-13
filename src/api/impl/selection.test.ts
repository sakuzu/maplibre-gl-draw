// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for draw.selection and draw.vertexSelection
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ObjectGroup, ObjectLayer } from '../../shared/types/model.js';
import { MemoryStore } from '../../store/memory.js';
import { createResourceDeps } from '../../test-utils.js';
import { DrawError } from '../errors.js';
import type { VertexSelectionResource } from '../selection.js';
import { createEventHub } from './events.js';
import { createFeatures } from './features.js';
import { createGroups } from './groups.js';
import { createSelection, createVertexSelection } from './selection.js';
import type { SelectionWrites as SelectionResource } from './selection-resource.js';

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
  groups.create({ id: 'g', members: ['b'] });
  selection = createSelection(deps, { features, groups }, createEventHub());
  vertices = createVertexSelection(deps, createEventHub());
});

describe('draw.selection', () => {
  it('sets, adds, removes and clears', () => {
    expect(selection.set('feature', ['a'])).toBe(true);
    expect(selection.value).toMatchObject({ type: 'feature', ids: ['a'] });
    expect(selection.add(['line', 'a'])).toBe(true);
    expect(selection.value.ids).toEqual(['a', 'line']);
    expect(selection.add(['a'])).toBe(false);
    expect(selection.remove(['a', 'x'])).toBe(true);
    expect(selection.remove(['a'])).toBe(false);
    expect(selection.value.ids).toEqual(['line']);
    selection.clear();
    expect(selection.value).toMatchObject({ count: 0, ids: [] });
  });

  it('takes the type of the first ID when adding to nothing', () => {
    expect(selection.add(['g'])).toBe(true);
    expect(selection.value).toMatchObject({ type: 'group', ids: ['g'] });
  });

  it('throws notFound for an ID of another type and invalidInput for a wrong type', () => {
    expect(codeOf(() => selection.set('feature', ['g']))).toBe('notFound');
    expect(codeOf(() => selection.set('thing' as never, ['a']))).toBe('invalidInput');
    selection.set('feature', ['a']);
    expect(codeOf(() => selection.add(['l1']))).toBe('notFound');
    expect(selection.value.ids).toEqual(['a']);
  });

  it('returns false when nothing given can be selected, and changes nothing', () => {
    selection.set('feature', ['a']);
    expect(selection.set('feature', ['hidden'])).toBe(false);
    expect(selection.value.ids).toEqual(['a']);
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
    expect((group as ObjectGroup | undefined)?.featureIds).toEqual(['a', 'line']);
    selection.set('group', [group?.id ?? '']);
    expect(selection.ungroup()).toBe(true);
    expect(store.getGroup(group?.id ?? '')).toBeUndefined();
    selection.set('feature', ['a']);
    expect(selection.ungroup()).toBe(false);
    store.setReadOnly(true);
    selection.set('feature', ['a', 'line']);
    expect(selection.group()).toBeNull();
  });

  it('reads the layers and the extent of the features of a Store of objects once asked for', () => {
    selection.set('feature', ['a', 'line']);
    selection.move({ layerId: 'l2' });
    selection.set('feature', ['a', 'b', 'line']);
    // A change of the selection, as each frame of a box makes, reads no feature
    const read = vi.spyOn(store, 'getFeature');
    store.setSelection('feature', ['a', 'b']);
    const value = selection.value;
    expect(value).toMatchObject({ type: 'feature', count: 2, ids: ['a', 'b'] });
    expect(read).not.toHaveBeenCalled();
    expect(value.bbox).toEqual([0, 0, 1, 1]);
    expect(value.layerIds).toEqual(['l2', 'l1']);
    expect(read).toHaveBeenCalledTimes(2);
    // Read once for the value
    expect(value.bbox).toEqual([0, 0, 1, 1]);
    expect(read).toHaveBeenCalledTimes(2);
    selection.set('group', ['g']);
    expect(selection.value).toMatchObject({ type: 'group', count: 1, layerIds: ['l1'] });
    expect(selection.value.bbox).toEqual([1, 1, 1, 1]);
  });

  it('gives the same value until the selection or the document changes, kept as it was given', () => {
    const told: Array<{ bbox: unknown; layerIds: readonly string[] }> = [];
    selection.set('feature', ['a', 'b']);
    const value = selection.value;
    expect(selection.value).toBe(value);
    store.subscribe((change) => {
      if (change.selection?.previousValue) told.push(change.selection.previousValue);
    });
    // Moved: the value given keeps the features as they were, the next one reads them now
    store.updateFeature('b', { geometry: { type: 'Point', coordinates: [5, 5] } });
    expect(value.bbox).toEqual([0, 0, 1, 1]);
    const moved = selection.value;
    expect(moved).not.toBe(value);
    expect(moved.bbox).toEqual([0, 0, 5, 5]);
    expect(selection.value).toBe(moved);
    // Deleted with nothing read: the selection before it is told as it was
    store.setSelection('feature', ['a', 'line']);
    told.length = 0;
    store.transact(() => {
      store.deleteFeature('a');
      store.deleteFeature('line');
    });
    expect(told).toHaveLength(1);
    expect(told[0]?.bbox).toEqual([0, 0, 2, 0]);
    expect(told[0]?.layerIds).toEqual(['l1']);
    expect(value.bbox).toEqual([0, 0, 1, 1]);
    // Written twice, and another feature written, before it is read: as it was given
    store.setSelection('feature', ['b']);
    const given = selection.value;
    store.updateFeature('b', { geometry: { type: 'Point', coordinates: [6, 6] } });
    store.updateFeature('hidden', { properties: { n: 1 } });
    store.updateFeature('b', { geometry: { type: 'Point', coordinates: [7, 7] } });
    expect(given.bbox).toEqual([5, 5, 5, 5]);
    expect(selection.value.bbox).toEqual([7, 7, 7, 7]);
  });

  it('refuses a target another instance gave', () => {
    selection.set('feature', ['a']);
    const target = selection.target;
    const other = new MemoryStore();
    const deps = createResourceDeps(other);
    const otherSelection = createSelection(
      deps,
      { features: createFeatures(deps), groups: createGroups(deps) },
      createEventHub(),
    );
    expect(codeOf(() => otherSelection.set(target))).toBe('invalidInput');
    expect(selection.set(target)).toBe(true);
  });

  it('names a group with the number of the features in it now', () => {
    selection.set('group', ['g']);
    const target = selection.target;
    expect(target.count).toBe(1);
    expect(selection.target).toBe(target);
    store.updateFeature('a', { groupId: 'g' });
    expect(selection.value.count).toBe(2);
    expect(selection.target).not.toBe(target);
    expect(selection.target.count).toBe(2);
  });

  it('moves the selected features or groups', () => {
    selection.set('feature', ['a']);
    expect(selection.move({ layerId: 'l2' })).toBe(true);
    expect(store.getFeature('a')?.layerId).toBe('l2');
    selection.set('group', ['g']);
    expect(selection.move({ layerId: 'l2', index: 0 })).toBe(true);
    expect((store.getLayer('l2') as ObjectLayer | undefined)?.items).toEqual(['g', 'a']);
    expect(codeOf(() => selection.move({ layerId: 'x' }))).toBe('notFound');
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

  it('throws notFound for a missing feature or vertex, and invalidInput for a wrong vertex', () => {
    expect(codeOf(() => vertices.set('x', [{ ring: 0, index: 0 }]))).toBe('notFound');
    expect(codeOf(() => vertices.set('line', [{ ring: 0, index: 3 }]))).toBe('notFound');
    expect(codeOf(() => vertices.set('a', [{ ring: 0, index: 0 }]))).toBe('notFound');
    expect(codeOf(() => vertices.set('line', [{ ring: -1, index: 0 }]))).toBe('invalidInput');
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

describe('selection.update', () => {
  it('writes the patches of the features selected through one applyEdits of the Store', () => {
    selection.set('feature', ['a', 'line']);
    const applyEdits = vi.spyOn(store, 'applyEdits');
    const updateFeature = vi.spyOn(store, 'updateFeature');
    expect(selection.update({ style: { strokeWidth: 3 } })).toBe(true);
    expect(applyEdits.mock.calls).toEqual([
      [
        [
          { kind: 'set', featureId: 'a', patch: { style: { strokeWidth: 3 } } },
          { kind: 'set', featureId: 'line', patch: { style: { strokeWidth: 3 } } },
        ],
      ],
    ]);
    expect(updateFeature).not.toHaveBeenCalled();
    expect(store.getFeature('line')?.style.strokeWidth).toBe(3);
  });
});
