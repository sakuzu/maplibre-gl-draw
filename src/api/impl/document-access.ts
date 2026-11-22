// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The layer over the Store of an instance (see `DocumentAccess`), over the Store of rows
 *
 * The features are rows of the Store; the layer makes the features of the rows, in one place,
 * and keeps up to 1,024 of them made. The layers and the groups the layer hands out are those of
 * the Store, with the order of what they hold (`Layer.items`, `Group.featureIds`) read from the
 * rows when it is read: a field that is not enumerable, made once per version of the order.
 *
 * The writes of the instance are written as rows: the order of the items of a layer and of the
 * features of a group as the `parent` and the `orderKey` of the rows and the `orderKey` of the
 * groups. The layer keeps what follows from a write that the Store does not do: a group whose last
 * feature leaves it is deleted, and the features of a group deleted take its place in its layer.
 *
 * Each transaction is told to the subscribers of the layer as one change in the words of the
 * features: what a write of the instance did, as the layer wrote it, and what a change written to
 * the Store directly did, as the layer reads it from the change of the Store. The values of a
 * change written to the Store directly are read while the Store tells it, and the change is told
 * to the subscribers of the layer once the Store has told it to all of its listeners, so that
 * they may write. The state of this client and the state only the drawing reads are kept here,
 * and told in the same change.
 */

import type { Geometry } from 'geojson';
import { DrawError } from '../../shared/errors.js';
import { countWork, type WorkCounts, workCountsOf } from '../../shared/work-counts.js';
import { onChangeTold } from '../../store/built-in/changes.js';
import { compareKeys, createOrderKeyBetween } from '../../store/built-in/order-keys.js';
import { setRowBoxes } from '../../store/built-in/row-boxes.js';
import type {
  DeletedRowsToken,
  FeatureRowField,
  GeometryColumn,
  LayerTableView,
  StoreChange as RowChange,
  Store as RowStore,
  RowValues,
  StoreGroup,
  StoreTransactOptions,
} from '../../store/built-in/types.js';
import {
  type CreatedPlace,
  FEATURES_KEPT,
  type FeatureBoxes,
  type FeatureMatch,
  type FeaturePlace,
  type FeatureValuesRead,
  type InstanceDocument,
  type MoveDestination,
  type SelectableRows,
} from '../../store/document-access.js';
import { ClientState } from '../../store/memory/ui-state.js';
import type {
  BoundingBox,
  BoxSelection,
  DragState,
  Feature,
  FileData,
  Group,
  Layer,
  Metadata,
  SelectionType,
  StoreChange,
  TentativeState,
  UpdateFeatureOptions,
  UpdateSource,
  VertexSelection,
} from '../../store/types.js';
import type { ChangedIds, IdSet } from '../model.js';
import {
  FEATURE_FIELDS,
  featuresOfValues,
  frozenFeature,
  frozenValue,
  geometryColumnOf,
  newRowFields,
  PROPERTY_FIELD,
  updatedRowFields,
} from './feature-rows.js';
import { makeIdSet } from './id-set.js';
import { RowIdSet, type RowIds } from './row-id-set.js';

/**
 * What a write of the layer throws inside itself when the Store refuses one of its writes (a
 * write of the Store that returns false): the write of the layer stops there, keeps and tells
 * what the Store applied before it, and returns false
 */
class RefusedWrite extends Error {
  constructor() {
    super('The Store refused a write');
  }
}

/**
 * What a change told to the subscribers of the layer did, in the words of the features: kept
 * with the change, in a field that is not enumerable, so that the change reads, copies and
 * compares as before
 */
const NOTES = Symbol('the notes of a change');

/** A feature a change wrote, by its ID: the reference of its row */
type NotedRows = Map<string, number>;

/** What the layer notes of a change (see `ChangeSummary`) */
interface Notes {
  operationId: number | undefined;
  hasMoreParts: boolean;
  stopped: boolean;
  /** Whether the features were noted (only while the changes are read in their words) */
  features: boolean;
  /**
   * Whether the change replaces the whole document: what it took out and what it wrote are
   * noted apart, so that a feature written again with its ID is in both
   */
  reset: boolean;
  readonly created: NotedRows;
  readonly updated: NotedRows;
  readonly moved: NotedRows;
  readonly deleted: Set<string>;
  /** The groups that moved, with the place each had before */
  readonly groupsMoved: Map<string, { layerId: string; key: string }>;
  layerOrder: { order: string[]; previous: string[] } | undefined;
  metadataKeys: Set<string> | undefined;
  valuesBefore: ReadonlyMap<string, RowValues> | undefined;
  askedBy: unknown;
  /**
   * The tokens that keep the rows the change deleted, held until the change is told (for a
   * change whose values before a watcher asked for), and whether one who reads the change took
   * them (see `ChangeSummary.claimDeletedRows`)
   */
  tokens: DeletedRowsToken[];
  claimed: boolean;
  /** Whether the change wrote whole geometries (see `DocumentOperations.markWholeGeometry`) */
  wholeGeometry: boolean;
  /** The groups deleted, with the layer and the key of the place each had */
  readonly groupsDeleted: Map<string, { layerId: string; key: string }>;
}

function newNotes(): Notes {
  return {
    operationId: undefined,
    hasMoreParts: false,
    stopped: false,
    features: false,
    reset: false,
    created: new Map(),
    updated: new Map(),
    moved: new Map(),
    deleted: new Set(),
    groupsMoved: new Map(),
    layerOrder: undefined,
    metadataKeys: undefined,
    valuesBefore: undefined,
    askedBy: null,
    tokens: [],
    claimed: false,
    wholeGeometry: false,
    groupsDeleted: new Map(),
  };
}

/** The notes of a change, or undefined when it has none */
function notesOf(change: StoreChange): Notes | undefined {
  return (change as { [NOTES]?: Notes })[NOTES];
}

/** The notes of a change, made for it when it has none */
function notesFor(change: StoreChange): Notes {
  const known = (change as { [NOTES]?: Notes })[NOTES];
  if (known) return known;
  const notes = newNotes();
  Object.defineProperty(change, NOTES, { value: notes, enumerable: false });
  return notes;
}

/**
 * A feature created: one deleted before it in the change and created again is updated, but in a
 * change that replaces the whole document, where it stays deleted and is created too
 */
function noteCreated(notes: Notes, id: string, ref: number): void {
  if (!notes.reset && notes.deleted.delete(id)) notes.updated.set(id, ref);
  else notes.created.set(id, ref);
}

/** A feature whose values changed (not one the change created) */
function noteUpdated(notes: Notes, id: string, ref: number): void {
  if (!notes.created.has(id)) notes.updated.set(id, ref);
}

/** A feature put in another place (not one the change created) */
function noteMoved(notes: Notes, id: string, ref: number): void {
  if (!notes.created.has(id)) notes.moved.set(id, ref);
}

/** A feature deleted: one the change created is in none of the sets */
function noteDeleted(notes: Notes, id: string): void {
  notes.updated.delete(id);
  notes.moved.delete(id);
  if (!notes.created.delete(id)) notes.deleted.add(id);
}

/**
 * A feature a change that replaces the whole document took out: deleted, whatever the change
 * writes with its ID
 */
function noteTakenOut(notes: Notes, id: string): void {
  notes.reset = true;
  notes.updated.delete(id);
  notes.moved.delete(id);
  notes.deleted.add(id);
}

/** Adds the notes of a change to those of the change being built */
function mergeNotes(target: Notes, from: Notes): void {
  if (from.operationId !== undefined) {
    target.operationId = from.operationId;
    target.hasMoreParts = from.hasMoreParts;
    target.stopped = from.stopped;
  }
  if (from.features) target.features = true;
  for (const id of from.deleted) noteDeleted(target, id);
  // What a replacement of the whole document writes is created, besides what it took out
  if (from.reset) target.reset = true;
  for (const [id, ref] of from.created) noteCreated(target, id, ref);
  for (const [id, ref] of from.updated) noteUpdated(target, id, ref);
  for (const [id, ref] of from.moved) noteMoved(target, id, ref);
  for (const [id, place] of from.groupsMoved) {
    if (!target.groupsMoved.has(id)) target.groupsMoved.set(id, place);
  }
  if (from.layerOrder) {
    target.layerOrder = target.layerOrder
      ? { order: from.layerOrder.order, previous: target.layerOrder.previous }
      : from.layerOrder;
  }
  if (from.metadataKeys) {
    target.metadataKeys ??= new Set();
    for (const key of from.metadataKeys) target.metadataKeys.add(key);
  }
  if (from.valuesBefore) target.valuesBefore = from.valuesBefore;
  if (from.askedBy !== null) target.askedBy = from.askedBy;
  // The tokens go with the notes they are merged into, once
  for (const token of from.tokens.splice(0)) target.tokens.push(token);
  if (from.wholeGeometry) target.wholeGeometry = true;
  for (const [id, place] of from.groupsDeleted) {
    if (!target.groupsDeleted.has(id)) target.groupsDeleted.set(id, place);
  }
}

/** Whether a feature changed in a value other than its place */
function valuesChanged(feature: Feature, previous: Feature): boolean {
  const a = feature as unknown as Record<string, unknown>;
  const b = previous as unknown as Record<string, unknown>;
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (key === 'layerId' || key === 'groupId') continue;
    if (a[key] !== b[key]) return true;
  }
  return false;
}

/**
 * What a change told to the subscribers of the layer did, in the words of the features
 *
 * @internal
 */
export interface ChangeSummary {
  /** The operation the change is a part of, as the Store told it */
  readonly operationId: number;
  /** Whether more changes of the same operation follow */
  readonly hasMoreParts: boolean;
  /** Whether it is the last change of an operation that stopped */
  readonly stopped: boolean;
  /**
   * The sets of the IDs of the features created, updated, deleted and moved, made at the first
   * call (the same sets afterwards): empty sets when the features were not noted
   */
  ids(): ChangedIds;
  /** The groups that moved, with the layer and the key of the place each had before */
  readonly groupsMoved: ReadonlyMap<string, { readonly layerId: string; readonly key: string }>;
  /** The stacking order of the layers after and before the change, when the Store changed it */
  readonly layerOrder: { readonly order: string[]; readonly previous: string[] } | undefined;
  /** The keys of the metadata the change wrote */
  readonly metadataKeys: readonly string[] | undefined;
  /** The values the rows had before the change, when a watcher asked for them */
  readonly valuesBefore: ReadonlyMap<string, RowValues> | undefined;
  /** What the watcher answered when it was asked for the values before the change */
  readonly askedBy: unknown;
  /**
   * Takes the rows the change deleted, which the layer keeps until the change has been told
   * (only for a change whose values before a watcher asked for): the layer then lets go of them
   * only when the function returned is called. Undefined when the change deleted no row, or
   * when it is called once the change has been told
   */
  claimDeletedRows(): (() => void) | undefined;
  /**
   * Whether the change wrote whole geometries (a move, a rotation, a scaling): every geometry it
   * wrote is taken back whole
   */
  readonly wholeGeometry: boolean;
  /** The groups the change deleted, with the layer and the key of the place each had */
  readonly groupsDeleted: ReadonlyMap<string, { readonly layerId: string; readonly key: string }>;
}

/**
 * Who reads the changes of the layer in the words of the features (the events of the instance)
 *
 * @internal
 */
export interface ChangeWatch {
  /** Whether the features a change wrote are noted (the sets of IDs are made of them) */
  wanted(): boolean;
  /**
   * Whether the features a change that replaces the whole document takes out are made (from
   * the values the rows had before it): only while they are told one by one
   */
  deletedFeatures(): boolean;
  /**
   * Asked before a transaction writes, once: anything but null makes the change carry the values
   * the rows had before it, and is carried with it (`ChangeSummary.askedBy`)
   */
  asksValues(change: { readonly source: UpdateSource; readonly operationId: number }): unknown;
}

/** The field of the layer that takes the watch of its changes */
const WATCH = Symbol('the watch of the changes');

/** The field of a change told that holds its summary */
const SUMMARY = Symbol('the summary of a change');

/**
 * What a change told by the layer did, in the words of the features (undefined for a change that
 * was not told by a layer, or that told the state of this client alone)
 *
 * @internal
 */
export function summaryOfChange(change: StoreChange): ChangeSummary | undefined {
  return (change as { [SUMMARY]?: ChangeSummary })[SUMMARY];
}

/**
 * Sets who reads the changes of a layer in the words of the features; nothing happens for a
 * layer that was not made by `createDocumentAccess`
 *
 * @returns The numbers of the work of the Store under the layer (undefined for none)
 * @internal
 */
export function watchChanges(
  layer: InstanceDocument,
  watch: ChangeWatch | null,
): WorkCounts | undefined {
  return (layer as { [WATCH]?: (watch: ChangeWatch | null) => WorkCounts | undefined })[WATCH]?.(
    watch,
  );
}

/** The number of features the layer keeps made */
const FEATURE_CACHE_LIMIT = FEATURES_KEPT;

/** The prefix of the fields of the keys of the style of a row */
const STYLE_FIELD = 'style:';

/** The kind of an item of a layer: a row, or a group */
const ROW_ITEM = 0;

/** A layer of the Store as the instance reads it: the layer with the order of its items */
type PublicLayer = Parameters<RowStore['createLayer']>[0];

type LayerUpdate = NonNullable<NonNullable<StoreChange['layers']>['updated']>[number];
type GroupUpdate = NonNullable<NonNullable<StoreChange['groups']>['updated']>[number];

/** The entries of a change that fold into one per ID */
interface Folds {
  readonly layers: Map<string, number>;
  readonly groups: Map<string, number>;
}

function newFolds(): Folds {
  return { layers: new Map(), groups: new Map() };
}

/** Adds the items to a list, or makes one of them */
function appended<T>(existing: T[] | undefined, items: readonly T[]): T[] {
  if (existing) {
    existing.push(...items);
    return existing;
  }
  return [...items];
}

/** Adds updates, folding those of one ID into one entry that keeps the first `previous` */
function foldedUpdates<T extends LayerUpdate | GroupUpdate>(
  existing: T[] | undefined,
  items: readonly T[],
  index: Map<string, number>,
  make: (item: T, previous: T) => T,
): T[] {
  const list = existing ?? [];
  for (const item of items) {
    const at = index.get(item.id);
    if (at === undefined) {
      index.set(item.id, list.length);
      list.push(item);
    } else {
      list[at] = make(item, list[at]);
    }
  }
  return list;
}

/** Adds a change to the change being built, as one notification of the Store gathers them */
function appendChange(target: StoreChange, change: StoreChange, folds: Folds): void {
  if (change.features) {
    if (!target.features) target.features = {};
    const t = target.features;
    if (change.features.created) t.created = appended(t.created, change.features.created);
    if (change.features.updated) t.updated = appended(t.updated, change.features.updated);
    if (change.features.deleted) t.deleted = appended(t.deleted, change.features.deleted);
  }
  if (change.layers) {
    if (!target.layers) target.layers = {};
    const t = target.layers;
    if (change.layers.created) t.created = appended(t.created, change.layers.created);
    if (change.layers.updated) {
      t.updated = foldedUpdates(t.updated, change.layers.updated, folds.layers, (item, at) => ({
        id: item.id,
        layer: item.layer,
        previous: at.previous,
      }));
    }
    if (change.layers.deleted) t.deleted = appended(t.deleted, change.layers.deleted);
    if (change.layers.orderChanged) t.orderChanged = change.layers.orderChanged;
  }
  if (change.groups) {
    if (!target.groups) target.groups = {};
    const t = target.groups;
    if (change.groups.created) t.created = appended(t.created, change.groups.created);
    if (change.groups.updated) {
      t.updated = foldedUpdates(t.updated, change.groups.updated, folds.groups, (item, at) => ({
        id: item.id,
        group: item.group,
        previous: at.previous,
      }));
    }
    if (change.groups.deleted) t.deleted = appended(t.deleted, change.groups.deleted);
  }
  if (change.layerReorder) target.layerReorder = change.layerReorder;
  if (change.groupReorder) target.groupReorder = change.groupReorder;
  if (change.selection) target.selection = change.selection;
  if (change.editing) {
    if (!target.editing) target.editing = {};
    const t = target.editing;
    if (change.editing.started) t.started = appended(t.started, change.editing.started);
    if (change.editing.ended) t.ended = appended(t.ended, change.editing.ended);
  }
  if (change.tentative) target.tentative = change.tentative;
  if (change.mode) target.mode = change.mode;
  if (change.uiStateChanged) target.uiStateChanged = true;
  if (change.reset === true) target.reset = true;
  if (change.metadata) target.metadata = change.metadata;
  if (change.files) {
    if (!target.files) target.files = {};
    const t = target.files;
    if (change.files.created) t.created = appended(t.created, change.files.created);
    if (change.files.deleted) t.deleted = appended(t.deleted, change.files.deleted);
  }
  const notes = (change as { [NOTES]?: Notes })[NOTES];
  if (notes) mergeNotes(notesFor(target), notes);
}

/**
 * Folds the features a change deleted and created again with their IDs into updates (see
 * `feature.updated`): one each, from what it was before the change to what it is now. The
 * updates of such a feature before its deletion and after its creation fold into it. A feature
 * created by the change before it was deleted is left as it is
 */
function foldMadeAgain(features: NonNullable<StoreChange['features']>): void {
  const { created, deleted } = features;
  if (!created?.length || !deleted?.length) return;
  const gone = new Map<string, Feature>();
  for (const feature of deleted) if (!gone.has(feature.id)) gone.set(feature.id, feature);
  const madeBefore = new Set(created);
  const again = created.filter((feature) => {
    const before = gone.get(feature.id);
    return before !== undefined && !madeBefore.has(before);
  });
  if (again.length === 0) return;
  const ids = new Set(again.map((feature) => feature.id));
  type Update = NonNullable<typeof features.updated>[number];
  const updates = new Map<string, Update[]>();
  const kept: Update[] = [];
  for (const update of features.updated ?? []) {
    if (!ids.has(update.id)) {
      kept.push(update);
      continue;
    }
    const list = updates.get(update.id) ?? [];
    list.push(update);
    updates.set(update.id, list);
  }
  for (const feature of again) {
    const before = gone.get(feature.id) as Feature;
    const list = updates.get(feature.id) ?? [];
    // The updates up to the value deleted came before the deletion, the others after the creation
    const last = list.findIndex((update) => update.feature === before);
    const after = list.slice(last + 1);
    kept.push({
      id: feature.id,
      feature: after.length > 0 ? after[after.length - 1].feature : feature,
      previous: last >= 0 ? list[0].previous : before,
    });
  }
  features.created = created.filter((feature) => !ids.has(feature.id));
  features.deleted = deleted.filter((feature) => !ids.has(feature.id));
  features.updated = kept;
  if (features.created.length === 0) delete features.created;
  if (features.deleted.length === 0) delete features.deleted;
}

/** Whether a change tells a change of the document (not of the state of this client alone) */
function changesDocument(change: StoreChange): boolean {
  return (
    change.features !== undefined ||
    change.layers !== undefined ||
    change.groups !== undefined ||
    change.layerReorder !== undefined ||
    change.groupReorder !== undefined ||
    change.metadata !== undefined ||
    change.files !== undefined ||
    change.reset === true
  );
}

/** Whether a change holds nothing */
function isEmptyChange(change: StoreChange): boolean {
  return Object.keys(change).length === 0;
}

/** The fields of a layer the Store holds, in the order of a layer of the library */
function storedLayerOf(layer: Partial<Layer> & { id: string }): PublicLayer {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(layer)) {
    if (key === 'items') continue;
    out[key] = frozenValue((layer as Record<string, unknown>)[key]);
  }
  return out as unknown as PublicLayer;
}

/** The fields of a group the Store holds, with the key of its place */
function storedGroupOf(group: Omit<Group, 'featureIds'>, orderKey: string): StoreGroup {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(group)) {
    if (key === 'featureIds') continue;
    out[key] = frozenValue((group as unknown as Record<string, unknown>)[key]);
  }
  out.orderKey = orderKey;
  return out as unknown as StoreGroup;
}

/** The values of some of the rows of values (by their positions, in order) */
function selectRows(values: RowValues, at: readonly number[]): RowValues {
  const rows = Int32Array.from(at, (i) => values.rows[i]);
  const fields = new Map<FeatureRowField, unknown[]>();
  for (const [field, column] of values.fields)
    fields.set(
      field,
      at.map((i) => column[i]),
    );
  const out: {
    rows: Int32Array;
    fields: typeof fields;
    geometry?: GeometryColumn;
    deleted?: Uint8Array;
  } = { rows, fields };
  if (values.deleted) out.deleted = Uint8Array.from(at, (i) => values.deleted?.[i] ?? 0);
  const g = values.geometry;
  if (g) {
    const types = new Uint8Array(at.length);
    const partStarts = new Int32Array(at.length + 1);
    const ringStarts: number[] = [0];
    const positionStarts: number[] = [0];
    const coordinates: number[] = [];
    const n = g.valuesPerPosition;
    at.forEach((row, k) => {
      types[k] = g.types[row];
      for (let p = g.partStarts[row]; p < g.partStarts[row + 1]; p++) {
        for (let r = g.ringStarts[p]; r < g.ringStarts[p + 1]; r++) {
          for (let v = g.positionStarts[r]; v < g.positionStarts[r + 1]; v++) {
            for (let c = 0; c < n; c++) coordinates.push(g.coordinates[v * n + c]);
          }
          positionStarts.push(coordinates.length / n);
        }
        ringStarts.push(positionStarts.length - 1);
      }
      partStarts[k + 1] = ringStarts.length - 1;
    });
    out.geometry = {
      types,
      coordinates: Float64Array.from(coordinates),
      valuesPerPosition: n,
      partStarts,
      ringStarts: Int32Array.from(ringStarts),
      positionStarts: Int32Array.from(positionStarts),
    };
  }
  return out;
}

/**
 * The keys of `count` items between two keys (undefined for no bound), in order: halved from
 * the middle, so that many keys between two stay short
 */
function keysBetween(
  below: string | undefined,
  above: string | undefined,
  count: number,
): string[] {
  const out = new Array<string>(count);
  const between = (lo: string | undefined, hi: string | undefined): string => {
    try {
      return createOrderKeyBetween(lo, hi);
    } catch {
      // Two items with the same key around the place (written so from elsewhere): after the one
      // behind
      return createOrderKeyBetween(lo, undefined);
    }
  };
  if (above === undefined) {
    let last = below;
    for (let i = 0; i < count; i++) {
      last = between(last, undefined);
      out[i] = last;
    }
    return out;
  }
  const fill = (from: number, to: number, lo: string | undefined, hi: string | undefined): void => {
    if (from >= to) return;
    const middle = (from + to) >> 1;
    const key = between(lo, hi);
    out[middle] = key;
    fill(from, middle, lo, key);
    fill(middle + 1, to, key, hi);
  };
  fill(0, count, below, above);
  return out;
}

