// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Where the operations that make, take apart and replace groups and features put what they
 * write: the order of the items of a layer and of the features of a group after them, read with
 * the reads by position of the public API alone
 *
 * Each scene starts from a layer whose items are named from the back, and reads the layer and
 * its groups again once the operation is done.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { createStore } from '../../store/built-in/create-store.js';
import { createMapStub } from '../../test-utils.js';
import type { Draw } from '../draw.js';
import type { DrawDocument } from '../model.js';
import { createDrawOnEngine } from './create-draw.js';
import { createEngine } from './engine.js';

const draws: Draw[] = [];

afterEach(() => {
  for (const draw of draws.splice(0)) draw.destroy();
});

/** An instance over a Store of its own, with the layer `l` and the layer `m` */
function instance(): Draw {
  const store = createStore();
  const engine = createEngine(createMapStub().map, { store }, { deferDefaultMode: true });
  const draw = createDrawOnEngine(engine, { store });
  engine.enterDefaultMode();
  draws.push(draw);
  draw.layers.create({ id: 'l', name: 'L' });
  draw.layers.create({ id: 'm', name: 'M' });
  return draw;
}

/** A square area at a position, the size of one degree */
function square(x: number, y = 0) {
  return {
    type: 'Polygon' as const,
    geometry: {
      type: 'Polygon' as const,
      coordinates: [
        [
          [x, y],
          [x + 1, y],
          [x + 1, y + 1],
          [x, y + 1],
          [x, y],
        ],
      ],
    },
  };
}

/** Creates areas in a layer, one after another (the last is the frontmost) */
function areas(draw: Draw, ids: readonly string[], layerId = 'l'): void {
  ids.forEach((id, i) => {
    draw.features.create({ ...square(i * 0.5), id, layerId });
  });
}

/** The items of a layer, from the back, with the features of each group after it in brackets */
function itemsOf(draw: Draw, layerId = 'l'): string[] {
  const ids = draw.layers.listItemIds(layerId, { start: 0, end: draw.layers.countItems(layerId) });
  return ids.map((id) => (draw.groups.has(id) ? `${id}[${membersOf(draw, id).join(',')}]` : id));
}

/** The features of a group, from the back */
function membersOf(draw: Draw, groupId: string): string[] {
  return draw.groups.listFeatureIds(groupId, { start: 0, end: draw.groups.countFeatures(groupId) });
}

/** The layer `l` holding x, the group g of a, b and c, and y */
function withGroup(): Draw {
  const draw = instance();
  areas(draw, ['x', 'a', 'b', 'c', 'y']);
  draw.groups.create({ id: 'g', featureIds: ['a', 'b', 'c'] });
  expect(itemsOf(draw)).toEqual(['x', 'g[a,b,c]', 'y']);
  return draw;
}

describe('features taken out of their group at once', () => {
  it('the two at the back of the three', () => {
    const draw = withGroup();
    draw.selection.set('feature', ['a', 'b']);
    expect(draw.selection.ungroup()).toBe(true);
    expect(itemsOf(draw)).toEqual(['x', 'g[c]', 'a', 'b', 'y']);
  });

  it('the two at the front of the three', () => {
    const draw = withGroup();
    draw.selection.set('feature', ['b', 'c']);
    expect(draw.selection.ungroup()).toBe(true);
    expect(itemsOf(draw)).toEqual(['x', 'g[a]', 'b', 'c', 'y']);
  });

  it('the three: the group goes, and they stand where it was', () => {
    const draw = withGroup();
    draw.selection.set('feature', ['a', 'b', 'c']);
    expect(draw.selection.ungroup()).toBe(true);
    expect(itemsOf(draw)).toEqual(['x', 'a', 'b', 'c', 'y']);
    expect(draw.groups.has('g')).toBe(false);
  });

  it('the two at the back, selected from the front', () => {
    const draw = withGroup();
    draw.selection.set('feature', ['b', 'a']);
    expect(draw.selection.ungroup()).toBe(true);
    expect(itemsOf(draw)).toEqual(['x', 'g[c]', 'a', 'b', 'y']);
  });
});

