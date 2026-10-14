// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The features of a document held as rows of columns
 *
 * A Store can hold the features of its layers as rows rather than as objects: the rows of a
 * layer are row groups of typed arrays, built in a Worker (`createRowGroupBuilder` of
 * `@sakuzu/maplibre-gl-draw/table`) and taken in without a copy. The instance draws and hit
 * tests such a layer from its rows, and a reader of many rows reads the columns; a row becomes
 * a {@link Feature} only when one is asked for.
 *
 * {@link createFeatureTables} returns the two halves: `tables`, the reading side, which the
 * Store hands out as its `tables` ({@link StoreView.tables}), and `writer`, which only the
 * implementation of the Store keeps and calls, after it has recorded what it writes.
 */

import { createFeatureTablesStore } from '../feature-table/feature-tables.js';
import type { FeatureTablesWorker } from '../feature-table/versions.js';
import type { BBox } from '../geometry/types.js';
import type {
  ItemPlacement,
  ItemRefs,
  LayerRowsChange,
  RetainToken,
  RowField,
  RowsChange,
  RowValuesSnapshot,
} from '../shared/types/model.js';
import { createTableMemoryStore as createTableMemoryStoreOf } from '../store/table-memory.js';
import type { CoordinateDims, CoordinateSystem } from '../table/coordinates.js';
import type { RowGroupData } from '../table/row-group-types.js';
import type { Utf8Column } from '../table/utf8-column.js';
import type { DocumentChange } from './events.js';
import type { Store, UpdateSource } from './extension/store.js';
import type { Feature, FeatureType } from './model.js';

export type {
  FeatureTablesWorker,
  ItemRefs,
  LayerRowsChange,
  RetainToken,
  RowField,
  RowsChange,
  RowValuesSnapshot,
};

/**
 * The handle of a row: a number the document gives a row the first time it sees its id, and
 * never changes while the document is open, whatever group, layer or place the row moves to.
 *
 * A host or an extension that keeps a value per row outside the row keys it by the handle, so
 * the value stays with its row when the rows are built again or reordered.
 */
export type RowHandle = number;

/**
 * The rows of one layer, read without making features.
 */
export interface LayerTableView {
  /** The layer */
  readonly layerId: string;
  /** The number of rows (deleted ones included until they are dropped) */
  readonly rowCount: number;
  /**
   * The handles of the rows drawn whose bbox meets a box `[west, south, east, north]`, in the
   * order of the layer (a hidden row is not drawn)
   */
  listDrawnRows(bbox: BBox): Int32Array;
  /** The bbox of a row (null for a row without a geometry or not in this layer) */
  getRowBounds(handle: RowHandle): BBox | null;
  /** The type of a row (null for a row not in this layer) */
  getRowType(handle: RowHandle): FeatureType | null;
  /** The position of a row whose geometry is a Point (null for any other row) */
  getRowPoint(handle: RowHandle): [number, number] | null;
  /** The value of an attribute of a row (undefined when it does not hold the key) */
  valueAt(handle: RowHandle, key: string): unknown;
  /**
   * A row as a feature: a new object every call, so read the values above for what is read
   * often (undefined for a deleted row or one not in this layer)
   */
  getRow(handle: RowHandle): Feature | undefined;
  /** Changes whenever the rows drawn may have changed (added, hidden, shown) */
  getDrawnRowsRevision(): number;
  /** The handles of `count` rows from the `start`-th one, in the order of the layer */
  rowsInOrder(start: number, count: number): Int32Array;
  /**
   * The number of items of the layer: its rows outside a group of features, and its groups of
   * features (a group is one item, at the place of its members), deleted rows left out
   */
  readonly itemCount: number;
  /** `count` items from the `start`-th one, in the order of the layer */
  itemsInOrder(start: number, count: number): ItemRefs;
  /** The number of the rows of a group of features in this layer (deleted rows left out) */
  groupMemberCount(group: number): number;
  /**
   * The handles of `count` rows of a group of features from the `start`-th one, in the order of
   * the layer (they follow each other at the place of the group)
   */
  groupMembersInOrder(group: number, start: number, count: number): Int32Array;
}

/** An item of {@link ItemRefs} that is a row (its handle is a {@link RowHandle}) */
export const ITEM_ROW = 0;
/** An item of {@link ItemRefs} that is a group of features (its handle is the handle of the group) */
export const ITEM_GROUP = 1;

