// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `draw.write`: the transaction, its writes kept until its function ends, and the commit that
 * makes them at once
 *
 * A write of a transaction is checked when it is called, against the document as committed with
 * what the transaction wrote before it over it (the features, layers and groups it wrote by their
 * IDs): a wrong input, a refusal of the state and a lock fail it there, and fail the whole
 * transaction. What it gives back (the feature created or changed) is what it will write. It is
 * kept as a write of the internal resources, made when the transaction is committed: the commit
 * goes into the queue of the writes of this client (`WriteQueue`), after the ones made before it,
 * and is made in a later microtask, in one transaction of the Store, so it is one notification
 * and one `change`. A write whose target is gone by then (a feature deleted from elsewhere) is
 * left out and counted as skipped.
 *
 * Nothing of a transaction is read before its commit: `draw.features` reads the document as
 * committed, however many features are written, so a read made without awaiting the write reads
 * the document before it.
 */

import type { BulkOperation, RowUpdate } from '../../feature-table/bulk-plan.js';
import { TableSelection } from '../../feature-table/selection.js';
import { differenceAll, intersectionAll, unionAll } from '../../geometry/boolean.js';
import type { AreaCoordinates, MultiPolygonCoordinates } from '../../geometry/types.js';
import type { ObjectGroup } from '../../shared/types/model.js';
import { createId } from '../../shared/utils/id.js';
import { forEachMatchingRow, type RowFilter } from '../../store/feature-stream.js';
import { featuresInStackingOrder } from '../../store/item-lists.js';
import { listEveryFeatureInOrder } from '../../store/ordering.js';
import { BULK_SLICE_ROWS } from '../../store/row-steps.js';
import { selectedRowsOfTarget, selectionOfTarget } from '../../store/selection-value.js';
import type { FeatureEdit, SlicedWrite, Store } from '../../store/store.js';
import type {
  FeatureCoordinates,
  FeatureType,
  RowValues,
  Selection,
  Feature as StoredFeature,
  Group as StoredGroup,
  Layer as StoredLayer,
} from '../../store/types.js';
import { DrawError } from '../errors.js';
import type { FeaturesCollection } from '../features.js';
import type { GroupsCollection } from '../groups.js';
import type { LayersCollection } from '../layers.js';
import type {
  Feature,
  FeatureInput,
  FeaturePatch,
  FeatureStyleSample,
  Group,
  GroupInput,
  GroupPatch,
  Layer,
  LayerInput,
  LayerPatch,
  LoadOptions,
  LoadResult,
  Metadata,
  MoveTarget,
  StoredFeaturePatch,
} from '../model.js';
import type { SelectionTarget } from '../state.js';
import type {
  ImportOptions,
  ImportResult,
  ImportSource,
  Many,
  Neighbor,
  OpenResult,
  OpenSource,
  Placement,
  Progress,
  Rotate,
  Scale,
  Target,
  Transaction,
  TransactionDocument,
  TransactionFeatures,
  TransactionGroups,
  TransactionLayers,
  Translate,
  Where,
  Write,
  WriteOptions,
  WriteResult,
} from '../write.js';
import type { DocumentLoader, PreparedItem } from './document.js';
import type { FeatureResource } from './feature-resource.js';
import { storedInputOf, storedPatchOf, toFeature } from './feature-shape.js';
import { prepareFeature, preparePatch } from './features.js';
import { resultFeature } from './geometry/apply.js';
import { planBuffer } from './geometry/buffer.js';
import { planSplit } from './geometry/split.js';
import {
  isAreaFeature,
  isBufferableFeature,
  isSplitLineFeature,
  toAreaCoordinates,
  toResultGeometry,
} from './geometry/targets.js';
import type { GroupResource } from './group-resource.js';
import { idsInStackingOrder, prepareGroup, prepareGroupPatch } from './groups.js';
import type { LayerResource } from './layer-resource.js';
import { prepareLayer, prepareLayerPatch } from './layers.js';
import { placementOf, resolveMoveTarget } from './placement.js';
import type { SelectionWrites } from './selection-resource.js';
import type { ResourceDeps } from './shared.js';
import {
  featureLocked,
  groupLocked,
  invalidInput,
  isRecord,
  layerLocked,
  notFound,
  onlyLockOrVisibility,
  requireId,
} from './shared.js';

// ============================================================================
// What the commit tells
// ============================================================================

/**
 * The commit of `draw.write` being made in a Store, read by the `change` it makes
 *
 * @internal
 */
export interface CommitInfo {
  readonly id: string;
  readonly label: string | undefined;
  /** Whether it is a step of undo */
  readonly undo: boolean;
}

const COMMITS = new WeakMap<Store, CommitInfo>();

/**
 * The commit being made in the Store, while its transaction runs and its notification goes out
 * (undefined for a write made otherwise: the input of the user, a write from elsewhere)
 *
 * @internal
 */
export function commitOf(store: Store): CommitInfo | undefined {
  return COMMITS.get(store);
}

/**
 * Makes a commit in the Store, with what tells it, in one transaction of the Store
 *
 * @internal
 */
export function runCommit<T>(store: Store, info: CommitInfo, source: string, fn: () => T): T {
  const outer = COMMITS.get(store);
  COMMITS.set(store, info);
  try {
    return store.transact(fn, source);
  } finally {
    if (outer) COMMITS.set(store, outer);
    else COMMITS.delete(store);
  }
}

/** Runs fn with the commit told as the one being made in the Store */
function withCommit<T>(store: Store, info: CommitInfo, fn: () => T): T {
  const outer = COMMITS.get(store);
  COMMITS.set(store, info);
  try {
    return fn();
  } finally {
    if (outer) COMMITS.set(store, outer);
    else COMMITS.delete(store);
  }
}

/**
 * Puts a commit in the queue of the writes of this client, after the ones before it, and makes it
 * in a later microtask (or sooner, when another write of this client comes first)
 *
 * @internal
 */
export function queueCommit<T>(store: Store, make: () => T | Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let made = false;
    const queued: SlicedWrite = {
      finish() {
        if (made) return;
        made = true;
        store.endSlicedWrite(queued);
        try {
          resolve(make());
        } catch (error) {
          reject(error);
        }
      },
    };
    store.beginSlicedWrite(queued);
    queueMicrotask(() => queued.finish());
  });
}

// ============================================================================
// The writer
// ============================================================================

/**
 * The internal resources the writes of a transaction are made with
 *
 * @internal
 */
export interface Writers {
  readonly features: FeatureResource;
  readonly layers: LayerResource;
  readonly groups: GroupResource;
  readonly metadata: { get(): Metadata; update(patch: Partial<Metadata>): Metadata | null };
  readonly selection: SelectionWrites;
  readonly document: DocumentLoader;
}

/**
 * What the writer is made of
 *
 * @internal
 */
export interface WriterDeps {
  readonly deps: ResourceDeps;
  readonly writers: Writers;
  readonly reads: {
    readonly features: FeaturesCollection;
    readonly layers: LayersCollection;
    readonly groups: GroupsCollection;
  };
}

/**
 * `draw.write` and `draw.open`
 *
 * @internal
 */
export interface Writer {
  write<T>(fn: (tx: Transaction) => T | Promise<T>, options?: WriteOptions): Write<T>;
  open(source?: OpenSource, options?: { readonly signal?: AbortSignal }): Promise<OpenResult>;
  /** Places an image at a position as one commit of this client (the image mode) */
  placeImage(
    image: Blob,
    at: { readonly coordinate: [number, number]; readonly zoom: number; readonly layerId: string },
    signal: AbortSignal,
  ): Promise<LoadResult | null>;
}

/** The source the Store is told for a commit of `draw.write` */
export const WRITE_SOURCE = 'local';

/**
 * The source the Store is told for a commit of `draw.write` that is no step of undo
 * (`undo: false`): the source a subscriber recording the changes as steps leaves out, as the
 * undo of a Store that keeps steps of its own does. The change of the instance still says `local`.
 */
export const WRITE_SOURCE_NO_UNDO = 'silent';

/**
 * Creates `draw.write` and `draw.open`
 *
 * @internal
 */
export function createWriter(writerDeps: WriterDeps): Writer {
  const { store } = writerDeps.deps;
  // The depth of the synchronous parts of the functions of `write` running
  let running = 0;

  const write = <T>(fn: (tx: Transaction) => T | Promise<T>, options?: WriteOptions): Write<T> => {
    if (running > 0) {
      throw new DrawError(
        'nestedWrite',
        'draw.write is called in the function of another: give its transaction to a function instead',
      );
    }
    if (typeof fn !== 'function') throw invalidInput('draw.write takes a function');
    const checked = checkWriteOptions(options);
    const id = createId();
    const tx = new TransactionImpl(id, checked.signal, writerDeps);
    let returned: T | Promise<T>;
    running++;
    try {
      returned = fn(tx);
    } catch (error) {
      returned = Promise.reject(error);
    } finally {
      running--;
    }
    // Once the function ends (and its writes not awaited are done), the commit is queued
    const commit = (value: T): WriteResult<T> | Promise<WriteResult<T>> => {
      tx.throwFailure();
      if (checked.signal.aborted) throw abortedError(checked.signal);
      if (tx.empty) return { value, skipped: 0 };
      return queueCommit(store, () =>
        tx.commit({ id, label: checked.label, undo: checked.undo }, checked.onProgress),
      ).then((skipped) => ({ value, skipped }));
    };
    const result: Promise<WriteResult<T>> = Promise.resolve(returned).then(
      (value) => {
        tx.close();
        return tx.pending ? tx.settled().then(() => commit(value)) : commit(value);
      },
      (error: unknown) => {
        tx.close();
        throw error;
      },
    );
    const done = result.then(({ value }) => value);
    return Object.assign(done, { id, result }) as Write<T>;
  };

  return {
    write,
    async placeImage(image, at, signal) {
      const loader = writerDeps.writers.document;
      const prepared = await loader.prepare(
        image as never,
        { mode: 'merge', coordinate: at.coordinate, zoom: at.zoom, layerId: at.layerId },
        new Set(),
        new Set(),
      );
      if (signal.aborted) throw abortedError(signal);
      if (!prepared) throw notEditable();
      return queueCommit(store, () => {
        if (store.isReadOnly()) throw notEditable();
        const [result] =
          runCommit(store, { id: createId(), label: undefined, undo: true }, WRITE_SOURCE, () =>
            loader.writeAll([prepared]),
          ) ?? [];
        return result ?? null;
      });
    },
    async open(source, options) {
      if (source === undefined) {
        throw new DrawError('invalidState', 'There is no storage to open the document from');
      }
      const signal = options?.signal;
      const loader = writerDeps.writers.document;
      const prepared = await loader.prepare(
        source as never,
        { mode: 'replace' },
        new Set(),
        new Set(),
      );
      if (signal?.aborted) throw abortedError(signal);
      if (!prepared) throw notEditable();
      return queueCommit(store, () => {
        if (store.isReadOnly()) throw notEditable();
        const id = createId();
        const [result] =
          runCommit(store, { id, label: undefined, undo: false }, 'open', () =>
            loader.writeAll([prepared]),
          ) ?? [];
        return {
          features: result?.featureIds.length ?? 0,
          skipped: (result?.skipped ?? []).map(({ index, reason }) => ({
            index,
            error: new DrawError('invalidInput', reason),
          })),
        };
      });
    },
  };
}

