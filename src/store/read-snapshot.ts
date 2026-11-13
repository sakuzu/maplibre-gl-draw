// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The document as it was when a write over several tasks began, read while it is written (the read
 * snapshot)
 *
 * A commit too long for one task is written a step at a time, a later task each, and told once
 * after its last step (`Store.writeInSteps`); a restore of many rows is written the same way
 * (`row-steps.ts`). What the instance reads of the document in between reads the document before
 * the write, as it reads it before the write is awaited (the reads of `draw` always see the document
 * committed), without finishing it: the snapshot.
 *
 * The rows are not copied. The snapshot keeps what the writes changed of them, from the values the
 * writes read before they wrote (the values of the undo of the transaction, `TableContractStore`),
 * and reads every other row where it is:
 *
 * - The values of a row the write changed are its values now with the values it had before (a row
 *   deleted is kept by the transaction, and read where it was); a row created is not there
 * - Where a row was (its layer and its group) is kept before a write puts it elsewhere
 * - The order of the rows of a layer is kept before the first write that changes it (a row put
 *   elsewhere, deleted, a group put elsewhere or deleted): the rows of the layer in their order then.
 *   The order of a layer no write changed is read as it is, the rows created left out
 * - The layers, the groups, their order and the metadata are kept when the write begins (they are
 *   few, and replaced, never changed in place, by the Store)
 *
 * The drawing and what this client does (its modes, its state) read the rows as they are written;
 * a write of this client, or a read of its state, finishes the write first, as before.
 */

import { ROW_FLAG_DELETED } from '@sakuzu/kasane/render';
import type { FeatureTables, RowField, RowRef, RowValues, TableGroupPatch } from '../api/tables.js';
import { featureWithFields } from '../feature-table/feature-fields.js';
import type { FeatureTablesInternals } from '../feature-table/feature-tables.js';
import { rowFeature } from '../feature-table/row-read.js';
import type { Feature, Group, Layer, Metadata } from './types.js';

/**
 * The document as it was when a write over several tasks began, read while it is written
 *
 * @internal
 */
export interface DocumentSnapshot {
  /** The feature then (undefined for one that was not there) */
  getFeature(id: string): Feature | undefined;
  getLayer(id: string): Layer | undefined;
  listLayers(): Layer[];
  getLayerOrder(): readonly string[];
  getGroup(id: string): Group | undefined;
  listGroups(): Group[];
  getMetadata(): Metadata;
  /**
   * Visits the rows of a layer in their order then, from the back: each with its feature then when
   * the write changed it, or null when the row reads as it is now
   *
   * @param visit Returns false to stop
   * @returns false when the visit stopped
   */
  forEachRow(layerId: string, visit: (handle: RowRef, changed: Feature | null) => boolean): boolean;
  /** The group of a row then (undefined for none) */
  groupOfRow(handle: RowRef): string | undefined;
  /**
   * Runs reads of the tables that read the rows as they are now without finishing the write (the
   * rows the write did not change, read through the reading side of the tables)
   */
  read<T>(fn: () => T): T;
}

/** The Stores whose reads read the snapshot of a write under way, and where they find it */
const READERS = new WeakMap<object, () => DocumentSnapshot | undefined>();

/**
 * Makes the reads of the document through an object read the snapshot of the write over several
 * tasks under way, when there is one (the reads of the instance: `publishedStore`)
 *
 * @internal
 */
export function readThroughSnapshot(
  store: object,
  snapshot: () => DocumentSnapshot | undefined,
): void {
  READERS.set(store, snapshot);
}

/**
 * The snapshot the reads of the document through an object read now (undefined when they read the
 * document as it is)
 *
 * @internal
 */
export function snapshotOf(store: object): DocumentSnapshot | undefined {
  return READERS.get(store)?.();
}

/**
 * What a snapshot reads of the Store that keeps it
 *
 * @internal
 */
export interface SnapshotSource {
  readonly tables: FeatureTables;
  readonly internals: FeatureTablesInternals;
  /** The values the writes of the transaction read before they wrote, in their order */
  before(): readonly RowValues[];
  /** The rows the transaction wrote that were not there when it began (false for those) */
  written(): ReadonlyMap<RowRef, boolean>;
  /** Runs reads of the tables that do not finish the write */
  through<T>(fn: () => T): T;
  /** The feature of a row as it is now (undefined for a deleted row) */
  liveFeature(handle: RowRef): Feature | undefined;
}

/** The fields of the place of a row: read when the row is put elsewhere, not from the undo */
const PLACE_FIELDS: ReadonlySet<RowField> = new Set(['parent', 'key']);

/**
 * The document as it was when a write over several tasks began: kept by the Store while the write
 * is under way
 *
 * @internal
 */
