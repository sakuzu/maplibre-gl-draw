// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Builds the row groups of one layer (`createRowGroupBuilder`)
 *
 * The rows are added in any order. `finish` puts them in the order of the layer
 * (`compareRowKeys`), cuts them into groups of at most a target number of rows and of
 * coordinates, and computes for every group what the main thread would otherwise compute: the
 * hashes of the ids, the bbox of every row, the triangulation of the fills, the spatial index,
 * and the form of every attribute column (dense or sparse). The styles are written as their
 * canonical bytes, shared within a group; the main thread numbers them in its table of styles.
 *
 * A pure module: it depends on neither maplibre, nor WebGL, nor the DOM, so a Worker builds the
 * groups and sends them with `rowGroupTransferList`.
 */

import earcut from 'earcut';
import type { Geometry, Position } from 'geojson';
import { generateCirclePolygon } from '../geometry/circle.js';
import { readDrawProperty } from '../shared/properties.js';
import { encodeCanonicalValue } from './canonical-value.js';
import { buildPackedRTree } from './packed-rtree.js';
import { polygonRingRuns } from './polygon-rings.js';
import {
  ROW_FLAG_DELETED,
  ROW_FLAG_LOCKED,
  ROW_FLAG_VISIBLE,
  type RowGroupData,
  type TriangleCache,
} from './row-group-types.js';
import { compareRowKeys, type GroupKeySource, type RowKeySource } from './row-keys.js';
import type { GeometryType, TableGeometry, TableMixedGeometry } from './types.js';
import {
  hashByteRun,
  hashUtf8,
  type Utf8Column,
  Utf8ColumnBuilder,
  utf8ColumnFromStrings,
} from './utf8-column.js';
import { type ValueColumn, ValueColumnBuilder } from './value-column.js';

/**
 * The target number of rows of a group
 *
 * A group is the unit that is built again when its rows change, so a smaller group costs less
 * to build again and a larger one gives fewer draws. It starts from the target of a chunk of a
 * large dataset (`LARGE_CHUNK_TARGET_SIZE`), to be set from measured data.
 */
export const ROW_GROUP_TARGET_ROWS = 4096;

/**
 * The target number of coordinates of a group
 *
 * Cutting by the rows alone would make a group of polygons of 50 coordinates hold 200,000
 * coordinates, and building it again would take about a second. It starts from the target of a
 * chunk (`CHUNK_TARGET_VERTICES`), to be set from measured data.
 */
export const ROW_GROUP_TARGET_VERTICES = 40_000;

/** The number of vertices of a fill below which its indices take 16 bits */
const WIDE_VERTICES = 65_536;

/**
 * A group the rows can belong to: its handle, its id and the key of its order
 */
export interface RowGroupKey {
  /** The handle of the group, which a row names */
  readonly handle: number;
  /** The id of the group */
  readonly id: string;
  /** The key of the order of the group in its layer */
  readonly order: string;
}

/**
 * The options of {@link createRowGroupBuilder}
 */
export interface RowGroupBuilderOptions {
  /** The groups the rows can belong to (none when omitted) */
  readonly groups?: readonly RowGroupKey[];
  /** The largest number of rows of a group ({@link ROW_GROUP_TARGET_ROWS} when omitted) */
  readonly targetRows?: number;
  /**
   * The largest number of coordinates of a group ({@link ROW_GROUP_TARGET_VERTICES} when
   * omitted). A single row of more coordinates makes a group of its own
   */
  readonly targetVertices?: number;
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
  /** The key of the order of the row within its group (when it is in a group) */
  readonly member?: string;
  /** The handle of the group of the row (outside a group when omitted or negative) */
  readonly group?: number;
  /** The style of the row */
  readonly style?: Readonly<Record<string, unknown>>;
  /** The attributes of the row */
  readonly properties?: Readonly<Record<string, unknown>>;
  /** Whether the row is shown (true when omitted) */
  readonly visible?: boolean;
  /** Whether the row is locked (false when omitted) */
  readonly locked?: boolean;
  /** Whether the row is deleted (false when omitted) */
  readonly deleted?: boolean;
}

/**
 * Builds the row groups of one layer
 */