/** An order with one of its IDs moved to a position (throws when the order does not hold it) */
function movedWithin(order: readonly string[], id: string, index: number): string[] {
  const at = order.indexOf(id);
  if (at === -1) throw new Error(`Item "${id}" not found`);
  const out = [...order];
  out.splice(at, 1);
  out.splice(index, 0, id);
  return out;
}

/** An item of an order: its key, and its ID, which orders the items of the same key */
interface Placed {
  readonly id: string;
  readonly key: string;
}

/** The order of two placed items */
/** Whether the fields of a write of a row are those of its place alone */
function isPlace(fields: ReadonlyMap<FeatureRowField, unknown>): boolean {
  for (const name of fields.keys()) {
    if (name !== 'parent' && name !== 'orderKey') return false;
  }
  return true;
}

function comparePlaced(a: Placed, b: Placed): number {
  return compareKeys(a.key, b.key) || compareKeys(a.id, b.id);
}

/**
 * The positions of the longest run of the items, in order, whose keys already rise: the items
 * that keep their keys when an order is written
 */
function risingRun(keys: readonly (Placed | undefined)[]): Set<number> {
  const tails: number[] = [];
  const before = new Array<number>(keys.length).fill(-1);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    if (!key) continue;
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (comparePlaced(keys[tails[mid]] as Placed, key) < 0) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) before[i] = tails[lo - 1];
    tails[lo] = i;
  }
  const kept = new Set<number>();
  let at = tails.length > 0 ? tails[tails.length - 1] : -1;
  while (at >= 0) {
    kept.add(at);
    at = before[at];
  }
  return kept;
}

/** The order of an item written as an order of a container that it is not in yet */
interface Listing {
  /** The layer or the group whose order lists it */
  readonly container: string;
  /** The order written */
  readonly order: readonly string[];
  /** Its position in it */
  readonly index: number;
}

/** A feature made, and when it was made: the layer keeps the latest it made */
interface IteratorState {
  readonly gone: Set<number>;
}

/** A weak reference to an object: it does not keep the object from being collected */
interface WeakReference<T extends object> {
  deref(): T | undefined;
}

/** The global `WeakRef` of the engines the library runs on (its types come after ES2020) */
interface WeakReferences {
  readonly WeakRef: new <T extends object>(target: T) => WeakReference<T>;
}

/** Whether a value is a set of IDs read through its methods (not an array or another iterable) */
function isIdSet(value: Iterable<string> | IdSet): value is IdSet {
  return typeof (value as Partial<IdSet>).iterate === 'function' && !Array.isArray(value);
}

/** A set of IDs (a copy of them) without those `leaves` says leave it; the set itself for none */
function idSetWithout(ids: IdSet, leaves: (id: string) => boolean): IdSet {
  const kept: string[] = [];
  for (const id of ids.iterate()) if (!leaves(id)) kept.push(id);
  return kept.length === ids.count() ? ids : makeIdSet(kept);
}

/** References, each once, in the order they come first (the array itself when none repeats) */
function uniqueRefs(refs: Int32Array): Int32Array {
  if (refs.length < 2) return refs;
  let least = refs[0];
  let most = refs[0];
  for (let i = 1; i < refs.length; i++) {
    if (refs[i] < least) least = refs[i];
    else if (refs[i] > most) most = refs[i];
  }
  const seen = new Uint32Array(((most - least) >>> 5) + 1);
  const out = new Int32Array(refs.length);
  let count = 0;
  for (let i = 0; i < refs.length; i++) {
    const at = refs[i] - least;
    const bit = 1 << (at & 31);
    if ((seen[at >>> 5] & bit) !== 0) continue;
    seen[at >>> 5] |= bit;
    out[count++] = refs[i];
  }
  return count === refs.length ? refs : out.slice(0, count);
}

