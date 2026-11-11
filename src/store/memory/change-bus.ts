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
 *
 * A transaction whose writes go on over several tasks (a restore of many rows written in steps)
 * holds its notification (`hold`): the outermost transaction ends without it, the steps add to it
 * (`continueHeld`), and it goes out once, with the source of the transaction, when the hold is
 * let go of (`release`). Anything else that comes meanwhile (an outermost transaction, a change
 * merged outside one) first has the held writes finished (`finish`), so the notifications keep
 * the order of the writes.
 */

import { asFeatureValues } from '../../shared/feature-values.js';
import type {
  Group,
  Layer,
  LayerRowsChange,
  RowField,
  RowsChange,
  RowValues,
  StoreChange,
  UpdateSource,
} from '../types.js';

export type StoreListener = (changes: StoreChange) => void;

type LayerUpdate = NonNullable<NonNullable<StoreChange['layers']>['updated']>[number];
type GroupUpdate = NonNullable<NonNullable<StoreChange['groups']>['updated']>[number];

/** Position of the entry for the same ID (for layers / groups respectively) */
interface UpdateIndex {
  readonly layers: Map<string, number>;
  readonly groups: Map<string, number>;
  /**
   * The rows written by the transaction, by layer, folded as they come (made into the arrays of
   * the notification when it is flushed): folding the arrays at each write would take time in
   * the square of the writes of a transaction (a layer deleted a batch of rows at a time)
   */
  readonly rows: Map<string, RowsFold>;
}

/** The rows of a layer written by a transaction, being folded */
interface RowsFold {
  /**
   * The writes as they came, while every one of them only created rows (null once one did more):
   * folding them is joining them, so no set is made (a large write of new rows, as the rows of
   * blocks put in the tables, goes through as it is)
   */
  parts: LayerRowsChange[] | null;
  /** The rows folded in sets (null while the writes are kept as they came) */
  sets: RowsSets | null;
}

/** The rows of a layer written by a transaction, folded in sets */
interface RowsSets {
  readonly created: Set<number>;
  readonly updated: Set<number>;
  readonly deleted: Set<number>;
  readonly fields: Set<RowField>;
  readonly styleKeys: Set<string>;
  /** Whether it holds one write as it came (folded with the next one in full, as two are) */
  single: boolean;
}

/** Whether a write of the rows of a layer only created rows */
function onlyCreates(change: LayerRowsChange): boolean {
  return change.updated.length === 0 && change.deleted.length === 0;
}

/** The sets of the first write of a layer */
function setsOf(change: LayerRowsChange): RowsSets {
  return {
    created: new Set(change.created),
    updated: new Set(change.updated),
    deleted: new Set(change.deleted),
    fields: new Set(change.fields),
    styleKeys: new Set(change.styleKeys),
    single: true,
  };
}

/** A row created and deleted within the folds dropped, a row created or deleted not updated */
function settleRow(fold: RowsSets, handle: number): void {
  if (fold.created.has(handle) && fold.deleted.has(handle)) {
    fold.created.delete(handle);
    fold.deleted.delete(handle);
    fold.updated.delete(handle);
  } else if (fold.updated.has(handle) && (fold.created.has(handle) || fold.deleted.has(handle))) {
    fold.updated.delete(handle);
  }
}

/** Folds a write of the rows of a layer into the sets of the ones before */
function foldIntoSets(fold: RowsSets, next: LayerRowsChange): void {
  for (const handle of next.created) fold.created.add(handle);
  for (const handle of next.deleted) fold.deleted.add(handle);
  for (const handle of next.updated) fold.updated.add(handle);
  for (const field of next.fields) fold.fields.add(field);
  for (const key of next.styleKeys) fold.styleKeys.add(key);
  if (fold.single) {
    // The first write is settled with the second, every row of both
    fold.single = false;
    for (const handle of [...fold.deleted]) settleRow(fold, handle);
    for (const handle of [...fold.updated]) settleRow(fold, handle);
    return;
  }
  for (const handle of next.created) settleRow(fold, handle);
  for (const handle of next.deleted) settleRow(fold, handle);
  for (const handle of next.updated) settleRow(fold, handle);
}

/**
 * Folds the rows written by a write of a transaction into the ones before (the same as
 * `mergeRowsChanges` of the writes two by two, in time linear in the rows of the write)
 */
