// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The features of a document held as rows of columns
 *
 * A Store can hold the features of its layers as rows rather than as objects: the rows of a
 * layer are held in row blocks of typed arrays ({@link RowBlock}), built in a Worker
 * (`createRowBlockBuilder`) and added without a copy. The instance draws and hit tests such a
 * layer from its rows, and a reader of many rows reads the columns; a row becomes a
 * {@link Feature} only when one is asked for.
 *
 * {@link createFeatureTables} returns the two halves: `tables`, the reading side, which the
 * Store hands out as its `tables` ({@link StoreView.tables}), and `writer`, which only the
 * implementation of the Store keeps and calls, after it has recorded what it writes.
 */

import type { CoordinateDimensions, CoordinateSystem, Utf8Column } from '@sakuzu/tabane';
import type { Position } from 'geojson';
import { createFeatureTablesStore } from '../feature-table/feature-tables.js';
import type { FeatureTablesWorker } from '../feature-table/versions.js';
import type { BBox } from '../geometry/types.js';
import type {
  ItemHandles,
  ItemPlacement,
  LayerRowsChange,
  RestoreToken,
  RowField,
  RowsChange,
  RowValues,
} from '../shared/types/model.js';
import { copyTableStore as copyTableStoreOf } from '../store/table-copy.js';
import { createTableStore as createTableStoreOf } from '../store/table-memory.js';
import type { RowBlock } from '../table/row-group-types.js';
import { DrawError } from './errors.js';
import type { DocumentChange } from './events.js';
import type { GeometryTransforms, Store, StoreView, UpdateSource } from './extension/store.js';
import type { Feature, FeatureStyle, FeatureType, FeatureValues } from './model.js';

export type {
  FeatureTablesWorker,
  ItemHandles,
  LayerRowsChange,
  RestoreToken,
  RowField,
  RowsChange,
  RowValues,
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
  /** The number of rows, deleted rows left out */
  readonly rowCount: number;
  /**
   * The number of rows read, deleted rows included until they are dropped (a deleted row kept by
   * a deletion, `DocumentChange.restoreToken`, among them): what a Store compares with the rows
   * it gave the layer
   */
  readonly rowCountWithDeleted: number;
  /**
   * The handles of the rows drawn whose box as drawn meets a box `[west, south, east, north]`, in
   * the order of the layer (a hidden row is not drawn). The box as drawn is the box of the
   * positions of a row, or for a type whose extent is worked out from its feature (an Image, a
   * Circle, a type of an extension that gives its `bbox`), the box it covers
   */
  listDrawnRows(bbox: BBox): Int32Array;
  /**
   * The bbox of the positions of a row, `[west, south, east, north]` in degrees, as they are now
   * (null for a row without a geometry or not in this layer). It is the box of the geometry, not
   * the box as drawn of a type whose extent is worked out from its feature, which
   * {@link LayerTableView.listDrawnRows} meets
   */
  getRowBBox(handle: RowHandle): BBox | null;
  /** The type of a row (null for a row not in this layer) */
  getRowType(handle: RowHandle): FeatureType | null;
  /** The position of a row whose geometry is a Point, `[x, y]` (null for any other row) */
  getRowPoint(handle: RowHandle): Position | null;
  /** The value of an attribute of a row (undefined when it does not hold the key) */
  getRowValue(handle: RowHandle, key: string): unknown;
  /**
   * The style of a row (undefined for a row not in this layer): the object the table of styles
   * shares between the rows of the same style, frozen, read without a copy
   */
  getRowStyle(handle: RowHandle): Readonly<FeatureStyle> | undefined;
  /**
   * A row as a feature, which is not to be changed: the same object is given again while the row
   * is not written, a few rows at a time, so read the values above for what is read often
   * (undefined for a deleted row or one not in this layer)
   */
  getRow(handle: RowHandle): Feature | undefined;
  /** Changes whenever the rows drawn may have changed (added, hidden, shown) */
  getDrawnRowsRevision(): number;
  /**
   * The handles of `count` rows from the `start`-th one, in the order of the layer: the rows read,
   * deleted rows included until they are dropped (`rowCountWithDeleted` of them)
   */
  listRowHandles(start: number, count: number): Int32Array;
  /**
   * The number of items of the layer: its rows outside a group of features, and its groups of
   * features (a group is one item, at the place of its members), deleted rows left out
   */
  readonly itemCount: number;
  /** `count` items from the `start`-th one, in the order of the layer */
  listItems(start: number, count: number): ItemHandles;
  /** The number of the rows of a group of features in this layer (deleted rows left out) */
  countGroupMembers(groupHandle: number): number;
  /**
   * The handles of `count` rows of a group of features from the `start`-th one, in the order of
   * the layer (they follow each other at the place of the group)
   */
  listGroupMembers(groupHandle: number, start: number, count: number): Int32Array;
}