export interface RowGroupBuilder {
  /** The number of rows added */
  readonly length: number;
  /**
   * Adds a row
   *
   * @throws when the id was already added, when the geometry is not a GeoJSON geometry of one
   *   of the six types, or when a value of the style or the attributes cannot be held (a
   *   number that is not finite, a function)
   */
  addRow(row: RowInput): void;
  /**
   * Puts the rows in the order of the layer and cuts them into groups
   *
   * @throws when a row names a group the options do not give
   */
  finish(): RowGroupData[];
}

/** The geometry of one row as the builder keeps it until it is cut into groups */
interface RowGeometry {
  readonly type: GeometryType;
  /** The coordinates (two values each) */
  readonly coords: Float64Array;
  /**
   * The sizes of the levels: [] for Point, LineString and MultiPoint; the number of coordinates
   * of each ring (part) for Polygon and MultiLineString; for MultiPolygon the number of rings of
   * each polygon followed by the number of coordinates of each ring
   */
  readonly parts: readonly number[];
  /** The number of rings per polygon of a MultiPolygon */
  readonly polygons: readonly number[];
}

/**
 * Creates the builder of the row groups of one layer
 */
export function createRowGroupBuilder(options: RowGroupBuilderOptions = {}): RowGroupBuilder {
  const targetRows = Math.max(1, options.targetRows ?? ROW_GROUP_TARGET_ROWS);
  const targetVertices = Math.max(1, options.targetVertices ?? ROW_GROUP_TARGET_VERTICES);

  const ids = new Utf8ColumnBuilder(256);
  const itemKeys = new Utf8ColumnBuilder(256);
  const memberKeys = new Utf8ColumnBuilder(256);
  const seen = new Set<string>();
  const rows: RowInput[] = [];
  const geometries: Array<RowGeometry | null> = [];
  let groupRefs: Int32Array = new Int32Array(256);
  let styleRefs: Int32Array = new Int32Array(256);
  const styles = new StyleInterner();

  return {
    get length() {
      return rows.length;
    },
    addRow(row: RowInput): void {
      if (seen.has(row.id)) throw new Error(`RowGroupBuilder: the id "${row.id}" is added twice`);
      const geometry = row.geometry ? toRowGeometry(row.geometry) : null;
      const style = styles.intern(row.style ?? {});
      seen.add(row.id);
      const at = rows.length;
      if (at >= groupRefs.length) {
        groupRefs = growInt32(groupRefs, at + 1);
        styleRefs = growInt32(styleRefs, at + 1);
      }
      groupRefs[at] = row.group !== undefined && row.group >= 0 ? row.group : -1;
      styleRefs[at] = style;
      ids.add(row.id);
      itemKeys.add(row.order);
      memberKeys.add(groupRefs[at] >= 0 ? (row.member ?? '') : '');
      rows.push(row);
      geometries.push(geometry);
    },
    finish(): RowGroupData[] {
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

      const dictionary = styles.finish();
      const vertexCounts = new Int32Array(n);
      for (let i = 0; i < n; i++) vertexCounts[i] = vertexCountOf(rows[i], geometries[i]);

      const out: RowGroupData[] = [];
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
        out.push(
          buildGroup(order.subarray(start, end), keys, rows, geometries, styleRefs, dictionary),
        );
        start = end;
      }
      return out;
    },
  };
}

/**
 * Every buffer of the groups, for `postMessage` with transfer (each one once)
 */
export function rowGroupTransferList(groups: readonly RowGroupData[]): ArrayBuffer[] {
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
    add(group.types);
    add(group.geometry.types);
    add(group.geometry.offsets);
    for (const child of group.geometry.children) {
      add(child.coords);
      for (const offsets of child.offsets ?? []) add(offsets);
    }
    addColumn(group.itemKeys);
    addColumn(group.memberKeys);
    add(group.groups);
    add(group.flags);
    add(group.styles);
    addColumn(group.styleDictionary);
    for (const column of group.properties.columns) {
      add(column.rows);
      add(column.tags);
      add(column.numbers);
      add(column.refs);
      addColumn(column.values);
    }
    add(group.rowBounds);
    add(group.triangles.offsets);
    add(group.triangles.indices);
    add(group.triangles.wideRows);
    add(group.triangles.wideOffsets);
    add(group.triangles.wideIndices);
    add(group.index.boxes);
    add(group.index.indices);
    add(group.index.levelBounds);
  }
  return [...buffers];
}

// === Building one group ===

