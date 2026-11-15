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
import { KeptRecords, placementOf, withPlacement } from './kept.js';
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

/**
 * Where an item is, as the operations say it: its parent (`null` for a layer among the layers)
 * and its key there
 *
 * @internal
 */
export interface ItemPlace {
  readonly parentId: string | null;
  readonly key: string;
}

/** Where items are, by their IDs (undefined: nowhere known) */
type PlaceList = Map<string, ItemPlace | undefined>;

/**
 * The `set` of a feature from one record to another: its geometry when it changed, the keys of
 * its properties that changed (the keys of its style one by one) and those it no longer has; its
 * layer and group are its place
 */
function recordSet(
  now: FeatureRecord,
  was: FeatureRecord,
): { set: { geometry?: Geometry; properties?: JsonObject }; unset?: UnsetKeys } | null {
  const set: { geometry?: Geometry; properties?: JsonObject } = {};
  if (!sameJson(now.geometry, was.geometry)) set.geometry = was.geometry;
  const properties: Record<string, JsonValue> = {};
  const unsetProperties: string[] = [];
  let unsetStyle: string[] = [];
  for (const key of new Set([...Object.keys(now.properties), ...Object.keys(was.properties)])) {
    if (key === LAYER_KEY || key === GROUP_KEY) continue;
    const inNow = hasKey(now.properties, key);
    const inWas = hasKey(was.properties, key);
    if (key === STYLE_KEY) {
      const style = styleChange(
        inNow ? (now.properties[key] as JsonObject) : {},
        inWas ? (was.properties[key] as JsonObject) : {},
      );
      if (style.set) setOwnProperty(properties, key, style.set);
      unsetStyle = style.unset;
      continue;
    }
    if (!inWas) unsetProperties.push(key);
    else if (!inNow || !sameJson(now.properties[key], was.properties[key])) {
      setOwnProperty(properties, key, was.properties[key] as JsonValue);
    }
  }
  if (Object.keys(properties).length > 0) set.properties = properties;
  const unset: { properties?: string[]; style?: string[] } = {};
  if (unsetProperties.length > 0) unset.properties = unsetProperties;
  if (unsetStyle.length > 0) unset.style = unsetStyle;
  const hasUnset = Object.keys(unset).length > 0;
  if (Object.keys(set).length === 0 && !hasUnset) return null;
  return hasUnset ? { set, unset } : { set };
}

/** A feature as the document of the storage had it before a write */
interface FeatureBefore {
  readonly record: FeatureRecord;
  /** Whether the group its record names was there */
  readonly groupThere: boolean;
  /** Whether the layer its record names was there */
  readonly layerThere: boolean;
}

/** A group as the document of the storage had it before a write */
type GroupBefore = GroupRecord;

/** A layer or a group as it was before a write */
interface ContainerBefore<T, R> {
  readonly item: T;
  readonly record: R;
  readonly place: ItemPlace | undefined;
}

/**
 * What operations name, as it was before they were written (null: it was not there), read by
 * `CommitValues.namedBefore`
 *
 * @internal
 */
export interface NamedBefore {
  readonly features: ReadonlyMap<string, FeatureBefore | null>;
  readonly layers: ReadonlyMap<string, ContainerBefore<Layer, LayerRecord> | null>;
  readonly groups: ReadonlyMap<string, GroupBefore | null>;
  readonly files: ReadonlyMap<string, FileData | null>;
  readonly document: { readonly title: string; readonly description: string } | null;
}

/** Whether two places are the same */
function samePlace(a: ItemPlace | undefined, b: ItemPlace | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.parentId === b.parentId && a.key === b.key;
}

/** The record a `create` makes */
function recordOfOperation(operation: ValueOperation): unknown {
  return operation.type === 'create' ? operation.record : undefined;
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
  /**
   * The operations that take them back, in the order they apply, once `step` said every one is
   * read: what was created deleted, what was deleted created again where it was, the values
   * written put back, the items put elsewhere put back (none for a notification from elsewhere)
   */
  inverse(): ValueOperation[];
  /** Lets go of the snapshot it reads from (once read, or when it is dropped) */
  release(): void;
}

/** The notification rows deleted by it come from */
interface DeletedBy {
  readonly change: Change;
  readonly changes: StoreChange;
  /** Where the rows were before it, read once */
  placesBefore?: Map<number, Place>;
}

/** A row a notification deleted, whose record before it is read for the inverse */
interface DeletedRow {
  readonly id: string;
  readonly handle: number;
  readonly by: DeletedBy;
  /** Its feature before the notification and its key then, once read (undefined: not yet) */
  before?: { readonly feature: Feature | undefined; readonly key: string };
  /** The IDs the storage gave it after it was deleted, by which it is made again too */
  names?: string[];
}

