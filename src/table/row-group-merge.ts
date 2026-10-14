// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Merges rows of row groups into new row groups (`mergeRowBlock`)
 *
 * The next version of a row group is the rows of the group that stay, and the rows that come into
 * its range, in the order of the layer. Both are rows of groups already built: the rows of the
 * group itself, and rows built on their own (the rows changed since). The merge copies their
 * columns as they are, so nothing is computed again for a row that did not change: its
 * triangles are copied from the cache of its group (earcut runs only where a row was built), its
 * bbox is copied, its attributes are copied as their bytes (no value is decoded and written
 * again), and only the spatial index of the new groups is built. A merge too large for
 * one group is cut into groups of the target sizes at once.
 *
 * The rows of the sources must hold the numbers of the table of styles of the document (a group
 * built in a Worker gets them when it is taken in), so a merge keeps the numbers as they are.
 *
 * A pure module: it depends on nothing outside `/table`, so it runs in a Worker as well, the
 * same function the main thread runs.
 */

import { DrawError } from '../shared/draw-error.js';
import {
  type CoordinateDimensions,
  type CoordinateSystem,
  dimsWithin,
  planarCoordinates,
  sortKeyOf,
} from './coordinates.js';
import { buildPackedRTree } from './packed-rtree.js';
import { rowGeometryOfColumn, WIDE_VERTICES } from './row-geometry.js';
import {
  ChildBuilder,
  type GroupEntry,
  groupKeySource,
  ROW_BLOCK_TARGET_ROWS,
  ROW_BLOCK_TARGET_VERTICES,
} from './row-group-builder.js';
import type { RowBlock, RowBlockData, TriangleCache } from './row-group-types.js';
import { compareRowKeys, type GroupKeySource } from './row-keys.js';
import type { GeometryType, TableMixedGeometry } from './types.js';
import { Utf8ColumnBuilder } from './utf8-column.js';
import {
  VALUE_ABSENT,
  type ValueColumn,
  ValueColumnBuilder,
  valueEntryOf,
} from './value-column.js';

/**
 * What {@link mergeRowBlock} merges
 */
export interface RowBlockMerge {
  /** The blocks the rows are taken from (their styles numbered: no `styleDictionary`) */
  readonly sources: readonly RowBlock[];
  /**
   * The rows taken, two numbers each: the source and the row there (`[source, row, ...]`). A row
   * is taken once
   */
  readonly rows: Int32Array;
  /** The groups of features the rows name (their keys order their members) */
  readonly groups?: readonly GroupEntry[] | null;
  /** Whether the rows are put in the order of the layer (true when omitted) */
  readonly sort?: boolean;
  /** The target number of rows of a block ({@link ROW_BLOCK_TARGET_ROWS} when omitted) */
  readonly targetRows?: number;
  /** The target number of coordinates of a block ({@link ROW_BLOCK_TARGET_VERTICES} when omitted) */
  readonly targetVertices?: number;
  /**
   * The share of the targets past which the rows are cut into blocks of the target sizes (1 when
   * omitted: cut at the targets). The next version of a block is cut only past twice the targets
   * (2), so a block that grew a little stays one block
   */
  readonly cutPast?: number;
  /**
   * The dimensions of the coordinates of the new blocks: those of the layer. A source of fewer
   * dimensions is copied with NaN for the others (a layer whose dimensions were raised). Every
   * source has the same when omitted
   */
  readonly dimensions?: CoordinateDimensions;
  /**
   * The number of coordinates a row that draws a ring around its point (a row of a Point with a
   * fill: a Circle) is counted as when the rows are cut into blocks (`RowRings.ringVertices`; 1
   * when omitted)
   */
  readonly ringVertices?: number;
  /**
   * The system of the coordinates the spatial index of the new blocks is made in (the plane when
   * omitted). A function: a Worker passes its own
   */
  readonly coordinateSystem?: CoordinateSystem;
}

/**
 * What the tables merge: blocks with every column, and the groups of features as the tables
 * read them
 *
 * @internal
 */
export interface RowBlockDataMerge extends Omit<RowBlockMerge, 'sources' | 'groups'> {
  readonly sources: readonly RowBlockData[];
  readonly groups?: readonly GroupEntry[] | GroupKeySource | null;
}

/**
 * Merges rows of blocks into new blocks, in the order of the layer
 *
 * @returns The new blocks (none for no row); their handles are those of the rows
 * @throws `DrawError` with the code `invalid-input` when a source holds styles not numbered yet,
 *   or `not-found` when a row names a group of features the keys do not give
 */
export function mergeRowBlock(merge: RowBlockMerge): RowBlock[] {
  return mergeRowBlockData(merge as RowBlockDataMerge);
}

/**
 * Merges rows of blocks into new blocks, as the tables merge them
 *
 * @internal
 */
