// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * ChangeBus
 *
 * Responsible for the Store's change notification and transactions. It holds pendingChanges
 * and flushes them to the listeners only at the outermost transaction. MemoryStore (and
 * future Store implementations) holds one internally and delegates the transaction /
 * listener mechanism to it.
 *
 * Accumulation is done by destructive appending (appendChanges). pendingChanges during a
 * transaction is exposed only inside ChangeBus and is always recreated after a flush, so there
 * is no need for an immutable merge (mergeChanges) that copies the arrays every time. With
 * immutable copies, stacking N changes in one transaction costs O(N^2) in total, which made
 * bulk import (draw.load) quadratic. Destructive appending costs an amortized O(1) per entry,
 * so the whole accumulation stays within O(N).
 *
 * layers.updated / groups.updated are folded into one entry per identical ID. Updates to the
 * same container happen many times within a single flush (layer.order changes every time one
 * feature is created), while each entry holds a full-length snapshot of order / featureIds.
 * Without folding, the amount retained in one transaction becomes O(N^2) and a bulk import
 * reaches the heap limit. A folded entry keeps previous as the first state and layer/group as
 * the last state, so as the diff of a single flush it means the same as before folding.
 */

import type { Group, Layer, StoreChange, UpdateSource } from '../types.js';

export type StoreListener = (changes: StoreChange) => void;

type LayerUpdate = NonNullable<NonNullable<StoreChange['layers']>['updated']>[number];
type GroupUpdate = NonNullable<NonNullable<StoreChange['groups']>['updated']>[number];

/** Position of the entry for the same ID (for layers / groups respectively) */
interface UpdateIndex {
  readonly layers: Map<string, number>;
  readonly groups: Map<string, number>;
}

/**
 * Appends changes destructively to target. Array categories (created/updated/deleted, etc.)
 * are concatenated with push, and single-value categories (orderChanged/selection/mode, etc.)
 * are overwritten. The final result matches mergeChanges (the immutable version), but target
 * is not recreated every time.
 */
// If an existing array is given, push into it destructively; otherwise create and return a new
// array. The caller only assigns the result (avoiding nested assignment expressions for lint).
function appendField<T>(existing: T[] | undefined, items: T[]): T[] {
  if (existing) {
    existing.push(...items);
    return existing;
  }
  return [...items];
}

/**
 * Appends update entries while folding those with the same ID into one entry. If an entry
 * already exists, only the current value is replaced while previous (the first state) is kept.
 */
function appendLayerUpdates(
  existing: LayerUpdate[] | undefined,
  items: LayerUpdate[],
  index: Map<string, number>,
): LayerUpdate[] {
  const list = existing ?? [];
  for (const item of items) {
    const at = index.get(item.id);
    if (at === undefined) {
      index.set(item.id, list.length);
      list.push(item);
    } else {
      list[at] = { id: item.id, layer: item.layer, previous: list[at].previous };
    }
  }
  return list;
}

function appendGroupUpdates(
  existing: GroupUpdate[] | undefined,
  items: GroupUpdate[],
  index: Map<string, number>,
): GroupUpdate[] {
  const list = existing ?? [];
  for (const item of items) {
    const at = index.get(item.id);
    if (at === undefined) {
      index.set(item.id, list.length);
      list.push(item);
    } else {
      list[at] = { id: item.id, group: item.group, previous: list[at].previous };
    }
  }
  return list;
}

function appendChanges(target: StoreChange, changes: StoreChange, index: UpdateIndex): void {
  // features
  if (changes.features) {
    if (!target.features) target.features = {};
    const t = target.features;
    if (changes.features.created) t.created = appendField(t.created, changes.features.created);
    if (changes.features.updated) t.updated = appendField(t.updated, changes.features.updated);
    if (changes.features.deleted) t.deleted = appendField(t.deleted, changes.features.deleted);
  }

  // layers
  if (changes.layers) {
    if (!target.layers) target.layers = {};
    const t = target.layers;
    if (changes.layers.created) t.created = appendField(t.created, changes.layers.created);
    if (changes.layers.updated) {
      t.updated = appendLayerUpdates(t.updated, changes.layers.updated, index.layers);
    }
    if (changes.layers.deleted) t.deleted = appendField(t.deleted, changes.layers.deleted);
    if (changes.layers.orderChanged) t.orderChanged = changes.layers.orderChanged;
  }

  // groups
  if (changes.groups) {
    if (!target.groups) target.groups = {};
    const t = target.groups;
    if (changes.groups.created) t.created = appendField(t.created, changes.groups.created);
    if (changes.groups.updated) {
      t.updated = appendGroupUpdates(t.updated, changes.groups.updated, index.groups);
    }
    if (changes.groups.deleted) t.deleted = appendField(t.deleted, changes.groups.deleted);
  }

  // layerReorder / groupReorder (dedicated, overwritten)
  if (changes.layerReorder) target.layerReorder = changes.layerReorder;
  if (changes.groupReorder) target.groupReorder = changes.groupReorder;

  // selection (overwritten)
  if (changes.selection) target.selection = changes.selection;

  // editing
  if (changes.editing) {
    if (!target.editing) target.editing = {};
    const t = target.editing;
    if (changes.editing.started) t.started = appendField(t.started, changes.editing.started);
    if (changes.editing.ended) t.ended = appendField(t.ended, changes.editing.ended);
  }

  // tentative / mode / metadata (overwritten)
  if (changes.tentative) target.tentative = changes.tentative;
  if (changes.mode) target.mode = changes.mode;
  if (changes.uiStateChanged) target.uiStateChanged = true;
  if (changes.metadata) target.metadata = changes.metadata;
}

