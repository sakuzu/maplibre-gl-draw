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
import type { BBox } from '../geometry/types.js';
import type { RowGroupData } from '../table/row-group-types.js';
import type { Utf8Column } from '../table/utf8-column.js';
import type { Feature, FeatureType } from './model.js';

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
}

/**
 * The options of {@link createFeatureTables}.
 */
export interface FeatureTablesOptions {
  /** The number of strings read from the columns that are kept (50,000 when omitted) */
  readonly stringCacheSize?: number;
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
