// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Builds the row groups of one layer (`createRowBlockBuilder`)
 *
 * The rows are added in any order. `finish` puts them in the order of the layer
 * (`compareRowKeys`), cuts them into groups of at most a target number of rows and of
 * coordinates, and computes for every group what the main thread would otherwise compute: the
 * hashes of the ids, the bbox of every row, the caches of the rows the user of the tables
 * declares (`RowCache`), and the form of every attribute column (dense or sparse). The styles are written as their
 * canonical bytes, shared within a group; the main thread numbers them in its table of styles.
 *
 * A pure module: it depends on neither maplibre, nor WebGL, nor the DOM, so a Worker builds the
 * groups and sends them with `blockTransferList`.
 */

import {
  type CoordinateDimensions,
  type CoordinateSystem,
  encodeCanonicalValue,
  hashByteRun,
  hashUtf8,
  type PropertyColumns,
  planarCoordinates,
  strideOf,
  type Utf8Column,
  Utf8ColumnBuilder,
  utf8ColumnFromStrings,
  type ValueColumn,
  ValueColumnBuilder,
} from '@sakuzu/tabane';
import type { Geometry } from 'geojson';
import type { TableColumns } from '../feature-table/row-values.js';
import { KasaneError, kasaneErrorOf } from './kasane-error.js';
import { type RowCache, RowCacheWriter } from './row-caches.js';
import {
  flagBitOf,
  keyedColumnOf,
  type RowColumnLayout,
  rowColumnLayoutOf,
  shapeColumnOf,
  wholeColumnOf,
} from './row-columns.js';
import {
  type RowGeometry,
  rowGeometryOfColumn,
  rowShapeOf,
  toRowGeometry,
} from './row-geometry.js';
import {
  ROW_FLAG_DELETED,
  type RowBlock,
  type RowBlockData,
  type RowBlockWhole,
} from './row-group-types.js';
import { compareRowKeys, type GroupKeySource, type RowKeySource } from './row-keys.js';
import type { RowRead, RowShape } from './row-read-type.js';
import type { PointRowRings, RowRings } from './row-rings.js';
import type { GeometryType, TableGeometry, TableMixedGeometry } from './types.js';

/**
 * The target number of rows of a row block
 *
 * A row block is the unit that is built again when its rows change, so a smaller row block costs less
 * to build again and a larger one gives fewer draws. It starts from the target of a chunk of a
 * large dataset (`LARGE_CHUNK_TARGET_SIZE`), to be set from measured data.
 */
export const ROW_BLOCK_TARGET_ROWS = 4096;

/**
 * The target number of coordinates of a row block
 *
 * Cutting by the rows alone would make a row block of polygons of 50 coordinates hold 200,000
 * coordinates, and building it again would take about a second. It starts from the target of a
 * chunk (`CHUNK_TARGET_VERTICES`), to be set from measured data.
 */
export const ROW_BLOCK_TARGET_VERTICES = 40_000;

/**
 * A group of features the rows can belong to: its handle, its id and the key of its order
 */
export interface GroupEntry {
  /** The handle of the group, which a row names */
  readonly handle: number;
  /** The id of the group */
  readonly id: string;
  /** The key of the order of the group in its layer */
  readonly order: string;
}

/**
 * The options of {@link createRowBlockBuilder}
 */
export interface RowBlockBuilderOptions {
  /** The groups of features the rows can belong to (none when omitted) */
  readonly groups?: readonly GroupEntry[];
  /** The largest number of rows of a row block ({@link ROW_BLOCK_TARGET_ROWS} when omitted) */
  readonly targetRows?: number;
  /**
   * The largest number of coordinates of a row block ({@link ROW_BLOCK_TARGET_VERTICES} when
   * omitted). A single row of more coordinates makes a row block of its own
   */
  readonly targetVertices?: number;
  /**
   * The dimensions of the coordinates of the rows: those of their layer (`xy` when omitted). A
   * position of fewer values gets NaN for the others; one of more values is refused
   */
  readonly dimensions?: CoordinateDimensions;
  /**
   * The system of the coordinates the bbox of the rows is made in (the plane when omitted). A
   * function: a Worker passes its own
   */
  readonly coordinateSystem?: CoordinateSystem;
  /**
   * The rings the rows of some types draw around their point, read from the type, the point and
   * the attributes of a row (none when omitted: every row draws its shape). A function: it is
   * given in the Worker that builds the rows
   */
  readonly rings?: PointRowRings;
}