/**
 * What {@link FeatureTables.scan} reads.
 */
export interface TableScanOptions {
  /** The layers read, in this order (every layer that holds rows when omitted) */
  readonly layerIds?: readonly string[];
  /** Only the rows whose bbox meets this box, `[west, south, east, north]` */
  readonly bbox?: BBox;
  /**
   * `layer` (the default): the rows of each layer in its order; `any`: in no order, which costs
   * less when a box is given
   */
  readonly order?: 'layer' | 'any';
  /** The number of handles read at a time (1,024 when omitted) */
  readonly batch?: number;
}

/**
 * Reads the handles of rows a batch at a time.
 */
export interface RowCursor {
  /** The handles of the next rows (null once every row is read) */
  next(): Int32Array | null;
}

/**
 * The values of a field, one per row of the patch: as the feature of the row holds them (a
 * GeoJSON geometry, a style, a boolean; for an attribute its value, `undefined` taking the key
 * off the row).
 */
export type RowFieldValues = readonly unknown[];

/**
 * Values written to rows of a document, by the implementation of the Store.
 */
export interface RowPatch {
  /** The rows written */
  readonly handles: Int32Array;
  /** The values of each field written, one per row */
  readonly fields: ReadonlyMap<RowField, RowFieldValues>;
  /**
   * Non-zero for a row deleted; zero for a row deleted and kept (`RetainToken`) created again at
   * its place, as it was
   */
  readonly deleted?: Uint8Array;
}

/**
 * New rows of a write of this client ({@link LocalRowWrite}): their ids, and the values of their
 * fields (a `type` and a `geometry` at least; the layer and the key of their order come from the
 * place they are put at).
 */
export interface CreatedRows {
  /** The ids of the new rows */
  readonly ids: Utf8Column;
  /** The values of each field, one per new row */
  readonly fields: ReadonlyMap<RowField, RowFieldValues>;
}

/**
 * Rows put in a place, one after the other ({@link LocalRowWrite}): the implementation of the
 * Store makes the keys of their order, and writes their layer and group.
 */
export interface RowPlacement {
  /** The rows there are, in the order they go there (the new rows of the write follow them) */
  readonly rows: Int32Array;
  /** The place */
  readonly to: ItemPlacement;
}

/**
 * A write of rows of this client, given to the implementation of the Store (`Store.applyLocal`):
 * the values of rows there are, new rows, the place rows go to, and the values the rows had
 * before. The implementation makes the keys of the order and the handles of the new rows, and
 * writes the rows with the writer of its tables; the values before go with the notification
 * (`RowsChange.before`).
 */
export interface LocalRowWrite {
  /** The values of rows there are (by their handles) */
  readonly patch: RowPatch;
  /** New rows */
  readonly created?: CreatedRows;
  /** Where rows go */
  readonly place?: RowPlacement;
  /** The values the rows had before */
  readonly before: RowValuesSnapshot;
}

/**
 * A field of a group of features a {@link TableGroupPatch} writes.
 */
export type TableGroupField = 'id' | 'name' | 'order' | 'layerId' | 'visible' | 'locked';

/**
 * Values written to groups of features of a document, by the implementation of the Store: the
 * groups by their handles (the handles rows name in `RowGroupData.groups`).
 */
export interface TableGroupPatch {
  /** The groups written */
  readonly handles: Int32Array;
  /** The values of each field written, one per group */
  readonly fields: ReadonlyMap<TableGroupField, readonly unknown[]>;
  /** Non-zero for a group deleted */
  readonly deleted?: Uint8Array;
}

/**
 * The options of {@link FeatureTablesWriter.apply}.
 */
export interface RowApplyOptions {
  /** Where the change comes from */
  readonly source?: UpdateSource;
  /**
   * What keeps the rows the write deletes (`FeatureTablesWriter.retainToken`): they stay as they
   * were until it is let go of, so that writing them not deleted puts them back where they were.
   * Given, it is added to the notification (`StoreChange.retain`). Rows deleted without one go
   * with the next versions of their row groups
   */
  readonly retain?: RetainToken;
  /** The values the rows had before the write, added to the notification (`RowsChange.before`) */
  readonly before?: RowValuesSnapshot;
}

