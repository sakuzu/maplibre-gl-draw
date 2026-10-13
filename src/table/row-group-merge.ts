// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Merges rows of row groups into new row groups (`mergeRowGroup`)
 *
 * The next version of a row group is the rows of the group that stay, and the rows that come into
 * its range, in the order of the layer. Both are rows of groups already built: the rows of the
 * group itself, and rows built on their own (the rows changed since). The merge copies their
 * columns as they are, so nothing is computed again for a row that did not change: its
 * triangles are copied from the cache of its group (earcut runs only where a row was built), its
 * bbox is copied, and only the spatial index of the new groups is built. A merge too large for
 * one group is cut into groups of the target sizes at once.
 *
 * The rows of the sources must hold the numbers of the table of styles of the document (a group
 * built in a Worker gets them when it is taken in), so a merge keeps the numbers as they are.
 *
 * A pure module: it depends on nothing outside `/table`, so it runs in a Worker as well, the
 * same function the main thread runs.
 */

import { buildPackedRTree } from './packed-rtree.js';
import { rowGeometryOfColumn, WIDE_VERTICES } from './row-geometry.js';
import {
  ChildBuilder,
  groupKeySource,
  ROW_GROUP_TARGET_ROWS,
  ROW_GROUP_TARGET_VERTICES,
  type RowGroupKey,
} from './row-group-builder.js';
import type { RowGroupData, TriangleCache } from './row-group-types.js';
import { compareRowKeys, type GroupKeySource } from './row-keys.js';
import type { GeometryType, TableMixedGeometry } from './types.js';
import { Utf8ColumnBuilder } from './utf8-column.js';
import { readValue, type ValueColumn, ValueColumnBuilder } from './value-column.js';

/** The number of coordinates a Circle is counted as (its ring) */
const CIRCLE_VERTICES = 65;

/**
 * What {@link mergeRowGroup} merges
 */
export interface RowGroupMerge {
  /** The groups the rows are taken from (their styles numbered: no `styleDictionary`) */
  readonly sources: readonly RowGroupData[];
  /**
   * The rows taken, two numbers each: the source and the row there (`[source, row, ...]`). A row
   * is taken once
   */
  readonly rows: Int32Array;
  /** The groups of features the rows name (their keys order their members) */
  readonly groups?: readonly RowGroupKey[] | GroupKeySource | null;
  /** Whether the rows are put in the order of the layer (true when omitted) */
  readonly sort?: boolean;
  /** The target number of rows of a group ({@link ROW_GROUP_TARGET_ROWS} when omitted) */
  readonly targetRows?: number;
  /** The target number of coordinates of a group ({@link ROW_GROUP_TARGET_VERTICES} when omitted) */
  readonly targetVertices?: number;
  /**
   * The share of the targets past which the rows are cut into groups of the target sizes (1 when
   * omitted: cut at the targets). The next version of a group is cut only past twice the targets
   * (2), so a group that grew a little stays one group
   */
  readonly cutPast?: number;
}

/**
 * Merges rows of row groups into new row groups, in the order of the layer
 *
 * @returns The new groups (none for no row); their handles are those of the rows
 * @throws when a source holds styles not numbered yet, or when a row names a group of features
 *   the keys do not give
 */
export function mergeRowGroup(merge: RowGroupMerge): RowGroupData[] {
  const { sources, rows } = merge;
  for (const source of sources) {
    if (source.styleDictionary) {
      throw new Error('mergeRowGroup: the styles of a source are not numbered');
    }
  }
  const count = rows.length / 2;
  if (count === 0) return [];
  const keys = isKeySource(merge.groups)
    ? merge.groups
    : groupKeySource((merge.groups as readonly RowGroupKey[] | null | undefined) ?? []);
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
    vertices[i] = vertexCountOf(sources[rows[i * 2]], rows[i * 2 + 1]);
    total += vertices[i];
  }
  const targetRows = Math.max(1, merge.targetRows ?? ROW_GROUP_TARGET_ROWS);
  const targetVertices = Math.max(1, merge.targetVertices ?? ROW_GROUP_TARGET_VERTICES);
  const past = Math.max(1, merge.cutPast ?? 1);
  // One group while the rows are within the targets times the share
  if (count <= targetRows * past && total <= targetVertices * past) {
    return [copyRows(sources, rows, order, vertices)];
  }
  const out: RowGroupData[] = [];
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
    out.push(copyRows(sources, rows, order.subarray(start, end), vertices));
    start = end;
  }
  return out;
}

/** Whether the groups of a merge are given as the keys themselves */
function isKeySource(groups: RowGroupMerge['groups']): groups is GroupKeySource {
  return groups !== null && groups !== undefined && !Array.isArray(groups);
}

/** The number of coordinates a row draws (the estimate of the work of a group) */
function vertexCountOf(data: RowGroupData, row: number): number {
  const child = data.geometry.types[row];
  if (child < 0) return 0;
  const column = data.geometry.children[child];
  const at = data.geometry.offsets[row];
  if (data.typeNames[data.types[row]] === 'Circle' && column.type === 'Point') {
    const t = data.triangles;
    return t.offsets[row + 1] > t.offsets[row] ? CIRCLE_VERTICES : 1;
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
  sources: readonly RowGroupData[],
  rows: Int32Array,
  order: Int32Array,
  vertices: Int32Array,
): RowGroupData {
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
      if (typeNames.length >= 255) throw new Error('mergeRowGroup: more than 255 types');
      type = typeNames.length;
      typeNames.push(typeName);
      typeIndex.set(typeName, type);
    }
    types[r] = type;

    // The attributes, by key
    const { keys, columns } = data.properties;
    for (let k = 0; k < keys.length; k++) {
      const value = readValue(columns[k] as ValueColumn, row);
      if (value === undefined) continue;
      let builder = builders.get(keys[k]);
      if (!builder) {
        builder = new ValueColumnBuilder(length);
        builders.set(keys[k], builder);
      }
      builder.set(r, value);
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
      children.push(new ChildBuilder(column.type));
      childIndex.set(column.type, target);
    }
    childTypes[r] = target;
    childRows[r] = children[target].add(rowGeometryOfColumn(column, data.geometry.offsets[row]));
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
    index: buildPackedRTree(rowBounds),
    vertexCount,
  };
}
