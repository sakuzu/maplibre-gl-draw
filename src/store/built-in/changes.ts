// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The transactions of the built-in Store and the changes it tells (`StoreChange`)
 *
 * The writes of a transaction are gathered as they come, and told once, when the outermost
 * transaction ends: to every listener, in the order they subscribed, before `transact` returns.
 * A write made outside a transaction is a transaction of its own, of the source `'remote'`. A
 * transaction inside another folds into it when it has the same source (the options of the
 * outermost one win: those of the inner one are not used), and throws `invalidState` otherwise;
 * so does a write or a transaction while the listeners are told. Each
 * part of an operation written in several transactions is told as it ends: nothing is held back to
 * a later part.
 *
 * A change tells what the transaction did as a whole, by what was there before it and what is
 * there after it. The rows are folded by layer, write by write: a row created and deleted again is
 * not told, a row deleted and created again is updated, a row moved to another layer is told in
 * the layer it is in now. The writes that only create rows are kept as they come, so a large write
 * of new rows goes through without a set of its rows. The updates of a layer or a group are folded
 * into one entry per id, which keeps the first state as `previous` and the last as the value: an
 * id written again is looked up in a map, so a transaction that writes many layers or groups does
 * work in the number of its writes. The change of the stacking order and of the metadata keeps the
 * value before the transaction with the value after it.
 *
 * A change does not carry the values written: they are read from the tables while it is told.
 * What a listener asked for besides the rows it is given in its own change: the values the rows
 * had before (`previousValues`, read only for a transaction a listener asked them for, see
 * `values-before.ts`), and a token that keeps the rows the change deleted (`keepDeletedRows`, see
 * `kept-rows.ts`). Whether a listener asks for the values before is asked once per transaction,
 * before it writes; the listeners that keep the deleted rows are those subscribed when it starts.
 * The listeners share the arrays of the values before, and the tokens one entry that keeps the
 * rows: nothing is copied per listener.
 *
 * @internal
 */

import type { TableRowsChange, RowsChange as TablesRowsChange } from '@sakuzu/kasane';
import type { UpdateSource } from '../../api/extension/store.js';
import type { FileData, Layer, Metadata } from '../../api/model.js';
import { DrawError } from '../../shared/errors.js';
import { countWork, createWorkCounts, type WorkCounts } from '../../shared/work-counts.js';
import { createKeptRows, type KeptRows, markDeletion, settleKept } from './kept-rows.js';
import type {
  DeletedRowsToken,
  FeatureRowField,
  LayerRowsChange,
  RowValues,
  StoreChange,
  StoreGroup,
  StoreTransactOptions,
  SubscribeOptions,
} from './types.js';
import {
  createValuesBefore,
  type ReadBefore,
  readBeforeWrite,
  shareValuesBefore,
  type ValuesBefore,
  valuesBeforeOf,
} from './values-before.js';

/** The rows of one layer a transaction wrote, being folded */
interface LayerFold {
  /**
   * The rows created by the writes as they came, while every one of them only created rows (null
   * once one did more)
   */
  parts: Int32Array[] | null;
  /** The rows folded by what the transaction did to them (null while the writes are kept) */
  sets: RowSets | null;
  /** The fields written */
  readonly fields: Set<FeatureRowField>;
}

/** The rows of one layer, each in one set at most, by what the transaction did to it */
interface RowSets {
  readonly created: Set<number>;
  readonly updated: Set<number>;
  readonly deleted: Set<number>;
}

/** An update of a layer or a group, folded: the first state and the last */
interface Update<T> {
  readonly id: string;
  value: T;
  readonly previous: T;
}

/** What one transaction wrote, being gathered */
interface PendingChange {
  /** The rows, by layer */
  rows: Map<string, LayerFold>;
  /** The rows the clears of the transaction took out, by layer (null for none) */
  cleared: Map<string, Set<number>> | null;
  layersCreated: Layer[];
  readonly layersUpdated: Map<string, Update<Layer>>;
  layersDeleted: Layer[];
  order: { readonly order: readonly string[]; readonly previous: readonly string[] } | null;
  groupsCreated: StoreGroup[];
  readonly groupsUpdated: Map<string, Update<StoreGroup>>;
  groupsDeleted: StoreGroup[];
  metadata: {
    readonly metadata: Metadata;
    readonly previous: Metadata;
    readonly keys: Set<string>;
  } | null;
  filesCreated: FileData[];
  filesDeleted: FileData[];
  reset: boolean;
}

