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
 * - The target is read once, when the edit starts, as a copy of the references of its rows in
 *   typed arrays: no array of IDs, no feature per row. An ID that names nothing then is counted
 *   as missing; a row deleted afterwards leaves the target (the Store tells it), and is not
 *   counted; a locked feature stays as it is and is counted, when the edit starts or meanwhile.
 * - The edits of this client are written one at a time, in the order they were started. A write
 *   of a few features of this client does not wait: the layer calls this before it writes the row
 *   of a feature, and the edit being written is first applied to that feature alone, in the
 *   transaction of the write. A change written to the Store directly is not held up: a later part
 *   reads the values the features have then.
 * - Read-only stops the edits: each writes its last part, with nothing in it and
 *   `stopped: true`. `destroy` writes that part for the edit being written, and then rejects
 *   every edit with `invalidState`; the edits waiting write nothing.
 *
 * The edits hold their state per instance; nothing is kept at the level of the module.
 */

import { countWork, type WorkCounts, workCountsOf } from '../../shared/work-counts.js';
import type { StoreChange as RowChange, Store as RowStore } from '../../store/built-in/types.js';
import type { InstanceDocument } from '../../store/document-access.js';
import type { UpdateSource } from '../../store/types.js';
import { DrawError } from '../errors.js';
import type { EditCounts, EditOptions, FeatureTarget } from '../features.js';
import type { IdSet } from '../model.js';
import { invalidInput, isRecord, locksIgnored, withLocksIgnored } from './shared.js';

/** The time of one part, the work of the listeners of its change included (ms) */
export const BULK_PART_BUDGET_MS = 50;

/**
 * What one bulk edit does to each feature of its target
 *
 * @internal
 */
export interface BulkEditWork {
  /**
   * Writes the edit to one feature through the layer, in the transaction open (a part of the
   * edit, or the transaction of a write that touches the feature first)
   *
   * @returns True when it changed the feature
   */
  writeFeature(id: string): boolean;
}

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
export interface BulkEdits {
  /**
   * Starts a bulk edit
   *
   * @returns A promise of what the edit did, once its last change has arrived; null at once when
   *   the document is read-only or every feature of the target is locked
   * @throws `DrawError` with the code `invalidInput` for a target or options of the wrong shape,
   *   or `invalidState` for a second edit started in the same `draw.transact`, or a source other
   *   than that of the `draw.transact` it is started in
   */
  start(
    target: FeatureTarget,
    options: EditOptions | undefined,
    work: BulkEditWork,
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
  readonly counts: Counts;
  /** Whether it waits for the transaction of `draw.transact` it was started in to end */
  inTransaction: boolean;
  /** Whether it stops at its next turn (read-only was turned on) */
  stopping: boolean;
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

  /** Applies the edit to one feature: a locked one stays as it is, and is counted */
  const visit = (edit: Edit, id: string): void => {
    if (!edit.ignoreLocks && isLocked(id)) {
      edit.counts.lockedCount += 1;
      return;
    }
    if (edit.work.writeFeature(id)) edit.counts.changedCount += 1;
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
   * Called by the layer before a write of this client writes the row of a feature: the edit
   * being written is applied to it first when it has not reached it yet
   */
  const beforeFeatureWrite = (id: string): void => {
    if (writing) return;
    const edit = queue[0];
    if (!edit || edit.stopping) return;
    const ref = tables.getRowRef(id);
    if (ref === undefined || !notReached(edit, ref)) return;
    edit.early.add(ref);
    writing = true;
    try {
      withLocksOf(edit, () => visit(edit, id));
    } finally {
      writing = false;
    }
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
        layer.transact(
          () => {
            const { order } = edit;
            while (edit.at < order.length) {
              const ref = order[edit.at];
              edit.at += 1;
              if (ref >= 0 && !edit.early.has(ref) && !edit.gone.has(ref)) {
                const id = tables.getRowId(ref);
                if (id !== undefined) {
                  visit(edit, id);
                  rows += 1;
                }
              }
              if (rows >= limit || now() - started >= budget) break;
            }
            // Rows are left: the change of this part is one that more follow
            if (edit.at < order.length) {
              layer.transact(nothing, edit.source, { hasMoreParts: true });
            }
          },
          edit.source,
          { operationId: edit.operationId },
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
  const resultOf = (edit: Edit, stopped: boolean): EditCounts => ({
    operationId: edit.operationId,
    changedCount: edit.counts.changedCount,
    lockedCount: edit.counts.lockedCount,
    missingCount: edit.counts.missingCount,
    stopped,
  });

  /** Takes an edit out of the queue once it has ended */
  const leave = (edit: Edit): void => {
    const at = queue.indexOf(edit);
    if (at >= 0) queue.splice(at, 1);
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
        layer.transact(nothing, edit.source, { operationId: edit.operationId, stopped: true }),
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
    work: BulkEditWork,
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
    const ignoreLocks = editOptions.ignoreLocks ?? open?.ignoreLocks ?? locksIgnored(layer);
    if (!ignoreLocks && everyLocked(order)) return Promise.resolve(null);
    const operationId = (open ? layer.currentOperationId() : undefined) ?? store.newOperationId();
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
      counts: { changedCount: 0, lockedCount: 0, missingCount: missing },
      inTransaction: open !== null,
      stopping: false,
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
        // The change of the transaction is the first part of the edit started in `fn`
        if (own.edit) layer.transact(nothing, source, { hasMoreParts: true });
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

  const destroy = (): void => {
    if (destroyed) return;
    const edits = queue.splice(0);
    const head = edits[0];
    // The edit being written ends its operation for the subscribers of the Store first
    if (head && !head.inTransaction) {
      try {
        withLocksOf(head, () =>
          layer.transact(nothing, head.source, { operationId: head.operationId, stopped: true }),
        );
      } catch (error) {
        console.error('Error while the last part of a bulk edit was written:', error);
      }
    }
    destroyed = true;
    for (const edit of edits) {
      edit.markEnded();
      edit.reject(destroyedError());
    }
    follow();
  };

  return { start, inTransaction, waitForWrites, stopAll, destroy };
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
