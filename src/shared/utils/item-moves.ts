// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The moves of items between two states of the order of the layers and the groups
 *
 * The items of a layer (its features outside a group, and its groups) and the members of a group
 * stand in an order. Between two states of it, a list of moves (`ItemMove`) is made that takes
 * the first to the second one item at a time, each with where the item stood and where it stands
 * at that moment, so that the moves made back from the last one (each item put back where it
 * was) take the second state back to the first.
 *
 * The moves come in this order: the items placed in the layers (moved, or created), then the
 * features placed in the groups, then the features deleted, then the groups deleted. A group is
 * then in its place before its members go into it, and its members leave it before it is
 * deleted; made back, the same holds.
 *
 * An item that stays where it is among the others of its container is not moved: the items to
 * move are given (`moved`), or found as the fewest that must move (the items of a container that
 * stay are the longest run of them already in their order).
 */

import type { ItemMove, ItemPosition } from '../types/model.js';

/**
 * A layer or a group of features, with its items before and after
 *
 * @internal
 */
export interface OrderContainer<T> {
  /** The layer (the layer of the group for a group) */
  readonly layerId: string;
  /** The group of features (undefined for a layer) */
  readonly groupId: string | undefined;
  /** Its items before, from the back (none when it did not exist) */
  readonly before: ArrayLike<T>;
  /** Its items after, from the back (none when it does not exist any more) */
  readonly after: ArrayLike<T>;
  /** The place of an item in `before` (-1 when it is not there) */
  beforeIndex(item: T): number;
  /**
   * Whether the first and the last item of `before` and of `after` are the same item standing
   * where it stands, given only as the neighbor of the others (the lists are a run of longer
   * ones that differ, see {@link trimmedContainer}): it is never moved
   */
  readonly fixedEnds?: readonly [boolean, boolean];
}

/**
 * A container whose lists are cut to the run where they differ, with the item next to it at each
 * end that stands where it was (which the moves name as a neighbor), and the places of the items
 * of `before` in that run: what an item added at the front of a long list costs is the items it is
 * added to, not the list
 *
 * @internal
 */
export function trimmedContainer<T>(
  layerId: string,
  groupId: string | undefined,
  before: ArrayLike<T>,
  after: ArrayLike<T>,
): OrderContainer<T> {
  let head = 0;
  const shortest = Math.min(before.length, after.length);
  while (head < shortest && before[head] === after[head]) head++;
  let tail = 0;
  while (
    tail < shortest - head &&
    before[before.length - 1 - tail] === after[after.length - 1 - tail]
  ) {
    tail++;
  }
  if (head === before.length && head === after.length) {
    return { layerId, groupId, before: [], after: [], beforeIndex: () => -1 };
  }
  const from = Math.max(0, head - 1);
  const runBefore = Array.prototype.slice.call(before, from, before.length - Math.max(0, tail - 1));
  const runAfter = Array.prototype.slice.call(after, from, after.length - Math.max(0, tail - 1));
  const index = new Map<T, number>();
  runBefore.forEach((item: T, i: number) => {
    index.set(item, i);
  });
  return {
    layerId,
    groupId,
    before: runBefore as T[],
    after: runAfter as T[],
    beforeIndex: (item) => index.get(item) ?? -1,
    fixedEnds: [head > 0, tail > 0],
  };
}

/**
 * What the moves are made with
 *
 * @internal
 */
export interface ItemMovesOptions<T> {
  /**
   * The items that moved, were created or were deleted; every other item of the containers stays
   * where it is among the others. When omitted, the fewest items that must move are found
   */
  readonly moved?: { has(item: T): boolean };
  /** The items deleted: in a container before, in none after */
  readonly deleted: readonly T[];
  /** Whether an item is a group of features (a group is deleted after the features) */
  isGroup(item: T): boolean;
  /** The id of an item, as the moves name it */
  idOf(item: T): string;
}

/**
 * The moves that take the containers from their items before to their items after (see the
 * module)
 *
 * @internal
 */
export function diffItemOrder<T>(
  containers: readonly OrderContainer<T>[],
  options: ItemMovesOptions<T>,
): ItemMove[] {
  const list = new LinkedItems(containers);
  const moves: ItemMove[] = [];
  const ordered = [
    ...containers.filter((c) => c.groupId === undefined),
    ...containers.filter((c) => c.groupId !== undefined),
  ];
  for (const container of ordered) {
    const c = containers.indexOf(container);
    const after = container.after;
    const stays = stayingItems(container, options.moved);
    for (let i = 0; i < after.length; i++) {
      const item = after[i];
      if (stays.has(i)) continue;
      const from = list.positionOf(item, options.idOf);
      list.remove(item);
      list.insertAfter(c, i > 0 ? after[i - 1] : null, item);
      const to = list.positionOf(item, options.idOf);
      moves.push({ kind: 'item', itemId: options.idOf(item), from, to });
    }
  }
  const features = options.deleted.filter((item) => !options.isGroup(item));
  const groups = options.deleted.filter((item) => options.isGroup(item));
  for (const item of [...features, ...groups]) {
    const from = list.positionOf(item, options.idOf);
    if (!from) continue;
    list.remove(item);
    moves.push({ kind: 'item', itemId: options.idOf(item), from, to: null });
  }
  return moves;
}

/**
 * The places in `after` of the items of a container that stay where they are: the ones not
 * moved, or the longest run of the ones that were there already in their order
 */
