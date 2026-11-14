// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The commits of a Store as operations on values (`ValueOperation`): what a storage of the first
 * shape receives. Each notification of the Store (one per transaction) is read once, after it is
 * applied: what it created is read from the Store as it is now, what it changed is compared with
 * what it was before, and where an item is is the key of its order under its parent.
 *
 * A layer of rows keeps the keys of its rows and groups in its tables. A layer of objects keeps
 * lists, with no keys: the keys of its items, and those of the layers among the layers, are kept
 * here, made when an item is put in a place and kept while it stays there among the others.
 *
 * The values of many rows (a commit of a hundred thousand rows moved) take longer than a frame to
 * read: they are read over several tasks (`ChangeReading.step`), from a snapshot of the document
 * as the notification left it (`Store.openSnapshot`), so that the commits made meanwhile are not
 * read in them. What is read where the notification goes out is only what tells the places.
 *
 * Nothing here runs when it is not made: the instance makes it only for a storage.
 *
 * @internal
 */

import { sameValue, type Value, valueToJSON } from '@sakuzu/tabane';
import type { Geometry } from 'geojson';
import { featureWithFields } from '../../feature-table/feature-fields.js';
import { longestRisingRun } from '../../shared/utils/item-moves.js';
import { setOwnProperty } from '../../shared/utils/own-property.js';
import { featuresInOrder } from '../../store/feature-stream.js';
import { compareKeys, keysBetween } from '../../store/order-keys.js';
import type { LastingSnapshot } from '../../store/read-snapshot.js';
import type { Store } from '../../store/store.js';
import type {
  FileData,
  Group,
  Layer,
  RowField,
  RowValues,
  StoreChange,
  Feature as StoredFeature,
} from '../../store/types.js';
import type { Change } from '../events.js';
import { toChange } from '../impl/events.js';
import { orientedGeometry, toFeature } from '../impl/feature-shape.js';
import type { Feature, JsonObject, JsonValue, StyleRule } from '../model.js';
import type {
  FeatureRecord,
  FileRecord,
  GroupRecord,
  LayerRecord,
  UnsetKeys,
  ValueOperation,
} from './values.js';

const STYLE_KEY = 'maplibre-gl-draw:style';
const LAYER_KEY = 'maplibre-gl-draw:layerId';
const GROUP_KEY = 'maplibre-gl-draw:groupId';

/** The parent of the layers among the keys kept here */
const LAYERS = '';

/** Where an item is: its parent (a layer or a group, `LAYERS` for a layer) and its key there */
interface Place {
  readonly parent: string;
  readonly key: string;
}

/** The most rows of a notification read where it goes out: more are read over several tasks */
const ROWS_READ_AT_ONCE = 2048;

/** The rows read between two looks at the time */
const ROWS_PER_LOOK = 128;

/**
 * What reads one notification as operations: at once, or over several tasks for many rows
 *
 * @internal
 */
export interface ChangeReading {
  /** Reads until a time (`performance.now`): true once every operation is read */
  step(deadline: number): boolean;
  /** The operations, in the order they apply, once `step` said every one is read */
  operations(): ValueOperation[];
  /** Lets go of the snapshot it reads from (once read, or when it is dropped) */
  release(): void;
}

/** The rows of a notification whose values are still to be read, and how far they are read */
interface RowsToRead {
  /** The rows created, with their keys */
  readonly created: { readonly id: string; readonly key: string }[];
  /** The rows updated, and their handles where the notification went out */
  updated: readonly string[];
  handles: ArrayLike<number>;
  /** The first of `created`, then of `updated`, not read yet */
  at: number;
  /** Where each row is among the values before of the notification, made a part a step */
  readonly index: Map<number, number>;
  /** How many of the values before are in `index` */
  indexed: number;
}

/** What the groups of a notification moved, for the features */
interface GroupsMoved {
  readonly moved: ReadonlySet<string>;
  readonly relayered: readonly Group[];
}

/** The operations of one notification, by what they do, in the order they are applied */
interface Operations {
  readonly createdFiles: ValueOperation[];
  readonly createdLayers: ValueOperation[];
  readonly createdGroups: ValueOperation[];
  readonly createdFeatures: ValueOperation[];
  readonly set: ValueOperation[];
  readonly placed: ValueOperation[];
  readonly deletedFeatures: string[];
  readonly deletedGroups: string[];
  readonly deletedLayers: string[];
  readonly deletedFiles: string[];
  document: { title?: string; description?: string } | null;
}