/** Whether a box `[west, south, east, north]` lies wholly inside one of the boxes */
function insideOne(
  box: readonly [number, number, number, number] | null,
  boxes: readonly BoundingBox[],
): boolean {
  if (!box) return false;
  for (const outer of boxes) {
    if (
      box[0] >= outer.minX &&
      box[1] >= outer.minY &&
      box[2] <= outer.maxX &&
      box[3] <= outer.maxY
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Makes the layer over a Store of rows. The instance makes one and hands it to its parts.
 *
 * @param client - The state of this client the instance holds (a new one when left out)
 * @internal
 */
export function createDocumentAccess(
  store: RowStore,
  client: ClientState = new ClientState(),
): InstanceDocument {
  const { tables } = store;
  const counts: WorkCounts | undefined = workCountsOf(store);

  /**
   * What waits for the Store to have told its change to all of its listeners: the changes written
   * to the Store directly, told to the subscribers of the layer then (throws `invalidInput` for a
   * Store whose tables are not those of a built-in Store)
   */
  let afterTold: Array<() => void> = [];
  onChangeTold(tables, () => {
    const waiting = afterTold;
    afterTold = [];
    for (const fn of waiting) fn();
  });

  // ==========================================================================
  // The notification of the layer
  // ==========================================================================

  const listeners = new Set<(change: StoreChange) => void>();
  /** How deep the transactions of the layer are */
  let busDepth = 0;
  /** What the transaction under way changed, told when it ends */
  let pending: StoreChange = {};
  let pendingFolds = newFolds();
  let busSource: UpdateSource = 'local';
  /**
   * What the writes of the instance changed in the document since it was last followed: told
   * with the change of the Store it belongs to, as one change of the document
   */
  let documentPending: StoreChange = {};
  let documentFolds = newFolds();
  /** Whether the writes of the instance wait for the change of a transaction of the Store */
  let awaitingRows = false;
  /** The orders before the change being built, and those of the change being told */
  let ordersBefore = new Map<string, readonly string[]>();
  let toldOrdersBefore: Map<string, readonly string[]> | null = null;
  let watchingMoves: () => boolean = () => false;

  // ==========================================================================
  // The notes of the changes, in the words of the features
  // ==========================================================================

  /** Who reads the changes in the words of the features */
  let watch: ChangeWatch | null = null;
  /** Whether the features the changes write are noted */
  const wanted = (): boolean => watch?.wanted() === true;
  /** What the watcher answered for the transaction under way, and its operation */
  let askedNow: unknown = null;
  let operationNow: number | undefined;
  const rowIds: RowIds = {
    getRowId: (ref) => tables.getRowId(ref),
    getRowRef: (id) => tables.getRowRef(id),
  };
  /**
   * The sets of the rows handed out, held weakly: told the rows each change deletes, so that each
   * keeps the IDs it was given
   */
  const liveSets = new Set<WeakReference<RowIdSet>>();
  let setsMade = 0;

  /** The sets handed out that are still there (the others are left out) */
  const forgetGoneSets = (): void => {
    for (const held of liveSets) if (!held.deref()) liveSets.delete(held);
  };

  /** A set of the rows noted, in the order they were noted */
  const setOfRows = (rows: NotedRows): IdSet => {
    const set = new RowIdSet(rowIds, Int32Array.from(rows.values()));
    countWork(counts, 'objectsCreated', 2);
    if (rows.size > 0) {
      setsMade += 1;
      if (setsMade % 256 === 0) forgetGoneSets();
      liveSets.add(new (globalThis as unknown as WeakReferences).WeakRef(set));
    }
    return set;
  };

  /** The rows a change deleted leave the sets handed out: each copies the IDs of its own */
  const rowsLeaveSets = (change: RowChange): void => {
    if (liveSets.size === 0 || !change.rows) return;
    const lists: Int32Array[] = [];
    let count = 0;
    for (const rows of change.rows.layers.values()) {
      if (rows.deleted.length === 0) continue;
      lists.push(rows.deleted);
      count += rows.deleted.length;
    }
    if (count === 0) return;
    for (const held of liveSets) {
      const set = held.deref();
      if (!set) {
        liveSets.delete(held);
        continue;
      }
      countWork(counts, 'objectsCreated', set.rowsDeleted(lists, count));
    }
  };

  // ==========================================================================
  // The sets of the features this client selects, held as their rows
  // ==========================================================================

  /**
   * A set of the rows of features, held weakly as the sets of a change are: told the rows each
   * change deletes, so that it keeps the IDs it was given
   *
   * @param refs - The references of the rows, each once (the set keeps them as they are)
   */
  const featureSetOfRows = (refs: Int32Array): IdSet => {
    const set = new RowIdSet(rowIds, refs);
    countWork(counts, 'objectsCreated');
    if (refs.length > 0) {
      setsMade += 1;
      if (setsMade % 256 === 0) forgetGoneSets();
      liveSets.add(new (globalThis as unknown as WeakReferences).WeakRef(set));
    }
    return set;
  };

  /** The references of the rows of the features of IDs, in the order given, each once */
  const featureRowsOf = (ids: Iterable<string>): Int32Array => {
    let refs = new Int32Array(16);
    let count = 0;
    for (const id of ids) {
      const ref = typeof id === 'string' ? tables.getRowRef(id) : undefined;
      if (ref === undefined) continue;
      if (count === refs.length) {
        const grown = new Int32Array(refs.length * 2);
        grown.set(refs);
        refs = grown;
      }
      refs[count++] = ref;
    }
    countWork(counts, 'objectsCreated');
    return uniqueRefs(count === refs.length ? refs : refs.slice(0, count));
  };

  /**
   * The references of the rows the features of a set are now, in the order of the set: those of a
   * set of rows this layer made as it holds them, the others read by their IDs
   */
  const rowsOfFeatureSet = (ids: IdSet): Int32Array =>
    ids instanceof RowIdSet && ids.readsFrom(rowIds) ? ids.rowRefs() : featureRowsOf(ids.iterate());

  /**
   * The features of IDs as a set of their rows, in the order given, each once (an ID that names no
   * feature is left out); a set of rows this layer made whose rows are all there is given back
   */
  const featureSetOf = (ids: Iterable<string> | IdSet): IdSet => {
    if (ids instanceof RowIdSet && ids.readsFrom(rowIds)) {
      const refs = ids.rowRefs();
      return refs.length === ids.count() ? ids : featureSetOfRows(refs.slice());
    }
    return featureSetOfRows(featureRowsOf(isIdSet(ids) ? ids.iterate() : ids));
  };

  /**
   * The set of features without the IDs `leaves` says leave it, in its order, read from its rows
   * (the set itself when none leaves it and its rows are all there)
   */
  const featureSetWithout = (ids: IdSet, leaves: (id: string) => boolean): IdSet => {
    const refs = rowsOfFeatureSet(ids);
    const kept = new Int32Array(refs.length);
    let count = 0;
    for (let i = 0; i < refs.length; i++) {
      const id = tables.getRowId(refs[i]);
      if (id !== undefined && !leaves(id)) kept[count++] = refs[i];
    }
    const ours = ids instanceof RowIdSet && ids.readsFrom(rowIds);
    if (ours && count === refs.length && count === ids.count()) return ids;
    return featureSetOfRows(kept.slice(0, count));
  };

  /** What this client hides, as IDs and as the rows of the features it hides */
  const hiddenNow = (): { ids: ReadonlySet<string>; rows: ReadonlySet<number> | null } => {
    const ids = client.listHidden();
    let rows: Set<number> | null = null;
    for (const id of ids) {
      const ref = tables.getRowRef(id);
      if (ref === undefined) continue;
      rows ??= new Set();
      rows.add(ref);
    }
    return { ids, rows };
  };

  /**
   * Marks the rows of one layer that can be seen, and that can be selected when `selectable`:
   * the visible flag of the row and that of its group, and what this client hides, read from the
   * columns of the rows without the features being made (the layer itself is not looked at)
   *
   * @returns One entry per row: 1 for a row seen, 0 for one that is not
   */
  const markShownRows = (
    layerId: string,
    refs: Int32Array,
    hidden: { ids: ReadonlySet<string>; rows: ReadonlySet<number> | null },
    selectable: boolean,
  ): { marks: Uint8Array; fields: ReadonlyMap<FeatureRowField, readonly unknown[]> } => {
    const fields = tables.readValues(
      refs,
      selectable ? ['visible', 'locked', 'parent', 'orderKey', 'type'] : ['visible', 'parent'],
    ).fields;
    countWork(counts, 'objectsCreated');
    const visible = fields.get('visible') ?? [];
    const locked = fields.get('locked') ?? [];
    const parents = fields.get('parent') ?? [];
    const groups = new Map<string, boolean>();
    /** Whether the members of a group can be seen (and selected) as far as the group says */
    const groupLets = (groupId: string): boolean => {
      let lets = groups.get(groupId);
      if (lets === undefined) {
        const group = store.getGroup(groupId);
        lets =
          group === undefined ||
          (group.visible !== false &&
            !hidden.ids.has(groupId) &&
            (!selectable || group.locked !== true));
        groups.set(groupId, lets);
      }
      return lets;
    };
    const marks = new Uint8Array(refs.length);
    for (let i = 0; i < refs.length; i++) {
      if (visible[i] === false || hidden.rows?.has(refs[i])) continue;
      if (selectable && locked[i] === true) continue;
      const parent = parents[i] as string;
      if (parent !== layerId && !groupLets(parent)) continue;
      marks[i] = 1;
    }
    return { marks, fields };
  };

  /**
   * The rows of the features given, by the layers they are in, in the order of the layers: the
   * positions of each in the references given, and their references
   */
  const rowsByLayer = (
    refs: Int32Array,
  ): Array<{ layerId: string; at: Int32Array; refs: Int32Array }> => {
    const out: Array<{ layerId: string; at: Int32Array; refs: Int32Array }> = [];
    if (refs.length === 0) return out;
    const placed = new Uint8Array(refs.length);
    let left = refs.length;
    for (const layerId of layerIdsInOrder(true)) {
      if (left === 0) break;
      const view = tables.get(layerId);
      if (!view || view.rowCount === 0) continue;
      const at = new Int32Array(left);
      let count = 0;
      for (let i = 0; i < refs.length; i++) {
        if (placed[i] === 1 || view.getRowType(refs[i]) === null) continue;
        placed[i] = 1;
        at[count++] = i;
      }
      if (count === 0) continue;
      left -= count;
      const own = new Int32Array(count);
      for (let k = 0; k < count; k++) own[k] = refs[at[k]];
      out.push({ layerId, at: at.subarray(0, count), refs: own });
    }
    countWork(counts, 'objectsCreated', out.length);
    return out;
  };

  /** Whether the features of a layer can be seen, and selected when `selectable`, as far as it says */
  const layerLets = (layerId: string, hiddenIds: ReadonlySet<string>, selectable: boolean) => {
    const base = store.getLayer(layerId);
    return (
      base !== undefined &&
      base.visible !== false &&
      !hiddenIds.has(layerId) &&
      (!selectable || base.locked !== true)
    );
  };

  /**
   * The set of features without those that cannot be seen (their own visible flag, that of their
   * group or their layer, or this client hiding one of them), read from the rows without the
   * features being made: the set itself when every one is seen
   */
  const shownFeatureSetOf = (ids: IdSet): IdSet => {
    if (ids.count() === 0) return ids;
    writePendingPlaces();
    const refs = rowsOfFeatureSet(ids);
    const hidden = hiddenNow();
    const keep = new Uint8Array(refs.length);
    let kept = 0;
    for (const part of rowsByLayer(refs)) {
      if (!layerLets(part.layerId, hidden.ids, false)) continue;
      const { marks } = markShownRows(part.layerId, part.refs, hidden, false);
      for (let k = 0; k < marks.length; k++) {
        if (marks[k] === 0) continue;
        keep[part.at[k]] = 1;
        kept += 1;
      }
    }
    const ours = ids instanceof RowIdSet && ids.readsFrom(rowIds);
    if (ours && kept === refs.length && refs.length === ids.count()) return ids;
    const out = new Int32Array(kept);
    let at = 0;
    for (let i = 0; i < refs.length; i++) if (keep[i] === 1) out[at++] = refs[i];
    return featureSetOfRows(out);
  };

  /**
   * The features of layers that can be seen, as a set of their rows: in the order of the layers
   * given, each layer in its order (the features of its groups at their place). The set is a copy
   * of the rows the layers hold now, which later changes of the layers do not change
   */
  const shownFeatureSetOfLayers = (layerIds: readonly string[]): IdSet => {
    writePendingPlaces();
    const hidden = hiddenNow();
    const parts: Int32Array[] = [];
    let total = 0;
    for (const layerId of new Set(layerIds)) {
      if (!layerLets(layerId, hidden.ids, false)) continue;
      const rows = rowsOfLayer(layerId);
      if (rows.length === 0) continue;
      const { marks } = markShownRows(layerId, rows, hidden, false);
      let count = 0;
      for (let i = 0; i < marks.length; i++) count += marks[i];
      const own = new Int32Array(count);
      let at = 0;
      for (let i = 0; i < rows.length; i++) if (marks[i] === 1) own[at++] = rows[i];
      parts.push(own);
      total += count;
    }
    const out = parts.length === 1 ? parts[0] : new Int32Array(total);
    if (parts.length > 1) {
      let at = 0;
      for (const part of parts) {
        out.set(part, at);
        at += part.length;
      }
    }
    countWork(counts, 'objectsCreated', parts.length);
    return featureSetOfRows(out);
  };

  /**
   * The rows of the candidates of a box that can be selected, in stacking order from the back:
   * shown (as `shownFeatureSetOf` reads it) and not locked (the row, its group and its layer),
   * read from the rows without the features being made. Each is marked with whether the box of
   * its positions lies wholly inside one of the boxes
   */
  const listSelectableRows = (
    candidateIds: Iterable<string>,
    boxes: readonly BoundingBox[],
    decided: (type: string) => boolean,
  ): SelectableRows => {
    writePendingPlaces();
    const refs = featureRowsOf(candidateIds);
    const hidden = hiddenNow();
    const outRefs = new Int32Array(refs.length);
    const outInside = new Uint8Array(refs.length);
    let taken = 0;
    for (const part of rowsByLayer(refs)) {
      if (!layerLets(part.layerId, hidden.ids, true)) continue;
      const view = tables.get(part.layerId);
      if (!view) continue;
      const { marks, fields } = markShownRows(part.layerId, part.refs, hidden, true);
      const parents = fields.get('parent') ?? [];
      const keys = fields.get('orderKey') ?? [];
      const types = fields.get('type') ?? [];
      const decidedTypes = new Map<string, boolean>();
      const decides = (type: string): boolean => {
        let answer = decidedTypes.get(type);
        if (answer === undefined) {
          answer = decided(type);
          decidedTypes.set(type, answer);
        }
        return answer;
      };
      let count = 0;
      for (let k = 0; k < marks.length; k++) count += marks[k];
      const order = new Int32Array(count);
      let at = 0;
      for (let k = 0; k < marks.length; k++) if (marks[k] === 1) order[at++] = k;
      // The stacking order within the layer: the items by their keys (a group at its place),
      // then the features of a group by theirs; the IDs are read only for keys that are equal
      const own = part.refs;
      const layerId = part.layerId;
      const groupKeys = new Map<string, string>();
      const itemKeyOf = (k: number): string => {
        const parent = parents[k] as string;
        if (parent === layerId) return String(keys[k] ?? '');
        let key = groupKeys.get(parent);
        if (key === undefined) {
          key = store.getGroup(parent)?.orderKey ?? '';
          groupKeys.set(parent, key);
        }
        return key;
      };
      const itemIdOf = (k: number): string => {
        const parent = parents[k] as string;
        return parent === layerId ? (tables.getRowId(own[k]) ?? '') : parent;
      };
      order.sort((a, b) => {
        const keyA = itemKeyOf(a);
        const keyB = itemKeyOf(b);
        if (keyA !== keyB) return compareKeys(keyA, keyB);
        const byItem = compareKeys(itemIdOf(a), itemIdOf(b));
        if (byItem !== 0 || parents[a] === layerId) return byItem;
        const memberA = String(keys[a] ?? '');
        const memberB = String(keys[b] ?? '');
        if (memberA !== memberB) return compareKeys(memberA, memberB);
        return compareKeys(tables.getRowId(own[a]) ?? '', tables.getRowId(own[b]) ?? '');
      });
      for (let i = 0; i < order.length; i++) {
        const ref = own[order[i]];
        const wholly = decides(String(types[order[i]])) && insideOne(view.getRowBBox(ref), boxes);
        outRefs[taken] = ref;
        outInside[taken] = wholly ? 1 : 0;
        taken += 1;
      }
    }
    countWork(counts, 'objectsCreated', 2);
    return { refs: outRefs.subarray(0, taken), inside: outInside.subarray(0, taken) };
  };

  /** Notes the features a change of the instance wrote (`features` of the change) */
  const noteOwnFeatures = (change: StoreChange, target: StoreChange): void => {
    if (!change.features || !wanted()) return;
    const notes = notesFor(target);
    notes.features = true;
    for (const feature of change.features.created ?? []) {
      const ref = tables.getRowRef(feature.id);
      if (ref !== undefined) noteCreated(notes, feature.id, ref);
    }
    for (const { id, feature, previous } of change.features.updated ?? []) {
      const ref = tables.getRowRef(id);
      if (ref === undefined) continue;
      const placeChanged =
        previous.layerId !== feature.layerId || previous.groupId !== feature.groupId;
      if (placeChanged) noteMoved(notes, id, ref);
      if (valuesChanged(feature, previous) || (!placeChanged && !notes.moved.has(id))) {
        noteUpdated(notes, id, ref);
      }
    }
    for (const feature of change.features.deleted ?? []) noteDeleted(notes, feature.id);
  };

  /** The sets of IDs of a change whose features were not noted, read from its features */
  const notesOfFeatures = (change: StoreChange): Notes => {
    const notes = newNotes();
    // A replacement of the whole document: what it took out, then what it wrote
    const reset = change.reset === true;
    if (reset) {
      for (const feature of change.features?.deleted ?? []) noteTakenOut(notes, feature.id);
    }
    for (const feature of change.features?.created ?? []) {
      const ref = tables.getRowRef(feature.id);
      if (ref !== undefined) noteCreated(notes, feature.id, ref);
    }
    for (const { id, feature, previous } of change.features?.updated ?? []) {
      const ref = tables.getRowRef(id);
      if (ref === undefined) continue;
      const placeChanged =
        previous.layerId !== feature.layerId || previous.groupId !== feature.groupId;
      if (placeChanged) noteMoved(notes, id, ref);
      if (!placeChanged || valuesChanged(feature, previous)) noteUpdated(notes, id, ref);
    }
    if (!reset) {
      for (const feature of change.features?.deleted ?? []) noteDeleted(notes, feature.id);
    }
    return notes;
  };

  /** The summary of a change told (see `ChangeSummary`) */
  const summaryOf = (notes: Notes, change: StoreChange): ChangeSummary => {
    let ids: ChangedIds | null = null;
    const metadataKeys = notes.metadataKeys ? Object.freeze([...notes.metadataKeys]) : undefined;
    return {
      operationId: notes.operationId ?? operationNow ?? 0,
      hasMoreParts: notes.hasMoreParts,
      stopped: notes.stopped,
      ids() {
        if (ids) return ids;
        const noted = notes.features || !change.features ? notes : notesOfFeatures(change);
        ids = Object.freeze({
          created: setOfRows(noted.created),
          updated: setOfRows(noted.updated),
          deleted: makeIdSet(noted.deleted),
          moved: setOfRows(noted.moved),
        });
        return ids;
      },
      groupsMoved: notes.groupsMoved,
      layerOrder: notes.layerOrder,
      metadataKeys,
      valuesBefore: notes.valuesBefore,
      askedBy: notes.askedBy,
      claimDeletedRows() {
        if (notes.claimed || notes.tokens.length === 0) return undefined;
        notes.claimed = true;
        const tokens = notes.tokens.splice(0);
        let released = false;
        return () => {
          if (released) return;
          released = true;
          for (const token of tokens) store.releaseDeletedRows(token);
        };
      },
      wholeGeometry: notes.wholeGeometry,
      groupsDeleted: notes.groupsDeleted,
    };
  };

  /** Lets go of the rows the tokens of a change keep, unless one who read it took them */
  const releaseTokensOf = (change: StoreChange): void => {
    const notes = notesOf(change);
    if (!notes) return;
    for (const token of notes.tokens.splice(0)) store.releaseDeletedRows(token);
  };

  /** What a change of the Store did that the changes of the layer do not say, noted with it */
  const notesOfRows = (change: RowChange): Notes => {
    const notes = newNotes();
    notes.operationId = change.operationId;
    notes.hasMoreParts = change.hasMoreParts;
    notes.stopped = change.stopped;
    if (change.layers?.orderChanged) {
      notes.layerOrder = {
        order: [...change.layers.orderChanged.order],
        previous: [...change.layers.orderChanged.previous],
      };
    }
    if (change.metadata) notes.metadataKeys = new Set(change.metadata.keys);
    const createdGroups = new Set((change.groups?.created ?? []).map((group) => group.id));
    for (const { id, group, previous } of change.groups?.updated ?? []) {
      if (createdGroups.has(id)) continue;
      if (group.layerId === previous.layerId && group.orderKey === previous.orderKey) continue;
      notes.groupsMoved.set(id, { layerId: previous.layerId, key: previous.orderKey });
    }
    for (const group of change.groups?.deleted ?? []) {
      notes.groupsDeleted.set(group.id, { layerId: group.layerId, key: group.orderKey });
    }
    if (askedNow !== null) {
      notes.askedBy = askedNow;
      notes.valuesBefore = change.previousValues;
    }
    askedNow = null;
    if (wholeGeometryNow) {
      notes.wholeGeometry = true;
      wholeGeometryNow = false;
    }
    return notes;
  };

  const mergeDocument = (change: StoreChange): void => {
    // While the places of many rows wait to be written, what the writes did waits with them
    const target = placeScope ? placeScope.change : documentPending;
    noteOwnFeatures(change, target);
    appendChange(target, change, placeScope ? placeScope.folds : documentFolds);
  };

  const merge = (change: StoreChange): void => {
    appendChange(pending, change, pendingFolds);
    if (busDepth === 0) flush();
  };

  /**
   * The operations a part was told of that more parts follow: their last part is told even when
   * it changes nothing, so that the subscribers of the layer see each operation end
   */
  const partsTold = new Set<number>();

  /**
   * Whether a change that holds nothing is told all the same: the last change of an operation
   * that stopped, and the last part of an operation a part of which was told
   */
  const toldWhenEmpty = (notes: Notes | undefined): boolean => {
    if (notes?.operationId === undefined) return false;
    return notes.stopped || (!notes.hasMoreParts && partsTold.has(notes.operationId));
  };

  /** Keeps or forgets the operation of a change told (a replacement forgets the others) */
  const partTold = (notes: Notes, reset: boolean): void => {
    const { operationId } = notes;
    if (reset) {
      for (const open of partsTold) if (open !== operationId) partsTold.delete(open);
    }
    if (operationId === undefined) return;
    if (notes.hasMoreParts) partsTold.add(operationId);
    else partsTold.delete(operationId);
  };

  /**
   * The part of an operation written in parts that the outermost transaction of the instance
   * writes now (a transaction given the number of its operation), and whether more parts follow
   * it, as the transactions inside it say
   */
  let partScope: { readonly operationId: number; more: boolean } | null = null;
  /**
   * The IDs the parts of each operation written in parts deleted: they leave the selection, the
   * editing and the items this client hides at once, when the last part of the operation is told
   */
  const goneInParts = new Map<number, Set<string>>();

  /** Notes the IDs a change of a part deleted, for the end of its operation */
  const noteGoneInPart = (operationId: number, change: StoreChange): void => {
    let gone = goneInParts.get(operationId);
    for (const list of [change.features?.deleted, change.groups?.deleted, change.layers?.deleted]) {
      if (!list || list.length === 0) continue;
      gone ??= new Set();
      for (const item of list) gone.add(item.id);
    }
    if (gone) goneInParts.set(operationId, gone);
  };

  /** The IDs the parts of an operation deleted leave the state of this client, at once */
  const forgetGoneInParts = (operationId: number): void => {
    const gone = goneInParts.get(operationId);
    goneInParts.delete(operationId);
    if (gone && gone.size > 0) client.forgetAll(gone);
  };

  /**
   * A change as the state of this client follows it in a part of an operation: without what it
   * deleted, which the end of the operation forgets, and with only the updates of groups and
   * layers that show or hide them (the others, such as an order that lost a feature, would take
   * what no longer exists out of the selection now)
   */
  const withoutDeleted = (change: StoreChange): StoreChange => {
    const followed: StoreChange = { ...change };
    if (change.features?.deleted) followed.features = { ...change.features, deleted: undefined };
    if (change.groups) {
      followed.groups = {
        ...change.groups,
        deleted: undefined,
        updated: change.groups.updated?.filter(
          ({ group, previous }) => group.visible !== previous.visible,
        ),
      };
    }
    if (change.layers) {
      followed.layers = {
        ...change.layers,
        deleted: undefined,
        updated: change.layers.updated?.filter(
          ({ layer, previous }) => layer.visible !== previous.visible,
        ),
      };
    }
    return followed;
  };

  /** Takes the changes of the document the writes made into the change, and follows them */
  const followDocument = (): void => {
    const part = partScope;
    if (isEmptyChange(documentPending)) {
      if (part && !part.more && goneInParts.has(part.operationId)) {
        busTransact(() => forgetGoneInParts(part.operationId), busSource);
      }
      return;
    }
    const change = documentPending;
    documentPending = {};
    documentFolds = newFolds();
    busTransact(() => {
      appendChange(pending, change, pendingFolds);
      if (!part) {
        client.followDocument(change, drawing.dragState !== null);
        return;
      }
      // A part of an operation: what it deleted leaves the state of this client once the
      // operation ends, in one write
      noteGoneInPart(part.operationId, change);
      client.followDocument(withoutDeleted(change), drawing.dragState !== null);
      if (!part.more) forgetGoneInParts(part.operationId);
    }, busSource);
  };

  const flush = (): void => {
    if (awaitingRows) return;
    if (isEmptyChange(pending) && !toldWhenEmpty(notesOf(pending))) {
      ordersBefore = new Map();
      releaseTokensOf(pending);
      return;
    }
    const change = pending;
    change.source = busSource;
    pending = {};
    pendingFolds = newFolds();
    // A replacement of the whole document tells what it took out and what it wrote as both
    if (change.features && change.reset !== true) foldMadeAgain(change.features);
    if (changesDocument(change) || toldWhenEmpty(notesOf(change))) {
      const notes = notesFor(change);
      Object.defineProperty(change, SUMMARY, { value: summaryOf(notes, change) });
      partTold(notes, change.reset === true);
    }
    const orders = ordersBefore;
    ordersBefore = new Map();
    if (delivering) {
      // Written while a change is told: told once that change has reached every listener. The
      // sets of its IDs are made now, so that they follow the rows deleted meanwhile
      if (wanted()) summaryOfChange(change)?.ids();
      toTell.push({ change, orders });
      return;
    }
    delivering = true;
    try {
      tell(change, orders);
      // The changes the listeners wrote, in the order they were written
      for (let next = toTell.shift(); next; next = toTell.shift()) tell(next.change, next.orders);
    } finally {
      delivering = false;
      toTell.length = 0;
    }
  };

  /** Whether a change is being told to the listeners of the layer */
  let delivering = false;
  /** The changes written while a change is told, with the orders before them, to tell after it */
  const toTell: Array<{ change: StoreChange; orders: Map<string, readonly string[]> }> = [];

  /** Tells a change to every listener of the layer */
  const tell = (change: StoreChange, orders: Map<string, readonly string[]>): void => {
    toldOrdersBefore = orders;
    // A notification of the state of this client alone is counted as the Store counts its own
    // (one that tells a change of the document follows the notification of the Store)
    if (!changesDocument(change)) countWork(counts, 'notifications');
    try {
      for (const listener of [...listeners]) {
        try {
          listener(change);
        } catch (error) {
          console.error('Error in a store listener:', error);
        }
      }
    } finally {
      toldOrdersBefore = null;
      trimCache();
      // The rows the change deleted that no one took go once it has been told
      releaseTokensOf(change);
    }
  };

  function busTransact<T>(fn: () => T, source: UpdateSource): T {
    if (busDepth === 0) busSource = source;
    busDepth += 1;
    try {
      return fn();
    } finally {
      busDepth -= 1;
      if (busDepth === 0) flush();
    }
  }

  // ==========================================================================
  // The transactions of the Store
  // ==========================================================================

  /** How deep the transactions of the instance on the Store are */
  let rowDepth = 0;
  /**
   * Whether the transaction of the instance open writes whole geometries (see
   * `DocumentOperations.markWholeGeometry`): noted with its change
   */
  let wholeGeometryNow = false;
  let rowSource: UpdateSource = 'local';
  /** Whether a transaction of the instance on the Store is being opened */
  let opening = false;
  /** Whether the transaction opened is the outermost one of the Store */
  let openedOutermost = false;
  /** The source of the last outermost transaction of the Store */
  let lastOuterSource: UpdateSource | null = null;
  /** Whether the instance wrote to the Store since its last change arrived */
  let wroteRows = false;
  /** How many times the document was written, by the instance or directly to the Store */
  let documentVersion = 0;
  /** A write of the instance to the Store */
  const wrote = (): void => {
    wroteRows = true;
    documentVersion += 1;
  };
  /** What the writes of the instance touched since the last change of the Store arrived */
  let ownRows = new Set<number>();
  let ownLayers = new Set<string>();
  let ownGroups = new Set<string>();
  let ownFiles = new Set<string>();
  let ownMetadata = false;
  let ownOrder = false;

  /** Asked by the Store at the start of each outermost transaction */
  const asksValuesBefore = (change: {
    readonly source: UpdateSource;
    readonly operationId: number;
  }): boolean => {
    // A new outermost transaction: the one the writes of the instance waited for has ended
    // without a change, and what waited is told now
    if (awaitingRows) releaseAwaiting(lastOuterSource ?? rowSource);
    lastOuterSource = change.source;
    operationNow = change.operationId;
    askedNow = watch ? (watch.asksValues(change) ?? null) : null;
    if (opening) {
      openedOutermost = true;
      // The values before of the writes of the instance only for the watcher that asks for them
      return askedNow !== null;
    }
    return true;
  };

  /** Tells what waited for a change of the Store that did not come */
  const releaseAwaiting = (source: UpdateSource): void => {
    if (!awaitingRows) return;
    awaitingRows = false;
    busDepth -= 1;
    busSource = source;
    clearOwn();
    followDocument();
    if (busDepth === 0) flush();
  };

  const clearOwn = (): void => {
    wroteRows = false;
    ownRows = new Set();
    ownLayers = new Set();
    ownGroups = new Set();
    ownFiles = new Set();
    ownMetadata = false;
    ownOrder = false;
  };

  /** Runs `fn` in a transaction of the Store, folding into one of the Store already open */
  function rowTransact<T>(fn: () => T, source: UpdateSource, options?: StoreTransactOptions): T {
    if (rowDepth > 0) return store.transact(fn, rowSource, options);
    const run = (): T => {
      opening = false;
      rowDepth += 1;
      try {
        return withOperation(fn);
      } finally {
        rowDepth -= 1;
      }
    };
    opening = true;
    openedOutermost = false;
    rowSource = source;
    let result: T;
    try {
      result = store.transact(run, source, options);
    } catch (error) {
      const nested =
        opening &&
        error instanceof DrawError &&
        error.code === 'invalidState' &&
        lastOuterSource !== null &&
        lastOuterSource !== source;
      if (!nested) {
        opening = false;
        throw error;
      }
      // Inside a transaction of the Store opened from elsewhere: the writes fold into it
      opening = false;
      rowSource = lastOuterSource as UpdateSource;
      result = store.transact(run, rowSource, options);
    } finally {
      opening = false;
      // The change of an outermost transaction has been told: its mark goes with it
      if (openedOutermost) wholeGeometryNow = false;
    }
    if (!openedOutermost && wroteRows && !awaitingRows) {
      // The change of the Store comes when the transaction opened from elsewhere ends: what
      // the writes made is held back until then (once, however many writes there are)
      awaitingRows = true;
      busDepth += 1;
    }
    return result;
  }

  // ==========================================================================
  // The writes the Store refuses
  // ==========================================================================

  /** How many writes of the Store were refused */
  let refusals = 0;
  /** How many writes of the Store applied */
  let storeWrites = 0;
  /**
   * The transaction that stops at the first write the Store refuses (see
   * `transactUntilRefused`): the number of the refusals when it started
   */
  let stopScope: { readonly mark: number } | null = null;

  /** Stops the write of the layer under way: the Store refused one of its writes */
  const refuse = (): never => {
    refusals += 1;
    throw new RefusedWrite();
  };

  /**
   * The layers being deleted (see `setLayersBeingDeleted`), and how deep the writes of their
   * deletion are, which the mark does not refuse
   */
  let layersBeingDeleted: ReadonlySet<string> | null = null;
  let deletionDepth = 0;

  /**
   * Stops the write of the layer under way, as a refusal of the Store, when it touches a layer
   * being deleted (outside the writes of the deletion)
   */
  const refuseInDeletion = (...layerIds: readonly (string | undefined)[]): void => {
    if (layersBeingDeleted === null || deletionDepth > 0) return;
    for (const layerId of layerIds) {
      if (layerId !== undefined && layersBeingDeleted.has(layerId)) refuse();
    }
  };

  /** The layer of a group, or undefined for no group */
  const layerOfGroup = (groupId: string | undefined): string | undefined =>
    groupId === undefined ? undefined : store.getGroup(groupId)?.layerId;

  /** A write of the Store: applied, or the write of the layer stops */
  const stored = (applied: boolean): void => {
    if (!applied) refuse();
    storeWrites += 1;
    if (placeScope) placeScope.wrote = true;
  };

  /** Whether the transaction that stops at a refusal has stopped */
  const stopped = (): boolean => stopScope !== null && refusals !== stopScope.mark;

  /**
   * Runs `fn` in one transaction of the instance; when it is the outermost one, the Store refused
   * a write in it and applied none, nothing of it is told (what the writes of the layer noted
   * before the refusal names nothing the Store holds)
   */
  const transactRefusable = <T>(fn: () => T, source: UpdateSource): T => {
    const outermost = busDepth === 0 && rowDepth === 0 && !awaitingRows;
    const mark = refusals;
    const writes = storeWrites;
    return transact(() => {
      try {
        return fn();
      } finally {
        if (outermost && refusals !== mark && storeWrites === writes) {
          documentPending = {};
          documentFolds = newFolds();
        }
      }
    }, source);
  };

  /**
   * Runs one write of the layer: false when the Store refused one of its writes (what it applied
   * before is kept and told), or when the transaction that stops at a refusal has stopped
   */
  const attempt = (fn: () => void, source: UpdateSource): boolean => {
    if (stopped()) return false;
    const mark = refusals;
    try {
      transactRefusable(fn, source);
    } catch (error) {
      if (!(error instanceof RefusedWrite)) throw error;
    }
    return refusals === mark;
  };

  /**
   * Runs `fn` as one transaction that stops at the first write the Store refuses: the writes of
   * the layer after it are not written. Null once a write was refused
   */
  const transactUntilRefused = <T>(fn: () => T, source: UpdateSource): T | null => {
    if (stopped()) return null;
    const outer = stopScope;
    const scope = { mark: refusals };
    stopScope = scope;
    try {
      const value = transactRefusable(fn, source);
      return refusals === scope.mark ? value : null;
    } catch (error) {
      if (error instanceof RefusedWrite) return null;
      throw error;
    } finally {
      stopScope = outer;
    }
  };

  /**
   * Runs one transaction of the instance: the writes, then the change they make, told once. The
   * options go to the transaction of the Store as they are
   */
  function transact<T>(
    fn: () => T,
    source: UpdateSource = 'local',
    options?: StoreTransactOptions,
  ): T {
    if (partScope !== null || rowDepth > 0 || options?.operationId === undefined) {
      // Inside a part: a transaction that says more parts follow makes the part one of them
      if (partScope !== null && options?.hasMoreParts === true) partScope.more = true;
      return transactOnce(fn, source, options);
    }
    partScope = { operationId: options.operationId, more: options.hasMoreParts === true };
    try {
      return transactOnce(fn, source, options);
    } finally {
      partScope = null;
    }
  }

  /** Runs one transaction of the instance (see `transact`) */
  function transactOnce<T>(fn: () => T, source: UpdateSource, options?: StoreTransactOptions): T {
    return client.hold(() =>
      busTransact(() => {
        try {
          return rowTransact(fn, busDepth > 1 ? busSource : source, options);
        } finally {
          // What was written before a throw stays, and is told
          if (rowDepth === 0 && !awaitingRows) {
            clearOwn();
            followDocument();
          }
        }
      }, source),
    );
  }

  // ==========================================================================
  // The operations of the instance (what is settled at their end)
  // ==========================================================================

  let operationDepth = 0;
  /** The features taken out of their group or put in another layer, listed at the end */
  const pendingFeaturePlacement = new Set<string>();
  /** The groups created that no order lists, with the place they take at the end */
  const pendingGroupPlacement = new Map<string, { layerId: string; index: number }>();
  /** The IDs an order written left out (they are listed nowhere until something lists them) */
  const unlisted = new Set<string>();
  /** The IDs an order written lists before they are items of its container */
  const listings = new Map<string, Listing>();

  /** Settles the placements: one the Store refuses stops them (the writes tell it) */
  const settleUnlessRefused = (): void => {
    try {
      settlePlacements();
    } catch (error) {
      if (!(error instanceof RefusedWrite)) throw error;
    }
  };

  function withOperation<T>(fn: () => T): T {
    operationDepth += 1;
    let refused = false;
    try {
      return fn();
    } catch (error) {
      if (error instanceof RefusedWrite) refused = true;
      throw error;
    } finally {
      operationDepth -= 1;
      if (operationDepth === 0) {
        if (refused || stopped()) {
          // An operation stopped by a refusal places nothing more
          pendingGroupPlacement.clear();
          pendingFeaturePlacement.clear();
        } else {
          settleUnlessRefused();
        }
        unlisted.clear();
        listings.clear();
      }
    }
  }

  // ==========================================================================
  // The features made from the rows
  // ==========================================================================

  const featureCache = new Map<string, Feature>();
  /**
   * How many callers keep the features made beyond the limit (`holdFeatures`). A transaction of
   * the layer keeps them too, until its change has been told: the features a write made are then
   * read without their rows by the subscribers of its change
   */
  let cacheHolds = 0;

  /** Lets go of the features kept made beyond the limit, the oldest first */
  const trimCache = (): void => {
    if (cacheHolds > 0 || busDepth > 0) return;
    while (featureCache.size > FEATURE_CACHE_LIMIT) {
      const oldest = featureCache.keys().next().value;
      if (oldest === undefined) break;
      featureCache.delete(oldest);
    }
  };

  const remember = (feature: Feature): void => {
    featureCache.delete(feature.id);
    featureCache.set(feature.id, feature);
    if (cacheHolds === 0 && busDepth === 0 && featureCache.size > FEATURE_CACHE_LIMIT) {
      const oldest = featureCache.keys().next().value;
      if (oldest !== undefined) featureCache.delete(oldest);
    }
  };

  /** The layer and the group of the parent of a row */
  const placeOf = (parent: unknown): { layerId: string; groupId: string | undefined } => {
    const id = String(parent);
    if (store.getLayer(id)) return { layerId: id, groupId: undefined };
    const group = store.getGroup(id);
    if (group) return { layerId: group.layerId, groupId: id };
    return { layerId: id, groupId: undefined };
  };

  /** Makes the features of rows of one layer, the deleted rows kept included */
  const makeFeatures = (refs: Int32Array, ids: readonly string[]): Feature[] => {
    if (refs.length === 0) return [];
    const keys = store.listPropertyKeys(refs);
    const fields: FeatureRowField[] = [
      ...FEATURE_FIELDS,
      ...keys.map((key) => `${PROPERTY_FIELD}${key}` as FeatureRowField),
    ];
    let values = tables.readValues(refs, fields);
    // The parents of a write of many places under way, as written
    if (pendingPlaces && pendingPlaces.size > 0) {
      const parents = [...(values.fields.get('parent') ?? [])];
      for (let i = 0; i < refs.length; i++) {
        const parent = pendingPlaces.get(refs[i])?.fields.get('parent');
        if (parent !== undefined) parents[i] = parent;
      }
      values = { ...values, fields: new Map(values.fields).set('parent', parents) };
    }
    countWork(counts, 'objectsCreated', refs.length);
    return featuresOfValues(values, ids, placeOf);
  };

  /** The feature of a row, made from it unless it is kept made */
  const featureOfRow = (ref: number, id: string): Feature => {
    const known = featureCache.get(id) ?? featureRead(id);
    if (known) return known;
    const [feature] = makeFeatures(Int32Array.of(ref), [id]);
    remember(feature);
    return feature;
  };

  const getFeature = (id: string): Feature | undefined => {
    if (typeof id !== 'string') return undefined;
    const known = featureCache.get(id) ?? featureRead(id);
    if (known) {
      remember(known);
      return known;
    }
    const ref = tables.getRowRef(id);
    if (ref === undefined) return undefined;
    return featureOfRow(ref, id);
  };

  /** The references of the rows of a layer, in its order (the rows of its groups at their place) */
  const rowsOfLayer = (layerId: string): Int32Array => {
    writePendingPlaces();
    const view = tables.get(layerId);
    if (!view || view.rowCount === 0) return new Int32Array(0);
    return view.listRowRefs(0, view.rowCount);
  };

  /** The features of rows of one layer, the ones kept made as they are */
  const featuresOfRows = (refs: Int32Array): Feature[] => {
    const out = new Array<Feature>(refs.length);
    const missing: number[] = [];
    const missingIds: string[] = [];
    for (let i = 0; i < refs.length; i++) {
      const id = tables.getRowId(refs[i]) as string;
      const known = featureCache.get(id) ?? featureRead(id);
      if (known) out[i] = known;
      else {
        missing.push(i);
        missingIds.push(id);
      }
    }
    if (missing.length > 0) {
      const made = makeFeatures(
        Int32Array.from(missing, (i) => refs[i]),
        missingIds,
      );
      missing.forEach((at, k) => {
        out[at] = made[k];
      });
    }
    return out;
  };

  /** The IDs of the layers in stacking order, then the layers the order does not hold */
  const layerIdsInOrder = (withOffOrder: boolean): string[] => {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const id of store.getLayerOrder()) {
      if (store.getLayer(id) && !seen.has(id)) {
        seen.add(id);
        out.push(id);
      }
    }
    if (withOffOrder) {
      for (const layer of store.listLayers()) {
        if (!seen.has(layer.id)) out.push(layer.id);
      }
    }
    return out;
  };

  /**
   * The features of the whole document in stacking order, as last read, kept while the document
   * is not written: the parts that read every feature (the drawing, the hit testing) read it
   * again without the features being made again. The features of the layers that are not on the
   * stacking order are at the end of the one with them.
   */
  const everyFeature: {
    version: number;
    inOrder: Feature[] | null;
    withOffOrder: Feature[] | null;
    byId: Map<string, Feature> | null;
  } = { version: -1, inOrder: null, withOffOrder: null, byId: null };

  /** The features of the whole document as last read, while they are what the document holds */
  const everyFeatureNow = (): typeof everyFeature => {
    if (everyFeature.version !== documentVersion) {
      everyFeature.version = documentVersion;
      everyFeature.inOrder = null;
      everyFeature.withOffOrder = null;
      everyFeature.byId = null;
    }
    return everyFeature;
  };

  /** A feature of the whole document as last read, while it is what the document holds */
  const featureRead = (id: string): Feature | undefined => {
    const every = everyFeatureNow();
    const list = every.withOffOrder ?? every.inOrder;
    if (!list) return undefined;
    if (!every.byId) every.byId = new Map(list.map((feature) => [feature.id, feature]));
    return every.byId.get(id);
  };

  const listFeaturesInOrder = (withOffOrder: boolean): Feature[] => {
    const every = everyFeatureNow();
    const known = withOffOrder ? every.withOffOrder : every.inOrder;
    if (known) return known.slice();
    const out: Feature[] = [];
    for (const layerId of layerIdsInOrder(withOffOrder)) {
      for (const feature of featuresOfRows(rowsOfLayer(layerId))) out.push(feature);
    }
    if (withOffOrder) every.withOffOrder = out;
    else every.inOrder = out;
    every.byId = null;
    return out.slice();
  };

  // ==========================================================================
  // The layers and the groups, with the order of what they hold
  // ==========================================================================

  const layerVersions = new Map<string, number>();
  const groupVersions = new Map<string, number>();
  const layerWrappers = new Map<string, { base: PublicLayer; version: number; layer: Layer }>();
  const groupWrappers = new Map<string, { base: StoreGroup; version: number; group: Group }>();

  const bumpLayer = (id: string): void => {
    layerVersions.set(id, (layerVersions.get(id) ?? 0) + 1);
  };
  const bumpGroup = (id: string): void => {
    groupVersions.set(id, (groupVersions.get(id) ?? 0) + 1);
  };

  /** The IDs of the items of a layer at the positions `[start, end)` */
  const itemIdsOf = (layerId: string, start = 0, end = Number.POSITIVE_INFINITY): string[] => {
    writePendingPlaces();
    const view = tables.get(layerId);
    if (!view) return [];
    const from = Math.max(0, Math.min(start, view.itemCount));
    const to = Math.max(from, Math.min(end, view.itemCount));
    if (to === from) return [];
    const { kinds, refs } = view.listItemRefs(from, to - from);
    const out = new Array<string>(refs.length);
    for (let i = 0; i < refs.length; i++) {
      out[i] =
        (kinds[i] === ROW_ITEM ? tables.getRowId(refs[i]) : tables.getGroupId(refs[i])) ?? '';
    }
    return out;
  };

  /** The references of the rows of a group, and its layer's rows */
  const memberRefsOf = (groupId: string, start = 0, end = Number.POSITIVE_INFINITY) => {
    writePendingPlaces();
    const group = store.getGroup(groupId);
    const groupRef = tables.findGroup(groupId);
    const view = group ? tables.get(group.layerId) : undefined;
    if (!group || groupRef === undefined || !view) return new Int32Array(0);
    const count = view.countGroupMembers(groupRef);
    const from = Math.max(0, Math.min(start, count));
    const to = Math.max(from, Math.min(end, count));
    if (to === from) return new Int32Array(0);
    return view.listGroupMembers(groupRef, from, to - from);
  };

  const memberIdsOf = (groupId: string, start?: number, end?: number): string[] =>
    Array.from(memberRefsOf(groupId, start, end), (ref) => tables.getRowId(ref) ?? '');

  const countMembers = (groupId: string): number => {
    writePendingPlaces();
    const group = store.getGroup(groupId);
    const groupRef = tables.findGroup(groupId);
    const view = group ? tables.get(group.layerId) : undefined;
    if (!group || groupRef === undefined || !view) return 0;
    return view.countGroupMembers(groupRef);
  };

  /** A layer of the Store with the order of its items, read when it is read */
  const layerOf = (base: PublicLayer | undefined): Layer | undefined => {
    if (!base) return undefined;
    const version = layerVersions.get(base.id) ?? 0;
    const known = layerWrappers.get(base.id);
    if (known && known.base === base && known.version === version) return known.layer;
    const layer: Record<string, unknown> = {};
    for (const key of Object.keys(base)) {
      if (key === 'items') continue;
      layer[key] = (base as unknown as Record<string, unknown>)[key];
    }
    let items: readonly string[] | undefined;
    Object.defineProperty(layer, 'items', {
      enumerable: false,
      get: () => {
        items ??= Object.freeze(itemIdsOf(base.id));
        return items;
      },
    });
    Object.freeze(layer);
    layerWrappers.set(base.id, { base, version, layer: layer as unknown as Layer });
    return layer as unknown as Layer;
  };

  /** A group of the Store with the order of its features, read when it is read */
  const groupOf = (base: StoreGroup | undefined): Group | undefined => {
    if (!base) return undefined;
    const version = groupVersions.get(base.id) ?? 0;
    const known = groupWrappers.get(base.id);
    if (known && known.base === base && known.version === version) return known.group;
    const group: Record<string, unknown> = {};
    for (const key of Object.keys(base)) {
      if (key === 'orderKey' || key === 'featureIds') continue;
      group[key] = (base as unknown as Record<string, unknown>)[key];
    }
    let featureIds: readonly string[] | undefined;
    Object.defineProperty(group, 'featureIds', {
      enumerable: false,
      get: () => {
        featureIds ??= Object.freeze(memberIdsOf(base.id));
        return featureIds;
      },
    });
    Object.freeze(group);
    groupWrappers.set(base.id, { base, version, group: group as unknown as Group });
    return group as unknown as Group;
  };

  const getLayer = (id: string): Layer | undefined => layerOf(store.getLayer(id));

  /** Where a feature is and its flags, read from its row (see `DocumentPlaces`) */
  const getFeaturePlace = (id: string): FeaturePlace | undefined => {
    if (typeof id !== 'string') return undefined;
    const ref = tables.getRowRef(id);
    if (ref === undefined) return undefined;
    writePendingPlaces();
    const fields = tables.readValues(Int32Array.of(ref), ['visible', 'locked', 'parent']).fields;
    return {
      id,
      ...placeOf(fields.get('parent')?.[0]),
      visible: fields.get('visible')?.[0] !== false,
      locked: fields.get('locked')?.[0] === true,
    };
  };
  const getGroup = (id: string): Group | undefined => groupOf(store.getGroup(id));

  /** Whether the row of a reference is locked, a deleted row kept included (see `DocumentPlaces`) */
  const isRowLocked = (ref: number, layerId?: string): boolean => {
    if (typeof ref !== 'number' || tables.getRowId(ref) === undefined) return false;
    writePendingPlaces();
    const fields = tables.readValues(Int32Array.of(ref), ['locked', 'parent']).fields;
    if (fields.get('locked')?.[0] === true) return true;
    const parent = String(fields.get('parent')?.[0]);
    const group = store.getLayer(parent) ? undefined : store.getGroup(parent);
    if (group?.locked === true) return true;
    const layerOfRow = group ? group.layerId : store.getLayer(parent) ? parent : layerId;
    return layerOfRow !== undefined && store.getLayer(layerOfRow)?.locked === true;
  };

  /** The values of fields of the rows of features, a run of the rows of one layer (see `DocumentPlaces`) */
  const readFeatureValues = (
    ids: readonly string[],
    fields: readonly FeatureRowField[],
    start = 0,
  ): FeatureValuesRead => {
    writePendingPlaces();
    const from = Math.max(0, Math.min(start, ids.length));
    const refs = new Int32Array(ids.length - from);
    const indices = new Int32Array(ids.length - from);
    let count = 0;
    let at = from;
    // The rows of the layer of the first row read; a row of another layer ends the run
    let view: LayerTableView | undefined;
    for (; at < ids.length; at++) {
      const id = ids[at];
      const ref = typeof id === 'string' ? tables.getRowRef(id) : undefined;
      if (ref === undefined) continue;
      if (view === undefined) {
        view = tables.get(layerOfRow(ref));
        if (view === undefined) continue;
      } else if (view.getRowType(ref) === null) {
        break;
      }
      refs[count] = ref;
      indices[count] = at;
      count += 1;
    }
    const values = tables.readValues(refs.subarray(0, count), fields);
    countWork(counts, 'objectsCreated', 3);
    return { values, indices: indices.subarray(0, count), end: at };
  };

  // ==========================================================================
  // The keys of the order
  // ==========================================================================

  const rowKeyOf = (ref: number): string =>
    (pendingPlaces?.get(ref)?.fields.get('orderKey') as string | undefined) ??
    (tables.readValues(Int32Array.of(ref), ['orderKey']).fields.get('orderKey')?.[0] as string) ??
    '';

  /**
   * The rows of features being created, not written to the Store yet (see `createFeatureRows`):
   * their containers and keys, which the reads of the order take as written
   */
  let pendingRows: Map<string, { container: string; key: string }> | null = null;

  /** The key of an item of a layer (a row outside a group, or a group), or undefined */
  const itemKeyOf = (id: string): string | undefined => {
    const pendingRow = pendingRows?.get(id);
    if (pendingRow) return pendingRow.key;
    const group = store.getGroup(id);
    if (group) return group.orderKey;
    const ref = tables.getRowRef(id);
    return ref === undefined ? undefined : rowKeyOf(ref);
  };

  /** Whether an ID is an item of a container: a row or a group of a layer, a row of a group */
  const containerOfItem = (id: string): string | undefined => {
    const pendingRow = pendingRows?.get(id);
    if (pendingRow) return pendingRow.container;
    const group = store.getGroup(id);
    if (group) return group.layerId;
    const ref = tables.getRowRef(id);
    if (ref === undefined) return undefined;
    return parentOfRow(ref);
  };

  /** The items of a container at positions, as placed items */
  const placedOf = (container: string, start: number, end: number): Placed[] => {
    if (store.getGroup(container)) {
      const refs = memberRefsOf(container, start, end);
      if (refs.length === 0) return [];
      const keys = tables.readValues(refs, ['orderKey']).fields.get('orderKey') ?? [];
      return Array.from(refs, (ref, i) => ({
        id: tables.getRowId(ref) ?? '',
        key: keys[i] as string,
      }));
    }
    const ids = itemIdsOf(container, start, end);
    return ids.map((id) => ({ id, key: itemKeyOf(id) ?? '' }));
  };

  const countOf = (container: string): number => {
    writePendingPlaces();
    return store.getGroup(container)
      ? countMembers(container)
      : (tables.get(container)?.itemCount ?? 0);
  };

  /** The position of an item in its container, by its key (-1 when it is not there) */
  const positionOf = (container: string, item: Placed): number => {
    let lo = 0;
    let hi = countOf(container);
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const at = placedOf(container, mid, mid + 1)[0];
      if (!at) return -1;
      const order = comparePlaced(at, item);
      if (order === 0) return mid;
      if (order < 0) lo = mid + 1;
      else hi = mid;
    }
    return -1;
  };

  /**
   * The keys around a position of a container, once the items given have left it: the position
   * counts from the back, and is the front when it is undefined
   */
  const boundsAt = (
    container: string,
    ids: readonly string[],
    index: number | undefined,
  ): { below: string | undefined; above: string | undefined } => {
    const moving = new Set(ids);
    // The items given that stand in the container now, in order
    const inside: Placed[] = [];
    for (const id of ids) {
      if (containerOfItem(id) !== container) continue;
      const key = itemKeyOf(id);
      if (key !== undefined) inside.push({ id, key });
    }
    inside.sort(comparePlaced);
    const total = countOf(container);
    const remaining = total - inside.length;
    let below: string | undefined;
    let above: string | undefined;
    if (index === undefined || index >= remaining) {
      // At the front: behind it, the frontmost item that does not move
      let end = total;
      while (end > 0 && below === undefined) {
        const start = Math.max(0, end - inside.length - 1);
        const window = placedOf(container, start, end);
        for (let i = window.length - 1; i >= 0; i--) {
          if (!moving.has(window[i].id)) {
            below = window[i].key;
            break;
          }
        }
        end = start;
      }
      return { below, above };
    }
    // The items at the positions index - 1 and index once the items given have left
    const movedBefore = (item: Placed): number => {
      let lo = 0;
      let hi = inside.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (comparePlaced(inside[mid], item) < 0) lo = mid + 1;
        else hi = mid;
      }
      return lo;
    };
    const start = Math.max(0, index - 1);
    const window = placedOf(container, start, Math.min(total, index + inside.length + 1));
    for (let i = 0; i < window.length; i++) {
      const item = window[i];
      if (moving.has(item.id)) continue;
      const at = start + i - movedBefore(item);
      if (at === index - 1) below = item.key;
      if (at === index) {
        above = item.key;
        break;
      }
    }
    return { below, above };
  };

  /** The keys of the items given at a position of a container, once they have left it */
  const keysAt = (
    container: string,
    ids: readonly string[],
    index: number | undefined,
  ): string[] => {
    const { below, above } = boundsAt(container, ids, index);
    return keysBetween(below, above, ids.length);
  };

  /** The key of the front of a container */
  const tailKeyOf = (container: string): string =>
    keysBetween(endKeysOf(container).front, undefined, 1)[0];

  /** The key of the item just in front of a group in its layer (undefined at the front) */
  const keyInFrontOf = (group: StoreGroup): string | undefined => {
    const at = positionOf(group.layerId, { id: group.id, key: group.orderKey });
    if (at < 0) return undefined;
    return placedOf(group.layerId, at + 1, at + 2)[0]?.key;
  };

  /**
   * The key of an item an order written lists, at its place among the items of that order the
   * container holds now
   */
  const keyOfListing = (listing: Listing): string => {
    const { container, order, index } = listing;
    let below: string | undefined;
    let above: string | undefined;
    for (let i = index - 1; i >= 0 && below === undefined; i--) {
      if (containerOfItem(order[i]) === container) below = itemKeyOf(order[i]);
    }
    // Nothing the container holds lies beyond the frontmost item of the order it holds
    const front = frontOfListing(container, order);
    for (let i = index + 1; i <= front && above === undefined; i++) {
      if (containerOfItem(order[i]) === container) above = itemKeyOf(order[i]);
    }
    if (below !== undefined && above !== undefined && compareKeys(below, above) >= 0) {
      above = undefined;
    }
    return keysBetween(below, above, 1)[0];
  };

  // ==========================================================================
  // The keys of the ends of the containers
  // ==========================================================================

  /**
   * The keys of the back and the front of the containers (layers and groups), as the layer last
   * read or wrote them, so that a feature created at the front does not read the order: updated
   * by the writes of the layer, and forgotten when a change written to the Store directly
   * creates, deletes or moves rows of the container, or writes their keys
   */
  const endKeys = new Map<string, { back: string | undefined; front: string | undefined }>();

  /** The keys of the ends of a container, read once until they are forgotten */
  const endKeysOf = (
    container: string,
  ): { back: string | undefined; front: string | undefined } => {
    let known = endKeys.get(container);
    if (!known) {
      const count = countOf(container);
      known =
        count === 0
          ? { back: undefined, front: undefined }
          : {
              back: placedOf(container, 0, 1)[0]?.key,
              front: placedOf(container, count - 1, count)[0]?.key,
            };
      endKeys.set(container, known);
    }
    return known;
  };

  /** A new item takes this key at the front of a container */
  const frontTaken = (container: string, key: string): void => {
    const known = endKeys.get(container);
    if (!known) return;
    known.front = key;
    if (known.back === undefined) known.back = key;
  };

  /** A new item takes this key somewhere in a container: the ends move when it is beyond them */
  const keyTaken = (container: string, key: string): void => {
    const known = endKeys.get(container);
    if (!known) return;
    if (known.front === undefined || compareKeys(key, known.front) > 0) known.front = key;
    if (known.back === undefined || compareKeys(key, known.back) < 0) known.back = key;
  };

  /**
   * How many times the places of items were written: the ends of the containers are forgotten,
   * and the positions of the orders written are read again (see `frontOfListing`)
   */
  let placeVersion = 0;

  /**
   * The position of the frontmost item of an order written that its container holds, kept while
   * the places are written only by the items of the orders taking their places (see
   * `listingPlaced`), so that the items of a long order placed one after another do not read it
   * whole each time
   */
  const listingFronts = new WeakMap<
    readonly string[],
    { container: string; index: number; version: number }
  >();

  const frontOfListing = (container: string, order: readonly string[]): number => {
    const known = listingFronts.get(order);
    if (known && known.version === placeVersion && known.container === container) {
      return known.index;
    }
    let index = -1;
    for (let i = order.length - 1; i >= 0; i--) {
      if (containerOfItem(order[i]) === container) {
        index = i;
        break;
      }
    }
    listingFronts.set(order, { container, index, version: placeVersion });
    return index;
  };

  /**
   * An item of an order written took its place, and nothing else was placed since `version`:
   * the position of the front of the order follows it
   */
  const listingPlaced = (listing: Listing, version: number): void => {
    const known = listingFronts.get(listing.order);
    if (!known || known.container !== listing.container || known.version !== version) return;
    listingFronts.set(listing.order, {
      container: listing.container,
      index: Math.max(known.index, listing.index),
      version: placeVersion,
    });
  };

  /** Forgets the keys of the ends of the containers, after a write of the places of items */
  const placesWritten = (): void => {
    endKeys.clear();
    placeVersion += 1;
  };

  /**
   * Whether a key is that of an end of a container, as the keys of its ends are kept: true for a
   * key that is not known (undefined), false for a container whose ends are not kept
   */
  const isEndKey = (container: string, key: string | undefined): boolean => {
    const known = endKeys.get(container);
    if (!known) return false;
    return key === undefined || key === known.front || key === known.back;
  };

  /**
   * Whether the rows of a layer a change written to the Store directly deleted leave the ends
   * kept where they are: each is read from its values before the change (its container and its
   * key), and none is an end of its container
   */
  const deletedAwayFromEnds = (rows: Int32Array, before: RowValues | undefined): boolean => {
    const parents = before?.fields.get('parent');
    const keys = before?.fields.get('orderKey');
    if (!before || !parents || !keys) return false;
    const at = new Map<number, number>();
    for (let i = 0; i < before.rows.length; i++) at.set(before.rows[i], i);
    for (const ref of rows) {
      const i = at.get(ref);
      const key = i === undefined ? undefined : keys[i];
      if (i === undefined || typeof key !== 'string') return false;
      if (isEndKey(String(parents[i]), key)) return false;
    }
    return true;
  };

  /**
   * Forgets the keys of the ends, and the positions of the orders written, that a change written
   * to the Store directly may have moved
   */
  const forgetEndKeys = (change: RowChange, foreign: StoreChange): void => {
    if (change.reset || foreign.groups || foreign.layers?.deleted || foreign.layers?.created) {
      placesWritten();
      return;
    }
    for (const [layerId, rows] of change.rows?.layers ?? []) {
      const deleted = rows.deleted.filter((ref) => !ownRows.has(ref));
      const moved =
        rows.created.some((ref) => !ownRows.has(ref)) ||
        ((rows.fields.has('parent') || rows.fields.has('orderKey')) &&
          rows.updated.some((ref) => !ownRows.has(ref)));
      if (!moved && deleted.length > 0) {
        // The positions of the orders written are read again; the ends only when one went
        placeVersion += 1;
        if (deletedAwayFromEnds(deleted, change.previousValues?.get(layerId))) continue;
      } else if (!moved) {
        continue;
      }
      placeVersion += 1;
      for (const container of [...endKeys.keys()]) {
        if (container === layerId) endKeys.delete(container);
        else {
          const group = store.getGroup(container);
          if (!group || group.layerId === layerId) endKeys.delete(container);
        }
      }
    }
  };

  // ==========================================================================
  // The writes of rows
  // ==========================================================================

  /**
   * The places of rows written while a write of many places runs (see `placesTogether`), not
   * written to the Store yet: by reference, the layer the row is in and the fields of its place.
   * The reads of the place of a row take them as written, and a read of the order or of the
   * values of rows writes them first
   */
  let pendingPlaces: Map<
    number,
    { layerId: string; fields: Map<FeatureRowField, unknown> }
  > | null = null;
  /** The groups the features taken out of them left, while a write of many places runs */
  let pendingLeftGroups: string[] | null = null;

  /** The parent of a row, as written */
  const parentOfRow = (ref: number): string =>
    (pendingPlaces?.get(ref)?.fields.get('parent') as string | undefined) ??
    (tables.readValues(Int32Array.of(ref), ['parent']).fields.get('parent')?.[0] as string);

  /**
   * Writes the places taken (see `pendingPlaces`): one write of the Store per layer, for the rows
   * whose places have the same fields, in the order they were taken
   */
  const writePendingPlaces = (): void => {
    const places = pendingPlaces;
    if (!places || places.size === 0) return;
    pendingPlaces = new Map();
    const writes = new Map<string, { refs: number[]; fields: Map<FeatureRowField, unknown[]> }>();
    for (const [ref, { layerId, fields }] of places) {
      const names = [...fields.keys()].sort();
      const at = `${layerId}\n${names.join('\n')}`;
      let write = writes.get(at);
      if (!write) {
        write = { refs: [], fields: new Map(names.map((name) => [name, []])) };
        writes.set(at, write);
      }
      write.refs.push(ref);
      for (const [name, value] of fields) write.fields.get(name)?.push(value);
    }
    const batches = [...writes.values()];
    for (let i = 0; i < batches.length; i++) {
      const rows = Int32Array.from(batches[i].refs);
      if (!store.writeRows({ rows, fields: batches[i].fields })) {
        // The rows of this write and of the writes after it are not written
        for (let k = i; k < batches.length; k++) {
          for (const ref of batches[k].refs) placeScope?.refused.add(ref);
        }
        refuse();
      }
      storeWrites += 1;
      if (placeScope) {
        placeScope.wrote = true;
        for (const ref of rows) placeScope.applied.add(ref);
      }
    }
  };

  /**
   * What the writes of the layer did while the places of many rows waited to be written (see
   * `placesTogether`): told with the writes when the places are written, and without what the
   * Store refused to write
   */
  interface PlaceScope {
    readonly change: StoreChange;
    readonly folds: Folds;
    /** The rows whose places the Store wrote */
    readonly applied: Set<number>;
    /** The rows whose places the Store refused, or that were not written after a refusal */
    readonly refused: Set<number>;
    /** Whether a write of the Store applied */
    wrote: boolean;
  }
  let placeScope: PlaceScope | null = null;

  /**
   * Ends what waited with the places of many rows: added to the change being built; after a
   * refusal, without the features whose places were not written (they are read again from their
   * rows), and nothing at all when no write applied
   */
  const endPlaceScope = (scope: PlaceScope, refused: boolean): void => {
    placeScope = null;
    const { change } = scope;
    if (refused) {
      const gone = new Set<string>();
      for (const ref of scope.refused) {
        if (scope.applied.has(ref)) continue;
        const id = tables.getRowId(ref);
        if (id !== undefined) gone.add(id);
      }
      for (const id of gone) {
        featureCache.delete(id);
        pendingFeaturePlacement.delete(id);
      }
      if (!scope.wrote) return;
      const features = change.features;
      if (features && gone.size > 0) {
        if (features.created) features.created = features.created.filter((f) => !gone.has(f.id));
        if (features.updated) features.updated = features.updated.filter((u) => !gone.has(u.id));
        if (features.deleted) features.deleted = features.deleted.filter((f) => !gone.has(f.id));
        for (const key of ['created', 'updated', 'deleted'] as const) {
          if (features[key]?.length === 0) delete features[key];
        }
        if (Object.keys(features).length === 0) delete change.features;
      }
      const notes = (change as { [NOTES]?: Notes })[NOTES];
      if (notes) {
        for (const id of gone) {
          notes.created.delete(id);
          notes.updated.delete(id);
          notes.moved.delete(id);
          notes.deleted.delete(id);
        }
      }
    }
    if (!isEmptyChange(change)) appendChange(documentPending, change, documentFolds);
  };

  /**
   * Runs a write of the places of many rows: the places are written when it ends, one write of
   * the Store per layer (a write of the Store that places one row puts the whole order of its
   * layer in place again), and the groups the features left empty are deleted then
   */
  const placesTogether = (fn: () => void): void => {
    if (pendingPlaces) {
      fn();
      return;
    }
    pendingPlaces = new Map();
    pendingLeftGroups = [];
    const scope: PlaceScope = {
      change: {},
      folds: newFolds(),
      applied: new Set(),
      refused: new Set(),
      wrote: false,
    };
    placeScope = scope;
    let left: string[] = [];
    try {
      try {
        fn();
      } catch (error) {
        // A refusal stops the write: the places taken are not written
        if (error instanceof RefusedWrite) {
          for (const ref of pendingPlaces?.keys() ?? []) scope.refused.add(ref);
          pendingPlaces?.clear();
        }
        throw error;
      } finally {
        left = pendingLeftGroups;
        writePendingPlaces();
      }
    } catch (error) {
      pendingPlaces = null;
      pendingLeftGroups = null;
      endPlaceScope(scope, error instanceof RefusedWrite);
      throw error;
    }
    pendingPlaces = null;
    pendingLeftGroups = null;
    endPlaceScope(scope, false);
    for (const groupId of new Set(left)) {
      if (store.getGroup(groupId) && countMembers(groupId) === 0) deleteGroupRow(groupId);
    }
  };

  /** Writes fields of one row */
  const writeRow = (
    ref: number,
    fields: Map<FeatureRowField, unknown[]>,
    geometry?: Geometry,
  ): void => {
    if (fields.size === 0 && geometry === undefined) return;
    /** What a write of the place of the row changes besides the row */
    const placeWritten = (): void => {
      if (!fields.has('parent') && !fields.has('orderKey')) return;
      placesWritten();
      if (wanted()) {
        const id = tables.getRowId(ref);
        if (id !== undefined) noteMoved(notesFor(placeScope?.change ?? documentPending), id, ref);
      }
    };
    if (pendingPlaces && geometry === undefined && isPlace(fields)) {
      placeWritten();
      ownRows.add(ref);
      wrote();
      const known = pendingPlaces.get(ref);
      if (known) {
        for (const [name, values] of fields) known.fields.set(name, values[0]);
      } else {
        const values = new Map<FeatureRowField, unknown>();
        for (const [name, written] of fields) values.set(name, written[0]);
        pendingPlaces.set(ref, { layerId: layerOfRow(ref), fields: values });
      }
      return;
    }
    // A write of other values comes after the places taken
    writePendingPlaces();
    stored(
      store.writeRows({
        rows: Int32Array.of(ref),
        fields,
        ...(geometry !== undefined && {
          geometry: geometryColumnOf([geometry], tables.getValuesPerPosition(layerOfRow(ref)) ?? 2),
        }),
      }),
    );
    placeWritten();
    ownRows.add(ref);
    wrote();
  };

  /** The layer of a row */
  const layerOfRow = (ref: number): string => placeOf(parentOfRow(ref)).layerId;

  /** Writes the place of rows (their parent and their key) */
  const writePlaces = (places: ReadonlyArray<{ id: string; parent: string; key: string }>) => {
    for (const { id, parent, key } of places) {
      const ref = tables.getRowRef(id);
      if (ref === undefined) continue;
      writeRow(
        ref,
        new Map<FeatureRowField, unknown[]>([
          ['parent', [parent]],
          ['orderKey', [key]],
        ]),
      );
    }
  };

  // ==========================================================================
  // The changes of the order, told as a write of the order of a container
  // ==========================================================================

  /** Notes the order of a container before the change, when the orders before are kept */
  const noteOrderBefore = (container: string): void => {
    if (ordersBefore.has(container) || !watchingMoves()) return;
    ordersBefore.set(
      container,
      store.getGroup(container) ? memberIdsOf(container) : itemIdsOf(container),
    );
  };

  /** Tells a change of the order of a layer, from what it was */
  const layerOrderChanged = (layerId: string, previous: Layer | undefined): void => {
    bumpLayer(layerId);
    const layer = getLayer(layerId);
    if (!layer) return;
    mergeDocument({ layers: { updated: [{ id: layerId, layer, previous: previous ?? layer }] } });
  };

  /** Tells a change of the order of a group, from what it was */
  const groupOrderChanged = (groupId: string, previous: Group | undefined): void => {
    bumpGroup(groupId);
    const group = getGroup(groupId);
    if (!group) return;
    mergeDocument({ groups: { updated: [{ id: groupId, group, previous: previous ?? group }] } });
  };

  /** Whether a feature or a group stands in the order of its container, as the orders were written */
  const isListed = (id: string): boolean => !unlisted.has(id);

  // ==========================================================================
  // The writes of the document
  // ==========================================================================

  /**
   * What is called before a write of this client writes the row of a feature, with its ID (see
   * `DocumentOperations.setBeforeFeatureWrite`)
   */
  let beforeFeatureWrite: ((id: string) => void) | null = null;

  /**
   * Runs one write of the document unless read-only; true once it applied, false when the Store
   * refused one of its writes (see `attempt`)
   */
  const write = (fn: () => void): boolean => {
    if (client.isReadOnly()) return false;
    return attempt(fn, busDepth > 0 ? busSource : 'local');
  };

  const requireLayer = (layerId: string | undefined): void => {
    if (layerId === undefined || !store.getLayer(layerId)) {
      throw new Error(`Layer with id "${layerId}" not found`);
    }
  };

  /**
   * Creates the rows of features, each at the front of its group or its layer (or at the place an
   * order written gives it), as if they were created one after another: the rows of each layer
   * are written in one write of the Store, and told in the order given. A feature that cannot be
   * created throws once the ones before it are written.
   */
  const createFeatureRows = (
    features: readonly Feature[],
    places?: readonly CreatedPlace[],
  ): Feature[] => {
    const made: Feature[] = [];
    type Pending = {
      stored: Feature;
      container: string;
      key: string;
      listed: boolean;
      before: Layer | Group | undefined;
    };
    let batch: Pending[] = [];
    /** Writes the rows of the features taken, one write per layer, and tells them in order */
    const flush = (): void => {
      const rows = batch;
      batch = [];
      pendingRows = null;
      if (rows.length === 0) return;
      const byLayer = new Map<string, Pending[]>();
      for (const row of rows) {
        const list = byLayer.get(row.stored.layerId);
        if (list) list.push(row);
        else byLayer.set(row.stored.layerId, [row]);
      }
      /** The layers whose rows the Store created; it refused those of the next, if any */
      const written = new Set<string>();
      let refused = false;
      for (const [layerId, inLayer] of byLayer) {
        // The IDs were found free: a Store that does not create the rows refuses them
        const created = store.createRows({
          ids: inLayer.map((row) => row.stored.id),
          fields: newRowFields(
            inLayer.map((row) => row.stored),
            inLayer.map((row) => ({ parent: row.container, orderKey: row.key })),
          ),
          geometry: geometryColumnOf(
            inLayer.map((row) => row.stored.geometry),
            tables.getValuesPerPosition(layerId) ?? 2,
          ),
        });
        if (!created) {
          refused = true;
          break;
        }
        storeWrites += 1;
        if (placeScope) placeScope.wrote = true;
        written.add(layerId);
        wrote();
      }
      for (const { stored, container, listed, before } of rows) {
        if (!written.has(stored.layerId)) {
          // Not created: the ends of its container are read again
          endKeys.delete(container);
          continue;
        }
        const ref = tables.getRowRef(stored.id);
        if (ref !== undefined) ownRows.add(ref);
        remember(stored);
        mergeDocument({ features: { created: [stored] } });
        if (stored.groupId !== undefined) {
          bumpGroup(container);
          // The layer lists the group once it holds a feature
          bumpLayer(stored.layerId);
          if (!listed) groupOrderChanged(container, before as Group | undefined);
        } else {
          bumpLayer(container);
          if (!listed) layerOrderChanged(container, before as Layer | undefined);
        }
        made.push(stored);
      }
      if (refused) {
        // The positions of the orders written are read again
        placeVersion += 1;
        refuse();
      }
    };
    for (const feature of features)
      refuseInDeletion(feature.layerId, layerOfGroup(feature.groupId));
    try {
      for (const [at, feature] of features.entries()) {
        if (pendingRows?.has(feature.id) || getFeature(feature.id)) {
          throw new Error(`Feature with id "${feature.id}" already exists`);
        }
        requireLayer(feature.layerId);
        if (feature.groupId && !store.getGroup(feature.groupId)) {
          throw new Error(`Group with id "${feature.groupId}" not found`);
        }
        const stored = frozenFeature(undefined, feature);
        const container = stored.groupId ?? stored.layerId;
        const listing = listings.get(stored.id);
        const place = places?.[at];
        const listed =
          place === undefined && listing !== undefined && listing.container === container;
        const before = listed
          ? undefined
          : stored.groupId !== undefined
            ? getGroup(container)
            : getLayer(container);
        if (!listed) noteOrderBefore(container);
        const version = placeVersion;
        const key = place
          ? keyOfPlace(container, place)
          : listed
            ? keyOfListing(listing)
            : tailKeyOf(container);
        pendingRows ??= new Map();
        pendingRows.set(stored.id, { container, key });
        batch.push({ stored, container, key, listed, before });
        if (listed) {
          listings.delete(stored.id);
          keyTaken(container, key);
          listingPlaced(listing, version);
        } else if (place) {
          keyTaken(container, key);
        } else {
          frontTaken(container, key);
        }
      }
    } catch (error) {
      flush();
      throw error;
    }
    flush();
    return made;
  };

  /**
   * The key a new item takes at a place of a container: just in front of an item of the container
   * (between it and the item in front of it), or the key of the order an item has in its own
   * container; at the front when the item is not in the container
   */
  const keyOfPlace = (container: string, place: CreatedPlace): string => {
    if ('keyOf' in place) {
      const key = itemKeyOf(place.keyOf);
      return key ?? tailKeyOf(container);
    }
    const itemId = place.inFrontOf;
    const key = containerOfItem(itemId) === container ? itemKeyOf(itemId) : undefined;
    if (key === undefined) return tailKeyOf(container);
    const at = positionOf(container, { id: itemId, key });
    const above = at < 0 ? undefined : placedOf(container, at + 1, at + 2)[0]?.key;
    return keysBetween(key, above, 1)[0];
  };

  /** Creates the row of a feature (see `createFeatureRows`) */
  const createFeatureRow = (feature: Feature): Feature => createFeatureRows([feature])[0];

  /**
   * Updates the row of a feature: its values, and its place when its layer or its group changes
   * (at the back of its new group, or of its layer until the end of the operation unless an
   * order lists it)
   *
   * @param place - The place to write instead, for a write that places the feature itself
   */
  const updateFeatureRow = (
    id: string,
    updates: Partial<Feature>,
    options?: UpdateFeatureOptions,
    place?: { parent: string; key: string },
  ): void => {
    beforeFeatureWrite?.(id);
    const previous = getFeature(id);
    if (!previous) throw new Error(`Feature with id "${id}" not found`);
    refuseInDeletion(previous.layerId, updates.layerId, layerOfGroup(updates.groupId));
    if ('layerId' in updates && updates.layerId !== previous.layerId) {
      requireLayer(updates.layerId);
    }
    const updated = frozenFeature(previous, { ...updates, id });
    countWork(counts, 'objectsCreated');
    const ref = tables.getRowRef(id) as number;
    const { fields, geometry } = updatedRowFields(previous, updated, updates);
    const fromContainer = previous.groupId ?? previous.layerId;
    let toContainer = updated.groupId ?? updated.layerId;
    // A group that is not there yet: the feature stays in its layer until the group is made
    if (updated.groupId !== undefined && !store.getGroup(updated.groupId)) {
      toContainer = updated.layerId;
    }
    const containerChanged =
      (previous.groupId ?? `layer:${previous.layerId}`) !==
      (updated.groupId ?? `layer:${updated.layerId}`);
    let leftGroup: string | undefined;
    if (containerChanged || place) {
      if (place) {
        noteOrderBefore(fromContainer);
        if (place.parent !== fromContainer) noteOrderBefore(place.parent);
        fields.set('parent', [place.parent]);
        fields.set('orderKey', [place.key]);
      } else if (fromContainer !== toContainer) {
        noteOrderBefore(fromContainer);
        noteOrderBefore(toContainer);
        const listing = listings.get(id);
        const key =
          listing && listing.container === toContainer
            ? keyOfListing(listing)
            : tailKeyOf(toContainer);
        if (listing && listing.container === toContainer) listings.delete(id);
        fields.set('parent', [toContainer]);
        fields.set('orderKey', [key]);
      }
    }
    // What the order of the containers was, for the change of their order
    const groupBefore = previous.groupId !== undefined ? getGroup(previous.groupId) : undefined;
    const layerBefore = getLayer(previous.layerId);
    const targetBefore =
      updated.groupId !== undefined && updated.groupId !== previous.groupId
        ? getGroup(updated.groupId)
        : undefined;
    writeRow(ref, fields, geometry);
    remember(updated);
    if (containerChanged) {
      // Out of the order of the container it left
      if (previous.groupId !== undefined) {
        // The layer no longer lists a group left empty
        bumpLayer(previous.layerId);
        if (store.getGroup(previous.groupId)) {
          bumpGroup(previous.groupId);
          if (isListed(id)) {
            groupOrderChanged(previous.groupId, groupBefore);
            leftGroup = previous.groupId;
          }
        }
      } else if (isListed(id)) {
        layerOrderChanged(previous.layerId, layerBefore);
      } else {
        bumpLayer(previous.layerId);
      }
      if (updated.groupId !== undefined) {
        // The layer lists the group once it holds a feature
        bumpLayer(updated.layerId);
        if (store.getGroup(updated.groupId)) {
          bumpGroup(updated.groupId);
          if (!listings.has(id) && isListed(id)) groupOrderChanged(updated.groupId, targetBefore);
        }
      } else {
        bumpLayer(updated.layerId);
        pendingFeaturePlacement.add(id);
      }
      unlisted.delete(id);
    } else if (place) {
      bumpLayer(updated.layerId);
      if (updated.groupId !== undefined) bumpGroup(updated.groupId);
    }
    mergeDocument({
      features: {
        updated: [
          {
            id,
            feature: updated,
            previous,
            ...(options?.isIntermediate ? { isIntermediate: true } : {}),
          },
        ],
      },
    });
    if (leftGroup === undefined) return;
    // While the places of many rows are written, the groups left empty go once they are written
    if (pendingLeftGroups) pendingLeftGroups.push(leftGroup);
    else if (countMembers(leftGroup) === 0) deleteGroupRow(leftGroup);
  };

  /** Deletes the row of a feature, and the group its going leaves empty */
  const deleteFeatureRow = (id: string): void => {
    beforeFeatureWrite?.(id);
    const feature = getFeature(id);
    if (!feature) throw new Error(`Feature with id "${id}" not found`);
    refuseInDeletion(feature.layerId);
    const ref = tables.getRowRef(id) as number;
    const container = feature.groupId ?? feature.layerId;
    noteOrderBefore(container);
    const layerBefore = getLayer(feature.layerId);
    const groupBefore = feature.groupId !== undefined ? getGroup(feature.groupId) : undefined;
    // The ends of its container move only when it is one of them
    const atEnd = isEndKey(container, endKeys.has(container) ? rowKeyOf(ref) : undefined);
    stored(
      store.writeRows({ rows: Int32Array.of(ref), fields: new Map(), deleted: Uint8Array.of(1) }),
    );
    ownRows.add(ref);
    wrote();
    if (atEnd) endKeys.delete(container);
    featureCache.delete(id);
    if (feature.groupId === undefined) {
      if (isListed(id)) layerOrderChanged(feature.layerId, layerBefore);
      else bumpLayer(feature.layerId);
    } else {
      bumpLayer(feature.layerId);
    }
    mergeDocument({ features: { deleted: [feature] } });
    if (feature.groupId !== undefined && store.getGroup(feature.groupId)) {
      bumpGroup(feature.groupId);
      if (isListed(id)) {
        groupOrderChanged(feature.groupId, groupBefore);
        // A group whose last feature goes is deleted with it
        if (countMembers(feature.groupId) === 0) deleteGroupRow(feature.groupId);
      }
    }
    unlisted.delete(id);
  };

  /**
   * Deletes a group: its features take its place in its layer (or the places an order written
   * gives them), and lose their group
   */
  const deleteGroupRow = (id: string): void => {
    const base = store.getGroup(id);
    if (!base) throw new Error(`Group with id "${id}" not found`);
    refuseInDeletion(base.layerId);
    const group = getGroup(id) as Group;
    const layerId = base.layerId;
    const layerBefore = getLayer(layerId);
    noteOrderBefore(layerId);
    const memberIds = memberIdsOf(id);
    const members = memberIds.map((memberId) => getFeature(memberId) as Feature);
    // The features go where the group was, unless an order written places them
    const free = memberIds.filter((memberId) => listings.get(memberId)?.container !== layerId);
    const groupListed = isListed(id);
    const placedByOrder = new Set<string>();
    if (memberIds.length > 0) {
      const keys = keysBetween(base.orderKey, keyInFrontOf(base), free.length);
      placesTogether(() => {
        writePlaces(free.map((memberId, i) => ({ id: memberId, parent: layerId, key: keys[i] })));
        // One after another, so that each takes its key among those the order placed before it
        for (const memberId of memberIds) {
          const listing = listings.get(memberId);
          if (listing?.container !== layerId) continue;
          writePlaces([{ id: memberId, parent: layerId, key: keyOfListing(listing) }]);
          listings.delete(memberId);
          placedByOrder.add(memberId);
        }
        // Each feature leaves its group, told with the places written (see `PlaceScope`)
        for (const member of members) {
          if (!member) continue;
          const updated = frozenFeature(member, { groupId: undefined });
          countWork(counts, 'objectsCreated');
          remember(updated);
          // A feature of a group no order lists is listed at the end of the operation, unless an
          // order placed it
          if (!groupListed && !placedByOrder.has(member.id)) pendingFeaturePlacement.add(member.id);
          mergeDocument({
            features: { updated: [{ id: member.id, feature: updated, previous: member }] },
          });
        }
      });
    }
    if (groupListed && free.some((memberId) => isListed(memberId))) {
      layerOrderChanged(layerId, layerBefore);
    }
    // The places taken by a write of many places under way, before the group goes
    writePendingPlaces();
    stored(store.deleteGroup(id));
    ownGroups.add(id);
    wrote();
    placesWritten();
    bumpLayer(layerId);
    groupWrappers.delete(id);
    if (groupListed) layerOrderChanged(layerId, layerBefore);
    mergeDocument({ groups: { deleted: [group] } });
    unlisted.delete(id);
  };

  /**
   * Writes the order of a container: the items it holds take the order given (the ones whose
   * keys already rise keep them), and the IDs it does not hold yet are placed when they come
   */
  const writeOrder = (container: string, order: readonly string[]): void => {
    const isGroup = store.getGroup(container) !== undefined;
    const given = new Set(order);
    const placed: (Placed | undefined)[] = order.map((id) => {
      if (containerOfItem(id) !== container) return undefined;
      const key = itemKeyOf(id);
      return key === undefined ? undefined : { id, key };
    });
    // The items the order leaves out stand nowhere until something lists them
    const now = isGroup ? memberIdsOf(container) : itemIdsOf(container);
    for (const id of now) {
      if (!given.has(id)) unlisted.add(id);
    }
    order.forEach((id, index) => {
      unlisted.delete(id);
      pendingFeaturePlacement.delete(id);
      if (!placed[index]) listings.set(id, { container, order, index });
    });
    const kept = risingRun(placed);
    try {
      writeKeysOfOrder(order, placed, kept);
    } finally {
      // The order is read again, also when the Store refused a key
      if (isGroup) bumpGroup(container);
      else bumpLayer(container);
    }
  };

  /** Writes the keys of the items of an order that move, between the items that keep theirs */
  const writeKeysOfOrder = (
    order: readonly string[],
    placed: (Placed | undefined)[],
    kept: Set<number>,
  ): void => {
    let i = 0;
    while (i < order.length) {
      if (!placed[i] || kept.has(i)) {
        i += 1;
        continue;
      }
      let j = i;
      while (j < order.length && (!placed[j] || !kept.has(j))) j += 1;
      const run: number[] = [];
      for (let k = i; k < j; k++) if (placed[k]) run.push(k);
      let below: string | undefined;
      for (let k = i - 1; k >= 0 && below === undefined; k--) {
        if (placed[k] && kept.has(k)) below = (placed[k] as Placed).key;
      }
      const above = j < order.length ? (placed[j] as Placed).key : undefined;
      const keys = keysBetween(below, above, run.length);
      run.forEach((at, k) => {
        const id = order[at];
        const key = keys[k];
        placed[at] = { id, key };
        if (store.getGroup(id)) {
          stored(store.updateGroup(id, { orderKey: key }));
          ownGroups.add(id);
          wrote();
          placesWritten();
        } else {
          const ref = tables.getRowRef(id);
          if (ref !== undefined) {
            writeRow(ref, new Map<FeatureRowField, unknown[]>([['orderKey', [key]]]));
          }
        }
      });
      i = j;
    }
  };

  /** Moves the groups an order of a layer lists from other layers into the layer */
  const takeListedGroups = (layerId: string, order: readonly string[]): void => {
    order.forEach((id, index) => {
      const group = store.getGroup(id);
      if (!group || group.layerId === layerId) return;
      const previous = getGroup(id) as Group;
      const from = group.layerId;
      const key = keyOfListing({ container: layerId, order, index });
      stored(store.updateGroup(id, { layerId, orderKey: key }));
      ownGroups.add(id);
      wrote();
      placesWritten();
      listings.delete(id);
      bumpLayer(from);
      bumpLayer(layerId);
      bumpGroup(id);
      for (const memberId of memberIdsOf(id)) featureCache.delete(memberId);
      const updated = getGroup(id) as Group;
      mergeDocument({ groups: { updated: [{ id, group: updated, previous }] } });
    });
  };

  const createLayerRow = (layer: Layer): void => {
    if (store.getLayer(layer.id)) {
      throw new Error(`Layer with id "${layer.id}" already exists`);
    }
    const items = [...(layer.items ?? [])];
    // The ID was found free: a Store that does not create the layer refuses it
    stored(store.createLayer(storedLayerOf(layer)));
    ownLayers.add(layer.id);
    wrote();
    placesWritten();
    // The stacking order of the Store gets the layer at the front; it says so in its change
    ownOrder = true;
    items.forEach((id, index) => {
      if (!store.getGroup(id)) listings.set(id, { container: layer.id, order: items, index });
    });
    // The items it was created with, as a field that is not enumerable (see `layerOf`)
    const created = Object.freeze(
      Object.defineProperty({ ...layerOf(store.getLayer(layer.id)) }, 'items', {
        value: Object.freeze(items),
        enumerable: false,
      }),
    );
    // Told before the groups it takes, which the Store may refuse
    mergeDocument({ layers: { created: [created as Layer] } });
    takeListedGroups(layer.id, items);
  };

  const updateLayerRow = (id: string, updates: Partial<Layer>): void => {
    const base = store.getLayer(id);
    if (!base) throw new Error(`Layer with id "${id}" not found`);
    refuseInDeletion(id);
    const previous = getLayer(id) as Layer;
    noteOrderBefore(id);
    const fields = storedLayerOf({ ...updates, id } as Layer) as unknown as Record<string, unknown>;
    delete fields.id;
    const mark = storeWrites;
    const told = (): void => {
      ownLayers.add(id);
      wrote();
      const layer = getLayer(id) as Layer;
      mergeDocument({ layers: { updated: [{ id, layer, previous }] } });
    };
    try {
      if (Object.keys(fields).length > 0 || !('items' in updates)) {
        stored(store.updateLayer(id, fields as Partial<PublicLayer>));
        ownLayers.add(id);
        wrote();
      }
      if (updates.items) {
        const order = [...updates.items];
        writeOrder(id, order);
        takeListedGroups(id, order);
      }
    } catch (error) {
      // What the Store applied before it refused a write is told
      if (error instanceof RefusedWrite && storeWrites !== mark) told();
      throw error;
    }
    told();
  };

  const deleteLayerRow = (id: string): void => {
    const base = store.getLayer(id);
    if (!base) throw new Error(`Layer with id "${id}" not found`);
    refuseInDeletion(id);
    const layerBefore = getLayer(id) as Layer;
    noteOrderBefore(id);
    // What goes, in the order of the items: the features, and the groups their going empties
    const features = featuresOfRows(rowsOfLayer(id));
    const byGroup = new Map<string, Feature[]>();
    for (const feature of features) {
      if (feature.groupId === undefined) continue;
      const list = byGroup.get(feature.groupId) ?? [];
      list.push(feature);
      byGroup.set(feature.groupId, list);
    }
    const standalone = new Map(
      features.filter((f) => f.groupId === undefined).map((f) => [f.id, f] as const),
    );
    const groupsBefore = new Map<string, Group>();
    for (const groupId of byGroup.keys()) groupsBefore.set(groupId, getGroup(groupId) as Group);
    const goneGroups: Group[] = [];
    /** What the deletion tells, once the Store has applied it */
    const told: StoreChange[] = [];
    const gone: string[] = [];
    for (const itemId of itemIdsOf(id)) {
      const members = byGroup.get(itemId);
      const group = store.getGroup(itemId);
      if (group) {
        const before = groupsBefore.get(itemId) ?? (getGroup(itemId) as Group);
        for (const member of members ?? []) {
          gone.push(member.id);
          told.push({ features: { deleted: [member] } });
          told.push({ groups: { updated: [{ id: itemId, group: before, previous: before }] } });
        }
        goneGroups.push(before);
        told.push({ groups: { deleted: [before] } });
        told.push({ layers: { updated: [{ id, layer: layerBefore, previous: layerBefore }] } });
      } else {
        const feature = standalone.get(itemId);
        if (!feature) continue;
        gone.push(itemId);
        told.push({ features: { deleted: [feature] } });
        told.push({ layers: { updated: [{ id, layer: layerBefore, previous: layerBefore }] } });
      }
    }
    const refs: number[] = [];
    for (const feature of features) {
      const ref = tables.getRowRef(feature.id);
      if (ref !== undefined) refs.push(ref);
    }
    stored(store.deleteLayer(id));
    for (const goneId of gone) featureCache.delete(goneId);
    for (const change of told) mergeDocument(change);
    for (const ref of refs) ownRows.add(ref);
    for (const group of goneGroups) {
      ownGroups.add(group.id);
      groupWrappers.delete(group.id);
    }
    ownLayers.add(id);
    ownOrder = true;
    wrote();
    placesWritten();
    bumpLayer(id);
    layerWrappers.delete(id);
    mergeDocument({ layers: { deleted: [layerBefore] } });
  };

  const createGroupRow = (group: Group, inFrontOf?: string): void => {
    if (store.getGroup(group.id)) {
      throw new Error(`Group with id "${group.id}" already exists`);
    }
    const featureIds = inFrontOf === undefined ? [...(group.featureIds ?? [])] : [];
    const listing = inFrontOf === undefined ? listings.get(group.id) : undefined;
    const firstMember = featureIds.map((id) => getFeature(id)).find((f) => f !== undefined);
    const layerId = listing
      ? listing.container
      : (firstMember?.layerId ?? (store.getLayer(group.layerId) ? group.layerId : undefined));
    if (layerId === undefined) throw new Error(`Layer with id "${group.layerId}" not found`);
    refuseInDeletion(layerId);
    const version = placeVersion;
    let key: string;
    const layerBefore = inFrontOf === undefined ? undefined : getLayer(layerId);
    if (inFrontOf !== undefined) {
      noteOrderBefore(layerId);
      key = keyOfPlace(layerId, { inFrontOf });
    } else if (listing) {
      key = keyOfListing(listing);
      listings.delete(group.id);
    } else {
      // No order lists it: it takes the place of its first feature at the end of the operation
      if (firstMember && firstMember.layerId === layerId) {
        const itemId = firstMember.groupId ?? firstMember.id;
        const key = itemKeyOf(itemId);
        const at = key === undefined ? -1 : positionOf(layerId, { id: itemId, key });
        pendingGroupPlacement.set(group.id, {
          layerId,
          index: at === -1 ? countOf(layerId) : at,
        });
      }
      unlisted.add(group.id);
      key = tailKeyOf(layerId);
    }
    // The ID was found free: a Store that does not create the group refuses it
    stored(store.createGroup(storedGroupOf({ ...group, layerId }, key)));
    ownGroups.add(group.id);
    wrote();
    // A new item of its layer: the ends of the layer and the front of the order follow it
    if (listing || inFrontOf !== undefined) {
      keyTaken(layerId, key);
      if (listing) listingPlaced(listing, version);
    } else {
      frontTaken(layerId, key);
    }
    bumpLayer(layerId);
    if (inFrontOf !== undefined) layerOrderChanged(layerId, layerBefore);
    // The features it was created with, as a field that is not enumerable (see `groupOf`); told
    // before its features join it, which the Store may refuse
    const created = Object.freeze(
      Object.defineProperty({ ...groupOf(store.getGroup(group.id)) }, 'featureIds', {
        value: Object.freeze(featureIds),
        enumerable: false,
      }),
    );
    mergeDocument({ groups: { created: [created as Group] } });
    // The features listed join it in the order given; the others when they are created
    const memberKeys = keysBetween(undefined, undefined, featureIds.length);
    try {
      placesTogether(() => {
        featureIds.forEach((featureId, index) => {
          const feature = getFeature(featureId);
          if (!feature) {
            listings.set(featureId, { container: group.id, order: featureIds, index });
            return;
          }
          listings.set(featureId, { container: group.id, order: featureIds, index });
          updateFeatureRow(featureId, { groupId: group.id }, undefined, {
            parent: group.id,
            key: memberKeys[index],
          });
          listings.delete(featureId);
        });
      });
    } finally {
      bumpGroup(group.id);
    }
  };

  const updateGroupRow = (id: string, updates: Partial<Group>): void => {
    const base = store.getGroup(id);
    if (!base) throw new Error(`Group with id "${id}" not found`);
    refuseInDeletion(base.layerId, updates.layerId);
    const previous = getGroup(id) as Group;
    noteOrderBefore(id);
    const fields: Record<string, unknown> = {};
    for (const key of Object.keys(updates)) {
      if (key === 'featureIds' || key === 'id' || key === 'layerId') continue;
      fields[key] = frozenValue((updates as Record<string, unknown>)[key]);
    }
    const mark = storeWrites;
    const told = (): void => {
      ownGroups.add(id);
      wrote();
      const group = getGroup(id) as Group;
      mergeDocument({ groups: { updated: [{ id, group, previous }] } });
    };
    try {
      if (Object.keys(fields).length > 0) {
        stored(store.updateGroup(id, fields as Partial<StoreGroup>));
      }
      if (updates.featureIds) writeOrder(id, [...updates.featureIds]);
    } catch (error) {
      // What the Store applied before it refused a write is told
      if (error instanceof RefusedWrite && storeWrites !== mark) told();
      throw error;
    }
    told();
  };

  /** Lists what is still unlisted at the end of an operation: groups at their place, features at the front */
  const settlePlacements = (): void => {
    if (pendingGroupPlacement.size === 0 && pendingFeaturePlacement.size === 0) return;
    const groups = [...pendingGroupPlacement];
    const features = [...pendingFeaturePlacement];
    pendingGroupPlacement.clear();
    pendingFeaturePlacement.clear();
    for (const [groupId, { layerId, index }] of groups) {
      const group = store.getGroup(groupId);
      if (!group || !unlisted.has(groupId) || !store.getLayer(layerId)) continue;
      const before = getLayer(layerId);
      noteOrderBefore(layerId);
      const [key] = keysAt(layerId, [groupId], Math.min(index, countOf(layerId) - 1));
      stored(store.updateGroup(groupId, { orderKey: key }));
      ownGroups.add(groupId);
      wrote();
      placesWritten();
      unlisted.delete(groupId);
      layerOrderChanged(layerId, before);
    }
    for (const id of features) {
      const feature = getFeature(id);
      if (!feature || feature.groupId !== undefined) continue;
      const before = getLayer(feature.layerId);
      noteOrderBefore(feature.layerId);
      const [key] = keysAt(feature.layerId, [id], undefined);
      const ref = tables.getRowRef(id);
      if (ref !== undefined) {
        writeRow(
          ref,
          new Map<FeatureRowField, unknown[]>([
            ['parent', [feature.layerId]],
            ['orderKey', [key]],
          ]),
        );
      }
      unlisted.delete(id);
      layerOrderChanged(feature.layerId, before);
    }
  };

  // ==========================================================================
  // The moves
  // ==========================================================================

  /** Moves features: false when the Store refused one of the writes (see `attempt`) */
  const moveFeatures = (ids: readonly string[], to: MoveDestination): boolean =>
    attempt(
      () => placesTogether(() => moveFeaturesTo(ids, to)),
      busDepth > 0 ? busSource : 'local',
    );

  /** Moves features (see `moveFeatures`), in the transaction of the caller */
  const moveFeaturesTo = (ids: readonly string[], to: MoveDestination): void => {
    refuseInDeletion(to.kind === 'layer' ? to.layerId : undefined);
    if (to.kind === 'group') refuseInDeletion(layerOfGroup(to.groupId));
    for (const id of ids) {
      const ref = tables.getRowRef(id);
      if (ref !== undefined) refuseInDeletion(layerOfRow(ref));
    }
    if (to.kind === 'layer') {
      const { layerId } = to;
      const before = getLayer(layerId);
      noteOrderBefore(layerId);
      const keys = keysAt(layerId, ids, to.index);
      ids.forEach((id, i) => {
        beforeFeatureWrite?.(id);
        const feature = getFeature(id);
        if (!feature) return;
        if (feature.layerId !== layerId || feature.groupId !== undefined) {
          updateFeatureRow(id, { layerId, groupId: undefined }, undefined, {
            parent: layerId,
            key: keys[i],
          });
          pendingFeaturePlacement.delete(id);
        } else {
          const ref = tables.getRowRef(id);
          if (ref !== undefined) {
            writeRow(ref, new Map<FeatureRowField, unknown[]>([['orderKey', [keys[i]]]]));
          }
        }
        unlisted.delete(id);
      });
      layerOrderChanged(layerId, before);
      return;
    }
    if (to.kind === 'group') {
      const { groupId } = to;
      const group = store.getGroup(groupId);
      if (!group) return;
      const before = getGroup(groupId);
      noteOrderBefore(groupId);
      const keys = keysAt(groupId, ids, to.index);
      ids.forEach((id, i) => {
        beforeFeatureWrite?.(id);
        const feature = getFeature(id);
        if (!feature) return;
        if (feature.groupId !== groupId) {
          updateFeatureRow(id, { layerId: group.layerId, groupId }, undefined, {
            parent: groupId,
            key: keys[i],
          });
        } else {
          const ref = tables.getRowRef(id);
          if (ref !== undefined) {
            writeRow(ref, new Map<FeatureRowField, unknown[]>([['orderKey', [keys[i]]]]));
          }
        }
      });
      if (store.getGroup(groupId)) groupOrderChanged(groupId, before);
      return;
    }
    // Out of their groups: each feature stays in its layer
    const byLayer = new Map<string, Feature[]>();
    for (const id of ids) {
      beforeFeatureWrite?.(id);
      const feature = getFeature(id);
      if (!feature) continue;
      const list = byLayer.get(feature.layerId) ?? [];
      list.push(feature);
      byLayer.set(feature.layerId, list);
    }
    for (const [layerId, inLayer] of byLayer) {
      const before = getLayer(layerId);
      noteOrderBefore(layerId);
      const places = new Map<string, { parent: string; key: string }>();
      if (to.index === undefined) {
        // Just in front of their group, or in its place when it is left empty and deleted
        const blocks = new Map<string, string[]>();
        for (const feature of inLayer) {
          if (feature.groupId === undefined) continue;
          const block = blocks.get(feature.groupId) ?? [];
          block.push(feature.id);
          blocks.set(feature.groupId, block);
        }
        for (const [groupId, block] of blocks) {
          const group = store.getGroup(groupId);
          if (!group) continue;
          const keys = keysBetween(group.orderKey, keyInFrontOf(group), block.length);
          block.forEach((id, i) => {
            places.set(id, { parent: layerId, key: keys[i] });
          });
        }
      } else {
        const layerIds = inLayer.map((feature) => feature.id);
        const keys = keysAt(layerId, layerIds, to.index);
        layerIds.forEach((id, i) => {
          places.set(id, { parent: layerId, key: keys[i] });
        });
      }
      for (const feature of inLayer) {
        const place = places.get(feature.id);
        if (feature.groupId !== undefined) {
          updateFeatureRow(feature.id, { groupId: undefined }, undefined, place);
          pendingFeaturePlacement.delete(feature.id);
        } else if (place) {
          const ref = tables.getRowRef(feature.id);
          if (ref !== undefined) {
            writeRow(ref, new Map<FeatureRowField, unknown[]>([['orderKey', [place.key]]]));
          }
        }
        unlisted.delete(feature.id);
      }
      layerOrderChanged(layerId, before);
    }
  };

  /** Moves groups: false when the Store refused one of the writes (see `attempt`) */
  const moveGroups = (ids: readonly string[], layerId: string, index: number | undefined) =>
    attempt(
      () => {
        refuseInDeletion(layerId, ...ids.map(layerOfGroup));
        const before = getLayer(layerId);
        noteOrderBefore(layerId);
        const keys = keysAt(layerId, ids, index);
        const mark = storeWrites;
        /** The order of the layer, then the groups that moved */
        const told = (): void => {
          layerOrderChanged(layerId, before);
          for (const { id, previous } of groupMoved.splice(0)) {
            const group = getGroup(id);
            if (group) mergeDocument({ groups: { updated: [{ id, group, previous }] } });
          }
        };
        try {
          ids.forEach((id, i) => {
            moveGroupTo(id, layerId, keys[i]);
          });
        } catch (error) {
          // The moves the Store applied before it refused one are told
          if (error instanceof RefusedWrite && storeWrites !== mark) told();
          throw error;
        }
        told();
      },
      busDepth > 0 ? busSource : 'local',
    );

  /** Moves a group to a key of a layer (see `moveGroups`), in the transaction of the caller */
  const moveGroupTo = (id: string, layerId: string, key: string): void => {
    const group = store.getGroup(id);
    if (!group) return;
    const previous = getGroup(id) as Group;
    if (group.layerId === layerId) {
      stored(store.updateGroup(id, { orderKey: key }));
      ownGroups.add(id);
      wrote();
      placesWritten();
      return;
    }
    const source = group.layerId;
    const sourceBefore = getLayer(source);
    noteOrderBefore(source);
    // Its features move with it: where they were in it is told of each of them
    noteOrderBefore(id);
    const memberIds = memberIdsOf(id);
    const members = memberIds.map((memberId) => getFeature(memberId) as Feature);
    stored(store.updateGroup(id, { layerId, orderKey: key }));
    ownGroups.add(id);
    wrote();
    placesWritten();
    for (const memberId of memberIds) {
      const ref = tables.getRowRef(memberId);
      if (ref !== undefined) ownRows.add(ref);
    }
    layerOrderChanged(source, sourceBefore);
    for (const member of members) {
      const updated = frozenFeature(member, { layerId });
      countWork(counts, 'objectsCreated');
      remember(updated);
      mergeDocument({
        features: { updated: [{ id: member.id, feature: updated, previous: member }] },
      });
    }
    bumpGroup(id);
    groupMoved.push({ id, previous });
  };
  const groupMoved: Array<{ id: string; previous: Group }> = [];

  // ==========================================================================
  // The values written back
  // ==========================================================================

  /**
   * The rows this layer brought back (a deletion written 0) whose change has not been read yet:
   * read as created, as the rows a change written to the Store directly brings back
   */
  const broughtBack = new Set<number>();

  /** The parents and the keys of rows, read at once, or one at a time for rows of several layers */
  const readPlaces = (rows: Int32Array): ReadonlyMap<FeatureRowField, readonly unknown[]> => {
    try {
      return tables.readValues(rows, ['parent', 'orderKey']).fields;
    } catch (error) {
      if (!(error instanceof DrawError)) throw error;
      const parents: unknown[] = [];
      const keys: unknown[] = [];
      for (let i = 0; i < rows.length; i++) {
        const one = tables.readValues(Int32Array.of(rows[i]), ['parent', 'orderKey']).fields;
        parents.push(one.get('parent')?.[0]);
        keys.push(one.get('orderKey')?.[0]);
      }
      countWork(counts, 'objectsCreated', 2);
      return new Map<FeatureRowField, readonly unknown[]>([
        ['parent', parents],
        ['orderKey', keys],
      ]);
    }
  };

  /** Writes values of rows of a layer as columns (see `DocumentMoves.writeRowValues`) */
  const writeRowValuesNow = (
    layerId: string,
    values: RowValues,
    ignoreLocks: boolean,
  ): Int32Array => {
    const { rows } = values;
    if (rows.length === 0) return new Int32Array(0);
    refuseInDeletion(layerId);
    // The edit being written in parts is applied first to the rows written
    for (let i = 0; i < rows.length; i++) {
      const id = tables.getRowId(rows[i]);
      if (id !== undefined) beforeFeatureWrite?.(id);
    }
    // The rows there, and those a deleted row kept: the locked ones are left out. A deleted row
    // whose group is gone is read alone (its parent names no layer the others are in)
    const now = readPlaces(rows);
    const keep: number[] = [];
    for (let i = 0; i < rows.length; i++) {
      if (tables.getRowId(rows[i]) === undefined) continue;
      if (!ignoreLocks && isRowLocked(rows[i], layerId)) continue;
      keep.push(i);
    }
    if (keep.length === 0) return new Int32Array(0);
    let write = keep.length === rows.length ? values : selectRows(values, keep);
    // A row whose group is not there goes into the layer, at its front
    const parents = write.fields.get('parent');
    const parentOf = (k: number): string =>
      String(parents ? parents[k] : now.get('parent')?.[keep[k]]);
    const homeless: number[] = [];
    for (let k = 0; k < write.rows.length; k++) {
      const parent = parentOf(k);
      if (parent !== layerId && !store.getGroup(parent)) homeless.push(k);
    }
    if (homeless.length > 0) {
      const keys = keysBetween(endKeysOf(layerId).front, undefined, homeless.length);
      const parentColumn = Array.from(write.rows, (_, k) => parentOf(k) as unknown);
      const keyColumn = Array.from(
        write.rows,
        (_, k) => write.fields.get('orderKey')?.[k] ?? now.get('orderKey')?.[keep[k]],
      );
      homeless.forEach((k, j) => {
        parentColumn[k] = layerId;
        keyColumn[k] = keys[j];
      });
      const fields = new Map(write.fields);
      fields.set('parent', parentColumn);
      fields.set('orderKey', keyColumn);
      write = { ...write, fields };
      for (const key of keys) keyTaken(layerId, key);
    }
    // Read from the change of the Store, as a change written to it directly
    stored(store.writeRows(write));
    const deleted = write.deleted;
    if (deleted) {
      for (let k = 0; k < write.rows.length; k++) {
        if (deleted[k] === 0) broughtBack.add(write.rows[k]);
      }
    }
    return write.rows;
  };

  /** Puts a group in a layer under a key (see `DocumentMoves.placeGroup`) */
  const placeGroupNow = (group: Group, layerId: string, key: string): void => {
    refuseInDeletion(layerId, layerOfGroup(group.id));
    if (!store.getLayer(layerId)) throw new Error(`Layer with id "${layerId}" not found`);
    const layerBefore = getLayer(layerId);
    noteOrderBefore(layerId);
    if (store.getGroup(group.id)) {
      moveGroupTo(group.id, layerId, key);
      layerOrderChanged(layerId, layerBefore);
      for (const { id, previous } of groupMoved.splice(0)) {
        const moved = getGroup(id);
        if (moved) mergeDocument({ groups: { updated: [{ id, group: moved, previous }] } });
      }
      return;
    }
    stored(store.createGroup(storedGroupOf({ ...group, layerId }, key)));
    ownGroups.add(group.id);
    wrote();
    keyTaken(layerId, key);
    bumpLayer(layerId);
    const created = Object.freeze(
      Object.defineProperty({ ...groupOf(store.getGroup(group.id)) }, 'featureIds', {
        value: Object.freeze([]),
        enumerable: false,
      }),
    );
    mergeDocument({ groups: { created: [created as Group] } });
    layerOrderChanged(layerId, layerBefore);
  };

  // ==========================================================================
  // The changes written to the Store directly
  // ==========================================================================

  /**
   * The iterators under way, which skip the rows deleted meanwhile: held weakly, so that the
   * state of an iterator left before its end goes with it
   */
  const iterators = new Set<WeakReference<IteratorState>>();

  /** The states of the iterators under way, the ones gone left out */
  const iteratorStates = (): IteratorState[] => {
    const out: IteratorState[] = [];
    for (const held of iterators) {
      const state = held.deref();
      if (state) out.push(state);
      else iterators.delete(held);
    }
    return out;
  };

  /** The rows a change deleted leave the iterators under way */
  const rowsLeaveIterators = (change: RowChange): void => {
    if (iterators.size === 0 || !change.rows) return;
    const states = iteratorStates();
    for (const rows of change.rows.layers.values()) {
      if (rows.deleted.length === 0) continue;
      for (const state of states) {
        for (const ref of rows.deleted) state.gone.add(ref);
      }
    }
  };

  /** The orders of the containers before the change written to the Store directly being read */
  let foreignOrdersBefore = new Map<string, readonly string[]>();

  /** Whether an update of a group wrote its key of the order alone */
  const onlyKeyOfGroup = (group: StoreGroup, previous: StoreGroup): boolean => {
    if (group.orderKey === previous.orderKey) return false;
    const keys = new Set([...Object.keys(group), ...Object.keys(previous)]);
    for (const key of keys) {
      if (key === 'orderKey') continue;
      const a = (group as unknown as Record<string, unknown>)[key];
      const b = (previous as unknown as Record<string, unknown>)[key];
      if (a !== b && JSON.stringify(a) !== JSON.stringify(b)) return false;
    }
    return true;
  };

  /** The change of the Store in the words of the features, for what the instance did not write */
  const changeFromRows = (change: RowChange): StoreChange => {
    const out: StoreChange = {};
    const created: Feature[] = [];
    const updated: NonNullable<NonNullable<StoreChange['features']>['updated']> = [];
    const deleted: Feature[] = [];
    const touchedLayers = new Set<string>();
    const touchedGroups = new Set<string>();
    /** Where the items the change placed, created or deleted were before it (none: not there) */
    const placesBefore = new Map<string, { container: string; key: string } | null>();
    /** The containers whose items only took other keys: their order changed, nothing else */
    const reordered = new Set<string>();
    /** The containers the features moved out of (when the orders before are kept) */
    const left = new Set<string>();
    /** The groups whose features the change deleted */
    const emptiedGroups = new Set<string>();
    const watching = watchingMoves();
    // The features of the change in their own words, while they are read so
    const notes = wanted() ? notesFor(out) : undefined;
    if (notes) {
      notes.features = true;
      // What a replacement of the whole document takes out and what it writes are noted apart
      if (change.reset) notes.reset = true;
    }
    for (const [layerId, rows] of change.rows?.layers ?? []) {
      let createdRefs = rows.created.filter((ref) => !ownRows.has(ref));
      let updatedRefs = rows.updated.filter((ref) => !ownRows.has(ref));
      const deletedRefs = rows.deleted.filter((ref) => !ownRows.has(ref));
      // A row brought back (its deletion written 0) is told as created, whoever wrote it
      const backFrom = change.previousValues?.get(layerId);
      const wasDeleted = new Set<number>();
      if (backFrom?.deleted) {
        for (let i = 0; i < backFrom.rows.length; i++) {
          if (backFrom.deleted[i] !== 0) wasDeleted.add(backFrom.rows[i]);
        }
      }
      if (broughtBack.size > 0 || wasDeleted.size > 0) {
        const back = updatedRefs.filter((ref) => broughtBack.has(ref) || wasDeleted.has(ref));
        if (back.length > 0) {
          const backSet = new Set(back);
          updatedRefs = updatedRefs.filter((ref) => !backSet.has(ref));
          const joined = new Int32Array(createdRefs.length + back.length);
          joined.set(createdRefs);
          joined.set(back, createdRefs.length);
          createdRefs = joined;
        }
      }
      if (createdRefs.length + updatedRefs.length + deletedRefs.length === 0) continue;
      // The order of a layer changes with the rows it gains or loses, and with the places written
      const placed = rows.fields.has('parent') || rows.fields.has('orderKey');
      // Only the places written: a row that stays in its container took another place among the
      // same items
      const onlyPlaces =
        placed && [...rows.fields].every((field) => field === 'parent' || field === 'orderKey');
      if (createdRefs.length + deletedRefs.length > 0) touchedLayers.add(layerId);
      // The features made from the rows as they were: those kept made, or their values before
      const before = change.previousValues?.get(layerId);
      const beforeIndex = new Map<number, number>();
      if (before) for (let i = 0; i < before.rows.length; i++) beforeIndex.set(before.rows[i], i);
      const previousOf = (
        ref: number,
        id: string,
        now: Feature | undefined,
      ): Feature | undefined => {
        const known = featureCache.get(id);
        if (known) return known;
        if (!before || !now) return now;
        const at = beforeIndex.get(ref);
        if (at === undefined) return now;
        const patch: Record<string, unknown> = {};
        const properties: Record<string, unknown> = { ...now.properties };
        let propertiesChanged = false;
        for (const [field, column] of before.fields) {
          const value = column[at];
          if (field.startsWith(PROPERTY_FIELD)) {
            const key = field.slice(PROPERTY_FIELD.length);
            propertiesChanged = true;
            if (value === undefined) delete properties[key];
            else properties[key] = value;
          } else if (field === 'parent') {
            Object.assign(patch, placeOf(value));
          } else if (
            field === 'visible' ||
            field === 'locked' ||
            field === 'type' ||
            field === 'style'
          ) {
            patch[field] = value;
          }
        }
        if (propertiesChanged) patch.properties = properties;
        if (before.geometry) {
          const shape = geometryOfBefore(before, at);
          if (shape) patch.geometry = shape;
        }
        return frozenFeature(now, patch as Partial<Feature>);
      };
      if (change.reset) takenOut(layerId, deletedRefs, before, change, notes, deleted);
      for (const ref of change.reset ? [] : deletedRefs) {
        const id = tables.getRowId(ref);
        if (id === undefined) continue;
        if (notes) noteDeleted(notes, id);
        let feature = featureCache.get(id);
        featureCache.delete(id);
        if (!feature && change.deletedRowsToken !== undefined) {
          [feature] = makeFeatures(Int32Array.of(ref), [id]);
        }
        if (feature) deleted.push(feature);
        if (feature?.groupId) {
          touchedGroups.add(feature.groupId);
          emptiedGroups.add(feature.groupId);
        }
      }
      // The places of the rows before the change, for the orders before it
      if (placed || deletedRefs.length > 0) {
        const notePlaces = (refs: Int32Array, beforeOf: (ref: number) => number | undefined) => {
          if (refs.length === 0) return;
          const nowValues = tables.readValues(refs, ['parent', 'orderKey']).fields;
          for (let i = 0; i < refs.length; i++) {
            const id = tables.getRowId(refs[i]);
            if (id === undefined) continue;
            const at = beforeOf(refs[i]);
            const parent =
              at !== undefined && before?.fields.has('parent')
                ? before.fields.get('parent')?.[at]
                : nowValues.get('parent')?.[i];
            const key =
              at !== undefined && before?.fields.has('orderKey')
                ? before.fields.get('orderKey')?.[at]
                : nowValues.get('orderKey')?.[i];
            placesBefore.set(id, { container: String(parent), key: String(key ?? '') });
          }
        };
        if (placed) notePlaces(updatedRefs, (ref) => beforeIndex.get(ref));
        // One at a time: the rows deleted with their group are read alone
        if (change.deletedRowsToken !== undefined) {
          for (const ref of deletedRefs) notePlaces(Int32Array.of(ref), () => undefined);
        }
        for (const ref of createdRefs) {
          const id = tables.getRowId(ref);
          if (id !== undefined) placesBefore.set(id, null);
        }
      }
      for (const ref of updatedRefs) {
        const id = tables.getRowId(ref);
        if (id === undefined) continue;
        if (placed) {
          const now = tables.readValues(Int32Array.of(ref), ['parent', 'orderKey']).fields;
          const parent = String(now.get('parent')?.[0]);
          const before = placesBefore.get(id);
          // Put in another place: in another container, or under another key in its own
          if (notes && (before?.container !== parent || before.key !== now.get('orderKey')?.[0])) {
            noteMoved(notes, id, ref);
          }
          if (onlyPlaces && before?.container === parent) {
            // Not a change of the feature: a change of the order of its container
            reordered.add(parent);
            continue;
          }
        }
        const cached = featureCache.get(id);
        featureCache.delete(id);
        const [now] = makeFeatures(Int32Array.of(ref), [id]);
        const previous = cached ?? previousOf(ref, id, now) ?? now;
        remember(now);
        updated.push({ id, feature: now, previous });
        if (notes) {
          // A row moved to another layer with its group keeps its parent
          if (previous.layerId !== now.layerId || previous.groupId !== now.groupId) {
            noteMoved(notes, id, ref);
          }
          if (!onlyPlaces) noteUpdated(notes, id, ref);
        }
        if (!placed) continue;
        if (watching && (previous.groupId ?? previous.layerId) !== (now.groupId ?? now.layerId)) {
          left.add(previous.groupId ?? previous.layerId);
        }
        if (previous.groupId) touchedGroups.add(previous.groupId);
        if (now.groupId) touchedGroups.add(now.groupId);
        // An item of the layer, before or after, changes the order of its items
        if (previous.groupId === undefined || now.groupId === undefined) touchedLayers.add(layerId);
        if (previous.layerId !== layerId) touchedLayers.add(previous.layerId);
      }
      if (createdRefs.length > 0) {
        const ids = Array.from(createdRefs, (ref) => tables.getRowId(ref) ?? '');
        for (const id of ids) featureCache.delete(id);
        if (notes) for (let i = 0; i < ids.length; i++) noteCreated(notes, ids[i], createdRefs[i]);
        const made = makeFeatures(createdRefs, ids);
        for (const feature of made) {
          created.push(feature);
          if (feature.groupId) touchedGroups.add(feature.groupId);
        }
      }
    }
    broughtBack.clear();
    if (created.length + updated.length + deleted.length > 0) {
      out.features = {
        ...(created.length > 0 && { created }),
        ...(updated.length > 0 && { updated }),
        ...(deleted.length > 0 && { deleted }),
      };
    }
    // The layers and the groups
    const layers: NonNullable<StoreChange['layers']> = {};
    const groups: NonNullable<StoreChange['groups']> = {};
    for (const layer of change.layers?.created ?? []) {
      if (ownLayers.has(layer.id)) continue;
      bumpLayer(layer.id);
      if (!layers.created) layers.created = [];
      layers.created.push(layerOf(layer) as Layer);
    }
    for (const entry of change.layers?.updated ?? []) {
      if (ownLayers.has(entry.id)) continue;
      touchedLayers.delete(entry.id);
      const previous = layerWrappers.get(entry.id)?.layer ?? (layerOf(entry.previous) as Layer);
      bumpLayer(entry.id);
      if (!layers.updated) layers.updated = [];
      layers.updated.push({
        id: entry.id,
        layer: layerOf(entry.layer) as Layer,
        previous,
      });
    }
    for (const layer of change.layers?.deleted ?? []) {
      if (ownLayers.has(layer.id)) continue;
      const gone = layerWrappers.get(layer.id)?.layer ?? (layerOf(layer) as Layer);
      // A layer deleted with its items loses them first, as the instance tells its own deletion
      if (touchedLayers.delete(layer.id)) {
        if (!layers.updated) layers.updated = [];
        layers.updated.push({ id: layer.id, layer: gone, previous: gone });
      }
      layerWrappers.delete(layer.id);
      bumpLayer(layer.id);
      if (!layers.deleted) layers.deleted = [];
      layers.deleted.push(gone);
    }
    if (
      change.layers?.orderChanged &&
      !ownOrder &&
      !(change.layers.created?.length || change.layers.deleted?.length)
    ) {
      layers.orderChanged = {
        order: [...change.layers.orderChanged.order],
        previous: [...change.layers.orderChanged.previous],
      };
    }
    for (const layerId of touchedLayers) {
      if (ownLayers.has(layerId)) continue;
      const previous = layerWrappers.get(layerId)?.layer;
      bumpLayer(layerId);
      const layer = getLayer(layerId);
      if (layer) {
        if (!layers.updated) layers.updated = [];
        layers.updated.push({ id: layerId, layer, previous: previous ?? layer });
      }
    }
    for (const group of change.groups?.created ?? []) {
      if (ownGroups.has(group.id)) continue;
      // The features it was created with are told with its creation
      touchedGroups.delete(group.id);
      bumpGroup(group.id);
      bumpLayer(group.layerId);
      if (!groups.created) groups.created = [];
      groups.created.push(groupOf(group) as Group);
    }
    for (const group of change.groups?.created ?? []) {
      if (!ownGroups.has(group.id)) placesBefore.set(group.id, null);
    }
    for (const group of change.groups?.deleted ?? []) {
      if (!ownGroups.has(group.id)) {
        placesBefore.set(group.id, { container: group.layerId, key: group.orderKey });
      }
    }
    for (const entry of change.groups?.updated ?? []) {
      if (ownGroups.has(entry.id)) continue;
      placesBefore.set(entry.id, {
        container: entry.previous.layerId,
        key: entry.previous.orderKey,
      });
      if (onlyKeyOfGroup(entry.group, entry.previous)) {
        // A group that took another place among the items of its layer
        reordered.add(entry.group.layerId);
        continue;
      }
      touchedGroups.delete(entry.id);
      const previous = groupWrappers.get(entry.id)?.group ?? (groupOf(entry.previous) as Group);
      bumpGroup(entry.id);
      bumpLayer(entry.group.layerId);
      bumpLayer(entry.previous.layerId);
      if (!groups.updated) groups.updated = [];
      groups.updated.push({
        id: entry.id,
        group: groupOf(entry.group) as Group,
        previous,
      });
    }
    for (const group of change.groups?.deleted ?? []) {
      if (ownGroups.has(group.id)) continue;
      const gone = groupWrappers.get(group.id)?.group ?? (groupOf(group) as Group);
      // A group deleted with its features loses them first
      if (touchedGroups.delete(group.id) && emptiedGroups.has(group.id)) {
        if (!groups.updated) groups.updated = [];
        groups.updated.push({ id: group.id, group: gone, previous: gone });
      }
      groupWrappers.delete(group.id);
      bumpLayer(group.layerId);
      if (!groups.deleted) groups.deleted = [];
      groups.deleted.push(gone);
    }
    for (const groupId of touchedGroups) {
      if (ownGroups.has(groupId)) continue;
      const previous = groupWrappers.get(groupId)?.group;
      bumpGroup(groupId);
      const group = getGroup(groupId);
      if (group) {
        if (!groups.updated) groups.updated = [];
        groups.updated.push({ id: groupId, group, previous: previous ?? group });
      }
    }
    if (Object.keys(layers).length > 0) out.layers = layers;
    if (Object.keys(groups).length > 0) out.groups = groups;
    // The orders of the containers before the change, from their orders now and the places the
    // change wrote
    const orderBefore = (container: string): string[] => {
      const now = placedOf(container, 0, countOf(container)).filter(
        (item) => !placesBefore.has(item.id),
      );
      for (const [id, place] of placesBefore) {
        if (place?.container === container) now.push({ id, key: place.key });
      }
      return now.sort(comparePlaced).map((item) => item.id);
    };
    for (const container of reordered) {
      if (store.getGroup(container)) {
        bumpGroup(container);
        out.groupReorder = {
          groupId: container,
          featureIds: memberIdsOf(container),
          previous: orderBefore(container),
        };
      } else if (store.getLayer(container)) {
        bumpLayer(container);
        out.layerReorder = {
          layerId: container,
          order: itemIdsOf(container),
          previous: orderBefore(container),
        };
      }
    }
    foreignOrdersBefore = new Map();
    // Not for a container the change deleted: the features that left it name it alone
    for (const container of left) {
      if (store.getGroup(container) || store.getLayer(container)) {
        foreignOrdersBefore.set(container, orderBefore(container));
      }
    }
    if (change.metadata && !ownMetadata) {
      out.metadata = {
        metadata: { ...change.metadata.metadata },
        previous: { ...change.metadata.previous },
      };
    }
    if (change.files) {
      const files: NonNullable<StoreChange['files']> = {};
      for (const file of change.files.created ?? []) {
        if (!ownFiles.has(file.id)) {
          if (!files.created) files.created = [];
          files.created.push(file);
        }
      }
      for (const file of change.files.deleted ?? []) {
        if (!ownFiles.has(file.id)) {
          if (!files.deleted) files.deleted = [];
          files.deleted.push(file);
        }
      }
      if (Object.keys(files).length > 0) out.files = files;
    }
    if (change.reset) {
      out.reset = true;
      featureCache.clear();
      layerWrappers.clear();
      groupWrappers.clear();
    }
    return out;
  };

  /**
   * The features of a layer a change that replaces the whole document took out: their IDs are
   * read only for the notes or for the features made, and the features are made, from the values
   * the rows had before the change, only while they are told one by one (`deletedFeatures`)
   */
  const takenOut = (
    layerId: string,
    refs: Int32Array,
    before: RowValues | undefined,
    change: RowChange,
    notes: Notes | undefined,
    out: Feature[],
  ): void => {
    const make = watch?.deletedFeatures() === true;
    if (refs.length === 0 || (!notes && !make)) return;
    const ids = Array.from(refs, (ref) => tables.getRowId(ref));
    if (notes) for (const id of ids) if (id !== undefined) noteTakenOut(notes, id);
    if (!make) return;
    const made = before ? featuresBefore(layerId, before, change) : new Map<number, Feature>();
    for (let i = 0; i < refs.length; i++) {
      const id = ids[i];
      if (id === undefined) continue;
      const feature = made.get(refs[i]) ?? featureCache.get(id);
      if (feature) out.push(feature);
    }
  };

  /**
   * The features of the rows of a layer as they were before a change, made from their values
   * before (every field, as a change that replaces the whole document carries them), by row
   */
  const featuresBefore = (
    layerId: string,
    before: RowValues,
    change: RowChange,
  ): Map<number, Feature> => {
    let values = before;
    // The style of each row, from the keys of its style
    if (!values.fields.has('style')) {
      const keys = [...values.fields.keys()].filter((field) => field.startsWith(STYLE_FIELD));
      const styles = Array.from(values.rows, (_, i) => {
        const style: Record<string, unknown> = {};
        for (const field of keys) {
          const value = values.fields.get(field)?.[i];
          if (value !== undefined) style[field.slice(STYLE_FIELD.length)] = value;
        }
        return style;
      });
      values = { ...values, fields: new Map(values.fields).set('style', styles) };
    }
    const ids = Array.from(values.rows, (ref) => tables.getRowId(ref) ?? '');
    // The groups taken out with them, or written again by the change
    const groups = new Map((change.groups?.deleted ?? []).map((group) => [group.id, group]));
    const features = featuresOfValues(values, ids, (parent) => {
      const id = String(parent);
      if (id === layerId) return { layerId, groupId: undefined };
      const group = groups.get(id) ?? store.getGroup(id);
      return group ? { layerId: group.layerId, groupId: id } : { layerId, groupId: undefined };
    });
    countWork(counts, 'objectsCreated', features.length);
    const out = new Map<number, Feature>();
    for (let i = 0; i < features.length; i++) out.set(values.rows[i], features[i]);
    return out;
  };

  /** The geometry a row had before a change, from its values before */
  const geometryOfBefore = (values: { geometry?: unknown }, at: number): Geometry | null => {
    const column = values.geometry as Parameters<typeof featuresOfValues>[0]['geometry'];
    if (!column) return null;
    return featuresOfValues(
      { rows: Int32Array.of(0), fields: new Map(), geometry: sliceColumn(column, at) },
      [''],
      () => ({ layerId: '', groupId: undefined }),
    )[0].geometry;
  };

  /** One row of a column of geometries, as a column of one row */
  const sliceColumn = (
    column: NonNullable<Parameters<typeof featuresOfValues>[0]['geometry']>,
    at: number,
  ) => {
    const { types, coordinates, valuesPerPosition, partStarts, ringStarts, positionStarts } =
      column;
    const p0 = partStarts[at];
    const p1 = partStarts[at + 1];
    const r0 = ringStarts[p0];
    const r1 = ringStarts[p1];
    const s0 = positionStarts[r0];
    const s1 = positionStarts[r1];
    return {
      types: Uint8Array.of(types[at]),
      coordinates: coordinates.slice(s0 * valuesPerPosition, s1 * valuesPerPosition),
      valuesPerPosition,
      partStarts: Int32Array.of(0, p1 - p0),
      ringStarts: Int32Array.from(ringStarts.subarray(p0, p1 + 1), (r) => r - r0),
      positionStarts: Int32Array.from(positionStarts.subarray(r0, r1 + 1), (s) => s - s0),
    };
  };

  /** A change of the Store: what the instance wrote is told as it wrote it, the rest read here */
  const onRowChange = (change: RowChange): void => {
    // Whoever wrote it, the document is no longer the one last read
    documentVersion += 1;
    /** Whether the token of the change goes with its notes, until the change is told */
    let held = false;
    try {
      rowsLeaveIterators(change);
      rowsLeaveSets(change);
      const own = wroteRows;
      const foreign = changeFromRows(change);
      forgetEndKeys(change, foreign);
      clearOwn();
      // What the change of the Store says besides its rows, with the change it belongs to
      const rowNotes = notesOfRows(change);
      // The rows deleted are kept until the change is told, for one who reads the values before
      if (change.deletedRowsToken !== undefined && rowNotes.askedBy !== null) {
        rowNotes.tokens.push(change.deletedRowsToken);
        held = true;
      }
      mergeNotes(notesFor(own ? documentPending : foreign), rowNotes);
      if (own && awaitingRows) {
        // The writes of the instance in a transaction opened from elsewhere end with it: told
        // once the Store has told its change (the layer holds its change back until then)
        awaitingRows = false;
        const { source } = change;
        if (!isEmptyChange(foreign)) appendChange(documentPending, foreign, documentFolds);
        afterTold.push(() => {
          busDepth -= 1;
          busSource = source;
          followDocument();
          if (busDepth === 0) flush();
        });
        return;
      }
      if (own) {
        if (!isEmptyChange(foreign)) appendChange(documentPending, foreign, documentFolds);
        return;
      }
      // An empty change is told when it ends an operation (see `toldWhenEmpty`)
      if (isEmptyChange(foreign) && !toldWhenEmpty(rowNotes)) {
        releaseTokensOf(foreign);
        return;
      }
      const { source } = change;
      const orders = foreignOrdersBefore;
      afterTold.push(() =>
        client.hold(() =>
          busTransact(() => {
            for (const [container, order] of orders) {
              if (!ordersBefore.has(container)) ordersBefore.set(container, order);
            }
            appendChange(pending, foreign, pendingFolds);
            client.followDocument(foreign, drawing.dragState !== null);
          }, source),
        ),
      );
    } finally {
      if (change.deletedRowsToken !== undefined && !held) {
        store.releaseDeletedRows(change.deletedRowsToken);
      }
    }
  };

  store.subscribe(onRowChange, { previousValues: asksValuesBefore, keepDeletedRows: true });

  // ==========================================================================
  // The state only the drawing reads
  // ==========================================================================

  const drawing: {
    tentative: TentativeState | null;
    boxSelection: BoxSelection | null;
    dragState: DragState | null;
    followedVertices: VertexSelection[] | null;
  } = { tentative: null, boxSelection: null, dragState: null, followedVertices: null };

  // ==========================================================================
  // The boxes of the features
  // ==========================================================================

  /** Takes back the boxes set on the Store (null while none is set) */
  let takeBoxesBack: (() => void) | null = null;

  const setFeatureBoxes = (boxes: FeatureBoxes | null): void => {
    if (boxes === null) {
      const back = takeBoxesBack;
      takeBoxesBack = null;
      back?.();
      return;
    }
    takeBoxesBack = setRowBoxes(tables, {
      gives: (type) => boxes.gives(type),
      boxOf: (ref, out) => {
        const id = tables.getRowId(ref);
        if (id === undefined) return false;
        // Made from the row as it is when the Store reads its box (the feature kept made may be
        // that of before a write the layer has not followed yet)
        const [feature] = makeFeatures(Int32Array.of(ref), [id]);
        const box = boxes.boxOf(feature);
        out[0] = box.minX;
        out[1] = box.minY;
        out[2] = box.maxX;
        out[3] = box.maxY;
        return true;
      },
    });
  };

  /**
   * The features of the IDs given in stacking order, from the back: the layers in their order,
   * then the items of a layer by their keys (a group at its place), then the features of a group
   * by theirs, each read from its row alone
   */
  const sortInStackingOrder = (ids: readonly string[]): string[] => {
    writePendingPlaces();
    const layerAt = new Map<string, number>();
    for (const layerId of layerIdsInOrder(true)) layerAt.set(layerId, layerAt.size);
    const placed: Array<{ id: string; layer: number; item: Placed; member: Placed | null }> = [];
    for (const id of ids) {
      const ref = tables.getRowRef(id);
      if (ref === undefined) continue;
      const fields = tables.readValues(Int32Array.of(ref), ['parent', 'orderKey']).fields;
      const parent = String(fields.get('parent')?.[0]);
      const own: Placed = { id, key: String(fields.get('orderKey')?.[0] ?? '') };
      const group = store.getGroup(parent);
      const layerId = group ? group.layerId : parent;
      placed.push({
        id,
        layer: layerAt.get(layerId) ?? layerAt.size,
        item: group ? { id: group.id, key: group.orderKey } : own,
        member: group ? own : null,
      });
    }
    placed.sort(
      (a, b) =>
        a.layer - b.layer ||
        comparePlaced(a.item, b.item) ||
        (a.member && b.member ? comparePlaced(a.member, b.member) : 0),
    );
    return placed.map((entry) => entry.id);
  };

  /** The IDs of the features whose box meets a box, read from the spatial index of the Store */
  const findFeatureIdsInBox = (bounds: BoundingBox): string[] => {
    const cursor = tables.scan({ bbox: [bounds.minX, bounds.minY, bounds.maxX, bounds.maxY] });
    const ids: string[] = [];
    for (let batch = cursor.next(); batch !== null; batch = cursor.next()) {
      for (let i = 0; i < batch.length; i++) {
        const id = tables.getRowId(batch[i]);
        if (id !== undefined) ids.push(id);
      }
    }
    return ids;
  };

  // ==========================================================================
  // The state of this client
  // ==========================================================================

  const layer: InstanceDocument = {
    // The reads of the document
    getFeature,
    listFeatures: () => listFeaturesInOrder(true),
    listFeaturesInOrder: () => listFeaturesInOrder(false),
    getLayer,
    listLayers: () => store.listLayers().map((base) => layerOf(base) as Layer),
    getLayerOrder: () => [...store.getLayerOrder()],
    getGroup,
    listGroups: () => store.listGroups().map((base) => groupOf(base) as Group),
    getFile: (id: string) => store.getFile(id),
    listFiles: () => store.listFiles(),
    getMetadata: () => ({ ...store.getMetadata() }) as Metadata,

    // The writes of the document, the transactions and the subscription
    createFeature: (feature: Feature) => write(() => void createFeatureRow(feature)),
    createFeatures: (features: readonly Feature[]) => write(() => void createFeatureRows(features)),
    createFeaturesAt: (features: readonly Feature[], places: readonly CreatedPlace[]) =>
      write(() => void createFeatureRows(features, places)),
    createGroupInFrontOf: (group: Group, itemId: string) =>
      write(() => createGroupRow(group, itemId)),
    writeRowValues(layerId: string, values: RowValues, options?: { ignoreLocks?: boolean }) {
      let written: Int32Array = new Int32Array(0);
      attempt(
        () => {
          written = writeRowValuesNow(layerId, values, options?.ignoreLocks === true);
        },
        busDepth > 0 ? busSource : 'local',
      );
      return written;
    },
    placeGroup: (group: Group, layerId: string, key: string) =>
      write(() => placeGroupNow(group, layerId, key)),
    updateFeature: (id: string, updates: Partial<Feature>, options?: UpdateFeatureOptions) =>
      write(() => updateFeatureRow(id, updates, options)),
    // A drag given up has written the values it started from back: nothing is left to drop
    abortIntermediateUpdates: () => {},
    // The function the edits written in parts set, called before a write reads the feature
    applyEditFirst: (id: string) => beforeFeatureWrite?.(id),
    deleteFeature: (id: string) =>
      write(() => {
        deleteFeatureRow(id);
        // At once, so that the rest of a transaction already sees the selection without it; in a
        // part of an operation, once the operation ends (see `followDocument`)
        if (partScope === null) client.forget(id);
      }),
    createLayer: (value: Layer) => write(() => createLayerRow(value)),
    updateLayer: (id: string, updates: Partial<Layer>) => write(() => updateLayerRow(id, updates)),
    deleteLayer: (id: string) => write(() => deleteLayerRow(id)),
    setLayerOrder: (order: string[]) =>
      write(() => {
        const previous = [...store.getLayerOrder()];
        stored(store.setLayerOrder(order));
        ownOrder = true;
        wrote();
        mergeDocument({
          layers: { orderChanged: { order: [...store.getLayerOrder()], previous } },
        });
      }),
    // A move within a layer or a group: the write of the order it makes
    reorderInLayer: (itemId: string, layerId: string, newIndex: number) =>
      write(() => {
        if (!store.getLayer(layerId)) throw new Error(`Layer with id "${layerId}" not found`);
        updateLayerRow(layerId, { items: movedWithin(itemIdsOf(layerId), itemId, newIndex) });
      }),
    reorderInGroup: (featureId: string, groupId: string, newIndex: number) =>
      write(() => {
        if (!store.getGroup(groupId)) throw new Error(`Group with id "${groupId}" not found`);
        updateGroupRow(groupId, {
          featureIds: movedWithin(memberIdsOf(groupId), featureId, newIndex),
        });
      }),
    createGroup: (group: Group) => write(() => createGroupRow(group)),
    updateGroup: (id: string, updates: Partial<Group>) => write(() => updateGroupRow(id, updates)),
    deleteGroup: (id: string) => write(() => deleteGroupRow(id)),
    createFile: (file: FileData) =>
      write(() => {
        if (store.getFile(file.id)) throw new Error(`File with id "${file.id}" already exists`);
        stored(store.createFile(frozenValue({ ...file })));
        ownFiles.add(file.id);
        wrote();
        mergeDocument({ files: { created: [store.getFile(file.id) as FileData] } });
      }),
    deleteFile: (id: string) =>
      write(() => {
        const file = store.getFile(id);
        if (!file) throw new Error(`File with id "${id}" not found`);
        stored(store.deleteFile(id));
        ownFiles.add(id);
        wrote();
        mergeDocument({ files: { deleted: [file] } });
      }),
    setMetadata: (metadata: Partial<Metadata>) =>
      write(() => {
        const previous = { ...store.getMetadata() } as Metadata;
        stored(store.setMetadata(frozenValue({ ...metadata })));
        ownMetadata = true;
        wrote();
        mergeDocument({
          metadata: { metadata: { ...store.getMetadata() } as Metadata, previous },
        });
      }),
    subscribe(listener: (changes: StoreChange) => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    transact: <T>(fn: () => T, source?: UpdateSource, options?: StoreTransactOptions): T =>
      transact(fn, source ?? (busDepth > 0 ? busSource : 'local'), options),
    transactUntilRefused: <T>(fn: () => T, source?: UpdateSource): T | null =>
      transactUntilRefused(fn, source ?? (busDepth > 0 ? busSource : 'local')),

    // What the operations written in parts read, and the call before a write
    currentOperationId: () => (rowDepth > 0 ? operationNow : undefined),
    currentSource: () => (rowDepth > 0 ? rowSource : undefined),
    setBeforeFeatureWrite(before: ((id: string) => void) | null) {
      beforeFeatureWrite = before;
    },
    releaseOpenOperations() {
      partsTold.clear();
      goneInParts.clear();
    },
    setLayersBeingDeleted(ids: ReadonlySet<string> | null) {
      layersBeingDeleted = ids;
    },
    asLayerDeletion<T>(fn: () => T): T {
      deletionDepth += 1;
      try {
        return fn();
      } finally {
        deletionDepth -= 1;
      }
    },
    isLayerBeingDeleted: (id: string) => layersBeingDeleted?.has(id) === true,
    markWholeGeometry() {
      if (rowDepth > 0) wholeGeometryNow = true;
    },

    // The reads by position
    countItems: (layerId: string) => tables.get(layerId)?.itemCount ?? 0,
    listItemIds: (layerId: string, start: number, end: number) => itemIdsOf(layerId, start, end),
    countGroupFeatures: (groupId: string) => countMembers(groupId),
    listGroupFeatureIds: (groupId: string, start: number, end: number) =>
      memberIdsOf(groupId, start, end),
    hasFeature: (id: string) =>
      typeof id === 'string' && (featureCache.has(id) || tables.getRowRef(id) !== undefined),
    getFeatureProperty(id: string, key: string) {
      const known = featureCache.get(id);
      if (known) return known.properties[key];
      const ref = tables.getRowRef(id);
      if (ref === undefined) return undefined;
      return tables.get(layerOfRow(ref))?.getRowProperty(ref, key);
    },
    getFeaturePlace,
    isRowLocked,
    readFeatureValues,
    holdFeatures<T>(fn: () => T): T {
      cacheHolds += 1;
      try {
        return fn();
      } finally {
        cacheHolds -= 1;
        trimCache();
      }
    },
    sortInStackingOrder,
    countFeatures: (match?: FeatureMatch) => countMatching(match),
    iterateFeatures: (match?: FeatureMatch) => iterateMatching(match),
    getOrderBefore: (containerId: string) => toldOrdersBefore?.get(containerId),
    watchMoves(watching: () => boolean) {
      watchingMoves = watching;
    },

    // The reads by box
    findFeatureIdsInBox,
    setFeatureBoxes,
    listSelectableRows,

    // The rows as the Store holds them
    getTables: () => tables,

    // The moves and the replacements
    moveFeatures,
    moveGroups,
    onReset(listener: () => void) {
      // Called once the Store has told the change, after the subscribers of the layer
      return store.subscribe((change) => {
        if (change.reset) afterTold.push(listener);
      });
    },

    // The state of this client
    get client(): ClientState {
      return client;
    },
    getSelection: () => client.getSelection(),
    setSelection: (type: SelectionType | null, ids: readonly string[] | IdSet) =>
      client.setSelection(type, ids),
    featureSetOf,
    featureSetOfRows: (refs: Int32Array) => featureSetOfRows(uniqueRefs(refs).slice()),
    shownFeatureSetOf,
    shownFeatureSetOfLayers,
    rowsOfFeatureSet,
    getEditingIds: () => client.getEditingIds(),
    startEditing: (ids: string[]) => client.startEditing(ids),
    endEditing: (ids: string[]) => client.endEditing(ids),
    getVertexSelection: () => client.getVertexSelection(),
    setSelectedVertices: (selection: VertexSelection | null) =>
      client.setSelectedVertices(selection),
    getMode: () => client.getMode(),
    setMode: (mode: string) => client.setMode(mode),
    isReadOnly: () => client.isReadOnly(),
    setReadOnly: (value: boolean) => client.setReadOnly(value),
    isInteractionLocked: () => client.isInteractionLocked(),
    setInteractionLock: (value: boolean) => client.setInteractionLock(value),
    isHidden: (id: string) => client.isHidden(id),
    listHidden: () => client.listHidden(),
    setLocallyHidden: (id: string, hidden: boolean) => client.setLocallyHidden(id, hidden),

    // The drawing state
    getTentative: () => drawing.tentative,
    setTentative(state: TentativeState | null) {
      const previous = drawing.tentative;
      drawing.tentative = state ? { ...state, coordinates: [...state.coordinates] } : null;
      merge({ tentative: { state: drawing.tentative, previous } });
    },
    getBoxSelection: () => drawing.boxSelection,
    setBoxSelection(box: BoxSelection | null) {
      drawing.boxSelection = box
        ? {
            startPoint: [...box.startPoint],
            endPoint: [...box.endPoint],
            previousSelection: [...box.previousSelection],
          }
        : null;
      merge({ uiStateChanged: true });
    },
    getDragState: () => drawing.dragState,
    setDragState(state: DragState | null) {
      drawing.dragState = state
        ? {
            operation: state.operation,
            activeVertex: state.activeVertex ? { ...state.activeVertex } : undefined,
            activeFeatureId: state.activeFeatureId,
            rotateInfo: state.rotateInfo,
            movingFeatureIds: state.movingFeatureIds ? [...state.movingFeatureIds] : undefined,
          }
        : null;
      merge({ uiStateChanged: true });
    },
    getFollowedVertices: () => drawing.followedVertices,
    setFollowedVertices(selections: VertexSelection[] | null) {
      // null is written at the end of every drag: null to null is not told
      if (drawing.followedVertices === null && (selections === null || selections.length === 0)) {
        return;
      }
      drawing.followedVertices =
        selections && selections.length > 0
          ? selections.map((selection) => ({
              featureId: selection.featureId,
              vertices: selection.vertices.map((ref) => ({ ...ref })),
            }))
          : null;
      merge({ uiStateChanged: true });
    },
  };

  // ==========================================================================
  // The reads of many features
  // ==========================================================================

  /** The rows of the features that match, by layer in stacking order, read from their columns */
  function matchingRows(
    match: FeatureMatch | undefined,
  ): Array<{ layerId: string; refs: Int32Array }> {
    const out: Array<{ layerId: string; refs: Int32Array }> = [];
    let layerIds = layerIdsInOrder(true);
    if (match?.groupId !== undefined) {
      const group = store.getGroup(match.groupId);
      if (!group) return out;
      layerIds = layerIds.filter((id) => id === group.layerId);
    }
    if (match?.layerId !== undefined) layerIds = layerIds.filter((id) => id === match.layerId);
    for (const layerId of layerIds) {
      let refs = match?.groupId !== undefined ? memberRefsOf(match.groupId) : rowsOfLayer(layerId);
      if (refs.length === 0) continue;
      if (match) refs = filterRows(layerId, refs, match);
      if (refs.length > 0) out.push({ layerId, refs });
    }
    return out;
  }

  /** The rows of a layer that match the keys of a match other than the layer and the group */
  function filterRows(layerId: string, refs: Int32Array, match: FeatureMatch): Int32Array {
    const fields: FeatureRowField[] = [];
    if (match.type !== undefined) fields.push('type');
    if (match.visible !== undefined || match.shown !== undefined) fields.push('visible');
    if (match.locked !== undefined) fields.push('locked');
    if (match.shown !== undefined) fields.push('parent');
    let values: ReadonlyMap<FeatureRowField, readonly unknown[]> | undefined;
    if (fields.length > 0) values = tables.readValues(refs, fields).fields;
    const layerShown = store.getLayer(layerId)?.visible !== false;
    const keep: number[] = [];
    for (let i = 0; i < refs.length; i++) {
      if (match.type !== undefined && values?.get('type')?.[i] !== match.type) continue;
      const visible = values?.get('visible')?.[i] !== false;
      if (match.visible !== undefined && visible !== match.visible) continue;
      if (match.locked !== undefined && (values?.get('locked')?.[i] === true) !== match.locked) {
        continue;
      }
      if (match.shown !== undefined) {
        const parent = values?.get('parent')?.[i] as string;
        const group = parent === layerId ? undefined : store.getGroup(parent);
        const shown = visible && layerShown && (group === undefined || group.visible !== false);
        if (shown !== match.shown) continue;
      }
      if (match.ids && !match.ids.has(tables.getRowId(refs[i]) ?? '')) continue;
      keep.push(refs[i]);
    }
    return keep.length === refs.length ? refs : Int32Array.from(keep);
  }

  function countMatching(match: FeatureMatch | undefined): number {
    if (!match || Object.keys(match).length === 0) {
      let total = 0;
      for (const base of store.listLayers()) total += tables.get(base.id)?.rowCount ?? 0;
      return total;
    }
    let total = 0;
    for (const { refs } of matchingRows(match)) total += refs.length;
    return total;
  }

  function* iterateMatching(match: FeatureMatch | undefined): IterableIterator<Feature> {
    const batches = matchingRows(match);
    const state: IteratorState = { gone: new Set() };
    const held = new (globalThis as unknown as WeakReferences).WeakRef(state);
    // The states of the iterators left before their end go
    iteratorStates();
    iterators.add(held);
    try {
      for (const { refs } of batches) {
        for (let i = 0; i < refs.length; i++) {
          const ref = refs[i];
          if (state.gone.has(ref)) continue;
          const id = tables.getRowId(ref);
          if (id === undefined) continue;
          yield featureOfRow(ref, id);
        }
      }
    } finally {
      iterators.delete(held);
    }
  }

  Object.defineProperty(layer, WATCH, {
    value: (given: ChangeWatch | null): WorkCounts | undefined => {
      watch = given;
      return counts;
    },
  });

  client.attach({
    // The rules of the state of this client read where the features are and whether they are
    // visible: from the rows, without the features being made
    document: {
      getFeature: (id: string) => getFeaturePlace(id) as Feature | undefined,
      getGroup,
      getLayer,
      listLayers: layer.listLayers,
      idSetOf: (type: SelectionType, ids: Iterable<string> | IdSet) =>
        type === 'feature' ? featureSetOf(ids) : makeIdSet(isIdSet(ids) ? ids.iterate() : ids),
      idSetWithout: (type: SelectionType, ids: IdSet, leaves: (id: string) => boolean) =>
        type === 'feature' ? featureSetWithout(ids, leaves) : idSetWithout(ids, leaves),
      shownFeatureSetOf,
    },
    merge: (change) => merge(change),
    transact: (fn) => busTransact(fn, 'local'),
  });

  return layer;
}
