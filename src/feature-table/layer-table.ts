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

import RBush from 'rbush';
import type { BoundingBox } from '../shared/types/model.js';
import { searchPackedRTree } from '../table/packed-rtree.js';
import { ROW_FLAG_DELETED, type RowGroupData } from '../table/row-group-types.js';
import { compareRowKeys, type GroupKeySource, type RowKeySource } from '../table/row-keys.js';
import { GeometryColumnReader } from '../table/table.js';
import type { RowGroupHandle } from './types.js';
import type { GeometryOverrides, ValueOverrides } from './value-overrides.js';

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
  /**
   * The union of the bboxes of the rows (null when no row has a geometry). A row written in
   * place only widens it
   */
  bounds: BoundingBox | null;
  /** The column of each attribute key */
  readonly propertyIndex: ReadonlyMap<string, number>;
  /** The reader of each geometry column of the group (made on the first read) */
  readers: GeometryColumnReader[] | null;
  /** The attributes written in place since the group was built (null before the first) */
  values: ValueOverrides | null;
  /** The geometry written in place that does not fit the columns (null before the first) */
  geometries: GeometryOverrides | null;
  /**
   * The rows moved since the group was built: 1 for a row the spatial index of the group no
   * longer finds where it is (its layer finds it in its index of the moved rows). Null before
   * the first
   */
  unindexed: Uint8Array | null;
}

/**
 * The geometry column a row is read from and its row there
 *
 * @internal
 */
export interface RowGeometryAt {
  readonly reader: GeometryColumnReader;
  /** The row in the column */
  readonly at: number;
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
    values: null,
    geometries: null,
    unindexed: null,
  };
}

/**
 * The bytes the values written in place of a group hold (attributes and geometry together)
 *
 * @internal
 */
export function overrideBytesOf(group: RowGroup): number {
  return (group.values?.bytes ?? 0) + (group.geometries?.bytes ?? 0);
}

/**
 * The geometry column of a row and its row there: the geometry written in place of another
 * shape when there is one, the column of the group otherwise (undefined for a row without a
 * geometry)
 *
 * @internal
 */
export function geometryAt(group: RowGroup, row: number): RowGeometryAt | undefined {
  const written = group.geometries?.geometry(row);
  if (written) return { reader: written, at: 0 };
  return columnGeometryAt(group, row);
}

/**
 * The geometry column of the group a row is in and its row there, without what was written in
 * place (undefined for a row without a geometry in the columns)
 *
 * @internal
 */
export function columnGeometryAt(group: RowGroup, row: number): RowGeometryAt | undefined {
  const child = group.data.geometry.types[row];
  if (child < 0) return undefined;
  group.readers ??= group.data.geometry.children.map(
    (column, k) => new GeometryColumnReader(column, undefined, `geometry.children[${k}]`),
  );
  return { reader: group.readers[child], at: group.data.geometry.offsets[row] };
}

/**
 * Widens a bbox to hold another (null widens nothing)
 *
 * @internal
 */
export function widenBounds(
  bounds: BoundingBox | null,
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
): BoundingBox {
  if (!bounds) return { minX, minY, maxX, maxY };
  return {
    minX: Math.min(bounds.minX, minX),
    minY: Math.min(bounds.minY, minY),
    maxX: Math.max(bounds.maxX, maxX),
    maxY: Math.max(bounds.maxY, maxY),
  };
}

/** An item that is a row */
const ITEM_KIND_ROW = 0;
/** An item that is a group of features */
const ITEM_KIND_GROUP = 1;

/**
 * The items of a layer in their order, and the members of its groups of features
 *
 * @internal
 */
export interface LayerItems {
  /** The kind of each item (0: a row, 1: a group of features) */
  readonly kinds: Uint8Array;
  /** The handle of the row or of the group of each item */
  readonly handles: Int32Array;
  /** The handles of the rows of each group of features, in their order */
  readonly members: ReadonlyMap<number, Int32Array>;
}