/** The signal of a write given none */
const NEVER_ABORTED = new AbortController().signal;

/**
 * The options of `draw.write`, checked
 *
 * @internal
 */
export function checkWriteOptions(options: WriteOptions | undefined): {
  signal: AbortSignal;
  label: string | undefined;
  undo: boolean;
  onProgress: ((progress: Progress) => void) | undefined;
} {
  if (options !== undefined && !isRecord(options))
    throw invalidInput('The options must be an object');
  const { signal, label, undo, onProgress } = options ?? {};
  if (onProgress !== undefined && typeof onProgress !== 'function') {
    throw invalidInput('onProgress must be a function');
  }
  if (label !== undefined && typeof label !== 'string')
    throw invalidInput('label must be a string');
  if (undo !== undefined && typeof undo !== 'boolean') throw invalidInput('undo must be a boolean');
  if (signal !== undefined && !(signal instanceof AbortSignal)) {
    throw invalidInput('signal must be an AbortSignal');
  }
  return {
    signal: signal ?? NEVER_ABORTED,
    label,
    undo: undo ?? true,
    onProgress: onProgress as ((progress: Progress) => void) | undefined,
  };
}

/** @internal */
export function abortedError(signal: AbortSignal): DrawError {
  return new DrawError('aborted', 'The write was stopped by its signal', { cause: signal.reason });
}

function notEditable(): DrawError {
  return new DrawError('notEditable', 'The document is read-only');
}

function lockedError(ids: readonly string[]): DrawError {
  return new DrawError('locked', `${ids.join(', ')} is locked`, { ids });
}

/** Whether a write made at the commit failed because what it named is gone, or locked meanwhile */
function isSkip(error: unknown): boolean {
  return error instanceof DrawError && (error.code === 'notFound' || error.code === 'locked');
}

// ============================================================================
// The transaction
// ============================================================================

/**
 * What a write of a transaction made at its commit gives: false when it was refused (left out),
 * or how many writes it left out (writes made as one)
 */
type OpResult = boolean | number | undefined;

/**
 * The parts a write of many rows or features is made in at its commit: each part writes some of
 * them and tells how many, and the end gives what the write gives
 */
type OpParts = Iterator<number, OpResult, undefined>;

/** A write of a transaction, made at its commit: at once, or in parts */
interface Op {
  (): OpResult | OpParts;
  /**
   * The features it creates: a creation, made in one write with the creations next to it (one
   * write of the rows of a layer for many features created one by one)
   */
  readonly creates?: readonly StoredFeature[];
  /** How much it writes (rows, features), told by the progress of the commit (1 when not told) */
  readonly size?: number;
  /**
   * Whether it writes features only (it creates, changes or deletes features, and writes nothing
   * of the layers, of the groups or of the metadata): a step of the commit ends after it, or
   * between its parts, only while every write made before it does as well, as the layers, the
   * groups and the metadata are read without finishing the commit (the drawing reads them every
   * frame)
   */
  readonly featuresOnly?: boolean;
}

/** A write of features made at the commit, with how much it writes */
function featureWrite(size: number, op: () => OpResult | OpParts): Op {
  return Object.assign(op, { size: Math.max(1, size), featuresOnly: true });
}

/** A creation made at the commit, with the features it creates */
function createOp(creates: readonly StoredFeature[], op: () => OpResult): Op {
  return Object.assign(op, { creates, size: Math.max(1, creates.length), featuresOnly: true });
}

/**
 * The time of a step of a commit written over several tasks (ms): writes are made until it is
 * spent, the next ones in a later task. A part of many rows then ends a step a few ms past it, and
 * the notification of the last step comes on top: a step stays well within the 100 ms of a task
 */
const COMMIT_STEP_MS = 40;

/** The rows or features a part of a write of many is made of, at first */
const FIRST_PART = BULK_SLICE_ROWS;

/** The time a part of a write of many is grown to (ms): it doubles while it is quicker */
const PART_MS = 8;

/**
 * Writes `count` items in parts, each of which a step of the commit can end after: a part doubles
 * while it is quick and halves while it is slow, so that many items cost few parts. `write` writes
 * the items `from` to `to` and says whether it wrote anything
 *
 * @returns Whether a part wrote anything
 */
function* inParts(
  count: number,
  write: (from: number, to: number) => boolean | undefined,
): Generator<number, boolean, undefined> {
  let written = false;
  let size = FIRST_PART;
  let at = 0;
  while (at < count) {
    const to = Math.min(count, at + size);
    const start = performance.now();
    if (write(at, to) === true) written = true;
    const took = performance.now() - start;
    if (took * 2 < PART_MS) size *= 2;
    else if (took > PART_MS * 2 && size > FIRST_PART) size = Math.max(FIRST_PART, size >> 1);
    yield to - at;
    at = to;
  }
  return written;
}

/** Writes rows in parts: `write` writes the rows of a part */
function rowsInParts(
  rows: TableSelection,
  write: (part: TableSelection) => boolean | undefined,
): Generator<number, boolean, undefined> {
  return inParts(rows.count, (from, to) =>
    write(TableSelection.of(rows.handles.subarray(from, to))),
  );
}

/** The deletion of rows, as the values of a write of them */
function deletionOf(handles: ArrayLike<number>): RowValues {
  return {
    handles: Int32Array.from(handles),
    fields: new Map(),
    deleted: new Uint8Array(handles.length).fill(1),
  };
}

/** Writes items of a list in parts: `write` writes the items of a part */
function listInParts<T>(
  list: readonly T[],
  write: (part: T[]) => boolean | undefined,
): Generator<number, boolean, undefined> {
  return inParts(list.length, (from, to) => write(list.slice(from, to)));
}

/** Whether what a write gave at its commit is the parts it is made in */
function isParts(value: OpResult | OpParts): value is OpParts {
  return typeof value === 'object' && value !== null && typeof value.next === 'function';
}

/**
 * The features, layers and groups a transaction wrote by their IDs, over the document as
 * committed: what its later writes are checked against
 */
class Overlay {
  readonly features = new Map<string, StoredFeature | null>();
  readonly layers = new Map<string, StoredLayer | null>();
  readonly groups = new Map<string, StoredGroup | null>();
  /**
   * The group of each feature a group the transaction made took, that the transaction has not
   * written otherwise (a feature it writes after is read as it wrote it)
   */
  readonly members = new Map<string, string>();
  /**
   * The writes of many rows the transaction made (a target of features selected in bulk), read
   * over the features of their rows as they are read: in their order, each giving the feature
   * after it, or null for one it deleted
   */
  readonly bulk: Array<{
    readonly rows: TableSelection;
    readonly apply: (feature: StoredFeature) => StoredFeature | null;
  }> = [];
  /** The Store as the checks read it, with what the transaction wrote over it */
  readonly view: Store;