/**
 * The reader of the commits of one Store as operations on values
 *
 * @internal
 */
export class CommitValues {
  /** The places of the layers, and of the items of the layers of objects */
  readonly #places = new Map<string, Place>();

  constructor(private readonly store: Store) {
    this.#placeDocument();
  }

  /** Gives the items of the layers of objects, and the layers, their keys from their order */
  #placeDocument(): void {
    const store = this.store;
    this.#places.clear();
    const layers = this.#layerIds();
    this.#placeAll(LAYERS, layers);
    for (const layerId of layers) {
      const layer = store.getLayer(layerId) as Layer;
      if (layer.kind !== 'table') this.#placeAll(layerId, layer.items);
    }
    for (const group of store.listGroups()) {
      if (group.kind !== 'table') this.#placeAll(group.id, group.featureIds);
    }
  }

  /**
   * The whole document as it is, as the operations that create it from an empty document. The
   * keys of the items of the layers of objects are made again from their order.
   */
  documentOperations(): ValueOperation[] {
    const store = this.store;
    this.#places.clear();
    const out = emptyOperations();
    for (const file of store.listFiles()) out.createdFiles.push(createFile(file));
    const layers = this.#layerIds();
    this.#placeAll(LAYERS, layers);
    for (const layerId of layers) {
      const layer = store.getLayer(layerId) as Layer;
      out.createdLayers.push(createLayer(layer, this.#keyOf(layerId)));
      if (layer.kind === 'table') continue;
      this.#placeAll(layerId, layer.items);
    }
    for (const group of store.listGroups()) {
      if (group.kind !== 'table') this.#placeAll(group.id, group.featureIds);
      out.createdGroups.push(createGroup(group, this.#groupKey(group)));
    }
    const rows: string[] = [];
    for (const feature of featuresInOrder(store)) {
      if (this.#isRow(feature.id)) rows.push(feature.id);
      else out.createdFeatures.push(createFeature(feature, this.#keyOf(feature.id)));
    }
    const rowPlaces = this.#rowPlaces(rows);
    for (const id of rows) {
      const feature = store.getFeature(id) as StoredFeature;
      out.createdFeatures.push(createFeature(feature, rowPlaces.get(id)?.key ?? ''));
    }
    const { title, description } = store.getMetadata();
    if (typeof title === 'string' && title !== '') out.document = { title };
    if (typeof description === 'string' && description !== '') {
      out.document = { ...out.document, description };
    }
    return listOf(out);
  }

  /**
   * The operations of one notification of the Store, read once it is applied: none when it
   * changed nothing of the document, and `null` when it replaced the whole document (read it
   * again with {@link documentOperations})
   */
  changeOperations(changes: StoreChange): ValueOperation[] | null {
    const reading = this.readChange(changes, Number.POSITIVE_INFINITY);
    if (!reading) return null;
    reading.step(Number.POSITIVE_INFINITY);
    const operations = reading.operations();
    reading.release();
    return operations;
  }

  /**
   * Reads one notification of the Store once it is applied, in the listener of the notification:
   * what tells the places at once, and the values of many rows over several tasks (`step`, from a
   * snapshot of the document as it is now). `null` when it replaced the whole document (read it
   * again with {@link documentOperations})
   *
   * @param atOnce - The most rows read now (more are read by `step`)
   * @param values - False to keep the places only, for a notification whose operations are not
   *   sent (one from elsewhere): no row is read
   */
  readChange(
    changes: StoreChange,
    atOnce = ROWS_READ_AT_ONCE,
    values = true,
  ): ChangeReading | null {
    if (changes.reset === true) {
      this.#placeDocument();
      return null;
    }
    const change = toChange(changes, this.store);
    const out = emptyOperations();
    if (!change) return readingOf(out, null);
    this.#files(changes, out);
    this.#layers(change, changes, out);
    const groups = this.#groups(change, changes, out);
    const rows = this.#features(change, changes, out, groups);
    this.#document(changes, out);
    const count = rows.created.length + rows.updated.length;
    if (count === 0 || !values) return readingOf(out, null);
    const lasting = count > atOnce ? this.store.openSnapshot() : undefined;
    if (!lasting) {
      // Read now, from the Store as the notification left it
      this.#readRows(rows, out, change, changes, null, Number.POSITIVE_INFINITY);
      return readingOf(out, null);
    }
    return readingOf(out, {
      step: (deadline) => this.#readRows(rows, out, change, changes, lasting, deadline),
      release: () => lasting.release(),
    });
  }

  // ==========================================================================
  // What changed
  // ==========================================================================

  #files(changes: StoreChange, out: Operations): void {
    for (const file of changes.files?.created ?? []) out.createdFiles.push(createFile(file));
    for (const file of changes.files?.deleted ?? []) {
      // A file deleted and made again in one transaction is there
      if (!this.store.getFile(file.id)) out.deletedFiles.push(file.id);
    }
  }

  #layers(change: Change, changes: StoreChange, out: Operations): void {
    const store = this.store;
    const ids = change.layers;
    for (const id of ids.deleted) {
      this.#places.delete(id);
      out.deletedLayers.push(id);
    }
    if (ids.created.length > 0 || ids.deleted.length > 0 || ids.placed.length > 0) {
      const moved = this.#placeAll(LAYERS, this.#layerIds());
      const created = new Set(ids.created);
      const placed = [...moved].filter((id) => !created.has(id));
      this.#pushPlaces(out, 'layer', placed, (id) => this.#places.get(id) as Place);
    }
    for (const id of ids.created) {
      const layer = store.getLayer(id);
      if (layer) out.createdLayers.push(createLayer(layer, this.#keyOf(id)));
    }
    const before = firstPrevious(changes.layers?.updated);
    for (const id of ids.updated) {
      const was = before.get(id);
      const now = store.getLayer(id);
      if (!was || !now) continue;
      const set = layerSet(was, now);
      if (set) out.set.push({ type: 'set', kind: 'layer', ids: [id], set });
    }
  }

  /**
   * @returns The items of the layers of objects the groups put elsewhere or made moved (the
   *   members of a group made among them), and the groups put in another layer, whose members
   *   are put there with them
   */
  #groups(change: Change, changes: StoreChange, out: Operations): GroupsMoved {
    const store = this.store;
    const ids = change.groups;
    // The layer each group put elsewhere was in
    const layersBefore = new Map<string, string>();
    for (const id of ids.placed) {
      const was = this.#places.get(id);
      const group = store.getGroup(id);
      if (was && group) layersBefore.set(id, this.#layerOfParent(was.parent));
    }
    // The items of the layers of objects where groups were put, made or deleted, and the members
    // of the groups made
    const touched = new Set<string>();
    for (const id of ids.deleted) {
      const was = this.#places.get(id);
      if (was) touched.add(was.parent);
      this.#places.delete(id);
      out.deletedGroups.push(id);
    }
    for (const id of [...ids.created, ...ids.placed]) {
      const was = this.#places.get(id);
      if (was) touched.add(was.parent);
      const group = store.getGroup(id);
      if (group) touched.add(group.layerId);
    }
    for (const id of ids.created) {
      const group = store.getGroup(id);
      if (group && group.kind !== 'table') touched.add(id);
    }
    const moved = this.#placeContainers(touched);
    const created = new Set(ids.created);
    const placed: string[] = [];
    for (const id of [...ids.placed, ...ids.updated]) {
      const group = store.getGroup(id);
      if (!group || created.has(id)) continue;
      if (group.kind === 'table') {
        // The tables keep the key of a group of rows
        const now: Place = { parent: group.layerId, key: this.#groupKey(group) };
        const was = this.#places.get(id);
        if (was && was.parent === now.parent && was.key === now.key) continue;
        this.#places.set(id, now);
        placed.push(id);
      } else if (moved.has(id)) {
        placed.push(id);
      }
    }
    this.#pushPlaces(out, 'group', unique(placed), (id) => this.#places.get(id) as Place);
    for (const id of ids.created) {
      const group = store.getGroup(id);
      if (!group) continue;
      const key = this.#groupKey(group);
      if (group.kind === 'table') this.#places.set(id, { parent: group.layerId, key });
      out.createdGroups.push(createGroup(group, key));
    }
    const before = firstPrevious(changes.groups?.updated);
    for (const id of ids.updated) {
      const was = before.get(id);
      const now = store.getGroup(id);
      if (!was || !now) continue;
      const set = groupSet(was, now);
      if (set) out.set.push({ type: 'set', kind: 'group', ids: [id], set });
    }
    const relayered: Group[] = [];
    for (const [id, layerId] of layersBefore) {
      const group = store.getGroup(id);
      if (group && group.layerId !== layerId) relayered.push(group);
    }
    return { moved, relayered };
  }

  #features(
    change: Change,
    changes: StoreChange,
    out: Operations,
    groups: GroupsMoved,
  ): RowsToRead {
    const store = this.store;
    const ids = change.features;
    // The lists of the layers and groups of objects features were put in, made in or deleted from
    const touched = new Set<string>();
    for (const id of ids.deleted) {
      const was = this.#places.get(id);
      if (was) touched.add(was.parent);
      this.#places.delete(id);
      out.deletedFeatures.push(id);
    }
    const rows: string[] = [];
    for (const id of [...ids.created, ...ids.placed]) {
      const was = this.#places.get(id);
      if (was) touched.add(was.parent);
      if (this.#isRow(id)) {
        rows.push(id);
        continue;
      }
      const feature = store.getFeature(id);
      if (feature) touched.add(feature.groupId ?? feature.layerId);
    }
    const moved = new Set([...groups.moved, ...this.#placeContainers(touched)]);
    // The members of a group put in another layer are put there: their layer is written
    for (const group of groups.relayered) {
      for (const id of this.#membersOf(group)) {
        if (this.#isRow(id)) rows.push(id);
        else moved.add(id);
      }
    }
    // The rows written with their place among the fields (a row put elsewhere and changed)
    const placedFields = placeFieldsWritten(changes);
    for (const id of ids.updated) {
      if (placedFields.size > 0 && this.#isRow(id)) {
        const layerId = store.getFeature(id)?.layerId;
        if (layerId !== undefined && placedFields.has(layerId)) rows.push(id);
      }
    }
    const rowPlaces = this.#rowPlaces(unique(rows));
    const created = new Set(ids.created);
    // The features of objects are read now; the rows are read by `#readRows`
    const toRead: RowsToRead = {
      created: [],
      updated: [],
      handles: [],
      at: 0,
      index: new Map(),
      indexed: 0,
    };
    const tables = store.tables;
    for (const id of ids.created) {
      const key = rowPlaces.get(id)?.key ?? this.#places.get(id)?.key ?? '';
      if (this.#isRow(id)) {
        toRead.created.push({ id, key });
        continue;
      }
      const feature = store.getFeature(id);
      if (feature) out.createdFeatures.push(createFeature(feature, key));
    }
    const placed: string[] = [];
    for (const id of moved) if (!created.has(id) && store.getFeature(id)) placed.push(id);
    for (const id of rowPlaces.keys()) if (!created.has(id)) placed.push(id);
    this.#pushPlaces(
      out,
      'feature',
      unique(placed),
      (id) => (rowPlaces.get(id) ?? this.#places.get(id)) as Place,
    );
    // Every feature updated is a row (a write of many rows): the IDs `change` lists are those of
    // the handles the notification lists, in their order
    const rowHandles = rowsUpdatedOf(changes);
    if (ids.updated.length > 0 && ids.updated.length === rowHandles.length) {
      toRead.updated = ids.updated;
      toRead.handles = rowHandles;
      return toRead;
    }
    const updated: string[] = [];
    const handles: number[] = [];
    for (const id of ids.updated) {
      const handle = tables?.getRowRef(id);
      if (handle !== undefined) {
        updated.push(id);
        handles.push(handle as number);
        continue;
      }
      const now = store.getFeature(id);
      if (!now) continue;
      const set = featureSet(change.previous(id), toFeature(now));
      if (set) out.set.push(set(id));
    }
    toRead.updated = updated;
    toRead.handles = handles;
    return toRead;
  }

  /**
   * Reads the values of rows a notification created and updated, until a time: from the Store as
   * the notification left it (`lasting` null, in the listener of the notification), or from the
   * snapshot taken then. A row updated is read with the values it had before for the fields the
   * notification wrote, the others being the same before and after
   *
   * @returns true once every row is read
   */
  #readRows(
    rows: RowsToRead,
    out: Operations,
    change: Change,
    changes: StoreChange,
    lasting: LastingSnapshot | null,
    deadline: number,
  ): boolean {
    const store = this.store;
    const read = (id: string): StoredFeature | undefined => {
      const snapshot = lasting?.snapshot();
      return snapshot ? snapshot.getFeature(id) : store.getFeature(id);
    };
    let looked = 0;
    const late = (): boolean => ++looked % ROWS_PER_LOOK === 0 && performance.now() >= deadline;
    const { created, updated } = rows;
    while (rows.at < created.length) {
      const { id, key } = created[rows.at++];
      const feature = read(id);
      if (feature) out.createdFeatures.push(createFeature(feature, key));
      if (late()) return false;
    }
    const values = changes.previousValues as RowValues | undefined;
    if (lasting && values && rows.at < created.length + updated.length) {
      // Where each row is among the values before, a part at a time
      const { index } = rows;
      while (rows.indexed < values.rows.length) {
        const end = Math.min(values.rows.length, rows.indexed + ROWS_PER_LOOK * 32);
        for (let i = rows.indexed; i < end; i++)
          if (!index.has(values.rows[i])) index.set(values.rows[i], i);
        rows.indexed = end;
        if (performance.now() >= deadline) return false;
      }
    }
    while (rows.at < created.length + updated.length) {
      const at = rows.at++ - created.length;
      const id = updated[at];
      const handle = rows.handles[at];
      const now = read(id);
      if (now) {
        const was = lasting
          ? valuesBefore(values, rows.index.get(handle), now)
          : change.previous(id);
        const set = featureSet(was, toFeature(now));
        if (set) out.set.push(set(id));
      }
      if (late()) return false;
    }
    return true;
  }

  #document(changes: StoreChange, out: Operations): void {
    const metadata = changes.metadata;
    if (!metadata) return;
    const now = metadata.metadata as { title?: unknown; description?: unknown };
    const was = metadata.previous as { title?: unknown; description?: unknown };
    const set: { title?: string; description?: string } = {};
    const text = (value: unknown): string => (typeof value === 'string' ? value : '');
    if (text(now.title) !== text(was.title)) set.title = text(now.title);
    if (text(now.description) !== text(was.description)) set.description = text(now.description);
    if (set.title !== undefined || set.description !== undefined) out.document = set;
  }

  // ==========================================================================
  // Places
  // ==========================================================================

  /** The IDs of the layers, in their order among the layers (other entries of the order left out) */
  #layerIds(): string[] {
    return this.store.getLayerOrder().filter((id) => this.store.getLayer(id) !== undefined);
  }

  /** Whether a feature is a row of a layer of rows */
  #isRow(id: string): boolean {
    return this.store.tables?.getRowRef(id) !== undefined;
  }

  /** The layer of a parent: the layer itself, or the layer of a group */
  #layerOfParent(parent: string): string {
    return this.store.getGroup(parent)?.layerId ?? parent;
  }

  /** The features of a group */
  #membersOf(group: Group): readonly string[] {
    if (group.kind !== 'table') return group.featureIds;
    const tables = this.store.tables;
    const view = tables?.get(group.layerId);
    const ref = tables?.getGroupRef(group.id);
    if (!tables || !view || ref === undefined) return [];
    const out: string[] = [];
    for (const row of view.listGroupMembers(ref, 0, view.countGroupMembers(ref))) {
      const id = tables.getRowId(row);
      if (id !== undefined) out.push(id);
    }
    return out;
  }

  #keyOf(id: string): string {
    return this.#places.get(id)?.key ?? '';
  }

  /** The key of a group: kept by the tables for a group of rows, here for one of objects */
  #groupKey(group: Group): string {
    if (group.kind !== 'table') return this.#keyOf(group.id);
    const tables = this.store.tables;
    const ref = tables?.getGroupRef(group.id);
    return (ref === undefined ? undefined : tables?.getGroupKey(ref)) ?? '';
  }

  /** The parents and keys of rows, as their tables hold them */
  #rowPlaces(ids: readonly string[]): Map<string, Place> {
    const out = new Map<string, Place>();
    const tables = this.store.tables;
    if (!tables || ids.length === 0) return out;
    const known = ids.filter((id) => tables.getRowRef(id) !== undefined);
    const rows = Int32Array.from(known, (id) => tables.getRowRef(id) as number);
    const read = tables.readValues({
      rows,
      fields: new Map<RowField, unknown[]>([
        ['parent', []],
        ['key', []],
      ]),
    });
    const parents = read.fields.get('parent') ?? [];
    const keys = read.fields.get('key') ?? [];
    known.forEach((id, i) => {
      if (typeof parents[i] === 'string' && typeof keys[i] === 'string') {
        out.set(id, { parent: parents[i] as string, key: keys[i] as string });
      }
    });
    return out;
  }

  /** Reads again the lists of the layers and groups of objects given (those still there) */
  #placeContainers(containers: ReadonlySet<string>): Set<string> {
    const moved = new Set<string>();
    for (const id of containers) {
      const items = this.#itemsOf(id);
      if (items) for (const item of this.#placeAll(id, items)) moved.add(item);
    }
    return moved;
  }

  /** The items of a layer or a group of objects, from the back (null for any other) */
  #itemsOf(id: string): readonly string[] | null {
    if (id === LAYERS) return this.#layerIds();
    const layer = this.store.getLayer(id);
    if (layer) return layer.kind === 'table' ? null : layer.items;
    const group = this.store.getGroup(id);
    return group && group.kind !== 'table' ? group.featureIds : null;
  }

  /**
   * Gives the items of a parent their keys in their order: the items there before that keep their
   * order among one another (the longest run of them) keep their keys, and the others take keys
   * between those of their neighbours
   *
   * @returns The items whose parent or key changed
   */
  #placeAll(parent: string, items: readonly string[]): Set<string> {
    const places = this.#places;
    // The items already there, by their key
    const there: number[] = [];
    for (let i = 0; i < items.length; i++) {
      if (places.get(items[i])?.parent === parent) there.push(i);
    }
    const sorted = there
      .map((i) => (places.get(items[i]) as Place).key)
      .sort(compareKeys)
      .filter((key, i, all) => i === 0 || all[i - 1] !== key);
    const ranks = new Map(sorted.map((key, rank) => [key, rank]));
    const run = longestRisingRun(
      there.map((i) => ranks.get((places.get(items[i]) as Place).key) as number),
    );
    const kept = new Set(run.map((k) => there[k]));
    const moved = new Set<string>();
    let below: string | null = null;
    for (let i = 0; i < items.length; ) {
      if (kept.has(i)) {
        below = (places.get(items[i]) as Place).key;
        i++;
        continue;
      }
      // A run of items with no key kept, up to the next kept one
      let end = i;
      while (end < items.length && !kept.has(end)) end++;
      const above = end < items.length ? (places.get(items[end]) as Place).key : null;
      const keys = keysBetween(below, above, end - i);
      for (let k = i; k < end; k++) {
        places.set(items[k], { parent, key: keys[k - i] });
        moved.add(items[k]);
      }
      below = keys[keys.length - 1] ?? below;
      i = end;
    }
    return moved;
  }

  /** The `place` operations of items, by their parent */
  #pushPlaces(
    out: Operations,
    kind: 'feature' | 'layer' | 'group',
    ids: readonly string[],
    placeOf: (id: string) => Place,
  ): void {
    const byParent = new Map<string, { ids: string[]; keys: string[] }>();
    for (const id of ids) {
      const place = placeOf(id);
      if (!place) continue;
      let entry = byParent.get(place.parent);
      if (!entry) {
        entry = { ids: [], keys: [] };
        byParent.set(place.parent, entry);
      }
      entry.ids.push(id);
      entry.keys.push(place.key);
    }
    for (const [parent, entry] of byParent) {
      out.placed.push({
        type: 'place',
        kind,
        ids: entry.ids,
        parentId: parent === LAYERS ? null : parent,
        keys: entry.keys,
      });
    }
  }
}

