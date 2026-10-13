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
import type { LayerRowsChange, RowField, RowsChange } from '../shared/types/model.js';
import type { RowGroupData } from '../table/row-group-types.js';
import type { Utf8Column } from '../table/utf8-column.js';
import type { UpdateSource } from './extension/store.js';
import type { Feature, FeatureType } from './model.js';

export type { FeatureTablesWorker, LayerRowsChange, RowField, RowsChange };

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
 * Items of a layer, in their order: rows and groups of features.
 */
export interface ItemRefs {
  /** The kind of each item: {@link ITEM_ROW} or {@link ITEM_GROUP} */
  readonly kinds: Uint8Array;
  /** The handle of each item: of its row, or of its group */
  readonly handles: Int32Array;
}

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
  /** Non-zero for a row deleted */
  readonly deleted?: Uint8Array;
}

/**
 * The options of {@link FeatureTablesWriter.apply}.
 */
export interface RowApplyOptions {
  /** Where the change comes from */
  readonly source?: UpdateSource;
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
   * Reads the handles of the rows of layers, a batch at a time (the deleted rows left out); read
   * their values with {@link LayerTableView}.
   */
  scan(options?: TableScanOptions): RowCursor;
}

/**
 * The writing side of the features held as rows: kept by the implementation of the Store only.
 */
export interface FeatureTablesWriter {
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
   * @throws when an array of a group does not have one entry per row, when a group is empty, or
   *   when a row names a group of features that is not known (nothing is queued then)
   */
  adopt(layerId: string, groups: readonly RowGroupData[]): void;
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
   * @returns The rows written, by layer
   * @throws when a handle names no row and a field a new row needs is missing, when a group of
   *   features is unknown, or when a value cannot be held (nothing is written then)
   */
  apply(patch: RowPatch, options?: RowApplyOptions): RowsChange;
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