  constructor(store: Store) {
    const read = <T>(
      written: Map<string, T | null>,
      id: string,
      committed: () => T | undefined,
    ) => {
      const own = written.get(id);
      return own === null ? undefined : (own ?? committed());
    };
    const overrides: Record<string, unknown> = {
      getFeature: (id: string) => {
        let feature = read(this.features, id, () => store.getFeature(id));
        // The writes of many rows, over a feature the transaction did not write otherwise
        if (feature && this.bulk.length > 0 && !this.features.has(id)) {
          const handle = store.tables?.getRowRef(id);
          for (const { rows, apply } of this.bulk) {
            if (!feature || handle === undefined || !rows.has(handle)) continue;
            feature = apply(feature) ?? undefined;
          }
        }
        // A member of a group the transaction made, written into the group as it is read
        const groupId = this.members.get(id);
        return feature && groupId !== undefined && !this.features.has(id)
          ? { ...feature, groupId }
          : feature;
      },
      getFeatureLayerId: (id: string) => {
        const own = this.features.get(id);
        if (own !== undefined) return own === null ? undefined : own.layerId;
        if (this.bulk.length > 0) return this.view.getFeature(id)?.layerId;
        return store.getFeatureLayerId(id);
      },
      getLayer: (id: string) => read(this.layers, id, () => store.getLayer(id)),
      getGroup: (id: string) => read(this.groups, id, () => store.getGroup(id)),
      getLayerOrder: () => {
        const order = store.getLayerOrder().filter((id) => this.layers.get(id) !== null);
        for (const [id, layer] of this.layers) {
          if (layer !== null && !order.includes(id)) order.push(id);
        }
        return order;
      },
      listLayers: () => {
        const out = store.listLayers().filter((layer) => this.layers.get(layer.id) !== null);
        for (const [id, layer] of this.layers) {
          if (layer !== null && !out.some((other) => other.id === id)) out.push(layer);
        }
        return out;
      },
    };
    this.view = new Proxy(store, {
      get(target, key, receiver) {
        if (typeof key === 'string' && key in overrides) return overrides[key];
        const value = Reflect.get(target, key, receiver === this ? target : target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  }
}

/** A transaction: its writes checked when called, kept, and made at its commit */
class TransactionImpl implements Transaction {
  readonly id: string;
  readonly signal: AbortSignal;
  // Made when first read: a transaction that writes features only makes nothing else
  #features: TransactionFeatures | undefined;
  #layers: TransactionLayers | undefined;
  #groups: TransactionGroups | undefined;
  #document: TransactionDocument | undefined;

  readonly #store: Store;
  readonly #deps: ResourceDeps;
  readonly #writers: Writers;
  readonly #reads: WriterDeps['reads'];
  #overlayMade: Overlay | undefined;
  /** The writes in the order they were called; an asynchronous one fills its place once read */
  readonly #ops: (Op | null)[] = [];
  /** The writes called that have not settled yet */
  readonly #pending = new Set<Promise<unknown>>();
  #closed = false;
  #failure: { error: unknown } | undefined;
  /** The revision of the Store the writes are checked against (`Store.revision`) */
  readonly #revision: number;
  /** Whether the Store changed while the writes were checked */
  #changed = false;
  /** Whether the Store is as the writes were checked against, as the commit is made */
  #unchangedAtCommit = false;

  constructor(id: string, signal: AbortSignal, writerDeps: WriterDeps) {
    this.id = id;
    this.signal = signal;
    this.#deps = writerDeps.deps;
    this.#store = writerDeps.deps.store;
    this.#writers = writerDeps.writers;
    this.#reads = writerDeps.reads;
    this.#revision = this.#store.revision;
  }

  /** Notes whether the Store changed since the transaction began */
  #noteRevision(): void {
    if (this.#store.revision !== this.#revision) this.#changed = true;
  }

  get features(): TransactionFeatures {
    this.#features ??= this.#featureWrites();
    return this.#features;
  }

  get layers(): TransactionLayers {
    this.#layers ??= this.#layerWrites();
    return this.#layers;
  }

  get groups(): TransactionGroups {
    this.#groups ??= this.#groupWrites();
    return this.#groups;
  }

  get document(): TransactionDocument {
    this.#document ??= this.#documentWrites();
    return this.#document;
  }

  /** What the transaction wrote over the document, made with its first write */
  get #overlay(): Overlay {
    this.#overlayMade ??= new Overlay(this.#store);
    return this.#overlayMade;
  }

  /** Whether it wrote nothing */
  get empty(): boolean {
    return this.#ops.every((op) => op === null);
  }

  close(): void {
    this.#closed = true;
  }

  /** Whether a write called has not settled yet */
  get pending(): boolean {
    return this.#pending.size > 0;
  }

  /** Settles once every write called has */
  async settled(): Promise<void> {
    while (this.#pending.size > 0) await Promise.allSettled([...this.#pending]);
  }

  /** Throws what failed first, when a write failed */
  throwFailure(): void {
    if (this.#failure) throw this.#failure.error;
  }

  /**
   * Makes the writes, in one transaction of the Store: in the task it is called in when they are
   * quick, over several tasks otherwise (`Store.writeInSteps`), a step of `COMMIT_STEP_MS` at a
   * time, a write of many rows or features made in parts. It is one notification, one `change`
   * and one step of undo either way; what reads the document before the last step finishes it
   * first, so nothing reads it half made. Writes next to each other that create features are made
   * in one write.
   *
   * @returns How many writes were left out, once the last step is made
   */
  commit(info: CommitInfo, onProgress?: (progress: Progress) => void): Promise<number> {
    const store = this.#store;
    if (store.isReadOnly()) throw notEditable();
    // Nothing changed the document since the writes were checked: a write may skip the checks
    // it made then (the writes before it in the commit are the ones it was checked after)
    this.#noteRevision();
    this.#unchangedAtCommit = !this.#changed;
    // The creations next to each other are one write
    const ops: Op[] = [];
    const written = this.#ops.filter((op): op is Op => op !== null);
    for (let i = 0; i < written.length; ) {
      let j = i;
      while (j < written.length && written[j].creates) j++;
      if (j > i) {
        ops.push(this.#creations(written.slice(i, j)));
        i = j;
      } else {
        ops.push(written[i]);
        i++;
      }
    }
    const total = ops.reduce((sum, op) => sum + (op.size ?? 1), 0);
    let at = 0;
    let parts: OpParts | null = null;
    // What the writes made so far wrote (those ended, and the parts of the one under way)
    let done = 0;
    let doneOfEnded = 0;
    let skipped = 0;
    // Whether a step may end now: every write made so far wrote features only
    let stoppable = true;
    const ended = (result: OpResult, size: number): void => {
      if (result === false) skipped++;
      else if (typeof result === 'number') skipped += result;
      if (ops[at].featuresOnly !== true) stoppable = false;
      doneOfEnded += size;
      done = doneOfEnded;
      at++;
      parts = null;
    };
    /** Makes writes until a time; true once every one is made */
    const step = (deadline: number): boolean => {
      while (at < ops.length) {
        const op = ops[at];
        const size = op.size ?? 1;
        try {
          if (parts === null) {
            const made = op();
            if (isParts(made)) parts = made;
            else ended(made, size);
          }
          if (parts !== null) {
            let next = parts.next();
            while (!next.done) {
              done = Math.min(doneOfEnded + size, done + next.value);
              if (stoppable && performance.now() >= deadline) return false;
              next = parts.next();
            }
            ended(next.value, size);
          }
        } catch (error) {
          // A write whose target is gone (or locked meanwhile) is left out
          if (!isSkip(error)) throw error;
          ended(false, size);
        }
        if (stoppable && performance.now() >= deadline) return at >= ops.length;
      }
      return true;
    };
    const refused = (error: unknown): DrawError =>
      // What the Store refuses at the commit fails the write as an error of the library
      error instanceof DrawError
        ? error
        : new DrawError('invalidState', `The commit was refused: ${String(error)}`, {
            cause: error,
          });
    return new Promise<number>((resolve, reject) => {
      let steps = 0;
      try {
        store.writeInSteps(
          info.undo ? WRITE_SOURCE : WRITE_SOURCE_NO_UNDO,
          (deadline) => {
            const all = step(deadline);
            steps++;
            if (!all || steps > 1) onProgress?.({ phase: 'apply', done, total });
            return all;
          },
          {
            budgetMs: COMMIT_STEP_MS,
            around: (fn) => withCommit(store, info, fn),
            onEnd: (error) => {
              if (error !== undefined) reject(refused(error));
              else resolve(skipped);
            },
          },
        );
      } catch (error) {
        reject(refused(error));
      }
    });
  }

  /**
   * Creations next to each other made as one write of their features, in parts. A creation whose
   * layer or group is gone is left out, as a creation alone is
   *
   * @returns The write, which gives how many creations it left out
   */
  #creations(ops: readonly Op[]): Op {
    const store = this.#store;
    const writers = this.#writers.features;
    const size = ops.reduce((sum, op) => sum + (op.size ?? 1), 0);
    return Object.assign(
      (): OpParts => {
        const features: StoredFeature[] = [];
        let skipped = 0;
        for (const op of ops) {
          const creates = op.creates as readonly StoredFeature[];
          const there = creates.every(
            (feature) =>
              store.getLayer(feature.layerId) !== undefined &&
              (feature.groupId === undefined || store.getGroup(feature.groupId) !== undefined),
          );
          if (there) features.push(...creates);
          else skipped++;
        }
        return (function* (): Generator<number, OpResult, undefined> {
          let refused = false;
          yield* inParts(features.length, (from, to) => {
            const made = writers.createMany(features.slice(from, to));
            if (made === null) refused = true;
            return made !== null;
          });
          // Refused (read-only): every creation is left out
          return refused ? ops.length : skipped;
        })();
      },
      { size },
    );
  }

  // ==========================================================================
  // Running a write
  // ==========================================================================

  /**
   * Runs a write now: its checks and what it gives back, the write it keeps for the commit
   * pushed by `keep`. What it throws fails it and the whole transaction.
   */
  #run<T>(check: (keep: (op: Op) => void) => T): Promise<T> {
    const refused = this.#refusal();
    if (refused) return this.#fail(refused);
    this.#noteRevision();
    try {
      return Promise.resolve(check((op) => this.#ops.push(op)));
    } catch (error) {
      return this.#fail(error);
    }
  }

  /** Runs a write that reads first: its place among the writes is kept from when it is called */
  #runAsync<T>(check: (keep: (op: Op) => void) => Promise<T>): Promise<T> {
    const refused = this.#refusal();
    if (refused) return this.#fail(refused);
    const at = this.#ops.length;
    this.#ops.push(null);
    this.#noteRevision();
    const running = (async () => {
      try {
        return await check((op) => {
          this.#noteRevision();
          this.#ops[at] = op;
        });
      } catch (error) {
        this.#failure ??= { error };
        throw error;
      }
    })();
    this.#pending.add(running);
    void running.then(
      () => this.#pending.delete(running),
      () => this.#pending.delete(running),
    );
    return running;
  }

  #refusal(): DrawError | null {
    if (this.#closed) {
      return new DrawError(
        'transactionClosed',
        'The function of draw.write has ended: its transaction takes no more writes',
      );
    }
    if (this.signal.aborted) return abortedError(this.signal);
    return null;
  }

  #fail<T>(error: unknown): Promise<T> {
    this.#failure ??= { error };
    return Promise.reject(error);
  }

  /** Throws unless the document can be written now */
  #requireEditable(): void {
    if (this.#store.isReadOnly()) throw notEditable();
  }

  /** Throws while a write of the transaction is under way: what it reads is not yet known */
  #requireSettled(): void {
    if (this.#closed) {
      throw new DrawError('transactionClosed', 'The function of draw.write has ended');
    }
    if (this.#pending.size > 0) {
      throw new DrawError(
        'writeNotFinished',
        'A write of the transaction is under way: await it before reading',
      );
    }
  }

  /** The feature as the transaction reads it */
  #feature(id: unknown): StoredFeature {
    const feature = typeof id === 'string' ? this.#overlay.view.getFeature(id) : undefined;
    if (!feature) throw notFound('feature', id);
    return feature;
  }

  // ==========================================================================
  // The targets
  // ==========================================================================

  /**
   * The features many names, read now: the IDs of the features (checked), or the selection of a
   * target, kept to be written as it was named
   */
  #resolve(target: Target, what: string): ResolvedTargetOf {
    if (typeof target === 'string') return { kind: 'ids', ids: [this.#feature(target).id] };
    if (Array.isArray(target)) {
      if (target.length === 0) throw invalidInput(`${what} names no feature`);
      const ids = [...new Set(target.map((id) => requireId(id)))];
      for (const id of ids) this.#feature(id);
      return { kind: 'ids', ids };
    }
    if (!isRecord(target)) throw invalidInput(`${what} must be an ID, IDs, a filter or a target`);
    if ((target as { type?: unknown }).type === 'selection') {
      const named = target as unknown as SelectionTarget;
      const selection = selectionOfTarget(this.#store, named);
      if (!selection) throw invalidInput('The target is not one this instance gave');
      // The features it names, read now: those of the selection as it was when the target was
      // read (whatever is selected since), written without touching the selection, the locked
      // ones left as they are
      const rows = selectedRowsOfTarget(this.#store, named);
      if (selection.bulk && rows && this.#overlay.features.size === 0) {
        // Written as rows: the IDs are read only by a write that writes them one by one
        let ids: string[] | undefined;
        const read = () => {
          ids ??= this.#idsOfSelection(selection, rows);
          return ids;
        };
        return {
          kind: 'ids',
          get ids() {
            return read();
          },
          skipLocked: true,
          rows,
        };
      }
      return { kind: 'ids', ids: this.#idsOfSelection(selection, rows), skipLocked: true };
    }
    if ('all' in target) {
      if (target.all !== true || Object.keys(target).length !== 1) {
        throw invalidInput('{ all: true } names every feature, and is given alone');
      }
      return { kind: 'filter', matches: () => true };
    }
    return { kind: 'filter', matches: whereMatcher(this.#store, target as Where) };
  }

  /** The IDs of the features of a target as the document is now (at the commit) */
  #idsAtCommit(resolved: ResolvedTargetOf, named?: readonly string[]): string[] {
    if (resolved.kind === 'ids') {
      return (named ?? resolved.ids).filter((id) => this.#store.getFeature(id) !== undefined);
    }
    if (resolved.kind === 'filter') {
      return listEveryFeatureIds(this.#store).filter((id) => {
        const feature = this.#store.getFeature(id);
        return feature !== undefined && resolved.matches(feature);
      });
    }
    return [];
  }

  /** The IDs of the features of a target as the transaction reads it (to count them now) */
  #idsNow(resolved: ResolvedTargetOf): string[] | null {
    if (resolved.kind === 'ids') return resolved.ids;
    if (resolved.kind === 'filter') {
      return listEveryFeatureIds(this.#store).filter((id) => {
        const feature = this.#overlay.view.getFeature(id);
        return feature !== undefined && resolved.matches(feature);
      });
    }
    return null;
  }

  /**
   * The IDs of the features a selection names: the features selected, or those of the groups or
   * the layers selected
   */
  #idsOfSelection(selection: Selection, rows: TableSelection | null): string[] {
    const store = this.#store;
    if (selection.bulk) {
      const tables = store.tables;
      if (!rows || !tables) return [];
      // The rows still there as the features they were (a row deleted since is left out)
      const ids: string[] = [];
      for (const handle of rows.handles) {
        const id = tables.getRowId(handle);
        if (typeof id === 'string' && tables.getRowRef(id) === handle) ids.push(id);
      }
      return ids;
    }
    const there = selection.ids.filter((id) => {
      if (selection.type === 'feature') return this.#overlay.view.getFeature(id) !== undefined;
      if (selection.type === 'group') return this.#overlay.view.getGroup(id) !== undefined;
      return this.#overlay.view.getLayer(id) !== undefined;
    });
    if (selection.type === 'feature') return there;
    if (selection.type === 'group') {
      const groups = new Set(there);
      return listEveryFeatureIds(store).filter((id) => {
        const groupId = this.#overlay.view.getFeature(id)?.groupId;
        return groupId !== undefined && groups.has(groupId);
      });
    }
    const layers = new Set(there);
    return listEveryFeatureIds(store).filter((id) => {
      const feature = this.#overlay.view.getFeature(id);
      return feature !== undefined && layers.has(feature.layerId);
    });
  }

  /**
   * The rows of the features selected in bulk a target names that are written now (not locked),
   * when they are written as rows: in a Store of rows that takes a write of many rows now
   * (null otherwise, the features written one by one)
   */
  #bulkRows(resolved: ResolvedTargetOf): TableSelection | null {
    if (resolved.kind !== 'ids' || !resolved.rows) return null;
    const store = this.#store;
    if (!store.tables || store.isInteractionLocked()) return null;
    return store.unlockedRows(resolved.rows);
  }

  /**
   * The IDs a target names now that are written. The features it names by their IDs are written
   * all or none: a locked one fails the write with `locked`. A filter, every feature and the
   * selection leave the locked ones out, and do not count them
   */
  #writableIds(resolved: ResolvedTargetOf): string[] {
    const ids = this.#idsNow(resolved) ?? [];
    const locked = (id: string) => featureLocked(this.#overlay.view, this.#feature(id));
    if (namesIds(resolved)) {
      const named = ids.filter(locked);
      if (named.length > 0) throw lockedError(named);
      return ids;
    }
    return ids.filter((id) => !locked(id));
  }

  // ==========================================================================
  // The features
  // ==========================================================================

  #featureWrites(): TransactionFeatures {
    const reads = this.#reads.features;
    const writers = this.#writers.features;
    const overlay = this.#overlay;
    const deps = (): ResourceDeps => ({ ...this.#deps, store: overlay.view });
    const read = <T>(fn: () => T): T => {
      this.#requireSettled();
      return fn();
    };
    const self = this;

    function create(input: FeatureInput): Promise<Feature>;
    function create(inputs: readonly FeatureInput[]): Promise<readonly string[]>;
    function create(
      given: FeatureInput | readonly FeatureInput[],
    ): Promise<Feature | readonly string[]> {
      return self.#run((keep) => {
        const many = Array.isArray(given);
        const inputs = (many ? given : [given]) as readonly FeatureInput[];
        const pending = new Set<string>();
        const prepared = inputs.map((input) => {
          const feature = prepareFeature(deps(), storedInputOf(input), pending);
          pending.add(feature.id);
          return feature;
        });
        self.#requireEditable();
        for (const feature of prepared) overlay.features.set(feature.id, feature);
        keep(createOp(prepared, () => writers.createMany(prepared) !== null));
        return many ? prepared.map((feature) => feature.id) : toFeature(prepared[0]);
      });
    }

    const updateOne = (
      id: string,
      patch: FeaturePatch,
    ): { feature: StoredFeature; next: StoredFeature; op: StoredFeaturePatch } => {
      const feature = self.#feature(id);
      const storedPatch = storedPatchOf(patch, feature);
      const updates = preparePatch(feature, storedPatch);
      return { feature, next: { ...feature, ...updates }, op: storedPatch };
    };

    function update(id: string, patch: FeaturePatch): Promise<Feature>;
    function update(
      target: Many,
      patch: FeaturePatch | ((sample: FeatureStyleSample) => FeaturePatch | null),
    ): Promise<number>;
    function update(
      entries: readonly { readonly id: string; readonly patch: FeaturePatch }[],
    ): Promise<number>;
    function update(
      target: string | Many | readonly { readonly id: string; readonly patch: FeaturePatch }[],
      patch?: FeaturePatch | ((sample: FeatureStyleSample) => FeaturePatch | null),
    ): Promise<Feature | number> {
      return self.#run((keep) => {
        if (typeof target === 'string') {
          const { feature, next, op } = updateOne(target, patch as FeaturePatch);
          self.#requireEditable();
          if (featureLocked(overlay.view, feature) && !onlyLockOrVisibility(op)) {
            throw lockedError([target]);
          }
          overlay.features.set(target, next);
          // Checked when called: the commit writes it, or leaves it out when the feature is gone
          keep(() => {
            const result = self.#store.applyEdits([{ kind: 'set', featureId: target, patch: op }]);
            return result !== null && result.dropped === 0;
          });
          return toFeature(next);
        }
        if (patch === undefined) {
          if (!Array.isArray(target)) throw invalidInput('update takes a target and a patch');
          return updateEntries(target as readonly { id: string; patch: FeaturePatch }[], keep);
        }
        const resolved = self.#resolve(target as Many, 'The target');
        return updateMany(resolved, patch, keep);
      });
    }