// ============================================================================
// Records
// ============================================================================

/** A reading of a notification: done, or read further by `rest` */
function readingOf(
  out: Operations,
  rest: { step(deadline: number): boolean; release(): void } | null,
): ChangeReading {
  let done = rest === null;
  let released = false;
  return {
    step(deadline) {
      if (!done && rest) done = rest.step(deadline);
      return done;
    },
    operations: () => listOf(out),
    release() {
      if (released) return;
      released = true;
      rest?.release();
    },
  };
}

/**
 * The handles of the rows a notification updated, besides those it only put in another place, in
 * the order `change` lists their IDs
 */
function rowsUpdatedOf(changes: StoreChange): Int32Array {
  const lists: Int32Array[] = [];
  let count = 0;
  for (const rows of changes.rows?.layers.values() ?? []) {
    let placedOnly = rows.fields.size > 0;
    for (const field of rows.fields) if (field !== 'parent' && field !== 'key') placedOnly = false;
    if (placedOnly) continue;
    lists.push(rows.updated);
    count += rows.updated.length;
  }
  const out = new Int32Array(count);
  let at = 0;
  for (const list of lists) {
    out.set(list, at);
    at += list.length;
  }
  return out;
}

/**
 * The feature of a row before a notification, from what it is after it: the values it had for the
 * fields the notification wrote (`StoreChange.previousValues`, at `index`), the others being the
 * same
 */
