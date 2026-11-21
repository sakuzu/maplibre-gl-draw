// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The selection as a set of IDs read without an array of them: the features of layers selected
 * with `{ layerIds }`, the limit of `selection.features`, the sets of `selection.changed`, the
 * box selection and the hook that narrows it, and the sets handed out, which stay as they were
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createParityMap, type ParityMap } from '../../test-utils.js';
import { createDraw, type Draw } from '../draw.js';
import { DrawError } from '../errors.js';
import type { DrawEvents } from '../events.js';
import { createIdSet, type IdSet } from '../model.js';

const draws: Draw[] = [];

afterEach(() => {
  for (const draw of draws.splice(0)) draw.destroy();
});

/** An instance over a map that takes the input of a real map, with IDs of its own */
function instance(): { draw: Draw; map: ParityMap } {
  const map = createParityMap();
  let n = 0;
  const draw = createDraw(map.map, { generateId: () => `id${++n}` });
  draws.push(draw);
  return { draw, map };
}

/** Points at x = 0, 0.1, 0.2… of the layer given (the active one when left out) */
function points(draw: Draw, prefix: string, count: number, layerId?: string): string[] {
  const made = draw.features.createMany(
    Array.from({ length: count }, (_, i) => ({
      id: `${prefix}${i}`,
      type: 'Point' as const,
      geometry: { type: 'Point' as const, coordinates: [i * 0.1, 0] },
      ...(layerId !== undefined && { layerId }),
    })),
  );
  return (made ?? []).map((feature) => feature.id);
}

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    if (error instanceof DrawError) return error.code;
    throw error;
  }
  return undefined;
}

describe('selection.set with { layerIds }', () => {
  it('selects the features of several layers, those of their groups included', () => {
    const { draw } = instance();
    const first = draw.layers.getActive()?.id as string;
    const second = draw.layers.create({ name: 'second' })?.id as string;
    const a = points(draw, 'a', 3, first);
    const b = points(draw, 'b', 2, second);
    draw.groups.create({ featureIds: [a[1], a[2]] });
    expect(draw.selection.set('feature', { layerIds: [first, second] })).toBe(true);
    const { type, ids } = draw.selection.get();
    expect(type).toBe('feature');
    expect(ids.count()).toBe(5);
    for (const id of [...a, ...b]) expect(ids.has(id)).toBe(true);
    expect(ids.has('nothing')).toBe(false);
    expect([...ids.iterate()].sort()).toEqual([...a, ...b].sort());
    expect(ids.toArray().sort()).toEqual([...a, ...b].sort());
  });

  it('reads the IDs in the order of the layers given, each layer in its order', () => {
    const { draw } = instance();
    const first = draw.layers.getActive()?.id as string;
    const second = draw.layers.create({ name: 'second' })?.id as string;
    const a = points(draw, 'a', 2, first);
    const b = points(draw, 'b', 2, second);
    draw.selection.set('feature', { layerIds: [second, first] });
    expect(draw.selection.get().ids.toArray()).toEqual([...b, ...a]);
  });

  it('counts and answers without an array of the IDs, and gives an array of 10,000 at most', () => {
    const { draw } = instance();
    const layerId = draw.layers.getActive()?.id as string;
    points(draw, 'p', 10_001, layerId);
    draw.selection.set('feature', { layerIds: [layerId] });
    const { ids } = draw.selection.get();
    expect(ids.count()).toBe(10_001);
    expect(ids.has('p10000')).toBe(true);
    let read = 0;
    for (const _ of ids.iterate()) read += 1;
    expect(read).toBe(10_001);
    expect(codeOf(() => ids.toArray())).toBe('tooManyItems');
  });

  it('is for features only: another type is invalidInput, and a layer that is not is notFound', () => {
    const { draw } = instance();
    const layerId = draw.layers.getActive()?.id as string;
    points(draw, 'p', 2, layerId);
    expect(codeOf(() => draw.selection.set('layer', { layerIds: [layerId] }))).toBe('invalidInput');
    expect(codeOf(() => draw.selection.set('group', { layerIds: [layerId] }))).toBe('invalidInput');
    expect(codeOf(() => draw.selection.set('feature', { layerIds: ['nothing'] }))).toBe('notFound');
    expect(draw.selection.get().type).toBeNull();
  });

  it('leaves out what is not shown: a feature hidden, one of a group hidden, one this client hides', () => {
    const { draw } = instance();
    const layerId = draw.layers.getActive()?.id as string;
    const [shown, hidden, inGroup, here] = points(draw, 'p', 4, layerId);
    draw.features.update(hidden, { visible: false });
    const group = draw.groups.create({ featureIds: [inGroup] });
    if (group) draw.groups.update(group.id, { visible: false });
    draw.hidden.add(here);
    draw.selection.set('feature', { layerIds: [layerId] });
    expect(draw.selection.get().ids.toArray()).toEqual([shown]);
  });

  it('returns false when none of the features is shown, and leaves out a hidden layer', () => {
    const { draw } = instance();
    const layerId = draw.layers.getActive()?.id as string;
    const [only] = points(draw, 'p', 1, layerId);
    draw.features.update(only, { visible: false });
    expect(draw.selection.set('feature', { layerIds: [layerId] })).toBe(false);
    expect(draw.selection.get().type).toBeNull();
    draw.features.update(only, { visible: true });
    draw.layers.update(layerId, { visible: false });
    expect(draw.selection.set('feature', { layerIds: [layerId] })).toBe(false);
  });
});

