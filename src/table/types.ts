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

/**
 * The geometry type of a geometry column of a single type.
 *
 * A table whose rows have different types gives a {@link TableMixedGeometry}, made of columns of
 * these types.
 */
export type GeometryType =
  | 'Point'
  | 'LineString'
  | 'Polygon'
  | 'MultiPoint'
  | 'MultiLineString'
  | 'MultiPolygon';

/**
 * The geometry column of a table whose rows share one geometry type.
 *
 * It follows the layout of GeoArrow: interleaved coordinates and the offset arrays, outermost
 * first.
 *
 * Every row owns a contiguous run of the coordinates, so the offsets only say where each row,
 * part and ring starts:
 *
 * | Type | `offsets` |
 * | --- | --- |
 * | Point | none: row `i` is coordinate `i` |
 * | LineString, MultiPoint | `[row → coordinate]` |
 * | Polygon | `[row → ring, ring → coordinate]` |
 * | MultiLineString | `[row → part, part → coordinate]` |
 * | MultiPolygon | `[row → polygon, polygon → ring, ring → coordinate]` |
 *
 * An offset array has one more entry than the level it splits (the first entry is the start of
 * the first element, the last is the end of the last), and its values never decrease.
 *
 * A row without a geometry has an empty run (two equal offsets), or NaN coordinates for a Point,
 * or a 0 bit in {@link Table.validity}. It is neither drawn nor hit.
 *
 * @example A table of two lines
 * ```ts
 * const geometry: TableGeometry = {
 *   type: 'LineString',
 *   coords: new Float64Array([139.70, 35.68, 139.71, 35.69, 139.72, 35.66, 139.73, 35.67]),
 *   offsets: [new Int32Array([0, 2, 4])],
 * };
 * ```
 */
export interface TableGeometry {
  /** The geometry type of every row */
  type: GeometryType;
  /**
   * The coordinates in degrees, interleaved: `[lng0, lat0, lng1, lat1, ...]`, or
   * `[lng0, lat0, z0, ...]` with `dimensions: 3`
   */
  coords: Float64Array;
  /**
   * The number of values per coordinate: 2 (`xy`, the default) or 3 (`xyz`; the third value is
   * skipped)
   */
  dimensions?: 2 | 3;
  /** The offset arrays, outermost first (see the table above). Omitted or empty for Point */
  offsets?: Int32Array[];
}

/**
 * The geometry column of a table whose rows have different geometry types.
 *
 * It follows the layout of the mixed geometry of GeoArrow (a dense union of Arrow): a geometry
 * column of a single type per child, and for every row of the table the child and the row within
 * it.
 *
 * The geometry of row `i` is row `offsets[i]` of `children[types[i]]`, and row `i` behaves exactly
 * as the feature of that child's type with those coordinates. The rows of a child can be in any
 * order; the draw order is the order of the table rows. A row with a negative `types[i]` has no
 * geometry (as a 0 bit in {@link Table.validity}, which still applies on top). The
 * number of rows of a child is read from its arrays: the coordinates for a Point column,
 * `offsets[0].length - 1` for the others.
 *
 * @example A point, a line and a polygon, the polygon first in the table
 * ```ts
 * const geometry: TableMixedGeometry = {
 *   type: 'Mixed',
 *   types: new Int8Array([2, 0, 1]),
 *   offsets: new Int32Array([0, 0, 0]),
 *   children: [
 *     { type: 'Point', coords: new Float64Array([139.70, 35.68]) },
 *     {
 *       type: 'LineString',
 *       coords: new Float64Array([139.71, 35.69, 139.72, 35.70]),
 *       offsets: [new Int32Array([0, 2])],
 *     },
 *     {
 *       type: 'Polygon',
 *       coords: new Float64Array([139.73, 35.66, 139.75, 35.66, 139.75, 35.68, 139.73, 35.66]),
 *       offsets: [new Int32Array([0, 1]), new Int32Array([0, 4])],
 *     },
 *   ],
 * };
 * ```
 */
export interface TableMixedGeometry {
  /** Marks the mixed form */
  type: 'Mixed';
  /**
   * For every row, the child column that holds its geometry (an index into `children`; negative
   * for a row without a geometry)
   */
  types: Int8Array;
  /** For every row, the row within its child column */
  offsets: Int32Array;
  /** The geometry columns of a single type */
  children: TableGeometry[];
}

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
 * draw.addDataset({ id: 'places', table: places });
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
 * ({@link transferList}). Treat everything but `table` as opaque: pass the whole object as
 * `table` to {@link maplibre-gl-draw!DatasetsCollection.add | draw.datasets.add} or to
 * {@link maplibre-gl-draw!Dataset.setTable | Dataset.setTable}.
 */
export interface PreparedTable {
  /** The table the rest was computed for */
  readonly table: Table;
  /**
   * The number of rows it was computed for (it must equal the `length` of the table)
   *
   * @internal
   */
  readonly length: number;
  /**
   * The bbox of each row, `[minX, minY, maxX, maxY]` (NaN for a row without a geometry)
   *
   * @internal
   */
  readonly bounds: Float64Array;
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
