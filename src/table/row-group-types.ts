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

/**
 * The bit of {@link RowBlockData.flags} of a row that is deleted (kept for what refers to it). The
 * `flag` columns declared take the bits after it, in the order they are declared
 * (`rowColumnLayoutOf`)
 */
export const ROW_FLAG_DELETED = 1;

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
 * A `whole` column whose values a row block keeps (declared `'rowBlock'`): each different value
 * once, and the value of each row as an index into them
 *
 * @internal
 */
export interface RowBlockValues {
  /** The value of each row, as an index into `values` */
  readonly indexes: Uint8Array;
  /** The values, each different one once (at most 255) */
  readonly values: readonly unknown[];
}

/**
 * A `whole` column whose values the tables keep (declared `'tables'`): the value of each row as
 * an index into `dictionary` while the row block comes from a Worker, as the number of the value
 * in the dictionary of the tables once the tables have taken it in
 *
 * @internal
 */
export interface RowBlockDictionary {
  /** The value of each row: an index into `dictionary`, or the number of the tables */
  readonly indexes: Uint32Array;
  /**
   * The values the rows of a row block from a Worker use, as their canonical bytes (null once the
   * tables have numbered them)
   */
  dictionary: Utf8Column | null;
}

/**
 * A `whole` column of a row block
 *
 * @internal
 */
export type RowBlockWhole = RowBlockValues | RowBlockDictionary;

/**
 * A row block with every column, as the tables read it
 *
 * Every array has one entry per row (`length` of them) unless it says otherwise, and every
 * array can be sent from a Worker without a copy ({@link blockTransferList}).
 *
 * @internal
 */
export interface RowBlockData extends RowBlock {
  /**
   * The `shape` columns, in the order they are declared (`RowColumnLayout.shapes`): null for a
   * column no row of the row block holds a value of. The points have the dimensions of the
   * table (`TableGeometry.dimensions` of every child)
   */
  readonly shapes: readonly (TableMixedGeometry | null)[];
  /**
   * The `whole` columns, in the order they are declared (`RowColumnLayout.wholes`): null for a
   * column no row of the row block holds a value of
   */
  readonly wholes: readonly (RowBlockWhole | null)[];
  /**
   * The `keyed` columns, one column per key, in the order they are declared
   * (`RowColumnLayout.keyed`): null for a column no row of the row block holds a key of
   */
  readonly keyed: readonly (PropertyColumns | null)[];
  /**
   * The key of the order of each row (`key`): among the members of its group for a row in a group,
   * among the items of its table otherwise
   */
  readonly keys: Utf8Column;
  /**
   * The flags of each row, one byte: {@link ROW_FLAG_DELETED}, and a bit per `flag` column
   * declared after it (`RowColumnLayout.flagBit`)
   */
  readonly flags: Uint8Array;
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
