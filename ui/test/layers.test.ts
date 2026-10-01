// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

import type { TreeNode } from '@sakuzu/kata/svelte';
import type { Layer } from '@sakuzu/maplibre-gl-draw';
import { describe, expect, it } from 'vitest';
import { legendBlocks, legendShape } from '../src/layers/legend.js';
import { coreIndex, planMove } from '../src/layers/move.js';
import {
  buildNodes,
  canDropInto,
  canGroup,
  DATASET_ICON,
  GROUP_ICON,
  LAYER_ICON,
  type LayerTreeNode,
  selectedIds,
  selectionOf,
} from '../src/layers/tree.js';
import { resolveMessages } from '../src/messages.js';
import { fakeDraw, feature, group, layer } from './fake-draw.js';

const en = resolveMessages('en');

/**
 * Two layers: l1 at the back holds a, the group g1 (c and d) and b, from the back; l2 in front
 * holds e and has a style rule
 */
function sample() {
  return fakeDraw({
    doc: {
      layers: [
        layer('l1', ['a', 'g1', 'b']),
        layer('l2', ['e'], {
          name: 'Places',
          styleRule: {
            kind: 'categorical',
            property: 'kind',
            map: { park: '#00aa00', shop: '#aa0000' },
            other: '#999999',
          },
        }),
      ],
      groups: [group('g1', 'l1', ['c', 'd'])],
      features: [
        feature('a', 'l1', 'Point', { style: { pointColor: '#ff0000' } }),
        feature('b', 'l1', 'LineString', {
          properties: { name: 'River' },
          style: { strokeColor: '#0000ff' },
        }),
        feature('c', 'l1', 'Polygon', { groupId: 'g1', style: { fillColor: '#00ff00' } }),
        feature('d', 'l1', 'Circle', { groupId: 'g1' }),
        feature('e', 'l2', 'Star'),
      ],
    },
  });
}

/** The IDs of the tree, as nested arrays: [id, [children]] */
function shape(nodes: readonly TreeNode[]): unknown[] {
  return nodes.map((n) => (n.children ? [n.id, shape(n.children)] : n.id));
}

describe('the nodes of the layer tree', () => {
  it('list the layers, their items and the features of the groups from the front', () => {
    const fake = sample();
    const nodes = buildNodes(fake.draw, en);
    expect(shape(nodes)).toEqual([
      ['l2', ['e']],
      ['l1', ['b', ['g1', ['d', 'c']], 'a']],
    ]);
    expect(nodes.map((n) => n.kind)).toEqual(['layer', 'layer']);
    const l1 = nodes[1].children as LayerTreeNode[];
    expect(l1.map((n) => n.kind)).toEqual(['feature', 'group', 'feature']);
    expect(nodes[1].data).toBe(fake.draw.layers.get('l1'));
  });

  it('name a feature by properties.name, or by its type', () => {
    const nodes = buildNodes(sample().draw, en);
    const names = new Map<string, string>();
    const walk = (list: readonly TreeNode[]) => {
      for (const n of list) {
        names.set(n.id, n.name);
        if (n.children) walk(n.children);
      }
    };
    walk(nodes);
    expect(Object.fromEntries(names)).toEqual({
      l2: 'Places',
      e: 'Star',
      l1: 'Layer l1',
      b: 'River',
      g1: 'Group g1',
      d: 'Circle',
      c: 'Polygon',
      a: 'Point',
    });
    expect(buildNodes(sample().draw, resolveMessages('ja'))[1].children?.[2].name).toBe('点');
  });

  it('mark a feature with the icon of its type in the color it is drawn with', () => {
    const nodes = buildNodes(sample().draw, en);
    const [b, g1, a] = nodes[1].children as LayerTreeNode[];
    const [d, c] = g1.children as LayerTreeNode[];
    expect([a.icon, a.iconColor]).toEqual(['point', '#ff0000']);
    expect([b.icon, b.iconColor]).toEqual(['polyline', '#0000ff']);
    expect([c.icon, c.iconColor]).toEqual(['polygon', '#00ff00']);
    expect(d.iconColor).toBe('#3388ff');
    expect(typeof d.icon).toBe('function');
    expect(nodes[0].icon).toBe(LAYER_ICON);
    expect(g1.icon).toBe(GROUP_ICON);
  });

  it('show the groups alone without the features', () => {
    const nodes = buildNodes(sample().draw, en, { features: false });
    expect(shape(nodes)).toEqual([
      ['l2', []],
      ['l1', ['g1']],
    ]);
  });

  it('show as hidden what the document or this client hides', () => {
    const fake = sample();
    fake.change(({ layers }) => {
      layers.set('l2', { ...(layers.get('l2') as Layer), visible: false });
    });
    fake.hide('a');
    const nodes = buildNodes(fake.draw, en);
    expect(nodes[0].visible).toBe(false);
    expect(nodes[1].visible).toBe(true);
    expect(nodes[1].children?.[2].visible).toBe(false);
  });

  it('leave out the entries of the stacking order that are neither layers nor datasets', () => {
    const fake = sample();
    const draw = { ...fake.draw, layers: { ...fake.draw.layers, getOrder: () => ['l1', 'ds'] } };
    expect(buildNodes(draw, en).map((n) => n.id)).toEqual(['l1']);
  });
});