/** The coordinates and offsets of one child column of a group, as it is filled */
class ChildBuilder {
  coords: number[] = [];
  level0: number[] = [0];
  level1: number[] = [0];
  level2: number[] = [0];
  rows = 0;

  constructor(readonly type: GeometryType) {}

  /** Adds the geometry of a row; returns its row in the child */
  add(geometry: RowGeometry): number {
    for (let k = 0; k < geometry.coords.length; k++) this.coords.push(geometry.coords[k]);
    const vertices = this.coords.length / 2;
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

  finish(): TableGeometry {
    const coords = Float64Array.from(this.coords);
    switch (this.type) {
      case 'Point':
        return { type: 'Point', coords };
      case 'LineString':
      case 'MultiPoint':
        return { type: this.type, coords, offsets: [Int32Array.from(this.level0)] };
      case 'Polygon':
      case 'MultiLineString':
        return {
          type: this.type,
          coords,
          offsets: [Int32Array.from(this.level0), Int32Array.from(this.level1)],
        };
      case 'MultiPolygon':
        return {
          type: 'MultiPolygon',
          coords,
          offsets: [
            Int32Array.from(this.level0),
            Int32Array.from(this.level1),
            Int32Array.from(this.level2),
          ],
        };
    }
  }
}

/** Builds one group from its rows in order (`order` holds the indices of the rows added) */
function buildGroup(
  order: Int32Array,
  keys: RowKeySource,
  rows: readonly RowInput[],
  geometries: ReadonlyArray<RowGeometry | null>,
  styleRefs: Int32Array,
  dictionary: Utf8Column,
): RowGroupData {
  const length = order.length;
  const ids = new Utf8ColumnBuilder(length);
  const itemKeys = new Utf8ColumnBuilder(length);
  const memberKeys = new Utf8ColumnBuilder(length);
  const idHashes = new Uint32Array(length);
  const types = new Uint8Array(length);
  const typeNames: string[] = [];
  const typeIndex = new Map<string, number>();
  const groups = new Int32Array(length);
  const flags = new Uint8Array(length);
  const styles = new Uint32Array(length);
  const localStyles = new Map<number, number>();
  const styleDictionary = new Utf8ColumnBuilder(8);
  const childTypes = new Int8Array(length);
  const childRows = new Int32Array(length);
  const children: ChildBuilder[] = [];
  const childIndex = new Map<GeometryType, number>();
  const rowBounds = new Float64Array(length * 4);
  const triangles = new TriangleWriter(length);
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

    let type = typeIndex.get(row.type);
    if (type === undefined) {
      if (typeNames.length >= 255) throw new Error('RowGroupBuilder: more than 255 types');
      type = typeNames.length;
      typeNames.push(row.type);
      typeIndex.set(row.type, type);
    }
    types[r] = type;

    flags[r] =
      (row.visible === false ? 0 : ROW_FLAG_VISIBLE) |
      (row.locked === true ? ROW_FLAG_LOCKED : 0) |
      (row.deleted === true ? ROW_FLAG_DELETED : 0);

    const global = styleRefs[source];
    let local = localStyles.get(global);
    if (local === undefined) {
      local = localStyles.size;
      localStyles.set(global, local);
      styleDictionary.addEntry(dictionary, global);
    }
    styles[r] = local;

    const properties = row.properties;
    if (properties) {
      for (const key of Object.keys(properties)) {
        let builder = propertyBuilders.get(key);
        if (!builder) {
          builder = new ValueColumnBuilder(length);
          propertyBuilders.set(key, builder);
        }
        builder.set(r, properties[key]);
      }
    }

    const geometry = geometries[source];
    if (!geometry) {
      childTypes[r] = -1;
      setNaNBounds(rowBounds, r);
      triangles.skip(r);
      continue;
    }
    let child = childIndex.get(geometry.type);
    if (child === undefined) {
      child = children.length;
      children.push(new ChildBuilder(geometry.type));
      childIndex.set(geometry.type, child);
    }
    childTypes[r] = child;
    childRows[r] = children[child].add(geometry);
    vertexCount += vertexCountOf(row, geometry);

    const circle = circleRing(row, geometry);
    if (circle) {
      writeBounds(rowBounds, r, circle, 0, circle.length / 2);
      triangles.polygonRow(r, circle, new Int32Array([0, circle.length / 2]), [[0, 1]]);
    } else {
      writeBounds(rowBounds, r, geometry.coords, 0, geometry.coords.length / 2);
      if (geometry.type === 'Polygon' || geometry.type === 'MultiPolygon') {
        triangles.polygonRow(r, geometry.coords, ringOffsetsOf(geometry), polygonRanges(geometry));
      } else {
        triangles.skip(r);
      }
    }
  }