/**
 * `draw.tables`: the writes of the rows of a Store that holds its features as rows, made by this
 * client through the gate of the instance (read-only), as its other writes are.
 *
 * What a Store of rows notifies of a write of this client carries the values the rows had
 * (`RowsChange.before`); written back with {@link TablesResource.applyRows}, they put the rows
 * back, as a history undoes a write.
 */
export interface TablesResource {
  /**
   * Writes values of rows through the Store, as a write of this client: the values the rows have
   * for the fields of the patch are read (`FeatureTables.snapshot`), the patch is written
   * (`Store.applyLocal`), and the notification carries the values read (`RowsChange.before`).
   *
   * A row is written whether it is a feature (selected, edited) or not, and whatever the locks of
   * the row, its group and its layer: it is what puts values back. A row deleted and kept
   * (`StoreChange.retain`) written not deleted comes back where it was. The place of a row (its
   * layer, group and keys of the order) is written as given, and the changes of the order it
   * makes are notified (`StoreChange.order`).
   *
   * @param patch - The rows by their handles, and the values of each field written
   * @returns The values the rows had for the fields written (written back, they put the rows
   *   back), or `null` when the document is read-only
   * @throws `DrawError` with the code `invalid-state` when the Store does not hold its features
   *   as rows, `invalid-input` when the patch has the wrong shape, or `not-found` when a handle
   *   names no row; the error of the Store when it cannot write a value (see
   *   `FeatureTablesWriter.apply`)
   *
   * @example Writing back the values before of a write
   * ```ts
   * draw.getStore().subscribe((change) => {
   *   if (change.source === 'local' && change.rows?.before) steps.push(change.rows.before);
   * });
   * // Later: the rows as they were
   * const before = steps.pop();
   * if (before) draw.transact(() => draw.tables.applyRows(before), { source: 'history' });
   * ```
   */
  applyRows(patch: RowPatch): RowValuesSnapshot | null;
}

/**
 * The reading side of the features held as rows: what a Store hands out as its `tables`.
 */
export interface FeatureTables {
  /** The rows of a layer (undefined for a layer that holds no rows) */
  layer(layerId: string): LayerTableView | undefined;
  /** The handle of the row of an id (undefined for an unknown or deleted row) */
  handleOf(id: string): RowHandle | undefined;
  /** The id of the row of a handle (undefined for an unknown handle) */
  idOf(handle: RowHandle): string | undefined;
  /**
   * The id of the group of features of a handle, as {@link ItemRefs} and
   * {@link LayerTableView.groupMembersInOrder} name it (undefined for an unknown handle)
   */
  groupIdOf(group: number): string | undefined;
  /** The handle of a group of features by its id (undefined for an unknown group) */
  groupHandleOf(id: string): number | undefined;
  /**
   * The key of the order of a group of features: where the group stands among the items of its
   * layer (the key of the order of a row, a fractional index, compared byte by byte; its members
   * follow each other at its place). It is the key last written, read at once: a new key puts
   * the members at their new place over the frames, and the rows are read and drawn in the order
   * before until then. The layer of the group is the `layerId` of the group (`Store.getGroup`).
   *
   * @param group - The handle of the group ({@link FeatureTables.groupHandleOf})
   * @returns The key (undefined for an unknown handle)
   */
  groupOrderOf(group: number): string | undefined;
  /**
   * Reads the handles of the rows of layers, a batch at a time (the deleted rows left out); read
   * their values with {@link LayerTableView}.
   */
  scan(options?: TableScanOptions): RowCursor;
  /**
   * Makes rows features for this client: the rows `owner` names are now these (the ones it named
   * before and no other owner names are no longer). A row held is a {@link Feature} the Store
   * gives as it is (`heldFeature`) until it is no longer held; it stays a row of the table, drawn
   * from the table while it is not changed. The change is notified as `held`, not as a change of
   * the document. An id of no row, or of a deleted one, is not held.
   *
   * The instance holds the rows selected and edited (`core:selection`) and, for a moment, the row
   * a click is on (`core:pointer`).
   *
   * @param owner Who holds the rows
   * @param ids The ids of the rows it holds (none: it holds no row any more)
   */
  hold(owner: string, ids: readonly string[]): void;
  /** The feature of a row held (undefined for an id not held) */
  heldFeature(id: string): Feature | undefined;
  /**
   * The values the fields of a patch have now, for its rows (as a feature holds them; `deleted`
   * read when the patch has it, a row that is not there counting as deleted): written back, they
   * put the rows back as they are
   */
  snapshot(patch: RowPatch): RowValuesSnapshot;
  /**
   * Lets go of the rows and the groups a deletion kept (`StoreChange.retain`): they go with the
   * next versions of their row groups, and the Store may forget their ids
   */
  release(token: RetainToken): void;
  /**
   * Draws features in the places of rows, for this client only: the features `owner` draws over
   * rows are now these (the ones it drew before and does not give are no longer drawn). A
   * feature is drawn in the place of the row of its id, which is not drawn while it is (and is
   * still hit where it is); a feature of no row is drawn at the end of its layer. Nothing is
   * written: the rows, what is read of them and the notifications of the document stay as they
   * are. The edits of others in their middle are shown so.
   *
   * @param owner Who draws the features
   * @param features The features it draws (none: it draws none any more)
   */
  overlay(owner: string, features: readonly Feature[]): void;
}

