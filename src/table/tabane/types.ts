// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The types of the Tabane format (see `README.md` of this folder)
 *
 * A pure module (types only), so it runs in a Worker as well.
 */

import type { Geometry } from 'geojson';
import type { CoordinateDimensions } from '../coordinates.js';
import type { TableMixedGeometry } from '../types.js';
import type { Utf8Column } from '../utf8-column.js';
import type { PropertyColumns } from '../value-column.js';

/**
 * A revision: what changed a row or a cell, as three numbers the user of the format gives
 * meaning to. `sequence` orders the revisions of a document, `origin` names where the change was
 * made (13 digits of base 32, as the origin of an id), and `step` counts the changes of that
 * origin.
 *
 * @experimental
 */
export type TabaneRevision = readonly [sequence: number, origin: string, step: number];

/**
 * The fill of a polygon row given to the writer: the triangles of its polygons in pairs, as the
 * rows hold them (`RowBlock`): 4 indices per pair into the vertices of the fill
 *
 * @experimental
 */
export interface TabaneFill {
  /** The number of vertices of the fill (the rings drawn, without their closing coordinate) */
  readonly vertices: number;
  /** The indices of the pairs, 4 per pair */
  readonly indices: readonly number[];
}

/**
 * A row given to the writer of a group
 *
 * @experimental
 */
export interface TabaneRow {
  /** The id of the row as text (the origin, `-`, the number in base 32) */
  readonly id: string;
  /** The type of the feature (`'Polygon'`, `'Circle'`, the type of an extension) */
  readonly type: string;
  /** The GeoJSON geometry of one of the six types, or null */
  readonly geometry: Geometry | null;
  /** The style of the row (`{}` when omitted) */
  readonly style?: Readonly<Record<string, unknown>>;
  /** The attributes of the row */
  readonly properties?: Readonly<Record<string, unknown>>;
  /** Whether the row is deleted (kept for what refers to it) */
  readonly deleted?: boolean;
  /** What made the row (every row of a group has one, or none has) */
  readonly made?: TabaneRevision;
  /** The revision of each cell changed after the row was made, by the name of the cell */
  readonly revisions?: Readonly<Record<string, TabaneRevision>>;
  /**
   * The fill of a polygon row, when the writer is not to make it (it makes it from the geometry
   * when omitted)
   */
  readonly fill?: TabaneFill;
}

/**
 * Where the rows of a group are: under a parent, after the key `head`, row `i` of the group
 * having the key of row `firstIndex + i` of the run (`tabaneRowSuffix`)
 *
 * @experimental
 */
export interface TabanePlace {
  /** The id of the parent of the rows (the empty string for none) */
  readonly parent: string;
  /** The key the rows follow */
  readonly head: string;
  /** The number of the first row of the group in its run */
  readonly firstIndex: number;
}

/**
 * The fills of the polygon rows of a group, as they were written
 *
 * @internal
 */
export interface TabaneFills {
  /** For each row, the number of vertices of its fill (-1 for a row that is not a polygon) */
  readonly vertices: Int32Array;
  /** Where the indices of each row start in `indices` (rows + 1 values) */
  readonly offsets: Int32Array;
  /** The indices of every polygon row, 4 per pair */
  readonly indices: Uint32Array;
}

/**
 * The cells changed after their row was made, in the order of the rows, then of the names
 *
 * @internal
 */
export interface TabaneRevisions {
  /** The names of the cells, in the order of their UTF-8 */
  readonly names: readonly string[];
  /** The row of each entry */
  readonly rows: Int32Array;
  /** The name of each entry, as an index into `names` */
  readonly cells: Int32Array;
  /** The revision of each entry */
  readonly sequences: Float64Array;
  readonly origins: readonly string[];
  /** The origin of each entry, as an index into `origins` */
  readonly originIndex: Int32Array;
  readonly steps: Float64Array;
}

/**
 * A group of rows read: its rows as columns, which {@link TabaneRow}s and blocks of rows of the
 * tables are made of
 *
 * @experimental
 */
export interface TabaneGroup {
  /** The number of rows */
  readonly length: number;
  /** The ids of the rows as runs: `[origin, first number, count]` */
  readonly ids: readonly (readonly [origin: string, first: number, count: number])[];
  readonly place: TabanePlace;
  /** What made each row, as runs `[revision, count]` (null: what added the group) */
  readonly made: readonly (readonly [revision: TabaneRevision, count: number])[] | null;
  /** The dimensions of the coordinates */
  readonly dimensions: CoordinateDimensions;
  /** The names of the types of the rows */
  readonly typeNames: readonly string[];
}

/**
 * A group of rows read, with every column
 *
 * @internal
 */
export interface TabaneGroupData extends TabaneGroup {
  /** A bit per row of the deleted rows (null when none is) */
  readonly deleted: Uint8Array | null;
  /** The type of each row, as an index into `typeNames` */
  readonly types: Uint8Array;
  readonly geometry: TableMixedGeometry;
  /** The fills of the polygon rows (null when they were not written) */
  readonly fills: TabaneFills | null;
  /** The styles, as their canonical bytes */
  readonly styleDictionary: Utf8Column;
  /** The style of each row, as an index into `styleDictionary` */
  readonly styles: Uint32Array;
  readonly properties: PropertyColumns;
  readonly revisions: TabaneRevisions;
}