    const updateEntries = (
      entries: readonly { id: string; patch: FeaturePatch }[],
      keep: (op: Op) => void,
    ): number => {
      if (entries.length === 0) throw invalidInput('The entries name no feature');
      const seen = new Set<string>();
      const prepared = entries.map((entry) => {
        if (!isRecord(entry)) throw invalidInput('Each entry must be { id, patch }');
        const id = requireId(entry.id);
        if (seen.has(id)) throw invalidInput(`The ID ${id} is given twice`);
        seen.add(id);
        return { id, ...updateOne(id, entry.patch) };
      });
      self.#requireEditable();
      const locked = prepared
        .filter(
          ({ id, op }) =>
            featureLocked(overlay.view, self.#feature(id)) && !onlyLockOrVisibility(op),
        )
        .map(({ id }) => id);
      if (locked.length > 0) throw lockedError(locked);
      for (const { id, next } of prepared) overlay.features.set(id, next);
      keep(
        featureWrite(prepared.length, () => {
          const edits: FeatureEdit[] = prepared.map(({ id, op }) => ({
            kind: 'set',
            featureId: id,
            patch: op,
          }));
          let refused = false;
          const parts = listInParts(edits, (part) => {
            const result = self.#store.applyEdits(part);
            if (result === null || result.dropped > 0) refused = true;
            return true;
          });
          return (function* (): Generator<number, OpResult, undefined> {
            yield* parts;
            return !refused;
          })();
        }),
      );
      return prepared.length;
    };

    /**
     * A patch given to many features: once per kind of feature when it is a function. A locked
     * feature takes only a patch of its lock or its visibility: one named by its ID fails the
     * write with `locked`, one a filter or the selection names is left out and not counted
     */
    const updateMany = (
      resolved: ResolvedTargetOf,
      patch: FeaturePatch | ((sample: FeatureStyleSample) => FeaturePatch | null),
      keep: (op: Op) => void,
    ): number => {
      self.#requireEditable();
      const make = sharedPatchMaker(patch);
      const bulk = self.#bulkRows(resolved);
      if (bulk) return updateRows(resolved, bulk, patch, make, keep);
      const ids = self.#idsNow(resolved) ?? [];
      // Checked now, on the features it names now: a wrong patch fails it
      const named = namesIds(resolved);
      const lockedNamed: string[] = [];
      let written = 0;
      for (const id of ids) {
        const feature = self.#feature(id);
        const made = make(sampleOf(feature), feature);
        if (made === null) continue;
        if (featureLocked(overlay.view, feature) && !onlyLockOrVisibility(made)) {
          if (named) lockedNamed.push(id);
          continue;
        }
        written++;
      }
      if (lockedNamed.length > 0) throw lockedError(lockedNamed);
      keep(
        featureWrite(written, () => {
          const entries: FeatureEdit[] = [];
          for (const id of self.#idsAtCommit(resolved)) {
            const feature = self.#store.getFeature(id);
            if (!feature) continue;
            const made = make(sampleOf(feature), feature);
            if (made === null) continue;
            if (featureLocked(self.#store, feature) && !onlyLockOrVisibility(made)) continue;
            entries.push({ kind: 'set', featureId: id, patch: made });
          }
          if (entries.length === 0) return true;
          return listInParts(entries, (part) => {
            self.#store.applyEdits(part);
            return true;
          });
        }),
      );
      return written;
    };

    /**
     * A patch given to features selected in bulk: written to their rows in one write, once per
     * kind of row; a locked row is left as it is, unless the patch is of its lock or its
     * visibility only
     */
    const updateRows = (
      resolved: ResolvedTargetOf,
      bulk: TableSelection,
      patch: FeaturePatch | ((sample: FeatureStyleSample) => FeaturePatch | null),
      make: ReturnType<typeof sharedPatchMaker>,
      keep: (op: Op) => void,
    ): number => {
      // A patch given whole is checked now; one made per kind is checked as it is made
      const whole =
        typeof patch === 'function'
          ? null
          : make({ type: 'Point', style: {}, createdZoom: undefined }, undefined);
      const all = (resolved as { rows: TableSelection }).rows;
      // A patch of the lock or of the visibility alone is written to the locked rows too
      const lockOnly = whole !== null && onlyLockOrVisibility(whole);
      const rows = lockOnly ? self.#store.liveRows(all) : bulk;
      // The rows read now hold at the commit when nothing changed the document since and no
      // write of the transaction comes before it
      const first = self.#ops.length === 0;
      overlay.bulk.push({
        rows,
        apply: (feature) => {
          const made = make(sampleOf(feature), feature);
          return made === null ? feature : { ...feature, ...preparePatch(feature, made) };
        },
      });
      keep(
        featureWrite(rows.count, () => {
          const reuse = first && self.#unchangedAtCommit;
          const now = reuse
            ? rows
            : lockOnly
              ? self.#store.liveRows(all)
              : self.#store.unlockedRows(bulk);
          if (now.count === 0) return true;
          const op: BulkOperation = {
            kind: 'update',
            make: (sample) => {
              const made = make(sample, undefined);
              return made === null ? null : rowUpdateOf(made);
            },
          };
          return rowsInParts(now, (part) => self.#store.applyBulk(op, part));
        }),
      );
      return rows.count;
    };

    const remove = (target: Target): Promise<number> =>
      self.#run((keep) => {
        const resolved = self.#resolve(target, 'The target');
        self.#requireEditable();
        const bulk = self.#bulkRows(resolved);
        if (bulk) {
          // Features selected in bulk: their rows not locked deleted in one write of the rows
          overlay.bulk.push({ rows: bulk, apply: () => null });
          const first = self.#ops.length === 0;
          keep(
            featureWrite(bulk.count, () => {
              const now = first && self.#unchangedAtCommit ? bulk : self.#store.unlockedRows(bulk);
              if (now.count === 0) return true;
              const store = self.#store;
              // Told as one write of every row: its changes of the order, the groups it empties
              const end = store.beginRowParts(deletionOf(now.handles));
              const parts = rowsInParts(now, (part) => store.applyBulk({ kind: 'delete' }, part));
              return (function* (): Generator<number, OpResult, undefined> {
                let deleted: boolean;
                try {
                  deleted = yield* parts;
                } finally {
                  end();
                }
                if (!deleted) return false;
                // A selection in bulk the deletion left without a feature is cleared with it (the
                // selection the target was read from, every row of it deleted, is known to be)
                const selected = store.getSelectedRows();
                const named = (resolved as { rows?: TableSelection }).rows;
                const emptied =
                  selected !== null &&
                  ((selected === named && now.count === named.count) ||
                    store.liveRows(selected).count === 0);
                if (emptied) store.setSelection(null, []);
                return true;
              })();
            }),
          );
          return bulk.count;
        }
        const ids = self.#writableIds(resolved);
        for (const id of ids) overlay.features.set(id, null);
        keep(
          featureWrite(ids.length, () => {
            const now = self.#idsAtCommit(resolved, ids).filter((id) => {
              const feature = self.#store.getFeature(id);
              return feature !== undefined && !featureLocked(self.#store, feature);
            });
            if (now.length === 0) return true;
            // Told as one write of every row: its changes of the order, the groups it empties
            const store = self.#store;
            const tables = store.tables;
            const handles: number[] = [];
            for (const id of now) {
              const handle = tables?.getRowRef(id);
              if (handle !== undefined) handles.push(handle);
            }
            const end = handles.length > 0 ? store.beginRowParts(deletionOf(handles)) : () => {};
            const parts = listInParts(now, (part) => writers.deleteMany(part));
            return (function* (): Generator<number, OpResult, undefined> {
              try {
                return yield* parts;
              } finally {
                end();
              }
            })();
          }),
        );
        return ids.length;
      });

    const transform =
      (kind: 'translate' | 'rotate' | 'scale') =>
      (target: Target, input: Translate | Rotate | Scale): Promise<number> =>
        self.#run((keep) => {
          if (!isRecord(input)) throw invalidInput(`The ${kind} must be an object`);
          const resolved = self.#resolve(target, 'The target');
          self.#requireEditable();
          const values = transformValues(kind, input);
          const ids = self.#writableIds(resolved);
          keep(
            featureWrite(ids.length, () => {
              const now = self.#idsAtCommit(resolved, ids).filter((id) => {
                const feature = self.#store.getFeature(id);
                return feature !== undefined && !featureLocked(self.#store, feature);
              });
              if (now.length === 0) return true;
              return listInParts(now, (part) => {
                self.#store.applyEdits([{ ...values, target: { featureIds: part } }]);
                return true;
              });
            }),
          );
          return ids.length;
        });

    const place = (target: Target, to: Placement): Promise<number> =>
      self.#run((keep) => {
        const resolved = self.#resolve(target, 'The target');
        const moveTarget = moveTargetOf(overlay.view, to);
        const resolvedTarget = resolveMoveTarget(overlay.view, moveTarget);
        self.#requireEditable();
        if (resolvedTarget.locked) throw lockedError([placeIdOf(to)]);
        const bulk = resolvedTarget.kind !== 'ungroup' ? self.#bulkRows(resolved) : null;
        if (bulk && resolvedTarget.kind !== 'ungroup') {
          // Features selected in bulk put in a layer or a group: their rows in one write
          const layerId =
            resolvedTarget.kind === 'layer'
              ? resolvedTarget.layer.id
              : resolvedTarget.group.layerId;
          const groupId = resolvedTarget.kind === 'group' ? resolvedTarget.group.id : undefined;
          const placement = placementOf(
            overlay.view,
            layerId,
            groupId,
            resolvedTarget.place,
            new Set(),
          );
          overlay.bulk.push({ rows: bulk, apply: (feature) => ({ ...feature, layerId, groupId }) });
          const first = self.#ops.length === 0;
          keep(() => {
            // One write of the rows: the tables build the rows put in another place again with
            // the rows they joined, once per write, so a write of them in parts would cost the
            // rows already placed once per part
            const now = first && self.#unchangedAtCommit ? bulk : self.#store.unlockedRows(bulk);
            return now.count === 0 || self.#store.applyBulk({ kind: 'place', to: placement }, now);
          });
          return bulk.count;
        }
        const ids = self.#writableIds(resolved);
        for (const id of ids) {
          const feature = self.#feature(id);
          const layerId =
            resolvedTarget.kind === 'layer'
              ? resolvedTarget.layer.id
              : resolvedTarget.kind === 'group'
                ? resolvedTarget.group.layerId
                : feature.layerId;
          const groupId = resolvedTarget.kind === 'group' ? resolvedTarget.group.id : undefined;
          overlay.features.set(id, { ...feature, layerId, groupId });
        }
        keep(() => {
          const now = self.#idsAtCommit(resolved, ids).filter((id) => {
            const feature = self.#store.getFeature(id);
            return feature !== undefined && !featureLocked(self.#store, feature);
          });
          return now.length === 0 || writers.moveMany(now, moveTarget);
        });
        return ids.length;
      });

    /** An operation on areas: its result computed now, written in place of the anchor */
    const areaOperation = (
      inputs: StoredFeature[],
      anchor: StoredFeature,
      removed: StoredFeature[],
      compute: (areas: AreaCoordinates[]) => MultiPolygonCoordinates,
      keep: (op: Op) => void,
    ): Feature => {
      for (const input of inputs) {
        if (!isAreaFeature(input)) throw invalidInput(`The feature ${input.id} is not an area`);
      }
      self.#requireEditable();
      const locked = inputs.filter((input) => featureLocked(overlay.view, input)).map((f) => f.id);
      if (locked.length > 0) throw lockedError(locked);
      const geometry = toResultGeometry(
        compute(inputs.map((feature) => toAreaCoordinates(feature) as AreaCoordinates)),
      );
      if (geometry === null) throw invalidInput('The result has no area');
      return writeResults(
        [{ anchor, removedIds: removed.map((feature) => feature.id), geometry }],
        keep,
      )[0];
    };

    /** Results of an operation on features, each with a new ID, written at the commit */
    /**
     * Results of an operation on features, each with a new ID, written at the commit in the place
     * of its anchor; `chained` puts each result after the first just above the one before it
     */
    const writeResults = (
      results: readonly {
        anchor: StoredFeature;
        removedIds: string[];
        geometry: { type: FeatureType; coordinates: FeatureCoordinates };
        properties?: StoredFeature['properties'];
      }[],
      keep: (op: Op) => void,
      chained = false,
    ): Feature[] => {
      const ids = results.map(() => self.#deps.generateId());
      const made: StoredFeature[] = [];
      const written = results.map((result, i) => {
        const anchor = chained && i > 0 ? made[i - 1] : result.anchor;
        const entry = { ...result, anchor };
        made.push(resultFeature(overlay.view, entry, ids[i]));
        for (const id of result.removedIds) overlay.features.set(id, null);
        overlay.features.set(ids[i], made[i]);
        return { ...entry, id: ids[i] };
      });
      keep(() => self.#writers.features.writeResults(written));
      return made.map(toFeature);
    };

    const inStackingOrder = (features: StoredFeature[]) =>
      featuresInStackingOrder(overlay.view, features);
    const areas = (ids: unknown, min: number): StoredFeature[] => {
      if (!Array.isArray(ids)) throw invalidInput('The IDs must be an array');
      const features = inStackingOrder(
        [...new Set(ids as string[])].map((id) => self.#feature(id)),
      );
      if (features.length < min) throw invalidInput(`At least ${min} areas are needed`);
      return features;
    };

    return {
      get: (id) =>
        read(() => {
          const feature = typeof id === 'string' ? overlay.view.getFeature(id) : undefined;
          return feature === undefined ? undefined : toFeature(feature);
        }),
      getMany: (ids) =>
        read(() => {
          if (!Array.isArray(ids)) throw invalidInput('The IDs must be an array');
          return ids.map((id) => {
            const feature = overlay.view.getFeature(id);
            return feature === undefined ? undefined : toFeature(feature);
          });
        }),
      has: (id) => read(() => typeof id === 'string' && overlay.view.getFeature(id) !== undefined),
      list: (filter, options) => read(() => reads.list(filter, options)),
      count: (filter) => read(() => reads.count(filter)),
      bbox: (filter) => read(() => reads.bbox(filter)),
      isEditable: (id) => read(() => reads.isEditable(id)),
      getAppliedStyle: (id) => read(() => reads.getAppliedStyle(id)),
      create,
      update,
      delete: remove,
      translate: transform('translate'),
      rotate: transform('rotate'),
      scale: transform('scale'),
      place,
      union: (ids) =>
        self.#run((keep) => {
          const inputs = areas(ids, 2);
          return areaOperation(inputs, inputs[inputs.length - 1], inputs, unionAll, keep);
        }),
      difference: (id, subtract) =>
        self.#run((keep) => {
          const subject = self.#feature(id);
          const others = areas(subtract, 1);
          if (others.some((other) => other.id === subject.id)) {
            throw invalidInput('An area cannot be subtracted from itself');
          }
          const inputs = inStackingOrder([subject, ...others]);
          return areaOperation(
            inputs,
            subject,
            [subject],
            (all) =>
              differenceAll(
                all[inputs.indexOf(subject)],
                all.filter((_, index) => inputs[index] !== subject),
              ),
            keep,
          );
        }),
      intersection: (ids) =>
        self.#run((keep) => {
          const inputs = areas(ids, 2);
          return areaOperation(inputs, inputs[inputs.length - 1], inputs, intersectionAll, keep);
        }),
      split: (id, lineId) =>
        self.#run((keep) => {
          const area = self.#feature(id);
          const line = self.#feature(lineId);
          if (!isAreaFeature(area)) throw invalidInput(`The feature ${area.id} is not an area`);
          if (!isSplitLineFeature(line)) throw invalidInput(`The feature ${line.id} is not a line`);
          self.#requireEditable();
          if (featureLocked(overlay.view, area)) throw lockedError([area.id]);
          const geometries = planSplit(area, line);
          if (geometries.length < 2) return [];
          return writeResults(
            geometries.map((geometry, i) => ({
              anchor: area,
              removedIds: i === 0 ? [area.id] : [],
              geometry,
            })),
            keep,
            true,
          );
        }),
      buffer: (id, distanceMeters) =>
        self.#run((keep) => {
          const input = self.#feature(id);
          if (typeof distanceMeters !== 'number' || !Number.isFinite(distanceMeters)) {
            throw invalidInput('distanceMeters must be a finite number');
          }
          if (!isBufferableFeature(input)) {
            throw invalidInput(`The feature ${input.id} cannot be buffered`);
          }
          self.#requireEditable();
          if (featureLocked(overlay.view, input)) throw lockedError([input.id]);
          const plan = distanceMeters === 0 ? null : planBuffer(input, { distanceMeters });
          if (plan === null) throw invalidInput('The buffer has no area');
          return writeResults(
            [
              {
                anchor: input,
                removedIds: [],
                geometry: plan.geometry,
                properties: plan.properties,
              },
            ],
            keep,
          )[0];
        }),
    };
  }

  // ==========================================================================
  // The layers, the groups and the document
  // ==========================================================================

  #layerWrites(): TransactionLayers {
    const reads = this.#reads.layers;
    const writers = this.#writers.layers;
    const overlay = this.#overlay;
    const read = <T>(fn: () => T): T => {
      this.#requireSettled();
      return fn();
    };
    const requireLayer = (id: unknown): StoredLayer => {
      const layer = typeof id === 'string' ? overlay.view.getLayer(id) : undefined;
      if (!layer) throw notFound('layer', id);
      return layer;
    };
    return {
      get: (id) => read(() => (typeof id === 'string' ? overlay.view.getLayer(id) : undefined)),
      getMany: (ids) =>
        read(() => reads.getMany(ids).map((layer, i) => overlay.view.getLayer(ids[i]) ?? layer)),
      has: (id) => read(() => typeof id === 'string' && overlay.view.getLayer(id) !== undefined),
      list: (filter) => read(() => reads.list(filter)),
      count: (filter) => read(() => reads.count(filter)),
      listItems: (id, options) => read(() => reads.listItems(id, options)),
      countItems: (id) => read(() => reads.countItems(id)),
      getOrder: () => read(() => reads.getOrder()),
      getActive: () => read(() => reads.getActive()),
      setActive: (id) => read(() => reads.setActive(id)),
      create: (input?: LayerInput) =>
        this.#run((keep) => {
          if (input !== undefined && isRecord(input) && input.metadata !== undefined) {
            checkAppValues(input.metadata, 'metadata');
          }
          const prepared = prepareLayer(
            { ...this.#deps, store: overlay.view },
            input ?? {},
            new Set(),
          );
          this.#requireEditable();
          overlay.layers.set(prepared.layer.id, prepared.layer);
          const { layer, index } = prepared;
          keep(
            () =>
              writers.create({
                id: layer.id,
                name: layer.name,
                visible: layer.visible,
                locked: layer.locked,
                opacity: (layer as { opacity?: number }).opacity,
                ...(layer.styleRule !== undefined && { styleRule: layer.styleRule }),
                ...(layer.metadata !== undefined && { metadata: layer.metadata }),
                ...(index !== undefined && { index }),
              } as LayerInput) !== null,
          );
          return layer as Layer;
        }),
      update: (id: string, given: LayerPatch) =>
        this.#run((keep) => {
          const layer = requireLayer(id);
          // The values of the application are merged key by key, the keys of `unset` removed
          const patch = layerPatchOf(given, layer);
          const updates = prepareLayerPatch(patch);
          this.#requireEditable();
          if (layerLocked(overlay.view, layer) && !onlyLockOrVisibility(patch)) {
            throw lockedError([layer.id]);
          }
          const next = { ...layer, ...updates } as StoredLayer;
          overlay.layers.set(layer.id, next);
          keep(() => writers.update(layer.id, patch) !== null);
          return next as Layer;
        }),
      delete: (target) =>
        this.#run((keep) => {
          const ids =
            typeof target === 'string'
              ? [requireLayer(target).id]
              : Array.isArray(target)
                ? [...new Set(target.map((id) => requireLayer(id).id))]
                : isRecord(target) && (target as { all?: unknown }).all === true
                  ? overlay.view.listLayers().map((layer) => layer.id)
                  : (() => {
                      throw invalidInput('The target must be an ID, IDs or { all: true }');
                    })();
          this.#requireEditable();
          const locked = ids.filter((id) => layerLocked(overlay.view, requireLayer(id)));
          if (locked.length > 0) throw lockedError(locked);
          for (const id of ids) overlay.layers.set(id, null);
          keep(() => {
            const now = ids.filter((id) => this.#store.getLayer(id) !== undefined);
            return now.length === 0 || writers.deleteMany(now);
          });
          return ids.length;
        }),
      place: (id: string, to: Neighbor) =>
        this.#run((keep) => {
          // A layer, or an entry of the stacking order that is not one (a dataset placed among
          // the layers, an entry of the application)
          const inOrder = (entry: unknown): string => {
            if (typeof entry === 'string' && overlay.view.getLayer(entry)) return entry;
            if (typeof entry === 'string' && writers.isStackEntry(entry)) return entry;
            throw notFound('layer or entry of the stacking order', entry);
          };
          const placed = inOrder(id);
          const { neighbor, after } = neighborOf(to);
          inOrder(neighbor);
          if (neighbor === placed) throw invalidInput('An entry is not placed next to itself');
          this.#requireEditable();
          keep(() => {
            const order = writers.getOrder().filter((other) => other !== placed);
            const at = order.indexOf(neighbor);
            const there =
              this.#store.getLayer(placed) !== undefined || writers.isStackEntry(placed);
            if (at < 0 || !there) return false;
            order.splice(after ? at + 1 : at, 0, placed);
            return writers.reorder(order);
          });
          return undefined;
        }),
    };
  }

  #groupWrites(): TransactionGroups {
    const reads = this.#reads.groups;
    const writers = this.#writers.groups;
    const overlay = this.#overlay;
    const read = <T>(fn: () => T): T => {
      this.#requireSettled();
      return fn();
    };
    const requireGroup = (id: unknown): StoredGroup => {
      const group = typeof id === 'string' ? overlay.view.getGroup(id) : undefined;
      if (!group) throw notFound('group', id);
      return group;
    };
    return {
      get: (id) => read(() => (typeof id === 'string' ? overlay.view.getGroup(id) : undefined)),
      getMany: (ids) =>
        read(() => reads.getMany(ids).map((group, i) => overlay.view.getGroup(ids[i]) ?? group)),
      has: (id) => read(() => typeof id === 'string' && overlay.view.getGroup(id) !== undefined),
      list: (filter) => read(() => reads.list(filter)),
      count: (filter) => read(() => reads.count(filter)),
      listMembers: (id, options) => read(() => reads.listMembers(id, options)),
      create: (input: GroupInput) =>
        this.#run((keep) => {
          const checked = prepareGroup(
            { ...this.#deps, store: overlay.view },
            input,
            new Set(),
            new Set(),
            { inOrder: false },
          );
          this.#requireEditable();
          // A group of a layer held as rows lists no members (they are read from the rows); a
          // group of a layer of objects lists them in stacking order
          const asRows = overlay.view.getLayer(checked.layerId)?.kind === 'table';
          const prepared: ObjectGroup = asRows
            ? checked
            : { ...checked, featureIds: idsInStackingOrder(overlay.view, checked.featureIds) };
          // The order read now holds at the commit when no write of the transaction comes
          // before it (a write before it may place its members elsewhere)
          const inOrderAtCommit = !asRows && this.#ops.length === 0;
          const { featureIds: _members, ...fields } = prepared;
          const made: StoredGroup = asRows ? { ...fields, kind: 'table' } : prepared;
          overlay.groups.set(prepared.id, made);
          for (const featureId of prepared.featureIds) {
            // The features it wrote are written again in the group; the others are read in it
            const own = overlay.features.get(featureId);
            if (own) overlay.features.set(featureId, { ...own, groupId: prepared.id });
            else overlay.members.set(featureId, prepared.id);
          }
          keep(() =>
            // Checked against the document as it is: made as it was checked
            this.#unchangedAtCommit
              ? writers.createChecked(prepared, { membersInOrder: inOrderAtCommit }) !== null
              : writers.create({
                  id: prepared.id,
                  name: prepared.name,
                  visible: prepared.visible,
                  locked: prepared.locked,
                  layerId: prepared.layerId,
                  members: prepared.featureIds,
                }) !== null,
          );
          return made as Group;
        }),
      update: (id: string, patch: GroupPatch) =>
        this.#run((keep) => {
          const group = requireGroup(id);
          const updates = prepareGroupPatch(patch);
          this.#requireEditable();
          if (groupLocked(overlay.view, group) && !onlyLockOrVisibility(patch)) {
            throw lockedError([group.id]);
          }
          const next = { ...group, ...updates } as StoredGroup;
          overlay.groups.set(group.id, next);
          keep(() => writers.update(group.id, patch) !== null);
          return next as Group;
        }),
      delete: (target, options) =>
        this.#run((keep) => {
          const ids =
            typeof target === 'string'
              ? [requireGroup(target).id]
              : Array.isArray(target)
                ? [...new Set(target.map((id) => requireGroup(id).id))]
                : (() => {
                    throw invalidInput('The target must be an ID or IDs');
                  })();
          if (!isRecord(options) || (options.members !== 'keep' && options.members !== 'delete')) {
            throw invalidInput("Say whether the members stay: { members: 'keep' } or 'delete'");
          }
          this.#requireEditable();
          const locked = ids.filter((id) => groupLocked(overlay.view, requireGroup(id)));
          if (locked.length > 0) throw lockedError(locked);
          const withMembers = options.members === 'delete';
          const members = withMembers
            ? ids.flatMap((id) => reads.listMembers(id).filter((m) => overlay.view.getFeature(m)))
            : [];
          for (const id of ids) overlay.groups.set(id, null);
          for (const id of members) overlay.features.set(id, null);
          keep(() => {
            const now = ids.filter((id) => this.#store.getGroup(id) !== undefined);
            if (withMembers) {
              const there = members.filter((id) => this.#store.getFeature(id) !== undefined);
              if (there.length > 0) this.#writers.features.deleteMany(there);
            }
            return now.length === 0 || writers.deleteMany(now);
          });
          return ids.length;
        }),
      place: (id: string, to: Placement) =>
        this.#run((keep) => {
          const group = requireGroup(id);
          const moveTarget = moveTargetOf(overlay.view, to);
          const resolvedTarget = resolveMoveTarget(overlay.view, moveTarget);
          if (resolvedTarget.kind !== 'layer')
            throw invalidInput('A group can only be put in a layer');
          this.#requireEditable();
          if (resolvedTarget.locked || groupLocked(overlay.view, group))
            throw lockedError([group.id]);
          overlay.groups.set(group.id, {
            ...group,
            layerId: resolvedTarget.layer.id,
          } as StoredGroup);
          keep(
            () =>
              this.#store.getGroup(group.id) === undefined ||
              writers.moveMany([group.id], moveTarget),
          );
          return undefined;
        }),
    };
  }

  #documentWrites(): TransactionDocument {
    const self = this;
    const metadata = this.#writers.metadata;
    let written: Record<string, unknown> = {};
    const now = (): Record<string, unknown> => {
      const out: Record<string, unknown> = { ...metadata.get(), ...written };
      for (const key of Object.keys(out)) if (out[key] === undefined) delete out[key];
      return out;
    };
    return {
      get title() {
        self.#requireSettled();
        return (now().title as string | undefined) ?? '';
      },
      get description() {
        self.#requireSettled();
        return (now().description as string | undefined) ?? '';
      },
      get metadata() {
        self.#requireSettled();
        return appValuesOf(now());
      },
      update: (patch) =>
        self.#run((keep) => {
          const fields = documentPatchOf(patch);
          self.#requireEditable();
          written = { ...written, ...fields };
          keep(() => metadata.update(fields as Partial<Metadata>) !== null);
          return undefined;
        }),
    };
  }

  // ==========================================================================
  // Importing
  // ==========================================================================

  /** The IDs of the layers and groups the imports of this transaction create */
  readonly #importIds = new Set<string>();
  readonly #importLayers = new Set<string>();

  import(source: ImportSource, options?: ImportOptions): Promise<ImportResult> {
    return this.#runAsync(async (keep) => {
      if (options !== undefined && !isRecord(options)) {
        throw invalidInput('The options must be an object');
      }
      const { layer, group, duplicateIds } = options ?? {};
      if (duplicateIds !== undefined && duplicateIds !== 'renew') {
        throw invalidInput("duplicateIds takes 'renew': an ID taken is given a new one");
      }
      const loader = this.#writers.document;
      const loadOptions: LoadOptions = {
        mode: 'merge',
        ...(typeof layer === 'string' ? { layerId: layer } : {}),
        ...(layer !== undefined && typeof layer !== 'string' ? { layer: layer as LayerInput } : {}),
        ...(group !== undefined ? { group: group as Omit<GroupInput, 'members'> } : {}),
      };
      const prepared: PreparedItem | null = await loader.prepare(
        source as never,
        loadOptions,
        this.#importIds,
        this.#importLayers,
      );
      if (this.signal.aborted) throw abortedError(this.signal);
      if (!prepared) throw notEditable();
      // The layer and the group it creates are taken from now on in the transaction: a write
      // after it that gives one of their IDs fails as it would once they are written
      const overlay = this.#overlay;
      if (prepared.layer) overlay.layers.set(prepared.layer.layer.id, prepared.layer.layer);
      if (prepared.group) {
        overlay.groups.set(prepared.group.id, {
          ...prepared.group,
          layerId: prepared.layer?.layer.id ?? loadOptions.layerId ?? '',
          featureIds: [],
        } as StoredGroup);
      }
      // What it read is known once it is written, at the commit: the result fills in then
      const result = {
        count: 0,
        layerId: prepared.layer?.layer.id ?? loadOptions.layerId ?? '',
        skipped: [] as ImportResult['skipped'],
      };
      keep(() => {
        // The features it writes take no ID the other writes of the transaction create
        for (const map of [overlay.features, overlay.groups, overlay.layers]) {
          for (const [id, item] of map) if (item !== null) this.#importIds.add(id);
        }
        const [written] = this.#writers.document.writeAll([prepared]) ?? [];
        if (!written) return false;
        result.count = written.featureIds.length;
        result.layerId =
          written.layerId ??
          this.#store.getFeature(written.featureIds[0] ?? '')?.layerId ??
          result.layerId;
        result.skipped = (written.skipped ?? []).map(({ index, reason }) => ({
          index,
          error: new DrawError('invalidInput', reason),
        }));
        return true;
      });
      return result as ImportResult;
    });
  }
}

