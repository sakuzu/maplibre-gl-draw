// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The building of a table from GeoJSON, row by row
 *
 * The builder collects the coordinates into growing typed arrays and the offsets in the layout
 * of GeoArrow, one geometry column per geometry type. At the end the columns become the geometry
 * of the table: the one column when every row has the same type, or a mixed geometry column
 * otherwise. The attributes are collected per property name and become typed columns where they
 * can.
 *
 * The positions keep every value they have: a column holds the dimensions of the longest of its
 * positions (`xyz` for 3 values, `xyzm` for 4), or the ones the builder is given.
 *
 * A pure module (it depends on nothing outside `/table`), so it runs in a Worker as well.
 */

import { type CoordinateDimensions, copyCoordinates, strideOf } from '@sakuzu/tabane';
import type { Feature, Geometry, Position } from 'geojson';
import type { Column, GeometryType, Table, TableGeometry } from './types.js';

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
   * @param geometry The GeoJSON geometry of the row; every value of its positions is kept (see
   *   {@link createTableBuilder})
   * @param properties The attributes of the row
   * @param id The id of the row. Once any row has an id, the rows without one get their row
   *   number
   * @throws when the builder was created with a `geometryType` and the geometry has another
   *   type, when a position has more values than the `dimensions` of the builder (or than 4), or when
   *   `finish` was already called
   */
  add(
    geometry: Geometry | null,
    properties?: Record<string, unknown> | null,
    id?: string | number,
  ): void;
  /**
   * Turns the rows added so far into a table; the builder cannot be used afterwards.
   *
   * @throws when it was already called
   */
  finish(): Table;
}

/** The number of offset arrays of each geometry type */
const OFFSET_LEVELS: Readonly<Record<GeometryType, number>> = {
  Point: 0,
  LineString: 1,
  MultiPoint: 1,
  Polygon: 2,
  MultiLineString: 2,
  MultiPolygon: 3,
};

/** The initial number of rows when no capacity is given */
const DEFAULT_CAPACITY = 64;

/** A Float64Array that grows as values are pushed */
class GrowingFloat64 {
  private data: Float64Array;
  length = 0;

  constructor(capacity: number) {
    this.data = new Float64Array(Math.max(4, capacity));
  }

  private reserve(count: number): void {
    if (this.length + count > this.data.length) {
      const next = new Float64Array(Math.max(this.data.length * 2, this.length + count));
      next.set(this.data);
      this.data = next;
    }
  }

  push2(a: number, b: number): void {
    this.reserve(2);
    this.data[this.length++] = a;
    this.data[this.length++] = b;
  }

  /** Pushes the first `stride` values of a position, NaN for the ones it does not have */
  pushPosition(position: Position, stride: number): void {
    this.reserve(stride);
    for (let k = 0; k < stride; k++) {
      this.data[this.length++] = k < position.length ? position[k] : Number.NaN;
    }
  }

  /** The values pushed as coordinates of other dimensions (more of them: NaN for the new ones) */
  restride(from: CoordinateDimensions, to: CoordinateDimensions): void {
    const count = this.length / strideOf(from);
    const next = new Float64Array(
      Math.max(4, Math.ceil(this.data.length / strideOf(from))) * strideOf(to),
    );
    copyCoordinates(this.data, from, 0, count, next, to, 0);
    this.data = next;
    this.length = count * strideOf(to);
  }

  /** A copy of exactly the pushed values */
  finish(): Float64Array {
    return this.data.slice(0, this.length);
  }
}

/** An Int32Array that grows as values are pushed */
class GrowingInt32 {
  private data: Int32Array;
  length = 0;

  constructor(capacity: number) {
    this.data = new Int32Array(Math.max(4, capacity));
  }

  push(value: number): void {
    if (this.length + 1 > this.data.length) {
      const next = new Int32Array(this.data.length * 2);
      next.set(this.data);
      this.data = next;
    }
    this.data[this.length++] = value;
  }

  get(index: number): number {
    return this.data[index];
  }

  /** The last value pushed */
  last(): number {
    return this.data[this.length - 1];
  }