/** The outermost transaction under way */
interface Transaction {
  readonly source: UpdateSource;
  readonly operationId: number;
  /** Whether the caller gave the number of the operation */
  readonly givenOperation: boolean;
  readonly hasMoreParts: boolean;
  readonly stopped: boolean;
  readonly pending: PendingChange;
  /** The listeners whose changes of this transaction carry the values before */
  readonly asking: ReadonlySet<Subscription>;
  /** The listeners that keep the rows this transaction deletes */
  readonly keeping: readonly Subscription[];
  /** The values read before the writes (null when no listener asked for them) */
  readonly before: ValuesBefore | null;
  /** The token of the tables the writes give, to keep what they delete (when a listener keeps it) */
  readonly tablesToken: number | undefined;
  /** The rows the writes gave the token of the tables */
  readonly keptRows: Int32Array[];
}

/** A listener, as it subscribed */
interface Subscription {
  readonly listener: (change: StoreChange) => void;
  /** Whether a change of a source and an operation carries the values before (null: never) */
  readonly previousValues: ((source: UpdateSource, operationId: number) => boolean) | null;
  readonly keepDeletedRows: boolean;
}

/**
 * The tokens of the tables that keep the rows a write deletes: a new one, and letting go of one
 *
 * @internal
 */
export interface TablesTokens {
  createRestoreToken(): number;
  release(token: number): void;
}

/**
 * The transactions and the listeners of one Store
 *
 * @internal
 */
export interface Changes {
  /** The listeners, in the order they subscribed */
  readonly subscriptions: Subscription[];
  /** How deep the transactions under way are (0 outside one) */
  depth: number;
  /** The outermost transaction under way (null outside one) */
  transaction: Transaction | null;
  /** Whether the listeners are being told a change */
  notifying: boolean;
  /** Whether a listener is being asked whether its change carries the values before */
  asking: boolean;
  /** The number the next operation is given */
  nextOperation: number;
  /**
   * The operations a part was written of without the last: closed by their last part, or taken
   * as ended at the next change with `reset`
   */
  readonly openOperations: Set<number>;
  /** The numbers of the work of the Store */
  readonly counts: WorkCounts;
  /** The numbers of the work done for the values before only (counted in `counts` as well) */
  readonly beforeCounts: WorkCounts;
  /** The deleted rows kept, and the tokens given */
  readonly kept: KeptRows;
  /** The tokens of the tables of the rows that keep deleted rows */
  readonly tables: TablesTokens;
  /** How the values before are read (given by the writes of the Store) */
  readBefore: ReadBefore | null;
  /** The number of values of a position of a layer */
  readonly valuesPerPosition: (layerId: string) => number;
}

/**
 * The transactions and the listeners of a new Store
 *
 * @internal
 */
export function createChanges(
  counts: WorkCounts,
  tables: TablesTokens,
  valuesPerPosition: (layerId: string) => number,
): Changes {
  return {
    subscriptions: [],
    depth: 0,
    transaction: null,
    notifying: false,
    asking: false,
    nextOperation: 1,
    openOperations: new Set(),
    counts,
    beforeCounts: createWorkCounts(),
    kept: createKeptRows(),
    tables,
    readBefore: null,
    valuesPerPosition,
  };
}

/** Nothing written yet */
function emptyPending(): PendingChange {
  return {
    rows: new Map(),
    cleared: null,
    layersCreated: [],
    layersUpdated: new Map(),
    layersDeleted: [],
    order: null,
    groupsCreated: [],
    groupsUpdated: new Map(),
    groupsDeleted: [],
    metadata: null,
    filesCreated: [],
    filesDeleted: [],
    reset: false,
  };
}

/**
 * A new number of an operation
 *
 * @internal
 */
export function newOperationId(changes: Changes): number {
  const id = changes.nextOperation;
  changes.nextOperation += 1;
  return id;
}

/**
 * Throws unless the Store may be written now: not while its listeners are told a change, nor
 * while one is asked whether its change carries the values before
 */