// ============================================================================
// Helpers
// ============================================================================

/** A patch of the Store as the change of a kind of row */
function rowUpdateOf(patch: StoredFeaturePatch): RowUpdate {
  return {
    ...(patch.style !== undefined && { style: patch.style as Record<string, unknown> }),
    ...(patch.properties !== undefined && {
      properties: patch.properties as Record<string, unknown>,
    }),
    ...(patch.visible !== undefined && { visible: patch.visible }),
    ...(patch.locked !== undefined && { locked: patch.locked }),
  };
}

/** Whether a target names its features by their IDs (not a filter, every feature or the selection) */
function namesIds(resolved: ResolvedTargetOf): boolean {
  return resolved.kind === 'ids' && resolved.skipLocked !== true;
}

type ResolvedTargetOf =
  | {
      kind: 'ids';
      ids: string[];
      skipLocked?: boolean;
      /**
       * The rows of the features selected in bulk the target names (written as rows, as many
       * at once, when the transaction wrote none of them before)
       */
      rows?: TableSelection;
    }
  | { kind: 'filter'; matches: (feature: StoredFeature) => boolean };

/** The IDs of every feature, in stacking order */
function listEveryFeatureIds(store: Store): string[] {
  const tables = store.tables;
  if (!tables) return listEveryFeatureInOrder(store).map((feature) => feature.id);
  const out: string[] = [];
  forEachMatchingRow(store, {} as RowFilter, (handle) => {
    const id = tables.getRowId(handle);
    if (typeof id === 'string') out.push(id);
    return true;
  });
  return out;
}

