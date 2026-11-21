// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The bulk edits of an instance: edits of any number of features, each one operation written in
 * parts (see `FeaturesCollection`)
 *
 * - An edit takes the number of its operation from the Store, or the number of the transaction of
 *   `draw.transact` it is started in, whose change is then its first part. Each other part is one
 *   transaction of the layer over the Store with that number, written in a task of its own, so
 *   that the map draws between two parts. Every part but the last has `hasMoreParts: true`
 *   (turned on from inside the part, once it is known that rows are left); the last part is
 *   written even when it writes nothing, with `stopped: true` when the edit stops.
 * - A part is cut by time (`BULK_PART_BUDGET_MS`), the work of the listeners of its change
 *   included: the time the rows of a part took, with the listeners, gives the number of rows of
 *   the next part, and a part also ends once its writes alone have taken the budget. A part writes
 *   one row at least, however long it takes.
 * - An edit that writes several features at a time is given them in batches, the locked ones and
 *   the ones deleted meanwhile left out, and the clock is read after each batch. The first batch
 *   is small (`BULK_FIRST_BATCH`); each next one is as many rows as the time a row of the batch
 *   before took leaves in the budget of the part, at most twice the batch before and at most
 *   `BULK_BATCH_MAX`. A write of a few features that touches a feature first gives it a batch of
 *   its own.
 * - The target is read once, when the edit starts, as a copy of the references of its rows in
 *   typed arrays: no array of IDs, no feature per row. An ID that names nothing then is counted
 *   as missing; a row deleted afterwards leaves the target (the Store tells it), and is not
 *   counted; a locked feature stays as it is and is counted, when the edit starts or meanwhile.
 * - The edits of this client are written one at a time, in the order they were started. A write
 *   of a few features of this client does not wait: before it reads a feature to write it, or to
 *   make the values it writes (and, as a net, the layer before it writes the row of a feature),
 *   the edit being written is first applied to that feature alone. Outside a transaction, that is a transaction of its own, a
 *   part of the operation of the edit; inside one (the fn of `draw.transact`, or the transaction
 *   a write opened before it writes the row), it is written in that transaction. A change written
 *   to the Store directly is not held up: a later part reads the values the features have then.
 * - Read-only stops the edits: each writes its last part, with nothing in it and
 *   `stopped: true`. `destroy` writes that part for the edit being written, and then rejects
 *   every edit with `invalidState`; the edits waiting write nothing. In the fn of a
 *   `draw.transact`, that part is written once the transaction has closed, before
 *   `draw.transact` returns (a transaction of the Store has one number); in a transaction opened
 *   on the Store directly, it folds into that transaction and closes nothing, so that the
 *   operation stays open.
 * - A work may refuse when it is about to write for the first time (`prepare`): the edit then
 *   rejects, nothing of it is written, and a write of this client that touched one of its
 *   features goes on as if it had not been started. It may write besides its target in the
 *   transaction of the last part (`end`, stopped or not), give the IDs of the features it created
 *   (`EditCounts.createdIds`), and not be applied first (a deletion of layers: from its first
 *   part on, the layer refuses the other writes of this client to the layers it deletes).
 *
 * The edits hold their state per instance; nothing is kept at the level of the module.
 */

import type {
  BulkBatchWork,
  BulkEditStarter,
  BulkFeatureWork,
  BulkStartOptions,
  BulkWork,
  BulkWorkFactory,
  BulkWorkStart,
} from '../../operations/bulk-work.js';
import { countWork, type WorkCounts, workCountsOf } from '../../shared/work-counts.js';
import type { StoreChange as RowChange, Store as RowStore } from '../../store/built-in/types.js';
import type { InstanceDocument } from '../../store/document-access.js';
import type { UpdateSource } from '../../store/types.js';
import { DrawError } from '../errors.js';
import type { EditCounts, EditOptions, FeatureTarget } from '../features.js';
import type { IdSet } from '../model.js';
import { makeIdSet } from './id-set.js';
import { invalidInput, isRecord, locksIgnored, withLocksIgnored } from './shared.js';

/** The time of one part, the work of the listeners of its change included (ms) */
export const BULK_PART_BUDGET_MS = 50;

/** The features of the first batch of an edit that writes several features at a time */
export const BULK_FIRST_BATCH = 16;

/** The most features one batch of an edit that writes several features at a time is given */
export const BULK_BATCH_MAX = 1024;

/**
 * What one bulk edit does to each feature of its target, one feature at a time
 *
 * @internal
 */
export type BulkEditFeatureWork = BulkFeatureWork;

/**
 * What one bulk edit does to the features of its target, several at a time
 *
 * @internal
 */