  /** A copy of exactly the pushed values */
  finish(): Int32Array {
    return this.data.slice(0, this.length);
  }
}

/** The geometry column of one geometry type, collected row by row */
class GeometryColumnBuilder {
  /** The number of rows collected */
  rows = 0;
  private readonly coords: GrowingFloat64;
  /** The offset arrays, outermost first; each starts with 0 */
  private readonly offsets: GrowingInt32[] = [];
  /** The dimensions of the coordinates collected */
  private dims: CoordinateDimensions;
  private stride: number;

  /**
   * @param fixedDims The dimensions of every position (they grow with the positions when
   *   omitted)
   */
  constructor(
    readonly type: GeometryType,
    capacity: number,
    private readonly fixedDims: CoordinateDimensions | undefined,
  ) {
    this.dims = fixedDims ?? 'xy';
    this.stride = strideOf(this.dims);
    this.coords = new GrowingFloat64(capacity * this.stride);
    for (let level = 0; level < OFFSET_LEVELS[type]; level++) {
      const offsets = new GrowingInt32(capacity + 1);
      offsets.push(0);
      this.offsets.push(offsets);
    }
  }

  /** The number of coordinates collected */
  private get vertexCount(): number {
    return this.coords.length / this.stride;
  }

  /**
   * Makes the column hold the values of a position: its dimensions grow to the ones of a longer
   * one (3 values: `xyz`, 4: `xyzm`) unless they are fixed
   *
   * @throws when the position has more values than the dimensions can hold
   */
  private holdDimsOf(position: Position): void {
    const length = position.length;
    if (length <= this.stride) return;
    if (this.fixedDims !== undefined || length > 4) {
      throw new TypeError(
        `TableBuilder: a position of ${length} values does not fit coordinates of ${this.fixedDims ?? 'xyzm'}`,
      );
    }
    const dims: CoordinateDimensions = length === 3 && this.dims === 'xy' ? 'xyz' : 'xyzm';
    this.coords.restride(this.dims, dims);
    this.dims = dims;
    this.stride = strideOf(dims);
  }

  private pushPosition(position: Position): void {
    if (this.stride === 2 && position.length <= 2) {
      this.coords.push2(position[0], position[1]);
      return;
    }
    this.holdDimsOf(position);
    this.coords.pushPosition(position, this.stride);
  }

  private pushPositions(positions: readonly Position[]): void {
    for (const position of positions) this.pushPosition(position);
  }

  /** Closes an element of an offset level at the current end of the level below it */
  private close(level: number): void {
    const below = level + 1 < this.offsets.length ? this.offsets[level + 1].length - 1 : null;
    this.offsets[level].push(below ?? this.vertexCount);
  }

  /** Adds the coordinates of one row, shaped as for the type of the column */
  add(coordinates: unknown): void {
    switch (this.type) {
      case 'Point':
        this.pushPosition(coordinates as Position);
        break;
      case 'LineString':
      case 'MultiPoint':
        this.pushPositions(coordinates as Position[]);
        this.close(0);
        break;
      case 'Polygon':
      case 'MultiLineString':
        for (const ring of coordinates as Position[][]) {
          this.pushPositions(ring);
          this.close(1);
        }
        this.close(0);
        break;
      case 'MultiPolygon':
        for (const polygon of coordinates as Position[][][]) {
          for (const ring of polygon) {
            this.pushPositions(ring);
            this.close(2);
          }
          this.close(1);
        }
        this.close(0);
        break;
    }
    this.rows++;
  }

  /** The column as collected: one row per row added */
  finish(): TableGeometry {
    const geometry: TableGeometry = { type: this.type, coords: this.coords.finish() };
    if (this.dims !== 'xy') geometry.dimensions = this.dims;
    if (this.offsets.length > 0) geometry.offsets = this.offsets.map((o) => o.finish());
    return geometry;
  }