function valuesBefore(
  values: RowValues | undefined,
  index: number | undefined,
  now: StoredFeature,
): Feature | undefined {
  if (!values || index === undefined) return undefined;
  const fields = new Map<RowField, unknown>();
  for (const [field, list] of values.fields) fields.set(field, list[index]);
  return toFeature(featureWithFields(now, fields));
}

function emptyOperations(): Operations {
  return {
    createdFiles: [],
    createdLayers: [],
    createdGroups: [],
    createdFeatures: [],
    set: [],
    placed: [],
    deletedFeatures: [],
    deletedGroups: [],
    deletedLayers: [],
    deletedFiles: [],
    document: null,
  };
}

/**
 * The operations in the order they apply: what is made before what is in it, what is put in a
 * place before what it was in is deleted, and what is in a layer or a group deleted before it
 */
function listOf(out: Operations): ValueOperation[] {
  const list: ValueOperation[] = [
    ...out.createdFiles,
    ...out.createdLayers,
    ...out.createdGroups,
    ...out.createdFeatures,
    ...out.set,
    ...out.placed,
  ];
  const deleted = (kind: 'feature' | 'group' | 'layer' | 'file', ids: readonly string[]): void => {
    if (ids.length > 0) list.push({ type: 'delete', kind, ids: unique(ids) });
  };
  deleted('feature', out.deletedFeatures);
  deleted('group', out.deletedGroups);
  deleted('layer', out.deletedLayers);
  deleted('file', out.deletedFiles);
  if (out.document) list.push({ type: 'set', kind: 'document', set: out.document });
  return list;
}