export type BulkEditBatchWork = BulkBatchWork;

/**
 * What one bulk edit does to the features of its target
 *
 * @internal
 */
export type BulkEditWork = BulkWork;

/**
 * What the work of an edit is made from, once the target is read and the number of the operation
 * is taken
 *
 * @internal
 */
export type BulkEditStart = BulkWorkStart;

/**
 * Makes the work of an edit once it starts
 *
 * @throws What it throws is thrown by `BulkEdits.start`, and the edit does not start
 * @internal
 */
export type BulkEditWorkFactory = BulkWorkFactory;

/**
 * What the bulk edits are built with: the clock and the tasks, which a test replaces
 *
 * @internal
 */
export interface BulkEditsOptions {
  /** The time of one part (ms); `BULK_PART_BUDGET_MS` when left out */
  readonly budgetMs?: number;
  /** The clock of the budget (ms); `performance.now` when left out */
  readonly now?: () => number;
  /** Runs a function in a later task; `setTimeout` when left out */
  readonly schedule?: (fn: () => void) => void;
}

/**
 * The bulk edits of one instance
 *
 * @internal
 */
export interface BulkEdits extends BulkEditStarter {
  /**
   * Starts a bulk edit
   *
   * @returns A promise of what the edit did, once its last change has arrived; null at once when
   *   the document is read-only, every feature of the target is locked, or the edit refuses
   * @param work - The work, or the function that makes it once the target is read; it is not
   *   called when the edit resolves with null at once
   * @param startOptions - What the edit refuses, and how it counts the locks
   * @throws `DrawError` with the code `invalidInput` for a target or options of the wrong shape,
   *   or `invalidState` for a second edit started in the same `draw.transact`, or a source other
   *   than that of the `draw.transact` it is started in; what the function that makes the work
   *   throws
   */
  start(
    target: FeatureTarget,
    options: EditOptions | undefined,
    work: BulkEditWork | BulkEditWorkFactory,
    startOptions?: BulkStartOptions,
  ): Promise<EditCounts | null>;
  /**
   * Runs the outermost `draw.transact` of the instance: `run` opens its transaction, and calls
   * `endOfFn` at the end of `fn`, inside the transaction, so that an edit started in `fn` makes
   * the change of the transaction its first part. When `run` throws, the edit started in `fn`
   * does not start (its promise resolves with null)
   */
  inTransaction<T>(source: UpdateSource, ignoreLocks: boolean, run: (endOfFn: () => void) => T): T;
  /** Resolves once the edits started and not ended when it is called have ended */
  waitForWrites(): Promise<void>;
  /** Stops every edit: read-only was turned on */
  stopAll(): void;
  /** Ends every edit: the instance is destroyed */
  destroy(): void;
}

/** The counts of an edit as they grow */
interface Counts {
  changedCount: number;
  lockedCount: number;
  missingCount: number;
}

/** One bulk edit, from its start to its last change */
interface Edit {
  readonly operationId: number;
  readonly source: UpdateSource;
  readonly ignoreLocks: boolean;
  readonly work: BulkEditWork;
  /** The references of the rows of the target, in its order; -1 for one given again */
  readonly order: Int32Array;
  /** The same references, each once, in rising order */
  readonly sorted: Int32Array;
  /** The position in `order` of each reference of `sorted` */
  readonly places: Int32Array;
  /** The position in `order` of the next row a part writes */
  at: number;
  /** The rows a write of this client touched first, to which the edit was applied then */
  readonly early: Set<number>;
  /** The rows of the target deleted since the edit started */
  readonly gone: Set<number>;
  /** How many rows the next part writes at most */
  rowsPerPart: number;
  /** How many rows the last batch had (a work that writes several features at a time) */
  batchRows: number;
  /** The time a row of the last batch took (ms); NaN before the first batch */
  batchRowMs: number;
  readonly counts: Counts;
  /** Whether it waits for the transaction of `draw.transact` it was started in to end */
  inTransaction: boolean;
  /** Whether it stops at its next turn (read-only was turned on) */
  stopping: boolean;
  /** Whether its work was prepared (see `BulkWorkHooks.prepare`) */
  prepared: boolean;
  /** Whether the layers it deletes refuse the other writes of this client now */
  marking: boolean;
  readonly resolve: (counts: EditCounts | null) => void;
  readonly reject: (error: unknown) => void;
  /** Resolves when the edit has ended, however it ended */
  readonly ended: Promise<void>;
  readonly markEnded: () => void;
}

/** The `draw.transact` open, while its `fn` runs */
interface TransactionScope {
  readonly source: UpdateSource;
  readonly ignoreLocks: boolean;
  edit: Edit | null;
}

