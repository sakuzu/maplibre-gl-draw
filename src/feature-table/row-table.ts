// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The rows of one table held as columns (`RowTable`)
 *
 * A table holds its rows as row groups in the order of the table: the rows of a group are in the
 * order of their keys, and every row of a group comes before every row of the next group. A
 * group is never changed in its shape once it is in the table; its handle names it in the order,
 * so the place of a row is its group and its row there.
 *
 * A place in the order of the table (`TablePosition`) is a group and a slot: the slot of row `r`
 * is `2r + 1`, the slot of what is drawn just before row `p` is `2p`, and `k` orders the things
 * at the same slot. The slots of a group never change while it is in the table, so a place found
 * once keeps its meaning until the group is replaced.
 */

import type { CoordinateDimensions } from '@sakuzu/tabane';
import type { BBox } from '../geometry/bbox-type.js';
import { KasaneError } from '../table/kasane-error.js';
import { ROW_FLAG_DELETED, type RowBlockData } from '../table/row-group-types.js';
import { compareRowKeys, type GroupKeySource, type RowKeySource } from '../table/row-keys.js';
import {
  type ShapeColumnReader,
  type ShapeFormReader,
  shapeColumnReaderOf,
} from '../table/shape-reader.js';
import { DeltaRows } from './delta.js';
import { elsewhereSkipsOf, skipsOf } from './row-skips.js';
import { STATE_ELSEWHERE } from './row-state.js';
import type { RowGroupHandle } from './types.js';
import type { GeometryOverrides, ValueOverrides } from './value-overrides.js';

/**
 * The `shape` column and the `keyed` column of the rows the tables read and write in place past
 * the columns of their row block (`GeometryOverrides`, `ValueOverrides`), and index for the boxes
 * of the rows: the first of each kind declared. The tables hold at most one of each for now
 *
 * @internal
 */
export const SHAPE_COLUMN = 0;
/** @internal */
export const KEYED_COLUMN = 0;

/**
 * A row group as a table holds it
 *
 * @internal
 */
export interface RowGroup {
  /** The handle of the group */
  readonly handle: RowGroupHandle;
  /** The columns of the rows */
  readonly data: RowBlockData;
  /** The copy of the state of each row (`row-state.ts`) */
  readonly state: Uint16Array;
  /**
   * The byte of the state of each row the drawing side reads, made of its copy by the user of the
   * tables (`stateByte`)
   */
  readonly gpuState: Uint8Array;
  /** Changes with every change of the state of a row of the group */
  stateVersion: number;
  /** The write mark each row was last written in (`write-marks.ts`) */
  readonly marks: Uint32Array;
  /**
   * The write mark its rows last changed in: a row written, come in or gone, or gone from it to
   * the delta (the mark it was made at for a group made outside a write)
   */
  mark: number;
  /**
   * The union of the bboxes of the rows (null when no row has a geometry). A row written in
   * place only widens it
   */
  bounds: BBox | null;
  /** The column of each attribute key */
  readonly propertyIndex: ReadonlyMap<string, number>;
  /** The reader of the `shape` column of the group (made on the first read) */
  readers: ShapeColumnReader | null;
  /** The attributes written in place since the group was built (null before the first) */
  values: ValueOverrides | null;
  /** The geometry written in place that does not fit the columns (null before the first) */
  geometries: GeometryOverrides | null;
  /**
   * The rows moved since the group was built: 1 for a row whose positions were written since
   * (a group with many is due for its next version, `GroupVersions.checkMoved`). Null before the
   * first
   */
  unindexed: Uint8Array | null;
  /** The number of rows marked in `unindexed` */
  unindexedCount: number;
  /** Whether the group holds the rows of the delta of its table (not a group of the order) */
  readonly delta: boolean;
  /**
   * Whether the group holds new rows read before their own row groups are taken in (neither a
   * group of the order nor the delta: it is read, not drawn)
   */
  readonly pending: boolean;
}

/**
 * The geometry column a row is read from and its row there
 *
 * @internal
 */
export interface RowGeometryAt {
  readonly reader: ShapeFormReader;
  /** The row in the form */
  readonly at: number;
}

/**
 * A place in the order of a table
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
 * Makes the row group of a table for its columns, every row of it and itself with a write mark
 *
 * @internal
 */