/** A row of a layer moved since its group was built, in the index of the moved rows */
interface MovedRow {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  readonly group: RowGroup;
  readonly row: number;
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
  /** The items of the layer in their order, made when first read after a change */
  private items: LayerItems | null = null;
  /** The rows moved since their group was built, by handle (7.4 of the design) */
  private readonly moved = new Map<number, MovedRow>();
  private movedIndex: RBush<MovedRow> | null = null;

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
    this.items = null;
  }

  /**
   * The items of the layer in their order: its rows outside a group of features and its groups
   * of features (one item at the place of their members, which follow each other), deleted rows
   * left out; with the members of each group in their order. Made again when read after a change
   * of the rows (`touchItems`)
   */
  itemsOf(): LayerItems {
    if (this.items) return this.items;
    const kinds: number[] = [];
    const handles: number[] = [];
    const members = new Map<number, number[]>();
    let last = -1;
    for (const handle of this.order) {
      const data = (this.groups.get(handle) as RowGroup).data;
      for (let r = 0; r < data.length; r++) {
        if ((data.flags[r] & ROW_FLAG_DELETED) !== 0) continue;
        const group = data.groups[r];
        if (group < 0) {
          kinds.push(ITEM_KIND_ROW);
          handles.push(data.handles[r]);
          last = -1;
          continue;
        }
        let list = members.get(group);
        if (!list) {
          list = [];
          members.set(group, list);
        }
        list.push(data.handles[r]);
        if (group !== last) {
          kinds.push(ITEM_KIND_GROUP);
          handles.push(group);
          last = group;
        }
      }
    }
    const byGroup = new Map<number, Int32Array>();
    for (const [group, list] of members) byGroup.set(group, Int32Array.from(list));
    this.items = {
      kinds: Uint8Array.from(kinds),
      handles: Int32Array.from(handles),
      members: byGroup,
    };
    return this.items;
  }

  /** Makes the items be made again when next read (a row deleted, a row of another group) */
  touchItems(): void {
    this.items = null;
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

  /** The number of rows moved since their groups were built */
  get movedRowCount(): number {
    return this.moved.size;
  }

  /**
   * Records that a row moved since its group was built, with its new bbox: the spatial index of
   * its group no longer finds it, the index of the moved rows of the layer does
   */
  moveRow(group: RowGroup, row: number, bounds: Float64Array): void {
    const handle = group.data.handles[row];
    group.unindexed ??= new Uint8Array(group.data.length);
    group.unindexed[row] = 1;
    this.movedIndex ??= new RBush<MovedRow>();
    const index = this.movedIndex;
    const old = this.moved.get(handle);
    if (old) index.remove(old);
    const at = row * 4;
    if (Number.isNaN(bounds[at])) {
      this.moved.delete(handle);
      return;
    }
    const entry: MovedRow = {
      minX: bounds[at],
      minY: bounds[at + 1],
      maxX: bounds[at + 2],
      maxY: bounds[at + 3],
      group,
      row,
    };
    this.moved.set(handle, entry);
    index.insert(entry);
  }

  /**
   * The rows of a group whose bbox meets a box, read from the spatial index of the group and the
   * index of the rows moved (in no particular order)
   *
   * @param out Receives the rows (it is not cleared)
   */
  searchRows(
    group: RowGroup,
    minX: number,
    minY: number,
    maxX: number,
    maxY: number,
    out: number[],
  ): void {
    const mark = out.length;
    searchPackedRTree(group.data.index, minX, minY, maxX, maxY, out);
    const unindexed = group.unindexed;
    if (unindexed) {
      let kept = mark;
      for (let i = mark; i < out.length; i++) {
        if (unindexed[out[i]] === 0) out[kept++] = out[i];
      }
      out.length = kept;
    }
    if (this.movedIndex && this.moved.size > 0) {
      for (const entry of this.movedIndex.search({ minX, minY, maxX, maxY })) {
        if (entry.group === group) out.push(entry.row);
      }
    }
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
