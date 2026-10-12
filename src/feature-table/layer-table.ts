// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The rows of one layer held as columns (`LayerTable`)
 *
 * A layer holds its rows as row groups in the order of the layer: the rows of a group are in the
 * order of their keys, and every row of a group comes before every row of the next group. A
 * group is never changed in its shape once it is in the layer; its handle names it in the order,
 * so the place of a row is its group and its row there.
 *
 * A place in the order of the layer (`TablePosition`) is a group and a slot: the slot of row `r`
 * is `2r + 1`, the slot of what is drawn just before row `p` is `2p`, and `k` orders the things
 * at the same slot. The slots of a group never change while it is in the layer, so a place found
 * once keeps its meaning until the group is replaced.
 */

import type { BoundingBox } from '../shared/types/model.js';
import type { RowGroupData } from '../table/row-group-types.js';
import { compareRowKeys, type GroupKeySource, type RowKeySource } from '../table/row-keys.js';
import { GeometryColumnReader } from '../table/table.js';
import type { RowGroupHandle } from './types.js';

/**
 * A row group as a layer holds it
 *
 * @internal
 */
export interface RowGroup {
  /** The handle of the group */
  readonly handle: RowGroupHandle;
  /** The columns of the rows */
  readonly data: RowGroupData;
  /** The copy of the state of each row (`row-state.ts`) */
  readonly state: Uint16Array;
  /** The byte of the state of each row the GPU reads */
  readonly gpuState: Uint8Array;
  /** Changes with every change of the state of a row of the group */
  stateVersion: number;
  /** The union of the bboxes of the rows (null when no row has a geometry) */
  readonly bounds: BoundingBox | null;
  /** The column of each attribute key */
  readonly propertyIndex: ReadonlyMap<string, number>;
  /** The reader of each geometry column of the group (made on the first read) */
  readers: GeometryColumnReader[] | null;
}

/**
 * A place in the order of a layer
 */
export interface TablePosition {
  /** The row group */
  readonly group: RowGroupHandle;
  /** `2r + 1` for row `r` of the group, `2p` for what comes just before row `p` */
  readonly slot: number;
  /** The order of the things at the same slot */
  readonly k: number;
}

/**
 * Makes the row group of a layer for its columns
 *
 * @internal
 */
export function createRowGroup(handle: RowGroupHandle, data: RowGroupData): RowGroup {
  return {
    handle,
    data,
    state: new Uint16Array(data.length),
    gpuState: new Uint8Array(data.length),
    stateVersion: 0,
    bounds: unionOfRows(data.rowBounds),
    propertyIndex: new Map(data.properties.keys.map((key, i) => [key, i])),
    readers: null,
  };
}

/**
 * The geometry column of a row (undefined for a row without a geometry)
 *
 * @internal
 */
export function geometryReaderOf(group: RowGroup, row: number): GeometryColumnReader | undefined {
  const child = group.data.geometry.types[row];
  if (child < 0) return undefined;
  group.readers ??= group.data.geometry.children.map(
    (column, k) => new GeometryColumnReader(column, undefined, `geometry.children[${k}]`),
  );
  return group.readers[child];
}

/**
 * The rows of one layer
 *
 * @internal
 */
export class LayerTable {
  private readonly order: RowGroupHandle[] = [];
  private readonly groups = new Map<RowGroupHandle, RowGroup>();
  private readonly indexOf = new Map<RowGroupHandle, number>();
  private rows = 0;
  private revision = 0;

  /**
   * @param layerId The layer
   * @param groupKeys The keys of the groups of features the rows name
   */
  constructor(
    readonly layerId: string,
    private readonly groupKeys: GroupKeySource,
  ) {}

  /** The number of rows */
  get rowCount(): number {
    return this.rows;
  }

  /** The number of row groups */
  get groupCount(): number {
    return this.order.length;
  }

  /** Changes with every row group added or taken out */
  get structureRevision(): number {
    return this.revision;
  }

  /** The handles of the row groups, in the order of the layer */
  get groupHandles(): readonly RowGroupHandle[] {
    return this.order;
  }

  /** The row group at a place of the order */
  groupAt(index: number): RowGroup {
    return this.groups.get(this.order[index]) as RowGroup;
  }

  /** A row group by handle */
  group(handle: RowGroupHandle): RowGroup | undefined {
    return this.groups.get(handle);
  }