/** An item of {@link ItemHandles} that is a row (its handle is a {@link RowHandle}) */
export const ITEM_ROW = 0;
/** An item of {@link ItemHandles} that is a group of features (its handle is the handle of the group) */
export const ITEM_GROUP = 1;

/**
 * What {@link FeatureTables.scan} reads.
 */
export interface TableScanOptions {
  /** The layers read, in this order (every layer that holds rows when omitted) */
  readonly layerIds?: readonly string[];
  /**
   * Only the rows whose box as drawn meets this box, `[west, south, east, north]` (the box a row
   * covers, as {@link LayerTableView.listDrawnRows} reads it)
   */
  readonly bbox?: BBox;
  /**
   * `layer` (the default): the rows of each layer in its order; `any`: in no order, which costs
   * less when a box is given
   */
  readonly order?: 'layer' | 'any';
  /** The number of handles read at a time (1,024 when omitted) */
  readonly batchSize?: number;
}

/**
 * Reads the handles of rows a batch at a time.
 */
export interface RowCursor {
  /** The handles of the next rows (null once every row is read) */
  next(): Int32Array | null;
}

/**
 * The values of a field, one per row of {@link RowValues}: as the feature of the row holds them
 * (a GeoJSON geometry, a style, a boolean; for an attribute its value, `undefined` taking the key
 * off the row).
 */
export type RowFieldValues = readonly unknown[];

/**
 * New rows of a write of this client ({@link RowWrite}): their ids, and the values of their
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
 * Rows put in a place, one after the other ({@link RowWrite}): the implementation of the
 * Store makes the keys of their order, and writes their layer and group.
 */
export interface RowPlacement {
  /** The rows there are, in the order they go there (the new rows of the write follow them) */
  readonly rows: Int32Array;
  /** The place */
  readonly to: ItemPlacement;
}

/**
 * A write of rows of this client, given to the implementation of the Store (`Store.applyRows`):
 * the values of rows there are, new rows, the place rows go to, and the values the rows had
 * before. The implementation makes the keys of the order and the handles of the new rows, and
 * writes the rows with the writer of its tables; the values before go with the notification
 * (`DocumentChange.previousValues`).
 */
export interface RowWrite {
  /** The values of rows there are (by their handles) */
  readonly patch: RowValues;
  /** New rows */
  readonly created?: CreatedRows;
  /** Where rows go */
  readonly place?: RowPlacement;
  /** The values the rows had before */
  readonly before: RowValues;
}

/**
 * A field of a group of features a {@link TableGroupPatch} writes.
 */
export type TableGroupField = 'id' | 'name' | 'order' | 'layerId' | 'visible' | 'locked';

/**
 * Values written to groups of features of a document, by the implementation of the Store: the
 * groups by their handles (the handles rows name in their row blocks, `GroupEntry.handle`).
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
   * What keeps the rows (or the groups, `applyGroups`) the write deletes
   * (`FeatureTablesWriter.createRestoreToken`): they stay as they were until it is let go of, so
   * that writing them not deleted puts them back where they were. Given, it is added to the
   * notification (`DocumentChange.restoreToken`). Rows deleted without one go with the next
   * versions of their row blocks
   */
  readonly restoreToken?: RestoreToken;
  /**
   * The values the rows had before the write, added to the notification
   * (`DocumentChange.previousValues`)
   */
  readonly before?: RowValues;
}

/** The fields of a row other than its attributes (`property:<key>`) */
const ROW_FIELDS: ReadonlySet<string> = new Set([
  'type',
  'layerId',
  'groupId',
  'order',
  'member',
  'geometry',
  'visible',
  'locked',
  'style',
]);