/**
 * The options of the builder of the tables (`createRowBlockDataBuilder`): those of
 * {@link RowBlockBuilderOptions}, with the rings that read a row
 *
 * @internal
 */
export interface RowBlockBuildOptions extends Omit<RowBlockBuilderOptions, 'rings'> {
  /**
   * The columns of the rows, by their names: a field of a row added is written to the column of
   * its name (`type`, `geometry`, `style`, `properties`, `hidden`, `locked`), and a field no column
   * is declared for is not held
   */
  readonly columns: TableColumns;
  /**
   * The rings the rows of some types draw around their point (none when omitted: every row draws
   * its shape). A function: it is given in the Worker that builds the rows
   */
  readonly rings?: RowRings;
  /**
   * The caches of the rows (none when omitted), made of every row built. Functions: they are given
   * in the Worker that builds the rows
   */
  readonly caches?: readonly RowCache[];
}

/**
 * One row given to the builder
 */
export interface RowInput {
  /** The id of the row (unique in the document) */
  readonly id: string;
  /** The type of the feature (`'Point'`, `'Circle'`, the type of an extension) */
  readonly type: string;
  /**
   * The GeoJSON geometry (a Circle and an Image give the Point of their center, a Freehand a
   * LineString), or null for a row without one
   */
  readonly geometry: Geometry | null;
  /** The key of the order of the row in its layer */
  readonly order: string;
  /** The key of the order of the row within its group of features (when it is in one) */
  readonly member?: string;
  /**
   * The handle of the group of features of the row (`GroupEntry.handle`; outside a group when
   * omitted or negative)
   */
  readonly group?: number;
  /** The style of the row */
  readonly style?: Readonly<Record<string, unknown>>;
  /** The attributes of the row */
  readonly properties?: Readonly<Record<string, unknown>>;
  /** Whether the row is hidden (false when omitted) */
  readonly hidden?: boolean;
  /** Whether the row is locked (false when omitted) */
  readonly locked?: boolean;
  /** Whether the row is deleted (false when omitted) */
  readonly deleted?: boolean;
}

/**
 * Builds the row blocks of one layer
 */
export interface RowBlockBuilder {
  /** The number of rows added */
  readonly length: number;
  /**
   * Adds a row
   *
   * @throws an error with the code `invalid-input` when the id was already added, when the
   *   geometry is not a GeoJSON geometry of one of the six types, or when a value of the style or
   *   the attributes cannot be held (a number that is not finite, a function)
   */
  addRow(row: RowInput): void;
  /**
   * Puts the rows in the order of the layer and cuts them into row blocks
   *
   * @throws an error with the code `not-found` when a row names a group the options do not give
   */
  finish(): RowBlock[];
}

/**
 * The builder as the tables use it: its row blocks with every column
 *
 * @internal
 */
export interface RowBlockDataBuilder extends RowBlockBuilder {
  finish(): RowBlockData[];
}

/**
 * Creates the builder of the row blocks of one layer
 *
 * @internal
 */
export function createRowBlockBuilder(options: RowBlockBuildOptions): RowBlockBuilder {
  return createRowBlockDataBuilder(options);
}

/**
 * Creates the builder of the row blocks of one layer, as the tables use it
 *
 * @internal
 */