describe('selection.features', () => {
  it('throws tooManyItems for more than 10,000 features, and never cuts the list short', () => {
    const { draw } = instance();
    const layerId = draw.layers.getActive()?.id as string;
    points(draw, 'p', 10_001, layerId);
    draw.selection.set('feature', { layerIds: [layerId] });
    expect(codeOf(() => draw.selection.features())).toBe('tooManyItems');
    // The same for the layer selected as a layer
    draw.selection.set('layer', [layerId]);
    expect(codeOf(() => draw.selection.features())).toBe('tooManyItems');
    // 10,000 are listed
    draw.features.delete('p0');
    draw.selection.set('feature', { layerIds: [layerId] });
    expect(draw.selection.features()).toHaveLength(10_000);
  });
});

describe('selection.changed', () => {
  it('carries the selection and the one before it as sets of IDs', () => {
    const { draw } = instance();
    const layerId = draw.layers.getActive()?.id as string;
    const [a, b] = points(draw, 'p', 2, layerId);
    const told: DrawEvents['selection.changed'][] = [];
    draw.on('selection.changed', (payload) => told.push(payload));
    draw.selection.set('feature', [a]);
    draw.selection.set('feature', { layerIds: [layerId] });
    expect(told).toHaveLength(2);
    const isSet = (ids: IdSet) =>
      ['count', 'has', 'iterate', 'toArray'].every(
        (name) => typeof (ids as unknown as Record<string, unknown>)[name] === 'function',
      ) && !Array.isArray(ids);
    for (const payload of told) {
      expect(isSet(payload.selection.ids)).toBe(true);
      expect(isSet(payload.previous.ids)).toBe(true);
    }
    expect(told[1].previous.ids.toArray()).toEqual([a]);
    expect(told[1].selection.ids.toArray()).toEqual([a, b]);
  });
});

describe('the sets handed out stay as they were given', () => {
  it('do not change with a later selection, nor with features added to the layer or deleted', () => {
    const { draw } = instance();
    const layerId = draw.layers.getActive()?.id as string;
    const ids = points(draw, 'p', 5, layerId);
    draw.selection.set('feature', { layerIds: [layerId] });
    const given = draw.selection.get().ids;
    draw.selection.set('feature', [ids[0]]);
    points(draw, 'q', 3, layerId);
    expect(given.toArray()).toEqual(ids);
    // Deleted features leave the selection, and stay readable from the set given before
    draw.features.delete(ids[1]);
    draw.features.delete(ids[2]);
    // Rows made after the deletion may take the references of the rows deleted
    points(draw, 'r', 20, layerId);
    expect(given.count()).toBe(5);
    expect(given.toArray()).toEqual(ids);
    expect(given.has(ids[1])).toBe(true);
    expect(given.has('r0')).toBe(false);
  });

  it('keeps the selection the same set while it does not change', () => {
    const { draw } = instance();
    const layerId = draw.layers.getActive()?.id as string;
    points(draw, 'p', 3, layerId);
    draw.selection.set('feature', { layerIds: [layerId] });
    const before = draw.selection.get().ids;
    draw.layers.update(layerId, { name: 'renamed' });
    expect(draw.selection.get().ids).toBe(before);
  });

  it('take the selection away from a layer hidden, but not from one renamed', () => {
    const { draw } = instance();
    const layerId = draw.layers.getActive()?.id as string;
    points(draw, 'p', 3, layerId);
    draw.selection.set('feature', { layerIds: [layerId] });
    draw.layers.update(layerId, { name: 'renamed' });
    expect(draw.selection.get().ids.count()).toBe(3);
    draw.layers.update(layerId, { visible: false });
    expect(draw.selection.get().type).toBeNull();
    expect(draw.selection.get().ids.count()).toBe(0);
  });
});

