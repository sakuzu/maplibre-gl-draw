// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The reading of a table (`Table`)
 *
 * It checks the shape of the input once and then reads the arrays as they are: the vertex run of
 * a row, the value of a column at a row, the bbox of every row, and one row materialized as a
 * feature on demand. Nothing is built per row until a row is asked for.
 *
 * The geometry is read through geometry columns of a single type: the one column of a table of one
 * type, or the children of a mixed geometry column, where every row names its child and its row
 * within it.
 *
 * A pure module (it depends on nothing outside `/table`), so it runs in a Worker as well.
 */

import { isCoordinateDimensions, strideOf, type Value } from '@sakuzu/tabane';
import type { Geometry } from 'geojson';
import type { Feature, FeatureCoordinates } from '../shared/types/model.js';
import { setOwnProperty } from '../shared/utils/own-property.js';
import { ShapeColumnReader, ShapeFormReader } from './shape-reader.js';
import type {
  Column,
  DictionaryColumn,
  GeometryType,
  Table,
  TableGeometry,
  TableMixedGeometry,
} from './types.js';

/** The number of offset arrays of each geometry type */
const OFFSET_LEVELS: Readonly<Record<GeometryType, number>> = {
  Point: 0,
  LineString: 1,
  MultiPoint: 1,
  Polygon: 2,
  MultiLineString: 2,
  MultiPolygon: 3,
};

/**
 * Whether a column is a dictionary
 *
 * @internal
 */
export function isDictionaryColumn(column: Column): column is DictionaryColumn {
  return (
    typeof column === 'object' &&
    column !== null &&
    !Array.isArray(column) &&
    !ArrayBuffer.isView(column) &&
    'codes' in column
  );
}

/** The number of rows a column holds */
function columnLength(column: Column): number {
  return isDictionaryColumn(column) ? column.codes.length : column.length;
}

/**
 * The value of a column at a row
 *
 * A number of a typed array (null for NaN in a floating point column: the way a missing number
 * is usually held), the value of a dictionary (null for a code outside it) or the element of a
 * plain array.
 *
 * @internal
 */
export function columnValue(column: Column, row: number): unknown {
  if (isDictionaryColumn(column)) {
    const code = column.codes[row];
    return code >= 0 && code < column.dictionary.length ? column.dictionary[code] : null;
  }
  const value = (column as ArrayLike<unknown>)[row];
  if ((column instanceof Float64Array || column instanceof Float32Array) && Number.isNaN(value)) {
    return null;
  }
  return value;
}

/**
 * The reader of a geometry column of a single type after checking its shape: the geometry of a
 * table of one type, or one child of a mixed geometry column. The geometry type is the name of
 * the form read (`ShapeFormReader.type`)
 *
 * @param rows The number of rows (the length of the table), or undefined for a child of a mixed
 *   column, whose number of rows is read from its arrays
 * @param path Where the column is in the input (`geometry` or `geometry.children[k]`), for the
 *   error messages
 * @throws when the shape of the column does not add up
 * @internal
 */
export function readGeometryColumn(
  geometry: TableGeometry,
  rows: number | undefined,
  path: string,
): ShapeFormReader<GeometryType> {
  // The messages about the geometry of a table of one type keep their short form
  const at = rows === undefined ? `${path}: ` : '';
  if (!geometry || !(geometry.type in OFFSET_LEVELS)) {
    throw new Error(`Table: ${at}unknown geometry type "${geometry?.type}"`);
  }
  if (!(geometry.coords instanceof Float64Array)) {
    throw new Error(`Table: ${path}.coords must be a Float64Array`);
  }
  const dims = geometry.dimensions ?? 'xy';
  if (!isCoordinateDimensions(dims)) {
    throw new Error(`Table: ${at}dimensions must be 'xy', 'xyz', 'xym' or 'xyzm' (got ${dims})`);
  }
  const stride = strideOf(dims);
  const offsets = geometry.offsets ?? [];
  const levels = OFFSET_LEVELS[geometry.type];
  if (offsets.length !== levels) {
    throw new Error(
      `Table: ${at}a ${geometry.type} ${rows === undefined ? 'column' : 'table'} has ${levels} offset arrays (got ${offsets.length})`,
    );
  }
  const vertexCount = Math.floor(geometry.coords.length / stride);
  let length = rows;
  if (length === undefined) {
    const first = offsets[0];
    length = levels === 0 ? vertexCount : first instanceof Int32Array ? first.length - 1 : 0;
    length = Math.max(0, length);
  }

  // Each level splits the elements of the level above it
  let elements = length;
  for (let level = 0; level < levels; level++) {
    const array = offsets[level];
    if (!(array instanceof Int32Array)) {
      throw new Error(`Table: ${at}offsets[${level}] must be an Int32Array`);
    }
    if (array.length < elements + 1) {
      throw new Error(
        `Table: ${at}offsets[${level}] has ${array.length} entries for ${elements} elements`,
      );
    }
    elements = array[elements];
  }
  if (elements > vertexCount) {
    throw new Error(
      `Table: ${at}the offsets reach coordinate ${elements} of ${vertexCount} coordinates`,
    );
  }
  return new ShapeFormReader(
    { type: geometry.type, coords: geometry.coords, dimensions: dims, offsets },
    length,
  );
}

