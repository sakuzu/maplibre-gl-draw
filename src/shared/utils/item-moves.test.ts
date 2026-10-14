// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { seededRandom } from '../../test-utils.js';
import type { ItemMove, ItemPosition } from '../types/model.js';
import { diffItemOrder, type OrderContainer } from './item-moves.js';

/** The items of each container, by `layerId/groupId` */
type State = Map<string, string[]>;

const keyOf = (position: ItemPosition) => `${position.layerId}/${position.groupId ?? ''}`;

/** Puts an item at a position (the item just below it decides, then the one above) */
function put(state: State, item: string, position: ItemPosition | null): void {
  for (const items of state.values()) {
    const at = items.indexOf(item);
    if (at >= 0) items.splice(at, 1);
  }
  if (!position) return;
  const items = state.get(keyOf(position)) ?? [];
  state.set(keyOf(position), items);
  if (position.below !== null) {
    const at = items.indexOf(position.below);
    expect(at, `${position.below} is not in ${keyOf(position)}`).toBeGreaterThanOrEqual(0);
    items.splice(at + 1, 0, item);
  } else {
    items.splice(0, 0, item);
  }
  // The item above is the one the move saw
  const at = items.indexOf(item);
  expect(items[at + 1] ?? null).toBe(position.above);
}

/** Makes the moves forward, or back from the last one */
function replay(state: State, moves: readonly ItemMove[], back: boolean): State {
  const out: State = new Map([...state].map(([key, items]) => [key, [...items]]));
  const list = back ? [...moves].reverse() : moves;
  for (const move of list) {
    // Before a move, the item stands where it says it was
    const where = back ? move.to : move.from;
    if (where) {
      const items = out.get(keyOf(where)) as string[];
      const at = items.indexOf(move.itemId);
      expect(items[at - 1] ?? null).toBe(where.below);
      expect(items[at + 1] ?? null).toBe(where.above);
    }
    put(out, move.itemId, back ? move.from : move.to);
  }
  for (const [key, items] of [...out]) if (items.length === 0) out.delete(key);
  return out;
}

function containersOf(before: State, after: State): OrderContainer<string>[] {
  const keys = new Set([...before.keys(), ...after.keys()]);
  return [...keys].map((key) => {
    const [layerId, groupId] = key.split('/');
    const b = before.get(key) ?? [];
    return {
      layerId,
      groupId: groupId === '' ? undefined : groupId,
      before: b,
      after: after.get(key) ?? [],
      beforeIndex: (item: string) => b.indexOf(item),
    };
  });
}

function clean(state: State): State {
  return new Map([...state].filter(([, items]) => items.length > 0));
}

describe('diffItemOrder', () => {
  it('moves the fewest items, and the moves made back put the order back', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const random = seededRandom(seed);
      const before: State = new Map();
      let next = 0;
      for (const layer of ['a', 'b']) {
        before.set(
          `${layer}/`,
          Array.from({ length: Math.floor(random() * 6) }, () => `f${next++}`),
        );
      }
      // A group in layer a with its members
      const members = Array.from({ length: 1 + Math.floor(random() * 3) }, () => `f${next++}`);
      before.get('a/')?.splice(0, 0, 'g');
      before.set('a/g', members);
      // The state after: items shuffled, moved to the other layer, deleted, created
      const after: State = new Map([...before].map(([key, items]) => [key, [...items]]));
      const deleted: string[] = [];
      for (let step = 0; step < 6; step++) {
        const r = random();
        const keys = [...after.keys()].filter((key) => (after.get(key) as string[]).length > 0);
        const key = keys[Math.floor(random() * keys.length)];
        const items = after.get(key) as string[];
        const item = items[Math.floor(random() * items.length)];
        if (item === undefined || item === 'g') continue;
        items.splice(items.indexOf(item), 1);
        if (r < 0.2) {
          deleted.push(item);
          continue;
        }
        const targets = ['a/', 'b/', 'a/g'];
        const target = after.get(targets[Math.floor(random() * targets.length)]) as string[];
        target.splice(Math.floor(random() * (target.length + 1)), 0, item);
        if (r > 0.9) {
          const created = `f${next++}`;
          target.splice(Math.floor(random() * (target.length + 1)), 0, created);
        }
      }
      // The group goes when it has no member left
      if ((after.get('a/g') as string[]).length === 0) {
        const items = after.get('a/') as string[];
        items.splice(items.indexOf('g'), 1);
        deleted.push('g');
      }
      const moves = diffItemOrder(containersOf(before, clean(after)), {
        deleted,
        isGroup: (item) => item === 'g',
        idOf: (item) => item,
      });
      expect(replay(before, moves, false), `seed ${seed}`).toEqual(clean(after));
      expect(replay(clean(after), moves, true), `seed ${seed}`).toEqual(clean(before));
    }
  });

  it('moves only the items given as moved', () => {
    const before: State = new Map([['a/', ['x', 'y', 'z']]]);
    const after: State = new Map([['a/', ['y', 'x', 'z']]]);
    const moves = diffItemOrder(containersOf(before, after), {
      moved: new Set(['y']),
      deleted: [],
      isGroup: () => false,
      idOf: (item) => item,
    });
    expect(moves).toEqual([
      {
        kind: 'item',
        itemId: 'y',
        from: { layerId: 'a', groupId: undefined, below: 'x', above: 'z' },
        to: { layerId: 'a', groupId: undefined, below: null, above: 'x' },
      },
    ]);
  });

  it('puts a group in its place before its members go into it, and back', () => {
    const before: State = new Map([['a/', ['x', 'y', 'z']]]);
    const after: State = new Map([
      ['a/', ['x', 'g']],
      ['a/g', ['y', 'z']],
    ]);
    const moves = diffItemOrder(containersOf(before, after), {
      deleted: [],
      isGroup: (item) => item === 'g',
      idOf: (item) => item,
    });
    expect(moves.map((move) => move.itemId)).toEqual(['g', 'y', 'z']);
    expect(replay(after, moves, true)).toEqual(before);
  });
});
