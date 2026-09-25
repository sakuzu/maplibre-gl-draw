// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The reading of a columnar table (`DatasetColumnarInput`)
 *
 * It checks the shape of the input once and then reads the arrays as they are: the vertex run of
 * a row, the value of a column at a row, the bbox of every row, and one row materialized as a
 * feature on demand. Nothing is built per row until a row is asked for.
 *
 * A pure module (it imports only types), so it runs in a Worker as well.
 */

import type { Coordinate, Feature } from '../../shared/types/model.js';
import type {
  DatasetColumn,
  DatasetColumnarGeometryType,
  DatasetColumnarInput,
  DatasetDictionaryColumn,
} from './types.js';

/** The number of offset arrays of each geometry type */
const OFFSET_LEVELS: Readonly<Record<DatasetColumnarGeometryType, number>> = {
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
export function isDictionaryColumn(column: DatasetColumn): column is DatasetDictionaryColumn {
  return (
    typeof column === 'object' &&
    column !== null &&
    !Array.isArray(column) &&
    !ArrayBuffer.isView(column) &&
    'codes' in column
  );
}

/** The number of rows a column holds */
function columnLength(column: DatasetColumn): number {
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
export function columnValue(column: DatasetColumn, row: number): unknown {
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
 * A validated columnar table
 *
 * @internal
 */
export class ColumnarTable {
  readonly length: number;
  readonly type: DatasetColumnarGeometryType;
  readonly coords: Float64Array;
  /** The number of values per coordinate (2 or 3) */
  readonly dimensions: number;
  readonly offsets: readonly Int32Array[];
  readonly validity: Uint8Array | undefined;
  readonly ids: DatasetColumn | undefined;
  readonly columns: Readonly<Record<string, DatasetColumn>>;
  /** The names of the columns (the key order of `columns`) */
  readonly columnNames: readonly string[];

  /**
   * @throws when the shape of the input does not add up (a wrong type, an offset array of the
   *   wrong length, a column shorter than the table)
   */
  constructor(readonly input: DatasetColumnarInput) {
    const { length, geometry } = input;
    if (!Number.isInteger(length) || length < 0) {
      throw new Error(`Columnar input: length must be a non-negative integer (got ${length})`);
    }
    if (!geometry || !(geometry.type in OFFSET_LEVELS)) {
      throw new Error(`Columnar input: unknown geometry type "${geometry?.type}"`);
    }
    if (!(geometry.coords instanceof Float64Array)) {
      throw new Error('Columnar input: geometry.coords must be a Float64Array');
    }
    const dimensions = geometry.dimensions ?? 2;
    if (dimensions !== 2 && dimensions !== 3) {
      throw new Error(`Columnar input: dimensions must be 2 or 3 (got ${dimensions})`);
    }
    const offsets = geometry.offsets ?? [];
    const levels = OFFSET_LEVELS[geometry.type];
    if (offsets.length !== levels) {
      throw new Error(
        `Columnar input: a ${geometry.type} table has ${levels} offset arrays (got ${offsets.length})`,
      );
    }

    // Each level splits the elements of the level above it
    let elements = length;
    for (let level = 0; level < levels; level++) {
      const array = offsets[level];
      if (!(array instanceof Int32Array)) {
        throw new Error(`Columnar input: offsets[${level}] must be an Int32Array`);
      }
      if (array.length < elements + 1) {
        throw new Error(
          `Columnar input: offsets[${level}] has ${array.length} entries for ${elements} elements`,
        );
      }
      elements = array[elements];
    }
    const vertexCount = Math.floor(geometry.coords.length / dimensions);
    if (elements > vertexCount) {
      throw new Error(
        `Columnar input: the offsets reach coordinate ${elements} of ${vertexCount} coordinates`,
      );
    }

    if (input.validity && input.validity.length < Math.ceil(length / 8)) {
      throw new Error('Columnar input: validity is shorter than the table');
    }
    if (input.ids && columnLength(input.ids) < length) {
      throw new Error('Columnar input: ids is shorter than the table');
    }
    const columns = input.columns ?? {};
    for (const [name, column] of Object.entries(columns)) {
      if (columnLength(column) < length) {
        throw new Error(`Columnar input: column "${name}" is shorter than the table`);
      }
    }

    this.length = length;
    this.type = geometry.type;
    this.coords = geometry.coords;
    this.dimensions = dimensions;
    this.offsets = offsets;
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

  /** The first coordinate of the run of a row */
  vertexStart(row: number): number {
    let at = row;
    for (let level = 0; level < this.offsets.length; level++) at = this.offsets[level][at];
    return at;
  }

  /** The end (exclusive) of the run of a row */
  vertexEnd(row: number): number {
    return this.vertexStart(row + 1);
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
    const coords = this.coords;
    const stride = this.dimensions;
    let start = this.vertexStart(0);
    for (let row = 0; row < n; row++) {
      const end = this.vertexStart(row + 1);
      const at = row * 4;
      let minX = Number.POSITIVE_INFINITY;
      let minY = Number.POSITIVE_INFINITY;
      let maxX = Number.NEGATIVE_INFINITY;
      let maxY = Number.NEGATIVE_INFINITY;
      if (this.isValid(row)) {
        for (let v = start; v < end; v++) {
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
      start = end;
    }
    return bounds;
  }

  /** The number of coordinates of every row (the estimate of the work of the splitting) */
  computeVertexCounts(): Int32Array {
    const n = this.length;
    const counts = new Int32Array(n);
    let start = this.vertexStart(0);
    for (let row = 0; row < n; row++) {
      const end = this.vertexStart(row + 1);
      counts[row] = end - start;
      start = end;
    }
    return counts;
  }

  /** Coordinate `v` as `[lng, lat]` */
  position(v: number): Coordinate {
    const at = v * this.dimensions;
    return [this.coords[at], this.coords[at + 1]];
  }

  /** The coordinates `[from, to)` as an array of positions */
  positions(from: number, to: number): Coordinate[] {
    const out: Coordinate[] = new Array(to - from);
    for (let v = from; v < to; v++) out[v - from] = this.position(v);
    return out;
  }

  /** The coordinates of a row, shaped as for its geometry type */
  coordinatesOf(row: number): Feature['coordinates'] {
    const o = this.offsets;
    switch (this.type) {
      case 'Point':
        return this.position(row);
      case 'LineString':
      case 'MultiPoint':
        return this.positions(o[0][row], o[0][row + 1]);
      case 'Polygon':
      case 'MultiLineString': {
        const rings: Coordinate[][] = [];
        for (let r = o[0][row]; r < o[0][row + 1]; r++) {
          rings.push(this.positions(o[1][r], o[1][r + 1]));
        }
        return rings;
      }
      case 'MultiPolygon': {
        const polygons: Coordinate[][][] = [];
        for (let p = o[0][row]; p < o[0][row + 1]; p++) {
          const rings: Coordinate[][] = [];
          for (let r = o[1][p]; r < o[1][p + 1]; r++) {
            rings.push(this.positions(o[2][r], o[2][r + 1]));
          }
          polygons.push(rings);
        }
        return polygons;
      }
    }
  }

  /** The value of every column at a row */
  propertiesOf(row: number): Record<string, unknown> {
    const properties: Record<string, unknown> = {};
    for (const name of this.columnNames) {
      properties[name] = columnValue(this.columns[name], row);
    }
    return properties;
  }

  /**
   * Materializes one row as a feature
   *
   * @param hasGeometry Whether the row has a geometry (a row without one is not visible)
   */
  featureAt(row: number, hasGeometry: boolean): Feature {
    return {
      id: this.idOf(row),
      type: this.type,
      coordinates: this.coordinatesOf(row),
      layerId: '',
      properties: this.propertiesOf(row),
      locked: false,
      visible: hasGeometry,
    };
  }
}
