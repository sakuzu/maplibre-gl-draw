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
 * A notification tells what the transaction did to each feature, layer, group and row as a whole,
 * by what was there before it and what is there after it. One deleted and created again with the
 * same ID (the same handle for a row) was there before and is there after: it is told as updated,
 * from what it was before the transaction to what it is after. One created and deleted again was
 * there neither before nor after: it is not told. The order of the writes decides which: the
 * deletions are noted with how far the creations and the updates had gone when they came
 * (`DeletionMarks`), and the rows are folded write by write.
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

/**
 * The deletions of a kind (features, layers or groups) of a transaction, two numbers for each
 * entry of its `deleted`, in their order: how many entries `created` and `updated` had when it
 * came. They tell, for one deleted and created again within the transaction, which came first,
 * and which updates came before its first deletion and after its last creation.
 */
interface DeletionMarks {
  readonly features: number[];
  readonly layers: number[];
  readonly groups: number[];
  /**
   * The IDs one change merged both created and deleted, by kind: the order of the two is not
   * known, so they are told as they came
   */
  readonly unordered: { features: Set<string>; layers: Set<string>; groups: Set<string> };
}

/** Position of the entry for the same ID (for layers / groups respectively) */
interface UpdateIndex {
  readonly layers: Map<string, number>;
  readonly groups: Map<string, number>;
  readonly deletions: DeletionMarks;
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

/**
 * The rows of a layer written by a transaction, folded in sets: each row in one of them at most,
 * by what the transaction did to it as a whole (created: not there before, there after; updated:
 * there before and after; deleted: there before, not after)
 */
interface RowsSets {
  readonly created: Set<number>;
  readonly updated: Set<number>;
  readonly deleted: Set<number>;
  readonly fields: Set<RowField>;
  readonly changedKeys: Set<string>;
}

/** Whether a write of the rows of a layer only created rows */
function onlyCreates(change: LayerRowsChange): boolean {
  return change.updated.length === 0 && change.deleted.length === 0;
}

/** No rows folded yet */
function emptySets(): RowsSets {
  return {
    created: new Set(),
    updated: new Set(),
    deleted: new Set(),
    fields: new Set(),
    changedKeys: new Set(),
  };
}

/**
 * Folds a write of the rows of a layer into the sets of the writes before it, row by row in the
 * order of the writes: a row created and deleted again was never there (dropped); a row deleted
 * and created again was there before and is there after (updated), in this layer, or in another
 * one it was deleted from (`elsewhere` takes it from the rows deleted there: it moved here)
 */
function foldIntoSets(
  fold: RowsSets,
  next: LayerRowsChange,
  elsewhere?: (handle: number) => boolean,
): void {
  for (const field of next.fields) fold.fields.add(field);
  for (const key of next.changedKeys) fold.changedKeys.add(key);
  for (const handle of next.deleted) {
    fold.updated.delete(handle);
    if (!fold.created.delete(handle)) fold.deleted.add(handle);
  }
  for (const handle of next.created) {
    if (fold.created.has(handle) || fold.updated.has(handle)) continue;
    if (fold.deleted.delete(handle) || elsewhere?.(handle)) fold.updated.add(handle);
    else fold.created.add(handle);
  }
  for (const handle of next.updated) {
    if (!fold.created.has(handle) && !fold.deleted.has(handle)) fold.updated.add(handle);
  }
}

/**
 * The rows deleted by the folds of the layers other than one, those that deleted any: a row one of
 * them deleted that a write creates in this layer moved here
 */
function deletedElsewhere(folds: ReadonlyMap<string, RowsFold>, layerId: string): Set<number>[] {
  const out: Set<number>[] = [];
  for (const [otherId, other] of folds) {
    const deleted = other.sets?.deleted;
    if (otherId !== layerId && deleted && deleted.size > 0) out.push(deleted);
  }
  return out;
}

/** Takes a row from the rows deleted elsewhere: true when one of them had it */
function takeFrom(deleted: readonly Set<number>[]): ((handle: number) => boolean) | undefined {
  if (deleted.length === 0) return undefined;
  return (handle) => deleted.some((set) => set.delete(handle));
}

/** Whether a write creates a row deleted elsewhere */
function revives(next: LayerRowsChange, deleted: readonly Set<number>[]): boolean {
  if (deleted.length === 0) return false;
  for (const handle of next.created) if (deleted.some((set) => set.has(handle))) return true;
  return false;
}

/**
 * Folds the rows written by a write of a transaction into the ones before (the same as
 * `mergeRowsChanges` of the writes two by two, in time linear in the rows of the write)
 */
function foldRows(folds: Map<string, RowsFold>, change: RowsChange): void {
  for (const [layerId, next] of change.layers) {
    const fold = folds.get(layerId);
    const others = deletedElsewhere(folds, layerId);
    // Writes that only create new rows are kept as they came
    const kept = onlyCreates(next) && !revives(next, others);
    const elsewhere = takeFrom(others);
    if (!fold) {
      if (kept) {
        folds.set(layerId, { parts: [next], sets: null });
      } else {
        const sets = emptySets();
        foldIntoSets(sets, next, elsewhere);
        folds.set(layerId, { parts: null, sets });
      }
      continue;
    }
    if (fold.parts) {
      if (kept) {
        fold.parts.push(next);
        continue;
      }
      // A write that does more: the writes before are folded in sets as they came, then this one
      const sets = emptySets();
      for (const part of fold.parts) foldIntoSets(sets, part);
      fold.parts = null;
      fold.sets = sets;
    }
    foldIntoSets(fold.sets as RowsSets, next, elsewhere);
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
      const changedKeys = new Set<string>();
      for (const part of fold.parts) {
        for (const field of part.fields) fields.add(field);
        for (const key of part.changedKeys) changedKeys.add(key);
      }
      layers.set(layerId, {
        created: joinRows(fold.parts.map((part) => part.created)),
        updated: new Int32Array(0),
        deleted: new Int32Array(0),
        fields,
        changedKeys,
      });
      continue;
    }
    const sets = fold.sets as RowsSets;
    layers.set(layerId, {
      created: Int32Array.from(sets.created),
      updated: Int32Array.from(sets.updated),
      deleted: Int32Array.from(sets.deleted),
      fields: sets.fields,
      changedKeys: sets.changedKeys,
    });
  }
  return { layers };
}