/** The rows of a notification whose values are still to be read, and how far they are read */
interface RowsToRead {
  /** The rows created, with their keys */
  readonly created: { readonly id: string; readonly key: string }[];
  /** The rows deleted, and their handles: what makes them again is read for the inverse */
  readonly deleted: DeletedRow[];
  /** The rows updated, and their handles where the notification went out */
  updated: readonly string[];
  handles: ArrayLike<number>;
  /** The first of `created`, then of `updated`, then of `deleted`, not read yet */
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
  /** The groups told as put in a place, or as created */
  readonly told: ReadonlySet<string>;
}

/** The operations of one notification, by what they do, in the order they are applied */
interface Operations {
  readonly createdFiles: ValueOperation[];
  readonly createdLayers: ValueOperation[];
  readonly createdGroups: ValueOperation[];
  readonly createdFeatures: ValueOperation[];
  readonly set: ValueOperation[];
  readonly placed: ValueOperation[];
  /**
   * The features deleted and made again as they were, where no place gives them back their keys
   * (after the places)
   */
  readonly placeKeys: ValueOperation[];
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
  /** What the storage has that the Store does not show (see `kept.ts`) */
  readonly kept = new KeptRecords();
  /** The places of the layers, and of the items of the layers of objects */
  readonly #places = new Map<string, Place>();
  /**
   * The place each item had before the notification being read changed it (null: it had none),
   * while one whose inverse is read is
   */
  #before: Map<string, Place | null> | null = null;
  /**
   * The rows deleted by notifications read over several tasks, not read yet, by their IDs (and by
   * the IDs the storage gave them since): one made again (an undo) is read when it comes back,
   * before it can be written again
   */
  readonly #unreadDeleted = new Map<string, DeletedRow>();

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
      // The tables keep the key of a group of rows: it is known here once read
      else this.#places.set(group.id, { parent: group.layerId, key: this.#groupKey(group) });
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
      else this.#places.set(group.id, { parent: group.layerId, key: this.#groupKey(group) });
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
      this.kept.clear();
      return null;
    }
    const change = toChange(changes, this.store);
    if (change && this.#unreadDeleted.size > 0) {
      for (const id of change.features.created) {
        const row = this.#unreadDeleted.get(id);
        if (!row) continue;
        this.#forgetUnread(row);
        // As it was before it was deleted, where it was: what it is made again with
        row.before = {
          feature: row.by.change.previous(row.id) ?? row.by.change.previous(id),
          key: this.#deletedKeys([row]).get(row.id) ?? '',
        };
      }
    }
    const out = emptyOperations();
    if (!change) return readingOf(out, null, null);
    // The inverse is read of a notification of this client only
    const inv = values ? emptyOperations() : null;
    this.#before = inv ? new Map() : null;
    let rows: RowsToRead;
    try {
      this.#files(changes, out, inv);
      this.#layers(change, changes, out, inv);
      const groups = this.#groups(change, changes, out, inv);
      rows = this.#features(change, changes, out, inv, groups);
      this.#document(changes, out, inv);
      if (inv) this.#placementsBack(change, inv);
    } finally {
      this.#before = null;
    }
    const count = rows.created.length + rows.updated.length + rows.deleted.length;
    if (count === 0 || !values) return readingOf(out, inv, null);
    const lasting = count > atOnce ? this.store.openSnapshot() : undefined;
    if (!lasting) {
      // Read now, from the Store as the notification left it
      this.#readRows(rows, out, inv, change, changes, null, Number.POSITIVE_INFINITY);
      return readingOf(out, inv, null);
    }
    for (const row of rows.deleted) this.#unreadDeleted.set(row.id, row);
    return readingOf(out, inv, {
      step: (deadline) => this.#readRows(rows, out, inv, change, changes, lasting, deadline),
      release: () => {
        lasting.release();
        for (const row of rows.deleted) this.#forgetUnread(row);
      },
    });
  }

  /**
   * Follows the IDs the storage gave features (from the old to the new): a row deleted and not
   * read yet is found by the new ID too, should it be made again under it
   */
  followIds(ids: ReadonlyMap<string, string>): void {
    if (this.#unreadDeleted.size === 0) return;
    for (const [from, to] of ids) {
      const row = this.#unreadDeleted.get(from);
      if (!row || this.#unreadDeleted.has(to)) continue;
      this.#unreadDeleted.set(to, row);
      (row.names ??= []).push(to);
    }
  }

  /** A row deleted no longer waits to be read under its IDs */
  #forgetUnread(row: DeletedRow): void {
    for (const id of [row.id, ...(row.names ?? [])]) {
      if (this.#unreadDeleted.get(id) === row) this.#unreadDeleted.delete(id);
    }
  }

  // ==========================================================================
  // The document as it is now, for what writes to it and compares with it
  // ==========================================================================

  /**
   * Where an item is now: its parent (`null` for a layer among the layers) and its key there.
   * Undefined for what is not there
   */
  placeOf(kind: 'feature' | 'layer' | 'group', id: string): ItemPlace | undefined {
    const store = this.store;
    if (kind === 'feature' && this.#isRow(id)) {
      const place = this.#rowPlaces([id]).get(id);
      return place && { parentId: place.parent, key: place.key };
    }
    if (kind === 'group') {
      const group = store.getGroup(id);
      if (!group) return undefined;
      if (group.kind === 'table') return { parentId: group.layerId, key: this.#groupKey(group) };
    }
    const place = this.#places.get(id);
    if (!place) return undefined;
    return { parentId: place.parent === LAYERS ? null : place.parent, key: place.key };
  }

  /**
   * Keeps the key of an item of a layer of objects, or of a layer, that is written in a place now:
   * the notification of the write, read after, keeps it while the order says it is there
   */
  keepPlace(id: string, parentId: string | null, key: string): void {
    this.#places.set(id, { parent: parentId ?? LAYERS, key });
  }

  /** The items of a parent of objects (`null`: the layers) by their keys here, with their keys */
  keysUnder(parentId: string | null): ReadonlyArray<{ readonly id: string; readonly key: string }> {
    const parent = parentId ?? LAYERS;
    const items = this.#itemsOf(parent) ?? [];
    const out: { id: string; key: string }[] = [];
    for (const id of items) {
      const place = this.#places.get(id);
      if (place?.parent === parent) out.push({ id, key: place.key });
    }
    return out;
  }

  /** The record of a feature, a layer or a group as it is now (undefined when it is not there) */
  recordOf(kind: 'feature', id: string): FeatureRecord | undefined;
  recordOf(kind: 'layer', id: string): LayerRecord | undefined;
  recordOf(kind: 'group', id: string): GroupRecord | undefined;
  recordOf(
    kind: 'feature' | 'layer' | 'group',
    id: string,
  ): FeatureRecord | LayerRecord | GroupRecord | undefined {
    const store = this.store;
    const key = this.placeOf(kind, id)?.key ?? '';
    const made = (operation: ValueOperation) =>
      operation.type === 'create' ? operation.record : undefined;
    switch (kind) {
      case 'feature': {
        const feature = store.getFeature(id);
        return feature && (made(createFeature(feature, key)) as FeatureRecord);
      }
      case 'layer': {
        const layer = store.getLayer(id);
        return layer && (made(createLayer(layer, key)) as LayerRecord);
      }
      case 'group': {
        const group = store.getGroup(id);
        return group && (made(createGroup(group, key)) as GroupRecord);
      }
    }
  }

  /**
   * What operations name, as the document of the storage has it before they are written to the
   * Store (what is shown, and what is kept): what takes the write back is read from it once they
   * are written ({@link inverseSince}). The groups the features named are in are named too (a
   * group a write leaves with no member is no longer shown)
   */
  namedBefore(operations: readonly ValueOperation[]): NamedBefore {
    const store = this.store;
    const features = new Set<string>();
    const layers = new Set<string>();
    const groups = new Set<string>();
    const files = new Set<string>();
    let document = false;
    const add = (kind: 'feature' | 'layer' | 'group' | 'file', id: string): void => {
      (kind === 'feature'
        ? features
        : kind === 'layer'
          ? layers
          : kind === 'group'
            ? groups
            : files
      ).add(id);
    };
    for (const operation of operations) {
      switch (operation.type) {
        case 'create': {
          add(operation.kind, operation.id);
          if (operation.kind === 'feature') {
            const group = operation.record.properties[GROUP_KEY];
            if (typeof group === 'string') groups.add(group);
          }
          break;
        }
        case 'set':
          if (operation.kind === 'document') document = true;
          else for (const id of operation.ids) add(operation.kind, id);
          break;
        case 'place':
          for (const id of operation.ids) add(operation.kind, id);
          if (operation.kind !== 'layer' && operation.parentId !== null) {
            groups.add(operation.parentId);
          }
          break;
        case 'delete':
          for (const id of operation.ids) add(operation.kind, id);
          break;
      }
    }
    const records = this.#featureRecords([...features]);
    for (const record of records.values()) {
      const group = record?.properties[GROUP_KEY];
      if (typeof group === 'string') groups.add(group);
    }
    for (const id of features) {
      const group = store.getFeature(id)?.groupId;
      if (group !== undefined) groups.add(group);
    }
    const groupsBefore = new Map<string, GroupBefore | null>();
    for (const id of groups) {
      const record = this.#groupRecord(id);
      if (record) groupsBefore.set(id, record);
      else if (!store.getLayer(id)) groupsBefore.set(id, null);
    }
    const featuresBefore = new Map<string, FeatureBefore | null>();
    for (const [id, record] of records) {
      if (!record) {
        featuresBefore.set(id, null);
        continue;
      }
      const keys = placementOf(record);
      const group = keys.groupId === undefined ? undefined : this.#groupRecord(keys.groupId);
      featuresBefore.set(id, {
        record,
        groupThere: group !== undefined,
        layerThere: store.getLayer(keys.layerId) !== undefined,
      });
    }
    const layersBefore = new Map<string, ContainerBefore<Layer, LayerRecord> | null>();
    for (const id of layers) {
      const layer = store.getLayer(id);
      const place = layer && this.placeOf('layer', id);
      layersBefore.set(
        id,
        layer
          ? {
              item: layer,
              record: recordOfOperation(createLayer(layer, place?.key ?? '')) as LayerRecord,
              place,
            }
          : null,
      );
    }
    const filesBefore = new Map<string, FileData | null>();
    for (const id of files) filesBefore.set(id, store.getFile(id) ?? null);
    const metadata = store.getMetadata();
    const text = (value: unknown): string => (typeof value === 'string' ? value : '');
    return {
      features: featuresBefore,
      layers: layersBefore,
      groups: groupsBefore,
      files: filesBefore,
      document: document
        ? { title: text(metadata.title), description: text(metadata.description) }
        : null,
    };
  }

  /**
   * The operations that take the document of the storage back to what {@link namedBefore} read,
   * once the operations it was read for are written: what they created deleted, what they deleted
   * created again where it was, the values they wrote put back, the things they put elsewhere put
   * back (by the keys of its place written again when no place there is to put it in)
   */
  inverseSince(before: NamedBefore): ValueOperation[] {
    const store = this.store;
    const out = emptyOperations();
    const records = this.#featureRecords([...before.features.keys()]);
    const placed = new Map<string, { ids: string[]; keys: string[] }>();
    const place = (parentId: string, id: string, key: string): void => {
      const list = placed.get(parentId) ?? { ids: [], keys: [] };
      placed.set(parentId, list);
      list.ids.push(id);
      list.keys.push(key);
    };
    for (const [id, was] of before.features) {
      const now = records.get(id);
      if (!was) {
        if (now) out.deletedFeatures.push(id);
        continue;
      }
      if (!now) {
        out.createdFeatures.push({ type: 'create', kind: 'feature', id, record: was.record });
        continue;
      }
      const set = recordSet(now, was.record);
      if (set) out.set.push({ type: 'set', kind: 'feature', ids: [id], ...set });
      const keys = placementOf(was.record);
      const nowKeys = placementOf(now);
      if (
        keys.layerId === nowKeys.layerId &&
        keys.groupId === nowKeys.groupId &&
        was.record.key === now.key
      ) {
        continue;
      }
      // Put back in its group, or else in its layer, when it was there and that place gives it
      // the keys it had; else deleted and made again as it was (a place under a parent not there
      // is left out)
      const group = keys.groupId === undefined ? undefined : before.groups.get(keys.groupId);
      if (keys.groupId !== undefined && was.groupThere && group?.layerId === keys.layerId) {
        place(keys.groupId, id, was.record.key);
      } else if (keys.groupId === undefined && was.layerThere) {
        place(keys.layerId, id, was.record.key);
      } else {
        out.placeKeys.push(
          { type: 'delete', kind: 'feature', ids: [id] },
          { type: 'create', kind: 'feature', id, record: was.record },
        );
      }
    }
    const layersBack: PlaceList = new Map();
    for (const [id, was] of before.layers) {
      const now = store.getLayer(id);
      if (!was) {
        if (now) out.deletedLayers.push(id);
        continue;
      }
      if (!now) {
        out.createdLayers.push({ type: 'create', kind: 'layer', id, record: was.record });
        continue;
      }
      const set = layerSet(now, was.item);
      if (set) out.set.push({ type: 'set', kind: 'layer', ids: [id], set });
      if (!samePlace(this.placeOf('layer', id), was.place)) layersBack.set(id, was.place);
    }
    const groupsBack: Array<{ id: string; layerId: string; key: string }> = [];
    for (const [id, was] of before.groups) {
      const now = this.#groupRecord(id);
      if (!was) {
        if (now) out.deletedGroups.push(id);
        continue;
      }
      if (!now) {
        out.createdGroups.push({ type: 'create', kind: 'group', id, record: was });
        continue;
      }
      const set: { name?: string; visible?: boolean; locked?: boolean } = {};
      if (now.name !== was.name) set.name = was.name;
      if (now.visible !== was.visible) set.visible = was.visible;
      if (now.locked !== was.locked) set.locked = was.locked;
      if (Object.keys(set).length > 0) out.set.push({ type: 'set', kind: 'group', ids: [id], set });
      if (now.layerId !== was.layerId || now.key !== was.key) {
        groupsBack.push({ id, layerId: was.layerId, key: was.key });
      }
    }
    this.#pushPlaces(out, 'layer', [...layersBack.keys()], (id) => {
      const at = layersBack.get(id);
      return at && { parent: LAYERS, key: at.key };
    });
    for (const { id, layerId, key } of groupsBack) {
      out.placed.push({ type: 'place', kind: 'group', ids: [id], parentId: layerId, keys: [key] });
    }
    for (const [parentId, list] of placed) {
      out.placed.push({ type: 'place', kind: 'feature', ids: list.ids, parentId, keys: list.keys });
    }
    for (const [id, was] of before.files) {
      const now = store.getFile(id);
      if (!was && now) out.deletedFiles.push(id);
      else if (was && !now) out.createdFiles.push(createFile(was));
    }
    if (before.document) {
      const metadata = store.getMetadata();
      const text = (value: unknown): string => (typeof value === 'string' ? value : '');
      const set: { title?: string; description?: string } = {};
      if (text(metadata.title) !== before.document.title) set.title = before.document.title;
      if (text(metadata.description) !== before.document.description) {
        set.description = before.document.description;
      }
      if (set.title !== undefined || set.description !== undefined) out.document = set;
    }
    return listOf(out);
  }

  /**
   * The records of features as the document of the storage has them (null: it has none): those
   * the Store shows with the keys of the place the storage has (see `KeptRecords.placements`), the
   * rows read at once, and those kept
   */
  #featureRecords(ids: readonly string[]): Map<string, FeatureRecord | null> {
    const store = this.store;
    const out = new Map<string, FeatureRecord | null>();
    const rows: string[] = [];
    for (const id of ids) {
      if (this.#isRow(id)) rows.push(id);
    }
    const rowPlaces = this.#rowPlaces(rows);
    for (const id of ids) {
      const stored = store.getFeature(id);
      if (!stored) {
        out.set(id, this.kept.features.get(id) ?? null);
        continue;
      }
      const key = rowPlaces.get(id)?.key ?? this.#places.get(id)?.key ?? '';
      const record = recordOfOperation(createFeature(stored, key)) as FeatureRecord;
      const keys = this.kept.placements.get(id);
      out.set(id, keys ? withPlacement(record, keys) : record);
    }
    return out;
  }

  /** The record of a group as the document of the storage has it (shown or kept) */
  #groupRecord(id: string): GroupRecord | undefined {
    if (this.store.getGroup(id)) return this.recordOf('group', id);
    return this.kept.groups.get(id);
  }

  /** Changes the place of an item, noting the one it had before (see `#before`) */
  #setPlace(id: string, place: Place | undefined): void {
    const before = this.#before;
    if (before && !before.has(id)) before.set(id, this.#places.get(id) ?? null);
    if (place) this.#places.set(id, place);
    else this.#places.delete(id);
  }

  /** The place an item had before the notification being read (see `#before`) */
  #placeBefore(id: string): Place | null {
    const before = this.#before;
    if (before?.has(id)) return before.get(id) ?? null;
    return this.#places.get(id) ?? null;
  }

  // ==========================================================================
  // What changed
  // ==========================================================================

  #files(changes: StoreChange, out: Operations, inv: Operations | null): void {
    for (const file of changes.files?.created ?? []) {
      out.createdFiles.push(createFile(file));
      inv?.deletedFiles.push(file.id);
    }
    for (const file of changes.files?.deleted ?? []) {
      // A file deleted and made again in one transaction is there
      if (this.store.getFile(file.id)) continue;
      out.deletedFiles.push(file.id);
      inv?.createdFiles.push(createFile(file));
    }
  }

  #layers(change: Change, changes: StoreChange, out: Operations, inv: Operations | null): void {
    const store = this.store;
    const ids = change.layers;
    const deleted = new Map((changes.layers?.deleted ?? []).map((layer) => [layer.id, layer]));
    for (const id of ids.deleted) {
      const layer = deleted.get(id);
      if (inv && layer) inv.createdLayers.push(createLayer(layer, this.#keyOf(id)));
      this.#setPlace(id, undefined);
      out.deletedLayers.push(id);
    }
    if (ids.created.length > 0 || ids.deleted.length > 0 || ids.placed.length > 0) {
      const moved = this.#placeAll(LAYERS, this.#layerIds());
      const created = new Set(ids.created);
      const placed = [...moved].filter((id) => !created.has(id));
      this.#pushPlaces(out, 'layer', placed, (id) => this.#places.get(id) as Place);
      if (inv) this.#pushPlaces(inv, 'layer', placed, (id) => this.#placeBefore(id));
    }
    for (const id of ids.created) {
      const layer = store.getLayer(id);
      if (layer) out.createdLayers.push(createLayer(layer, this.#keyOf(id)));
      inv?.deletedLayers.push(id);
    }
    const before = firstPrevious(changes.layers?.updated);
    for (const id of ids.updated) {
      const was = before.get(id);
      const now = store.getLayer(id);
      if (!was || !now) continue;
      const set = layerSet(was, now);
      if (set) out.set.push({ type: 'set', kind: 'layer', ids: [id], set });
      const back = inv ? layerSet(now, was) : null;
      if (back) inv?.set.push({ type: 'set', kind: 'layer', ids: [id], set: back });
    }
  }

  /**
   * @returns The items of the layers of objects the groups put elsewhere or made moved (the
   *   members of a group made among them), and the groups put in another layer, whose members
   *   are put there with them
   */
  #groups(
    change: Change,
    changes: StoreChange,
    out: Operations,
    inv: Operations | null,
  ): GroupsMoved {
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
    const deleted = new Map((changes.groups?.deleted ?? []).map((group) => [group.id, group]));
    for (const id of ids.deleted) {
      const was = this.#places.get(id);
      if (was) touched.add(was.parent);
      const group = deleted.get(id);
      if (inv && group) inv.createdGroups.push(createGroup(group, was?.key ?? ''));
      this.#setPlace(id, undefined);
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
    // The groups of rows given another key where they stand are told apart from the order
    for (const id of unique([...ids.placed, ...ids.updated, ...(changes.groupsPlaced ?? [])])) {
      const group = store.getGroup(id);
      if (!group || created.has(id)) continue;
      if (group.kind === 'table') {
        // The tables keep the key of a group of rows
        const now: Place = { parent: group.layerId, key: this.#groupKey(group) };
        const was = this.#places.get(id);
        if (was && was.parent === now.parent && was.key === now.key) continue;
        this.#setPlace(id, now);
        placed.push(id);
      } else if (moved.has(id)) {
        placed.push(id);
      }
    }
    // The groups of objects given other keys where they stand (those of the same key above an item
    // put between them)
    for (const id of moved) {
      const group = store.getGroup(id);
      if (group && group.kind !== 'table' && !created.has(id)) placed.push(id);
    }
    this.#pushPlaces(out, 'group', unique(placed), (id) => this.#places.get(id) as Place);
    if (inv) this.#pushPlaces(inv, 'group', unique(placed), (id) => this.#placeBefore(id));
    for (const id of ids.created) {
      inv?.deletedGroups.push(id);
      const group = store.getGroup(id);
      if (!group) continue;
      const key = this.#groupKey(group);
      if (group.kind === 'table') this.#setPlace(id, { parent: group.layerId, key });
      out.createdGroups.push(createGroup(group, key));
    }
    const before = firstPrevious(changes.groups?.updated);
    for (const id of ids.updated) {
      const was = before.get(id);
      const now = store.getGroup(id);
      if (!was || !now) continue;
      const set = groupSet(was, now);
      if (set) out.set.push({ type: 'set', kind: 'group', ids: [id], set });
      const back = inv ? groupSet(now, was) : null;
      if (back) inv?.set.push({ type: 'set', kind: 'group', ids: [id], set: back });
    }
    const relayered: Group[] = [];
    for (const [id, layerId] of layersBefore) {
      const group = store.getGroup(id);
      if (group && group.layerId !== layerId) relayered.push(group);
    }
    return { moved, relayered, told: new Set([...placed, ...created]) };
  }

  #features(
    change: Change,
    changes: StoreChange,
    out: Operations,
    inv: Operations | null,
    groups: GroupsMoved,
  ): RowsToRead {
    const store = this.store;
    const ids = change.features;
    // The rows deleted, by their IDs: what makes them again is read with the values of the rows
    const rowsDeleted = inv ? rowsDeletedOf(changes, store) : null;
    const deletedRows: DeletedRow[] = [];
    const by: DeletedBy = { change, changes };
    // The lists of the layers and groups of objects features were put in, made in or deleted from
    const touched = new Set<string>();
    for (const id of ids.deleted) {
      const was = this.#places.get(id);
      if (was) touched.add(was.parent);
      const handle = rowsDeleted?.get(id);
      if (handle !== undefined) {
        deletedRows.push({ id, handle, by });
      } else if (inv) {
        const before = change.previous(id);
        if (before) inv.createdFeatures.push(createShownFeature(id, before, was?.key ?? ''));
      }
      this.#setPlace(id, undefined);
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
    // The groups of objects given other keys where they stand by the features put among them
    const regrouped = [...moved].filter((id) => {
      if (groups.told.has(id)) return false;
      const group = store.getGroup(id);
      return group !== undefined && group.kind !== 'table';
    });
    if (regrouped.length > 0) {
      this.#pushPlaces(out, 'group', regrouped, (id) => this.#places.get(id) as Place);
      if (inv) this.#pushPlaces(inv, 'group', regrouped, (id) => this.#placeBefore(id));
    }
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
      deleted: deletedRows,
      updated: [],
      handles: [],
      at: 0,
      index: new Map(),
      indexed: 0,
    };
    const tables = store.tables;
    for (const id of ids.created) {
      inv?.deletedFeatures.push(id);
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
    if (inv) {
      // Where each was: a row by the values of its place before, an item of objects as noted
      const rowsBefore = rowPlaces.size > 0 ? rowPlacesBefore(changes) : null;
      this.#pushPlaces(inv, 'feature', unique(placed), (id) => {
        if (!rowPlaces.has(id)) return this.#placeBefore(id);
        const handle = tables?.getRowRef(id);
        return (handle === undefined ? undefined : rowsBefore?.get(handle as number)) ?? null;
      });
    }
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
      const was = change.previous(id);
      const shown = toFeature(now);
      const set = featureSet(was, shown);
      if (set) out.set.push(set(id));
      const back = inv && was ? featureSet(shown, was) : null;
      if (back) inv?.set.push(back(id));
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
    inv: Operations | null,
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
    const { created, updated, deleted } = rows;
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
        const shown = toFeature(now);
        const set = featureSet(was, shown);
        if (set) out.set.push(set(id));
        const back = inv && was ? featureSet(shown, was) : null;
        if (back) inv?.set.push(back(id));
      }
      if (late()) return false;
    }
    if (inv && rows.at < created.length + updated.length + deleted.length) {
      // The rows deleted, as they were: kept by the tables while their deletion can be undone, at
      // the key they had before the notification (a row put elsewhere before it was deleted), or
      // as read when they were made again (see `#unreadDeleted`)
      const from = rows.at - created.length - updated.length;
      const keys = this.#deletedKeys(deleted.slice(from).filter((row) => !row.before));
      for (let i = from; i < deleted.length; i++) {
        rows.at++;
        const row = deleted[i];
        const before = row.before ?? {
          feature: change.previous(row.id),
          key: keys.get(row.id) ?? '',
        };
        this.#forgetUnread(row);
        if (before.feature) {
          inv.createdFeatures.push(createShownFeature(row.id, before.feature, before.key));
        }
        if (late()) return false;
      }
    }
    return true;
  }

  /**
   * The keys of the place the storage has of the features a commit of this client puts elsewhere
   * or deletes, where they are not where the features are shown (see `KeptRecords.placements`):
   * what takes the commit back writes them again, after it puts the features back. The commit
   * writes the keys of where it puts them: they are where they are shown after it
   */
  #placementsBack(change: Change, inv: Operations): void {
    const placements = this.kept.placements;
    if (placements.size === 0) return;
    const named = new Set([...change.features.placed, ...change.features.deleted]);
    for (const operation of inv.placed) {
      if (operation.type === 'place' && operation.kind === 'feature') {
        for (const id of operation.ids) named.add(id);
      }
    }
    for (const [id, keys] of placements) {
      if (!named.has(id)) continue;
      inv.placeKeys.push({
        type: 'set',
        kind: 'feature',
        ids: [id],
        set: {
          properties: {
            [LAYER_KEY]: keys.layerId,
            ...(keys.groupId !== undefined && { [GROUP_KEY]: keys.groupId }),
          },
        },
        ...(keys.groupId === undefined && { unset: { properties: [GROUP_KEY] } }),
      });
      placements.delete(id);
    }
  }

  #document(changes: StoreChange, out: Operations, inv: Operations | null): void {
    const metadata = changes.metadata;
    if (!metadata) return;
    const now = metadata.metadata as { title?: unknown; description?: unknown };
    const was = metadata.previous as { title?: unknown; description?: unknown };
    const set: { title?: string; description?: string } = {};
    const text = (value: unknown): string => (typeof value === 'string' ? value : '');
    if (text(now.title) !== text(was.title)) set.title = text(now.title);
    if (text(now.description) !== text(was.description)) set.description = text(now.description);
    if (set.title !== undefined || set.description !== undefined) out.document = set;
    if (!inv) return;
    const back: { title?: string; description?: string } = {};
    if (set.title !== undefined) back.title = text(was.title);
    if (set.description !== undefined) back.description = text(was.description);
    if (back.title !== undefined || back.description !== undefined) inv.document = back;
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

  /** The keys of rows by their handles, deleted rows the tables keep included */
  #rowPlacesOf(handles: readonly number[]): Map<number, string> {
    const out = new Map<number, string>();
    const tables = this.store.tables;
    if (!tables || handles.length === 0) return out;
    const read = tables.readValues({
      rows: Int32Array.from(handles),
      fields: new Map<RowField, unknown[]>([['key', []]]),
    });
    const keys = read.fields.get('key') ?? [];
    handles.forEach((handle, i) => {
      if (typeof keys[i] === 'string') out.set(handle, keys[i] as string);
    });
    return out;
  }

  /**
   * The keys rows deleted had before the notification that deleted them: where the notification
   * says they were, else the key the tables keep for them
   */
  #deletedKeys(rows: readonly DeletedRow[]): Map<string, string> {
    const out = new Map<string, string>();
    if (rows.length === 0) return out;
    const kept = this.#rowPlacesOf(rows.map(({ handle }) => handle));
    for (const row of rows) {
      row.by.placesBefore ??= rowPlacesBefore(row.by.changes);
      out.set(row.id, row.by.placesBefore.get(row.handle)?.key ?? kept.get(row.handle) ?? '');
    }
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
    // By key, and by ID among the same keys (as a storage orders them)
    const sorted = [...there].sort((a, b) => {
      const order = compareKeys(
        (places.get(items[a]) as Place).key,
        (places.get(items[b]) as Place).key,
      );
      return order !== 0 ? order : items[a] < items[b] ? -1 : items[a] > items[b] ? 1 : 0;
    });
    const ranks = new Map(sorted.map((i, rank) => [i, rank]));
    const run = longestRisingRun(there.map((i) => ranks.get(i) as number));
    const kept = new Set(run.map((k) => there[k]));
    const moved = new Set<string>();
    let below: string | null = null;
    for (let i = 0; i < items.length; ) {
      if (kept.has(i)) {
        below = (places.get(items[i]) as Place).key;
        i++;
        continue;
      }
      // A run of items with no key kept, up to the next kept one. Items of the same key (ordered
      // by their IDs) leave no key between them: those above take keys of their own too
      let end = i;
      while (end < items.length && !kept.has(end)) end++;
      while (
        below !== null &&
        end < items.length &&
        compareKeys((places.get(items[end]) as Place).key, below) <= 0
      ) {
        end++;
        while (end < items.length && !kept.has(end)) end++;
      }
      const above = end < items.length ? (places.get(items[end]) as Place).key : null;
      const keys = keysBetween(below, above, end - i);
      for (let k = i; k < end; k++) {
        this.#setPlace(items[k], { parent, key: keys[k - i] });
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
    placeOf: (id: string) => Place | null | undefined,
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
  inv: Operations | null,
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
    inverse: () => (inv ? listOf(inv) : []),
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
    placeKeys: [],
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
    ...out.placeKeys,
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

/** The `create` of a feature from the feature of the public shape it was */
function createShownFeature(id: string, shown: Feature, key: string): ValueOperation {
  const record: FeatureRecord = {
    geometry: orientedGeometry(shown.geometry) as Geometry,
    properties: jsonProperties(shown.properties),
    key,
  };
  return { type: 'create', kind: 'feature', id, record };
}

/** The rows a notification deleted, their handles by their IDs */
function rowsDeletedOf(changes: StoreChange, store: Store): Map<string, number> {
  const out = new Map<string, number>();
  const tables = store.tables;
  if (!tables) return out;
  for (const rows of changes.rows?.layers.values() ?? []) {
    for (const handle of rows.deleted) {
      const id = tables.getRowId(handle);
      if (id !== undefined) out.set(id, handle);
    }
  }
  return out;
}

/**
 * Where rows were before a notification put them elsewhere, by their handles: where the Store says
 * they were (`placesBefore`, those given another key where they stand included), else what the
 * moves of the notification say they were first, else the values of their place before
 */
function rowPlacesBefore(changes: StoreChange): Map<number, Place> {
  const out = new Map<number, Place>();
  const take = (before: RowValues | undefined): void => {
    const parents = before?.fields.get('parent');
    const keys = before?.fields.get('key');
    if (!before || !parents || !keys) return;
    before.rows.forEach((handle, i) => {
      if (out.has(handle)) return;
      if (typeof parents[i] === 'string' && typeof keys[i] === 'string') {
        out.set(handle, { parent: parents[i] as string, key: keys[i] as string });
      }
    });
  };
  take(changes.placesBefore);
  for (const move of changes.order ?? []) take(move.before);
  take(changes.previousValues as RowValues | undefined);
  return out;
}

function createLayer(layer: Layer, key: string): ValueOperation {
  const record: LayerRecord = {
    name: layer.name,
    visible: layer.visible,
    locked: layer.locked,
    opacity: layer.opacity,
    // A layer has no look of its own yet: its features take the defaults and its rule
    style: {},
    styleRule: ruleRecordOf(layer.styleRule),
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

/**
 * The style rule of a layer as a record holds it: told apart by `type`, the colors of the
 * categories under `colors` (the core of this version names them `kind` and `map`)
 */
function ruleRecordOf(rule: StyleRule | undefined): LayerRecord['styleRule'] {
  if (!rule) return null;
  switch (rule.kind) {
    case 'single':
      return { type: 'single', color: rule.color };
    case 'categorical':
      return {
        type: 'categorical',
        property: rule.property,
        colors: { ...rule.map },
        other: rule.other,
      };
    case 'graduated':
      return {
        type: 'graduated',
        property: rule.property,
        breaks: [...rule.breaks],
        colors: [...rule.colors],
        other: rule.other,
      };
    case 'continuous':
      return {
        type: 'continuous',
        property: rule.property,
        min: rule.min,
        max: rule.max,
        ramp: [rule.ramp[0], rule.ramp[1]],
        other: rule.other,
      };
  }
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
    styleRule?: LayerRecord['styleRule'];
  } = {};
  if (was.name !== now.name) set.name = now.name;
  if (was.visible !== now.visible) set.visible = now.visible;
  if (was.locked !== now.locked) set.locked = now.locked;
  if (was.opacity !== now.opacity) set.opacity = now.opacity;
  const rule = ruleRecordOf(now.styleRule);
  if (!sameJson(ruleRecordOf(was.styleRule), rule)) set.styleRule = rule;
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