/**
 * The options of {@link FeatureTablesWriter.writeHeld}.
 */
export interface HeldWriteOptions {
  /**
   * Whether the values are a state in the middle of an edit (a drag), always followed by the
   * values it ends with: the rows show them, and the values of others written meanwhile into the
   * fields it writes are kept apart until it ends (written when it is no longer held without an
   * end, the row is shown with its values before the edit)
   */
  readonly intermediate?: boolean;
}

/**
 * The writing side of the features held as rows: kept by the implementation of the Store only.
 */
export interface FeatureTablesWriter {
  /**
   * The handle of the row of an id, deleted rows included (with `deleted`), until the id is
   * forgotten (undefined for an id never seen, or forgotten)
   */
  lookup(id: string): { readonly handle: RowHandle; readonly deleted: boolean } | undefined;
  /** A new token to keep the rows a write deletes (`RowApplyOptions.retain`) */
  retainToken(): RetainToken;
  /**
   * Forgets the ids of deleted rows that nothing keeps any more: they leave the table of the ids
   * (an id seen again is a new row), and their handles are given again once their rows are gone.
   * A row that is not deleted, or is kept, is left as it is
   */
  forget(handles: Int32Array): void;
  /**
   * The handle of the row of each id, given to the ids not seen yet.
   *
   * @param hashes - The hashes of the ids (`RowGroupData.idHashes`; computed when omitted)
   */
  allocateHandles(ids: Utf8Column, hashes?: Uint32Array): Int32Array;
  /**
   * Takes row groups into a layer, without copying their columns.
   *
   * The groups are queued, and taken in a group at a time within the time of the frames of the
   * drawing, so that a large file does not hold a frame; the layer draws the groups taken in so
   * far. When a group is taken in, its rows that have no handle yet (-1) get one (from the hashes
   * of `idHashes`, computed where the group was built), its styles built in a Worker are numbered
   * in the table of styles, and it is put at its place in the order of the layer. The groups are
   * kept as they are: do not change their arrays afterwards.
   *
   * A group that cannot be taken in (an id that is already a row of the document, rows not in
   * the order of their keys, keys that overlap those of another group of the layer) is left out
   * and reported on the console.
   *
   * @throws when an array of a group does not have one entry per row, when a group is empty, when
   *   its coordinates do not have the dimensions of the layer (`FeatureTablesOptions.dimsOf`), or
   *   when a row names a group of features that is not known (nothing is queued then)
   */
  adopt(layerId: string, groups: readonly RowGroupData[]): void;
  /**
   * Takes in, now and on this thread, every row group waiting: the groups given to `adopt`, in the
   * order they were given, and the new rows written that wait to be built into row groups of
   * their own (built here, not in the Worker; the ones a Worker is building are taken in once
   * built). It is for a host that draws nothing, and for tests: the tables take the groups in
   * over the frames of the drawing otherwise, and do so still when this is not called.
   *
   * The groups of a layer whose groups of features are being put in the order of new keys (a
   * drawing holds the reorder until it has drawn it) keep waiting, and are taken in once it is
   * in: placed among the row groups by the keys before, they could overlap the members of a
   * group where its new key puts it. Without a drawing, nothing waits.
   *
   * @throws when a group given to `adopt` cannot be taken in (see `adopt`): the groups after it
   *   keep waiting
   */
  flushAdoption(): void;
  /**
   * Raises the dimensions of the coordinates of a layer, so that it holds a `z` or an `m` it did
   * not (`xy` to `xyz`, `xyz` to `xyzm`; a layer of no rows yet included): no value is dropped.
   *
   * The rows written from then on are held with the new dimensions (a position of fewer values
   * gets NaN for the others), and every row group of the layer is due for its next version, which
   * copies its coordinates into them over the frames; the groups of before are read and drawn as
   * they are until then. The row groups given to `adopt` from then on have the new dimensions.
   *
   * @throws when the dimensions do not hold the ones of the layer (they are never lowered), or
   *   when a row of the layer is held as a feature (`FeatureTables.hold`)
   */
  raiseDims(layerId: string, dims: CoordinateDims): void;
  /**
   * Writes values of rows, after the implementation of the Store recorded them.
   *
   * The geometry, the style, shown and locked, the attributes and the deletion of a row are
   * written in place: what fits the columns of its row group is written into them, the rest kept
   * with the group and read before its columns (every reader of the rows reads the values
   * written). The drawing writes the rows into the chunks that draw them before its next frame.
   *
   * A row whose change moves it in the order of its layer or to another layer (`type`,
   * `layerId`, `groupId`, `order`, `member`, or an attribute the cutting of the rows into chunks
   * reads, the created zoom) goes to the rows of its layer changed since their groups were built
   * (the delta), and so does a new row: a handle that names no row, with at least its `type`,
   * `layerId`, `geometry` and `order` (the other fields take the defaults of a feature). The
   * readers read the row there at once, and the drawing draws it at its place in the order; the
   * next version of the row group its key falls in takes it, over the frames. New rows whose keys
   * are one run that no row of the layer is within are built into row groups of their own
   * instead, and are drawn once built.
   *
   * The positions of a geometry are read as coordinates of the dimensions of the layer of the
   * row (`FeatureTablesOptions.dimsOf`): `[x, y, z]` in a layer of `xyz`, `[x, y, m]` in one of
   * `xym`; a position of fewer values gets NaN for the others. A position of more values than the
   * dimensions is refused rather than cut: raise the dimensions of the layer first (`raiseDims`).
   *
   * @returns The rows written, by layer
   * @throws when a handle names no row and a field a new row needs is missing, when a group of
   *   features is unknown, when a row is moved without a geometry to a layer of dimensions that
   *   would read its positions otherwise (only `xy` into any, and `xyz` into `xyzm`, keep them), or
   *   when a value cannot be held (nothing is written then); when a position has more values than
   *   the dimensions of its layer (the rows before it in the patch are written)
   */
  apply(patch: RowPatch, options?: RowApplyOptions): RowsChange;
  /**
   * Writes values of groups of features, after the implementation of the Store recorded them.
   *
   * A new group (a handle no group has) needs its `id`, `order` and `layerId`; its `name` is held
   * by the Store, not by the tables (the Store of rows of `createTableMemoryStore` creates,
   * changes and deletes its groups as the values say, and notifies them). A new key of the
   * order of a group moves its members, which follow each other at the place of the group: the
   * row groups are cut at the runs of the members and at the place they go to, and put in their
   * new order over the frames, read and drawn in the order before until then; the rows are not
   * written. A group given another `layerId` is in that layer from then on; its members go there
   * by the writes of their rows (`apply`). A group shown or hidden shows or hides its members. A
   * group deleted is taken out once no row names it.
   *
   * @throws when a new group misses its id, its key or its layer, or a value is not of its kind
   *   (nothing is written then)
   */
  applyGroups(patch: TableGroupPatch, options?: RowApplyOptions): void;
  /**
   * Writes the feature of a row held, after the implementation of the Store recorded it: the
   * feature is what `heldFeature` gives from now on, and its values are written to the row as
   * `apply` writes them (the layer and the group of features are written with `apply`, with the
   * key of the order, not here). The change is notified as an update of the feature.
   *
   * @throws when the row is not held, or the feature names another id, layer or group
   */
  writeHeld(id: string, feature: Feature, options?: HeldWriteOptions): void;
}

