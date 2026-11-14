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
  /** The layers, the groups, their order and the metadata as they are now */
  containers(): Containers;
}

/**
 * The layers, the groups, the stacking order and the metadata of a document
 *
 * @internal
 */
export interface Containers {
  readonly layers: ReadonlyMap<string, Layer>;
  readonly order: readonly string[];
  readonly groups: ReadonlyMap<string, Group>;
  readonly metadata: Metadata;
}

/**
 * A snapshot a transaction keeps from its beginning to the end of its function (the document its
 * reads and the checks of its writes read): `snapshot` gives it once the document may have changed
 * since (undefined while it has not: the document as it is is the one it began on)
 *
 * @internal
 */
export interface LastingSnapshot {
  snapshot(): DocumentSnapshot | undefined;
  /** Lets go of it (it follows no more writes) */
  release(): void;
}

/** The fields of the place of a row: read when the row is put elsewhere, not from the undo */
const PLACE_FIELDS: ReadonlySet<RowField> = new Set(['parent', 'key']);

/** Whether the row of a handle is deleted now (or is no row) */
function deletedNow(internals: FeatureTablesInternals, handle: RowRef): boolean {
  const place = internals.placeOf(handle);
  return !place || (place.group.data.flags[place.row] & ROW_FLAG_DELETED) !== 0;
}

/**
 * The document as it was at a moment, read while it is written after it
 *
 * Two kinds, by what tells the values the rows had:
 *
 * - The snapshot of a write over several tasks (held): from the values its transaction read before
 *   it wrote (the values of the undo), taken in when it is read. When a lasting snapshot began during
 *   the write, it is frozen at its end (the values taken in and the rows created copied): the
 *   lasting one reads the rows the write changed from it
 * - A lasting snapshot (a transaction from its beginning to the end of its function, over any
 *   number of commits): it reads the values of the rows itself before each write, the first time a
 *   row is written; its layers, groups and metadata are copied before the first transaction after it
 *   began
 *
 * @internal
 */
export class HeldSnapshot implements DocumentSnapshot {
  readonly #source: SnapshotSource;
  /** The snapshot of the write over several tasks under way when this lasting one began */
  readonly #parent: HeldSnapshot | null;
  readonly #lasting: boolean;
  /** The layers, groups, order and metadata then (null: as they are now, none changed since) */
  #kept: Containers | null;
  /** The values of the transaction read before it wrote that the snapshot took in so far */
  #taken: number;
  /** Whether the values are taken in (a held snapshot at the end of its write) */
  #frozen = false;
  /** The lasting snapshots reading this one, which freeze it at the end of its write */
  #readers = 0;
  /** The first value read of each field of each row */
  readonly #fields = new Map<RowField, Map<RowRef, unknown>>();
  /** Where each row put elsewhere was: its parent then (a layer or a group) */
  readonly #parents = new Map<RowRef, string>();
  /** The rows changed since (their values, their place or their deletion) */
  readonly #touched = new Set<RowRef>();
  /** The rows created since (a lasting or a frozen snapshot) */
  readonly #created = new Set<RowRef>();
  /** The rows of each layer whose order changed since, in their order then (deleted ones too) */
  readonly #orders = new Map<string, Int32Array>();
  /** The rows there then and deleted now, by their IDs (made when a feature is not found) */
  #deletedIds: Map<string, RowRef> | null = null;
  /** False once a write the snapshot does not follow came (the write is finished by a read then) */
  #valid = true;

  constructor(
    source: SnapshotSource,
    containers: Containers | null,
    options: { readonly parent?: HeldSnapshot | null; readonly lasting?: boolean } = {},
  ) {
    this.#source = source;
    this.#parent = options.parent ?? null;
    this.#lasting = options.lasting === true;
    this.#kept = containers && {
      layers: new Map(containers.layers),
      order: containers.order,
      groups: new Map(containers.groups),
      metadata: containers.metadata,
    };
    this.#taken = this.#lasting ? 0 : source.before().length;
    if (this.#parent) this.#parent.#readers++;
  }

  /** Whether the snapshot follows every write made since it began */
  get valid(): boolean {
    return this.#valid && (this.#parent === null || this.#parent.#valid);
  }

  /** Whether the document may have changed since the snapshot began */
  get changed(): boolean {
    return (
      this.#parent !== null ||
      this.#kept !== null ||
      this.#touched.size > 0 ||
      this.#created.size > 0 ||
      this.#orders.size > 0
    );
  }

  /** The layers, groups, order and metadata then */
  get containers(): Containers {
    return this.#kept ?? this.#source.containers();
  }

  /** Stops following the writes (a load, a clear): what reads it finishes the write instead */
  invalidate(): void {
    this.#valid = false;
  }

  /** Copies the layers, groups, order and metadata before they may change (a lasting snapshot) */
  keepContainers(): void {
    if (this.#kept) return;
    const now = this.#source.containers();
    this.#kept = {
      layers: new Map(now.layers),
      order: now.order,
      groups: new Map(now.groups),
      metadata: now.metadata,
    };
  }