/**
 * Appends changes destructively to target. Array categories (created/updated/deleted, etc.)
 * are concatenated with push, and single-value categories (selection/mode, etc.) are
 * overwritten. The change of the order of the layers and of the metadata keeps the value before
 * the transaction (`previous` of the first) with the value after it (of the last). The final result matches mergeChanges (the immutable version), but target
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
 * Folds the rows written by two changes of a transaction: one entry per row, by what the two did
 * to it as a whole (see `foldIntoSets`): a row created and deleted within the transaction dropped,
 * a row deleted and created again updated
 */
export function mergeRowsChanges(a: RowsChange, b: RowsChange): RowsChange {
  const folds = new Map<string, RowsFold>();
  for (const [layerId, before] of a.layers) {
    const sets = emptySets();
    foldIntoSets(sets, before);
    folds.set(layerId, { parts: null, sets });
  }
  for (const [layerId, next] of b.layers) {
    let fold = folds.get(layerId);
    if (!fold) {
      fold = { parts: null, sets: emptySets() };
      folds.set(layerId, fold);
    }
    foldIntoSets(fold.sets as RowsSets, next, takeFrom(deletedElsewhere(folds, layerId)));
  }
  return rowsOfFolds(folds);
}

/**
 * The values before of two writes of a transaction: the rows of both, a row with the values it had
 * before the first write of it (a field the first did not read is read in the second)
 */