export class ChangeBus {
  readonly #listeners = new Set<StoreListener>();
  readonly #beforeFlush: (() => void) | undefined;
  #transactionDepth = 0;
  #pendingChanges: StoreChange = {};
  #currentSource: UpdateSource = 'local';
  #updateIndex: UpdateIndex = { layers: new Map(), groups: new Map() };

  /**
   * @param beforeFlush Called when the outermost operation is about to notify, before the
   *   listeners (MemoryStore freezes the objects it built during the flush here)
   */
  constructor(beforeFlush?: () => void) {
    this.#beforeFlush = beforeFlush;
  }

  subscribe(listener: StoreListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /**
   * Runs fn inside a transaction. Nesting is supported, and pendingChanges is flushed to the
   * listeners at the moment the outermost transact finishes.
   *
   * Not atomic: when fn throws, what it changed before the throw is flushed like any other
   * change and the exception propagates.
   */
  transact<T>(fn: () => T, source: UpdateSource = 'local'): T {
    const wasInTransaction = this.#transactionDepth > 0;
    this.#transactionDepth++;

    // Set source only for the outermost transaction
    if (!wasInTransaction) {
      this.#currentSource = source;
    }

    try {
      return fn();
    } finally {
      this.#transactionDepth--;
      if (this.#transactionDepth === 0) {
        this.#flushChanges();
        this.#currentSource = 'local';
      }
    }
  }

  /**
   * Merges the changes into pendingChanges. Flushes immediately if outside a transaction.
   */
  merge(changes: StoreChange): void {
    appendChanges(this.#pendingChanges, changes, this.#updateIndex);
    if (this.#transactionDepth === 0) {
      this.#flushChanges();
    }
  }

  /** Whether an update entry for this layer is already stacked within the same flush */
  hasPendingLayerUpdate(id: string): boolean {
    return this.#updateIndex.layers.has(id);
  }

  /** Whether an update entry for this group is already stacked within the same flush */
  hasPendingGroupUpdate(id: string): boolean {
    return this.#updateIndex.groups.has(id);
  }

  /**
   * Stacks one layers.updated entry.
   *
   * Since folding leaves only the "first state" as previous, when hasPendingLayerUpdate is
   * true the caller may pass undefined instead of building one (the existing entry's previous
   * is used as is). When there is no entry, undefined means the state before and after the
   * change is the same, so layer itself is used.
   */
  mergeLayerUpdate(layer: Layer, previous: Layer | undefined): void {
    this.merge({ layers: { updated: [{ id: layer.id, layer, previous: previous ?? layer }] } });
  }

  /** Stacks one groups.updated entry (previous is handled as in mergeLayerUpdate) */
  mergeGroupUpdate(group: Group, previous: Group | undefined): void {
    this.merge({ groups: { updated: [{ id: group.id, group, previous: previous ?? group }] } });
  }

  #flushChanges(): void {
    this.#beforeFlush?.();
    if (Object.keys(this.#pendingChanges).length === 0) return;

    const changes: StoreChange = this.#pendingChanges;
    changes.source = this.#currentSource;
    // Swap in a new container for the next accumulation (the flushed object is retained by the
    // listeners, so always recreate it so that appends do not pollute it).
    this.#pendingChanges = {};
    this.#updateIndex = { layers: new Map(), groups: new Map() };

    // Every listener gets the notification: one that throws is reported and the others still
    // run, so the Store and its subscribers (rendering, the mode manager, the spatial index, a
    // history) never drift apart because of another subscriber's bug.
    for (const listener of [...this.#listeners]) {
      try {
        listener(changes);
      } catch (error) {
        console.error('Error in a store listener:', error);
      }
    }
  }
}