export function mergeRowBlockData(merge: RowBlockDataMerge): RowBlockData[] {
  const { sources, rows } = merge;
  for (const source of sources) {
    if (source.styleDictionary) {
      throw new DrawError(
        'invalid-input',
        'mergeRowBlock: the styles of a source are not numbered',
      );
    }
  }
  const count = rows.length / 2;
  if (count === 0) return [];
  const dims = mergeDims(sources, merge.dimensions);
  const shape: MergeShape = {
    dims,
    ringVertices: merge.ringVertices ?? 1,
    sortKey: sortKeyOf(merge.coordinateSystem ?? planarCoordinates),
  };
  const keys = isKeySource(merge.groups)
    ? merge.groups
    : groupKeySource((merge.groups as readonly GroupEntry[] | null | undefined) ?? []);
  // The rows in the order of the layer
  const order = new Int32Array(count);
  for (let i = 0; i < count; i++) order[i] = i;
  if (merge.sort !== false) {
    order.sort((a, b) =>
      compareRowKeys(
        sources[rows[a * 2]],
        rows[a * 2 + 1],
        sources[rows[b * 2]],
        rows[b * 2 + 1],
        keys,
      ),
    );
  }
  const vertices = new Int32Array(count);
  let total = 0;
  for (let i = 0; i < count; i++) {
    vertices[i] = vertexCountOf(sources[rows[i * 2]], rows[i * 2 + 1], shape.ringVertices);
    total += vertices[i];
  }
  const targetRows = Math.max(1, merge.targetRows ?? ROW_BLOCK_TARGET_ROWS);
  const targetVertices = Math.max(1, merge.targetVertices ?? ROW_BLOCK_TARGET_VERTICES);
  const past = Math.max(1, merge.cutPast ?? 1);
  // One group while the rows are within the targets times the share
  if (count <= targetRows * past && total <= targetVertices * past) {
    return [copyRows(sources, rows, order, vertices, shape)];
  }
  const out: RowBlockData[] = [];
  let start = 0;
  while (start < count) {
    let end = start;
    let sum = 0;
    while (end < count && end - start < targetRows) {
      const n = vertices[order[end]];
      if (end > start && sum + n > targetVertices) break;
      sum += n;
      end++;
    }
    out.push(copyRows(sources, rows, order.subarray(start, end), vertices, shape));
    start = end;
  }
  return out;
}

/** What the new groups of a merge are made of */
interface MergeShape {
  readonly dims: CoordinateDimensions;
  readonly ringVertices: number;
  readonly sortKey: ((centerX: number, centerY: number) => number) | undefined;
}

/**
 * The dimensions of the new groups of a merge: the ones given, which hold those of every source,
 * or the ones every source has
 *
 * @throws when a source has a dimension the ones given do not, or when the sources have
 *   different ones and none are given
 */
function mergeDims(
  sources: readonly RowBlockData[],
  given: CoordinateDimensions | undefined,
): CoordinateDimensions {
  let dims = given;
  for (const source of sources) {
    for (const child of source.geometry.children) {
      const own = child.dimensions ?? 'xy';
      if (dims === undefined) dims = own;
      else if (given === undefined ? own !== dims : !dimsWithin(own, dims)) {
        throw new DrawError(
          'invalid-input',
          `mergeRowBlock: a source has coordinates of ${own}, the merge ${given === undefined ? 'has' : 'makes'} ${dims}`,
        );
      }
    }
  }
  return dims ?? 'xy';
}

/** Whether the groups of a merge are given as the keys themselves */
function isKeySource(groups: RowBlockDataMerge['groups']): groups is GroupKeySource {
  return groups !== null && groups !== undefined && !Array.isArray(groups);
}

/**
 * The number of coordinates a row draws (the estimate of the work of a group): a Point with a
 * fill draws a ring around it
 */
function vertexCountOf(data: RowBlockData, row: number, ringVertices: number): number {
  const child = data.geometry.types[row];
  if (child < 0) return 0;
  const column = data.geometry.children[child];
  const at = data.geometry.offsets[row];
  if (column.type === 'Point') {
    const t = data.triangles;
    return t.offsets[row + 1] > t.offsets[row] ? ringVertices : 1;
  }
  let first = at;
  let end = at + 1;
  for (const level of column.offsets ?? []) {
    first = level[first];
    end = level[end];
  }
  return end - first;
}

/** The triangles of a row in the cache of its group */
function trianglesOf(cache: TriangleCache, row: number): Uint16Array | Uint32Array {
  const start = cache.offsets[row];
  const end = cache.offsets[row + 1];
  if (end > start) return cache.indices.subarray(start, end);
  let lo = 0;
  let hi = cache.wideRows.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cache.wideRows[mid] === row) {
      return cache.wideIndices.subarray(cache.wideOffsets[mid], cache.wideOffsets[mid + 1]);
    }
    if (cache.wideRows[mid] < row) lo = mid + 1;
    else hi = mid - 1;
  }
  return cache.indices.subarray(start, start);
}