describe('the datasets in the layer tree', () => {
  /** Two layers with a dataset between them, one in front of them all and one behind them all */
  function stacked() {
    return fakeDraw({
      doc: {
        layers: [layer('l1'), layer('l2')],
        datasets: [
          { id: 'buildings', rows: 12_345 },
          { id: 'places', order: 'above-store', rows: 7 },
          { id: 'roads', order: 'below-store', rows: 3, visible: false },
          { id: 'unplaced' },
        ],
        order: ['l1', 'buildings', 'l2'],
      },
    });
  }

  it('are rows at the root in their place in the stack, from the front', () => {
    const nodes = buildNodes(stacked().draw, en);
    expect(shape(nodes)).toEqual(['places', ['l2', []], 'buildings', ['l1', []], 'roads']);
    const [places, , buildings, , roads] = nodes;
    expect(buildings).toMatchObject({
      kind: 'dataset',
      name: 'buildings',
      icon: DATASET_ICON,
      visible: true,
      locked: false,
      count: 12_345,
    });
    expect(places.count).toBe(7);
    expect(roads.visible).toBe(false);
  });

  it('are left out with datasets: false', () => {
    const nodes = buildNodes(stacked().draw, en, { features: true, datasets: false });
    expect(nodes.map((n) => n.id)).toEqual(['l2', 'l1']);
  });

  it('move among the layers when they are placed among them, and stay otherwise', () => {
    const nodes = buildNodes(stacked().draw, en);
    const [places, l2, buildings] = nodes;
    expect(canDropInto(buildings, null)).toBe(true);
    expect(canDropInto(buildings, l2)).toBe(false);
    expect(canDropInto(places, null)).toBe(false);
    // The dataset to the front of the layers: the datasets in front of every layer are not
    // entries of the stacking order
    expect(planMove({ id: 'buildings', parentId: null, index: 0 }, nodes)).toEqual({
      kind: 'layers',
      order: ['l1', 'l2', 'buildings'],
    });
    // A layer behind the dataset
    expect(planMove({ id: 'l2', parentId: null, index: 2 }, nodes)).toEqual({
      kind: 'layers',
      order: ['l1', 'l2', 'buildings'],
    });
    expect(planMove({ id: 'places', parentId: null, index: 4 }, nodes)).toBeNull();
  });
});

describe('the selection of the tree', () => {
  const kinds: Record<string, 'layer' | 'group' | 'feature'> = {
    l1: 'layer',
    g1: 'group',
    a: 'feature',
    b: 'feature',
  };
  const kindOf = (id: string) => kinds[id];

  it('mirrors what draw has selected', () => {
    expect(selectedIds({ type: 'feature', ids: ['a', 'b'] })).toEqual(['a', 'b']);
    expect(selectedIds({ type: 'layer', ids: ['l1'] })).toEqual(['l1']);
    expect(selectedIds({ type: null, ids: [] })).toEqual([]);
  });

  it('keeps the kind of the row pressed last', () => {
    expect(selectionOf(['a', 'l1', 'b'], kindOf, 'feature')).toEqual({
      type: 'feature',
      ids: ['a', 'b'],
    });
    expect(selectionOf(['a', 'l1'], kindOf, 'layer')).toEqual({ type: 'layer', ids: ['l1'] });
    expect(selectionOf(['a', 'g1'], kindOf)).toEqual({ type: 'group', ids: ['g1'] });
    expect(selectionOf([], kindOf)).toBeNull();
    expect(selectionOf(['gone'], kindOf)).toBeNull();
  });

  it('can group two features or more of one layer', () => {
    const fake = sample();
    const get = (id: string) => fake.draw.features.get(id);
    expect(canGroup({ type: 'feature', ids: ['a', 'b'] }, get)).toBe(true);
    expect(canGroup({ type: 'feature', ids: ['a'] }, get)).toBe(false);
    expect(canGroup({ type: 'feature', ids: ['a', 'e'] }, get)).toBe(false);
    expect(canGroup({ type: 'layer', ids: ['l1', 'l2'] }, get)).toBe(false);
  });
});