function mergeSnapshots(a: RowValues, b: RowValues): RowValues {
  const rowsOf = (snapshot: RowValues) =>
    new Map(Array.from(snapshot.rows, (handle, i) => [handle, i]));
  const ra = rowsOf(a);
  const rb = rowsOf(b);
  const handles = [...a.rows, ...Array.from(b.rows).filter((handle) => !ra.has(handle))];
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
  return { rows: Int32Array.from(handles), fields, ...(deleted && { deleted }) };
}

/**
 * Notes deletions about to be appended to the entries of a kind: for each, how many entries its
 * `created` and `updated` have (see `DeletionMarks`); an ID the change also creates is noted as
 * one whose order is not known
 */
function markDeletions(
  marks: number[],
  unordered: Set<string>,
  entries: { created?: unknown[]; updated?: unknown[] },
  deleted: ReadonlyArray<{ readonly id: string }>,
  created: ReadonlyArray<{ readonly id: string }> | undefined,
): void {
  const createdCount = entries.created?.length ?? 0;
  const updatedCount = entries.updated?.length ?? 0;
  for (let i = 0; i < deleted.length; i++) marks.push(createdCount, updatedCount);
  if (created?.length) {
    const ids = new Set(deleted.map((entry) => entry.id));
    for (const entry of created) if (ids.has(entry.id)) unordered.add(entry.id);
  }
}

/** The positions of the entries of a list by their IDs, of the IDs `only` has (all without it) */
function positionsById(
  list: ReadonlyArray<{ readonly id: string }>,
  only?: ReadonlyMap<string, unknown>,
): Map<string, number[]> {
  const positions = new Map<string, number[]>();
  list.forEach((entry, i) => {
    if (only && !only.has(entry.id)) return;
    const known = positions.get(entry.id);
    if (known) known.push(i);
    else positions.set(entry.id, [i]);
  });
  return positions;
}

/**
 * The entries of a kind (features, layers or groups) of a transaction, each told once by what was
 * there before the transaction and what is there after it, when one was deleted and created again
 * within it: there before and after, updated (from what it was before the first write of it to
 * what it is after the last one); there before only, deleted (with the updates before its first
 * deletion); there after only, created (with the updates after its last creation); neither, not
 * told. The others are left as they are. Empty lists are taken away.
 */
function settleRecreated<T extends { readonly id: string }, U extends { readonly id: string }>(
  entries: { created?: T[]; updated?: U[]; deleted?: T[] },
  marks: readonly number[],
  unordered: ReadonlySet<string>,
  ends: {
    previous(update: U): T;
    value(update: U): T;
    update(id: string, value: T, previous: T): U;
  },
): boolean {
  const { created, deleted } = entries;
  if (!created?.length || !deleted?.length) return false;
  const deletedAt = positionsById(deleted);
  for (const id of unordered) deletedAt.delete(id);
  const createdAt = positionsById(created, deletedAt);
  if (createdAt.size === 0) return false;
  const updated = entries.updated ?? [];
  const updatedAt = positionsById(updated, createdAt);
  const dropCreated = new Set<number>();
  const dropUpdated = new Set<number>();
  const dropDeleted = new Set<number>();
  const added: U[] = [];
  for (const [id, creations] of createdAt) {
    const deletions = deletedAt.get(id) as number[];
    const updates = updatedAt.get(id) ?? [];
    const firstDeletion = deletions[0];
    const lastDeletion = deletions[deletions.length - 1];
    // There before: it was deleted before it was first created
    const before = creations[0] >= marks[2 * firstDeletion];
    const after = (before ? 1 : 0) + creations.length - deletions.length === 1;
    const updatesBefore = updates.filter((i) => i < marks[2 * firstDeletion + 1]);
    const updatesAfter = updates.filter((i) => i >= marks[2 * lastDeletion + 1]);
    for (const i of creations) dropCreated.add(i);
    for (const i of deletions) dropDeleted.add(i);
    for (const i of updates) dropUpdated.add(i);
    if (before && after) {
      const previous =
        updatesBefore.length > 0
          ? ends.previous(updated[updatesBefore[0]])
          : deleted[firstDeletion];
      const value =
        updatesAfter.length > 0
          ? ends.value(updated[updatesAfter[updatesAfter.length - 1]])
          : created[creations[creations.length - 1]];
      added.push(ends.update(id, value, previous));
    } else if (before) {
      dropDeleted.delete(firstDeletion);
      for (const i of updatesBefore) dropUpdated.delete(i);
    } else if (after) {
      dropCreated.delete(creations[creations.length - 1]);
      for (const i of updatesAfter) dropUpdated.delete(i);
    }
  }
  const keep = <V>(list: V[], drop: ReadonlySet<number>): V[] =>
    drop.size === 0 ? list : list.filter((_, i) => !drop.has(i));
  const nextCreated = keep(created, dropCreated);
  const nextDeleted = keep(deleted, dropDeleted);
  const nextUpdated = [...keep(updated, dropUpdated), ...added];
  if (nextCreated.length > 0) entries.created = nextCreated;
  else delete entries.created;
  if (nextDeleted.length > 0) entries.deleted = nextDeleted;
  else delete entries.deleted;
  if (nextUpdated.length > 0) entries.updated = nextUpdated;
  else delete entries.updated;
  return true;
}

