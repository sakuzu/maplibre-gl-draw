// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `features.restore` with `exceptProperties`: the keys of `properties` it names keep what they
 * have now on the features that are there, a feature that comes back comes back with every key,
 * their values before are used up with the rest, and the changes of the `restore` carry no value
 * before of them
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createStore } from '../../store/built-in/create-store.js';
import type { Store } from '../../store/built-in/types.js';
import { createMapStub } from '../../test-utils.js';
import type { Draw } from '../draw.js';
import type { DocumentChange } from '../events.js';
import type { FeatureValues } from '../model.js';
import { createDraw } from './create-draw.js';
import { sharedValuesOf } from './feature-values.js';

let store: Store;
let draw: Draw;

beforeEach(() => {
  store = createStore();
  draw = createDraw(createMapStub().map, { store });
});

afterEach(() => {
  draw.destroy();
});

/** The changes of a subscriber that asks for the values before, from now on */
function record() {
  const changes: DocumentChange[] = [];
  draw.document.subscribe((change) => changes.push(change), { previousValues: true });
  return {
    changes,
    /** The values of every change from now on, in the order they arrived */
    all: (): FeatureValues[] =>
      changes.flatMap((change) => (change.previousValues ? [change.previousValues] : [])),
  };
}

const point = (id: string, properties: Record<string, unknown>) => ({
  id,
  type: 'Point' as const,
  geometry: { type: 'Point' as const, coordinates: [0, 0] },
  properties,
});

const propertiesOf = (id: string): unknown => draw.features.get(id)?.properties;