describe('dropping in the tree', () => {
  const node = (kind: string) => ({ id: kind, kind, name: kind, visible: true, locked: false });

  it('lets a layer go to the root, a group into a layer, a feature into a layer or a group', () => {
    expect(canDropInto(node('layer'), null)).toBe(true);
    expect(canDropInto(node('layer'), node('layer'))).toBe(false);
    expect(canDropInto(node('group'), node('layer'))).toBe(true);
    expect(canDropInto(node('group'), node('group'))).toBe(false);
    expect(canDropInto(node('group'), null)).toBe(false);
    expect(canDropInto(node('feature'), node('layer'))).toBe(true);
    expect(canDropInto(node('feature'), node('group'))).toBe(true);
    expect(canDropInto(node('feature'), null)).toBe(false);
  });

  it('places an item just in front of the one behind it in the list of core', () => {
    expect(coreIndex(['a', 'g1', 'b'], 'a', 'b')).toBe(2);
    expect(coreIndex(['a', 'g1', 'b'], 'b', undefined)).toBe(0);
    expect(coreIndex(['x', 'a', 'g1', 'b'], 'a', 'g1')).toBe(2);
  });

  it('reorders the layers from the back', () => {
    const fake = sample();
    const nodes = buildNodes(fake.draw, en);
    expect(planMove({ id: 'l1', parentId: null, index: 0 }, nodes)).toEqual({
      kind: 'layers',
      order: ['l2', 'l1'],
    });
    expect(planMove({ id: 'l2', parentId: null, index: 1 }, nodes)).toEqual({
      kind: 'layers',
      order: ['l2', 'l1'],
    });
  });

  // Each drop is applied to the document, and the tree built again shows the node where it was
  // dropped
  const drops: [string, { id: string; parentId: string; index: number }, unknown[]][] = [
    [
      'a feature to the front of its layer',
      { id: 'a', parentId: 'l1', index: 0 },
      ['a', 'b', 'g1'],
    ],
    ['a feature to the back of its layer', { id: 'b', parentId: 'l1', index: 2 }, ['g1', 'a', 'b']],
    ['a feature one step up', { id: 'a', parentId: 'l1', index: 1 }, ['b', 'a', 'g1']],
    ['a group to the front', { id: 'g1', parentId: 'l1', index: 0 }, ['g1', 'b', 'a']],
  ];
  for (const [what, move, children] of drops) {
    it(`moves ${what}`, () => {
      const fake = sample();
      const plan = planMove(move, buildNodes(fake.draw, en));
      if (plan?.kind === 'feature') fake.draw.features.move(plan.id, plan.to);
      else if (plan?.kind === 'group') fake.draw.groups.move(plan.id, plan.to);
      else throw new Error('no plan');
      const l1 = buildNodes(fake.draw, en)[1];
      expect(l1.children?.map((n) => n.id)).toEqual(children);
    });
  }

  it('moves a feature into a group, at the place it was dropped', () => {
    const fake = sample();
    const plan = planMove({ id: 'a', parentId: 'g1', index: 1 }, buildNodes(fake.draw, en));
    expect(plan).toEqual({ kind: 'feature', id: 'a', to: { groupId: 'g1', index: 1 } });
    fake.draw.features.move('a', { groupId: 'g1', index: 1 });
    const g1 = buildNodes(fake.draw, en)[1].children?.find((n) => n.id === 'g1');
    expect(g1?.children?.map((n) => n.id)).toEqual(['d', 'a', 'c']);
  });

  it('moves a feature out of its group into another layer', () => {
    const fake = sample();
    const plan = planMove({ id: 'c', parentId: 'l2', index: 0 }, buildNodes(fake.draw, en));
    expect(plan).toEqual({ kind: 'feature', id: 'c', to: { layerId: 'l2', index: 1 } });
  });

  it('moves a group into another layer', () => {
    const fake = sample();
    const plan = planMove({ id: 'g1', parentId: 'l2', index: 1 }, buildNodes(fake.draw, en));
    expect(plan).toEqual({ kind: 'group', id: 'g1', to: { layerId: 'l2', index: 0 } });
  });

  it('refuses a drop the tree does not allow', () => {
    const nodes = buildNodes(sample().draw, en);
    expect(planMove({ id: 'a', parentId: null, index: 0 }, nodes)).toBeNull();
    expect(planMove({ id: 'g1', parentId: 'g1', index: 0 }, nodes)).toBeNull();
    expect(planMove({ id: 'l1', parentId: 'l2', index: 0 }, nodes)).toBeNull();
    expect(planMove({ id: 'gone', parentId: 'l1', index: 0 }, nodes)).toBeNull();
  });

  it('counts the items the tree does not show', () => {
    const fake = fakeDraw({
      doc: {
        layers: [layer('l1', ['a', 'g1', 'b', 'g2'])],
        groups: [group('g1', 'l1', []), group('g2', 'l1', [])],
        features: [feature('a', 'l1'), feature('b', 'l1')],
      },
    });
    // Without the features, the tree shows g2 and g1 alone; g1 dropped on top goes in front of g2
    const nodes = buildNodes(fake.draw, en, { features: false });
    expect(shape(nodes)).toEqual([['l1', ['g2', 'g1']]]);
    const plan = planMove({ id: 'g1', parentId: 'l1', index: 0 }, nodes);
    expect(plan).toEqual({ kind: 'group', id: 'g1', to: { layerId: 'l1', index: 3 } });
  });
});