/**
 * The features, layers and groups of a notification deleted and created again (or created and
 * deleted again) within its transaction, each told once (see `settleRecreated`); a kind left with
 * nothing is taken away
 */
function settleKinds(changes: StoreChange, marks: DeletionMarks): void {
  const { unordered } = marks;
  if (
    changes.features &&
    settleRecreated(changes.features, marks.features, unordered.features, {
      previous: (update) => update.previous,
      value: (update) => update.feature,
      update: (id, feature, previous) => ({ id, feature, previous }),
    }) &&
    Object.keys(changes.features).length === 0
  ) {
    delete changes.features;
  }
  if (
    changes.layers &&
    settleRecreated(changes.layers, marks.layers, unordered.layers, {
      previous: (update) => update.previous,
      value: (update) => update.layer,
      update: (id, layer, previous) => ({ id, layer, previous }),
    }) &&
    Object.keys(changes.layers).length === 0
  ) {
    delete changes.layers;
  }
  if (
    changes.groups &&
    settleRecreated(changes.groups, marks.groups, unordered.groups, {
      previous: (update) => update.previous,
      value: (update) => update.group,
      update: (id, group, previous) => ({ id, group, previous }),
    }) &&
    Object.keys(changes.groups).length === 0
  ) {
    delete changes.groups;
  }
}