export function createRowBlockDataBuilder(options: RowBlockBuildOptions): RowBlockDataBuilder {
  const targetRows = Math.max(1, options.targetRows ?? ROW_BLOCK_TARGET_ROWS);
  const targetVertices = Math.max(1, options.targetVertices ?? ROW_BLOCK_TARGET_VERTICES);
  const shape: GroupShape = {
    dims: options.dimensions ?? 'xy',
    coordinates: options.coordinateSystem ?? planarCoordinates,
    rings: options.rings ?? null,
    caches: options.caches ?? [],
    places: inputPlacesOf(rowColumnLayoutOf(options.columns)),
  };

  const ids = new Utf8ColumnBuilder(256);
  const itemKeys = new Utf8ColumnBuilder(256);
  const memberKeys = new Utf8ColumnBuilder(256);
  const seen = new Set<string>();
  const rows: RowInput[] = [];
  const geometries: Array<RowGeometry | null> = [];
  let groupRefs: Int32Array = new Int32Array(256);
  const places = shape.places;
  const wholes: WholeInput[] = [];
  if (places.type >= 0) {
    wholes.push(new WholeInput(places.type, 'type', places.typeInTables, (row) => row.type));
  }
  if (places.style >= 0) {
    wholes.push(
      new WholeInput(places.style, 'style', places.styleInTables, (row) => row.style ?? EMPTY),
    );
  }

  return {
    get length() {
      return rows.length;
    },
    addRow(row: RowInput): void {
      if (seen.has(row.id))
        throw new KasaneError(
          'invalid-input',
          `RowBlockBuilder: the id "${row.id}" is added twice`,
        );
      const geometry = row.geometry ? toRowGeometry(row.geometry, shape.dims) : null;
      const at = rows.length;
      for (const whole of wholes) whole.add(at, row);
      seen.add(row.id);
      if (at >= groupRefs.length) groupRefs = growInt32(groupRefs, at + 1);
      groupRefs[at] = row.group !== undefined && row.group >= 0 ? row.group : -1;
      ids.add(row.id);
      itemKeys.add(row.order);
      memberKeys.add(groupRefs[at] >= 0 ? (row.member ?? '') : '');
      rows.push(row);
      geometries.push(geometry);
    },
    finish(): RowBlockData[] {
      const n = rows.length;
      const keys: RowKeySource = {
        ids: ids.finish(),
        itemKeys: itemKeys.finish(),
        memberKeys: memberKeys.finish(),
        groups: groupRefs.slice(0, n),
      };
      const groupKeys = groupKeySource(options.groups ?? []);
      const order = new Int32Array(n);
      for (let i = 0; i < n; i++) order[i] = i;
      order.sort((a, b) => compareRowKeys(keys, a, keys, b, groupKeys));

      for (const whole of wholes) whole.finish();
      const vertexCounts = new Int32Array(n);
      for (let i = 0; i < n; i++) {
        vertexCounts[i] = vertexCountOf(rows[i], geometries[i], shape.rings);
      }

      const out: RowBlockData[] = [];
      let start = 0;
      while (start < n) {
        let end = start;
        let vertices = 0;
        while (end < n && end - start < targetRows) {
          const count = vertexCounts[order[end]];
          if (end > start && vertices + count > targetVertices) break;
          vertices += count;
          end++;
        }
        out.push(buildGroup(order.subarray(start, end), keys, rows, geometries, wholes, shape));
        start = end;
      }
      return out;
    },
  };
}

/**
 * Every buffer of the row blocks, for `postMessage` with transfer (each one once)
 *
 * @internal
 */
export function blockTransferList(groups: readonly RowBlockData[]): ArrayBuffer[] {
  const buffers = new Set<ArrayBuffer>();
  const add = (array: ArrayBufferView | null | undefined): void => {
    if (array && array.buffer instanceof ArrayBuffer) buffers.add(array.buffer);
  };
  const addColumn = (column: Utf8Column | null): void => {
    if (!column) return;
    add(column.offsets);
    add(column.bytes);
  };
  for (const group of groups) {
    add(group.handles);
    addColumn(group.ids);
    add(group.idHashes);
    for (const shape of group.shapes) {
      if (!shape) continue;
      add(shape.types);
      add(shape.offsets);
      for (const child of shape.children) {
        add(child.coords);
        for (const offsets of child.offsets ?? []) add(offsets);
      }
    }
    for (const whole of group.wholes) {
      if (!whole) continue;
      add(whole.indexes);
      if ('dictionary' in whole) addColumn(whole.dictionary);
    }
    addColumn(group.itemKeys);
    addColumn(group.memberKeys);
    add(group.groups);
    add(group.flags);
    for (const keyed of group.keyed) {
      for (const column of keyed?.columns ?? []) {
        add(column.rows);
        add(column.tags);
        add(column.numbers);
        add(column.refs);
        addColumn(column.values);
      }
    }
    add(group.rowBounds);
    for (const cache of group.caches) {
      add(cache.offsets);
      add(cache.numbers);
      add(cache.wideRows);
      add(cache.wideOffsets);
      add(cache.wideNumbers);
    }
  }
  return [...buffers];
}

// === Building one group ===

/**
 * The coordinates and offsets of one child column of a group, as it is filled
 *
 * @internal
 */