describe('features taken out of a group of four at once keep the order they stood in it', () => {
  /** The layer `l` holding x, the group g of a, b, c and d, and y */
  function withFour(): Draw {
    const draw = instance();
    areas(draw, ['x', 'a', 'b', 'c', 'd', 'y']);
    draw.groups.create({ id: 'g', featureIds: ['a', 'b', 'c', 'd'] });
    expect(itemsOf(draw)).toEqual(['x', 'g[a,b,c,d]', 'y']);
    return draw;
  }

  it('three of them, just in front of the group', () => {
    const draw = withFour();
    draw.selection.set('feature', ['a', 'b', 'd']);
    expect(draw.selection.ungroup()).toBe(true);
    expect(itemsOf(draw)).toEqual(['x', 'g[c]', 'a', 'b', 'd', 'y']);
  });

  it('three of them selected in another order, in their stacking order', () => {
    const draw = withFour();
    draw.selection.set('feature', ['d', 'a', 'c']);
    expect(draw.selection.ungroup()).toBe(true);
    expect(itemsOf(draw)).toEqual(['x', 'g[b]', 'a', 'c', 'd', 'y']);
  });

  it('all of them: the group goes, and they stand where it was', () => {
    const draw = withFour();
    draw.selection.set('feature', ['c', 'a', 'd', 'b']);
    expect(draw.selection.ungroup()).toBe(true);
    expect(itemsOf(draw)).toEqual(['x', 'a', 'b', 'c', 'd', 'y']);
    expect(draw.groups.has('g')).toBe(false);
  });
});

describe('a group dissolved (selection.ungroup of a group)', () => {
  it('puts its features in its place, in their order', () => {
    const draw = withGroup();
    draw.selection.set('group', ['g']);
    expect(draw.selection.ungroup()).toBe(true);
    expect(itemsOf(draw)).toEqual(['x', 'a', 'b', 'c', 'y']);
    expect(draw.groups.has('g')).toBe(false);
  });
});

describe('a group made of the selection (selection.group)', () => {
  it('of three features apart: in the place of the frontmost, in stacking order', () => {
    const draw = instance();
    areas(draw, ['a', 'b', 'c', 'd', 'e', 'f']);
    draw.selection.set('feature', ['b', 'd', 'e']);
    const group = draw.selection.group();
    expect(group).not.toBeNull();
    const id = group?.id as string;
    expect(draw.layers.listItemIds('l', { start: 0, end: 10 })).toEqual(['a', 'c', id, 'f']);
    expect(membersOf(draw, id)).toEqual(['b', 'd', 'e']);
  });

  it('of features selected from the front: in the order selected', () => {
    const draw = instance();
    areas(draw, ['a', 'b', 'c', 'd', 'e', 'f']);
    draw.selection.set('feature', ['e', 'b', 'd']);
    const group = draw.selection.group();
    const id = group?.id as string;
    expect(draw.layers.listItemIds('l', { start: 0, end: 10 })).toEqual(['a', 'c', id, 'f']);
    expect(membersOf(draw, id)).toEqual(['e', 'b', 'd']);
  });

  it('refuses features of a group', () => {
    const draw = withGroup();
    draw.selection.set('feature', ['x', 'a']);
    expect(draw.selection.group()).toBeNull();
    expect(itemsOf(draw)).toEqual(['x', 'g[a,b,c]', 'y']);
  });
});