/**
 * The values checked: rows by their handles, values of fields of a row, one per row
 *
 * @throws `DrawError` with the code `invalid-input` when they have another shape
 * @internal
 */
export function checkRowValues(values: unknown): RowValues {
  if (typeof values !== 'object' || values === null || Array.isArray(values)) {
    throw new DrawError('invalid-input', 'The values must be an object');
  }
  const { handles, fields, deleted } = values as Partial<RowValues>;
  if (!(handles instanceof Int32Array)) {
    throw new DrawError('invalid-input', 'The handles must be an Int32Array');
  }
  if (!(fields instanceof Map)) throw new DrawError('invalid-input', 'The fields must be a Map');
  const n = handles.length;
  for (const [field, list] of fields) {
    if (typeof field !== 'string' || !(ROW_FIELDS.has(field) || field.startsWith('property:'))) {
      throw new DrawError('invalid-input', `${JSON.stringify(field)} is not a field of a row`);
    }
    if (!Array.isArray(list) || list.length !== n) {
      throw new DrawError(
        'invalid-input',
        `The values of ${field} must be an array of one value per row`,
      );
    }
  }
  if (deleted !== undefined && (!(deleted instanceof Uint8Array) || deleted.length !== n)) {
    throw new DrawError('invalid-input', 'The deletions must be a Uint8Array of one value per row');
  }
  return values as RowValues;
}

/**
 * Makes values of rows, which `draw.features.restore` writes back (a {@link FeatureValues} of the
 * main entry)
 *
 * @param values - The rows by their handles, the values of each field, one per row, and the
 *   deletion of each row (non-zero for a row deleted)
 * @returns The values
 * @throws `DrawError` with the code `invalid-input` when they have another shape: a field that is
 *   not one of a row, or not one value per row
 */
export function createRowValues(values: {
  readonly handles: Int32Array;
  readonly fields: ReadonlyMap<RowField, RowFieldValues>;
  readonly deleted?: Uint8Array;
}): RowValues {
  const checked = checkRowValues(values);
  return {
    handles: checked.handles,
    fields: checked.fields,
    ...(checked.deleted && { deleted: checked.deleted }),
  };
}

/**
 * Reads values of features as values of rows: what a Store that holds its features as rows
 * notifies (`DocumentChange.previousValues`) and `draw.features.restore` returns
 *
 * @returns The same values, as rows by their handles and values of fields
 * @throws `DrawError` with the code `invalid-input` when they are not values of rows
 */
export function rowValuesOf(values: FeatureValues): RowValues {
  return checkRowValues(values);
}

/**
 * The reading side of the features held as rows: what a Store hands out as its `tables`.
 */
