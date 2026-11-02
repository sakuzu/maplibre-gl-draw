// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The moves of the items a Store of objects notifies (`order`): made back from the last one,
 * they put the items of the layers and the groups as they were before the transaction, whatever
 * the writes of it
 */

import { describe, expect, it } from 'vitest';
import { seededRandom } from '../test-utils.js';
import { MemoryStore } from './memory.js';
import type { Store } from './store.js';
import type { Feature, ItemMove, ItemPosition, StoreChange } from './types.js';

/** The items of every layer and group, by `layerId/groupId` */
type Lists = Map<string, string[]>;

function listsOf(store: Store): Lists {
  const out: Lists = new Map();
  for (const layer of store.listLayers()) {
    if (layer.kind === 'table') continue;
    if (layer.items.length > 0) out.set(`${layer.id}/`, [...layer.items]);
  }
  for (const group of store.listGroups()) {
    if (group.kind === 'table') continue;
    if (group.featureIds.length > 0) out.set(`${group.layerId}/${group.id}`, [...group.featureIds]);
  }
  return out;
}

const keyOf = (p: ItemPosition) => `${p.layerId}/${p.groupId ?? ''}`;

/** Makes the moves back, from the last one */
function undo(lists: Lists, moves: readonly ItemMove[]): Lists {
  const out: Lists = new Map([...lists].map(([key, items]) => [key, [...items]]));
  for (const move of [...moves].reverse()) {
    for (const items of out.values()) {
      const at = items.indexOf(move.itemId);
      if (at >= 0) items.splice(at, 1);
    }
    const from = move.from;
    if (!from) continue;
    const items = out.get(keyOf(from)) ?? [];
    out.set(keyOf(from), items);
    const at = from.below === null ? 0 : items.indexOf(from.below) + 1;
    expect(at, `${from.below} is in ${keyOf(from)}`).toBeGreaterThanOrEqual(0);
    items.splice(at, 0, move.itemId);
    expect(items[at + 1] ?? null).toBe(from.above);
  }
  for (const [key, items] of [...out]) if (items.length === 0) out.delete(key);
  return out;
}

function point(id: string, layerId: string): Feature {
  return {
    id,
    type: 'Point',
    geometry: { type: 'Point', coordinates: [0, 0] },
    layerId,
    groupId: undefined,
    properties: {},
    style: {},
    visible: true,
    locked: false,
  };
}

describe('the moves a Store of objects notifies', () => {
  it('made back, put the items as they were before each transaction', () => {
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const random = seededRandom(seed);
      const store = new MemoryStore();
      for (const id of ['a', 'b']) {
        store.createLayer({
          id,
          name: id,
          visible: true,
          locked: false,
          opacity: 1,
          items: [],
          metadata: undefined,
          styleRule: undefined,
        });
      }
      let notified: StoreChange[] = [];
      store.subscribe((change) => notified.push(change));
      let next = 0;
      const features = () => store.listFeatures().map((f) => f.id);
      for (let step = 0; step < 120; step++) {
        const before = listsOf(store);
        notified = [];
        const r = random();
        const ids = features();
        const pick = () => ids[Math.floor(random() * ids.length)];
        const layerId = random() < 0.5 ? 'a' : 'b';
        if (r < 0.25 || ids.length < 3) {
          store.createFeature(point(`f${next++}`, layerId));
        } else if (r < 0.35) {
          store.deleteFeature(pick());
        } else if (r < 0.5) {
          const id = pick();
          const feature = store.getFeature(id) as Feature;
          if (feature.groupId) continue;
          const layer = store.getLayer(feature.layerId);
          if (!layer || layer.kind === 'table') continue;
          store.reorderInLayer(id, layer.id, Math.floor(random() * layer.items.length));
        } else if (r < 0.6) {
          const id = pick();
          store.updateFeature(id, { layerId, groupId: undefined });
        } else if (r < 0.7) {
          // Two features grouped
          const members = ids.filter((id) => !store.getFeature(id)?.groupId).slice(0, 2);
          if (members.length < 2) continue;
          store.transact(() => {
            for (const id of members) store.updateFeature(id, { layerId: 'a' });
            store.createGroup({
              id: `g${next++}`,
              layerId: 'a',
              name: 'g',
              featureIds: members,
              visible: true,
              locked: false,
            });
          });
        } else if (r < 0.8) {
          const group = store.listGroups()[0];
          if (!group) continue;
          store.deleteGroup(group.id);
        } else if (r < 0.9) {
          // The items of a layer in another order at once
          const layer = store.getLayer(layerId);
          if (!layer || layer.kind === 'table') continue;
          const items = [...layer.items].sort(() => random() - 0.5);
          store.updateLayer(layerId, { items });
        } else {
          // Several writes in one transaction
          store.transact(() => {
            const id = `f${next++}`;
            store.createFeature(point(id, 'b'));
            store.updateFeature(id, { layerId: 'a' });
            const other = pick();
            if (store.getFeature(other)) store.deleteFeature(other);
          });
        }
        const moves = notified.flatMap((change) => change.order ?? []) as ItemMove[];
        expect(moves.every((move) => move.kind === 'item')).toBe(true);
        expect(undo(listsOf(store), moves), `seed ${seed}, step ${step}`).toEqual(before);
      }
    }
  });

  it('notifies a feature created with nowhere it was, and a feature deleted with nowhere it is', () => {
    const store = new MemoryStore();
    store.createLayer({
      id: 'l',
      name: 'l',
      visible: true,
      locked: false,
      opacity: 1,
      items: [],
      metadata: undefined,
      styleRule: undefined,
    });
    const changes: StoreChange[] = [];
    store.subscribe((change) => changes.push(change));
    store.createFeature(point('x', 'l'));
    store.createFeature(point('y', 'l'));
    store.deleteFeature('x');
    expect(changes.map((change) => change.order)).toEqual([
      [
        {
          kind: 'item',
          itemId: 'x',
          from: null,
          to: { layerId: 'l', groupId: undefined, below: null, above: null },
        },
      ],
      [
        {
          kind: 'item',
          itemId: 'y',
          from: null,
          to: { layerId: 'l', groupId: undefined, below: 'x', above: null },
        },
      ],
      [
        {
          kind: 'item',
          itemId: 'x',
          from: { layerId: 'l', groupId: undefined, below: null, above: 'y' },
          to: null,
        },
      ],
    ]);
  });
});