/** The error of an edit the destroy of the instance ends */
function destroyedError(): DrawError {
  return new DrawError(
    'invalidState',
    'The draw instance was destroyed while the edit was written',
  );
}

/** Whether a value is a set of IDs read through its methods */
function isIdSet(value: unknown): value is IdSet {
  if (typeof value !== 'object' || value === null) return false;
  const set = value as Record<string, unknown>;
  return (
    typeof set.count === 'function' &&
    typeof set.has === 'function' &&
    typeof set.iterate === 'function'
  );
}

/** Throws unless the value is an array of strings */
function requireStrings(value: unknown, what: string): readonly string[] {
  if (!Array.isArray(value) || value.some((id) => typeof id !== 'string')) {
    throw invalidInput(`${what} must be an array of strings`);
  }
  return value as readonly string[];
}

/** The position of a reference in references in rising order, or -1 */
function findSorted(sorted: Int32Array, ref: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < ref) lo = mid + 1;
    else hi = mid;
  }
  return lo < sorted.length && sorted[lo] === ref ? lo : -1;
}

/** Nothing: the body of a transaction that only carries its options */
const nothing = (): void => {};

/**
 * Makes the bulk edits of an instance
 *
 * @param layer - The layer over the Store of the instance, through which the edits write
 * @param store - The Store under it, whose tables the targets are read from
 * @internal
 */
