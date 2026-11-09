// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The types of a row group: a run of the rows of a layer, held as columns
 *
 * The features of a document can be held as rows rather than as objects: the rows of a layer
 * are cut, in the order of the layer, into groups of a few thousand rows, and every group is a
 * set of columns of typed arrays that is never changed in place in its shape. A Worker builds
 * the groups (`createRowBlockBuilder`) and sends them to the main thread without a copy
 * (`blockTransferList`); the main thread only gives the rows their handles and draws them.
 *
 * A pure module (types only), so it runs in a Worker as well.
 */

import type { PropertyColumns, Utf8Column } from '@sakuzu/tabane';
import type { RowCacheColumn } from './row-caches.js';
import type { TableMixedGeometry } from './types.js';

/** The bit of {@link RowBlockData.flags} of a row that is shown */
export const ROW_FLAG_VISIBLE = 1;
/** The bit of {@link RowBlockData.flags} of a row that is locked */
export const ROW_FLAG_LOCKED = 2;
/** The bit of {@link RowBlockData.flags} of a row that is deleted (kept for what refers to it) */
export const ROW_FLAG_DELETED = 4;

/**
 * A row block of one layer, in the order of the layer: columns of typed arrays, built in a
 * Worker (`createRowBlockBuilder`) and sent to the main thread without a copy (`transferList`).
 *
 * Its other columns (the geometry, the keys of the order, the styles, the attributes, the spatial
 * index) are read by the tables only: a row block is given to them as it was built.
 *
 * @experimental
 */
export interface RowBlock {
  /** The number of rows */
  readonly length: number;
  /**
   * The handle of each row: a number the document gives a row once and never changes. A Worker
   * cannot give them, so a row block built in a Worker holds -1 until the main thread does
   * (`FeatureTablesWriter.allocateHandles`)
   */
  readonly handles: Int32Array;
  /** The id of each row */
  readonly ids: Utf8Column;
  /** The hash of the bytes of each id (computed where the row block is built) */
  readonly idHashes: Uint32Array;
  /**
   * The group of features of each row, by the handle the builder was given for it
   * (`GroupEntry.handle`; -1 outside a group)
   */
  readonly groups: Int32Array;
}

/**
 * A row block with every column, as the tables read it
 *
 * Every array has one entry per row (`length` of them) unless it says otherwise, and every
 * array can be sent from a Worker without a copy ({@link blockTransferList}).
 *
 * @internal
 */
export interface RowBlockData extends RowBlock {
  /** The type of each row, as an index into `typeNames` */
  readonly types: Uint8Array;
  /** The names of the types (`'Point'`, `'Circle'`, the type of an extension) */
  readonly typeNames: readonly string[];
  /**
   * The geometry of each row. A Circle and an Image hold a Point, a Freehand a LineString; the
   * coordinates have the dimensions of the layer (`TableGeometry.dimensions` of every child)
   */
  readonly geometry: TableMixedGeometry;
  /** The key of the order of each row */
  readonly itemKeys: Utf8Column;
  /** The key of the order of each row within its group (empty outside a group) */
  readonly memberKeys: Utf8Column;
  /** The flags of each row: {@link ROW_FLAG_VISIBLE}, {@link ROW_FLAG_LOCKED}, {@link ROW_FLAG_DELETED} */
  readonly flags: Uint8Array;
  /**
   * The style of each row: an index into `styleDictionary` while the group comes from a
   * Worker, the number of the table of styles of the document once the main thread has taken it
   */
  readonly styles: Uint32Array;
  /**
   * The styles the rows of a group from a Worker use, as their canonical bytes (null once the
   * main thread has numbered them in its table of styles)
   */
  styleDictionary: Utf8Column | null;
  /** The attributes of the rows, one column per key */
  readonly properties: PropertyColumns;
  /** The bbox of each row, `[minX, minY, maxX, maxY]` (NaN for a row without a geometry) */
  readonly rowBounds: Float64Array;
  /**
   * The caches of the rows (`RowCache`), one column per cache: in the order the tables declare
   * them once the tables have taken the row block in
   */
  caches: readonly RowCacheColumn[];
  /** The total number of coordinates of the rows */
  readonly vertexCount: number;
}