/** The test of a filter of features by the values of the document */
function whereMatcher(store: Store, where: Where): (feature: StoredFeature) => boolean {
  const entries = Object.entries(where);
  if (entries.length === 0)
    throw invalidInput('A filter names at least one key: { all: true } names every feature');
  const tests: ((feature: StoredFeature) => boolean)[] = [];
  const oneOf = (value: unknown, key: string): ReadonlySet<string> => {
    const list = Array.isArray(value) ? value : [value];
    if (list.length === 0 || list.some((id) => typeof id !== 'string')) {
      throw invalidInput(`${key} must be an ID or IDs`);
    }
    return new Set(list as string[]);
  };
  for (const [key, value] of entries) {
    if (value === undefined) throw invalidInput(`The filter key ${key} is undefined`);
    switch (key) {
      case 'layerId': {
        const ids = oneOf(value, key);
        tests.push((feature) => ids.has(feature.layerId));
        break;
      }
      case 'groupId': {
        const ids = oneOf(value, key);
        tests.push((feature) => feature.groupId !== undefined && ids.has(feature.groupId));
        break;
      }
      case 'featureType':
        if (typeof value !== 'string') throw invalidInput('featureType must be a string');
        tests.push((feature) => feature.type === value);
        break;
      case 'visible':
      case 'locked':
        if (typeof value !== 'boolean') throw invalidInput(`${key} must be a boolean`);
        tests.push((feature) => feature[key] === value);
        break;
      case 'bbox': {
        if (
          !Array.isArray(value) ||
          value.length !== 4 ||
          value.some((n) => typeof n !== 'number')
        ) {
          throw invalidInput('bbox must be [west, south, east, north]');
        }
        const [w, s, e, n] = value as number[];
        tests.push((feature) => {
          const box = boxOf(feature);
          return box !== null && box[0] <= e && box[2] >= w && box[1] <= n && box[3] >= s;
        });
        break;
      }
      case 'properties': {
        if (!isRecord(value)) throw invalidInput('properties must be an object');
        const wanted = Object.entries(value);
        tests.push((feature) =>
          wanted.every(
            ([name, v]) => JSON.stringify(feature.properties[name]) === JSON.stringify(v),
          ),
        );
        break;
      }
      default:
        throw invalidInput(`A filter cannot have the key ${key}`);
    }
  }
  void store;
  return (feature) => tests.every((test) => test(feature));
}