  /**
   * The column spread over the rows of the table, with an empty run (NaN coordinates for a
   * Point) for every row without a geometry
   *
   * @param childOf The child of every row of the table (negative for a row without a geometry)
   * @param length The number of rows of the table
   */
  finishSpread(childOf: Int8Array, length: number): TableGeometry {
    const dims = this.dims !== 'xy' ? { dimensions: this.dims } : {};
    if (this.type === 'Point') {
      const source = this.coords.finish();
      const stride = this.stride;
      const coords = new Float64Array(length * stride);
      let k = 0;
      for (let row = 0; row < length; row++) {
        if (childOf[row] < 0) {
          coords.fill(Number.NaN, row * stride, (row + 1) * stride);
        } else {
          for (let i = 0; i < stride; i++) coords[row * stride + i] = source[k * stride + i];
          k++;
        }
      }
      return { type: 'Point', coords, ...dims };
    }
    const outer = this.offsets[0];
    const first = new Int32Array(length + 1);
    let k = 0;
    for (let row = 0; row < length; row++) {
      if (childOf[row] >= 0) k++;
      first[row + 1] = outer.get(k);
    }
    return {
      type: this.type,
      coords: this.coords.finish(),
      ...dims,
      offsets: [first, ...this.offsets.slice(1).map((o) => o.finish())],
    };
  }
}

/** The values of one attribute column, collected row by row */
interface ColumnState {
  values: unknown[];
  /** Whether every value that is not null is a number */
  numeric: boolean;
}

/** Whether a GeoJSON geometry type is one a table holds */
function isTableGeometryType(type: string): type is GeometryType {
  return type in OFFSET_LEVELS;
}

/**
 * Creates a builder that makes a table from rows added one at a time.
 *
 * The coordinates are collected into growing typed arrays in the layout of GeoArrow. When every
 * row has the same geometry type the table has one geometry column of that type; otherwise it
 * has a mixed geometry column. An attribute whose values are all numbers (or null) becomes a
 * `Float64Array` with NaN for null; any other attribute becomes a plain array.
 *
 * Every value of the positions is kept. A geometry column holds `x` and `y`, and takes the
 * dimensions of a longer position when one comes (`xyz` for 3 values, `xyzm` for 4), the values
 * the positions before it do not have being NaN; the rows are drawn by their `x` and `y`. With
 * `dimensions`, every column has those dimensions, and a longer position throws.
 *
 * @param options `geometryType` fixes the geometry type of every row (a geometry of another
 *   type throws), and gives the type of a table without any geometry. `capacity` is the
 *   expected number of rows, to size the arrays from the start. `columns` limits the attributes
 *   that become columns to these names (every one is created, even if no row has it).
 *   `dimensions` fixes the dimensions of the coordinates (`[x, y, m]` is a position of `xym`)
 * @returns A new builder
 */