describe('a group made with groups.create', () => {
  it('of three features apart: in the place of the frontmost, in stacking order', () => {
    const draw = instance();
    areas(draw, ['a', 'b', 'c', 'd', 'e', 'f']);
    draw.groups.create({ id: 'h', featureIds: ['e', 'b', 'd'] });
    expect(itemsOf(draw)).toEqual(['a', 'c', 'h[b,d,e]', 'f']);
  });

  it('with a feature of another group behind the frontmost one standing in the layer', () => {
    const draw = withGroup();
    draw.groups.create({ id: 'h', featureIds: ['b', 'y'] });
    expect(itemsOf(draw)).toEqual(['x', 'g[a,c]', 'h[b,y]']);
  });

  it('with a feature of another group in front of the one standing in the layer', () => {
    const draw = withGroup();
    draw.groups.create({ id: 'h', featureIds: ['x', 'c'] });
    expect(itemsOf(draw)).toEqual(['h[x,c]', 'g[a,b]', 'y']);
  });

  it('of features all in another group: at the front of the layer', () => {
    const draw = withGroup();
    draw.groups.create({ id: 'h', featureIds: ['c', 'a'] });
    expect(itemsOf(draw)).toEqual(['x', 'g[b]', 'y', 'h[a,c]']);
  });

  it('of every feature of another group: that group goes', () => {
    const draw = withGroup();
    draw.groups.create({ id: 'h', featureIds: ['a', 'b', 'c'] });
    expect(itemsOf(draw)).toEqual(['x', 'y', 'h[a,b,c]']);
    expect(draw.groups.has('g')).toBe(false);
  });

  it('many at once, each in the place of its frontmost feature', () => {
    const draw = instance();
    areas(draw, ['a', 'b', 'c', 'd', 'e', 'f']);
    draw.groups.createMany([
      { id: 'h', featureIds: ['e', 'a'] },
      { id: 'k', featureIds: ['b', 'f'] },
    ]);
    expect(itemsOf(draw)).toEqual(['c', 'd', 'h[a,e]', 'k[b,f]']);
  });
});

describe('the result of a geometry operation', () => {
  it('of a union of features of a layer: in the place of the frontmost', () => {
    const draw = instance();
    areas(draw, ['a', 'b', 'c', 'd']);
    const result = draw.features.union(['a', 'c']);
    const id = result?.id as string;
    expect(itemsOf(draw)).toEqual(['b', id, 'd']);
  });

  it('of a union of features of a group: in the group, in the place of the frontmost', () => {
    const draw = withGroup();
    const result = draw.features.union(['a', 'b']);
    const id = result?.id as string;
    expect(itemsOf(draw)).toEqual(['x', `g[${id},c]`, 'y']);
  });

  it('of a union of a feature of a group and one of the layer, the frontmost in the group', () => {
    const draw = withGroup();
    const result = draw.features.union(['x', 'b']);
    const id = result?.id as string;
    expect(itemsOf(draw)).toEqual([`g[a,${id},c]`, 'y']);
  });

  it('of a difference in a layer: in the place of the area subtracted from', () => {
    const draw = instance();
    areas(draw, ['a', 'b', 'c', 'd']);
    const result = draw.features.difference('b', ['c']);
    const id = result?.id as string;
    expect(itemsOf(draw)).toEqual(['a', id, 'c', 'd']);
  });

  it('of a difference in a group: in the group, in the place of the area subtracted from', () => {
    const draw = withGroup();
    const result = draw.features.difference('b', ['a']);
    const id = result?.id as string;
    expect(itemsOf(draw)).toEqual(['x', `g[a,${id},c]`, 'y']);
  });
});

/** A document of the library holding the layer `l`, the groups and the features given */
function documentOf(
  draw: Draw,
  items: readonly string[],
  groups: ReadonlyArray<{ id: string; layerId?: string; featureIds: string[] }>,
  features: ReadonlyArray<{ id: string; groupId?: string }>,
): DrawDocument {
  const saved = draw.document.toJSON();
  return {
    ...saved,
    layers: [
      {
        id: 'l',
        name: 'L',
        visible: true,
        locked: false,
        opacity: 1,
        styleRule: undefined,
        metadata: undefined,
        items,
      },
    ],
    layerOrder: ['l'],
    groups: groups.map((group) => ({
      id: group.id,
      layerId: group.layerId ?? 'l',
      name: group.id,
      visible: true,
      locked: false,
      featureIds: group.featureIds,
    })),
    features: features.map(({ id, groupId }, i) => ({
      ...square(i * 0.5),
      id,
      layerId: 'l',
      groupId,
      properties: {},
      style: {},
      visible: true,
      locked: false,
    })),
  };
}