function foldRows(folds: Map<string, RowsFold>, change: RowsChange): void {
  for (const [layerId, next] of change.layers) {
    const fold = folds.get(layerId);
    if (!fold) {
      folds.set(
        layerId,
        onlyCreates(next) ? { parts: [next], sets: null } : { parts: null, sets: setsOf(next) },
      );
      continue;
    }
    if (fold.parts) {
      if (onlyCreates(next)) {
        fold.parts.push(next);
        continue;
      }
      // A write that does more: the writes before are folded in sets as they came, then this one
      const parts = fold.parts;
      const sets = setsOf(parts[0]);
      for (let k = 1; k < parts.length; k++) foldIntoSets(sets, parts[k]);
      fold.parts = null;
      fold.sets = sets;
    }
    foldIntoSets(fold.sets as RowsSets, next);
  }
}

/**
 * The rows of arrays joined, each once, in the order they first come (what an array of a set of
 * them gives): joined as they are when a sorted copy shows no row twice (the rows a write creates
 * are new), through a set otherwise
 */
function joinRows(arrays: readonly Int32Array[]): Int32Array {
  let total = 0;
  for (const array of arrays) total += array.length;
  const out = new Int32Array(total);
  let at = 0;
  for (const array of arrays) {
    out.set(array, at);
    at += array.length;
  }
  const sorted = out.slice().sort();
  let twice = false;
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] === sorted[i - 1]) {
      twice = true;
      break;
    }
  }
  if (!twice) return out;
  const set = new Set<number>();
  for (let i = 0; i < out.length; i++) set.add(out[i]);
  return Int32Array.from(set);
}