export interface FeatureTables {
  /** The rows of a layer (undefined for a layer that holds no rows) */
  get(layerId: string): LayerTableView | undefined;
  /** The handle of the row of an id (undefined for an unknown or deleted row) */
  findRow(id: string): RowHandle | undefined;
  /** The id of the row of a handle (undefined for an unknown handle) */
  getRowId(handle: RowHandle): string | undefined;
  /**
   * The id of the group of features of a handle, as {@link ItemHandles} and
   * {@link LayerTableView.listGroupMembers} name it (undefined for an unknown handle)
   */
  getGroupId(groupHandle: number): string | undefined;
  /** The handle of a group of features by its id (undefined for an unknown group) */
  findGroup(id: string): number | undefined;
  /**
   * Reads the handles of the rows of layers, a batch at a time (the deleted rows left out); read
   * their values with {@link LayerTableView}.
   */
  scan(options?: TableScanOptions): RowCursor;
  /**
   * The values the fields given have now, for the rows given (as a feature holds them; `deleted`
   * read when the values given have it, a row that is not there counting as deleted): written
   * back, they put the rows back as they are
   */
  readValues(rows: RowValues): RowValues;
  /**
   * Lets go of the rows and the groups a deletion kept (`DocumentChange.restoreToken`): they go
   * with the next versions of their row blocks, and the Store may forget their ids
   */
  release(token: RestoreToken): void;
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
  /** A new token to keep the rows and groups a write deletes (`RowApplyOptions.restoreToken`) */
  createRestoreToken(): RestoreToken;
  /**
   * Forgets the ids of deleted rows that nothing keeps any more: they leave the table of the ids
   * (an id seen again is a new row), and their handles are given again once their rows are gone.
   * A row that is not deleted, or is kept, is left as it is
   */
  forget(handles: Int32Array): void;
  /**
   * The handle of the row of each id, given to the ids not seen yet.
   *
   * @param hashes - The hashes of the ids (`RowBlock.idHashes`; computed when omitted)
   */
  allocateHandles(ids: Utf8Column, hashes?: Uint32Array): Int32Array;
  /**
   * Adds row blocks to a layer at once, without copying their columns, after the implementation of
   * the Store recorded them.
   *
   * Every row block is checked before any is added. Then each is put at its place in the order of
   * the layer: its rows that have no handle yet (-1) get one (from the hashes of `idHashes`,
   * computed where the row block was built), and its styles built in a Worker are numbered in the
   * table of styles. The row blocks are kept as they are: do not change their arrays afterwards.
   * The rows are told as created, as a write of `apply` tells them (`DocumentChange.rows`, in the
   * transaction of the Store), and the drawing draws them from its next draw.
   *
   * A row block whose rows are not in the order of their keys, or whose keys overlap those of
   * another row block of the layer (one added, or built of rows written, since it was made), is not
   * left out: its rows go to the rows of the layer changed since their row blocks were built (the
   * delta), read and drawn at their places at once, and into the row blocks with their next
   * versions.
   *
   * Taking in a row block costs little next to building it, but a caller that adds many keeps the
   * draws going by adding them a few at a time (a copy of a document adds them a block at a time).
   *
   * @returns The rows added, by layer
   * @throws `DrawError` with the code `invalid-input` when an array of a row block does not have one
   *   entry per row, when a row block is empty, or when its coordinates do not have the dimensions of
   *   the layer (`FeatureTablesOptions.dimensionsOf`), `not-found` when a row names a group of
   *   features that is not known, or `already-exists` when an id is already a row of the document
   *   (nothing is added then)
   */
  addRowBlocks(layerId: string, rowBlocks: readonly RowBlock[]): RowsChange;
  /**
   * Raises the dimensions of the coordinates of a layer, so that it holds a `z` or an `m` it did
   * not (`xy` to `xyz`, `xyz` to `xyzm`; a layer of no rows yet included): no value is dropped.
   *
   * The rows written from then on are held with the new dimensions (a position of fewer values
   * gets NaN for the others), and every row block of the layer is due for its next version, which
   * copies its coordinates into them over the draws; the row blocks of before are read and drawn as
   * they are until then. The row blocks given to `addRowBlocks` from then on have the new dimensions.
   *
   * @throws `DrawError` with the code `invalid-input` when the dimensions do not hold the ones of
   *   the layer (they are never lowered)
   */
  raiseDimensions(layerId: string, dimensions: CoordinateDimensions): void;
  /**
   * Writes values of rows, after the implementation of the Store recorded them.
   *
   * The geometry, the style, shown and locked, the attributes and the deletion of a row are
   * written in place: what fits the columns of its row block is written into them, the rest kept
   * with the row block and read before its columns (every reader of the rows reads the values
   * written). The drawing writes the rows into the chunks that draw them before its next draw.
   *
   * A row whose change moves it in the order of its layer or to another layer (`type`,
   * `layerId`, `groupId`, `order`, `member`, or an attribute the cutting of the rows into chunks
   * reads, the created zoom) goes to the rows of its layer changed since their row blocks were built
   * (the delta), and so does a new row: a handle that names no row, with at least its `type`,
   * `layerId`, `geometry` and `order` (the other fields take the defaults of a feature). The
   * readers read the row there at once, and the drawing draws it at its place in the order; the
   * next version of the row block its key falls in takes it, over the draws. New rows whose keys
   * are one run that no row of the layer is within are built into row blocks of their own instead,
   * and are drawn once built.
   *
   * The positions of a geometry are read as coordinates of the dimensions of the layer of the
   * row (`FeatureTablesOptions.dimensionsOf`): `[x, y, z]` in a layer of `xyz`, `[x, y, m]` in
   * one of `xym`; a position of fewer values gets NaN for the others. A position of more values
   * than the dimensions is refused rather than cut: raise the dimensions of the layer first
   * (`raiseDimensions`).
   *
   * @returns The rows written, by layer
   * @throws `DrawError`: `not-found` when a handle names no row or a group of features is
   *   unknown; `invalid-input` when a field a new row needs is missing, when a row is moved without
   *   a geometry to a layer of dimensions that would read its positions otherwise (only `xy` into
   *   any, and `xyz` into `xyzm`, keep them), or when a value cannot be held (nothing is written
   *   then), and when a position has more values than the dimensions of its layer (the rows before
   *   it in the values are written)
   */
  apply(values: RowValues, options?: RowApplyOptions): RowsChange;
  /**
   * Writes values of groups of features, after the implementation of the Store recorded them.
   *
   * A new group (a handle no group has) needs its `id`, `order` and `layerId`; its `name` is held
   * by the Store, not by the tables (the Store of rows of `createTableStore` creates, changes and
   * deletes its groups as the values say, and notifies them). A new key of the order of a group
   * moves its members, which follow each other at the place of the group: the row blocks are cut at
   * the runs of the members and at the place they go to, and put in their new order over the
   * draws, read and drawn in the order before until then; the rows are not written. A group
   * given another `layerId` is in that layer from then on; its members go there by the writes of
   * their rows (`apply`). A group shown or hidden shows or hides its members. A group deleted is
   * taken out once no row names it and no token keeps it: deleted with a token
   * (`RowApplyOptions.restoreToken`, added to the notification), it keeps its handle, its key and
   * its layer until the token is let go of, so that writing it again with its handle puts it back
   * where it was.
   *
   * @throws `DrawError` with the code `invalid-input` when a new group misses its id, its key or
   *   its layer, or a value is not of its kind (nothing is written then)
   */
  applyGroups(patch: TableGroupPatch, options?: RowApplyOptions): void;
  /**
   * The key of the order of a group of features: where the group stands among the items of its
   * layer (the key of the order of a row, a fractional index, compared byte by byte; its members
   * follow each other at its place). It is the key last written, read at once: a new key puts
   * the members at their new place over the draws, and the rows are read and drawn in the order
   * before until then. The layer of the group is the `layerId` of the group (`Store.getGroup`).
   *
   * @param groupHandle - The handle of the group ({@link FeatureTables.findGroup})
   * @returns The key (undefined for an unknown handle)
   */
  getGroupOrder(groupHandle: number): string | undefined;
  /**
   * Takes every row out of the tables, after the implementation of the Store recorded it: the
   * document is replaced from elsewhere (a version of it put back, the document read again from
   * the start), and its rows come back with `addRowBlocks`.
   *
   * The features drawn for the sketches are let go of, the features selected are no longer
   * marked, the next versions of the row blocks and the work given to
   * the Worker are dropped (what the Worker gives back is not taken in), the row blocks queued and the
   * new rows not built yet go, and so do the rows and the groups of features the deletions kept
   * (their tokens keep nothing any more). The groups of features stay, with the keys of their
   * order, and the layers keep the dimensions of their coordinates. An id keeps its handle until
   * the Store forgets it (`forget`): a row of an id seen before gets the same handle when its
   * row block is added, so that what is kept by the handles (the values of the rows written before,
   * the rows hidden on this client) goes on; the Store forgets the ids that do not come back.
   *
   * It is told as a replacement of the document (`DocumentChange.reset`). The Store of core lets
   * go of the features selected then: they are selected again by their rows once the rows are
   * back.
   */
  clear(): void;
}

