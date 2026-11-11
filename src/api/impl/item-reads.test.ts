// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `layers.listItems`, `layers.countItems` and `groups.listMembers`: the items of a layer and the
 * members of a group read by position, from the back, in the same way whether the Store holds its
 * features as objects or as rows.
 */

import { afterEach, describe, expect, it } from 'vitest';

import type { Store } from '../../store/store.js';
import { createTableStore } from '../../store/table-memory.js';
import { writesOf } from '../../test-support/writes.js';
import { createMapStub } from '../../test-utils.js';
import type { Draw } from '../draw.js';
import { createDrawOnEngine } from './create-draw.js';
import { createEngine } from './engine.js';

let draw: Draw | undefined;

afterEach(() => {
  draw?.destroy();
  draw = undefined;
});

function drawOn(store?: Store): Draw {
  const engine = createEngine(
    createMapStub().map,
    { ...(store && { store }), initDefaultLayer: false },
    { deferDefaultMode: true },
  );
  draw = createDrawOnEngine(engine, { ...(store && { store }), initDefaultLayer: false });
  engine.enterDefaultMode();
  return draw;
}

/**
 * A layer `l` of the features p0 to p5, with p2 and p3 in a group `g` (the items from the back:
 * p0, p1, g, p4, p5), and a layer `empty`
 */
function setup(kind: 'objects' | 'rows'): Draw {
  const instance = drawOn(kind === 'rows' ? createTableStore().store : undefined);
  writesOf(instance).layers.create({ id: 'l', name: 'l' });
  writesOf(instance).layers.create({ id: 'empty', name: 'empty' });
  for (let i = 0; i < 6; i++) {
    writesOf(instance).features.create({
      id: `p${i}`,
      type: 'Point',
      geometry: { type: 'Point', coordinates: [i, 0] },
      layerId: 'l',
    });
  }
  writesOf(instance).groups.create({ id: 'g', members: ['p2', 'p3'] });
  return instance;
}

describe.each(['objects', 'rows'] as const)('the items read by position, a Store of %s', (kind) => {
  it('lists the items of a layer from the back, a range of them by offset and limit', () => {
    const draw = setup(kind);
    expect(draw.layers.listItems('l')).toEqual(['p0', 'p1', 'g', 'p4', 'p5']);
    expect(draw.layers.listItems('l', { offset: 1, limit: 3 })).toEqual(['p1', 'g', 'p4']);
    expect(draw.layers.listItems('l', { offset: 3 })).toEqual(['p4', 'p5']);
    expect(draw.layers.listItems('l', { limit: 2 })).toEqual(['p0', 'p1']);
    expect(draw.layers.listItems('l', { offset: 5 })).toEqual([]);
    expect(draw.layers.listItems('l', { offset: 9, limit: 2 })).toEqual([]);
    expect(draw.layers.listItems('l', { limit: 0 })).toEqual([]);
    expect(draw.layers.listItems('empty')).toEqual([]);
  });

  it('counts the items of a layer: its features outside a group, and its groups', () => {
    const draw = setup(kind);
    expect(draw.layers.countItems('l')).toBe(5);
    expect(draw.layers.countItems('empty')).toBe(0);
    writesOf(draw).features.delete('p0');
    expect(draw.layers.countItems('l')).toBe(4);
    expect(draw.layers.listItems('l')).toEqual(['p1', 'g', 'p4', 'p5']);
  });

  it('lists the members of a group from the back, a range of them by offset and limit', () => {
    const draw = setup(kind);
    expect(draw.groups.listMembers('g')).toEqual(['p2', 'p3']);
    expect(draw.groups.listMembers('g', { offset: 1 })).toEqual(['p3']);
    expect(draw.groups.listMembers('g', { limit: 1 })).toEqual(['p2']);
    expect(draw.groups.listMembers('g', { offset: 2 })).toEqual([]);
    expect(draw.features.count({ groupId: 'g' })).toBe(2);
  });

  it('throws not-found for a layer or a group that is not there, and invalid-input for a wrong range', () => {
    const draw = setup(kind);
    expect(() => draw.layers.listItems('none')).toThrow(
      expect.objectContaining({ code: 'not-found' }),
    );
    expect(() => draw.layers.countItems('none')).toThrow(
      expect.objectContaining({ code: 'not-found' }),
    );
    expect(() => draw.groups.listMembers('none')).toThrow(
      expect.objectContaining({ code: 'not-found' }),
    );
    for (const range of [{ offset: -1 }, { offset: 1.5 }, { limit: -1 }, { limit: Number.NaN }]) {
      expect(() => draw.layers.listItems('l', range)).toThrow(
        expect.objectContaining({ code: 'invalid-input' }),
      );
      expect(() => draw.groups.listMembers('g', range)).toThrow(
        expect.objectContaining({ code: 'invalid-input' }),
      );
    }
    expect(() => draw.layers.listItems('l', { after: 'p0' } as never)).toThrow(
      expect.objectContaining({ code: 'invalid-input' }),
    );
  });
});