function checkNotNotifying(changes: Changes, what: string): void {
  if (changes.notifying) {
    throw new DrawError(
      'invalidState',
      `${what}: the Store is not written while its listeners are told a change; write after it, in a task of your own`,
    );
  }
  if (changes.asking) {
    throw new DrawError(
      'invalidState',
      `${what}: the Store is not written while a listener is asked whether its changes carry the values before`,
    );
  }
}

/**
 * The listeners whose changes of a transaction carry the values before, each asked once, before
 * the transaction writes; a function that throws is reported, and answers no
 */
function askingOf(changes: Changes, source: UpdateSource, operationId: number): Set<Subscription> {
  const asking = new Set<Subscription>();
  changes.asking = true;
  try {
    for (const subscription of changes.subscriptions) {
      const asks = subscription.previousValues;
      if (!asks) continue;
      let answer = false;
      try {
        answer = asks(source, operationId);
      } catch (error) {
        console.error('Error in a listener of the Store asked for the values before:', error);
      }
      if (answer) asking.add(subscription);
    }
  } finally {
    changes.asking = false;
  }
  return asking;
}

/** Throws unless the options of a transaction are options */
function checkOptions(options: unknown): asserts options is StoreTransactOptions | undefined {
  if (options === undefined) return;
  if (typeof options !== 'object' || options === null) {
    throw new DrawError('invalidInput', 'transact: the options are not an object');
  }
  const { operationId, hasMoreParts, stopped } = options as Record<string, unknown>;
  if (
    operationId !== undefined &&
    (typeof operationId !== 'number' || !Number.isFinite(operationId))
  ) {
    throw new DrawError('invalidInput', 'transact: operationId is not a number of an operation');
  }
  for (const [name, value] of [
    ['hasMoreParts', hasMoreParts],
    ['stopped', stopped],
  ] as const) {
    if (value !== undefined && typeof value !== 'boolean') {
      throw new DrawError('invalidInput', `transact: ${name} is not a boolean`);
    }
  }
}

/**
 * Runs `fn` as one transaction (see `StoreView.transact`)
 *
 * @internal
 */
export function transact<T>(
  changes: Changes,
  fn: () => T,
  source: UpdateSource,
  options?: StoreTransactOptions,
): T {
  checkNotNotifying(changes, 'transact');
  if (typeof fn !== 'function') {
    throw new DrawError('invalidInput', 'transact: the transaction is not a function');
  }
  if (typeof source !== 'string') {
    throw new DrawError('invalidInput', 'transact: the source is not given');
  }
  const outer = changes.transaction;
  if (outer) {
    if (source !== outer.source) {
      throw new DrawError(
        'invalidState',
        `transact: a transaction of the source ${JSON.stringify(source)} inside one of ${JSON.stringify(outer.source)}`,
      );
    }
    // The options of the outermost transaction win: those of this one are not used
    changes.depth += 1;
    try {
      return fn();
    } finally {
      changes.depth -= 1;
    }
  }
  checkOptions(options);
  const givenOperation = options?.operationId !== undefined;
  const operationId = givenOperation ? (options?.operationId as number) : newOperationId(changes);
  const asking = askingOf(changes, source, operationId);
  const keeping = changes.subscriptions.filter((subscription) => subscription.keepDeletedRows);
  const transaction: Transaction = {
    source,
    operationId,
    givenOperation,
    hasMoreParts: options?.hasMoreParts ?? false,
    stopped: options?.stopped ?? false,
    pending: emptyPending(),
    asking,
    keeping,
    before: asking.size > 0 ? createValuesBefore() : null,
    tablesToken: keeping.length > 0 ? changes.tables.createRestoreToken() : undefined,
    keptRows: [],
  };
  changes.transaction = transaction;
  changes.depth = 1;
  let result: T | undefined;
  let failed = false;
  let failure: unknown;
  try {
    result = fn();
  } catch (error) {
    failed = true;
    failure = error;
  }
  changes.depth = 0;
  changes.transaction = null;
  tell(changes, transaction);
  if (failed) throw failure;
  return result as T;
}

/**
 * Runs a write: in the transaction under way, or in one of its own of the source `'remote'`
 *
 * @internal
 */
export function write<T>(changes: Changes, what: string, fn: () => T): T {
  checkNotNotifying(changes, what);
  if (changes.transaction) return fn();
  return transact(changes, fn, 'remote');
}

/** What the transaction under way has written */
function pendingOf(changes: Changes): PendingChange {
  const transaction = changes.transaction;
  if (!transaction) throw new DrawError('invalidState', 'a write outside a transaction');
  return transaction.pending;
}