export class ChildBuilder {
  /** The coordinates added, in the first `size` values */
  private coords = new Float64Array(1024);
  private size = 0;
  level0: number[] = [0];
  level1: number[] = [0];
  level2: number[] = [0];
  rows = 0;
  private readonly stride: number;

  /**
   * @param type The geometry type of the column
   * @param dims The dimensions of its coordinates (those of every row added)
   */
  constructor(
    readonly type: GeometryType,
    readonly dims: CoordinateDimensions = 'xy',
  ) {
    this.stride = strideOf(dims);
  }

  /** Adds the geometry of a row (of the dimensions of the column); returns its row in the child */
  add(geometry: RowGeometry): number {
    this.addCoords(geometry.coords);
    const vertices = this.size / this.stride;
    switch (this.type) {
      case 'Point':
        break;
      case 'LineString':
      case 'MultiPoint':
        this.level0.push(vertices);
        break;
      case 'Polygon':
      case 'MultiLineString': {
        let at = this.level1[this.level1.length - 1];
        for (const size of geometry.parts) {
          at += size;
          this.level1.push(at);
        }
        this.level0.push(this.level1.length - 1);
        break;
      }
      case 'MultiPolygon': {
        let ring = 0;
        let at = this.level2[this.level2.length - 1];
        for (const ringCount of geometry.polygons) {
          for (let r = 0; r < ringCount; r++) {
            at += geometry.parts[ring++];
            this.level2.push(at);
          }
          this.level1.push(this.level2.length - 1);
        }
        this.level0.push(this.level1.length - 1);
        break;
      }
    }
    return this.rows++;
  }

  /**
   * Adds the geometry of row `at` of a column as it is held there; returns its row in the column.
   * A column of other dimensions is read as `add` reads a row
   */
  addOfColumn(column: TableGeometry, at: number): number {
    if ((column.dimensions ?? 'xy') !== this.dims) {
      return this.add(rowGeometryOfColumn(column, at, this.dims));
    }
    const levels = column.offsets ?? [];
    let first = at;
    let end = at + 1;
    for (const level of levels) {
      first = level[first];
      end = level[end];
    }
    this.addCoords(column.coords.subarray(first * this.stride, end * this.stride));
    const vertices = this.size / this.stride;
    const [l0, l1, l2] = levels;
    switch (this.type) {
      case 'Point':
        break;
      case 'LineString':
      case 'MultiPoint':
        this.level0.push(vertices);
        break;
      case 'Polygon':
      case 'MultiLineString': {
        let last = this.level1[this.level1.length - 1];
        for (let r = l0[at]; r < l0[at + 1]; r++) {
          last += l1[r + 1] - l1[r];
          this.level1.push(last);
        }
        this.level0.push(this.level1.length - 1);
        break;
      }
      case 'MultiPolygon': {
        let last = this.level2[this.level2.length - 1];
        for (let p = l0[at]; p < l0[at + 1]; p++) {
          for (let r = l1[p]; r < l1[p + 1]; r++) {
            last += l2[r + 1] - l2[r];
            this.level2.push(last);
          }
          this.level1.push(this.level2.length - 1);
        }
        this.level0.push(this.level1.length - 1);
        break;
      }
    }
    return this.rows++;
  }

  /** Adds coordinates after the ones added */
  private addCoords(values: Float64Array): void {
    const end = this.size + values.length;
    if (end > this.coords.length) {
      const grown = new Float64Array(Math.max(end, this.coords.length * 2));
      grown.set(this.coords.subarray(0, this.size));
      this.coords = grown;
    }
    this.coords.set(values, this.size);
    this.size = end;
  }

  finish(): TableGeometry {
    const coords = this.coords.slice(0, this.size);
    const dims = this.dims;
    switch (this.type) {
      case 'Point':
        return { type: 'Point', coords, dimensions: dims };
      case 'LineString':
      case 'MultiPoint':
        return {
          type: this.type,
          coords,
          dimensions: dims,
          offsets: [new Int32Array(this.level0)],
        };
      case 'Polygon':
      case 'MultiLineString':
        return {
          type: this.type,
          coords,
          dimensions: dims,
          offsets: [new Int32Array(this.level0), new Int32Array(this.level1)],
        };
      case 'MultiPolygon':
        return {
          type: 'MultiPolygon',
          coords,
          dimensions: dims,
          offsets: [
            new Int32Array(this.level0),
            new Int32Array(this.level1),
            new Int32Array(this.level2),
          ],
        };
    }
  }
}