function appendChanges(target: StoreChange, changes: StoreChange, index: UpdateIndex): void {
  // features
  if (changes.features) {
    if (!target.features) target.features = {};
    const t = target.features;
    if (changes.features.created) t.created = appendField(t.created, changes.features.created);
    if (changes.features.updated) t.updated = appendField(t.updated, changes.features.updated);
    if (changes.features.deleted) {
      const { deletions } = index;
      const { created, deleted } = changes.features;
      markDeletions(deletions.features, deletions.unordered.features, t, deleted, created);
      t.deleted = appendField(t.deleted, changes.features.deleted);
    }
  }

  // layers
  if (changes.layers) {
    if (!target.layers) target.layers = {};
    const t = target.layers;
    if (changes.layers.created) t.created = appendField(t.created, changes.layers.created);
    if (changes.layers.updated) {
      t.updated = appendLayerUpdates(t.updated, changes.layers.updated, index.layers);
    }
    if (changes.layers.deleted) {
      const { deletions } = index;
      const { created, deleted } = changes.layers;
      markDeletions(deletions.layers, deletions.unordered.layers, t, deleted, created);
      // An update after it (of one created again) is an entry of its own
      for (const layer of changes.layers.deleted) index.layers.delete(layer.id);
      t.deleted = appendField(t.deleted, changes.layers.deleted);
    }
    if (changes.layers.orderChanged) {
      // The order before the transaction (the first previous) and the order after it (the last)
      const { order } = changes.layers.orderChanged;
      t.orderChanged = t.orderChanged
        ? { order, previous: t.orderChanged.previous }
        : changes.layers.orderChanged;
    }
  }

  // groups
  if (changes.groups) {
    if (!target.groups) target.groups = {};
    const t = target.groups;
    if (changes.groups.created) t.created = appendField(t.created, changes.groups.created);
    if (changes.groups.updated) {
      t.updated = appendGroupUpdates(t.updated, changes.groups.updated, index.groups);
    }
    if (changes.groups.deleted) {
      const { deletions } = index;
      const { created, deleted } = changes.groups;
      markDeletions(deletions.groups, deletions.unordered.groups, t, deleted, created);
      for (const group of changes.groups.deleted) index.groups.delete(group.id);
      t.deleted = appendField(t.deleted, changes.groups.deleted);
    }
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

  // mode (overwritten)
  if (changes.mode) target.mode = changes.mode;
  if (changes.uiStateChanged) target.uiStateChanged = true;
  if (changes.reset === true) target.reset = true;
  // the IDs given other IDs: every pair, the last of an ID kept
  if (changes.reassigned) {
    target.reassigned = target.reassigned
      ? new Map([...target.reassigned, ...changes.reassigned])
      : changes.reassigned;
  }
  // metadata: the metadata before the transaction (the first previous) and after it (the last),
  // as the order of the layers
  if (changes.metadata) {
    target.metadata = target.metadata
      ? { metadata: changes.metadata.metadata, previous: target.metadata.previous }
      : changes.metadata;
  }

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

  // where the rows put elsewhere were (a row where it was before the first write of it)
  if (changes.placesBefore) {
    target.placesBefore = target.placesBefore
      ? mergeSnapshots(target.placesBefore, changes.placesBefore)
      : changes.placesBefore;
  }

  // files
  if (changes.files) {
    if (!target.files) target.files = {};
    const t = target.files;
    if (changes.files.created) t.created = appendField(t.created, changes.files.created);
    if (changes.files.deleted) t.deleted = appendField(t.deleted, changes.files.deleted);
  }
}

/** No entry of a transaction yet */
function newUpdateIndex(): UpdateIndex {
  return {
    layers: new Map(),
    groups: new Map(),
    deletions: {
      features: [],
      layers: [],
      groups: [],
      unordered: { features: new Set(), layers: new Set(), groups: new Set() },
    },
    rows: new Map(),
  };
}

export class ChangeBus {
  readonly #listeners = new Set<StoreListener>();
  readonly #beforeFlush: (() => StoreChange | undefined) | undefined;
  #transactionDepth = 0;
  #pendingChanges: StoreChange = {};
  #currentSource: UpdateSource = 'local';
  #updateIndex: UpdateIndex = newUpdateIndex();
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

  /** Whether a transaction is being run (a step of the held one included) */
  get inTransaction(): boolean {
    return this.#transactionDepth > 0;
  }

  /**
   * Finishes the held writes now, outside a transaction (a read that comes before them): nothing
   * inside one, where the held writes are the ones being made
   */
  finishHeld(): void {
    if (this.#transactionDepth === 0) this.#finishHeld();
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
    settleKinds(this.#pendingChanges, this.#updateIndex.deletions);
    if (this.#updateIndex.rows.size > 0) {
      this.#pendingChanges.rows = rowsOfFolds(this.#updateIndex.rows);
    }
    if (Object.keys(this.#pendingChanges).length === 0) return;

    const changes: StoreChange = this.#pendingChanges;
    changes.source = this.#currentSource;
    // Swap in a new container for the next accumulation (the flushed object is retained by the
    // listeners, so always recreate it so that appends do not pollute it).
    this.#pendingChanges = {};
    this.#updateIndex = newUpdateIndex();

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