describe('the keys left as they are', () => {
  it('keeps the key it names as it is now, and writes the other key back', async () => {
    draw.features.create(point('a', { name: 'one', text: 'first' }));
    const mine = record();
    draw.features.update('a', { properties: { name: 'two', text: 'second' } });
    await draw.features.restore(mine.all(), { exceptProperties: ['text'] });
    expect(propertiesOf('a')).toEqual({ name: 'one', text: 'second' });
  });

  it('keeps the value the key was given after the change', async () => {
    draw.features.create(point('a', { name: 'one', text: 'first' }));
    const mine = record();
    draw.features.update('a', { properties: { name: 'two', text: 'second' } });
    const [values] = mine.all();
    draw.features.update('a', { properties: { text: 'typed' } });
    await draw.features.restore([values], { exceptProperties: ['text'] });
    expect(propertiesOf('a')).toEqual({ name: 'one', text: 'typed' });
  });

  it('brings a deleted feature back with the key it names', async () => {
    draw.features.create(point('a', { name: 'one', text: 'first' }));
    const mine = record();
    draw.features.delete('a');
    await draw.features.restore(mine.all(), { exceptProperties: ['text'] });
    expect(propertiesOf('a')).toEqual({ name: 'one', text: 'first' });
  });

  it('writes the key to a feature that comes back, not to one there in the same change', async () => {
    draw.features.create(point('a', { text: 'a first' }));
    draw.features.create(point('b', { text: 'b first' }));
    const mine = record();
    draw.transact(() => {
      draw.features.update('a', { properties: { text: 'a second' } });
      draw.features.delete('b');
    });
    expect(mine.all()).toHaveLength(1);
    await draw.features.restore(mine.all(), { exceptProperties: ['text'] });
    expect(propertiesOf('a')).toEqual({ text: 'a second' });
    expect(propertiesOf('b')).toEqual({ text: 'b first' });
  });

  it('writes nothing for a change of that key alone, counts 0, and uses the values up', async () => {
    draw.features.create(point('a', { text: 'first' }));
    const mine = record();
    draw.features.update('a', { properties: { text: 'second' } });
    const [values] = mine.all();
    const after = record();
    const counts = await draw.features.restore([values], { exceptProperties: ['text'] });
    expect(counts).not.toBeNull();
    expect(counts?.changedCount).toBe(0);
    expect(propertiesOf('a')).toEqual({ text: 'second' });
    expect(after.changes).toEqual([]);
    await expect(
      draw.features.restore([values], { exceptProperties: ['text'] }),
    ).rejects.toMatchObject({ code: 'invalidInput' });
    await expect(draw.features.restore([values])).rejects.toMatchObject({ code: 'invalidInput' });
    expect(propertiesOf('a')).toEqual({ text: 'second' });
  });

  it('counts only the features it writes', async () => {
    draw.features.create(point('a', { text: 'a first' }));
    draw.features.create(point('b', { name: 'one' }));
    const mine = record();
    draw.features.update('a', { properties: { text: 'a second' } });
    draw.features.update('b', { properties: { name: 'two' } });
    const counts = await draw.features.restore(mine.all(), { exceptProperties: ['text'] });
    expect(counts?.changedCount).toBe(1);
    expect(propertiesOf('a')).toEqual({ text: 'a second' });
    expect(propertiesOf('b')).toEqual({ name: 'one' });
  });

  it('carries no value before of the key, so that making the change again leaves it', async () => {
    draw.features.create(point('a', { name: 'one', text: 'first' }));
    const mine = record();
    draw.features.update('a', { properties: { name: 'two', text: 'second' } });
    const [values] = mine.all();
    draw.features.update('a', { properties: { text: 'typed' } });
    await draw.features.restore([values], { exceptProperties: ['text'] });
    const back = mine.changes[mine.changes.length - 1];
    const again = back.previousValues as FeatureValues;
    const fields = [...(sharedValuesOf(again)?.byLayer.values() ?? [])].flatMap((before) => [
      ...before.fields.keys(),
    ]);
    expect(fields).toContain('properties:name');
    expect(fields).not.toContain('properties:text');
    draw.features.update('a', { properties: { text: 'typed more' } });
    await draw.features.restore([again]);
    expect(propertiesOf('a')).toEqual({ name: 'two', text: 'typed more' });
  });

  it('takes an empty array as no key named', async () => {
    draw.features.create(point('a', { name: 'one', text: 'first' }));
    const mine = record();
    draw.features.update('a', { properties: { name: 'two', text: 'second' } });
    await draw.features.restore(mine.all(), { exceptProperties: [] });
    expect(propertiesOf('a')).toEqual({ name: 'one', text: 'first' });
  });

  it('does not keep the keys with the values: they are those of one call', async () => {
    draw.features.create(point('a', { name: 'one', text: 'first' }));
    draw.features.create(point('b', { name: 'one', text: 'first' }));
    const mine = record();
    draw.features.update('a', { properties: { name: 'two', text: 'second' } });
    draw.features.update('b', { properties: { name: 'two', text: 'second' } });
    const [ofA, ofB] = mine.all();
    await draw.features.restore([ofA], { exceptProperties: ['text'] });
    await draw.features.restore([ofB]);
    expect(propertiesOf('a')).toEqual({ name: 'one', text: 'second' });
    expect(propertiesOf('b')).toEqual({ name: 'one', text: 'first' });
  });

  it('leaves the style, the geometry and the flags to the values', async () => {
    draw.features.create(point('a', { text: 'first' }));
    const mine = record();
    draw.features.update('a', {
      geometry: { type: 'Point', coordinates: [1, 1] },
      style: { pointColor: '#f00' },
      visible: false,
      properties: { text: 'second' },
    });
    await draw.features.restore(mine.all(), { exceptProperties: ['text', 'pointColor'] });
    const feature = draw.features.get('a');
    expect(feature?.geometry).toEqual({ type: 'Point', coordinates: [0, 0] });
    expect(feature?.style.pointColor).toBeUndefined();
    expect(feature?.visible).toBe(true);
    expect(feature?.properties).toEqual({ text: 'second' });
  });
});

describe('the keys of the wrong shape', () => {
  it('rejects keys that are not an array, or not strings, and writes nothing', async () => {
    draw.features.create(point('a', { name: 'one' }));
    const mine = record();
    draw.features.update('a', { properties: { name: 'two' } });
    const values = mine.all();
    for (const exceptProperties of ['name', { name: true }, ['name', 1], [null], null]) {
      await expect(
        draw.features.restore(values, { exceptProperties } as never),
      ).rejects.toMatchObject({ code: 'invalidInput' });
    }
    expect(propertiesOf('a')).toEqual({ name: 'two' });
    // Nothing was used: the values still write back
    await draw.features.restore(values);
    expect(propertiesOf('a')).toEqual({ name: 'one' });
  });
});