/** What the coordinates of the groups are, and what they are read as */
interface GroupShape {
  readonly dims: CoordinateDimensions;
  readonly coordinates: CoordinateSystem;
  readonly rings: RowRings | null;
  readonly caches: readonly RowCache[];
  readonly places: InputPlaces;
}

/**
 * Where the fields of a row added are written: the places of the columns of their names (-1, or
 * the bit 0, for a field no column is declared for)
 */
interface InputPlaces {
  /** The number of columns of each kind */
  readonly shapes: number;
  readonly wholes: number;
  readonly keyed: number;
  readonly geometry: number;
  readonly type: number;
  /** Whether the values of the type are kept by the tables (else by each row block) */
  readonly typeInTables: boolean;
  readonly style: number;
  /** Whether the values of the style are kept by the tables (else by each row block) */
  readonly styleInTables: boolean;
  readonly properties: number;
  readonly hidden: number;
  readonly locked: number;
}

function inputPlacesOf(layout: RowColumnLayout): InputPlaces {
  const type = wholeColumnOf(layout, 'type');
  const style = wholeColumnOf(layout, 'style');
  return {
    shapes: layout.shapes.length,
    wholes: layout.wholes.length,
    keyed: layout.keyed.length,
    geometry: shapeColumnOf(layout, 'geometry'),
    type,
    typeInTables: type >= 0 && layout.dictionaries[type] === 'tables',
    style,
    styleInTables: style >= 0 && layout.dictionaries[style] === 'tables',
    properties: keyedColumnOf(layout, 'properties'),
    hidden: flagBitOf(layout, 'hidden'),
    locked: flagBitOf(layout, 'locked'),
  };
}

/** Builds one group from its rows in order (`order` holds the indices of the rows added) */
function buildGroup(
  order: Int32Array,
  keys: RowKeySource,
  rows: readonly RowInput[],
  geometries: ReadonlyArray<RowGeometry | null>,
  wholes: readonly WholeInput[],
  shape: GroupShape,
): RowBlockData {
  const places = shape.places;
  const length = order.length;
  const ids = new Utf8ColumnBuilder(length);
  const itemKeys = new Utf8ColumnBuilder(length);
  const memberKeys = new Utf8ColumnBuilder(length);
  const idHashes = new Uint32Array(length);
  const groups = new Int32Array(length);
  const flags = new Uint8Array(length);
  const childTypes = new Int8Array(length);
  const childRows = new Int32Array(length);
  const children: ChildBuilder[] = [];
  const childIndex = new Map<GeometryType, number>();
  const rowBounds = new Float64Array(length * 4);
  const caches = shape.caches.map((cache) => new RowCacheWriter(cache.name, cache.width, length));
  const propertyBuilders = new Map<string, ValueColumnBuilder>();
  let vertexCount = 0;

  for (let r = 0; r < length; r++) {
    const source = order[r];
    const row = rows[source];
    ids.addEntry(keys.ids, source);
    idHashes[r] = hashUtf8(keys.ids, source);
    itemKeys.addEntry(keys.itemKeys, source);
    memberKeys.addEntry(keys.memberKeys, source);
    groups[r] = keys.groups[source];

    flags[r] =
      (row.hidden === true ? places.hidden : 0) |
      (row.locked === true ? places.locked : 0) |
      (row.deleted === true ? ROW_FLAG_DELETED : 0);

    const properties = places.properties >= 0 ? row.properties : undefined;
    if (properties) {
      try {
        for (const key of Object.keys(properties)) {
          let builder = propertyBuilders.get(key);
          if (!builder) {
            builder = new ValueColumnBuilder(length);
            propertyBuilders.set(key, builder);
          }
          builder.set(r, properties[key]);
        }
      } catch (error) {
        throw kasaneErrorOf(error);
      }
    }

    const geometry = places.geometry >= 0 ? geometries[source] : null;
    if (!geometry) {
      childTypes[r] = -1;
      setNaNBounds(rowBounds, r);
      for (const cache of caches) cache.skip(r);
      continue;
    }
    let child = childIndex.get(geometry.type);
    if (child === undefined) {
      child = children.length;
      children.push(new ChildBuilder(geometry.type, shape.dims));
      childIndex.set(geometry.type, child);
    }
    childTypes[r] = child;
    childRows[r] = children[child].add(geometry);
    vertexCount += vertexCountOf(row, geometry, shape.rings);

    const ring = ringOfRow(row, geometry, shape.rings);
    if (ring) {
      shape.coordinates.rowBox(ring, 2, 0, ring.length / 2, rowBounds, r * 4);
    } else {
      const stride = geometry.stride;
      shape.coordinates.rowBox(
        geometry.coords,
        stride,
        0,
        geometry.coords.length / stride,
        rowBounds,
        r * 4,
      );
    }
    if (caches.length > 0) {
      const read = new InputRowRead(row, geometry);
      for (let c = 0; c < caches.length; c++) caches[c].put(r, shape.caches[c].build(read, ring));
    }
  }

  const keysOfProperties = [...propertyBuilders.keys()];
  const columns: ValueColumn[] = keysOfProperties.map((key) =>
    (propertyBuilders.get(key) as ValueColumnBuilder).finish(),
  );
  // A column no row holds a value of has no arrays
  const shapes: Array<TableMixedGeometry | null> = new Array(places.shapes).fill(null);
  if (children.length > 0) {
    shapes[places.geometry] = {
      type: 'Mixed',
      types: childTypes,
      offsets: childRows,
      children: children.map((child) => child.finish()),
    };
  }
  const keyed: Array<PropertyColumns | null> = new Array(places.keyed).fill(null);
  if (keysOfProperties.length > 0) {
    keyed[places.properties] = { keys: keysOfProperties, columns };
  }
  const wholeColumns: Array<RowBlockWhole | null> = new Array(places.wholes).fill(null);
  for (const whole of wholes) wholeColumns[whole.place] = whole.build(order, rows);

  return {
    length,
    handles: new Int32Array(length).fill(-1),
    ids: ids.finish(),
    idHashes,
    shapes,
    wholes: wholeColumns,
    keyed,
    itemKeys: itemKeys.finish(),
    memberKeys: memberKeys.finish(),
    groups,
    flags,
    rowBounds,
    caches: caches.map((cache) => cache.finish()),
    vertexCount,
  };
}