/** Whether an object has a key of its own */
function hasKey(object: object, key: string): boolean {
  return Object.getOwnPropertyDescriptor(object, key) !== undefined;
}

function unique(ids: readonly string[]): string[] {
  return [...new Set(ids)];
}

/** The first value before of each ID a notification updated (the one before its first write) */
function firstPrevious<T>(
  updates: readonly { id: string; previous: T }[] | undefined,
): Map<string, T> {
  const out = new Map<string, T>();
  for (const update of updates ?? []) if (!out.has(update.id)) out.set(update.id, update.previous);
  return out;
}

/** The layers of rows whose rows a notification wrote with the fields of their place */
function placeFieldsWritten(changes: StoreChange): Set<string> {
  const out = new Set<string>();
  for (const [layerId, rows] of changes.rows?.layers ?? []) {
    if (rows.fields.has('parent') || rows.fields.has('key')) out.add(layerId);
  }
  return out;
}

/** The properties of a feature in their JSON form */
function jsonProperties(properties: { readonly [key: string]: unknown }): JsonObject {
  const out: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(properties)) {
    setOwnProperty(out, key, valueToJSON(value as Value) as JsonValue);
  }
  return out;
}

function createFeature(feature: StoredFeature, key: string): ValueOperation {
  const shown = toFeature(feature);
  const record: FeatureRecord = {
    geometry: orientedGeometry(shown.geometry) as Geometry,
    properties: jsonProperties(shown.properties),
    key,
  };
  return { type: 'create', kind: 'feature', id: feature.id, record };
}