/**
 * Reads the values rows have before a write of the transaction under way writes the fields given,
 * when a listener asked for the values before
 *
 * @internal
 */
export function readValuesBefore(
  changes: Changes,
  rows: Int32Array,
  fields: Iterable<FeatureRowField>,
): void {
  const before = changes.transaction?.before;
  const read = changes.readBefore;
  if (before && read) readBeforeWrite(before, read, rows, fields);
}

/**
 * Whether the transaction under way reads the values before
 *
 * @internal
 */
export function readsValuesBefore(changes: Changes): boolean {
  return (changes.transaction?.before ?? null) !== null;
}

/**
 * The token of the tables the writes of the transaction under way give, to keep the rows they
 * delete (undefined when no listener keeps them)
 *
 * @internal
 */
export function tablesTokenOf(changes: Changes): number | undefined {
  return changes.transaction?.tablesToken;
}

/**
 * Marks the deletion a write of the transaction under way wrote: a row written not deleted is not
 * kept any more, and a row deleted is kept by the token of the tables of the transaction
 *
 * @internal
 */
export function markDeletionWritten(changes: Changes, rows: Int32Array, deleted: Uint8Array): void {
  const tablesToken = changes.transaction?.tablesToken;
  markDeletion(changes.kept, rows, deleted, tablesToken);
  if (tablesToken !== undefined) changes.transaction?.keptRows.push(rows);
}

/** Throws unless the sources given are strings, and gives a set of them */
function sourcesOf(what: string, sources: unknown): Set<UpdateSource> {
  if (!Array.isArray(sources) || sources.some((source) => typeof source !== 'string')) {
    throw new DrawError('invalidInput', `subscribe: ${what} is not an array of sources`);
  }
  return new Set(sources);
}

/** Whether the changes of a source and an operation carry the values before, as asked */
function previousValuesOf(
  previousValues: SubscribeOptions['previousValues'],
): Subscription['previousValues'] {
  if (previousValues === undefined || previousValues === false) return null;
  if (previousValues === true) return () => true;
  if (typeof previousValues === 'function') {
    return (source, operationId) => previousValues({ source, operationId }) === true;
  }
  if (Array.isArray(previousValues)) {
    const sources = sourcesOf('previousValues', previousValues);
    return (source) => sources.has(source);
  }
  if (typeof previousValues === 'object' && previousValues !== null) {
    const sources = sourcesOf(
      'previousValues.except',
      (previousValues as { except?: unknown }).except,
    );
    return (source) => !sources.has(source);
  }
  throw new DrawError(
    'invalidInput',
    'subscribe: previousValues is neither a boolean, sources, { except } nor a function',
  );
}

/**
 * Subscribes a listener (see `StoreView.subscribe`)
 *
 * @internal
 */
export function subscribe(
  changes: Changes,
  listener: (change: StoreChange) => void,
  options?: SubscribeOptions,
): () => void {
  if (typeof listener !== 'function') {
    throw new DrawError('invalidInput', 'subscribe: the listener is not a function');
  }
  if (options !== undefined && (typeof options !== 'object' || options === null)) {
    throw new DrawError('invalidInput', 'subscribe: the options are not an object');
  }
  const keepDeletedRows = options?.keepDeletedRows ?? false;
  if (typeof keepDeletedRows !== 'boolean') {
    throw new DrawError('invalidInput', 'subscribe: keepDeletedRows is not a boolean');
  }
  const subscription: Subscription = {
    listener,
    previousValues: previousValuesOf(options?.previousValues),
    keepDeletedRows,
  };
  changes.subscriptions.push(subscription);
  return () => {
    const at = changes.subscriptions.indexOf(subscription);
    if (at >= 0) changes.subscriptions.splice(at, 1);
  };
}

// =============================================================================
// The rows
// =============================================================================

/** The fields of the tables, by their names in the changes */
const TABLE_FIELDS: ReadonlyMap<string, FeatureRowField> = new Map([
  ['key', 'orderKey'],
  ['hidden', 'visible'],
]);