  const keysOfProperties = [...propertyBuilders.keys()];
  const columns: ValueColumn[] = keysOfProperties.map((key) =>
    (propertyBuilders.get(key) as ValueColumnBuilder).finish(),
  );
  const geometry: TableMixedGeometry = {
    type: 'Mixed',
    types: childTypes,
    offsets: childRows,
    children: children.map((child) => child.finish()),
  };

  return {
    length,
    handles: new Int32Array(length).fill(-1),
    ids: ids.finish(),
    idHashes,
    types,
    typeNames,
    geometry,
    itemKeys: itemKeys.finish(),
    memberKeys: memberKeys.finish(),
    groups,
    flags,
    styles,
    styleDictionary: styleDictionary.finish(),
    properties: { keys: keysOfProperties, columns },
    rowBounds,
    triangles: triangles.finish(),
    index: buildPackedRTree(rowBounds),
    vertexCount,
  };
}

/** The offsets from a ring to its first coordinate, over every ring of a polygon geometry */
function ringOffsetsOf(geometry: RowGeometry): Int32Array {
  const offsets = new Int32Array(geometry.parts.length + 1);
  for (let i = 0; i < geometry.parts.length; i++) offsets[i + 1] = offsets[i] + geometry.parts[i];
  return offsets;
}

/** The rings of each polygon of a polygon geometry, as `[first ring, end ring)` */
function polygonRanges(geometry: RowGeometry): Array<[number, number]> {
  if (geometry.type === 'Polygon') return [[0, geometry.parts.length]];
  const out: Array<[number, number]> = [];
  let ring = 0;
  for (const count of geometry.polygons) {
    out.push([ring, ring + count]);
    ring += count;
  }
  return out;
}

/** The coordinates of the ring of a Circle, or null for any other row */
function circleRing(row: RowInput, geometry: RowGeometry): Float64Array | null {
  if (row.type !== 'Circle' || geometry.type !== 'Point') return null;
  const radius = readDrawProperty(row.properties, 'radiusMeters');
  if (!radius || radius <= 0) return null;
  const ring = generateCirclePolygon([geometry.coords[0], geometry.coords[1]], radius);
  if (ring.length === 0) return null;
  const coords = new Float64Array(ring.length * 2);
  for (let i = 0; i < ring.length; i++) {
    coords[i * 2] = ring[i][0];
    coords[i * 2 + 1] = ring[i][1];
  }
  return coords;
}

/** The number of coordinates a row draws (the estimate of the work of a group) */
function vertexCountOf(row: RowInput, geometry: RowGeometry | null): number {
  if (!geometry) return 0;
  if (row.type === 'Circle' && geometry.type === 'Point') {
    const ring = circleRing(row, geometry);
    return ring ? ring.length / 2 : 1;
  }
  return geometry.coords.length / 2;
}