/** The rows of the folds, as the notification has them */
function rowsOfFolds(folds: ReadonlyMap<string, RowsFold>): RowsChange {
  const layers = new Map<string, LayerRowsChange>();
  for (const [layerId, fold] of folds) {
    if (fold.parts) {
      const fields = new Set<RowField>();
      const styleKeys = new Set<string>();
      for (const part of fold.parts) {
        for (const field of part.fields) fields.add(field);
        for (const key of part.styleKeys) styleKeys.add(key);
      }
      layers.set(layerId, {
        created: joinRows(fold.parts.map((part) => part.created)),
        updated: new Int32Array(0),
        deleted: new Int32Array(0),
        fields,
        styleKeys,
      });
      continue;
    }
    const sets = fold.sets as RowsSets;
    layers.set(layerId, {
      created: Int32Array.from(sets.created),
      updated: Int32Array.from(sets.updated),
      deleted: Int32Array.from(sets.deleted),
      fields: sets.fields,
      styleKeys: sets.styleKeys,
    });
  }
  return { layers };
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

/**
 * Folds the rows written by two changes of a transaction: one entry per row, a row created and
 * deleted within the transaction dropped
 */
export function mergeRowsChanges(a: RowsChange, b: RowsChange): RowsChange {
  const layers = new Map<string, LayerRowsChange>(a.layers);
  for (const [layerId, next] of b.layers) {
    const before = layers.get(layerId);
    if (!before) {
      layers.set(layerId, next);
      continue;
    }
    const created = new Set([...before.created, ...next.created]);
    const deleted = new Set([...before.deleted, ...next.deleted]);
    const updated = new Set([...before.updated, ...next.updated]);
    for (const handle of [...deleted]) {
      if (!created.has(handle)) continue;
      created.delete(handle);
      deleted.delete(handle);
      updated.delete(handle);
    }
    for (const handle of [...updated]) {
      if (created.has(handle) || deleted.has(handle)) updated.delete(handle);
    }
    layers.set(layerId, {
      created: Int32Array.from(created),
      updated: Int32Array.from(updated),
      deleted: Int32Array.from(deleted),
      fields: new Set<RowField>([...before.fields, ...next.fields]),
      styleKeys: new Set([...before.styleKeys, ...next.styleKeys]),
    });
  }
  return { layers };
}

/**
 * The values before of two writes of a transaction: the rows of both, a row with the values it had
 * before the first write of it (a field the first did not read is read in the second)
 */
function mergeSnapshots(a: RowValues, b: RowValues): RowValues {
  const rowsOf = (snapshot: RowValues) =>
    new Map(Array.from(snapshot.handles, (handle, i) => [handle, i]));
  const ra = rowsOf(a);
  const rb = rowsOf(b);
  const handles = [...a.handles, ...Array.from(b.handles).filter((handle) => !ra.has(handle))];
  const fields = new Map<RowField, unknown[]>();
  for (const field of new Set([...a.fields.keys(), ...b.fields.keys()])) {
    fields.set(
      field,
      handles.map((handle) => {
        const i = ra.get(handle);
        if (i !== undefined && a.fields.has(field)) return a.fields.get(field)?.[i];
        const j = rb.get(handle);
        return j !== undefined ? b.fields.get(field)?.[j] : undefined;
      }),
    );
  }
  const deleted =
    a.deleted || b.deleted
      ? Uint8Array.from(handles, (handle) => {
          const i = ra.get(handle);
          if (i !== undefined && a.deleted) return a.deleted[i];
          const j = rb.get(handle);
          return j !== undefined && b.deleted ? b.deleted[j] : 0;
        })
      : undefined;
  return { handles: Int32Array.from(handles), fields, ...(deleted && { deleted }) };
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

  // order: the moves in the order they were made (appended, so that every one is undone)
  if (changes.order) target.order = appendField(target.order, changes.order);
  // What keeps the rows deleted: one per transaction, the first given
  if (changes.restoreToken !== undefined && target.restoreToken === undefined)
    target.restoreToken = changes.restoreToken;

  // selection: the last one, with the one before the transaction (the first before), as the
  // updates of a layer or a group keep their first state
  if (changes.selection) {
    const first = target.selection;
    if (!first) {
      target.selection = changes.selection;
    } else {
      const { previousType, previousIds, previousBulk } = first;
      const { previousBulk: _ignored, ...latest } = changes.selection;
      target.selection = {
        ...latest,
        previousType,
        previousIds,
        ...(previousBulk && { previousBulk }),
      };
    }
  }

  // editing
  if (changes.editing) {
    if (!target.editing) target.editing = {};
    const t = target.editing;
    if (changes.editing.started) t.started = appendField(t.started, changes.editing.started);
    if (changes.editing.ended) t.ended = appendField(t.ended, changes.editing.ended);
  }

  // mode / metadata (overwritten)
  if (changes.mode) target.mode = changes.mode;
  if (changes.uiStateChanged) target.uiStateChanged = true;
  if (changes.reset === true) target.reset = true;
  if (changes.metadata) target.metadata = changes.metadata;

  // rows held as columns (one entry per row): folded in the index, made at the flush
  if (changes.rows) foldRows(index.rows, changes.rows);
  // the values the rows had before (a row with the values before the first write of it)
  if (changes.previousValues) {
    // A Store of rows gives values of rows
    target.previousValues = target.previousValues
      ? asFeatureValues(
          mergeSnapshots(
            target.previousValues as unknown as RowValues,
            changes.previousValues as unknown as RowValues,
          ),
        )
      : changes.previousValues;
  }

  // files
  if (changes.files) {
    if (!target.files) target.files = {};
    const t = target.files;
    if (changes.files.created) t.created = appendField(t.created, changes.files.created);
    if (changes.files.deleted) t.deleted = appendField(t.deleted, changes.files.deleted);
  }
}

export class ChangeBus {
  readonly #listeners = new Set<StoreListener>();
  readonly #beforeFlush: (() => StoreChange | undefined) | undefined;
  #transactionDepth = 0;
  #pendingChanges: StoreChange = {};
  #currentSource: UpdateSource = 'local';
  #updateIndex: UpdateIndex = { layers: new Map(), groups: new Map(), rows: new Map() };
  /** The notification held for writes over several tasks: what finishes them, and its source */
  #hold: { readonly finish: () => void; readonly source: UpdateSource } | null = null;
  /** Whether the held writes are being finished (what comes meanwhile is part of them) */
  #finishing = false;
  /** Called once a notification has gone to every listener (see `setAfterFlush`) */
  #afterFlush: ((changes: StoreChange) => void) | null = null;

  /**
   * @param beforeFlush Called when the outermost operation is about to notify, before the
   *   listeners (MemoryStore freezes the objects it built during the flush here); the changes it
   *   returns are added to the notification
   */
  constructor(beforeFlush?: () => StoreChange | undefined) {
    this.#beforeFlush = beforeFlush;
  }

  subscribe(listener: StoreListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /**
   * Sets what is called once a notification has gone to every listener (null for nothing). It is
   * called outside the guard of the listeners, so what it throws reaches the write or the
   * transaction that ended, after the bus is ready for the next one
   */
  setAfterFlush(fn: ((changes: StoreChange) => void) | null): void {
    this.#afterFlush = fn;
  }

  /** The source of the outermost transaction being run ('local' outside one) */
  get source(): UpdateSource {
    return this.#currentSource;
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
    // Another transaction comes after the held writes, finished first
    if (!wasInTransaction) this.#finishHeld();
    this.#transactionDepth++;

    // Set source only for the outermost transaction (the held one's, while it is finished)
    if (!wasInTransaction) {
      this.#currentSource = this.#hold?.source ?? source;
    }

    try {
      return fn();
    } finally {
      this.#transactionDepth--;
      if (this.#transactionDepth === 0) {
        try {
          if (!this.#hold) this.#flushChanges();
        } finally {
          this.#currentSource = 'local';
        }
      }
    }
  }

  /**
   * Merges the changes into pendingChanges. Flushes immediately if outside a transaction.
   */
  merge(changes: StoreChange): void {
    if (this.#transactionDepth === 0) this.#finishHeld();
    appendChanges(this.#pendingChanges, changes, this.#updateIndex);
    if (this.#transactionDepth === 0 && !this.#hold) {
      this.#flushChanges();
    }
  }

  /**
   * Holds the notification of the transaction under way (called inside it): it is not flushed
   * when the transaction ends, but when `release` is called. `finish` writes the rest of what the
   * transaction goes on writing, and calls `release`: it is called when anything else comes first
   */
  hold(finish: () => void): void {
    this.#hold = { finish, source: this.#currentSource };
  }

  /** Whether a notification is held */
  get held(): boolean {
    return this.#hold !== null;
  }

  /**
   * Runs a write of the held transaction in a later task: added to its notification, with its
   * source, nothing finished (flushed when it lets go of the notification)
   */
  continueHeld<T>(fn: () => T): T {
    const hold = this.#hold;
    if (!hold) return this.transact(fn);
    const wasInTransaction = this.#transactionDepth > 0;
    this.#transactionDepth++;
    if (!wasInTransaction) this.#currentSource = hold.source;
    try {
      return fn();
    } finally {
      this.#transactionDepth--;
      if (this.#transactionDepth === 0) {
        try {
          // Let go of within it: flushed with its source
          if (!this.#hold) {
            this.#currentSource = hold.source;
            this.#flushChanges();
          }
        } finally {
          this.#currentSource = 'local';
        }
      }
    }
  }

  /**
   * Lets go of the notification held: flushed now outside a transaction, with the transaction it
   * is in otherwise
   */
  release(): void {
    const hold = this.#hold;
    if (!hold) return;
    this.#hold = null;
    if (this.#transactionDepth > 0) return;
    this.#currentSource = hold.source;
    try {
      this.#flushChanges();
    } finally {
      this.#currentSource = 'local';
    }
  }

  /** Finishes the held writes (once; what they bring meanwhile is part of them) */
  #finishHeld(): void {
    const hold = this.#hold;
    if (!hold || this.#finishing) return;
    this.#finishing = true;
    try {
      hold.finish();
    } finally {
      this.#finishing = false;
    }
    // A finish that did not let go of the notification: let go of here
    if (this.#hold === hold) this.release();
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
    const added = this.#beforeFlush?.();
    if (added) appendChanges(this.#pendingChanges, added, this.#updateIndex);
    if (this.#updateIndex.rows.size > 0) {
      this.#pendingChanges.rows = rowsOfFolds(this.#updateIndex.rows);
    }
    if (Object.keys(this.#pendingChanges).length === 0) return;

    const changes: StoreChange = this.#pendingChanges;
    changes.source = this.#currentSource;
    // Swap in a new container for the next accumulation (the flushed object is retained by the
    // listeners, so always recreate it so that appends do not pollute it).
    this.#pendingChanges = {};
    this.#updateIndex = { layers: new Map(), groups: new Map(), rows: new Map() };

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
    this.#afterFlush?.(changes);
  }
}
