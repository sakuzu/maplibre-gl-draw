// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `diffItemOrder`: the moves of the items between two states of lists of items (13.6 of the
 * design). They are the moves a reference made item by item over arrays makes (the items of a
 * list that stay are the longest run of them already in their order, the first such run the
 * patience method finds), they take the lists before to the lists after, and made back they take
 * them back.
 */

import { describe, expect, it } from 'vitest';
import type { ItemMove, ItemPosition } from '../shared/types/model.js';
import { diffItemOrder, type ItemListChange } from './model.js';

/** The places in `after` of the items that stay: the longest run whose places in `before` go up */
function stayingOf(before: readonly string[], after: readonly string[]): Set<number> {
  const placeBefore = new Map<string, number>();
  before.forEach((id, i) => {
    if (!placeBefore.has(id)) placeBefore.set(id, i);
  });
  const places: number[] = [];
  const indices: number[] = [];
  after.forEach((id, i) => {
    const at = placeBefore.get(id);
    if (at === undefined) return;
    places.push(at);
    indices.push(i);
  });
  const tails: number[] = [];
  const previous: number[] = places.map(() => -1);
  places.forEach((place, k) => {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (places[tails[mid]] < place) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) previous[k] = tails[lo - 1];
    tails[lo] = k;
  });
  const stays = new Set<number>();
  for (let k = tails.length > 0 ? tails[tails.length - 1] : -1; k >= 0; k = previous[k]) {
    stays.add(indices[k]);
  }
  return stays;
}

/** The reference: the lists as arrays, the items moved one at a time */
function referenceMoves(lists: readonly ItemListChange[], isGroup: (id: string) => boolean) {
  const seen = new Set<string>();
  const state = lists.map((list) =>
    list.before.filter((id) => {
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    }),
  );
  const where = (id: string): ItemPosition | null => {
    for (let k = 0; k < state.length; k++) {
      const at = state[k].indexOf(id);
      if (at < 0) continue;
      return {
        layerId: lists[k].layerId,
        groupId: lists[k].groupId,
        below: at > 0 ? state[k][at - 1] : null,
        above: at + 1 < state[k].length ? state[k][at + 1] : null,
      };
    }
    return null;
  };
  const take = (id: string) => {
    for (const list of state) {
      const at = list.indexOf(id);
      if (at >= 0) list.splice(at, 1);
    }
  };
  const moves: ItemMove[] = [];
  const order = [
    ...lists.flatMap((list, k) => (list.groupId === undefined ? [k] : [])),
    ...lists.flatMap((list, k) => (list.groupId !== undefined ? [k] : [])),
  ];
  const placed = new Set<string>();
  for (const k of order) {
    const after = lists[k].after;
    const stays = stayingOf(lists[k].before, after);
    let below: string | null = null;
    after.forEach((id, i) => {
      if (placed.has(id)) return;
      placed.add(id);
      if (!stays.has(i)) {
        const from = where(id);
        take(id);
        state[k].splice(below === null ? 0 : state[k].indexOf(below) + 1, 0, id);
        moves.push({ kind: 'item', itemId: id, from, to: where(id) });
      }
      below = id;
    });
  }
  const listedAfter = new Set(lists.flatMap((list) => list.after));
  const deleted = lists.flatMap((list) => list.before.filter((id) => !listedAfter.has(id)));
  const done = new Set<string>();
  for (const id of [
    ...deleted.filter((id) => !isGroup(id)),
    ...deleted.filter((id) => isGroup(id)),
  ]) {
    if (done.has(id)) continue;
    done.add(id);
    const from = where(id);
    if (!from) continue;
    take(id);
    moves.push({ kind: 'item', itemId: id, from, to: null });
  }
  return moves;
}

/** A small generator of numbers, so that the cases are the same every run */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

/** Lists of a layer and its groups, before and after a change made of random edits */
function randomCase(next: () => number): ItemListChange[] {
  const groups = ['g0', 'g1', 'g2'].slice(0, Math.floor(next() * 4));
  const ids = Array.from({ length: 4 + Math.floor(next() * 12) }, (_, i) => `f${i}`);
  const before = new Map<string | undefined, string[]>([[undefined, [...groups]]]);
  for (const group of groups) before.set(group, []);
  for (const id of ids) {
    const into = [undefined, ...groups][Math.floor(next() * (groups.length + 1))];
    (before.get(into) as string[]).push(id);
  }
  const after = new Map([...before].map(([key, list]) => [key, [...list]]));
  const containers = [...after.keys()];
  const edits = 1 + Math.floor(next() * 6);
  for (let e = 0; e < edits; e++) {
    const kind = next();
    const from = after.get(containers[Math.floor(next() * containers.length)]) as string[];
    if (kind < 0.5 && from.length > 0) {
      // Move an item (a feature into another list, a group within the layer)
      const [id] = from.splice(Math.floor(next() * from.length), 1);
      const target = groups.includes(id)
        ? (after.get(undefined) as string[])
        : (after.get(containers[Math.floor(next() * containers.length)]) as string[]);
      target.splice(Math.floor(next() * (target.length + 1)), 0, id);
    } else if (kind < 0.75) {
      // Create a feature
      const target = after.get(containers[Math.floor(next() * containers.length)]) as string[];
      target.splice(Math.floor(next() * (target.length + 1)), 0, `n${e}`);
    } else if (from.length > 0) {
      // Delete an item (a group with its members out of it first)
      const [id] = from.splice(Math.floor(next() * from.length), 1);
      if (groups.includes(id)) {
        const members = after.get(id) as string[];
        (after.get(undefined) as string[]).push(...members);
        members.length = 0;
      }
    }
  }
  return containers.map((key) => ({
    layerId: 'layer',
    groupId: key,
    before: before.get(key) as string[],
    after: after.get(key) as string[],
  }));
}