export function createBulkEdits(
  layer: InstanceDocument,
  store: RowStore,
  options: BulkEditsOptions = {},
): BulkEdits {
  const { tables } = store;
  const counts: WorkCounts | undefined = workCountsOf(store);
  const budget = options.budgetMs ?? BULK_PART_BUDGET_MS;
  const now = options.now ?? (() => performance.now());
  const schedule = options.schedule ?? ((fn: () => void) => void setTimeout(fn, 0));

  /** The edits started and not ended, in the order they were started: the first is written */
  const queue: Edit[] = [];
  /** Whether a task that writes the next part is waiting */
  let waiting = false;
  /** Whether the edits write a part now (the writes of the layer then do not call back) */
  let writing = false;
  let destroyed = false;
  let scope: TransactionScope | null = null;
  /**
   * The edit being written when the instance was destroyed in the fn of `draw.transact`: its last
   * part is written once the transaction has closed
   */
  let closeAfterTransaction: Edit | null = null;
  let stopListening: (() => void) | null = null;

  // ==========================================================================
  // The target
  // ==========================================================================

  /** The references of the rows of IDs, and how many IDs named nothing (each once) */
  const refsOfIds = (
    ids: Iterable<string>,
    size: number,
  ): { refs: Int32Array; missing: number } => {
    const refs = new Int32Array(size);
    let count = 0;
    // The IDs that name nothing, each once: as many as they are, not as the target
    let missing: Set<string> | null = null;
    for (const id of ids) {
      const ref = typeof id === 'string' ? tables.getRowRef(id) : undefined;
      if (ref === undefined) {
        missing ??= new Set();
        missing.add(id);
      } else if (count < size) {
        refs[count++] = ref;
      }
    }
    countWork(counts, 'objectsCreated');
    return { refs: refs.subarray(0, count), missing: missing?.size ?? 0 };
  };

  /** The references of the rows of layers, and how many layer IDs named nothing */
  const refsOfLayers = (layerIds: readonly string[]): { refs: Int32Array; missing: number } => {
    const lists: Int32Array[] = [];
    let total = 0;
    let missing = 0;
    for (const layerId of new Set(layerIds)) {
      if (!store.getLayer(layerId)) {
        missing += 1;
        continue;
      }
      const table = tables.get(layerId);
      if (!table || table.rowCount === 0) continue;
      const refs = table.listRowRefs(0, table.rowCount);
      lists.push(refs);
      total += refs.length;
    }
    return { refs: joined(lists, total), missing };
  };

  /** The references of the rows of groups (each once) */
  const refsOfGroups = (groupIds: readonly string[]): { refs: Int32Array; missing: number } => {
    const lists: Int32Array[] = [];
    let total = 0;
    let missing = 0;
    for (const groupId of new Set(groupIds)) {
      const group = store.getGroup(groupId);
      const groupRef = tables.findGroup(groupId);
      const table = group ? tables.get(group.layerId) : undefined;
      if (!group || groupRef === undefined) {
        missing += 1;
        continue;
      }
      if (!table) continue;
      const refs = table.listGroupMembers(groupRef, 0, table.countGroupMembers(groupRef));
      lists.push(refs);
      total += refs.length;
    }
    return { refs: joined(lists, total), missing };
  };

  /** Lists of references one after another, in one array */
  const joined = (lists: readonly Int32Array[], total: number): Int32Array => {
    if (lists.length === 1) return lists[0];
    const out = new Int32Array(total);
    let at = 0;
    for (const list of lists) {
      out.set(list, at);
      at += list.length;
    }
    countWork(counts, 'objectsCreated', lists.length + 1);
    return out;
  };

  /** The types of the rows of references, read from the tables of their layers */
  const typesOf = (refs: Int32Array): Set<string> => {
    const types = new Set<string>();
    const views = store
      .listLayers()
      .map((base) => tables.get(base.id))
      .filter((view) => view !== undefined);
    for (let i = 0; i < refs.length; i++) {
      for (const view of views) {
        const type = view.getRowType(refs[i]);
        if (type !== null) {
          types.add(type);
          break;
        }
      }
    }
    return types;
  };

  /** The references of the rows of the features selected in this client */
  const refsOfSelection = (): { refs: Int32Array; missing: number } => {
    const selection = layer.getSelection();
    if (selection.type === 'layer') return refsOfLayers(selection.ids);
    if (selection.type === 'group') return refsOfGroups(selection.ids);
    return refsOfIds(selection.ids, selection.ids.length);
  };

  /** Reads a target once (throws `invalidInput` for one of the wrong shape) */
  const readTarget = (target: FeatureTarget): { refs: Int32Array; missing: number } => {
    if (Array.isArray(target)) {
      const ids = requireStrings(target, 'The target');
      return refsOfIds(ids, ids.length);
    }
    if (isIdSet(target)) return refsOfIds(target.iterate(), target.count());
    if (isRecord(target)) {
      const record: Record<string, unknown> = target;
      const keys = Object.keys(record);
      if (keys.length === 1 && keys[0] === 'selection' && record.selection === true) {
        return refsOfSelection();
      }
      if (keys.length === 1 && keys[0] === 'layerIds') {
        return refsOfLayers(requireStrings(record.layerIds, 'layerIds'));
      }
    }
    throw invalidInput(
      'The target must be an array of IDs, an IdSet, { selection: true } or { layerIds }',
    );
  };

  /**
   * The order of the references, with the ones given again marked -1, the references each once
   * in rising order, and the position in the order of each of them
   */
  const indexTarget = (
    refs: Int32Array,
  ): { order: Int32Array; sorted: Int32Array; places: Int32Array } => {
    const order = Int32Array.from(refs);
    const byRef = new Int32Array(order.length);
    for (let i = 0; i < byRef.length; i++) byRef[i] = i;
    byRef.sort((a, b) => order[a] - order[b] || a - b);
    const sorted = new Int32Array(order.length);
    const places = new Int32Array(order.length);
    let count = 0;
    for (let k = 0; k < byRef.length; k++) {
      const i = byRef[k];
      const ref = order[i];
      if (count > 0 && sorted[count - 1] === ref) {
        order[i] = -1;
        continue;
      }
      sorted[count] = ref;
      places[count] = i;
      count += 1;
    }
    countWork(counts, 'objectsCreated', 4);
    return { order, sorted: sorted.subarray(0, count), places: places.subarray(0, count) };
  };

  // ==========================================================================
  // The features
  // ==========================================================================

  /** Whether a feature is locked: itself, its group or its layer */
  const isLocked = (id: string): boolean => {
    const place = layer.getFeaturePlace(id);
    if (!place) return false;
    if (place.locked) return true;
    if (place.groupId !== undefined && store.getGroup(place.groupId)?.locked === true) return true;
    return store.getLayer(place.layerId)?.locked === true;
  };

  /** Whether every feature of a target is locked (false for a target of no feature) */
  const everyLocked = (order: Int32Array): boolean => {
    let any = false;
    for (let i = 0; i < order.length; i++) {
      const ref = order[i];
      if (ref < 0) continue;
      const id = tables.getRowId(ref);
      if (id === undefined) continue;
      if (!isLocked(id)) return false;
      any = true;
    }
    return any;
  };

  /** Writes the edit to one feature, whatever the work writes at a time */
  const writeOne = (work: BulkEditWork, id: string): boolean => {
    if (!('writeFeatures' in work)) return work.writeFeature(id);
    const changed = new Uint8Array(1);
    countWork(counts, 'objectsCreated', 2);
    work.writeFeatures([id], changed);
    return changed[0] === 1;
  };

  /** Applies the edit to one feature: a locked one stays as it is, and is counted */
  const visit = (edit: Edit, id: string): void => {
    if (!edit.ignoreLocks && isLocked(id)) {
      edit.counts.lockedCount += 1;
      return;
    }
    if (writeOne(edit.work, id)) edit.counts.changedCount += 1;
  };

  /**
   * The rows of the next batch: as many as the time a row of the batch before took leaves in the
   * budget of the part, at most twice the batch before and `BULK_BATCH_MAX`; one at least
   */
  const batchSizeOf = (edit: Edit, elapsed: number): number => {
    if (Number.isNaN(edit.batchRowMs)) return BULK_FIRST_BATCH;
    const growth = Math.min(BULK_BATCH_MAX, edit.batchRows * 2);
    if (edit.batchRowMs <= 0) return growth;
    return Math.max(1, Math.min(growth, Math.floor((budget - elapsed) / edit.batchRowMs)));
  };

  /**
   * Gives the next rows of the order, at most `size` of them, to a work that writes several
   * features at a time: the rows deleted or written first are passed over, and a locked one is
   * counted and left out
   *
   * @returns The rows it went through, the locked ones included
   */
  const writeBatch = (edit: Edit, work: BulkEditBatchWork, size: number): number => {
    const started = now();
    const { order } = edit;
    const ids: string[] = [];
    let rows = 0;
    while (edit.at < order.length && rows < size) {
      const ref = order[edit.at];
      edit.at += 1;
      if (ref < 0 || edit.early.has(ref) || edit.gone.has(ref)) continue;
      const id = tables.getRowId(ref);
      if (id === undefined) continue;
      rows += 1;
      if (!edit.ignoreLocks && isLocked(id)) {
        edit.counts.lockedCount += 1;
        continue;
      }
      ids.push(id);
    }
    if (ids.length > 0) {
      const changed = new Uint8Array(ids.length);
      countWork(counts, 'objectsCreated', 2);
      work.writeFeatures(ids, changed);
      for (let i = 0; i < changed.length; i++) {
        if (changed[i] === 1) edit.counts.changedCount += 1;
      }
    }
    if (rows > 0) {
      edit.batchRows = rows;
      edit.batchRowMs = (now() - started) / rows;
    }
    return rows;
  };

  /** Runs `fn` with the locks ignored when the edit ignores them */
  const withLocksOf = <T>(edit: Edit, fn: () => T): T =>
    edit.ignoreLocks ? withLocksIgnored(layer, fn) : fn();

  /** Whether the row is in the target of the edit and was not reached yet */
  const notReached = (edit: Edit, ref: number): boolean => {
    const k = findSorted(edit.sorted, ref);
    if (k < 0 || edit.places[k] < edit.at) return false;
    return !edit.early.has(ref) && !edit.gone.has(ref);
  };

  // ==========================================================================
  // What the edits follow while some is under way
  // ==========================================================================

  /**
   * Called by the layer before a write of this client reads a feature to write it or to make the
   * values it writes, and before it writes the row of a feature: the edit being written is applied to it first when it has not
   * reached it yet. Outside a transaction, in a transaction of its own with the number of the
   * edit, a part that more follow; inside one, in that transaction (a transaction of the Store
   * has one number)
   */
  const beforeFeatureWrite = (id: string): void => {
    if (writing) return;
    let edit = queue[0];
    if (!edit || edit.stopping || layer.isReadOnly()) return;
    if (edit.work.appliesFirst === false) return;
    const ref = tables.getRowRef(id);
    if (ref === undefined || !notReached(edit, ref)) return;
    // An edit that refuses when it is about to write ends as if it had not been started, and the
    // write goes on with the next one
    while (!prepareEdit(edit)) {
      next();
      const following = queue[0];
      if (!following || following.stopping || following.inTransaction) return;
      if (following.work.appliesFirst === false || !notReached(following, ref)) return;
      edit = following;
    }
    const current = edit;
    edit.early.add(ref);
    writing = true;
    try {
      withLocksOf(current, () => {
        if (layer.currentOperationId() !== undefined) {
          visit(current, id);
          return;
        }
        layer.transact(
          () => {
            // A part that more follow, the last one of the edit being written later; only in a
            // transaction of its own, not one of the Store opened elsewhere that it folded into
            if (layer.currentOperationId() === current.operationId) {
              layer.transact(nothing, current.source, { hasMoreParts: true });
            }
            visit(current, id);
          },
          current.source,
          { operationId: current.operationId },
        );
      });
    } catch (error) {
      // A write that threw is not taken as applied (the Store refused it): a later part writes it
      current.early.delete(ref);
      throw error;
    } finally {
      writing = false;
    }
  };

  /**
   * Prepares the work of an edit about to write for the first time; an edit whose work throws
   * then ends, rejected with what it threw, and nothing of it is written
   *
   * @returns False when the edit ended
   */
  const prepareEdit = (edit: Edit): boolean => {
    if (edit.prepared) return true;
    edit.prepared = true;
    try {
      edit.work.prepare?.();
    } catch (error) {
      leave(edit);
      edit.reject(error);
      return false;
    }
    return true;
  };

  /** Runs `fn`, as a write of the deletion of the layers of the edit when it marks them */
  const asWritesOf = <T>(edit: Edit, fn: () => T): T =>
    edit.marking ? layer.asLayerDeletion(fn) : fn();

  /** Calls the end of the work of an edit, in the transaction of its last part */
  const endWork = (edit: Edit, stopped: boolean): void => {
    const more = edit.work.end?.(stopped);
    if (typeof more === 'number') edit.counts.changedCount += more;
  };

  /** A change of the Store: the rows of the targets it deleted leave them */
  const onStoreChange = (change: RowChange): void => {
    if (change.reset) {
      // Every row the targets named is gone
      for (const edit of queue) edit.at = edit.order.length;
      return;
    }
    if (!change.rows) return;
    for (const rows of change.rows.layers.values()) {
      const { deleted } = rows;
      for (let i = 0; i < deleted.length; i++) {
        const ref = deleted[i];
        for (const edit of queue) {
          if (findSorted(edit.sorted, ref) >= 0) edit.gone.add(ref);
        }
      }
    }
  };

  /** Follows the writes and the deletions while some edit is under way, and stops after */
  const follow = (): void => {
    if (queue.length > 0 && stopListening === null && !destroyed) {
      layer.setBeforeFeatureWrite(beforeFeatureWrite);
      const unsubscribe = store.subscribe(onStoreChange);
      stopListening = () => {
        unsubscribe();
        layer.setBeforeFeatureWrite(null);
      };
    } else if (queue.length === 0 && stopListening !== null) {
      const stop = stopListening;
      stopListening = null;
      stop();
    }
  };

  // ==========================================================================
  // The parts
  // ==========================================================================

  /** Writes the next part of the edit; true when it was its last */
  const writePart = (edit: Edit): boolean => {
    const started = now();
    const limit = edit.rowsPerPart;
    let rows = 0;
    writing = true;
    try {
      withLocksOf(edit, () =>
        asWritesOf(edit, () =>
          layer.transact(
            () => {
              const { order, work } = edit;
              while (edit.at < order.length) {
                if ('writeFeatures' in work) {
                  const size = Math.min(batchSizeOf(edit, now() - started), limit - rows);
                  rows += writeBatch(edit, work, Math.max(1, size));
                } else {
                  const ref = order[edit.at];
                  edit.at += 1;
                  if (ref >= 0 && !edit.early.has(ref) && !edit.gone.has(ref)) {
                    const id = tables.getRowId(ref);
                    if (id !== undefined) {
                      visit(edit, id);
                      rows += 1;
                    }
                  }
                }
                if (rows >= limit || now() - started >= budget) break;
              }
              // Rows are left: the change of this part is one that more follow
              if (edit.at < order.length) {
                layer.transact(nothing, edit.source, { hasMoreParts: true });
              } else {
                endWork(edit, false);
              }
            },
            edit.source,
            { operationId: edit.operationId },
          ),
        ),
      );
    } finally {
      writing = false;
    }
    if (rows > 0) {
      // The rows of the next part, from the time a row took in this one, listeners included
      const perRow = (now() - started) / rows;
      edit.rowsPerPart =
        perRow > 0 ? Math.max(1, Math.floor(budget / perRow)) : Number.POSITIVE_INFINITY;
    }
    return edit.at >= edit.order.length;
  };

  /** The counts of an edit, as its promise gives them */
  const resultOf = (edit: Edit, stopped: boolean): EditCounts => {
    const result: EditCounts = {
      operationId: edit.operationId,
      changedCount: edit.counts.changedCount,
      lockedCount: edit.counts.lockedCount,
      missingCount: edit.counts.missingCount,
      stopped,
    };
    const created = edit.work.createdIds?.();
    if (created) result.createdIds = makeIdSet(created);
    return result;
  };

  /** Takes an edit out of the queue once it has ended */
  const leave = (edit: Edit): void => {
    const at = queue.indexOf(edit);
    if (at >= 0) queue.splice(at, 1);
    if (edit.marking) {
      edit.marking = false;
      layer.setLayersBeingDeleted(null);
    }
    edit.markEnded();
    follow();
  };

  /**
   * Writes the last part of an edit that stops, with nothing in it, and resolves its promise
   *
   * @returns False when the Store cannot be written now (its listeners are told a change): the
   *   edit stops in a later task
   */
  const stopEdit = (edit: Edit): boolean => {
    try {
      withLocksOf(edit, () =>
        asWritesOf(edit, () =>
          layer.transact(() => endWork(edit, true), edit.source, {
            operationId: edit.operationId,
            stopped: true,
          }),
        ),
      );
    } catch (error) {
      if (error instanceof DrawError && error.code === 'invalidState') return false;
      leave(edit);
      edit.reject(error);
      return true;
    }
    leave(edit);
    edit.resolve(resultOf(edit, true));
    return true;
  };

  /** Writes the next part of the edit being written, in a task of its own */
  const step = (): void => {
    waiting = false;
    if (destroyed) return;
    const edit = queue[0];
    if (!edit || edit.inTransaction) return;
    if (edit.stopping || layer.isReadOnly()) {
      if (!stopEdit(edit)) {
        waiting = true;
        schedule(step);
        return;
      }
    } else {
      if (!prepareEdit(edit)) {
        next();
        return;
      }
      if (edit.work.deletesLayers && !edit.marking) {
        // From its first part on, the layers it deletes take no other write of this client
        layer.setLayersBeingDeleted(new Set(edit.work.deletesLayers));
        edit.marking = true;
      }
      let last = false;
      try {
        last = writePart(edit);
      } catch (error) {
        // The edit ends where it failed: the change of the part closed its operation
        leave(edit);
        edit.reject(error);
        next();
        return;
      }
      if (last) {
        leave(edit);
        edit.resolve(resultOf(edit, false));
      }
    }
    next();
  };

  /** Waits for a later task to write the next part, when one is to be written */
  const next = (): void => {
    if (waiting || destroyed) return;
    const edit = queue[0];
    if (!edit || edit.inTransaction) return;
    waiting = true;
    schedule(step);
  };

  // ==========================================================================
  // The members
  // ==========================================================================

  /** Throws unless the options of an edit are options */
  const checkOptions = (given: unknown): EditOptions => {
    if (given === undefined) return {};
    if (!isRecord(given)) throw invalidInput('The options must be an object');
    if (given.source !== undefined && typeof given.source !== 'string') {
      throw invalidInput('source must be a string');
    }
    if (given.ignoreLocks !== undefined && typeof given.ignoreLocks !== 'boolean') {
      throw invalidInput('ignoreLocks must be a boolean');
    }
    return given as EditOptions;
  };

  const start = (
    target: FeatureTarget,
    given: EditOptions | undefined,
    makeWork: BulkEditWork | BulkEditWorkFactory,
    startOptions: BulkStartOptions = {},
  ): Promise<EditCounts | null> => {
    if (destroyed) throw destroyedError();
    const editOptions = checkOptions(given);
    const open = scope;
    if (open) {
      if (open.edit) {
        throw new DrawError(
          'invalidState',
          'One bulk edit at most can be started in one draw.transact',
        );
      }
      if (editOptions.source !== undefined && editOptions.source !== open.source) {
        throw new DrawError(
          'invalidState',
          `A bulk edit of the source ${JSON.stringify(editOptions.source)} cannot be started in a draw.transact of the source ${JSON.stringify(open.source)}`,
        );
      }
    }
    const { refs, missing } = readTarget(target);
    if (layer.isReadOnly()) return Promise.resolve(null);
    const { order, sorted, places } = indexTarget(refs);
    const ignoreLocks =
      startOptions.writesLocked === true ||
      (editOptions.ignoreLocks ?? open?.ignoreLocks ?? locksIgnored(layer));
    if (startOptions.refuses?.(ignoreLocks)) return Promise.resolve(null);
    if (!ignoreLocks && everyLocked(order)) return Promise.resolve(null);
    const operationId = (open ? layer.currentOperationId() : undefined) ?? store.newOperationId();
    const work =
      typeof makeWork === 'function'
        ? makeWork(
            {
              operationId,
              featureCount: sorted.length,
              onlyId: sorted.length === 1 ? tables.getRowId(sorted[0]) : undefined,
            },
            {
              ignoreLocks,
              targets: (id) => {
                const ref = tables.getRowRef(id);
                return ref !== undefined && findSorted(sorted, ref) >= 0;
              },
              targetTypes: () => typesOf(sorted),
            },
          )
        : makeWork;
    let resolve: (counts: EditCounts | null) => void = () => {};
    let reject: (error: unknown) => void = () => {};
    const promise = new Promise<EditCounts | null>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    let markEnded: () => void = () => {};
    const ended = new Promise<void>((res) => {
      markEnded = res;
    });
    const edit: Edit = {
      operationId,
      source: editOptions.source ?? open?.source ?? 'local',
      ignoreLocks,
      work,
      order,
      sorted,
      places,
      at: 0,
      early: new Set(),
      gone: new Set(),
      rowsPerPart: Number.POSITIVE_INFINITY,
      batchRows: 0,
      batchRowMs: Number.NaN,
      counts: {
        changedCount: 0,
        lockedCount: startOptions.lockedBefore ?? 0,
        missingCount: missing,
      },
      inTransaction: open !== null,
      stopping: false,
      prepared: false,
      marking: false,
      resolve,
      reject,
      ended,
      markEnded,
    };
    countWork(counts, 'objectsCreated', 4);
    if (open) open.edit = edit;
    queue.push(edit);
    follow();
    next();
    return promise;
  };

  const inTransaction = <T>(
    source: UpdateSource,
    ignoreLocks: boolean,
    run: (endOfFn: () => void) => T,
  ): T => {
    if (scope) return run(nothing);
    const own: TransactionScope = { source, ignoreLocks, edit: null };
    scope = own;
    let returned = false;
    try {
      const result = run(() => {
        // The change of the transaction is the first part of the edit started in `fn`, unless
        // `fn` destroyed the instance (the edit then does not start: destroy rejected it)
        if (own.edit && !destroyed) layer.transact(nothing, source, { hasMoreParts: true });
      });
      returned = true;
      return result;
    } finally {
      scope = null;
      const edit = own.edit;
      if (edit) {
        edit.inTransaction = false;
        if (returned) {
          next();
        } else {
          // `fn` threw: the edit does not start
          leave(edit);
          edit.resolve(null);
          next();
        }
      }
      // `fn` destroyed the instance: the edit being written ends its operation now that the
      // transaction has closed, and then rejects
      const closing = closeAfterTransaction;
      if (closing) {
        closeAfterTransaction = null;
        writeLastPartOnDestroy(closing);
        closing.markEnded();
        closing.reject(destroyedError());
      }
    }
  };

  const waitForWrites = (): Promise<void> => {
    if (queue.length === 0) return Promise.resolve();
    return Promise.all(queue.map((edit) => edit.ended)).then(nothing);
  };

  const stopAll = (): void => {
    if (queue.length === 0) return;
    for (const edit of queue) edit.stopping = true;
    // The edits not waiting for their transaction stop now, one after another, in their order
    while (queue.length > 0 && !queue[0].inTransaction && !destroyed) {
      if (!stopEdit(queue[0])) break;
    }
    next();
  };

  /** Writes the last part of the edit being written when the instance is destroyed */
  const writeLastPartOnDestroy = (edit: Edit): void => {
    try {
      withLocksOf(edit, () =>
        asWritesOf(edit, () =>
          layer.transact(nothing, edit.source, { operationId: edit.operationId, stopped: true }),
        ),
      );
    } catch (error) {
      console.error('Error while the last part of a bulk edit was written:', error);
    } finally {
      if (edit.marking) {
        edit.marking = false;
        layer.setLayersBeingDeleted(null);
      }
    }
  };

  const destroy = (): void => {
    if (destroyed) return;
    const edits = queue.splice(0);
    const head = edits[0];
    // The edit being written ends its operation for the subscribers of the Store first; in the fn
    // of draw.transact, once its transaction has closed (it would fold into it, its number and
    // `stopped` unused)
    if (head && !head.inTransaction) {
      if (scope) closeAfterTransaction = head;
      else writeLastPartOnDestroy(head);
    }
    destroyed = true;
    for (const edit of edits) {
      if (edit === closeAfterTransaction) continue;
      edit.markEnded();
      edit.reject(destroyedError());
    }
    follow();
  };

  return { layer, start, inTransaction, waitForWrites, stopAll, destroy };
}

/** The field of a draw instance that holds its bulk edits */
const BULK_EDITS = Symbol('the bulk edits');

/**
 * Gives a draw instance its bulk edits, in a field no other module can name
 *
 * @internal
 */
export function holdBulkEdits(draw: object, edits: BulkEdits): void {
  Object.defineProperty(draw, BULK_EDITS, { value: edits });
}

/**
 * The bulk edits of a draw instance (undefined for an object that holds none)
 *
 * @internal
 */
export function bulkEditsOf(draw: unknown): BulkEdits | undefined {
  if (typeof draw !== 'object' || draw === null) return undefined;
  return (draw as { [BULK_EDITS]?: BulkEdits })[BULK_EDITS];
}
