// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// The tree of a layer held as rows: its items and the members of its groups read from the rows,
// and a drop in it named by the item behind the node

import type { FeatureTables, Group, Layer } from '@sakuzu/maplibre-gl-draw';
import { describe, expect, it } from 'vitest';
import { planMove } from '../src/layers/move.js';
import { buildNodes, type LayerTreeNode, type TreeSource } from '../src/layers/tree.js';
import { resolveMessages } from '../src/messages.js';
import { feature } from './fake-draw.js';

const en = resolveMessages('en');

/** A layer held as rows: a, the group g (c and d) and b, from the back */
function tableSource(): TreeSource {
  const layer: Layer = {
    id: 'rows',
    name: 'Rows',
    visible: true,
    locked: false,
    opacity: 1,
    kind: 'table',
    styleRule: undefined,
    metadata: undefined,
  };
  const group: Group = {
    id: 'g',
    layerId: 'rows',
    name: 'G',
    visible: true,
    locked: false,
    kind: 'table',
  };
  const ids = ['a', 'b', 'c', 'd'];
  const features = new Map(ids.map((id) => [id, { ...feature(id, 'rows'), layerId: 'rows' }]));
  for (const id of ['c', 'd']) {
    const f = features.get(id);
    if (f) features.set(id, { ...f, groupId: 'g' });
  }
  // Rows 0 to 3 are a, b, c, d; the group is the handle 7
  const tables = {
    idOf: (handle: number) => ids[handle],
    groupIdOf: (handle: number) => (handle === 7 ? 'g' : undefined),
    groupHandleOf: (id: string) => (id === 'g' ? 7 : undefined),
    layer: (layerId: string) =>
      layerId === 'rows'
        ? {
            itemCount: 3,
            itemsInOrder: () => ({
              kinds: Uint8Array.of(0, 1, 0),
              handles: Int32Array.of(0, 7, 1),
            }),
            groupMemberCount: (handle: number) => (handle === 7 ? 2 : 0),
            groupMembersInOrder: (handle: number) =>
              handle === 7 ? Int32Array.of(2, 3) : new Int32Array(0),
          }
        : undefined,
  } as unknown as FeatureTables;
  return {
    layers: { get: (id) => (id === 'rows' ? layer : undefined), getOrder: () => ['rows'] },
    groups: { get: (id) => (id === 'g' ? group : undefined) },
    features: { get: (id) => features.get(id), getAppliedStyle: () => undefined },
    getStore: () => ({ tables }),
  };
}

describe('a layer held as rows in the tree', () => {
  it('lists its items and the members of its groups from the front, read from the rows', () => {
    const nodes = buildNodes(tableSource(), en, { features: true, datasets: false });
    const rows = nodes[0];
    expect(rows.children?.map((n) => n.id)).toEqual(['b', 'g', 'a']);
    expect(rows.children?.[1].children?.map((n) => n.id)).toEqual(['d', 'c']);
  });

  it('counts its features without listing them past the limit', () => {
    const nodes = buildNodes(tableSource(), en, { features: true, datasets: false, limit: 3 });
    expect(nodes[0].children?.map((n) => (n as LayerTreeNode).count)).toEqual([4]);
  });

  it('names a drop by the item behind the node', () => {
    const nodes = buildNodes(tableSource(), en, { features: true, datasets: false });
    // a to the front of the layer: nothing is in front of it, b is behind it
    expect(planMove({ id: 'a', parentId: 'rows', index: 0 }, nodes)).toEqual({
      kind: 'feature',
      id: 'a',
      to: { layerId: 'rows', below: 'b' },
    });
    // b to the back
    expect(planMove({ id: 'b', parentId: 'rows', index: 2 }, nodes)).toEqual({
      kind: 'feature',
      id: 'b',
      to: { layerId: 'rows', below: null },
    });
    // a into the group, in front of d
    expect(planMove({ id: 'a', parentId: 'g', index: 0 }, nodes)).toEqual({
      kind: 'feature',
      id: 'a',
      to: { layerId: 'rows', groupId: 'g', below: 'd' },
    });
  });
});
