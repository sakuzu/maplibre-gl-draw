// @sakuzu/maplibre-gl-draw/table 2.2.0 (main) の公開 API の宣言を 1 つにまとめた物。
// 元は tsc --emitDeclarationOnly の出力 (stripInternal)。再 export は元の宣言を写した。
// @internal のメンバーと private のメンバーは落としてある。
// 「export されない宣言」の領域は、export された宣言が参照するので、このファイルだけで
// 読めるように写した物で、入口からは export されていない。

import type { Feature, Geometry } from 'geojson';

// 入口の説明 (入口の index の先頭の TSDoc)
/**
 * Read a large table in a Worker and put it on the map.
 *
 * Use it when the data has hundreds of thousands of rows or more and comes from a file: read
 * and prepare it in a Worker, and the main thread only receives it and passes it to
 * `draw.datasets.add`. For a few thousand rows, passing an array of features as `rows` is
 * simpler. It depends on neither maplibre nor WebGL nor the DOM, so a Worker can import it
 * without pulling in the engine.
 *
 * ```ts
 * // worker.ts
 * import {
 *   tableFromFeatures, prepareTable, transferList,
 * } from '@sakuzu/maplibre-gl-draw/table';
 *
 * const features = await readGeoJSON(url);          // read it any way you like
 * const prepared = prepareTable(tableFromFeatures(features));
 * self.postMessage(prepared, { transfer: transferList(prepared) });
 *
 * // main.ts
 * worker.onmessage = (e) =>
 *   draw.datasets.add({ id: 'places', table: e.data });
 * ```
 *
 * Read next: the guide
 * [showing large data](https://sakuzu.github.io/maplibre-gl-draw/guides/large-data). The
 * functions used most are {@link tableFromFeatures}, {@link createTableBuilder},
 * {@link prepareTable} and {@link transferList}.
 *
 * @module table
 */

// =============================================================================
// 領域: Build a table
// =============================================================================

/**
 * Builds a table one row at a time, for readers that stream their rows.
 *
 * Create one with {@link createTableBuilder}, call `add` once per row and `finish` once at the
 * end.
 */
export interface TableBuilder {
    /**
     * Adds one row.
     *
     * A null geometry, or a `GeometryCollection` (which a table cannot hold), gives a row without
     * a geometry: it keeps its place and its attributes but is neither drawn nor hit.
     *
     * @param geometry The GeoJSON geometry of the row; only the first two values of each position
     *   are kept
     * @param properties The attributes of the row
     * @param id The id of the row. Once any row has an id, the rows without one get their row
     *   number
     * @throws when the builder was created with a `geometryType` and the geometry has another
     *   type, or when `finish` was already called
     */
    add(geometry: Geometry | null, properties?: Record<string, unknown> | null, id?: string | number): void;
    /**
     * Turns the rows added so far into a table; the builder cannot be used afterwards.
     *
     * @throws when it was already called
     */
    finish(): Table;
}

/**
 * Creates a builder that makes a table from rows added one at a time.
 *
 * The coordinates are collected into growing typed arrays in the layout of GeoArrow. When every
 * row has the same geometry type the table has one geometry column of that type; otherwise it
 * has a mixed geometry column. An attribute whose values are all numbers (or null) becomes a
 * `Float64Array` with NaN for null; any other attribute becomes a plain array.
 *
 * @param options `geometryType` fixes the geometry type of every row (a geometry of another
 *   type throws), and gives the type of a table without any geometry. `capacity` is the
 *   expected number of rows, to size the arrays from the start. `columns` limits the attributes
 *   that become columns to these names (every one is created, even if no row has it)
 * @returns A new builder
 */
export declare function createTableBuilder(options?: {
    geometryType?: GeometryType;
    capacity?: number;
    columns?: readonly string[];
}): TableBuilder;

/**
 * Makes a table from an array of GeoJSON features.
 *
 * It is {@link createTableBuilder} with one `add` per feature: the geometry, the properties and
 * the id of each feature become a row. Rows of different geometry types give a mixed geometry
 * column.
 *
 * @param features The features, in row order
 * @param options `columns` limits the properties that become columns to these names
 * @returns The table
 *
 * @example
 * ```ts
 * import { tableFromFeatures } from '@sakuzu/maplibre-gl-draw/table';
 *
 * const table = tableFromFeatures(collection.features, { columns: ['name', 'visitors'] });
 * draw.datasets.add({ id: 'places', table });
 * ```
 */
export declare function tableFromFeatures(features: readonly Feature<Geometry | null>[], options?: {
    columns?: readonly string[];
}): Table;

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

// =============================================================================
// 領域: Prepare in a Worker
// =============================================================================

/**
 * Computes the bboxes, the spatial chunks and the spatial index of a table, and returns them
 * with the table.
 *
 * It is the work that the dataset would otherwise do on the main thread when it is given the
 * table. Call it where the table is read (in a Worker), send the result to the main thread and
 * pass it as `table` to `draw.datasets.add` or to `Dataset.setTable`. It uses neither maplibre nor
 * WebGL, so it runs in any Worker.
 *
 * @param table The table
 * @returns The table with its prepared arrays, which belong to this table only
 * @throws when the shape of the table does not add up (the same checks as `Dataset.setTable`)
 *
 * @example In a Worker
 * ```ts
 * import { prepareTable, transferList } from '@sakuzu/maplibre-gl-draw/table';
 *
 * self.onmessage = async (event) => {
 *   const table = await readTable(event.data); // your reader, which returns a Table
 *   const prepared = prepareTable(table);
 *   self.postMessage(prepared, { transfer: transferList(prepared) });
 * };
 * ```
 */
export declare function prepareTable(table: Table): PreparedTable;

/**
 * Lists the buffers of a table, or of a prepared table, for the transfer list of `postMessage`.
 *
 * The buffers move to the other thread without a copy. The geometry arrays of every child of a
 * mixed geometry column are listed too, and for a prepared table the prepared arrays as well.
 * Each buffer appears once, even when several arrays share it. A `SharedArrayBuffer` is left
 * out (it is shared, not moved). After the transfer the arrays are empty on the sending side.
 *
 * @param table The table, or the result of {@link prepareTable}
 * @returns The buffers to pass as the transfer list
 *
 * @example
 * ```ts
 * const prepared = prepareTable(tableFromFeatures(features));
 * self.postMessage(prepared, { transfer: transferList(prepared) });
 * ```
 */
export declare function transferList(table: Table | PreparedTable): ArrayBuffer[];

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
}

// =============================================================================
// 領域: Column types
// =============================================================================

/**
 * An attribute column of a table: a typed array of numbers, a dictionary, or a plain array.
 *
 * Row `i` of the table is element `i` of the column. In a `Float64Array` or a `Float32Array`,
 * NaN means no value (`null`).
 */
export type Column = Float64Array | Float32Array | Int32Array | Uint32Array | Int16Array | Uint16Array | Int8Array | Uint8Array | DictionaryColumn | readonly unknown[];

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
 * The geometry type of a geometry column of a single type.
 *
 * A table whose rows have different types gives a {@link TableMixedGeometry}, made of columns of
 * these types.
 */
export type GeometryType = 'Point' | 'LineString' | 'Polygon' | 'MultiPoint' | 'MultiLineString' | 'MultiPolygon';

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

// =============================================================================
// 領域: export されない宣言 (export された宣言が参照する)
// =============================================================================

/**
 * A bounding box as `[minLng, minLat, maxLng, maxLat]` in degrees.
 *
 * A box never crosses the ±180 degree meridian: `minLng <= maxLng` always holds.
 */
type BBox = [number, number, number, number];