export function createRowGroup(
  handle: RowGroupHandle,
  data: RowBlockData,
  mark: number,
  delta = false,
  pending = false,
): RowGroup {
  return {
    handle,
    data,
    state: new Uint16Array(data.length),
    gpuState: new Uint8Array(data.length),
    stateVersion: 0,
    marks: new Uint32Array(data.length).fill(mark),
    mark,
    bounds: unionOfRows(data.rowBounds),
    propertyIndex: new Map((data.keyed[KEYED_COLUMN]?.keys ?? []).map((key, i) => [key, i])),
    readers: null,
    values: null,
    geometries: null,
    unindexed: null,
    unindexedCount: 0,
    delta,
    pending,
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
  const shape = group.data.shapes[SHAPE_COLUMN];
  if (!shape) return undefined;
  const form = shape.types[row];
  if (form < 0) return undefined;
  group.readers ??= shapeColumnReaderOf(shape);
  return { reader: group.readers.readers[form], at: shape.offsets[row] };
}

/**
 * Widens a bbox to hold another (null widens nothing)
 *
 * @internal
 */
export function widenBounds(
  bounds: BBox | null,
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
): BBox {
  if (!bounds) return [minX, minY, maxX, maxY];
  return [
    Math.min(bounds[0], minX),
    Math.min(bounds[1], minY),
    Math.max(bounds[2], maxX),
    Math.max(bounds[3], maxY),
  ];
}

/** An item that is a row */
const ITEM_KIND_ROW = 0;
/** An item that is a group of features */
const ITEM_KIND_GROUP = 1;

/**
 * The items of a table in their order, and the members of its groups of features
 *
 * @internal
 */
export interface TableItems {
  /** The kind of each item (0: a row, 1: a group of features) */
  readonly kinds: Uint8Array;
  /** The handle of the row or of the group of each item */
  readonly handles: Int32Array;
  /** The handles of the rows of each group of features, in their order */
  readonly members: ReadonlyMap<number, Int32Array>;
  /** The number of the rows that are not deleted */
  readonly rowCount: number;
}

/**
 * The rows of a table in their order: the rows of its groups that are read there, and the rows
 * of its delta at their places
 *
 * @internal
 */
export interface TableOrder {
  /** The handle of each row */
  readonly handles: Int32Array;
  /** The group each row is read from (a group of the table, or the group of its delta) */
  readonly groups: readonly RowGroup[];
  /** The row of each in its group */
  readonly rows: Int32Array;
}

/**
 * A row of the order of a table: the group it is read from (a group of the table, the group of
 * its delta, or a group of its new rows read before their groups are taken in) and its row there
 *
 * @internal
 */
export interface OrderRow {
  readonly group: RowGroup;
  readonly row: number;
}

/**
 * Where the rows of the delta of a table are drawn and read: before row `cuts[k]` of the group
 * at `groups[k]` of the order (the rows of the delta are in their order, so the places are too)
 *
 * @internal
 */
export interface DeltaPlaces {
  /** The place of the group of each row of the delta in the order of the table (-1: no group) */
  readonly groups: Int32Array;
  /** The row of that group the row of the delta comes before (its length: after every row) */
  readonly cuts: Int32Array;
}

/**
 * The rows of a table read outside its groups, in the order of their keys: the rows of its delta
 * and its new rows read before their groups are taken in
 */
interface ReadExtras {
  /** The group each row is read from */
  readonly groups: readonly RowGroup[];
  /** The row of each in its group */
  readonly rows: Int32Array;
  /** The place of each among the rows of the groups of the table */
  readonly places: DeltaPlaces;
  /** The entry of each row of each group (-1 for none) */
  readonly entries: ReadonlyMap<RowGroup, Int32Array>;
  /** The first entry of the run of entries of the same group each entry is in */
  readonly runStarts: Int32Array;
  /** The last entry of the run of entries of the same group each entry is in */
  readonly runEnds: Int32Array;
}

/**
 * The rows of one table
 *
 * @internal
 */
export class RowTable {
  private readonly order: RowGroupHandle[] = [];
  private readonly groups = new Map<RowGroupHandle, RowGroup>();
  private readonly indexOf = new Map<RowGroupHandle, number>();
  private rows = 0;
  private revision = 0;
  /** The items of the table in their order, made when first read after a change */
  private items: TableItems | null = null;
  /** The rows in their order, made when first read after a change */
  private ordered: TableOrder | null = null;
  /** The places of the rows of the delta, and what they were found with */
  private places: DeltaPlaces | null = null;
  private placesKey = '';
  /** The revision of the keys of the groups of features the rows of the delta are in the order of */
  deltaKeysRevision = -1;
  /** The group of each row moved since its group was built, by handle */
  private readonly moved = new Map<number, RowGroup>();
  /** The rows of the table changed since their groups were built */
  readonly delta: DeltaRows;
  /** The new rows read before their own groups are taken in (`setPendingSource`) */
  private pendingSource: (() => readonly RowGroup[]) | null = null;
  /**
   * Whether a row of the delta is a feature drawn over a row for this client only (drawn, not
   * read: `setDrawnOnly`)
   */
  private drawnOnly: ((handle: number) => boolean) | null = null;
  private pendingRevision = 0;
  /** The rows read outside the groups, and what they were found with */
  private extras: ReadExtras | null = null;
  private extrasAt = { revision: -1, delta: -1, keys: -1, pending: -1 };

  /** Told of the rows whose boxes were written again in place (the index of the boxes of the rows) */
  onRowBox: ((handle: number) => void) | null = null;

  /**
   * The dimensions of the coordinates of the rows of the table. The groups built since it was
   * last raised have them; a group of before keeps its own (fewer) until its next version
   */
  dims: CoordinateDimensions;

  /**
   * @param tableId The table
   * @param groupKeys The keys of the groups of features the rows name
   * @param serial The number of the table among the tables of its tables
   * @param deltaHandle The handle of the group of its delta
   * @param dims The dimensions of the coordinates of its rows
   */
  constructor(
    readonly tableId: string,
    private readonly groupKeys: GroupKeySource & { readonly revision?: number },
    readonly serial = 0,
    deltaHandle: RowGroupHandle = -1,
    dims: CoordinateDimensions = 'xy',
  ) {
    this.delta = new DeltaRows(deltaHandle);
    this.dims = dims;
  }

  /** The number of rows read in the table (deleted ones included until they are dropped) */
  get rowCount(): number {
    return this.rowOrder().handles.length;
  }

  /** The number of rows held by the groups of the table, the copies not read included */
  get groupRowCount(): number {
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

  /**
   * Changes whenever the rows read outside the groups but the delta may have changed: the new
   * rows read before their groups are taken in, and which rows of the delta are drawn only
   * (`touchPending`)
   */
  get pendingRowsRevision(): number {
    return this.pendingRevision;
  }

  /** The handles of the row groups, in the order of the table */
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

  /** The place of a row group in the order (-1 when it is not in the table) */
  orderOf(handle: RowGroupHandle): number {
    return this.indexOf.get(handle) ?? -1;
  }

  /** Whether the rows of a row group are in the order of their keys */
  inKeyOrder(data: RowBlockData): boolean {
    for (let r = 1; r < data.length; r++) {
      if (compareRowKeys(data, r - 1, data, r, this.groupKeys) >= 0) return false;
    }
    return true;
  }

  /**
   * Whether the keys of the rows of a row group overlap the keys of the rows of a group of the
   * table: it then cannot be put among them (its rows are not in the order of their keys
   * otherwise: see `insert`)
   */
  overlaps(data: RowBlockData): boolean {
    return this.placeOfGroup(data) < 0;
  }

  /**
   * The place in the order of a row group (the number of groups whose first row comes before
   * its first row), or -1 when its rows overlap the rows of the group before or after it there
   */
  private placeOfGroup(data: RowBlockData): number {
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
      return -1;
    }
    if (after && compareRowKeys(data, data.length - 1, after, 0, this.groupKeys) >= 0) return -1;
    return lo;
  }

  /**
   * Puts a row group at its place in the order (the order of its first row)
   *
   * @throws when the keys of its rows overlap the keys of the rows of another group, or when
   *   its rows are not in the order of their keys
   */
  insert(group: RowGroup): void {
    const data = group.data;
    if (data.length === 0) throw new KasaneError('invalid-input', 'RowTable: an empty row group');
    if (!this.inKeyOrder(data)) {
      throw new KasaneError(
        'invalid-state',
        'RowTable: the rows of a group are not in the order of their keys',
      );
    }
    const lo = this.placeOfGroup(data);
    if (lo < 0) {
      throw new KasaneError(
        'invalid-state',
        'RowTable: the rows of a group overlap the rows of another group',
      );
    }
    this.order.splice(lo, 0, group.handle);
    this.groups.set(group.handle, group);
    this.rows += data.length;
    this.reindex();
    this.revision++;
    this.touchItems();
  }

  /**
   * The groups of the table once some are replaced by others, in the order of their rows (null
   * when the rows of two of them would overlap)
   *
   * @throws when a group replaced is not in the table
   */
  private groupsAfter(
    before: readonly RowGroup[],
    after: readonly RowGroup[],
    groupKeys: GroupKeySource,
  ): RowGroup[] | null {
    const replaced = new Set<RowGroup>();
    for (const group of before) {
      if (this.groups.get(group.handle) !== group) {
        throw new KasaneError('invalid-state', 'RowTable: a group replaced is not in the table');
      }
      replaced.add(group);
    }
    const groups = [...this.groups.values()].filter((group) => !replaced.has(group));
    for (const group of after) if (group.data.length > 0) groups.push(group);
    groups.sort((a, b) => compareRowKeys(a.data, 0, b.data, 0, groupKeys));
    for (let i = 1; i < groups.length; i++) {
      const a = groups[i - 1].data;
      const b = groups[i].data;
      if (compareRowKeys(a, a.length - 1, b, 0, groupKeys) >= 0) return null;
    }
    return groups;
  }

  /**
   * Whether the rows of a group would overlap the rows of another once some groups are replaced
   * by others (a next version built while a group was taken in within its range)
   */
  overlapsAfter(
    before: readonly RowGroup[],
    after: readonly RowGroup[],
    groupKeys: GroupKeySource = this.groupKeys,
  ): boolean {
    return this.groupsAfter(before, after, groupKeys) === null;
  }

  /**
   * Replaces row groups of the table by others (the next versions of groups, groups cut or
   * joined, the order of their rows changed) and puts the groups in the order of their rows
   *
   * @throws when the rows of two groups would overlap (the table is left as it was)
   */
  replaceGroups(
    before: readonly RowGroup[],
    after: readonly RowGroup[],
    groupKeys: GroupKeySource = this.groupKeys,
  ): void {
    const groups = this.groupsAfter(before, after, groupKeys);
    if (!groups) throw new KasaneError('invalid-state', 'RowTable: the rows of two groups overlap');
    for (const group of before) {
      this.groups.delete(group.handle);
      this.rows -= group.data.length;
      this.dropMoved(group);
    }
    for (const group of after) {
      if (group.data.length === 0) continue;
      this.groups.set(group.handle, group);
      this.rows += group.data.length;
    }
    this.order.length = 0;
    for (const group of groups) this.order.push(group.handle);
    this.reindex();
    this.revision++;
    this.touchItems();
  }

  /**
   * The rows of the table in their order: the rows of its groups read there (not the ones read
   * from the delta, nor the ones waiting for another group), the rows of the delta and the new
   * rows read before their groups are taken in at their places, deleted rows included. Made again
   * when read after a change (`touchItems`)
   */
  rowOrder(): TableOrder {
    if (this.ordered) return this.ordered;
    const extras = this.readExtras();
    const places = extras.places;
    // Counted first, so the arrays are made at their size (no array grown a row at a time)
    let count = extras.rows.length;
    for (let g = 0; g < this.order.length; g++) {
      const group = this.groupAt(g);
      const state = group.state;
      for (let r = 0; r < group.data.length; r++) {
        if ((state[r] & STATE_ELSEWHERE) === 0) count++;
      }
    }
    const handles = new Int32Array(count);
    const groups = new Array<RowGroup>(count);
    const rows = new Int32Array(count);
    let at = 0;
    let next = 0;
    const flush = (g: number, before: number): void => {
      while (
        next < extras.rows.length &&
        (places.groups[next] < g || (places.groups[next] === g && places.cuts[next] <= before))
      ) {
        const group = extras.groups[next];
        const row = extras.rows[next];
        handles[at] = group.data.handles[row];
        groups[at] = group;
        rows[at] = row;
        at++;
        next++;
      }
    };
    for (let g = 0; g < this.order.length; g++) {
      const group = this.groupAt(g);
      const data = group.data;
      for (let r = 0; r < data.length; r++) {
        flush(g, r);
        if ((group.state[r] & STATE_ELSEWHERE) !== 0) continue;
        handles[at] = data.handles[r];
        groups[at] = group;
        rows[at] = r;
        at++;
      }
      flush(g, data.length);
    }
    flush(Number.MAX_SAFE_INTEGER, 0);
    if (at !== count)
      throw new KasaneError('invalid-state', 'RowTable: the order read other rows than it counted');
    this.ordered = { handles, groups, rows };
    return this.ordered;
  }

  /**
   * Sets where the new rows of the table read before their own groups are taken in come from: row
   * groups in no particular order whose runs of keys do not overlap (`touchPending` when they
   * change)
   */
  setPendingSource(source: () => readonly RowGroup[]): void {
    this.pendingSource = source;
    this.touchPending();
  }

  /**
   * Sets which rows of the delta are drawn and not read (the features drawn over rows for this
   * client only): the order and the searches leave them out
   */
  setDrawnOnly(test: (handle: number) => boolean): void {
    this.drawnOnly = test;
    this.touchPending();
  }

  /** Makes the order and the searches read the new rows read before their groups again */
  touchPending(): void {
    this.pendingRevision++;
    this.touchItems();
  }

  /**
   * The rows read outside the groups of the table, in the order of their keys: the rows of the
   * delta and the new rows read before their groups are taken in, with their places among the
   * rows of the groups (found again when the groups, the delta, the new rows or the keys of the
   * groups of features changed)
   */
  private readExtras(): ReadExtras {
    const keys = this.groupKeys.revision ?? 0;
    if (
      this.extras &&
      this.extrasAt.revision === this.revision &&
      this.extrasAt.delta === this.delta.revision &&
      this.extrasAt.keys === keys &&
      this.extrasAt.pending === this.pendingRevision
    ) {
      return this.extras;
    }
    const delta = this.delta.group;
    const pending = (this.pendingSource?.() ?? [])
      .filter((group) => group.data.length > 0)
      .sort((a, b) => compareRowKeys(a.data, 0, b.data, 0, this.groupKeys));
    const groups: RowGroup[] = [];
    const rows: number[] = [];
    const deltaLength = delta?.data.length ?? 0;
    const drawnOnly = this.drawnOnly;
    let d = 0;
    let p = 0;
    let pr = 0;
    while (d < deltaLength || p < pending.length) {
      // A row of the delta drawn only is not read
      if (d < deltaLength && drawnOnly?.((delta as RowGroup).data.handles[d])) {
        d++;
        continue;
      }
      const fromDelta =
        p >= pending.length ||
        (d < deltaLength &&
          compareRowKeys((delta as RowGroup).data, d, pending[p].data, pr, this.groupKeys) < 0);
      if (fromDelta) {
        groups.push(delta as RowGroup);
        rows.push(d++);
        continue;
      }
      groups.push(pending[p]);
      rows.push(pr++);
      if (pr >= pending[p].data.length) {
        p++;
        pr = 0;
      }
    }
    const n = rows.length;
    const placeGroups = new Int32Array(n).fill(-1);
    const cuts = new Int32Array(n);
    const deltaPlaces = this.deltaPlaces();
    const entries = new Map<RowGroup, Int32Array>();
    for (let k = 0; k < n; k++) {
      const group = groups[k];
      const row = rows[k];
      let list = entries.get(group);
      if (!list) {
        list = new Int32Array(group.data.length).fill(-1);
        entries.set(group, list);
      }
      list[row] = k;
      if (group === delta) {
        placeGroups[k] = deltaPlaces.groups[row];
        cuts[k] = deltaPlaces.cuts[row];
        continue;
      }
      const place = this.positionOfKey(group.data, row);
      if (!place) continue;
      placeGroups[k] = this.orderOf(place.group);
      cuts[k] = (place.slot + 1) >> 1;
    }
    const runStarts = new Int32Array(n);
    const runEnds = new Int32Array(n);
    for (let k = 0; k < n; k++) {
      runStarts[k] = k > 0 && groups[k - 1] === groups[k] ? runStarts[k - 1] : k;
    }
    for (let k = n - 1; k >= 0; k--) {
      runEnds[k] = k < n - 1 && groups[k + 1] === groups[k] ? runEnds[k + 1] : k;
    }
    this.extras = {
      groups,
      rows: Int32Array.from(rows),
      places: { groups: placeGroups, cuts },
      entries,
      runStarts,
      runEnds,
    };
    this.extrasAt = {
      revision: this.revision,
      delta: this.delta.revision,
      keys,
      pending: this.pendingRevision,
    };
    return this.extras;
  }

  /**
   * The places of the rows of the delta among the rows of the groups (found again when the
   * groups, the delta or the keys of the groups of features changed)
   */
  deltaPlaces(): DeltaPlaces {
    const delta = this.delta.group;
    const key = `${this.revision}:${this.delta.revision}:${this.groupKeys.revision ?? 0}`;
    if (this.places && this.placesKey === key) return this.places;
    const n = delta?.data.length ?? 0;
    const groups = new Int32Array(n).fill(-1);
    const cuts = new Int32Array(n);
    for (let k = 0; k < n; k++) {
      const place = this.positionOfKey((delta as RowGroup).data, k);
      if (!place) continue;
      groups[k] = this.orderOf(place.group);
      cuts[k] = (place.slot + 1) >> 1;
    }
    this.places = { groups, cuts };
    this.placesKey = key;
    return this.places;
  }

  /** The places of the rows of the delta when they are known still (null when they are not) */
  placesOfDelta(): DeltaPlaces | null {
    const key = `${this.revision}:${this.delta.revision}:${this.groupKeys.revision ?? 0}`;
    return this.places && this.placesKey === key ? this.places : null;
  }

  /**
   * Keeps the places of the rows that stayed when the delta was made again: the groups and their
   * keys are the same, so only the rows that came in are looked for
   *
   * @param before The places of the rows before
   * @param pairs The rows of the delta now, two numbers each: the source and the row there (the
   *   source 0 is the delta before)
   */
  carryDeltaPlaces(before: DeltaPlaces, pairs: Int32Array): void {
    const n = pairs.length / 2;
    const groups = new Int32Array(n).fill(-1);
    const cuts = new Int32Array(n);
    const data = this.delta.group?.data;
    for (let k = 0; k < n; k++) {
      if (pairs[k * 2] === 0) {
        const row = pairs[k * 2 + 1];
        groups[k] = before.groups[row];
        cuts[k] = before.cuts[row];
        continue;
      }
      const place = this.positionOfKey(data as RowBlockData, k);
      if (!place) continue;
      groups[k] = this.orderOf(place.group);
      cuts[k] = (place.slot + 1) >> 1;
    }
    this.places = { groups, cuts };
    this.placesKey = `${this.revision}:${this.delta.revision}:${this.groupKeys.revision ?? 0}`;
  }

  /**
   * The items of the table in their order: its rows outside a group of features and its groups
   * of features (one item at the place of their members, which follow each other), deleted rows
   * left out; with the members of each group in their order. Made again when read after a change
   * of the rows (`touchItems`)
   */
  itemsOf(): TableItems {
    if (this.items) return this.items;
    const order = this.rowOrder();
    const n = order.handles.length;
    // Counted first, so the arrays are made at their size: a row outside a group of features is
    // an item, and a group of features is one item at each run of its members
    let count = 0;
    let deleted = 0;
    let last = -1;
    for (let i = 0; i < n; i++) {
      const data = order.groups[i].data;
      const r = order.rows[i];
      if ((data.flags[r] & ROW_FLAG_DELETED) !== 0) {
        deleted++;
        continue;
      }
      const group = data.groups[r];
      if (group < 0) {
        count++;
        last = -1;
      } else if (group !== last) {
        count++;
        last = group;
      }
    }
    const kinds = new Uint8Array(count);
    const handles = new Int32Array(count);
    const members = new Map<number, number[]>();
    let at = 0;
    last = -1;
    for (let i = 0; i < n; i++) {
      const data = order.groups[i].data;
      const r = order.rows[i];
      if ((data.flags[r] & ROW_FLAG_DELETED) !== 0) continue;
      const group = data.groups[r];
      if (group < 0) {
        kinds[at] = ITEM_KIND_ROW;
        handles[at] = data.handles[r];
        at++;
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
        kinds[at] = ITEM_KIND_GROUP;
        handles[at] = group;
        at++;
        last = group;
      }
    }
    const byGroup = new Map<number, Int32Array>();
    for (const [group, list] of members) byGroup.set(group, Int32Array.from(list));
    this.items = { kinds, handles, members: byGroup, rowCount: n - deleted };
    return this.items;
  }

  /** The items of the table when they are made, null when they would have to be made again */
  get itemsMade(): TableItems | null {
    return this.items;
  }

  /**
   * Makes the items and the order be made again when next read (a row deleted, a row of another
   * group, a row of the delta)
   */
  touchItems(): void {
    this.items = null;
    this.ordered = null;
  }

  // === Walking the order a row at a time ===
  //
  // The rows of the order (`rowOrder`) are the rows of the groups read there and the rows read
  // outside them (the delta, the new rows) at their places. A row is found from its place and
  // the rows next to it are read from the groups and the places of the rows outside them, so a
  // step costs the rows not read it passes, not the rows of the table.

  /** The first row of the order (null for a table without rows) */
  firstRow(): OrderRow | null {
    return this.earlier(this.mainFrom(0, 0), this.readExtras().rows.length > 0 ? 0 : -1);
  }

  /** The last row of the order (null for a table without rows) */
  lastRow(): OrderRow | null {
    const extras = this.readExtras();
    const last = this.order.length - 1;
    const main = last >= 0 ? this.mainBefore(last, this.groupAt(last).data.length) : null;
    return this.later(main, extras.rows.length - 1);
  }

  /**
   * The row just before a row of the order (null for the first one)
   *
   * @throws when the row is not read in the table
   */
  previousRow(at: OrderRow): OrderRow | null {
    const extras = this.readExtras();
    const k = this.extraOf(at);
    if (k >= 0) {
      const g = extras.places.groups[k];
      const main = g >= 0 ? this.mainBefore(g, extras.places.cuts[k]) : null;
      return this.later(main, k - 1);
    }
    const [g, r] = this.mainOf(at);
    return this.later(this.mainBefore(g, r), this.lastExtraBefore(g, r));
  }

  /**
   * The row just after a row of the order (null for the last one)
   *
   * @throws when the row is not read in the table
   */
  nextRow(at: OrderRow): OrderRow | null {
    const extras = this.readExtras();
    const k = this.extraOf(at);
    if (k >= 0) {
      const g = extras.places.groups[k];
      const main = g >= 0 ? this.mainFrom(g, extras.places.cuts[k]) : this.mainFrom(0, 0);
      return this.earlier(main, k + 1 < extras.rows.length ? k + 1 : -1);
    }
    const [g, r] = this.mainOf(at);
    const next = this.lastExtraBefore(g, r) + 1;
    return this.earlier(this.mainFrom(g, r + 1), next < extras.rows.length ? next : -1);
  }

  /**
   * The row at or before a row of the order that is not deleted (null when there is none): a run
   * of deleted rows of a group is passed in a few steps (`RowSkips`), so a walk costs the rows it
   * reads, not the rows deleted before them
   *
   * @throws when the row is not read in the table
   */
  liveRowAtOrBefore(at: OrderRow | null): OrderRow | null {
    if (!at || (at.group.data.flags[at.row] & ROW_FLAG_DELETED) === 0) return at;
    const extras = this.readExtras();
    const k = this.extraOf(at);
    if (k >= 0) {
      const g = extras.places.groups[k];
      const main = g >= 0 ? this.mainLiveBefore(g, extras.places.cuts[k]) : null;
      return this.later(main, this.extraLiveAtOrBefore(k - 1));
    }
    const [g, r] = this.mainOf(at);
    return this.later(
      this.mainLiveBefore(g, r),
      this.extraLiveAtOrBefore(this.lastExtraBefore(g, r)),
    );
  }

  /**
   * The row at or after a row of the order that is not deleted (null when there is none), as
   * `liveRowAtOrBefore` finds it up
   *
   * @throws when the row is not read in the table
   */
  liveRowAtOrAfter(at: OrderRow | null): OrderRow | null {
    if (!at || (at.group.data.flags[at.row] & ROW_FLAG_DELETED) === 0) return at;
    const extras = this.readExtras();
    const k = this.extraOf(at);
    if (k >= 0) {
      const g = extras.places.groups[k];
      const main = g >= 0 ? this.mainLiveFrom(g, extras.places.cuts[k]) : this.mainLiveFrom(0, 0);
      return this.earlier(main, this.extraLiveAtOrAfter(k + 1));
    }
    const [g, r] = this.mainOf(at);
    return this.earlier(
      this.mainLiveFrom(g, r + 1),
      this.extraLiveAtOrAfter(this.lastExtraBefore(g, r) + 1),
    );
  }

  /** The last row of the groups read there and not deleted before row `r` of the group at `g` */
  private mainLiveBefore(g: number, r: number): [number, number] | null {
    for (let i = g; i >= 0; i--) {
      const group = this.groupAt(i);
      const row = skipsOf(group).lastAtOrBefore((i === g ? r : group.data.length) - 1);
      if (row >= 0) return [i, row];
    }
    return null;
  }

  /** The first row of the groups read there and not deleted at or after row `r` of the group at `g` */
  private mainLiveFrom(g: number, r: number): [number, number] | null {
    for (let i = g; i < this.order.length; i++) {
      const group = this.groupAt(i);
      const row = skipsOf(group).firstAtOrAfter(i === g ? r : 0);
      if (row < group.data.length) return [i, row];
    }
    return null;
  }

  /**
   * The last row read outside the groups at or before entry `k` that is not deleted (-1 for
   * none): a run of deleted rows of the same group is passed in a few steps
   */
  private extraLiveAtOrBefore(k: number): number {
    const extras = this.readExtras();
    let j = k;
    while (j >= 0) {
      const group = extras.groups[j];
      const row = skipsOf(group).lastAtOrBefore(extras.rows[j]);
      const entry = row >= 0 ? (extras.entries.get(group)?.[row] ?? -1) : -1;
      if (entry === j) return j;
      if (row >= 0 && entry < 0) {
        // A row of the group read for this client only (not in the order): one step down
        j--;
        continue;
      }
      // The rows of the group in the run are passed: the one found, or the run before
      if (entry >= extras.runStarts[j]) return entry;
      j = extras.runStarts[j] - 1;
    }
    return -1;
  }

  /** As `extraLiveAtOrBefore`, up: the first at or after entry `k` (-1 for none) */
  private extraLiveAtOrAfter(k: number): number {
    const extras = this.readExtras();
    const n = extras.rows.length;
    let j = k;
    while (j < n) {
      const group = extras.groups[j];
      const row = skipsOf(group).firstAtOrAfter(extras.rows[j]);
      const entry = row < group.data.length ? (extras.entries.get(group)?.[row] ?? -1) : -1;
      if (entry === j) return j;
      if (row < group.data.length && entry < 0) {
        j++;
        continue;
      }
      if (entry >= 0 && entry <= extras.runEnds[j]) return entry;
      j = extras.runEnds[j] + 1;
    }
    return -1;
  }

  /**
   * The first row of the order that does not come before a key (null when every row does)
   *
   * @param keys The columns the key is read from
   * @param row The entry of the key in them
   */
  rowNotBefore(keys: RowKeySource, row: number): OrderRow | null {
    const extras = this.readExtras();
    let main: [number, number] | null = null;
    const place = this.positionOfKey(keys, row);
    if (place) {
      const g = this.orderOf(place.group);
      main = this.mainFrom(g, place.slot >> 1);
    }
    // The first row outside the groups that does not come before the key
    let lo = 0;
    let hi = extras.rows.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const group = extras.groups[mid];
      if (compareRowKeys(group.data, extras.rows[mid], keys, row, this.groupKeys) < 0) {
        lo = mid + 1;
      } else hi = mid;
    }
    return this.earlier(main, lo < extras.rows.length ? lo : -1);
  }

  /** The entry of a row among the rows read outside the groups (-1 for a row of a group) */
  private extraOf(at: OrderRow): number {
    if (!at.group.delta && !at.group.pending) return -1;
    const k = this.readExtras().entries.get(at.group)?.[at.row] ?? -1;
    if (k < 0) throw new KasaneError('invalid-state', 'RowTable: the row is not read in the table');
    return k;
  }

  /** The place in the order of the groups of a row of a group */
  private mainOf(at: OrderRow): [number, number] {
    const g = this.orderOf(at.group.handle);
    if (g < 0 || this.groupAt(g) !== at.group || (at.group.state[at.row] & STATE_ELSEWHERE) !== 0) {
      throw new KasaneError('invalid-state', 'RowTable: the row is not read in the table');
    }
    return [g, at.row];
  }

  /** The first row of the groups read there at or after row `r` of the group at `g` */
  private mainFrom(g: number, r: number): [number, number] | null {
    for (let i = g; i < this.order.length; i++) {
      const group = this.groupAt(i);
      // The rows read elsewhere are passed together (`RowSkips`)
      const row = elsewhereSkipsOf(group).firstAtOrAfter(i === g ? r : 0);
      if (row < group.data.length) return [i, row];
    }
    return null;
  }

  /** The last row of the groups read there before row `r` of the group at `g` */
  private mainBefore(g: number, r: number): [number, number] | null {
    for (let i = g; i >= 0; i--) {
      const group = this.groupAt(i);
      const row = elsewhereSkipsOf(group).lastAtOrBefore((i === g ? r : group.data.length) - 1);
      if (row >= 0) return [i, row];
    }
    return null;
  }

  /** Whether the row `k` read outside the groups comes before row `r` of the group at `g` */
  private extraBefore(k: number, g: number, r: number, places = this.readExtras().places): boolean {
    return places.groups[k] < g || (places.groups[k] === g && places.cuts[k] <= r);
  }

  /** The last row read outside the groups that comes before row `r` of the group at `g` (-1) */
  private lastExtraBefore(g: number, r: number): number {
    const extras = this.readExtras();
    let lo = 0;
    let hi = extras.rows.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.extraBefore(mid, g, r, extras.places)) lo = mid + 1;
      else hi = mid;
    }
    return lo - 1;
  }

  /** The earlier of a row of the groups and a row read outside them (-1 for none) */
  private earlier(main: [number, number] | null, k: number): OrderRow | null {
    if (k >= 0 && (!main || this.extraBefore(k, main[0], main[1]))) return this.extraRow(k);
    return main ? { group: this.groupAt(main[0]), row: main[1] } : null;
  }

  /** The later of a row of the groups and a row read outside them (-1 for none) */
  private later(main: [number, number] | null, k: number): OrderRow | null {
    if (k >= 0 && (!main || !this.extraBefore(k, main[0], main[1]))) return this.extraRow(k);
    return main ? { group: this.groupAt(main[0]), row: main[1] } : null;
  }

  private extraRow(k: number): OrderRow {
    const extras = this.readExtras();
    return { group: extras.groups[k], row: extras.rows[k] };
  }

  /**
   * The place in the order of a key: the slot just before the first row that does not come
   * before it, or the row itself when a row has the same keys
   *
   * @param keys The columns the key is read from
   * @param row The entry of the key in them
   * @param k The order of the things at the same slot
   * @returns The place, or null when the table has no row
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
   * The order of two places of this table
   *
   * @returns A negative number when `a` comes first
   * @throws when a place names a group that is not in the table
   */
  comparePositions(a: TablePosition, b: TablePosition): number {
    const ai = this.orderOf(a.group);
    const bi = this.orderOf(b.group);
    if (ai < 0 || bi < 0)
      throw new KasaneError('invalid-state', 'RowTable: a place names a group not in the table');
    if (ai !== bi) return ai - bi;
    if (a.slot !== b.slot) return a.slot - b.slot;
    return a.k - b.k;
  }

  /** The number of rows moved since their groups were built */
  get movedRowCount(): number {
    return this.moved.size;
  }

  /**
   * Records that a row moved since its group was built, with its new bbox (the index of the boxes
   * of the rows is told to read it again)
   */
  moveRow(group: RowGroup, row: number, bounds: Float64Array): void {
    const handle = group.data.handles[row];
    this.onRowBox?.(handle);
    group.unindexed ??= new Uint8Array(group.data.length);
    if (group.unindexed[row] === 0) group.unindexedCount++;
    group.unindexed[row] = 1;
    if (Number.isNaN(bounds[row * 4])) this.moved.delete(handle);
    else this.moved.set(handle, group);
  }

  /**
   * Calls `visit` with rows found in the table, in the order of the table: the rows of its groups
   * read there, and the rows of its delta and its new rows read before their groups are taken in at
   * their places. A row not read in the table (a row of a group of the order read elsewhere, a row
   * of the delta drawn only, a group the table does not read) is left out
   *
   * @param found The rows found, by the group they are read from (in no particular order; the
   *   arrays are sorted in place)
   * @param visit Receives each row, in order, with the group it is read from
   */
  visitInOrder(
    found: ReadonlyMap<RowGroup, number[]>,
    visit: (group: RowGroup, row: number) => void,
  ): void {
    if (found.size === 0) return;
    const extras = this.readExtras();
    const hits: number[] = [];
    if (extras.rows.length > 0) {
      for (const [group, entries] of extras.entries) {
        const rows = found.get(group);
        if (!rows) continue;
        for (const row of rows) {
          if (entries[row] >= 0) hits.push(entries[row]);
        }
      }
      hits.sort((a, b) => a - b);
    }
    const places = extras.places;
    let next = 0;
    const flush = (g: number, before: number): void => {
      while (
        next < hits.length &&
        (places.groups[hits[next]] < g ||
          (places.groups[hits[next]] === g && places.cuts[hits[next]] <= before))
      ) {
        visit(extras.groups[hits[next]], extras.rows[hits[next]]);
        next++;
      }
    };
    for (let g = 0; g < this.order.length; g++) {
      const group = this.groupAt(g);
      const rows = found.get(group);
      if (rows) {
        for (const row of inOrder(rows, group.data.length)) {
          flush(g, row);
          if ((group.state[row] & STATE_ELSEWHERE) === 0) visit(group, row);
        }
      }
      if (next < hits.length) flush(g, group.data.length);
    }
    flush(Number.MAX_SAFE_INTEGER, 0);
  }

  /**
   * Whether a row is read in the table from a group: a row of a group of the order not read
   * elsewhere, or a row of its delta or its new rows that is read (not drawn only)
   */
  readsRow(group: RowGroup, row: number): boolean {
    if (this.indexOf.has(group.handle) && this.groups.get(group.handle) === group) {
      return (group.state[row] & STATE_ELSEWHERE) === 0;
    }
    return (this.readExtras().entries.get(group)?.[row] ?? -1) >= 0;
  }

  /**
   * The box of the positions of a row as it is now (its bbox is written again with every write
   * of its geometry in place): written into `out` as minX, minY, maxX, maxY
   *
   * @returns false for a row without positions
   */
  rowBox(group: RowGroup, row: number, out: Float64Array): boolean {
    const b = group.data.rowBounds;
    const at = row * 4;
    if (Number.isNaN(b[at])) return false;
    out[0] = b[at];
    out[1] = b[at + 1];
    out[2] = b[at + 2];
    out[3] = b[at + 3];
    return true;
  }

  /** Forgets the rows of a group moved since it was built (the group left the table) */
  dropMoved(group: RowGroup): void {
    if (group.unindexedCount === 0) return;
    for (const [handle, of] of this.moved) {
      if (of === group) this.moved.delete(handle);
    }
  }

  private reindex(): void {
    this.indexOf.clear();
    this.order.forEach((handle, i) => {
      this.indexOf.set(handle, i);
    });
  }
}

/**
 * Rows of a group in their order: marked and read off in order when they are many of the group,
 * else sorted
 *
 * @param length The number of rows of the group
 */
function inOrder(rows: readonly number[], length: number): Int32Array {
  if (rows.length * 8 < length) return Int32Array.from(rows).sort();
  const marked = new Uint8Array(length);
  for (const row of rows) marked[row] = 1;
  const out = new Int32Array(rows.length);
  let n = 0;
  for (let row = 0; row < length; row++) if (marked[row] === 1) out[n++] = row;
  return n === out.length ? out : out.subarray(0, n);
}

/** The union of the bboxes of the rows (null when no row has one) */
function unionOfRows(rowBounds: Float64Array): BBox | null {
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
  return minX === Number.POSITIVE_INFINITY ? null : [minX, minY, maxX, maxY];
}