/** A row added, as the rings and the caches read it */
class InputRowRead implements RowRead {
  readonly handle = -1;
  private made: RowShape | null = null;
  constructor(
    private readonly row: RowInput,
    private readonly geometry: RowGeometry | null,
  ) {}

  get type(): string {
    return this.row.type;
  }

  value(key: string): unknown {
    const properties = this.row.properties;
    return properties ? properties[key] : undefined;
  }

  shape(): RowShape | null {
    if (!this.geometry) return null;
    this.made ??= rowShapeOf(this.geometry);
    return this.made;
  }
}

/** The ring a row draws around its point, or null for a row that draws its geometry */
function ringOfRow(
  row: RowInput,
  geometry: RowGeometry,
  rings: RowRings | null,
): Float64Array | null {
  if (!rings || geometry.type !== 'Point' || !rings.draws(row.type)) return null;
  return rings.ringOf(new InputRowRead(row, geometry));
}

/** The number of coordinates a row draws (the estimate of the work of a group) */
function vertexCountOf(
  row: RowInput,
  geometry: RowGeometry | null,
  rings: RowRings | null,
): number {
  if (!geometry) return 0;
  if (rings && geometry.type === 'Point' && rings.draws(row.type)) {
    const ring = ringOfRow(row, geometry, rings);
    return ring ? ring.length / 2 : 1;
  }
  return geometry.coords.length / geometry.stride;
}

function setNaNBounds(bounds: Float64Array, row: number): void {
  bounds.fill(Number.NaN, row * 4, row * 4 + 4);
}

// === The whole columns ===

/** The value of a `style` of a row added without one */
const EMPTY: Readonly<Record<string, unknown>> = Object.freeze({});

/**
 * The values of a `whole` column of the rows added: as their canonical bytes, each different
 * value once, for a column the tables keep the values of (`'tables'`: the tables number them when
 * they take the row block in), or as they are, for a column each row block keeps the values of
 */
class WholeInput {
  /** The entry of the canonical bytes of the value of each row added (for `'tables'`) */
  private refs: Int32Array = new Int32Array(256);
  private readonly interner: ValueInterner | null;
  private dictionary: Utf8Column | null = null;