/**
 * How the tables add to the notifications of the Store that holds them
 */
export interface FeatureTablesHooks {
  /**
   * Adds what the tables changed to the notification of the transaction of the Store (notified
   * at once outside one): the rows written (`rows`), the rows made features and no longer
   * (`held`), and the changes of the features of the rows held (`features`)
   */
  emit(change: DocumentChange): void;
  /**
   * Tells the Store the deleted rows nothing keeps any more (a token let go of, or the oldest
   * ones past `retainLimit`): it forgets them (`FeatureTablesWriter.forget`) once it no longer
   * needs their ids
   */
  released?(handles: Int32Array): void;
}

/**
 * The options of {@link createFeatureTables}.
 */
export interface FeatureTablesOptions {
  /** The number of strings read from the columns that are kept (50,000 when omitted) */
  readonly stringCacheSize?: number;
  /**
   * Where the large merges and builds of rows run (on the main thread, within the time of the
   * frames, when omitted)
   */
  readonly worker?: FeatureTablesWorker;
  /**
   * How the tables add to the notifications of the Store (without them, `apply` only returns
   * the rows written, and the rows held and their features are not notified)
   */
  readonly hooks?: FeatureTablesHooks;
  /**
   * The most the deletions kept and not let go of may hold: tokens (100 when omitted), and bytes
   * of the rows they keep (64 MiB when omitted, counted at the size of a row of five corners).
   * Past it, the oldest are let go of
   */
  readonly retainLimit?: { readonly tokens?: number; readonly bytes?: number };
  /**
   * The number of rows held as features from which a row held moved as a whole in the middle of
   * an edit (a drag of the selection) is drawn moved by its state rather than written in every
   * frame: its feature takes every value written, and its row is written once, with the values
   * the edit ends with (100 when omitted; `Infinity`: every row is written)
   */
  readonly moveHeldByStateFrom?: number;
  /**
   * The dimensions of the coordinates of the rows of a layer, read once, when the layer first
   * holds rows (`xy` for every layer when omitted): `xy`, `xyz`, `xym` or `xyzm`. The rows of a
   * layer of `z` or `m` are drawn and hit by their `x` and `y`, and are read with every value
   * (`snapshot`); they are not made features (`hold`, `getRow`)
   */
  readonly dimsOf?: (layerId: string) => CoordinateDims;
  /**
   * The system of the coordinates the bbox of the rows and their spatial index are made in (the
   * plane of the longitudes and latitudes when omitted). A Worker passes its own
   */
  readonly coordinates?: CoordinateSystem;
}