export function createTableBuilder(options?: {
  geometryType?: GeometryType;
  capacity?: number;
  columns?: readonly string[];
  dimensions?: CoordinateDimensions;
}): TableBuilder {
  const fixedType = options?.geometryType;
  const fixedDims = options?.dimensions;
  const capacity = Math.max(1, Math.floor(options?.capacity ?? DEFAULT_CAPACITY));
  const fixedColumns = options?.columns !== undefined;

  let length = 0;
  let finished = false;
  /** The child of every row (-1 for a row without a geometry) */
  let childOf = new Int8Array(capacity);
  /** The row within its child of every row */
  let childRow = new Int32Array(capacity);
  const children: GeometryColumnBuilder[] = [];
  const childByType = new Map<GeometryType, number>();
  const columns = new Map<string, ColumnState>();
  for (const name of options?.columns ?? []) columns.set(name, { values: [], numeric: true });
  let ids: unknown[] | null = null;

  const ensureRowCapacity = (): void => {
    if (length < childOf.length) return;
    const nextOf = new Int8Array(childOf.length * 2);
    nextOf.set(childOf);
    childOf = nextOf;
    const nextRow = new Int32Array(childRow.length * 2);
    nextRow.set(childRow);
    childRow = nextRow;
  };

  const childFor = (type: GeometryType): number => {
    let child = childByType.get(type);
    if (child === undefined) {
      child = children.length;
      children.push(new GeometryColumnBuilder(type, capacity, fixedDims));
      childByType.set(type, child);
    }
    return child;
  };

  const checkOpen = (): void => {
    if (finished) throw new Error('TableBuilder: finish was already called');
  };

  const add = (
    geometry: Geometry | null,
    properties?: Record<string, unknown> | null,
    id?: string | number,
  ): void => {
    checkOpen();
    ensureRowCapacity();
    const row = length;

    let child = -1;
    if (geometry && isTableGeometryType(geometry.type)) {
      if (fixedType !== undefined && geometry.type !== fixedType) {
        throw new TypeError(
          `TableBuilder: row ${row} is a ${geometry.type}, but the table holds ${fixedType}`,
        );
      }
      child = childFor(geometry.type);
      childRow[row] = children[child].rows;
      children[child].add((geometry as { coordinates: unknown }).coordinates);
    }
    childOf[row] = child;

    if (properties) {
      for (const name of Object.keys(properties)) {
        let column = columns.get(name);
        if (!column) {
          if (fixedColumns) continue;
          column = { values: new Array(row).fill(null), numeric: true };
          columns.set(name, column);
        }
        const value = properties[name] ?? null;
        if (value !== null && typeof value !== 'number') column.numeric = false;
        column.values.push(value);
      }
    }
    for (const column of columns.values()) {
      if (column.values.length === row) column.values.push(null);
    }

    if (id !== undefined && ids === null) ids = Array.from({ length: row }, (_, i) => i);
    if (ids !== null) ids.push(id ?? row);

    length++;
  };

  const finish = (): Table => {
    checkOpen();
    finished = true;
    const types = childOf.slice(0, length);

    let geometry: Table['geometry'];
    if (children.length === 0) {
      geometry = emptyGeometry(fixedType ?? 'Point', length, fixedDims ?? 'xy');
    } else if (children.length === 1) {
      const only = children[0];
      geometry = only.rows === length ? only.finish() : only.finishSpread(types, length);
    } else {
      const offsets = childRow.slice(0, length);
      for (let row = 0; row < length; row++) if (types[row] < 0) offsets[row] = 0;
      geometry = {
        type: 'Mixed',
        types,
        offsets,
        children: children.map((child) => child.finish()),
      };
    }

    const table: Table = { length, geometry, columns: {} };
    const out = table.columns as Record<string, Column>;
    for (const [name, column] of columns) {
      out[name] = column.numeric
        ? Float64Array.from(column.values, (value) =>
            value === null ? Number.NaN : (value as number),
          )
        : column.values;
    }
    if (ids !== null) table.ids = ids;
    return table;
  };

  return { add, finish };
}

/** A geometry column of one type whose rows all have no geometry */
function emptyGeometry(
  type: GeometryType,
  length: number,
  dims: CoordinateDimensions,
): TableGeometry {
  const of = dims !== 'xy' ? { dimensions: dims } : {};
  if (type === 'Point') {
    return { type, coords: new Float64Array(length * strideOf(dims)).fill(Number.NaN), ...of };
  }
  const levels = OFFSET_LEVELS[type];
  const offsets = [new Int32Array(length + 1)];
  for (let level = 1; level < levels; level++) offsets.push(new Int32Array(1));
  return { type, coords: new Float64Array(0), ...of, offsets };
}

/**
 * Makes a table from an array of GeoJSON features.
 *
 * It is {@link createTableBuilder} with one `add` per feature: the geometry, the properties and
 * the id of each feature become a row. Rows of different geometry types give a mixed geometry
 * column.
 *
 * @param features The features, in row order
 * @param options `columns` limits the properties that become columns to these names;
 *   `dimensions` fixes the dimensions of the coordinates (see {@link createTableBuilder})
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
export function tableFromFeatures(
  features: readonly Feature<Geometry | null>[],
  options?: { columns?: readonly string[]; dimensions?: CoordinateDimensions },
): Table {
  const builder = createTableBuilder({
    capacity: features.length,
    columns: options?.columns,
    dimensions: options?.dimensions,
  });
  for (const feature of features) {
    builder.add(feature.geometry, feature.properties, feature.id);
  }
  return builder.finish();
}