describe('selection.set and add with a set', () => {
  it('take an IdSet as they take an array', () => {
    const { draw } = instance();
    const layerId = draw.layers.getActive()?.id as string;
    const [a, b, c] = points(draw, 'p', 3, layerId);
    expect(draw.selection.set('feature', createIdSet([b, a]))).toBe(true);
    expect(draw.selection.get().ids.toArray()).toEqual([b, a]);
    expect(draw.selection.add(createIdSet([c, a]))).toBe(true);
    expect(draw.selection.get().ids.toArray()).toEqual([b, a, c]);
    expect(draw.selection.remove(createIdSet([a]))).toBe(true);
    expect(draw.selection.get().ids.toArray()).toEqual([b, c]);
  });
});

describe('the hook that narrows a selection', () => {
  it('takes the candidates of a box as a set, and what it returns is selected', () => {
    const { draw, map } = instance();
    const layerId = draw.layers.getActive()?.id as string;
    const ids = points(draw, 'p', 4, layerId);
    const filterSelection = vi.fn((candidates: IdSet) =>
      createIdSet([...candidates.iterate()].filter((id) => id !== ids[1])),
    );
    draw.extensions.plugins.add({ name: 'narrow', onAdd() {}, interaction: { filterSelection } });
    map.drag([-0.05, -0.05], [0.35, 0.05], { modifiers: { shift: true } });
    const candidates = filterSelection.mock.lastCall?.[0] as IdSet;
    expect(typeof candidates.iterate).toBe('function');
    expect(candidates.toArray()).toEqual(ids);
    expect(draw.selection.get().ids.toArray()).toEqual([ids[0], ids[2], ids[3]]);
  });

  it('is not called by selection.set', () => {
    const { draw } = instance();
    const layerId = draw.layers.getActive()?.id as string;
    const ids = points(draw, 'p', 2, layerId);
    const filterSelection = vi.fn((_candidates: IdSet) => createIdSet([]));
    draw.extensions.plugins.add({ name: 'narrow', onAdd() {}, interaction: { filterSelection } });
    draw.selection.set('feature', ids);
    draw.selection.set('feature', { layerIds: [layerId] });
    expect(filterSelection).not.toHaveBeenCalled();
    expect(draw.selection.get().ids.toArray()).toEqual(ids);
  });
});

describe('the box selection', () => {
  it('leaves out what is locked and what is hidden', () => {
    const { draw, map } = instance();
    const layerId = draw.layers.getActive()?.id as string;
    const [kept, locked, hidden, here] = points(draw, 'p', 4, layerId);
    draw.features.update(locked, { locked: true });
    draw.features.update(hidden, { visible: false });
    draw.hidden.add(here);
    map.drag([-0.05, -0.05], [0.35, 0.05], { modifiers: { shift: true } });
    expect(draw.selection.get().ids.toArray()).toEqual([kept]);
  });

  it('tests a feature on the edge of the box as before: a line that only enters it is taken', () => {
    const { draw, map } = instance();
    draw.features.create({
      id: 'through',
      type: 'LineString',
      geometry: {
        type: 'LineString',
        coordinates: [
          [-1, 0],
          [1, 0],
        ],
      },
    });
    draw.features.create({
      id: 'beside',
      type: 'LineString',
      geometry: {
        type: 'LineString',
        coordinates: [
          [-1, 0.5],
          [-0.5, 1],
        ],
      },
    });
    map.drag([-0.2, -0.2], [0.2, 0.2], { modifiers: { shift: true } });
    expect(draw.selection.get().ids.toArray()).toEqual(['through']);
  });

  it('calls the box test of a type of an extension for a feature wholly inside the box', () => {
    const { draw, map } = instance();
    const boxSelect = vi.fn(() => false);
    draw.extensions.featureTypes.add({
      type: 'pin',
      geometry: 'Point',
      renderer: { onAdd: vi.fn(), draw: vi.fn(), onRemove: vi.fn() },
      boxSelect,
    });
    draw.features.create({
      id: 'pin',
      type: 'pin',
      geometry: { type: 'Point', coordinates: [0, 0] },
    });
    draw.features.create({
      id: 'pt',
      type: 'Point',
      geometry: { type: 'Point', coordinates: [0.1, 0] },
    });
    map.drag([-0.2, -0.2], [0.2, 0.2], { modifiers: { shift: true } });
    expect(boxSelect).toHaveBeenCalled();
    expect(draw.selection.get().ids.toArray()).toEqual(['pt']);
  });
});