/**
 * The options of {@link createFeatureTables}.
 */
export interface FeatureTablesOptions {
  /**
   * Where the large merges and builds of rows run (on the main thread, within the time of the
   * draws of the map, when omitted)
   */
  readonly worker?: FeatureTablesWorker;
  /**
   * Adds what the tables changed to the notification of the transaction of the Store (notified
   * at once outside one): the rows written (`rows`). Without it, `apply` only returns the rows
   * written
   */
  readonly onChange?: (change: DocumentChange) => void;
  /**
   * Tells the Store the deleted rows nothing keeps any more (a token let go of): it forgets them
   * (`FeatureTablesWriter.forget`) once it no longer needs their ids
   */
  readonly onRelease?: (handles: Int32Array) => void;
  /**
   * The dimensions of the coordinates of the rows of a layer, read once, when the layer first
   * holds rows (`xy` for every layer when omitted): `xy`, `xyz`, `xym` or `xyzm`. The rows of a
   * layer of `z` or `m` are drawn and hit by their `x` and `y`, and are read with every value
   * (`readValues`); they are not made features (for the selection, or by `getRow`)
   */
  readonly dimensionsOf?: (layerId: string) => CoordinateDimensions;
  /**
   * The system of the coordinates the bbox of the rows and their spatial index are made in (the
   * plane of the longitudes and latitudes when omitted). A Worker passes its own
   */
  readonly coordinateSystem?: CoordinateSystem;
}

