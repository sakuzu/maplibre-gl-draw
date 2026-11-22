// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `features.restore` of the features and groups moved to another layer: the place is written back
 * key by key, the layer included
 *
 * - A feature moved to another layer goes back to its layer, at its place there; one moved out of
 *   a group of another layer goes back into the group, or to the front of the layer the group was
 *   in when the group is gone
 * - A group moved to another layer goes back with its features
 * - A layer the features were in that is gone refuses the values with `notFound`, and nothing is
 *   written
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createStore } from '../../store/built-in/create-store.js';
import { createMapStub } from '../../test-utils.js';
import type { Draw } from '../draw.js';
import type { DocumentChange } from '../events.js';
import type { FeatureValues } from '../model.js';
import { createDraw } from './create-draw.js';

let draw: Draw;
let first: string;
let other: string;

beforeEach(() => {
  draw = createDraw(createMapStub().map, { store: createStore() });
  first = draw.layers.list()[0].id;
  other = draw.layers.create({ name: 'other' })?.id as string;
});

afterEach(() => {
  draw.destroy();
});

const point = (id: string, x = 0, more: Record<string, unknown> = {}) => ({
  id,
  type: 'Point' as const,
  geometry: { type: 'Point' as const, coordinates: [x, 0] },
  ...more,
});

/** The values of every change a subscriber that asks for them receives from now on */
function record(): () => FeatureValues[] {
  const changes: DocumentChange[] = [];
  draw.document.subscribe((change) => changes.push(change), { previousValues: true });
  return () => changes.flatMap((change) => (change.previousValues ? [change.previousValues] : []));
}

/** The items of a layer, from the back */
const itemsOf = (layerId: string): string[] =>
  draw.layers.listItemIds(layerId, { start: 0, end: 20 });

/** The features of a group, from the back */
const membersOf = (groupId: string): string[] =>
  draw.groups.listFeatureIds(groupId, { start: 0, end: 20 });

/** Features in the first layer, a group `g` of two among them, and one in the other layer */
function scene(): void {
  draw.features.createMany([point('a'), point('b', 1), point('c', 2), point('d', 3)]);
  draw.groups.create({ id: 'g', featureIds: ['b', 'c'] });
  draw.features.createMany([point('x', 5, { layerId: other }), point('y', 6, { layerId: other })]);
}

describe('a feature moved to another layer', () => {
  it('goes back to its layer, at its place there', async () => {
    scene();
    const order = itemsOf(first);
    const otherOrder = itemsOf(other);
    const values = record();
    draw.features.move('a', { layerId: other, index: 1 });
    expect(draw.features.get('a')?.layerId).toBe(other);
    const counts = await draw.features.restore(values());
    expect(counts?.changedCount).toBe(1);
    expect(draw.features.get('a')?.layerId).toBe(first);
    expect(itemsOf(first)).toEqual(order);
    expect(itemsOf(other)).toEqual(otherOrder);
  });

  it('goes back into the group of another layer it was moved out of, at its place there', async () => {
    scene();
    const order = itemsOf(first);
    const members = membersOf('g');
    const values = record();
    draw.features.move('b', { layerId: other });
    expect(membersOf('g')).toEqual(['c']);
    await draw.features.restore(values());
    expect(draw.features.get('b')).toEqual(
      expect.objectContaining({ layerId: first, groupId: 'g' }),
    );
    expect(membersOf('g')).toEqual(members);
    expect(itemsOf(first)).toEqual(order);
    expect(itemsOf(other)).toEqual(['x', 'y']);
  });

  it('goes back to the front of the layer its group was in, when the group is gone', async () => {
    scene();
    const values = record();
    draw.features.move('b', { layerId: other });
    // Deleted by a later change, whose values are not written back
    draw.groups.delete('g');
    expect(draw.groups.has('g')).toBe(false);
    await draw.features.restore([values()[0]]);
    expect(draw.features.get('b')?.layerId).toBe(first);
    expect(draw.features.get('b')?.groupId).toBeUndefined();
    const items = itemsOf(first);
    expect(items[items.length - 1]).toBe('b');
    expect(itemsOf(other)).toEqual(['x', 'y']);
  });

  it('goes back into a group of another layer emptied and deleted by the move', async () => {
    draw.features.createMany([point('a'), point('b', 1)]);
    draw.groups.create({ id: 'h', featureIds: ['a'] });
    const order = itemsOf(first);
    const values = record();
    draw.features.move('a', { layerId: other });
    expect(draw.groups.has('h')).toBe(false);
    await draw.features.restore(values());
    expect(draw.features.get('a')).toEqual(
      expect.objectContaining({ layerId: first, groupId: 'h' }),
    );
    expect(itemsOf(first)).toEqual(order);
    expect(itemsOf(other)).toEqual([]);
  });

  it('comes back to its layer when it was moved and then deleted', async () => {
    scene();
    const order = itemsOf(first);
    const values = record();
    draw.features.move('a', { layerId: other });
    draw.features.delete('a');
    await draw.features.restore(values());
    expect(draw.features.get('a')?.layerId).toBe(first);
    expect(itemsOf(first)).toEqual(order);
    expect(itemsOf(other)).toEqual(['x', 'y']);
  });

  it('refuses with notFound when its layer is gone, and writes nothing', async () => {
    scene();
    const values = record();
    draw.features.move('a', { layerId: other });
    const otherOrder = itemsOf(other);
    // The first layer is deleted with what is left in it
    await draw.layers.delete(first);
    expect(draw.layers.get(first)).toBeUndefined();
    const moveValues = values()[0];
    await expect(draw.features.restore([moveValues])).rejects.toMatchObject({ code: 'notFound' });
    expect(draw.features.get('a')?.layerId).toBe(other);
    expect(itemsOf(other)).toEqual(otherOrder);
  });

  it('refuses with notFound when the layer of its group is gone, and writes nothing', async () => {
    scene();
    const values = record();
    draw.features.move('b', { layerId: other });
    const otherOrder = itemsOf(other);
    await draw.layers.delete(first);
    await expect(draw.features.restore([values()[0]])).rejects.toMatchObject({
      code: 'notFound',
    });
    expect(draw.features.get('b')?.layerId).toBe(other);
    expect(itemsOf(other)).toEqual(otherOrder);
  });
});

describe('a group moved to another layer', () => {
  it('goes back to its layer with its features, at its place there', async () => {
    scene();
    const order = itemsOf(first);
    const members = membersOf('g');
    const values = record();
    draw.groups.move('g', { layerId: other });
    expect(draw.features.get('b')?.layerId).toBe(other);
    await draw.features.restore(values());
    expect(draw.groups.get('g')?.layerId).toBe(first);
    expect(draw.features.get('b')?.layerId).toBe(first);
    expect(draw.features.get('c')?.layerId).toBe(first);
    expect(membersOf('g')).toEqual(members);
    expect(itemsOf(first)).toEqual(order);
    expect(itemsOf(other)).toEqual(['x', 'y']);
  });

  it('goes back with its features when a feature was moved out of it to the layer since', async () => {
    scene();
    const order = itemsOf(first);
    const members = membersOf('g');
    const values = record();
    draw.groups.move('g', { layerId: other });
    draw.features.move('c', { groupId: null });
    await draw.features.restore(values());
    expect(draw.groups.get('g')?.layerId).toBe(first);
    expect(membersOf('g')).toEqual(members);
    expect(itemsOf(first)).toEqual(order);
    expect(itemsOf(other)).toEqual(['x', 'y']);
  });
});