describe('the legend', () => {
  it('has the rows of the rule of each layer that has one, from the front', () => {
    const fake = sample();
    fake.change(({ layers }) => {
      layers.set('l1', {
        ...(layers.get('l1') as Layer),
        styleRule: { kind: 'single', color: '#123456' },
      });
    });
    const blocks = legendBlocks(fake.draw, en);
    expect(blocks).toEqual([
      {
        layerId: 'l2',
        name: 'Places',
        entries: [
          { label: 'park', color: '#00aa00' },
          { label: 'shop', color: '#aa0000' },
          { label: 'Other', color: '#999999' },
        ],
        shape: 'area',
      },
      {
        layerId: 'l1',
        name: 'Layer l1',
        entries: [{ label: 'All', color: '#123456' }],
        shape: 'box',
      },
    ]);
  });

  it('leaves out the layers without a rule', () => {
    const fake = sample();
    fake.change(({ layers }) => {
      layers.set('l2', { ...(layers.get('l2') as Layer), styleRule: undefined });
    });
    expect(legendBlocks(fake.draw, en)).toEqual([]);
  });

  it('labels the classes with the words of the locale', () => {
    const fake = sample();
    fake.change(({ layers }) => {
      layers.set('l2', {
        ...(layers.get('l2') as Layer),
        styleRule: {
          kind: 'graduated',
          property: 'n',
          breaks: [10, 20],
          colors: ['#000000', '#888888', '#ffffff'],
          other: '#ff0000',
        },
      });
    });
    const labels = (locale: 'en' | 'ja') =>
      legendBlocks(fake.draw, resolveMessages(locale))[0].entries.map((e) => e.label);
    expect(labels('en')).toEqual(['Below 10', '10 to below 20', '20 or more', 'Other']);
    expect(labels('ja')).toEqual(['10 未満', '10 以上 20 未満', '20 以上', 'その他']);
  });

  it('draws the swatches after what the features of the layer are', () => {
    const f = (type: string) => feature(type, 'l', type);
    expect(legendShape([f('Point'), f('MultiPoint')])).toBe('dot');
    expect(legendShape([f('LineString'), f('Freehand')])).toBe('line');
    expect(legendShape([f('Polygon'), f('Circle'), f('Image')])).toBe('area');
    expect(legendShape([f('Point'), f('Polygon')])).toBe('box');
    expect(legendShape([])).toBe('box');
  });
});