/** The items of the layers and the features of the groups of the document the instance writes */
function writtenOrders(draw: Draw) {
  const json = draw.document.toJSON();
  return {
    layers: (json.layers ?? []).map((layer) => [layer.id, [...layer.items]]),
    groups: (json.groups ?? []).map((group) => [group.id, [...group.featureIds]]),
  };
}

describe('a document of the library loaded', () => {
  it('with groups and features one after another', async () => {
    const draw = instance();
    const data = documentOf(
      draw,
      ['a', 'g', 'b', 'c', 'h', 'd'],
      [
        { id: 'g', featureIds: ['e', 'f'] },
        { id: 'h', featureIds: ['k'] },
      ],
      [
        { id: 'k', groupId: 'h' },
        { id: 'd' },
        { id: 'a' },
        { id: 'f', groupId: 'g' },
        { id: 'b' },
        { id: 'e', groupId: 'g' },
        { id: 'c' },
      ],
    );
    await draw.document.load(data);
    expect(itemsOf(draw)).toEqual(['a', 'g[e,f]', 'b', 'c', 'h[k]', 'd']);
    expect(writtenOrders(draw)).toEqual({
      layers: [
        ['default-layer', []],
        ['l', ['a', 'g', 'b', 'c', 'h', 'd']],
      ],
      groups: [
        ['g', ['e', 'f']],
        ['h', ['k']],
      ],
    });
  });

  it('with features its orders do not list: at the front, in the order of the data', async () => {
    const draw = instance();
    const data = documentOf(
      draw,
      ['a', 'g', 'b'],
      [{ id: 'g', featureIds: ['e'] }],
      [{ id: 'a' }, { id: 'e', groupId: 'g' }, { id: 'b' }, { id: 'x' }, { id: 'f', groupId: 'g' }],
    );
    await draw.document.load(data);
    expect(itemsOf(draw)).toEqual(['a', 'g[e,f]', 'b', 'x']);
    expect(writtenOrders(draw)).toEqual({
      layers: [
        ['default-layer', []],
        ['l', ['a', 'g', 'b', 'x']],
      ],
      groups: [['g', ['e', 'f']]],
    });
  });

  it('with a group the order of no layer lists: at the front', async () => {
    const draw = instance();
    const data = documentOf(
      draw,
      ['a', 'b'],
      [{ id: 'g', featureIds: ['e', 'f'] }],
      [{ id: 'a' }, { id: 'b' }, { id: 'e', groupId: 'g' }, { id: 'f', groupId: 'g' }],
    );
    await draw.document.load(data);
    expect(itemsOf(draw)).toEqual(['a', 'b', 'g[e,f]']);
    expect(writtenOrders(draw)).toEqual({
      layers: [
        ['default-layer', []],
        ['l', ['a', 'b', 'g']],
      ],
      groups: [['g', ['e', 'f']]],
    });
  });

  it('with groups and features the orders do not list: the groups, then the features, in the order of the data', async () => {
    const draw = instance();
    const data = documentOf(
      draw,
      ['a', 'b'],
      [
        { id: 'k', featureIds: ['m'] },
        { id: 'h', featureIds: ['n'] },
      ],
      [
        { id: 'z' },
        { id: 'a' },
        { id: 'n', groupId: 'h' },
        { id: 'y' },
        { id: 'm', groupId: 'k' },
        { id: 'b' },
      ],
    );
    await draw.document.load(data);
    expect(itemsOf(draw)).toEqual(['a', 'b', 'k[m]', 'h[n]', 'z', 'y']);
  });
});