/** The lists after the moves made from the lists before, or back from the lists after */
function replay(lists: readonly ItemListChange[], moves: readonly ItemMove[], back: boolean) {
  const state = new Map<string | undefined, string[]>(
    lists.map((list) => [list.groupId, [...(back ? list.after : list.before)]]),
  );
  const put = (id: string, position: ItemPosition | null) => {
    for (const list of state.values()) {
      const at = list.indexOf(id);
      if (at >= 0) list.splice(at, 1);
    }
    if (!position) return;
    const list = state.get(position.groupId) as string[];
    list.splice(position.below === null ? 0 : list.indexOf(position.below) + 1, 0, id);
  };
  if (back) for (const move of [...moves].reverse()) put(move.itemId, move.from);
  else for (const move of moves) put(move.itemId, move.to);
  return lists.map((list) => state.get(list.groupId));
}

describe('diffItemOrder', () => {
  it('moves the fewest items, each with where it stood and where it stands', () => {
    const moves = diffItemOrder(
      [{ layerId: 'l', groupId: undefined, before: ['a', 'b', 'c'], after: ['c', 'a', 'b'] }],
      () => false,
    );
    expect(moves).toEqual([
      {
        kind: 'item',
        itemId: 'c',
        from: { layerId: 'l', groupId: undefined, below: 'b', above: null },
        to: { layerId: 'l', groupId: undefined, below: null, above: 'a' },
      },
    ]);
  });

  it('places a group before its members go into it, and deletes it after they left', () => {
    const isGroup = (id: string) => id === 'g';
    const grouped = diffItemOrder(
      [
        { layerId: 'l', groupId: undefined, before: ['a', 'b', 'c'], after: ['a', 'g'] },
        { layerId: 'l', groupId: 'g', before: [], after: ['b', 'c'] },
      ],
      isGroup,
    );
    expect(grouped.map((move) => [move.itemId, move.from?.groupId, move.to?.groupId])).toEqual([
      ['g', undefined, undefined],
      ['b', undefined, 'g'],
      ['c', undefined, 'g'],
    ]);
    expect(grouped[0].from).toBeNull();
    const ungrouped = diffItemOrder(
      [
        { layerId: 'l', groupId: undefined, before: ['a', 'g'], after: ['a', 'b', 'c'] },
        { layerId: 'l', groupId: 'g', before: ['b', 'c'], after: [] },
      ],
      isGroup,
    );
    expect(ungrouped.map((move) => move.itemId)).toEqual(['b', 'c', 'g']);
    expect(ungrouped[2].to).toBeNull();
  });

  it('keeps the first place of an item listed twice', () => {
    const lists: ItemListChange[] = [
      { layerId: 'l', groupId: undefined, before: ['a', 'b', 'a'], after: ['b', 'a', 'b'] },
    ];
    const moves = diffItemOrder(lists, () => false);
    expect(moves).toEqual(referenceMoves(lists, () => false));
    // Read once each: 'b' goes to the back, before 'a'
    expect(moves.map((move) => [move.itemId, move.to?.below, move.to?.above])).toEqual([
      ['b', null, 'a'],
    ]);
  });

  it('makes the moves of the reference, which take the lists there and back', () => {
    const next = random(129);
    for (let run = 0; run < 2000; run++) {
      const lists = randomCase(next);
      const isGroup = (id: string) => id.startsWith('g');
      const moves = diffItemOrder(lists, isGroup);
      expect(moves).toEqual(referenceMoves(lists, isGroup));
      expect(replay(lists, moves, false)).toEqual(lists.map((list) => list.after));
      expect(replay(lists, moves, true)).toEqual(lists.map((list) => list.before));
    }
  });

  it('makes the moves of the reference with items listed twice', () => {
    const next = random(31);
    for (let run = 0; run < 2000; run++) {
      const lists = randomCase(next).map((list) => ({
        ...list,
        before:
          list.before.length > 1 && next() < 0.3 ? [...list.before, list.before[0]] : list.before,
        after: list.after.length > 1 && next() < 0.3 ? [...list.after, list.after[1]] : list.after,
      }));
      const isGroup = (id: string) => id.startsWith('g');
      expect(diffItemOrder(lists, isGroup)).toEqual(referenceMoves(lists, isGroup));
    }
  });
});