/** The extent of the positions of a feature */
function boxOf(feature: StoredFeature): [number, number, number, number] | null {
  let w = Infinity;
  let s = Infinity;
  let e = -Infinity;
  let n = -Infinity;
  const visit = (value: unknown): void => {
    if (!Array.isArray(value)) return;
    if (typeof value[0] === 'number') {
      w = Math.min(w, value[0]);
      e = Math.max(e, value[0]);
      s = Math.min(s, value[1] as number);
      n = Math.max(n, value[1] as number);
      return;
    }
    for (const part of value) visit(part);
  };
  visit((feature.geometry as { coordinates?: unknown }).coordinates);
  return w === Infinity ? null : [w, s, e, n];
}

/** The sample of a feature a patch made per kind is asked with */
function sampleOf(feature: StoredFeature): FeatureStyleSample {
  const createdZoom = feature.properties['maplibre-gl-draw:createdZoom'];
  return {
    type: feature.type,
    style: feature.style,
    createdZoom: typeof createdZoom === 'number' ? createdZoom : undefined,
  };
}

/**
 * The maker of the patch of the Store of a feature from a patch given to many features: the
 * patch, or the function asked once per kind of feature (`null` leaves the kind as it is)
 */
function sharedPatchMaker(
  patch: FeaturePatch | ((sample: FeatureStyleSample) => FeaturePatch | null),
): (sample: FeatureStyleSample, feature: StoredFeature | undefined) => StoredFeaturePatch | null {
  const kinds = new Map<string, FeaturePatch | null>();
  return (sample, feature) => {
    let made: FeaturePatch | null;
    if (typeof patch === 'function') {
      const key = JSON.stringify([sample.type, sample.style, sample.createdZoom ?? null]);
      if (!kinds.has(key)) kinds.set(key, patch(sample));
      made = kinds.get(key) ?? null;
    } else {
      made = patch;
    }
    if (made === null) return null;
    if (isRecord(made) && (made as { geometry?: unknown }).geometry !== undefined) {
      throw invalidInput('A patch given to many features does not change their geometry');
    }
    return storedPatchOf(made, feature ?? ({ style: sample.style } as StoredFeature));
  };
}