/** The rows of a fold in sets, made from the writes kept as they came */
function setsOf(fold: LayerFold): RowSets {
  if (fold.sets) return fold.sets;
  const sets: RowSets = { created: new Set(), updated: new Set(), deleted: new Set() };
  for (const part of fold.parts ?? []) for (const row of part) sets.created.add(row);
  fold.parts = null;
  fold.sets = sets;
  return sets;
}

/** Whether a fold of another layer deleted a row */
function deletedIn(folds: readonly LayerFold[]): boolean {
  return folds.some((fold) => (fold.sets?.deleted.size ?? 0) > 0);
}

/**
 * Takes a row out of the folds of the other layers, for a row that is in this one now: what the
 * transaction did to it there (`created`, `updated` or `deleted`), or null for nothing
 */
function takeFrom(
  folds: readonly LayerFold[],
  row: number,
  kinds: readonly ('created' | 'updated' | 'deleted')[],
): 'created' | 'updated' | 'deleted' | null {
  for (const fold of folds) {
    const sets = fold.parts && kinds.includes('created') ? setsOf(fold) : fold.sets;
    if (!sets) continue;
    for (const kind of kinds) if (sets[kind].delete(row)) return kind;
  }
  return null;
}

/**
 * Folds the rows one write of the tables wrote in one table into the writes before it: a deleted
 * row brought back, which the tables tell as created, is updated. The fields are those the write
 * was given: the style written by its keys is named by the keys written, and the whole style as
 * `style` alone
 */
function foldTable(
  pending: PendingChange,
  layerId: string,
  written: TableRowsChange,
  broughtBack?: ReadonlySet<number>,
  styleKeys?: readonly FeatureRowField[],
): void {
  let fold = pending.rows.get(layerId);
  if (!fold) {
    fold = { parts: [], sets: null, fields: new Set() };
    pending.rows.set(layerId, fold);
  }
  for (const field of written.fields) {
    if (field === 'style' && styleKeys) {
      for (const key of styleKeys) fold.fields.add(key);
    } else {
      fold.fields.add(TABLE_FIELDS.get(field) ?? (field as FeatureRowField));
    }
  }
  const others: LayerFold[] = [];
  if (pending.rows.size > 1) {
    for (const [otherId, other] of pending.rows) if (otherId !== layerId) others.push(other);
  }
  const { created, updated, deleted } = written;
  if (
    fold.parts &&
    updated.length === 0 &&
    deleted.length === 0 &&
    !broughtBack &&
    !deletedIn(others)
  ) {
    if (created.length > 0) fold.parts.push(created);
    return;
  }
  const sets = setsOf(fold);
  for (const row of deleted) {
    sets.updated.delete(row);
    if (!sets.created.delete(row)) sets.deleted.add(row);
  }
  for (const row of created) {
    if (sets.deleted.delete(row) || broughtBack?.has(row)) sets.updated.add(row);
    else if (others.length > 0 && takeFrom(others, row, ['deleted']) !== null)
      sets.updated.add(row);
    else sets.created.add(row);
  }
  for (const row of updated) {
    if (sets.created.has(row) || sets.updated.has(row)) continue;
    // A row moved here: created by the transaction in the layer it left, it is created here
    const there = others.length > 0 ? takeFrom(others, row, ['created', 'updated']) : null;
    if (there === 'created') sets.created.add(row);
    else sets.updated.add(row);
  }
}

/**
 * Adds the rows a write of the tables wrote to the change of the transaction under way
 *
 * @param broughtBack - The deleted rows the write brought back (none when it is left out)
 * @param styleKeys - The fields of the keys of the style the write was given, when it wrote the
 *   style by its keys (the tables are given the whole style then)
 * @internal
 */
export function addRows(
  changes: Changes,
  written: TablesRowsChange,
  broughtBack?: ReadonlySet<number>,
  styleKeys?: readonly FeatureRowField[],
): void {
  if (written.tables.size === 0) return;
  const pending = pendingOf(changes);
  for (const [layerId, rows] of written.tables) {
    foldTable(pending, layerId, rows, broughtBack, styleKeys);
  }
}