function createLayer(layer: Layer, key: string): ValueOperation {
  const record: LayerRecord = {
    name: layer.name,
    visible: layer.visible,
    locked: layer.locked,
    opacity: layer.opacity,
    // A layer has no look of its own yet: its features take the defaults and its rule
    style: {},
    styleRule: (layer.styleRule ?? null) as StyleRule | null,
    key,
  };
  return { type: 'create', kind: 'layer', id: layer.id, record };
}

function createGroup(group: Group, key: string): ValueOperation {
  const record: GroupRecord = {
    name: group.name,
    layerId: group.layerId,
    parentId: null,
    visible: group.visible,
    locked: group.locked,
    key,
  };
  return { type: 'create', kind: 'group', id: group.id, record };
}

function createFile(file: FileData): ValueOperation {
  return { type: 'create', kind: 'file', id: file.id, record: fileRecordOf(file) };
}

/** A file as a record: its media type, and its bytes in base64 */
export function fileRecordOf(file: FileData): FileRecord {
  const url = file.dataURL;
  const comma = url.indexOf(',');
  const head = comma < 0 ? '' : url.slice(0, comma);
  const body = comma < 0 ? url : url.slice(comma + 1);
  if (/;base64$/i.test(head)) return { mediaType: file.mimeType, content: body };
  // A data URL of text: its characters, as the bytes of their UTF-8
  const bytes = new TextEncoder().encode(decodeURIComponent(body));
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return { mediaType: file.mimeType, content: btoa(binary) };
}