/** The values of a move, a turn or a stretch, checked */
function transformValues(
  kind: 'translate' | 'rotate' | 'scale',
  input: Translate | Rotate | Scale,
):
  | { kind: 'translate'; from: [number, number]; to: [number, number] }
  | { kind: 'rotate'; center: [number, number]; angleDegrees: number }
  | {
      kind: 'scale';
      center: [number, number];
      eastFactor: number;
      northFactor: number;
      sizeFactor: number;
    } {
  const position = (value: unknown, name: string): [number, number] => {
    if (
      !Array.isArray(value) ||
      value.length < 2 ||
      !Number.isFinite(value[0]) ||
      !Number.isFinite(value[1])
    ) {
      throw invalidInput(`${name} must be [longitude, latitude]`);
    }
    return [value[0] as number, value[1] as number];
  };
  const finite = (value: unknown, name: string): number => {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw invalidInput(`${name} must be a finite number`);
    }
    return value;
  };
  if (kind === 'translate') {
    const { from, to } = input as Translate;
    return { kind, from: position(from, 'from'), to: position(to, 'to') };
  }
  if (kind === 'rotate') {
    const { center, angleDegrees } = input as Rotate;
    return {
      kind,
      center: position(center, 'center'),
      angleDegrees: finite(angleDegrees, 'angleDegrees'),
    };
  }
  const { center, eastFactor, northFactor, sizeFactor } = input as Scale;
  return {
    kind,
    center: position(center, 'center'),
    eastFactor: finite(eastFactor, 'eastFactor'),
    northFactor: finite(northFactor, 'northFactor'),
    sizeFactor: finite(sizeFactor, 'sizeFactor'),
  };
}

/** The item a neighbor names, and whether the item goes just after it (above it) */
function neighborOf(to: Neighbor): { neighbor: string; after: boolean } {
  if (!isRecord(to)) throw invalidInput('The place must be { below } or { above }');
  const below = (to as { below?: unknown }).below;
  const above = (to as { above?: unknown }).above;
  if ((below === undefined) === (above === undefined)) {
    throw invalidInput('The place names one neighbor: { below } or { above }');
  }
  return below !== undefined
    ? { neighbor: requireId(below, 'below'), after: true }
    : { neighbor: requireId(above, 'above'), after: false };
}

/** The ID a placement names, for the error of a lock */
function placeIdOf(to: Placement): string {
  const record = to as Record<string, unknown>;
  return String(record.groupId ?? record.layerId ?? record.below ?? record.above ?? '');
}

/**
 * A placement as the internal resources take it: a neighbor alone is in the layer and the group
 * of the neighbor; `below` is the item just below
 */
function moveTargetOf(store: Store, to: Placement): MoveTarget {
  if (!isRecord(to)) throw invalidInput('The place must be an object');
  const record = to as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!['layerId', 'groupId', 'below', 'above'].includes(key)) {
      throw invalidInput(`A place cannot have the key ${key}`);
    }
  }
  const below = record.below as string | undefined;
  const above = record.above as string | undefined;
  if (below !== undefined && above !== undefined) {
    throw invalidInput('A place names one neighbor at most');
  }
  let layerId = record.layerId as string | undefined;
  let groupId = record.groupId as string | undefined;
  if (layerId === undefined && groupId === undefined) {
    const neighbor = requireId(below ?? above, 'The neighbor');
    const item = store.getFeature(neighbor) ?? store.getGroup(neighbor);
    if (!item) throw notFound('feature or group', neighbor);
    layerId = item.layerId;
    groupId = 'type' in item ? (item as StoredFeature).groupId : undefined;
  }
  if (layerId === undefined && groupId !== undefined) {
    const group = store.getGroup(groupId);
    if (!group) throw notFound('group', groupId);
    layerId = group.layerId;
  }
  return {
    layerId: layerId as string,
    ...(groupId !== undefined && { groupId }),
    ...(below !== undefined && { below }),
    ...(above !== undefined && { above }),
  } as MoveTarget;
}

// ============================================================================
// The values of the application
// ============================================================================

/** Whether a key is one of the values of an application: it has a prefix, `app:key` */
function isAppKey(key: string): boolean {
  const at = key.indexOf(':');
  return at > 0 && at < key.length - 1;
}

/** Whether a value is a JSON value */
function isJsonValue(value: unknown, depth = 0): boolean {
  if (depth > 64) return false;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((item) => isJsonValue(item, depth + 1));
  if (!isRecord(value) || Object.getPrototypeOf(value) !== Object.prototype) return false;
  return Object.values(value).every((item) => isJsonValue(item, depth + 1));
}

/**
 * Checks the values of an application: an object whose keys have a prefix and whose values are
 * JSON values (`undefined` is refused: a key is removed by naming it in `unset`)
 *
 * @internal
 */
export function checkAppValues(values: unknown, what: string): Record<string, unknown> {
  if (!isRecord(values)) throw invalidInput(`${what} must be an object`);
  for (const [key, value] of Object.entries(values)) {
    if (!isAppKey(key)) {
      throw invalidInput(`The key ${key} of ${what} has no prefix: write it as app:${key}`);
    }
    if (value === undefined) throw invalidInput(`The key ${key} of ${what} is undefined: unset it`);
    if (!isJsonValue(value)) throw invalidInput(`The key ${key} of ${what} is not a JSON value`);
  }
  return values;
}

/** The keys of `unset.metadata`, checked */
function unsetKeysOf(unset: unknown): string[] {
  if (unset === undefined) return [];
  if (!isRecord(unset)) throw invalidInput('unset must be an object');
  for (const key of Object.keys(unset)) {
    if (key !== 'metadata') throw invalidInput(`unset cannot have the key ${key}`);
  }
  const keys = unset.metadata;
  if (keys === undefined) return [];
  if (!Array.isArray(keys) || keys.length === 0 || keys.some((key) => typeof key !== 'string')) {
    throw invalidInput('unset.metadata must be a non-empty array of keys');
  }
  for (const key of keys as string[]) {
    if (!isAppKey(key)) throw invalidInput(`The key ${key} has no prefix`);
  }
  return keys as string[];
}

/**
 * The values of an application among the metadata the Store holds
 *
 * @internal
 */
export function appValuesOf(metadata: Record<string, unknown>): {
  readonly [key: `${string}:${string}`]: unknown;
} {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) if (isAppKey(key)) out[key] = value;
  return out as { readonly [key: `${string}:${string}`]: unknown };
}

/** A patch of the document as the fields of the metadata of the Store (`undefined` removes) */
function documentPatchOf(patch: unknown): Record<string, unknown> {
  if (!isRecord(patch)) throw invalidInput('The patch must be an object');
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(patch)) {
    if (!['title', 'description', 'metadata', 'unset'].includes(key)) {
      throw invalidInput(`The patch cannot have the key ${key}`);
    }
  }
  for (const key of ['title', 'description'] as const) {
    const value = patch[key];
    if (value !== undefined && typeof value !== 'string')
      throw invalidInput(`${key} must be a string`);
    if (value !== undefined) out[key] = value;
  }
  if (patch.metadata !== undefined) Object.assign(out, checkAppValues(patch.metadata, 'metadata'));
  for (const key of unsetKeysOf(patch.unset)) out[key] = undefined;
  if (Object.keys(out).length === 0) throw invalidInput('The patch changes nothing');
  return out;
}

/** A patch of a layer as the internal resource takes it: its whole metadata, merged */
function layerPatchOf(patch: LayerPatch, layer: StoredLayer): LayerPatch {
  if (!isRecord(patch)) throw invalidInput('The patch must be an object');
  const { metadata, unset, ...rest } = patch as LayerPatch & Record<string, unknown>;
  const removed = unsetKeysOf(unset);
  if (metadata === undefined && removed.length === 0) return rest as LayerPatch;
  const merged: Record<string, unknown> = { ...(layer.metadata ?? {}) };
  if (metadata !== undefined) Object.assign(merged, checkAppValues(metadata, 'metadata'));
  for (const key of removed) delete merged[key];
  return { ...rest, metadata: merged } as LayerPatch;
}
