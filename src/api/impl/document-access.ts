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
  FeatureRowField,
  StoreChange as RowChange,
  Store as RowStore,
  StoreGroup,
} from '../../store/built-in/types.js';
import type {
  FeatureBoxes,
  FeatureMatch,
  FeaturePlace,
  InstanceDocument,
  MoveDestination,
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

/** The number of features the layer keeps made */
const FEATURE_CACHE_LIMIT = 1_024;

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

  const mergeDocument = (change: StoreChange): void => {
    appendChange(documentPending, change, documentFolds);
  };

  const merge = (change: StoreChange): void => {
    appendChange(pending, change, pendingFolds);
    if (busDepth === 0) flush();
  };

  /** Takes the changes of the document the writes made into the change, and follows them */
  const followDocument = (): void => {
    if (isEmptyChange(documentPending)) return;
    const change = documentPending;
    documentPending = {};
    documentFolds = newFolds();
    busTransact(() => {
      appendChange(pending, change, pendingFolds);
      client.followDocument(change, drawing.dragState !== null);
    }, busSource);
  };

  const flush = (): void => {
    if (awaitingRows) return;
    if (isEmptyChange(pending)) {
      ordersBefore = new Map();
      return;
    }
    const change = pending;
    change.source = busSource;
    pending = {};
    pendingFolds = newFolds();
    toldOrdersBefore = ordersBefore;
    ordersBefore = new Map();
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
  const asksValuesBefore = (change: { readonly source: UpdateSource }): boolean => {
    // A new outermost transaction: the one the writes of the instance waited for has ended
    // without a change, and what waited is told now
    if (awaitingRows) releaseAwaiting(lastOuterSource ?? rowSource);
    lastOuterSource = change.source;
    if (opening) {
      openedOutermost = true;
      return false;
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
  function rowTransact<T>(fn: () => T, source: UpdateSource): T {
    if (rowDepth > 0) return store.transact(fn, rowSource);
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
      result = store.transact(run, source);
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
      result = store.transact(run, rowSource);
    } finally {
      opening = false;
    }
    if (!openedOutermost && wroteRows && !awaitingRows) {
      // The change of the Store comes when the transaction opened from elsewhere ends: what
      // the writes made is held back until then (once, however many writes there are)
      awaitingRows = true;
      busDepth += 1;
    }
    return result;
  }

  /** Runs one transaction of the instance: the writes, then the change they make, told once */
  function transact<T>(fn: () => T, source: UpdateSource = 'local'): T {
    return client.hold(() =>
      busTransact(() => {
        try {
          return rowTransact(fn, busDepth > 1 ? busSource : source);
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

  function withOperation<T>(fn: () => T): T {
    operationDepth += 1;
    try {
      return fn();
    } finally {
      operationDepth -= 1;
      if (operationDepth === 0) {
        settlePlacements();
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
   * Forgets the keys of the ends, and the positions of the orders written, that a change written
   * to the Store directly may have moved
   */
  const forgetEndKeys = (change: RowChange, foreign: StoreChange): void => {
    if (change.reset || foreign.groups || foreign.layers?.deleted || foreign.layers?.created) {
      placesWritten();
      return;
    }
    for (const [layerId, rows] of change.rows?.layers ?? []) {
      const moved =
        rows.created.some((ref) => !ownRows.has(ref)) ||
        rows.deleted.some((ref) => !ownRows.has(ref)) ||
        ((rows.fields.has('parent') || rows.fields.has('orderKey')) &&
          rows.updated.some((ref) => !ownRows.has(ref)));
      if (!moved) continue;
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
    for (const { refs, fields } of writes.values()) {
      store.writeRows({ rows: Int32Array.from(refs), fields });
    }
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
    let left: string[];
    try {
      fn();
    } finally {
      left = pendingLeftGroups;
      writePendingPlaces();
      pendingPlaces = null;
      pendingLeftGroups = null;
    }
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
    if (fields.has('parent') || fields.has('orderKey')) placesWritten();
    ownRows.add(ref);
    wrote();
    if (pendingPlaces && geometry === undefined && isPlace(fields)) {
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
    store.writeRows({
      rows: Int32Array.of(ref),
      fields,
      ...(geometry !== undefined && {
        geometry: geometryColumnOf([geometry], tables.getValuesPerPosition(layerOfRow(ref)) ?? 2),
      }),
    });
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

  /** Runs one write of the document unless read-only; true once it applied */
  const write = (fn: () => void): boolean => {
    if (client.isReadOnly()) return false;
    transact(fn, busDepth > 0 ? busSource : 'local');
    return true;
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
  const createFeatureRows = (features: readonly Feature[]): Feature[] => {
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
      for (const [layerId, inLayer] of byLayer) {
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
          throw new Error(`Feature with id "${inLayer[0].stored.id}" already exists`);
        }
        wrote();
      }
      for (const { stored, container, listed, before } of rows) {
        const ref = tables.getRowRef(stored.id);
        if (ref !== undefined) ownRows.add(ref);
        remember(stored);
        mergeDocument({ features: { created: [stored] } });
        if (stored.groupId !== undefined) {
          bumpGroup(container);
          if (!listed) groupOrderChanged(container, before as Group | undefined);
        } else {
          bumpLayer(container);
          if (!listed) layerOrderChanged(container, before as Layer | undefined);
        }
        made.push(stored);
      }
    };
    try {
      for (const feature of features) {
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
        const listed = listing !== undefined && listing.container === container;
        const before = listed
          ? undefined
          : stored.groupId !== undefined
            ? getGroup(container)
            : getLayer(container);
        if (!listed) noteOrderBefore(container);
        const version = placeVersion;
        const key = listed ? keyOfListing(listing) : tailKeyOf(container);
        pendingRows ??= new Map();
        pendingRows.set(stored.id, { container, key });
        batch.push({ stored, container, key, listed, before });
        if (listed) {
          listings.delete(stored.id);
          keyTaken(container, key);
          listingPlaced(listing, version);
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
    const previous = getFeature(id);
    if (!previous) throw new Error(`Feature with id "${id}" not found`);
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
    const feature = getFeature(id);
    if (!feature) throw new Error(`Feature with id "${id}" not found`);
    const ref = tables.getRowRef(id) as number;
    const container = feature.groupId ?? feature.layerId;
    noteOrderBefore(container);
    const layerBefore = getLayer(feature.layerId);
    const groupBefore = feature.groupId !== undefined ? getGroup(feature.groupId) : undefined;
    ownRows.add(ref);
    wrote();
    endKeys.delete(container);
    store.writeRows({ rows: Int32Array.of(ref), fields: new Map(), deleted: Uint8Array.of(1) });
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
      });
    }
    if (groupListed && free.some((memberId) => isListed(memberId))) {
      layerOrderChanged(layerId, layerBefore);
    }
    // Each feature leaves its group
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
    ownGroups.add(id);
    wrote();
    placesWritten();
    // The places taken by a write of many places under way, before the group goes
    writePendingPlaces();
    store.deleteGroup(id);
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
    // The keys of the items that move, between the items around them that keep theirs
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
          ownGroups.add(id);
          wrote();
          placesWritten();
          store.updateGroup(id, { orderKey: key });
        } else {
          const ref = tables.getRowRef(id);
          if (ref !== undefined) {
            writeRow(ref, new Map<FeatureRowField, unknown[]>([['orderKey', [key]]]));
          }
        }
      });
      i = j;
    }
    if (isGroup) bumpGroup(container);
    else bumpLayer(container);
  };

  /** Moves the groups an order of a layer lists from other layers into the layer */
  const takeListedGroups = (layerId: string, order: readonly string[]): void => {
    order.forEach((id, index) => {
      const group = store.getGroup(id);
      if (!group || group.layerId === layerId) return;
      const previous = getGroup(id) as Group;
      const from = group.layerId;
      const key = keyOfListing({ container: layerId, order, index });
      ownGroups.add(id);
      wrote();
      placesWritten();
      store.updateGroup(id, { layerId, orderKey: key });
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
    ownLayers.add(layer.id);
    wrote();
    placesWritten();
    if (!store.createLayer(storedLayerOf(layer))) {
      throw new Error(`Layer with id "${layer.id}" already exists`);
    }
    // The stacking order of the Store gets the layer at the front; it says so in its change
    ownOrder = true;
    items.forEach((id, index) => {
      if (!store.getGroup(id)) listings.set(id, { container: layer.id, order: items, index });
    });
    takeListedGroups(layer.id, items);
    // The items it was created with, as a field that is not enumerable (see `layerOf`)
    const created = Object.freeze(
      Object.defineProperty({ ...layerOf(store.getLayer(layer.id)) }, 'items', {
        value: Object.freeze(items),
        enumerable: false,
      }),
    );
    mergeDocument({ layers: { created: [created as Layer] } });
  };

  const updateLayerRow = (id: string, updates: Partial<Layer>): void => {
    const base = store.getLayer(id);
    if (!base) throw new Error(`Layer with id "${id}" not found`);
    const previous = getLayer(id) as Layer;
    noteOrderBefore(id);
    const fields = storedLayerOf({ ...updates, id } as Layer) as unknown as Record<string, unknown>;
    delete fields.id;
    ownLayers.add(id);
    wrote();
    if (Object.keys(fields).length > 0 || !('items' in updates)) {
      store.updateLayer(id, fields as Partial<PublicLayer>);
    }
    if (updates.items) {
      const order = [...updates.items];
      writeOrder(id, order);
      takeListedGroups(id, order);
    }
    const layer = getLayer(id) as Layer;
    mergeDocument({ layers: { updated: [{ id, layer, previous }] } });
  };

  const deleteLayerRow = (id: string): void => {
    const base = store.getLayer(id);
    if (!base) throw new Error(`Layer with id "${id}" not found`);
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
    let touched = false;
    for (const itemId of itemIdsOf(id)) {
      const members = byGroup.get(itemId);
      const group = store.getGroup(itemId);
      if (group) {
        const before = groupsBefore.get(itemId) ?? (getGroup(itemId) as Group);
        for (const member of members ?? []) {
          featureCache.delete(member.id);
          mergeDocument({ features: { deleted: [member] } });
          mergeDocument({ groups: { updated: [{ id: itemId, group: before, previous: before }] } });
        }
        goneGroups.push(before);
        mergeDocument({ groups: { deleted: [before] } });
        touched = true;
        mergeDocument({
          layers: { updated: [{ id, layer: layerBefore, previous: layerBefore }] },
        });
      } else {
        const feature = standalone.get(itemId);
        if (!feature) continue;
        featureCache.delete(itemId);
        mergeDocument({ features: { deleted: [feature] } });
        touched = true;
        mergeDocument({
          layers: { updated: [{ id, layer: layerBefore, previous: layerBefore }] },
        });
      }
    }
    for (const feature of features) {
      const ref = tables.getRowRef(feature.id);
      if (ref !== undefined) ownRows.add(ref);
    }
    for (const group of goneGroups) {
      ownGroups.add(group.id);
      groupWrappers.delete(group.id);
    }
    ownLayers.add(id);
    ownOrder = true;
    wrote();
    placesWritten();
    store.deleteLayer(id);
    bumpLayer(id);
    layerWrappers.delete(id);
    void touched;
    mergeDocument({ layers: { deleted: [layerBefore] } });
  };

  const createGroupRow = (group: Group): void => {
    if (store.getGroup(group.id)) {
      throw new Error(`Group with id "${group.id}" already exists`);
    }
    const featureIds = [...(group.featureIds ?? [])];
    const listing = listings.get(group.id);
    const firstMember = featureIds.map((id) => getFeature(id)).find((f) => f !== undefined);
    const layerId = listing
      ? listing.container
      : (firstMember?.layerId ?? (store.getLayer(group.layerId) ? group.layerId : undefined));
    if (layerId === undefined) throw new Error(`Layer with id "${group.layerId}" not found`);
    const version = placeVersion;
    let key: string;
    if (listing) {
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
    ownGroups.add(group.id);
    wrote();
    if (!store.createGroup(storedGroupOf({ ...group, layerId }, key))) {
      throw new Error(`Group with id "${group.id}" already exists`);
    }
    // A new item of its layer: the ends of the layer and the front of the order follow it
    if (listing) {
      keyTaken(layerId, key);
      listingPlaced(listing, version);
    } else {
      frontTaken(layerId, key);
    }
    bumpLayer(layerId);
    // The features listed join it in the order given; the others when they are created
    const memberKeys = keysBetween(undefined, undefined, featureIds.length);
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
    bumpGroup(group.id);
    // The features it was created with, as a field that is not enumerable (see `groupOf`)
    const created = Object.freeze(
      Object.defineProperty({ ...groupOf(store.getGroup(group.id)) }, 'featureIds', {
        value: Object.freeze(featureIds),
        enumerable: false,
      }),
    );
    mergeDocument({ groups: { created: [created as Group] } });
  };

  const updateGroupRow = (id: string, updates: Partial<Group>): void => {
    const base = store.getGroup(id);
    if (!base) throw new Error(`Group with id "${id}" not found`);
    const previous = getGroup(id) as Group;
    noteOrderBefore(id);
    const fields: Record<string, unknown> = {};
    for (const key of Object.keys(updates)) {
      if (key === 'featureIds' || key === 'id' || key === 'layerId') continue;
      fields[key] = frozenValue((updates as Record<string, unknown>)[key]);
    }
    ownGroups.add(id);
    wrote();
    if (Object.keys(fields).length > 0) store.updateGroup(id, fields as Partial<StoreGroup>);
    if (updates.featureIds) writeOrder(id, [...updates.featureIds]);
    const group = getGroup(id) as Group;
    mergeDocument({ groups: { updated: [{ id, group, previous }] } });
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
      ownGroups.add(groupId);
      wrote();
      placesWritten();
      store.updateGroup(groupId, { orderKey: key });
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

  const moveFeatures = (ids: readonly string[], to: MoveDestination): void => {
    transact(
      () => placesTogether(() => moveFeaturesTo(ids, to)),
      busDepth > 0 ? busSource : 'local',
    );
  };

  /** Moves features (see `moveFeatures`), in the transaction of the caller */
  const moveFeaturesTo = (ids: readonly string[], to: MoveDestination): void => {
    if (to.kind === 'layer') {
      const { layerId } = to;
      const before = getLayer(layerId);
      noteOrderBefore(layerId);
      const keys = keysAt(layerId, ids, to.index);
      ids.forEach((id, i) => {
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

  const moveGroups = (ids: readonly string[], layerId: string, index: number | undefined): void => {
    transact(
      () => {
        const before = getLayer(layerId);
        noteOrderBefore(layerId);
        const keys = keysAt(layerId, ids, index);
        ids.forEach((id, i) => {
          const group = store.getGroup(id);
          if (!group) return;
          const previous = getGroup(id) as Group;
          if (group.layerId === layerId) {
            ownGroups.add(id);
            wrote();
            placesWritten();
            store.updateGroup(id, { orderKey: keys[i] });
            return;
          }
          const source = group.layerId;
          const sourceBefore = getLayer(source);
          noteOrderBefore(source);
          // Its features move with it: where they were in it is told of each of them
          noteOrderBefore(id);
          const memberIds = memberIdsOf(id);
          const members = memberIds.map((memberId) => getFeature(memberId) as Feature);
          ownGroups.add(id);
          wrote();
          placesWritten();
          store.updateGroup(id, { layerId, orderKey: keys[i] });
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
        });
        layerOrderChanged(layerId, before);
        for (const { id, previous } of groupMoved.splice(0)) {
          const group = getGroup(id);
          if (group) mergeDocument({ groups: { updated: [{ id, group, previous }] } });
        }
      },
      busDepth > 0 ? busSource : 'local',
    );
  };
  const groupMoved: Array<{ id: string; previous: Group }> = [];

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
  const noteDeleted = (change: RowChange): void => {
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
    for (const [layerId, rows] of change.rows?.layers ?? []) {
      const createdRefs = rows.created.filter((ref) => !ownRows.has(ref));
      const updatedRefs = rows.updated.filter((ref) => !ownRows.has(ref));
      const deletedRefs = rows.deleted.filter((ref) => !ownRows.has(ref));
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
      for (const ref of deletedRefs) {
        const id = tables.getRowId(ref);
        if (id === undefined) continue;
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
        if (onlyPlaces) {
          const parent = String(
            tables.readValues(Int32Array.of(ref), ['parent']).fields.get('parent')?.[0],
          );
          if (placesBefore.get(id)?.container === parent) {
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
        const made = makeFeatures(createdRefs, ids);
        for (const feature of made) {
          created.push(feature);
          if (feature.groupId) touchedGroups.add(feature.groupId);
        }
      }
    }
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
    try {
      noteDeleted(change);
      const own = wroteRows;
      const foreign = changeFromRows(change);
      forgetEndKeys(change, foreign);
      clearOwn();
      if (own && awaitingRows) {
        // The writes of the instance in a transaction opened from elsewhere end with it: told
        // once the Store has told its change (the layer holds its change back until then)
        awaitingRows = false;
        const { source } = change;
        if (!isEmptyChange(foreign)) mergeDocument(foreign);
        afterTold.push(() => {
          busDepth -= 1;
          busSource = source;
          followDocument();
          if (busDepth === 0) flush();
        });
        return;
      }
      if (own) {
        if (!isEmptyChange(foreign)) mergeDocument(foreign);
        return;
      }
      if (isEmptyChange(foreign)) return;
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
      if (change.deletedRowsToken !== undefined) store.releaseDeletedRows(change.deletedRowsToken);
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
    updateFeature: (id: string, updates: Partial<Feature>, options?: UpdateFeatureOptions) =>
      write(() => updateFeatureRow(id, updates, options)),
    // A drag given up has written the values it started from back: nothing is left to drop
    abortIntermediateUpdates: () => {},
    deleteFeature: (id: string) =>
      write(() => {
        deleteFeatureRow(id);
        // At once, so that the rest of a transaction already sees the selection without it
        client.forget(id);
      }),
    createLayer: (value: Layer) => write(() => createLayerRow(value)),
    updateLayer: (id: string, updates: Partial<Layer>) => write(() => updateLayerRow(id, updates)),
    deleteLayer: (id: string) => write(() => deleteLayerRow(id)),
    setLayerOrder: (order: string[]) =>
      write(() => {
        const previous = [...store.getLayerOrder()];
        ownOrder = true;
        wrote();
        store.setLayerOrder(order);
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
        ownFiles.add(file.id);
        wrote();
        store.createFile(frozenValue({ ...file }));
        mergeDocument({ files: { created: [store.getFile(file.id) as FileData] } });
      }),
    deleteFile: (id: string) =>
      write(() => {
        const file = store.getFile(id);
        if (!file) throw new Error(`File with id "${id}" not found`);
        ownFiles.add(id);
        wrote();
        store.deleteFile(id);
        mergeDocument({ files: { deleted: [file] } });
      }),
    setMetadata: (metadata: Partial<Metadata>) =>
      write(() => {
        const previous = { ...store.getMetadata() } as Metadata;
        ownMetadata = true;
        wrote();
        store.setMetadata(frozenValue({ ...metadata }));
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
    transact: <T>(fn: () => T, source?: UpdateSource): T =>
      transact(fn, source ?? (busDepth > 0 ? busSource : 'local')),

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
    setSelection: (type: SelectionType | null, ids: string[]) => client.setSelection(type, ids),
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

  client.attach({
    // The rules of the state of this client read where the features are and whether they are
    // visible: from the rows, without the features being made
    document: {
      getFeature: (id: string) => getFeaturePlace(id) as Feature | undefined,
      getGroup,
      getLayer,
      listLayers: layer.listLayers,
    },
    merge: (change) => merge(change),
    transact: (fn) => busTransact(fn, 'local'),
  });

  return layer;
}
