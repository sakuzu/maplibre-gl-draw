// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The types of a row group: a run of the rows of a layer, held as columns
 *
 * The features of a document can be held as rows rather than as objects: the rows of a layer
 * are cut, in the order of the layer, into groups of a few thousand rows, and every group is a
 * set of columns of typed arrays that is never changed in place in its shape. A Worker builds
 * the groups (`createRowGroupBuilder`) and sends them to the main thread without a copy
 * (`rowGroupTransferList`); the main thread only gives the rows their handles and draws them.
 *
 * A pure module (types only), so it runs in a Worker as well.
 */

import type { PackedRTree } from './packed-rtree.js';
import type { TableMixedGeometry } from './types.js';
import type { Utf8Column } from './utf8-column.js';
import type { PropertyColumns } from './value-column.js';

/** The bit of {@link RowGroupData.flags} of a row that is shown */
export const ROW_FLAG_VISIBLE = 1;
/** The bit of {@link RowGroupData.flags} of a row that is locked */
export const ROW_FLAG_LOCKED = 2;
/** The bit of {@link RowGroupData.flags} of a row that is deleted (kept for what refers to it) */
export const ROW_FLAG_DELETED = 4;

/**
 * The triangulation of the fills of the rows of a group
 *
 * The triangles of a row are indices into the vertices of its fill: the rings of each of its
 * polygons in turn, without the closing coordinate of a ring, leaving out a ring of fewer than 3
 * coordinates (and a polygon whose outer ring has fewer than 3). A row of fewer than 65,536 such
 * vertices keeps its indices in `indices`; a larger one in `wideIndices`.
 */
export interface TriangleCache {
  /** Where the indices of each row start in `indices` (rows + 1 values) */
  readonly offsets: Int32Array;
  /** The indices of the rows of fewer than 65,536 vertices */
  readonly indices: Uint16Array;
  /** The rows of 65,536 vertices or more, ascending */
  readonly wideRows: Int32Array;
  /** Where the indices of each of `wideRows` start in `wideIndices` (`wideRows` + 1 values) */
  readonly wideOffsets: Int32Array;
  /** The indices of the rows of 65,536 vertices or more */
  readonly wideIndices: Uint32Array;
}

/**
 * A group of rows of one layer, in the order of the layer
 *
 * Every array has one entry per row (`length` of them) unless it says otherwise, and every
 * array can be sent from a Worker without a copy ({@link rowGroupTransferList}).
 */
export interface RowGroupData {
  /** The number of rows */
  readonly length: number;
  /**
   * The handle of each row: a number the document gives a row once and never changes. A Worker
   * cannot give them, so a group built in a Worker holds -1 until the main thread does
   */
  readonly handles: Int32Array;
  /** The id of each row */
  readonly ids: Utf8Column;
  /** The hash of the bytes of each id (computed where the group is built) */
  readonly idHashes: Uint32Array;
  /** The type of each row, as an index into `typeNames` */
  readonly types: Uint8Array;
  /** The names of the types (`'Point'`, `'Circle'`, the type of an extension) */
  readonly typeNames: readonly string[];
  /**
   * The geometry of each row. A Circle and an Image hold a Point, a Freehand a LineString; the
   * coordinates have two dimensions
   */
  readonly geometry: TableMixedGeometry;
  /** The key of the order of each row */
  readonly itemKeys: Utf8Column;
  /** The key of the order of each row within its group (empty outside a group) */
  readonly memberKeys: Utf8Column;
  /** The handle of the group of each row (-1 outside a group) */
  readonly groups: Int32Array;
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
  /** The triangulation of the fills of the rows */
  readonly triangles: TriangleCache;
  /** The spatial index of the rows of the group (it holds the numbers of the rows in the group) */
  readonly index: PackedRTree;
  /** The total number of coordinates of the rows */
  readonly vertexCount: number;
}