export class HeldSnapshot implements DocumentSnapshot {
  readonly #source: SnapshotSource;
  readonly #layers: ReadonlyMap<string, Layer>;
  readonly #order: readonly string[];
  readonly #groups: ReadonlyMap<string, Group>;
  readonly #metadata: Metadata;
  /** The values of the transaction read before it wrote that the snapshot took in so far */
  #taken: number;
  /** The first value read of each field of each row */
  readonly #fields = new Map<RowField, Map<RowRef, unknown>>();
  /** Where each row put elsewhere was: its parent then (a layer or a group) */
  readonly #parents = new Map<RowRef, string>();
  /** The rows the write changed (their values, their place or their deletion) */
  readonly #touched = new Set<RowRef>();
  /** The rows of each layer whose order the write changed, in their order then */
  readonly #orders = new Map<string, Int32Array>();
  /** The rows there then and deleted now, by their IDs (made when a feature is not found) */
  #deletedIds: Map<string, RowRef> | null = null;
  /** False once a write the snapshot does not follow came (the write is finished by a read then) */
  #valid = true;

  constructor(
    source: SnapshotSource,
    containers: {
      readonly layers: ReadonlyMap<string, Layer>;
      readonly order: readonly string[];
      readonly groups: ReadonlyMap<string, Group>;
      readonly metadata: Metadata;
    },
  ) {
    this.#source = source;
    this.#layers = new Map(containers.layers);
    this.#order = containers.order;
    this.#groups = new Map(containers.groups);
    this.#metadata = containers.metadata;
    this.#taken = source.before().length;
  }

  /** Whether the snapshot follows every write made since it began */
  get valid(): boolean {
    return this.#valid;
  }

  /** Stops following the writes (a load, a clear): what reads it finishes the write instead */
  invalidate(): void {
    this.#valid = false;
  }

  // ==========================================================================
  // Following the writes (before each is made)
  // ==========================================================================

  /** Keeps what a write of rows changes, before it is made */
  beforeRows(patch: RowValues): void {
    if (!this.#valid) return;
    const places = patch.fields.has('parent') || patch.fields.has('key');
    const deletes = patch.deleted !== undefined;
    if (!places && !deletes) return;
    const { internals } = this.#source;
    const written = this.#source.written();
    const layers = new Set<string>();
    const handles = patch.handles;
    const parentless: number[] = [];
    for (let i = 0; i < handles.length; i++) {
      const handle = handles[i];
      // A row created by the transaction was not there: nothing of it is kept
      if (written.get(handle) === false) continue;
      const place = internals.placeOf(handle);
      if (place) layers.add(place.table.tableId);
      if (patch.fields.has('parent') && !this.#parents.has(handle)) parentless.push(handle);
    }
    // The layers the rows go to
    for (const parent of new Set(patch.fields.get('parent') ?? [])) {
      if (typeof parent !== 'string') continue;
      layers.add(this.#layerOfParent(parent));
    }
    for (const layerId of layers) this.#keepOrder(layerId);
    if (parentless.length > 0) {
      const read = this.#source.through(() =>
        this.#source.tables.readValues({
          handles: Int32Array.from(parentless),
          fields: new Map<RowField, unknown[]>([['parent', []]]),
        }),
      );
      const parents = read.fields.get('parent') ?? [];
      parentless.forEach((handle, k) => {
        const parent = parents[k];
        if (typeof parent !== 'string') return;
        this.#parents.set(handle, parent);
        this.#touched.add(handle);
      });
    }
  }

