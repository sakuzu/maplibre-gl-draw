// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The columnar input of a dataset
 *
 * The rows are given as columns of typed arrays in the layout of GeoArrow (the native encoding
 * with separated offsets), so a reader of GeoParquet, Arrow or FlatGeobuf can hand what it reads
 * over without building an object per row, and a Worker can send it to the main thread without a
 * copy.
 */

/**
 * The geometry type of a columnar table. A table holds one type.
 */
export type DatasetColumnarGeometryType =
  | 'Point'
  | 'LineString'
  | 'Polygon'
  | 'MultiPoint'
  | 'MultiLineString'
  | 'MultiPolygon';

/**
 * The geometry column of a columnar table, in the layout of GeoArrow: interleaved coordinates
 * and the offset arrays, outermost first.
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
 * or a 0 bit in {@link DatasetColumnarInput.validity}. It is neither drawn nor hit.
 *
 * @example A table of two lines
 * ```ts
 * const geometry: DatasetColumnarGeometry = {
 *   type: 'LineString',
 *   coords: new Float64Array([139.70, 35.68, 139.71, 35.69, 139.72, 35.66, 139.73, 35.67]),
 *   offsets: [new Int32Array([0, 2, 4])],
 * };
 * ```
 */
export interface DatasetColumnarGeometry {
  /** The geometry type of every row */
  type: DatasetColumnarGeometryType;
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
 * The integer arrays that can hold the codes of a {@link DatasetDictionaryColumn}.
 */
export type DatasetDictionaryCodes =
  | Int8Array
  | Uint8Array
  | Int16Array
  | Uint16Array
  | Int32Array
  | Uint32Array;

/**
 * An attribute column encoded as a dictionary (the dictionary type of Arrow): the value of row
 * `i` is `dictionary[codes[i]]`. A negative code, or one past the end of the dictionary, means
 * no value (`null`).
 *
 * @example
 * ```ts
 * const category: DatasetDictionaryColumn = {
 *   codes: new Int32Array([0, 1, 0, -1]),
 *   dictionary: ['cafe', 'school'],
 * }; // 'cafe', 'school', 'cafe', null
 * ```
 */
export interface DatasetDictionaryColumn {
  /** The code of each row */
  codes: DatasetDictionaryCodes;
  /** The distinct values */
  dictionary: readonly (string | number | boolean | null)[];
}

/**
 * An attribute column of a columnar table: a typed array of numbers, a dictionary, or a plain
 * array of values. Row `i` of the table is element `i` of the column. In a `Float64Array` or a
 * `Float32Array`, NaN means no value (`null`).
 */
export type DatasetColumn =
  | Float64Array
  | Float32Array
  | Int32Array
  | Uint32Array
  | Int16Array
  | Uint16Array
  | Int8Array
  | Uint8Array
  | DatasetDictionaryColumn
  | readonly unknown[];

/**
 * The rows of a dataset given as columns, the counterpart of an array of
 * {@link DatasetFeatureInput}. Pass it as `columnar` to
 * {@link MapLibreGLDraw.addDataset} or to {@link Dataset.setColumnar}.
 *
 * Nothing is copied: the dataset keeps and reads the arrays, so do not change them while the
 * dataset holds them (replace the table with `setColumnar` instead). Every array can be sent
 * from a Worker without a copy; `columnarTransferables` from
 * `@sakuzu/maplibre-gl-draw/columnar` lists their buffers.
 *
 * Row `i` behaves as the feature `{ id, type: geometry.type, coordinates, properties }` where
 * `coordinates` are read from the geometry column, `properties` holds the value of every column at
 * row `i`, and `id` is `String(ids[i])` (or `String(i)` without `ids`). The rows have no
 * individual style; the style rule and the base style of the dataset color them.
 *
 * @example
 * ```ts
 * const places: DatasetColumnarInput = {
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
 * draw.addDataset({ id: 'places', columnar: places });
 * ```
 */
export interface DatasetColumnarInput {
  /** The number of rows */
  length: number;
  /** The geometry column */
  geometry: DatasetColumnarGeometry;
  /**
   * Which rows have a geometry, as the validity bitmap of Arrow: bit `i % 8` of byte `i >> 3` (the
   * lowest bit first) is 1 for a row with a geometry. Every row has one when omitted
   */
  validity?: Uint8Array;
  /**
   * The id of each row, turned into a string with `String()` (the row number as a string when
   * omitted). The ids must be unique within the table
   */
  ids?: DatasetColumn;
  /**
   * The attribute columns by name. They become the `properties` of the rows, which the style
   * rule reads. Passing only the columns that the rule and the host read is enough
   */
  columns?: Record<string, DatasetColumn>;
}

/**
 * What `prepareDatasetColumnar` (from `@sakuzu/maplibre-gl-draw/columnar`) computes from a
 * columnar table so that the main thread does not have to: the bbox of each row, the spatial
 * chunks and the spatial index of the hit testing.
 *
 * Every field is a typed array, so it can be sent from a Worker without a copy. Treat it as
 * opaque: pass it with the same table to {@link Dataset.setColumnar} or as `prepared` to
 * {@link MapLibreGLDraw.addDataset}.
 */
export interface DatasetColumnarPrepared {
  /** The number of rows it was computed for (it must equal the `length` of the table) */
  readonly length: number;
  /** The bbox of each row, `[minX, minY, maxX, maxY]` (NaN for a row without a geometry) */
  readonly bounds: Float64Array;
  /** The rows of every chunk, chunk after chunk */
  readonly chunkRows: Int32Array;
  /** Where each chunk starts in `chunkRows` (the chunk count + 1 entries) */
  readonly chunkOffsets: Int32Array;
  /** The bbox of each chunk, `[minX, minY, maxX, maxY]` */
  readonly chunkBounds: Float64Array;
  /** The number of entries of one node of the spatial index */
  readonly indexNodeSize: number;
  /** The number of leaves of the spatial index (the rows with a geometry) */
  readonly indexItemCount: number;
  /** The boxes of the spatial index */
  readonly indexBoxes: Float64Array;
  /** The rows and child positions of the spatial index */
  readonly indexEntries: Int32Array;
  /** The end of each level of the spatial index */
  readonly indexLevels: Int32Array;
}