function layerSet(
  was: Layer,
  now: Layer,
): Extract<ValueOperation, { kind: 'layer'; type: 'set' }>['set'] | null {
  const set: {
    name?: string;
    visible?: boolean;
    locked?: boolean;
    opacity?: number;
    styleRule?: StyleRule | null;
  } = {};
  if (was.name !== now.name) set.name = now.name;
  if (was.visible !== now.visible) set.visible = now.visible;
  if (was.locked !== now.locked) set.locked = now.locked;
  if (was.opacity !== now.opacity) set.opacity = now.opacity;
  const rule = (now.styleRule ?? null) as StyleRule | null;
  if (!sameJson(was.styleRule ?? null, rule)) set.styleRule = rule;
  return Object.keys(set).length > 0 ? set : null;
}

function groupSet(
  was: Group,
  now: Group,
): Extract<ValueOperation, { kind: 'group'; type: 'set' }>['set'] | null {
  const set: { name?: string; visible?: boolean; locked?: boolean } = {};
  if (was.name !== now.name) set.name = now.name;
  if (was.visible !== now.visible) set.visible = now.visible;
  if (was.locked !== now.locked) set.locked = now.locked;
  return Object.keys(set).length > 0 ? set : null;
}

/**
 * The `set` of a feature from what it was to what it is: its geometry when it changed, the keys
 * of its properties that changed (the keys of its style one by one), and the keys it no longer
 * has. Its layer and group are its place, written by `place`. With nothing before (a feature of
 * rows written from elsewhere), every value it has is written.
 */
