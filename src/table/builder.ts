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
 * A pure module (it imports only types), so it runs in a Worker as well.
 */

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
   * @param geometry The GeoJSON geometry of the row; only the first two values of each position
   *   are kept
   * @param properties The attributes of the row
   * @param id The id of the row. Once any row has an id, the rows without one get their row
   *   number
   * @throws when the builder was created with a `geometryType` and the geometry has another
   *   type, or when `finish` was already called
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

  push2(a: number, b: number): void {
    if (this.length + 2 > this.data.length) {
      const next = new Float64Array(Math.max(this.data.length * 2, this.length + 2));
      next.set(this.data);
      this.data = next;
    }
    this.data[this.length++] = a;
    this.data[this.length++] = b;
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

  constructor(
    readonly type: GeometryType,
    capacity: number,
  ) {
    this.coords = new GrowingFloat64(capacity * 2);
    for (let level = 0; level < OFFSET_LEVELS[type]; level++) {
      const offsets = new GrowingInt32(capacity + 1);
      offsets.push(0);
      this.offsets.push(offsets);
    }
  }

  /** The number of coordinates collected */
  private get vertexCount(): number {
    return this.coords.length / 2;
  }

  private pushPositions(positions: readonly Position[]): void {
    for (const position of positions) this.coords.push2(position[0], position[1]);
  }

  /** Closes an element of an offset level at the current end of the level below it */
  private close(level: number): void {
    const below = level + 1 < this.offsets.length ? this.offsets[level + 1].length - 1 : null;
    this.offsets[level].push(below ?? this.vertexCount);
  }

  /** Adds the coordinates of one row, shaped as for the type of the column */
  add(coordinates: unknown): void {
    switch (this.type) {
      case 'Point': {
        const position = coordinates as Position;
        this.coords.push2(position[0], position[1]);
        break;
      }
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
    if (this.type === 'Point') {
      const source = this.coords.finish();
      const coords = new Float64Array(length * 2);
      let k = 0;
      for (let row = 0; row < length; row++) {
        if (childOf[row] < 0) {
          coords[row * 2] = Number.NaN;
          coords[row * 2 + 1] = Number.NaN;
        } else {
          coords[row * 2] = source[k * 2];
          coords[row * 2 + 1] = source[k * 2 + 1];
          k++;
        }
      }
      return { type: 'Point', coords };
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
 * @param options `geometryType` fixes the geometry type of every row (a geometry of another
 *   type throws), and gives the type of a table without any geometry. `capacity` is the
 *   expected number of rows, to size the arrays from the start. `columns` limits the attributes
 *   that become columns to these names (every one is created, even if no row has it)
 * @returns A new builder
 */
export function createTableBuilder(options?: {
  geometryType?: GeometryType;
  capacity?: number;
  columns?: readonly string[];
}): TableBuilder {
  const fixedType = options?.geometryType;
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
      children.push(new GeometryColumnBuilder(type, capacity));
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
      geometry = emptyGeometry(fixedType ?? 'Point', length);
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
function emptyGeometry(type: GeometryType, length: number): TableGeometry {
  if (type === 'Point') {
    return { type, coords: new Float64Array(length * 2).fill(Number.NaN) };
  }
  const levels = OFFSET_LEVELS[type];
  const offsets = [new Int32Array(length + 1)];
  for (let level = 1; level < levels; level++) offsets.push(new Int32Array(1));
  return { type, coords: new Float64Array(0), offsets };
}

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
export function tableFromFeatures(
  features: readonly Feature<Geometry | null>[],
  options?: { columns?: readonly string[] },
): Table {
  const builder = createTableBuilder({ capacity: features.length, columns: options?.columns });
  for (const feature of features) {
    builder.add(feature.geometry, feature.properties, feature.id);
  }
  return builder.finish();
}