/** Whether a geometry column is the mixed form */
function isMixedGeometry(geometry: Table['geometry']): geometry is TableMixedGeometry {
  return geometry?.type === 'Mixed';
}

/**
 * A validated table
 *
 * @internal
 */
export class TableReader {
  readonly length: number;
  /**
   * The geometry columns of a single type: the one column of a table of one type, or the children
   * of a mixed geometry column
   */
  readonly children: readonly ShapeFormReader<GeometryType>[];
  /**
   * The child and the row there of every row (a table of one type: every row is the same row of
   * child 0)
   */
  readonly shapes: ShapeColumnReader<GeometryType>;
  /** Whether every geometry of the table is a Point or a MultiPoint */
  readonly onlyPoints: boolean;
  readonly validity: Uint8Array | undefined;
  readonly ids: Column | undefined;
  readonly columns: Readonly<Record<string, Column>>;
  /** The names of the columns (the key order of `columns`) */
  readonly columnNames: readonly string[];

  /**
   * @throws when the shape of the input does not add up (a wrong type, an offset array of the
   *   wrong length, a column shorter than the table, a row of a mixed column pointing outside its
   *   child)
   */
  constructor(readonly input: Table) {
    const { length, geometry } = input;
    if (!Number.isInteger(length) || length < 0) {
      throw new Error(`Table: length must be a non-negative integer (got ${length})`);
    }
    if (isMixedGeometry(geometry)) {
      this.children = readMixedChildren(geometry, length);
      this.shapes = new ShapeColumnReader(geometry.types, geometry.offsets, this.children);
    } else {
      this.children = [readGeometryColumn(geometry, length, 'geometry')];
      this.shapes = new ShapeColumnReader(null, null, this.children);
    }
    this.onlyPoints = this.children.every(
      (child) => child.type === 'Point' || child.type === 'MultiPoint',
    );

    if (input.validity && input.validity.length < Math.ceil(length / 8)) {
      throw new Error('Table: validity is shorter than the table');
    }
    if (input.ids && columnLength(input.ids) < length) {
      throw new Error('Table: ids is shorter than the table');
    }
    const columns = input.columns ?? {};
    for (const [name, column] of Object.entries(columns)) {
      if (columnLength(column) < length) {
        throw new Error(`Table: column "${name}" is shorter than the table`);
      }
    }

    this.length = length;
    this.validity = input.validity;
    this.ids = input.ids;
    this.columns = columns;
    this.columnNames = Object.keys(columns);
  }

  /** Whether the validity bitmap marks the row as having a geometry */
  isValid(row: number): boolean {
    const validity = this.validity;
    return validity === undefined || (validity[row >> 3] & (1 << (row & 7))) !== 0;
  }

  /** The index of the child that holds the geometry of a row (-1 for a row without one) */
  childOf(row: number): number {
    return this.shapes.formOf(row);
  }

  /** The row within its child of a row */
  childRowOf(row: number): number {
    return this.shapes.rowOf(row);
  }

  /** The geometry column of a row (undefined for a row without a geometry) */
  columnOf(row: number): ShapeFormReader<GeometryType> | undefined {
    return this.shapes.readerOf(row);
  }

  /** The value of a column at a row (undefined when the table has no such column) */
  value(name: string, row: number): unknown {
    const column = this.columns[name];
    return column === undefined ? undefined : columnValue(column, row);
  }

  /** The id of a row */
  idOf(row: number): string {
    if (!this.ids) return String(row);
    return String(columnValue(this.ids, row));
  }