  /** The place of a row group in the order (-1 when it is not in the layer) */
  orderOf(handle: RowGroupHandle): number {
    return this.indexOf.get(handle) ?? -1;
  }

  /**
   * Puts a row group at its place in the order (the order of its first row)
   *
   * @throws when the keys of its rows overlap the keys of the rows of another group, or when
   *   its rows are not in the order of their keys
   */
  insert(group: RowGroup): void {
    const data = group.data;
    if (data.length === 0) throw new Error('LayerTable: an empty row group');
    for (let r = 1; r < data.length; r++) {
      if (compareRowKeys(data, r - 1, data, r, this.groupKeys) >= 0) {
        throw new Error('LayerTable: the rows of a group are not in the order of their keys');
      }
    }
    // The number of groups whose first row comes before the first row of the new group
    let lo = 0;
    let hi = this.order.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const other = this.groupAt(mid).data;
      if (compareRowKeys(other, 0, data, 0, this.groupKeys) < 0) lo = mid + 1;
      else hi = mid;
    }
    const before = lo > 0 ? this.groupAt(lo - 1).data : null;
    const after = lo < this.order.length ? this.groupAt(lo).data : null;
    if (before && compareRowKeys(before, before.length - 1, data, 0, this.groupKeys) >= 0) {
      throw new Error('LayerTable: the rows of a group overlap the rows of the group before it');
    }
    if (after && compareRowKeys(data, data.length - 1, after, 0, this.groupKeys) >= 0) {
      throw new Error('LayerTable: the rows of a group overlap the rows of the group after it');
    }
    this.order.splice(lo, 0, group.handle);
    this.groups.set(group.handle, group);
    this.rows += data.length;
    this.reindex();
    this.revision++;
  }

  /**
   * The place in the order of a key: the slot just before the first row that does not come
   * before it, or the row itself when a row has the same keys
   *
   * @param keys The columns the key is read from
   * @param row The entry of the key in them
   * @param k The order of the things at the same slot
   * @returns The place, or null when the layer has no row
   */
  positionOfKey(keys: RowKeySource, row: number, k = 0): TablePosition | null {
    if (this.order.length === 0) return null;
    // The last group whose first row does not come after the key
    let lo = 0;
    let hi = this.order.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (compareRowKeys(this.groupAt(mid).data, 0, keys, row, this.groupKeys) <= 0) lo = mid;
      else hi = mid - 1;
    }
    const group = this.groupAt(lo);
    const data = group.data;
    // The first row of the group that does not come before the key
    let first = 0;
    let last = data.length;
    while (first < last) {
      const mid = (first + last) >> 1;
      if (compareRowKeys(data, mid, keys, row, this.groupKeys) < 0) first = mid + 1;
      else last = mid;
    }
    const same =
      first < data.length && compareRowKeys(data, first, keys, row, this.groupKeys) === 0;
    return { group: group.handle, slot: same ? 2 * first + 1 : 2 * first, k };
  }

  /**
   * The order of two places of this layer
   *
   * @returns A negative number when `a` comes first
   * @throws when a place names a group that is not in the layer
   */
  comparePositions(a: TablePosition, b: TablePosition): number {
    const ai = this.orderOf(a.group);
    const bi = this.orderOf(b.group);
    if (ai < 0 || bi < 0) throw new Error('LayerTable: a place names a group not in the layer');
    if (ai !== bi) return ai - bi;
    if (a.slot !== b.slot) return a.slot - b.slot;
    return a.k - b.k;
  }

  private reindex(): void {
    this.indexOf.clear();
    this.order.forEach((handle, i) => {
      this.indexOf.set(handle, i);
    });
  }
}

/** The union of the bboxes of the rows (null when no row has one) */
function unionOfRows(rowBounds: Float64Array): BoundingBox | null {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (let at = 0; at < rowBounds.length; at += 4) {
    if (Number.isNaN(rowBounds[at])) continue;
    if (rowBounds[at] < minX) minX = rowBounds[at];
    if (rowBounds[at + 1] < minY) minY = rowBounds[at + 1];
    if (rowBounds[at + 2] > maxX) maxX = rowBounds[at + 2];
    if (rowBounds[at + 3] > maxY) maxY = rowBounds[at + 3];
  }
  return minX === Number.POSITIVE_INFINITY ? null : { minX, minY, maxX, maxY };
}