function featureSet(
  was: Feature | undefined,
  now: Feature,
): ((id: string) => ValueOperation) | null {
  const geometry = orientedGeometry(now.geometry) as Geometry;
  const before = (was?.properties ?? {}) as { readonly [key: string]: unknown };
  const after = now.properties as { readonly [key: string]: unknown };
  const properties: Record<string, JsonValue> = {};
  const unsetProperties: string[] = [];
  let unsetStyle: string[] = [];
  let changed = false;
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (key === LAYER_KEY || key === GROUP_KEY) continue;
    const inBefore = was !== undefined && hasKey(before, key);
    const inAfter = hasKey(after, key);
    if (key === STYLE_KEY) {
      const style = styleChange(
        inBefore ? (before[key] as JsonObject) : {},
        inAfter ? (after[key] as JsonObject) : {},
      );
      if (style.set) {
        setOwnProperty(properties, key, style.set);
        changed = true;
      }
      if (style.unset.length > 0) {
        unsetStyle = style.unset;
        changed = true;
      }
      continue;
    }
    if (!inAfter) {
      unsetProperties.push(key);
      changed = true;
    } else if (!inBefore || !sameJson(before[key], after[key])) {
      setOwnProperty(properties, key, valueToJSON(after[key] as Value) as JsonValue);
      changed = true;
    }
  }
  const geometryChanged = was === undefined || !sameJson(orientedGeometry(was.geometry), geometry);
  if (!changed && !geometryChanged) return null;
  const set: { geometry?: Geometry; properties?: JsonObject } = {};
  if (geometryChanged) set.geometry = geometry;
  if (Object.keys(properties).length > 0) set.properties = properties;
  const unset: { properties?: string[]; style?: string[] } = {};
  if (unsetProperties.length > 0) unset.properties = unsetProperties;
  if (unsetStyle.length > 0) unset.style = unsetStyle;
  const withUnset = Object.keys(unset).length > 0 ? { unset: unset as UnsetKeys } : {};
  return (id) => ({ type: 'set', kind: 'feature', ids: [id], set, ...withUnset });
}

/** The keys of a style that changed, and those it no longer has */
function styleChange(
  was: JsonObject,
  now: JsonObject,
): { readonly set: JsonObject | null; readonly unset: string[] } {
  const set: Record<string, JsonValue> = {};
  const unset: string[] = [];
  for (const key of Object.keys(was)) if (!hasKey(now, key)) unset.push(key);
  for (const [key, value] of Object.entries(now)) {
    if (!hasKey(was, key) || !sameJson(was[key], value)) setOwnProperty(set, key, value);
  }
  return { set: Object.keys(set).length > 0 ? set : null, unset };
}

/** Whether two values are the same value (the kinds of values JSON has not included) */
function sameJson(a: unknown, b: unknown): boolean {
  return sameValue(a as Value, b as Value);
}