  /**
   * Computes the bbox of every row, `[minX, minY, maxX, maxY]` per row (NaN for a row without a
   * geometry)
   */
  computeBounds(): Float64Array {
    const n = this.length;
    const bounds = new Float64Array(n * 4);
    for (let row = 0; row < n; row++) {
      const at = row * 4;
      let minX = Number.POSITIVE_INFINITY;
      let minY = Number.POSITIVE_INFINITY;
      let maxX = Number.NEGATIVE_INFINITY;
      let maxY = Number.NEGATIVE_INFINITY;
      const column = this.columnOf(row);
      if (column !== undefined && this.isValid(row)) {
        const r = this.childRowOf(row);
        const end = column.vertexStart(r + 1);
        const coords = column.coords;
        const stride = column.stride;
        for (let v = column.vertexStart(r); v < end; v++) {
          const x = coords[v * stride];
          const y = coords[v * stride + 1];
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
      if (minX === Number.POSITIVE_INFINITY || Number.isNaN(minX) || Number.isNaN(minY)) {
        bounds[at] = Number.NaN;
        bounds[at + 1] = Number.NaN;
        bounds[at + 2] = Number.NaN;
        bounds[at + 3] = Number.NaN;
      } else {
        bounds[at] = minX;
        bounds[at + 1] = minY;
        bounds[at + 2] = maxX;
        bounds[at + 3] = maxY;
      }
    }
    return bounds;
  }

  /** The number of coordinates of every row (the estimate of the work of the splitting) */
  computeVertexCounts(): Int32Array {
    const n = this.length;
    const counts = new Int32Array(n);
    for (let row = 0; row < n; row++) {
      const column = this.columnOf(row);
      if (column === undefined) continue;
      const r = this.childRowOf(row);
      counts[row] = column.vertexStart(r + 1) - column.vertexStart(r);
    }
    return counts;
  }

  /** The coordinates of a row, shaped as for its geometry type (a NaN point without a geometry) */
  coordinatesOf(row: number): FeatureCoordinates {
    const column = this.columnOf(row);
    return column === undefined
      ? [Number.NaN, Number.NaN]
      : (column.coordinatesOf(this.childRowOf(row)) as FeatureCoordinates);
  }

  /** The value of every column at a row */
  propertiesOf(row: number): Record<string, Value> {
    // The columns of a table hold strings, numbers, booleans and null
    const properties: Record<string, Value> = {};
    for (const name of this.columnNames) {
      setOwnProperty(properties, name, columnValue(this.columns[name], row) as Value);
    }
    return properties;
  }

  /**
   * Materializes one row as a feature
   *
   * A row of a mixed column that names no child is a Point with NaN coordinates.
   *
   * @param hasGeometry Whether the row has a geometry (a row without one is not visible)
   */
  featureAt(row: number, hasGeometry: boolean): Feature {
    const type = this.columnOf(row)?.type ?? 'Point';
    return {
      id: this.idOf(row),
      type,
      // The type of a column is a GeoJSON geometry type, so it is the kind of the geometry
      geometry: { type, coordinates: this.coordinatesOf(row) } as Geometry,
      layerId: '',
      groupId: undefined,
      properties: this.propertiesOf(row),
      locked: false,
      visible: hasGeometry,
      style: {},
    };
  }
}

/**
 * Validates the children of a mixed geometry column and the child and child row of every row
 *
 * @throws when an array has the wrong type or is shorter than the table, or when a row names a
 *   child that does not exist or a row past the end of its child
 */
function readMixedChildren(
  geometry: TableMixedGeometry,
  length: number,
): ShapeFormReader<GeometryType>[] {
  const { types, offsets, children } = geometry;
  if (!(types instanceof Int8Array)) {
    throw new Error('Table: geometry.types must be an Int8Array');
  }
  if (!(offsets instanceof Int32Array)) {
    throw new Error('Table: geometry.offsets must be an Int32Array');
  }
  if (!Array.isArray(children)) {
    throw new Error('Table: geometry.children must be an array');
  }
  if (types.length < length) {
    throw new Error('Table: geometry.types is shorter than the table');
  }
  if (offsets.length < length) {
    throw new Error('Table: geometry.offsets is shorter than the table');
  }
  const columns = children.map((child, k) =>
    readGeometryColumn(child, undefined, `geometry.children[${k}]`),
  );
  for (let row = 0; row < length; row++) {
    const child = types[row];
    if (child < 0) continue;
    if (child >= columns.length) {
      throw new Error(
        `Table: geometry.types[${row}] is ${child}, but there are ${columns.length} children`,
      );
    }
    const at = offsets[row];
    if (at < 0 || at >= columns[child].length) {
      throw new Error(
        `Table: geometry.offsets[${row}] is ${at}, but geometry.children[${child}] has ${columns[child].length} rows`,
      );
    }
  }
  return columns;
}