/** Writes the bbox of the coordinates `[from, to)` (NaN when there is none or one is NaN) */
function writeBounds(
  bounds: Float64Array,
  row: number,
  coords: Float64Array,
  from: number,
  to: number,
): void {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (let v = from; v < to; v++) {
    const x = coords[v * 2];
    const y = coords[v * 2 + 1];
    if (Number.isNaN(x) || Number.isNaN(y)) {
      setNaNBounds(bounds, row);
      return;
    }
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  if (minX === Number.POSITIVE_INFINITY) {
    setNaNBounds(bounds, row);
    return;
  }
  bounds[row * 4] = minX;
  bounds[row * 4 + 1] = minY;
  bounds[row * 4 + 2] = maxX;
  bounds[row * 4 + 3] = maxY;
}

function setNaNBounds(bounds: Float64Array, row: number): void {
  bounds.fill(Number.NaN, row * 4, row * 4 + 4);
}

/** Writes the triangles of the fills of the rows of a group */
class TriangleWriter {
  private readonly offsets: Int32Array;
  private indices: number[] = [];
  private readonly wideRows: number[] = [];
  private readonly wideOffsets: number[] = [0];
  private wideIndices: number[] = [];
  private readonly runs: number[] = [];

  constructor(length: number) {
    this.offsets = new Int32Array(length + 1);
  }

  /** A row without a fill */
  skip(row: number): void {
    this.offsets[row + 1] = this.indices.length;
  }

  /**
   * The triangles of the polygons of a row
   *
   * @param ringOffsets The offsets from a ring to its first coordinate
   * @param polygons The rings of each polygon, `[first, end)`
   */
  polygonRow(
    row: number,
    coords: Float64Array,
    ringOffsets: Int32Array,
    polygons: ReadonlyArray<readonly [number, number]>,
  ): void {
    const out: number[] = [];
    let base = 0;
    for (const [ringStart, ringEnd] of polygons) {
      const runs = this.runs;
      runs.length = 0;
      const count = polygonRingRuns(coords, 2, ringOffsets, ringStart, ringEnd, runs);
      if (count === 0) continue;
      const flat: number[] = new Array(count * 2);
      const holes: number[] = [];
      let at = 0;
      for (let k = 0; k < runs.length; k += 2) {
        if (k > 0) holes.push(at);
        for (let v = runs[k]; v < runs[k + 1]; v++) {
          flat[at * 2] = coords[v * 2];
          flat[at * 2 + 1] = coords[v * 2 + 1];
          at++;
        }
      }
      for (const index of earcut(flat, holes)) out.push(index + base);
      base += count;
    }
    if (base >= WIDE_VERTICES) {
      this.wideRows.push(row);
      for (const index of out) this.wideIndices.push(index);
      this.wideOffsets.push(this.wideIndices.length);
    } else {
      for (const index of out) this.indices.push(index);
    }
    this.offsets[row + 1] = this.indices.length;
  }

  finish(): TriangleCache {
    return {
      offsets: this.offsets,
      indices: Uint16Array.from(this.indices),
      wideRows: Int32Array.from(this.wideRows),
      wideOffsets: Int32Array.from(this.wideOffsets),
      wideIndices: Uint32Array.from(this.wideIndices),
    };
  }
}

// === Styles ===

/** Shares the canonical bytes of the styles of the rows (one entry per distinct style) */
class StyleInterner {
  private readonly column = new Utf8ColumnBuilder(16);
  private readonly entries: Uint8Array[] = [];
  private readonly buckets = new Map<number, number[]>();
  private readonly byObject = new WeakMap<object, number>();

  intern(style: Readonly<Record<string, unknown>>): number {
    const known = this.byObject.get(style);
    if (known !== undefined) return known;
    const bytes = encodeCanonicalValue(style);
    const hash = hashByteRun(bytes, 0, bytes.length);
    let bucket = this.buckets.get(hash);
    if (bucket) {
      for (const entry of bucket) {
        if (sameBytes(this.entries[entry], bytes)) {
          this.byObject.set(style, entry);
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
    this.byObject.set(style, entry);
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

/** The keys of the groups of the options, by handle */
function groupKeySource(groups: readonly RowGroupKey[]): GroupKeySource | null {
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

/** The geometry of a row as the builder keeps it */
function toRowGeometry(geometry: Geometry): RowGeometry {
  const positions: number[] = [];
  const push = (position: Position): void => {
    positions.push(Number(position[0]), Number(position[1]));
  };
  const parts: number[] = [];
  const polygons: number[] = [];
  switch (geometry.type) {
    case 'Point':
      push(geometry.coordinates);
      break;
    case 'LineString':
    case 'MultiPoint':
      for (const position of geometry.coordinates) push(position);
      break;
    case 'Polygon':
    case 'MultiLineString':
      for (const ring of geometry.coordinates) {
        for (const position of ring) push(position);
        parts.push(ring.length);
      }
      break;
    case 'MultiPolygon':
      for (const polygon of geometry.coordinates) {
        for (const ring of polygon) {
          for (const position of ring) push(position);
          parts.push(ring.length);
        }
        polygons.push(polygon.length);
      }
      break;
    default:
      throw new Error(`RowGroupBuilder: a ${geometry.type} geometry cannot be a row`);
  }
  return { type: geometry.type, coords: Float64Array.from(positions), parts, polygons };
}

function growInt32(array: Int32Array, length: number): Int32Array {
  let size = array.length * 2;
  while (size < length) size *= 2;
  const next = new Int32Array(size);
  next.set(array);
  return next;
}