function stayingItems<T>(
  container: OrderContainer<T>,
  moved: { has(item: T): boolean } | undefined,
): Set<number> {
  const after = container.after;
  const stays = new Set<number>();
  if (container.fixedEnds?.[0] && after.length > 0) stays.add(0);
  if (container.fixedEnds?.[1] && after.length > 0) stays.add(after.length - 1);
  if (moved) {
    for (let i = 0; i < after.length; i++) {
      if (!moved.has(after[i]) && container.beforeIndex(after[i]) >= 0) stays.add(i);
    }
    return stays;
  }
  // The longest run of places in `after` whose places in `before` go up
  const places: number[] = [];
  const indices: number[] = [];
  for (let i = 0; i < after.length; i++) {
    if (stays.has(i)) continue;
    const at = container.beforeIndex(after[i]);
    if (at < 0) continue;
    places.push(at);
    indices.push(i);
  }
  for (const k of longestRisingRun(places)) stays.add(indices[k]);
  return stays;
}

/**
 * The longest run of numbers that go up, as their places in the list (the first one the patience
 * method finds, from the last number of the run back)
 *
 * @internal
 */
export function longestRisingRun(numbers: ArrayLike<number>): number[] {
  const tails: number[] = [];
  const previous = new Int32Array(numbers.length).fill(-1);
  for (let k = 0; k < numbers.length; k++) {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (numbers[tails[mid]] < numbers[k]) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) previous[k] = tails[lo - 1];
    tails[lo] = k;
  }
  const run: number[] = [];
  for (let k = tails.length > 0 ? tails[tails.length - 1] : -1; k >= 0; k = previous[k]) {
    run.push(k);
  }
  return run;
}

/**
 * The items of the containers as linked lists, the items before first (read in place, not
 * copied), and the items put in them after
 */
class LinkedItems<T> {
  /** The first node of each container's items before */
  private readonly offsets: number[] = [];
  private prev: Int32Array;
  private next: Int32Array;
  private readonly containerOf: number[] = [];
  /** The items of the nodes put in after the ones before */
  private readonly added = new Map<number, T>();
  /** The node of an item put somewhere else than where it was, or -1 once it is taken out */
  private readonly moved = new Map<T, number>();
  private readonly heads: number[] = [];
  private readonly tails: number[] = [];
  private count = 0;

  constructor(private readonly containers: readonly OrderContainer<T>[]) {
    let total = 0;
    for (const c of containers) {
      this.offsets.push(total);
      total += c.before.length;
    }
    this.count = total;
    this.prev = new Int32Array(Math.max(16, total * 2));
    this.next = new Int32Array(Math.max(16, total * 2));
    containers.forEach((c, k) => {
      const offset = this.offsets[k];
      const n = c.before.length;
      for (let i = 0; i < n; i++) {
        this.prev[offset + i] = i > 0 ? offset + i - 1 : -1;
        this.next[offset + i] = i + 1 < n ? offset + i + 1 : -1;
        this.containerOf[offset + i] = k;
      }
      this.heads.push(n > 0 ? offset : -1);
      this.tails.push(n > 0 ? offset + n - 1 : -1);
    });
  }

  /** The node of an item (-1 when it is in no container) */
  private nodeOf(item: T): number {
    const moved = this.moved.get(item);
    if (moved !== undefined) return moved;
    for (let k = 0; k < this.containers.length; k++) {
      const at = this.containers[k].beforeIndex(item);
      if (at >= 0) return this.offsets[k] + at;
    }
    return -1;
  }

  /** The item of a node */
  private itemOf(node: number): T {
    const added = this.added.get(node);
    if (added !== undefined || this.added.has(node)) return added as T;
    const k = this.containerOf[node];
    return this.containers[k].before[node - this.offsets[k]];
  }

  /** Where an item stands (null when it is in no container) */
  positionOf(item: T, idOf: (item: T) => string): ItemPosition | null {
    const node = this.nodeOf(item);
    if (node < 0) return null;
    const c = this.containers[this.containerOf[node]];
    const below = this.prev[node];
    const above = this.next[node];
    return {
      layerId: c.layerId,
      groupId: c.groupId,
      below: below >= 0 ? idOf(this.itemOf(below)) : null,
      above: above >= 0 ? idOf(this.itemOf(above)) : null,
    };
  }

  /** Takes an item out of its container */
  remove(item: T): void {
    const node = this.nodeOf(item);
    if (node < 0) return;
    const k = this.containerOf[node];
    const p = this.prev[node];
    const n = this.next[node];
    if (p >= 0) this.next[p] = n;
    else this.heads[k] = n;
    if (n >= 0) this.prev[n] = p;
    else this.tails[k] = p;
    this.moved.set(item, -1);
  }

  /** Puts an item in a container just above another (at the back for null) */
  insertAfter(container: number, below: T | null, item: T): void {
    const node = this.count++;
    if (node >= this.prev.length) {
      const prev = new Int32Array(this.prev.length * 2);
      prev.set(this.prev);
      this.prev = prev;
      const next = new Int32Array(this.next.length * 2);
      next.set(this.next);
      this.next = next;
    }
    this.added.set(node, item);
    this.containerOf[node] = container;
    this.moved.set(item, node);
    const p = below === null ? -1 : this.nodeOf(below);
    const n = p >= 0 ? this.next[p] : this.heads[container];
    this.prev[node] = p;
    this.next[node] = n;
    if (p >= 0) this.next[p] = node;
    else this.heads[container] = node;
    if (n >= 0) this.prev[n] = node;
    else this.tails[container] = node;
  }
}