/** Copies the rows `order` (indices into the pairs of `rows`) into one group */
function copyRows(
  sources: readonly RowBlockData[],
  rows: Int32Array,
  order: Int32Array,
  vertices: Int32Array,
  shape: MergeShape,
): RowBlockData {
  const length = order.length;
  const handles = new Int32Array(length);
  const ids = new Utf8ColumnBuilder(length);
  const idHashes = new Uint32Array(length);
  const itemKeys = new Utf8ColumnBuilder(length);
  const memberKeys = new Utf8ColumnBuilder(length);
  const types = new Uint8Array(length);
  const typeNames: string[] = [];
  const typeIndex = new Map<string, number>();
  const groups = new Int32Array(length);
  const flags = new Uint8Array(length);
  const styles = new Uint32Array(length);
  const childTypes = new Int8Array(length);
  const childRows = new Int32Array(length);
  const children: ChildBuilder[] = [];
  const childIndex = new Map<GeometryType, number>();
  const rowBounds = new Float64Array(length * 4);
  const triangleOffsets = new Int32Array(length + 1);
  const narrow: number[] = [];
  const wideRows: number[] = [];
  const wideOffsets: number[] = [0];
  const wide: number[] = [];
  const builders = new Map<string, ValueColumnBuilder>();
  let vertexCount = 0;

  for (let r = 0; r < length; r++) {
    const pair = order[r];
    const data = sources[rows[pair * 2]];
    const row = rows[pair * 2 + 1];
    handles[r] = data.handles[row];
    ids.addEntry(data.ids, row);
    idHashes[r] = data.idHashes[row];
    itemKeys.addEntry(data.itemKeys, row);
    memberKeys.addEntry(data.memberKeys, row);
    groups[r] = data.groups[row];
    flags[r] = data.flags[row];
    styles[r] = data.styles[row];
    const typeName = data.typeNames[data.types[row]];
    let type = typeIndex.get(typeName);
    if (type === undefined) {
      if (typeNames.length >= 255)
        throw new DrawError('invalid-input', 'mergeRowBlock: more than 255 types');
      type = typeNames.length;
      typeNames.push(typeName);
      typeIndex.set(typeName, type);
    }
    types[r] = type;

    // The attributes, by key, copied as their bytes (no value is decoded)
    const { keys, columns } = data.properties;
    for (let k = 0; k < keys.length; k++) {
      const column = columns[k] as ValueColumn;
      const entry = valueEntryOf(column, row);
      if (entry < 0 || column.tags[entry] === VALUE_ABSENT) continue;
      let builder = builders.get(keys[k]);
      if (!builder) {
        builder = new ValueColumnBuilder(length);
        builders.set(keys[k], builder);
      }
      builder.copy(r, column, entry);
    }

    for (let k = 0; k < 4; k++) rowBounds[r * 4 + k] = data.rowBounds[row * 4 + k];
    const triangles = trianglesOf(data.triangles, row);
    let max = -1;
    for (const index of triangles) if (index > max) max = index;
    if (max >= WIDE_VERTICES || triangles instanceof Uint32Array) {
      if (triangles.length > 0) {
        wideRows.push(r);
        for (const index of triangles) wide.push(index);
        wideOffsets.push(wide.length);
      }
    } else {
      for (const index of triangles) narrow.push(index);
    }
    triangleOffsets[r + 1] = narrow.length;

    const child = data.geometry.types[row];
    if (child < 0) {
      childTypes[r] = -1;
      continue;
    }
    const column = data.geometry.children[child];
    let target = childIndex.get(column.type);
    if (target === undefined) {
      target = children.length;
      children.push(new ChildBuilder(column.type, shape.dims));
      childIndex.set(column.type, target);
    }
    childTypes[r] = target;
    childRows[r] = children[target].add(
      rowGeometryOfColumn(column, data.geometry.offsets[row], shape.dims),
    );
    vertexCount += vertices[pair];
  }

  const propertyKeys = [...builders.keys()];
  const geometry: TableMixedGeometry = {
    type: 'Mixed',
    types: childTypes,
    offsets: childRows,
    children: children.map((child) => child.finish()),
  };
  return {
    length,
    handles,
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
    styleDictionary: null,
    properties: {
      keys: propertyKeys,
      columns: propertyKeys.map((key) => (builders.get(key) as ValueColumnBuilder).finish()),
    },
    rowBounds,
    triangles: {
      offsets: triangleOffsets,
      indices: Uint16Array.from(narrow),
      wideRows: Int32Array.from(wideRows),
      wideOffsets: Int32Array.from(wideOffsets),
      wideIndices: Uint32Array.from(wide),
    },
    index: buildPackedRTree(rowBounds, undefined, shape.sortKey),
    vertexCount,
  };
}