/** The rows of a fold, joined */
function joined(parts: readonly Int32Array[]): Int32Array {
  if (parts.length === 1) return parts[0];
  let length = 0;
  for (const part of parts) length += part.length;
  const out = new Int32Array(length);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** The rows of the change, by layer (undefined when the transaction wrote none) */
function rowsOf(pending: PendingChange): Map<string, LayerRowsChange> | undefined {
  const layers = new Map<string, LayerRowsChange>();
  const none = new Int32Array(0);
  const ids = new Set([...pending.rows.keys(), ...(pending.cleared?.keys() ?? [])]);
  for (const layerId of ids) {
    const fold = pending.rows.get(layerId);
    const cleared = pending.cleared?.get(layerId);
    const sets = fold?.sets;
    const created = fold?.parts ? joined(fold.parts) : sets ? Int32Array.from(sets.created) : none;
    const updated = sets ? Int32Array.from(sets.updated) : none;
    let deleted = sets ? Int32Array.from(sets.deleted) : none;
    if (cleared) {
      for (const row of deleted) cleared.add(row);
      deleted = Int32Array.from(cleared);
    }
    if (created.length === 0 && updated.length === 0 && deleted.length === 0) continue;
    layers.set(layerId, { created, updated, deleted, fields: fold?.fields ?? new Set() });
  }
  return layers.size > 0 ? layers : undefined;
}

// =============================================================================
// The layers, the groups, the files and the metadata
// =============================================================================

/**
 * Adds a layer created to the change of the transaction under way
 *
 * @internal
 */
export function addLayerCreated(changes: Changes, layer: Layer): void {
  pendingOf(changes).layersCreated.push(layer);
}

/** Folds an update of a layer or a group into the updates of the same id before it */
function foldUpdate<T>(
  changes: Changes,
  updates: Map<string, Update<T>>,
  id: string,
  value: T,
  previous: T,
): void {
  countWork(changes.counts, 'changeLookups');
  const before = updates.get(id);
  if (before) before.value = value;
  else updates.set(id, { id, value, previous });
}

/**
 * Adds an update of a layer to the change of the transaction under way
 *
 * @internal
 */
export function addLayerUpdated(changes: Changes, layer: Layer, previous: Layer): void {
  foldUpdate(changes, pendingOf(changes).layersUpdated, layer.id, layer, previous);
}

/**
 * Adds a layer deleted to the change of the transaction under way
 *
 * @internal
 */
export function addLayerDeleted(changes: Changes, layer: Layer): void {
  pendingOf(changes).layersDeleted.push(layer);
}

/**
 * Adds a change of the stacking order to the change of the transaction under way: the order
 * before the transaction is kept
 *
 * @internal
 */
export function addOrderChanged(
  changes: Changes,
  order: readonly string[],
  previous: readonly string[],
): void {
  const pending = pendingOf(changes);
  pending.order = { order, previous: pending.order?.previous ?? previous };
}

/**
 * Adds a group created to the change of the transaction under way
 *
 * @internal
 */
export function addGroupCreated(changes: Changes, group: StoreGroup): void {
  pendingOf(changes).groupsCreated.push(group);
}

/**
 * Adds an update of a group to the change of the transaction under way
 *
 * @internal
 */
export function addGroupUpdated(changes: Changes, group: StoreGroup, previous: StoreGroup): void {
  foldUpdate(changes, pendingOf(changes).groupsUpdated, group.id, group, previous);
}

/**
 * Adds a group deleted to the change of the transaction under way
 *
 * @internal
 */
export function addGroupDeleted(changes: Changes, group: StoreGroup): void {
  pendingOf(changes).groupsDeleted.push(group);
}

/**
 * Adds a file created to the change of the transaction under way
 *
 * @internal
 */
export function addFileCreated(changes: Changes, file: FileData): void {
  pendingOf(changes).filesCreated.push(file);
}

/**
 * Adds a file deleted to the change of the transaction under way
 *
 * @internal
 */
export function addFileDeleted(changes: Changes, file: FileData): void {
  pendingOf(changes).filesDeleted.push(file);
}

/**
 * Adds a change of the metadata to the change of the transaction under way: the metadata before
 * the transaction is kept, and the keys written are added to those before
 *
 * @internal
 */
export function addMetadata(
  changes: Changes,
  metadata: Metadata,
  previous: Metadata,
  keys: Iterable<string>,
): void {
  const pending = pendingOf(changes);
  const written = pending.metadata?.keys ?? new Set<string>();
  for (const key of keys) written.add(key);
  pending.metadata = { metadata, previous: pending.metadata?.previous ?? previous, keys: written };
}

/** What the document holds when it is cleared */
export interface ClearedDocument {
  /** The rows of each layer that are not deleted */
  readonly rows: ReadonlyMap<string, Int32Array>;
  readonly layers: readonly Layer[];
  readonly groups: readonly StoreGroup[];
  readonly files: readonly FileData[];
  readonly metadata: Metadata;
  readonly order: readonly string[];
}

/** What was there before the transaction of the things a clear takes out */
function takenOut<T extends { readonly id: string }>(
  created: readonly T[],
  deleted: readonly T[],
  current: readonly T[],
): T[] {
  const made = new Set(created.map((item) => item.id));
  return [...deleted, ...current].filter((item) => !made.has(item.id));
}

/**
 * Adds a clear to the change of the transaction under way: the change has `reset`, what was there
 * before the transaction and is taken out is told as deleted, and what is written after it as
 * created
 *
 * @internal
 */
export function addCleared(changes: Changes, document: ClearedDocument): void {
  const pending = pendingOf(changes);
  // The rows there are now are deleted, so the rows the transaction created are not told
  for (const [layerId, rows] of document.rows) {
    foldTable(pending, layerId, {
      created: new Int32Array(0),
      updated: new Int32Array(0),
      deleted: rows,
      fields: new Set(),
      changedKeys: new Set(),
    });
  }
  const cleared = pending.cleared ?? new Map<string, Set<number>>();
  for (const [layerId, fold] of pending.rows) {
    const deleted = fold.sets?.deleted;
    if (!deleted || deleted.size === 0) continue;
    const into = cleared.get(layerId) ?? new Set<number>();
    for (const row of deleted) into.add(row);
    cleared.set(layerId, into);
  }
  pending.cleared = cleared;
  pending.rows = new Map();

  pending.layersDeleted = takenOut(pending.layersCreated, pending.layersDeleted, document.layers);
  pending.layersCreated = [];
  pending.layersUpdated.clear();
  pending.groupsDeleted = takenOut(pending.groupsCreated, pending.groupsDeleted, document.groups);
  pending.groupsCreated = [];
  pending.groupsUpdated.clear();
  pending.filesDeleted = takenOut(pending.filesCreated, pending.filesDeleted, document.files);
  pending.filesCreated = [];

  const previousOrder = pending.order?.previous ?? document.order;
  pending.order =
    pending.order || previousOrder.length > 0
      ? { order: Object.freeze([]), previous: previousOrder }
      : null;
  const previousMetadata = pending.metadata?.previous ?? document.metadata;
  const keys = pending.metadata?.keys ?? new Set<string>();
  for (const key of Object.keys(document.metadata)) keys.add(key);
  pending.metadata =
    pending.metadata || keys.size > 0
      ? { metadata: Object.freeze({}), previous: previousMetadata, keys }
      : null;
  pending.reset = true;
}

// =============================================================================
// The change
// =============================================================================

/** The change of a transaction, as the listeners receive it */
function changeOf(transaction: Transaction): StoreChange {
  const { pending } = transaction;
  const change: StoreChange = {
    source: transaction.source,
    operationId: transaction.operationId,
    hasMoreParts: transaction.hasMoreParts,
    stopped: transaction.stopped,
    reset: pending.reset,
  };
  const rows = rowsOf(pending);
  if (rows) change.rows = { layers: rows };
  const { layersCreated, layersUpdated, layersDeleted, order } = pending;
  if (layersCreated.length > 0 || layersUpdated.size > 0 || layersDeleted.length > 0 || order) {
    change.layers = {
      ...(layersCreated.length > 0 && { created: layersCreated }),
      ...(layersUpdated.size > 0 && {
        updated: Array.from(layersUpdated.values(), (u) => ({
          id: u.id,
          layer: u.value,
          previous: u.previous,
        })),
      }),
      ...(layersDeleted.length > 0 && { deleted: layersDeleted }),
      ...(order && { orderChanged: { order: [...order.order], previous: [...order.previous] } }),
    };
  }
  const { groupsCreated, groupsUpdated, groupsDeleted } = pending;
  if (groupsCreated.length > 0 || groupsUpdated.size > 0 || groupsDeleted.length > 0) {
    change.groups = {
      ...(groupsCreated.length > 0 && { created: groupsCreated }),
      ...(groupsUpdated.size > 0 && {
        updated: Array.from(groupsUpdated.values(), (u) => ({
          id: u.id,
          group: u.value,
          previous: u.previous,
        })),
      }),
      ...(groupsDeleted.length > 0 && { deleted: groupsDeleted }),
    };
  }
  if (pending.metadata) {
    change.metadata = {
      metadata: pending.metadata.metadata,
      previous: pending.metadata.previous,
      keys: Object.freeze([...pending.metadata.keys]),
    };
  }
  const { filesCreated, filesDeleted } = pending;
  if (filesCreated.length > 0 || filesDeleted.length > 0) {
    change.files = {
      ...(filesCreated.length > 0 && { created: filesCreated }),
      ...(filesDeleted.length > 0 && { deleted: filesDeleted }),
    };
  }
  return change;
}

/** Whether a change tells that the document changed */
function changedDocument(change: StoreChange): boolean {
  return (
    change.reset ||
    change.rows !== undefined ||
    change.layers !== undefined ||
    change.groups !== undefined ||
    change.metadata !== undefined ||
    change.files !== undefined
  );
}

/**
 * Tells the change of a transaction that ended to the listeners, in the order they subscribed:
 * when it changed the document, or when it is the last part of an operation (an operation is
 * always closed)
 */
function tell(changes: Changes, transaction: Transaction): void {
  const change = changeOf(transaction);
  const { operationId, givenOperation, hasMoreParts } = transaction;
  if (givenOperation) {
    if (hasMoreParts) changes.openOperations.add(operationId);
    else changes.openOperations.delete(operationId);
  }
  // A change that replaces the document ends the operations left open
  if (change.reset) {
    for (const open of changes.openOperations) {
      if (open !== operationId) changes.openOperations.delete(open);
    }
  }
  const told = changedDocument(change) || (givenOperation && !hasMoreParts);
  const listeners = told ? changes.subscriptions.slice() : [];
  const tokens = keptFor(changes, transaction, change, listeners);
  if (!told) return;
  const before = valuesBeforeFor(changes, transaction, change);
  countWork(changes.counts, 'notifications');
  changes.notifying = true;
  try {
    // Every listener is told: one that throws is reported, and the ones after it still are
    for (const subscription of listeners) {
      let own = change;
      if (before && transaction.asking.has(subscription)) {
        own = { ...own, previousValues: shareValuesBefore(before, countsOf(changes)) };
      }
      const token = tokens?.get(subscription);
      if (token !== undefined) own = { ...own, deletedRowsToken: token };
      try {
        subscription.listener(own);
      } catch (error) {
        console.error('Error in a listener of the Store:', error);
      }
    }
  } finally {
    changes.notifying = false;
  }
}

/** Where the work for the values before is counted: the numbers of the Store, and its own */
function countsOf(changes: Changes): readonly WorkCounts[] {
  return [changes.counts, changes.beforeCounts];
}

/**
 * Settles what the token of the tables of a transaction keeps: the rows its change deleted, for
 * the listeners told that keep them, each given a token (none for a change with `reset`)
 */
function keptFor(
  changes: Changes,
  transaction: Transaction,
  change: StoreChange,
  listeners: readonly Subscription[],
): Map<Subscription, DeletedRowsToken> | null {
  const { tablesToken } = transaction;
  if (tablesToken === undefined) return null;
  const keeping = transaction.keeping.filter((subscription) => listeners.includes(subscription));
  const deleted: Int32Array[] = [];
  if (!change.reset) {
    for (const rows of change.rows?.layers.values() ?? []) {
      if (rows.deleted.length > 0) deleted.push(rows.deleted);
    }
  }
  const tokens = settleKept(
    changes.kept,
    tablesToken,
    transaction.keptRows,
    deleted,
    keeping.length,
    (token) => changes.tables.release(token),
  );
  if (tokens.length === 0) return null;
  return new Map(keeping.map((subscription, i) => [subscription, tokens[i]]));
}

/** The values before of the change of a transaction a listener asked them for */
function valuesBeforeFor(
  changes: Changes,
  transaction: Transaction,
  change: StoreChange,
): Map<string, RowValues> | null {
  const { before } = transaction;
  const read = changes.readBefore;
  if (!before || !read || !change.rows) return null;
  const values = valuesBeforeOf(
    before,
    read,
    change.rows.layers,
    changes.valuesPerPosition,
    countsOf(changes),
  );
  return values.size > 0 ? values : null;
}