  constructor(
    /** The place of the column in `RowBlockData.wholes` */
    readonly place: number,
    /** The name of the column */
    private readonly name: string,
    inTables: boolean,
    /** The value of the column of a row */
    private readonly read: (row: RowInput) => unknown,
  ) {
    this.interner = inTables ? new ValueInterner() : null;
  }

  /** Takes the value of a row added (checks that it can be held) */
  add(at: number, row: RowInput): void {
    if (!this.interner) return;
    const entry = this.interner.intern(this.read(row));
    if (at >= this.refs.length) this.refs = growInt32(this.refs, at + 1);
    this.refs[at] = entry;
  }

  /** Ends the adding of rows */
  finish(): void {
    if (this.interner) this.dictionary = this.interner.finish();
  }

  /** The column of the rows of a row block (`order` holds the indices of the rows added) */
  build(order: Int32Array, rows: readonly RowInput[]): RowBlockWhole {
    const length = order.length;
    if (this.interner) {
      const all = this.dictionary as Utf8Column;
      const indexes = new Uint32Array(length);
      const local = new Map<number, number>();
      const dictionary = new Utf8ColumnBuilder(8);
      for (let r = 0; r < length; r++) {
        const global = this.refs[order[r]];
        let at = local.get(global);
        if (at === undefined) {
          at = local.size;
          local.set(global, at);
          dictionary.addEntry(all, global);
        }
        indexes[r] = at;
      }
      return { indexes, dictionary: dictionary.finish() };
    }
    const indexes = new Uint8Array(length);
    const values: unknown[] = [];
    const index = new Map<unknown, number>();
    for (let r = 0; r < length; r++) {
      const value = this.read(rows[order[r]]);
      let at = index.get(value);
      if (at === undefined) {
        if (values.length >= 255) {
          throw new KasaneError(
            'invalid-input',
            `RowBlockBuilder: more than 255 values of ${this.name} in a row block`,
          );
        }
        at = values.length;
        values.push(value);
        index.set(value, at);
      }
      indexes[r] = at;
    }
    return { indexes, values };
  }
}

/** Shares the canonical bytes of the values of a column (one entry per distinct value) */
class ValueInterner {
  private readonly column = new Utf8ColumnBuilder(16);
  private readonly entries: Uint8Array[] = [];
  private readonly buckets = new Map<number, number[]>();
  private readonly byObject = new WeakMap<object, number>();

  intern(value: unknown): number {
    const object = typeof value === 'object' && value !== null ? value : null;
    const known = object ? this.byObject.get(object) : undefined;
    if (known !== undefined) return known;
    let bytes: Uint8Array;
    try {
      bytes = encodeCanonicalValue(value);
    } catch (error) {
      throw kasaneErrorOf(error);
    }
    const hash = hashByteRun(bytes, 0, bytes.length);
    let bucket = this.buckets.get(hash);
    if (bucket) {
      for (const entry of bucket) {
        if (sameBytes(this.entries[entry], bytes)) {
          if (object) this.byObject.set(object, entry);
          return entry;
        }
      }
    } else {
      bucket = [];
      this.buckets.set(hash, bucket);
    }
    const entry = this.entries.length;
    this.entries.push(bytes);
    this.column.addBytes(bytes);
    bucket.push(entry);
    if (object) this.byObject.set(object, entry);
    return entry;
  }

  finish(): Utf8Column {
    return this.entries.length === 0 ? utf8ColumnFromStrings([]) : this.column.finish();
  }
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let k = 0; k < a.length; k++) if (a[k] !== b[k]) return false;
  return true;
}

// === Groups and geometry ===

/**
 * The keys of the groups of features the rows name, by handle (null when there is none)
 *
 * @internal
 */
export function groupKeySource(groups: readonly GroupEntry[]): GroupKeySource | null {
  if (groups.length === 0) return null;
  const entries = new Map<number, number>();
  groups.forEach((group, i) => {
    entries.set(group.handle, i);
  });
  return {
    ids: utf8ColumnFromStrings(groups.map((group) => group.id)),
    keys: utf8ColumnFromStrings(groups.map((group) => group.order)),
    entryOf: (handle) => entries.get(handle) ?? -1,
  };
}

function growInt32(array: Int32Array, length: number): Int32Array {
  let size = array.length * 2;
  while (size < length) size *= 2;
  const next = new Int32Array(size);
  next.set(array);
  return next;
}