/**
 * Creates the tables of the features of a document, as its reading and writing sides.
 *
 * @example A Store that holds its features as rows
 * ```ts
 * const { tables, writer } = createFeatureTables();
 * writer.adopt('layer-1', groups); // the row groups a Worker built
 * const store = { ...documentStore, tables }; // the Store hands out the reading side
 * ```
 */
export function createFeatureTables(options: FeatureTablesOptions = {}): {
  tables: FeatureTables;
  writer: FeatureTablesWriter;
} {
  return createFeatureTablesStore(options);
}

/**
 * Creates an empty Store in memory that holds its features as rows of columns: every layer of
 * it is held as rows, read from its tables (`store.tables`).
 *
 * A row is a {@link Feature} while it is selected or edited (it is then notified as a feature),
 * and when one is asked for (`getFeature`); its writes are notified as rows written otherwise,
 * with the values the rows had before (`RowsChange.before`; none for a change from elsewhere).
 * `listFeatures` and `listFeaturesInOrder` throw: read the rows from the tables.
 *
 * @param options The options of its tables (the Worker that builds the rows)
 * @returns The Store, for the `store` option of `createDraw`, and the writer of its tables: what
 *   takes row groups in (`adopt`) and writes rows from elsewhere, in a transaction of the Store
 *   with their source
 *
 * @example
 * ```ts
 * const { store, writer } = createTableMemoryStore();
 * store.createLayer({ id: 'buildings', name: 'Buildings', visible: true, locked: false, opacity: 1, kind: 'table', metadata: undefined, styleRule: undefined });
 * writer.adopt('buildings', groups); // the row groups a Worker built
 * const draw = createDraw(map, { store });
 * store.transact(() => writer.apply(patch), 'remote'); // a change from elsewhere
 * ```
 */
export function createTableMemoryStore(options: Omit<FeatureTablesOptions, 'hooks'> = {}): {
  store: Store;
  writer: FeatureTablesWriter;
} {
  return createTableMemoryStoreOf(options);
}