  /** Keeps what a write of groups changes, before it is made */
  beforeGroups(patch: TableGroupPatch): void {
    if (!this.#valid) return;
    const places = patch.fields.has('parent') || patch.fields.has('key');
    if (!places && patch.deleted === undefined) return;
    const groups = this.#source.internals.groups;
    const layers = new Set<string>();
    for (const handle of patch.handles) {
      const layerId = groups.tableOf(handle);
      if (layerId !== undefined) layers.add(layerId);
    }
    for (const parent of new Set(patch.fields.get('parent') ?? [])) {
      if (typeof parent === 'string') layers.add(this.#layerOfParent(parent));
    }
    for (const layerId of layers) this.#keepOrder(layerId);
  }

  /** The layer of a parent of a row or a group: the layer itself, or the layer of the group */
  #layerOfParent(parent: string): string {
    if (this.#layers.has(parent)) return parent;
    const groups = this.#source.internals.groups;
    const handle = groups.handleOfId(parent);
    return (handle >= 0 ? groups.tableOf(handle) : undefined) ?? parent;
  }

  /** Keeps the order of the rows of a layer as it is now, the first time it is about to change */
  #keepOrder(layerId: string): void {
    if (this.#orders.has(layerId)) return;
    this.#orders.set(layerId, this.#scanLayer(layerId));
  }

  /** The rows of a layer as they are now, in their order */
  #scanLayer(layerId: string): Int32Array {
    return this.#source.through(() => {
      const batches: Int32Array[] = [];
      let length = 0;
      const cursor = this.#source.tables.scan({ layerIds: [layerId] });
      for (let batch = cursor.next(); batch; batch = cursor.next()) {
        batches.push(batch.slice());
        length += batch.length;
      }
      const out = new Int32Array(length);
      let at = 0;
      for (const batch of batches) {
        out.set(batch, at);
        at += batch.length;
      }
      return out;
    });
  }

  /** Takes in the values the writes read before they wrote since the last time */
  #take(): void {
    const parts = this.#source.before();
    if (this.#taken > parts.length) this.#taken = 0;
    for (; this.#taken < parts.length; this.#taken++) {
      const part = parts[this.#taken];
      const handles = part.handles;
      for (const [field, values] of part.fields) {
        if (PLACE_FIELDS.has(field)) continue;
        let column = this.#fields.get(field);
        if (!column) {
          column = new Map();
          this.#fields.set(field, column);
        }
        for (let i = 0; i < handles.length; i++) {
          if (column.has(handles[i])) continue;
          column.set(handles[i], values[i]);
          this.#touched.add(handles[i]);
        }
      }
      if (part.deleted) {
        for (let i = 0; i < handles.length; i++) this.#touched.add(handles[i]);
        this.#deletedIds = null;
      }
    }
  }

  // ==========================================================================
  // Reads
  // ==========================================================================

  read<T>(fn: () => T): T {
    return this.#source.through(fn);
  }

  getFeature(id: string): Feature | undefined {
    return this.read(() => {
      this.#take();
      const handle = this.#source.tables.getRowRef(id) ?? this.#deletedIdIndex().get(id);
      return handle === undefined ? undefined : this.#featureOf(handle);
    });
  }

  getLayer(id: string): Layer | undefined {
    return this.#layers.get(id);
  }
  listLayers(): Layer[] {
    return [...this.#layers.values()];
  }
  getLayerOrder(): readonly string[] {
    return this.#order;
  }
  getGroup(id: string): Group | undefined {
    return this.#groups.get(id);
  }
  listGroups(): Group[] {
    return [...this.#groups.values()];
  }
  getMetadata(): Metadata {
    return this.#metadata;
  }

  forEachRow(
    layerId: string,
    visit: (handle: RowRef, changed: Feature | null) => boolean,
  ): boolean {
    return this.read(() => {
      this.#take();
      const written = this.#source.written();
      const one = (handle: RowRef): boolean => {
        // A row the write created was not there
        if (written.get(handle) === false) return true;
        if (!this.#touched.has(handle)) return visit(handle, null);
        const feature = this.#featureOf(handle);
        return feature === undefined || visit(handle, feature);
      };
      const kept = this.#orders.get(layerId);
      if (kept) {
        for (const handle of kept) if (!one(handle)) return false;
        return true;
      }
      const cursor = this.#source.tables.scan({ layerIds: [layerId] });
      for (let batch = cursor.next(); batch; batch = cursor.next()) {
        for (const handle of batch) if (!one(handle)) return false;
      }
      return true;
    });
  }

  groupOfRow(handle: RowRef): string | undefined {
    const parent = this.#parents.get(handle);
    if (parent !== undefined) return this.#groups.has(parent) ? parent : undefined;
    return this.read(() => {
      const place = this.#source.internals.placeOf(handle);
      if (!place) return undefined;
      const group = place.group.data.groups[place.row];
      return group >= 0 ? this.#source.internals.groups.idOf(group) : undefined;
    });
  }

  /** The feature of a row then (undefined for a row that was not there) */
  #featureOf(handle: RowRef): Feature | undefined {
    if (this.#source.written().get(handle) === false) return undefined;
    if (!this.#touched.has(handle)) return this.#source.liveFeature(handle);
    const { internals } = this.#source;
    const place = internals.placeOf(handle);
    if (!place) return undefined;
    let now: Feature;
    try {
      now = rowFeature(internals.readContext, place.table.tableId, place.group, place.row);
    } catch {
      return undefined;
    }
    const fields = new Map<RowField, unknown>();
    for (const [field, column] of this.#fields) {
      if (column.has(handle)) fields.set(field, column.get(handle));
    }
    const feature = featureWithFields(now, fields);
    const parent = this.#parents.get(handle);
    if (parent === undefined) return feature;
    if (this.#layers.has(parent)) return { ...feature, layerId: parent, groupId: undefined };
    const group = this.#groups.get(parent);
    return group ? { ...feature, layerId: group.layerId, groupId: parent } : feature;
  }

  /** The rows there then and deleted now, by their IDs */
  #deletedIdIndex(): ReadonlyMap<string, RowRef> {
    if (this.#deletedIds) return this.#deletedIds;
    const out = new Map<string, RowRef>();
    const { tables, internals } = this.#source;
    const written = this.#source.written();
    for (const handle of this.#touched) {
      if (written.get(handle) === false) continue;
      const place = internals.placeOf(handle);
      if (!place || (place.group.data.flags[place.row] & ROW_FLAG_DELETED) === 0) continue;
      const id = tables.getRowId(handle);
      if (id !== undefined) out.set(id, handle);
    }
    this.#deletedIds = out;
    return out;
  }
}