/**
 * Creates the tables of the features of a document, as its reading and writing sides.
 *
 * @example A Store that holds its features as rows
 * ```ts
 * const { tables, writer } = createFeatureTables();
 * writer.addRowBlocks('layer-1', rowBlocks); // the row blocks a Worker built
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
 * A row is read as a {@link Feature} only when one is asked for (`getFeature`, the features of
 * the selection), made of the row each time it changes; its writes are notified as rows written,
 * selected or not, with the values the rows had before (`DocumentChange.previousValues`; none for
 * a change from elsewhere).
 * `listFeatures` and `listFeaturesInOrder` throw: read the rows from the tables.
 *
 * @param options The options of its tables (the Worker that builds the rows), and how it
 *   computes the edits that move, rotate and scale features (`transforms`, see
 *   {@link Store.transforms}; the computation of the library when omitted)
 * @returns The Store, for the `store` option of `createDraw`, and the writer of its tables: what
 *   adds row blocks (`addRowBlocks`) and writes rows from elsewhere, in a transaction of the
 *   Store with their source
 *
 * @example
 * ```ts
 * const { store, writer } = createTableStore();
 * const draw = createDraw(map, { store });
 * draw.layers.create({ id: 'buildings', name: 'Buildings' }); // a layer held as rows
 * writer.addRowBlocks('buildings', rowBlocks); // the row blocks a Worker built
 * store.transact(() => writer.apply(values), 'remote'); // a change from elsewhere
 * ```
 */
export function createTableStore(
  options: Omit<FeatureTablesOptions, 'onChange' | 'onRelease'> & {
    readonly transforms?: GeometryTransforms;
  } = {},
): {
  store: Store;
  writer: FeatureTablesWriter;
} {
  return createTableStoreOf(options);
}

/**
 * A copy of a document held as rows ({@link copyTableStore}), made a row block at a time.
 */
export interface TableStoreCopy {
  /** The new Store, for the `store` option of the `createDraw` that draws the copy */
  readonly store: Store;
  /** The writer of its tables */
  readonly writer: FeatureTablesWriter;
  /**
   * Copies the next row block into the new Store (it takes them in over the draws of its
   * drawing, as `addRowBlocks` does)
   *
   * @returns Whether rows are left to copy
   */
  copyNext(): boolean;
}

/**
 * Copies a document held as rows into a new Store that holds its features as rows, to draw it
 * apart from the instance that edits it (a print, a thumbnail) without making its features.
 *
 * The layers (each held as rows), the groups at their places, the stacking order, the metadata
 * and the embedded files are copied at once, and the features of a layer of objects too. The rows
 * are listed at once, in the order of their layers, and copied a row block at a time with
 * `copyNext`, each row block read as the rows are then (a value written meanwhile is copied as it is
 * when its row block is read), so that the copy of a large document is spread over draws or tasks.
 * The layers keep the dimensions of their coordinates. The new Store computes the edits that
 * move, rotate and scale features as the Store copied does (its `transforms`).
 *
 * @param source - The Store of the document (`draw.getStore()`)
 * @param options - The options of the tables of the new Store (the Worker that builds its next
 *   versions)
 * @throws `DrawError` with the code `invalid-input` when the Store does not hold its features as
 *   rows
 *
 * @example
 * ```ts
 * const copy = copyTableStore(draw.getStore());
 * const printed = createDraw(printMap, { store: copy.store, initDefaultLayer: false });
 * while (copy.copyNext()) await new Promise(requestAnimationFrame);
 * ```
 */
export function copyTableStore(
  source: StoreView,
  options: Omit<FeatureTablesOptions, 'onChange' | 'onRelease' | 'dimensionsOf'> = {},
): TableStoreCopy {
  return copyTableStoreOf(source, options);
}