  /** Lets go of the snapshot this lasting one reads */
  release(): void {
    if (this.#parent) this.#parent.#readers--;
  }

  /**
   * Ends the snapshot of a write over several tasks once its last step is written: frozen when a
   * lasting snapshot reads it (the values its transaction read taken in, the rows it created copied)
   */
  end(): void {
    if (this.#readers === 0 || this.#frozen) return;
    this.takeIn();
    for (const [handle, there] of this.#source.written()) if (!there) this.#created.add(handle);
    this.#frozen = true;
  }

  // ==========================================================================
  // Following the writes (before each is made)
  // ==========================================================================

  /** Keeps what a write of rows changes, before it is made */
  beforeRows(patch: RowValues): void {
    if (!this.#valid || this.#frozen) return;
    if (this.#lasting) this.#keepValues(patch);
    // A row deleted stays where it is in the order of its table (kept by the transaction): only a
    // row put elsewhere changes the order the snapshot reads
    if (!patch.fields.has('parent') && !patch.fields.has('key')) return;
    const { internals } = this.#source;
    const layers = new Set<string>();
    const handles = patch.rows;
    const parentless: number[] = [];
    // The layers the rows are in: none to look for once the order of every layer with rows is kept
    const findLayers = !this.#everyOrderKept();
    for (let i = 0; i < handles.length; i++) {
      const handle = handles[i];
      // A row created since was not there: nothing of it is kept
      if (this.createdSinceOf(handle)) continue;
      if (findLayers) {
        const place = internals.placeOf(handle);
        if (place) layers.add(place.table.tableId);
      }
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
          rows: Int32Array.from(parentless),
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

  /**
   * Reads the values a write of rows changes before it is made, the first time a row is written
   * since the snapshot began (a lasting snapshot): a row not there is one created since
   */
  #keepValues(patch: RowValues): void {
    const { internals } = this.#source;
    const fields = [...patch.fields.keys()].filter((field) => !PLACE_FIELDS.has(field));
    const read: number[] = [];
    for (const handle of patch.rows) {
      if (this.#created.has(handle)) continue;
      if (deletedNow(internals, handle)) {
        if (!this.#touched.has(handle)) this.#created.add(handle);
        continue;
      }
      if (patch.deleted && !this.#touched.has(handle)) {
        this.#touched.add(handle);
        this.#deletedIds = null;
      }
      if (fields.some((field) => !this.#fields.get(field)?.has(handle))) read.push(handle);
    }
    if (read.length === 0 || fields.length === 0) return;
    const values = this.#source.through(() =>
      this.#source.tables.readValues({
        rows: Int32Array.from(read),
        fields: new Map(fields.map((field) => [field, []])),
      }),
    );
    for (const [field, list] of values.fields) {
      let column = this.#fields.get(field);
      if (!column) {
        column = new Map();
        this.#fields.set(field, column);
      }
      read.forEach((handle, k) => {
        if (column.has(handle)) return;
        column.set(handle, list[k]);
        this.#touched.add(handle);
      });
    }
  }

  /** Keeps what a write of groups changes, before it is made */
  beforeGroups(patch: TableGroupPatch): void {
    if (!this.#valid || this.#frozen) return;
    const places = patch.fields.has('parent') || patch.fields.has('key');
    if (!places && patch.deleted === undefined) return;
    const groups = this.#source.internals.groups;
    const layers = new Set<string>();
    const known = this.containers.groups;
    for (const handle of patch.groups) {
      // A group made since was not there: making it puts no row elsewhere (its members are put
      // into it by writes of rows)
      const id = groups.idOf(handle);
      if (id === undefined || !known.has(id)) continue;
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
    if (this.containers.layers.has(parent)) return parent;
    const groups = this.#source.internals.groups;
    const handle = groups.handleOfId(parent);
    return (handle >= 0 ? groups.tableOf(handle) : undefined) ?? parent;
  }

  /** Whether the order of every layer that holds rows is kept */
  #everyOrderKept(): boolean {
    for (const layerId of this.containers.layers.keys()) {
      if (this.#orders.has(layerId)) continue;
      const rows = this.#source.through(() => this.#source.tables.get(layerId)?.rowCount ?? 0);
      if (rows > 0) return false;
    }
    return true;
  }

  /** Keeps the order of the rows of a layer as it is now, the first time it is about to change */
  #keepOrder(layerId: string): void {
    if (this.#orders.has(layerId)) return;
    this.#orders.set(layerId, this.#scanLayer(layerId));
  }

  /** The rows of a layer as they are now, in their order (the deleted ones kept too) */
  #scanLayer(layerId: string): Int32Array {
    return this.#source.through(() => {
      // The order of the rows the table keeps (made again when read after a change)
      const table = this.#source.internals.rowTable(layerId);
      return table ? table.rowOrder().handles.slice() : new Int32Array(0);
    });
  }

  /** Takes in the values the writes read before they wrote since the last time (held) */
  takeIn(): void {
    if (this.#lasting || this.#frozen) return;
    const parts = this.#source.before();
    if (this.#taken > parts.length) this.#taken = 0;
    for (; this.#taken < parts.length; this.#taken++) {
      const part = parts[this.#taken];
      const handles = part.rows;
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

  /** Whether the row was created since the snapshot began (by its write, or by the one it reads) */
  createdSinceOf(handle: RowRef): boolean {
    const parent = this.#parent;
    if (parent?.createdSinceOf(handle)) return true;
    if (this.#lasting || this.#frozen) return this.#created.has(handle);
    return this.#source.written().get(handle) === false;
  }

  /** Whether the row changed since the snapshot began */
  touchesOf(handle: RowRef): boolean {
    return this.#touched.has(handle) || this.#parent?.touchesOf(handle) === true;
  }

  // ==========================================================================
  // Reads
  // ==========================================================================

  read<T>(fn: () => T): T {
    return this.#source.through(fn);
  }

  getFeature(id: string): Feature | undefined {
    return this.read(() => {
      this.#takeAll();
      const handle =
        this.#source.tables.getRowRef(id) ??
        this.deletedIdsOf().get(id) ??
        this.#parent?.deletedIdsOf().get(id);
      return handle === undefined ? undefined : this.featureOf(handle);
    });
  }

  getLayer(id: string): Layer | undefined {
    return this.containers.layers.get(id);
  }
  listLayers(): Layer[] {
    return [...this.containers.layers.values()];
  }
  getLayerOrder(): readonly string[] {
    return this.containers.order;
  }
  getGroup(id: string): Group | undefined {
    return this.containers.groups.get(id);
  }
  listGroups(): Group[] {
    return [...this.containers.groups.values()];
  }
  getMetadata(): Metadata {
    return this.containers.metadata;
  }

  forEachRow(
    layerId: string,
    visit: (handle: RowRef, changed: Feature | null) => boolean,
  ): boolean {
    return this.read(() => {
      this.#takeAll();
      const { internals } = this.#source;
      const one = (handle: RowRef, deleted: boolean): boolean => {
        // A row created since was not there
        if (this.createdSinceOf(handle)) return true;
        if (!this.touchesOf(handle)) {
          // A row deleted before is left out; one deleted since is read where it was
          return deleted || visit(handle, null);
        }
        const feature = this.featureOf(handle);
        return feature === undefined || visit(handle, feature);
      };
      const kept = this.orderOf(layerId);
      if (kept) {
        for (const handle of kept) if (!one(handle, deletedNow(internals, handle))) return false;
        return true;
      }
      // The order of the table as it is, the rows deleted included
      const table = internals.rowTable(layerId);
      if (!table) return true;
      const order = table.rowOrder();
      for (let i = 0; i < order.handles.length; i++) {
        const deleted = (order.groups[i].data.flags[order.rows[i]] & ROW_FLAG_DELETED) !== 0;
        if (!one(order.handles[i], deleted)) return false;
      }
      return true;
    });
  }

  /** The rows of a layer in their order then, when it changed since (the snapshot read first) */
  orderOf(layerId: string): Int32Array | undefined {
    return this.#parent?.orderOf(layerId) ?? this.#orders.get(layerId);
  }

  groupOfRow(handle: RowRef): string | undefined {
    const parent = this.parentOf(handle);
    if (parent !== undefined) return this.containers.groups.has(parent) ? parent : undefined;
    return this.read(() => {
      const place = this.#source.internals.placeOf(handle);
      if (!place) return undefined;
      const group = place.group.data.groups[place.row];
      return group >= 0 ? this.#source.internals.groups.idOf(group) : undefined;
    });
  }

  /** Where a row put elsewhere since was then (the snapshot read first) */
  parentOf(handle: RowRef): string | undefined {
    return this.#parent?.parentOf(handle) ?? this.#parents.get(handle);
  }

  /** Takes in the values of the snapshot read and of this one */
  #takeAll(): void {
    this.#parent?.takeIn();
    this.takeIn();
  }

  /** The feature of a row then (undefined for a row that was not there) */
  featureOf(handle: RowRef): Feature | undefined {
    if (this.createdSinceOf(handle)) return undefined;
    // The write over several tasks this one began in tells the rows it changed
    const reading = this.#parent;
    if (reading?.touchesOf(handle)) return reading.featureOf(handle);
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
    const { layers, groups } = this.containers;
    if (layers.has(parent)) return { ...feature, layerId: parent, groupId: undefined };
    const group = groups.get(parent);
    return group ? { ...feature, layerId: group.layerId, groupId: parent } : feature;
  }

  /** The rows there then and deleted now, by their IDs */
  deletedIdsOf(): ReadonlyMap<string, RowRef> {
    if (this.#deletedIds) return this.#deletedIds;
    const out = new Map<string, RowRef>();
    const { tables, internals } = this.#source;
    for (const handle of this.#touched) {
      if (this.createdSinceOf(handle) || !deletedNow(internals, handle)) continue;
      const id = tables.getRowId(handle);
      if (id !== undefined) out.set(id, handle);
    }
    this.#deletedIds = out;
    return out;
  }
}
