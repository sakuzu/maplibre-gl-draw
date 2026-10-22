// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The types of a table
 *
 * The rows are held as columns of typed arrays in the layout of GeoArrow (the native encoding
 * with separated offsets), so a reader of GeoParquet, Arrow or FlatGeobuf can hand what it reads
 * over without building an object per row, and a Worker can send it to the main thread without a
 * copy.
 */

import type { TableGeometry, TableMixedGeometry } from '@sakuzu/tabane';
import type { BBox } from '../geometry/types.js';

/**
 * An attribute column encoded as a dictionary (the dictionary type of Arrow).
 *
 * The value of row `i` is `dictionary[codes[i]]`. A negative code, or one past the end of the
 * dictionary, means no value (`null`).
 *
 * @example
 * ```ts
 * const category: DictionaryColumn = {
 *   codes: new Int32Array([0, 1, 0, -1]),
 *   dictionary: ['cafe', 'school'],
 * }; // 'cafe', 'school', 'cafe', null
 * ```
 */
export interface DictionaryColumn {
  /** The code of each row */
  codes: Int8Array | Uint8Array | Int16Array | Uint16Array | Int32Array | Uint32Array;
  /** The distinct values */
  dictionary: readonly (string | number | boolean | null)[];
}

/**
 * An attribute column of a table: a typed array of numbers, a dictionary, or a plain array.
 *
 * Row `i` of the table is element `i` of the column. In a `Float64Array` or a `Float32Array`,
 * NaN means no value (`null`).
 */
export type Column =
  | Float64Array
  | Float32Array
  | Int32Array
  | Uint32Array
  | Int16Array
  | Uint16Array
  | Int8Array
  | Uint8Array
  | DictionaryColumn
  | readonly unknown[];

/**
 * A table of rows held as columns, the fast way to put many rows on the map.
 *
 * Build one with {@link tableFromFeatures} or {@link createTableBuilder}, or take the output of
 * a GeoArrow reader as it is: the layout is the same. Pass it as `table` to
 * {@link maplibre-gl-draw!DatasetsCollection.add | draw.datasets.add} or to
 * {@link maplibre-gl-draw!Dataset.setTable | Dataset.setTable}.
 *
 * Nothing is copied: the dataset keeps and reads the arrays, so do not change them while the
 * dataset holds them (replace the table with `setTable` instead). Every array can be sent from a
 * Worker without a copy; {@link transferList} lists their buffers.
 *
 * Row `i` behaves as the feature `{ id, type: geometry.type, coordinates, properties }` where
 * `coordinates` are read from the geometry column, `properties` holds the value of every column at
 * row `i`, and `id` is `String(ids[i])` (or `String(i)` without `ids`). With a
 * {@link TableMixedGeometry}, `type` and `coordinates` are those of the row's child
 * column. The rows have no individual style; the style rule and the base style of the dataset
 * color them.
 *
 * @example
 * ```ts
 * const places: Table = {
 *   length: 3,
 *   geometry: {
 *     type: 'Point',
 *     coords: new Float64Array([139.70, 35.68, 139.71, 35.69, 139.72, 35.66]),
 *   },
 *   columns: {
 *     name: ['Shinjuku', 'Yoyogi', 'Shibuya'],
 *     visitors: new Float64Array([3.5, 0.7, 3.0]),
 *   },
 * };
 * draw.datasets.add({ id: 'places', table: places });
 * ```
 */
export interface Table {
  /** The number of rows */
  length: number;
  /**
   * The geometry column: of one type, or {@link TableMixedGeometry} for rows of
   * different types
   */
  geometry: TableGeometry | TableMixedGeometry;
  /**
   * Which rows have a geometry, as the validity bitmap of Arrow: bit `i % 8` of byte `i >> 3` (the
   * lowest bit first) is 1 for a row with a geometry. Every row has one when omitted
   */
  validity?: Uint8Array;
  /**
   * The id of each row, turned into a string with `String()` (the row number as a string when
   * omitted). The ids must be unique within the table
   */
  ids?: Column;
  /**
   * The attribute columns by name. They become the `properties` of the rows, which the style
   * rule reads. Passing only the columns that the rule and the host read is enough
   */
  columns?: Record<string, Column>;
}

/**
 * A table together with what {@link prepareTable} computed for it, ready for the main thread.
 *
 * Besides the table it carries the bbox of each row, the spatial chunks and the spatial index
 * of the hit testing, all in typed arrays, so it can be sent from a Worker without a copy
 * ({@link transferList}). It also tells the number of rows and the extent of the table. Treat
 * everything else as opaque: pass the whole object as `table` to {@link maplibre-gl-draw!DatasetsCollection.add | draw.datasets.add} or to
 * {@link maplibre-gl-draw!Dataset.setTable | Dataset.setTable}.
 */
export interface PreparedTable {
  /** The table the rest was computed for */
  readonly table: Table;
  /** The number of rows, the `length` of the table it was computed for */
  readonly length: number;
  /**
   * The extent of the rows with a geometry, as `[west, south, east, north]` in degrees, or
   * `null` when no row has a geometry
   */
  readonly bounds: BBox | null;
  /**
   * The bbox of each row, `[minX, minY, maxX, maxY]` (NaN for a row without a geometry)
   *
   * @internal
   */
  readonly rowBounds: Float64Array;
  /**
   * The rows of every chunk, chunk after chunk
   *
   * @internal
   */
  readonly chunkRows: Int32Array;
  /**
   * Where each chunk starts in `chunkRows` (the chunk count + 1 entries)
   *
   * @internal
   */
  readonly chunkOffsets: Int32Array;
  /**
   * The bbox of each chunk, `[minX, minY, maxX, maxY]`
   *
   * @internal
   */
  readonly chunkBounds: Float64Array;
  /**
   * The number of entries of one node of the spatial index
   *
   * @internal
   */
  readonly indexNodeSize: number;
  /**
   * The number of leaves of the spatial index (the rows with a geometry)
   *
   * @internal
   */
  readonly indexItemCount: number;
  /**
   * The boxes of the spatial index
   *
   * @internal
   */
  readonly indexBoxes: Float64Array;
  /**
   * The rows and child positions of the spatial index
   *
   * @internal
   */
  readonly indexEntries: Int32Array;
  /**
   * The end of each level of the spatial index
   *
   * @internal
   */
  readonly indexLevels: Int32Array;
}
