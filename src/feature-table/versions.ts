// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The next versions of the row groups (`GroupVersions`)
 *
 * A row group never changes its shape: a row of it placed elsewhere, a new row in its range, its
 * values written in place past a limit, its rows moved far, are kept beside it (the delta, the
 * overrides, the marks of the moved rows) until the next version of the group takes them. The
 * next version is the rows of the group that stay and the rows of the delta whose keys fall in
 * its range, merged in the order of the table (`mergeRowBlockData`, on the main thread or in the
 * Worker of the host), and cut into groups of the target sizes when it grew past twice them. A
 * small group is merged with its neighbor.
 *
 * A version goes through: started (its groups locked, the write mark it takes the rows of the
 * delta up to kept), built (its columns are made), uploaded (every side that draws the rows
 * has its GPU side, `GroupVersionReceiver`), and swapped. The swap replaces the groups in one
 * step, in the pass before the main one of the frame its GPU side is up in: the rows it took
 * leave the delta, the values written in place of its groups since it started are written again
 * into it, and the copies of the state of its rows are made again. Until then the groups it
 * replaces are read and drawn.
 *
 * A row moved from a group A to a group B is in the next version of B before A has its next
 * version when B goes first: there it waits (its copy in B is hidden and not read, the row is
 * read from the delta) until A has its next version, which hands the row to B. Each group is
 * replaced on its own, whatever order they go in.
 */

import type { CoordinateDimensions, CoordinateSystem } from '@sakuzu/tabane';
import type { BBox } from '../geometry/bbox-type.js';
import type { GroupEntry, RowBlockBuilderOptions, RowInput } from '../table/row-group-builder.js';
import { ROW_BLOCK_TARGET_ROWS, ROW_BLOCK_TARGET_VERTICES } from '../table/row-group-builder.js';
import {
  mergeRowBlockData,
  type RowBlockDataMerge,
  type RowBlockMerge,
} from '../table/row-group-merge.js';
import type { RowBlock, RowBlockData } from '../table/row-group-types.js';
import { createRowGroup, type RowGroup, type RowTable } from './row-table.js';
import type { RowsChange } from './tables-writer.js';
import type { GroupHandle, RowGroupHandle, RowHandle, TableWorkBudget } from './types.js';

/**
 * The work the tables hand to a Worker of the host: the functions of the
 * `@sakuzu/maplibre-gl-draw/table` subpath, run there on copies of the columns.
 *
 * What is handed over can be posted as it is: it holds no function. The Worker gives the
 * system of the coordinates to the builder when the tables are given one
 * (`TablesStoreOptions.coordinateSystem`); the builder of the entry draws the rings the
 * tables draw.
 *
 * @example A Worker of the host
 * ```ts
 * // in the Worker
 * import {
 *   createRowBlockBuilder,
 *   mergeRowBlock,
 *   transferList,
 * } from '@sakuzu/maplibre-gl-draw/kasane';
 * self.onmessage = ({ data }) => {
 *   const blocks = data.merge
 *     ? mergeRowBlock(data.merge)
 *     : build(data.rows, data.options); // createRowBlockBuilder, addRow, finish
 *   self.postMessage({ id: data.id, blocks }, transferList(blocks));
 * };
 * ```
 */
export interface FeatureTablesWorker {
  /** Merges rows of blocks (`mergeRowBlock`): the next version of blocks */
  merge(merge: RowBlockMerge): Promise<RowBlock[]>;
  /** Builds rows into blocks (`createRowBlockBuilder`): many new rows written at once */
  build(rows: readonly RowInput[], options: RowBlockBuilderOptions): Promise<RowBlock[]>;
}

/**
 * The frames the changes of a group are gathered for before its next version starts (a first
 * estimate, to be set from measured data)
 *
 * @internal
 */
export const VERSION_WAIT_FRAMES = 2;

/**
 * The rows a next version is merged with on the main thread at most; larger ones go to the
 * Worker of the host when it has one
 *
 * @internal
 */
export const FOLD_INLINE_ROWS = 8192;

/**
 * The bytes the versions started and not swapped yet may hold together (a whole-table change
 * goes a group at a time within it)
 *
 * @internal
 */
export const PENDING_VERSION_BYTES = 64 * 1024 * 1024;

/** The bytes a row of a version is counted as (a polygon of 5 corners) */
const ROW_BYTES = 342;

/**
 * The share of the rows of a group moved since it was built past which the group is due for its
 * next version
 *
 * @internal
 */
export const MOVED_ROWS_SHARE = 1 / 8;

/** The number of moved rows a group always keeps before it is due */
const MOVED_ROWS_MIN = 64;

/** Where a version is in its life */
export type GroupVersionStatus = 'building' | 'built' | 'uploaded' | 'swapped' | 'dropped';

/**
 * A next version of row groups of a table
 *
 * @internal
 */
export interface GroupVersion {
  readonly id: number;
  readonly table: RowTable;
  /** The groups it replaces, in their order (none for the first group of a table) */
  readonly replaces: readonly RowGroup[];
  /** The groups of the version once built */
  groups: RowGroup[] | null;
  /**
   * The write mark when it started: it takes the rows of the delta last written up to it (but the
   * ones in `stays`)
   */
  readonly deltaMark: number;
  /**
   * The rows of the delta that stay there when it is swapped in, whatever their marks: kept there
   * when it started (held by the user of the tables), held since, or written or come in since under its mark
   */
  readonly stays: Set<RowHandle>;
  /**
   * The groups its rows name, and the versions of their keys it was made with (a
   * version whose rows are in the order of other keys is dropped)
   */
  readonly keys: ReadonlyMap<GroupHandle, number>;
  /**
   * Whether it takes the rows of the deltas in its range (a next version), or only puts the rows
   * of its groups in another order (a reorder of groups)
   */
  readonly takesDelta: boolean;
  /** The keys of groups the swap puts in (a reorder; null for none) */
  readonly orders: ReadonlyMap<GroupHandle, string> | null;
  status: GroupVersionStatus;
  /**
   * Whether it went in without waiting for part of its GPU side (a side that draws the rows in
   * parts, a draped drawing: what it does not wait for keeps its old copy until it is made)
   */
  partial: boolean;
  /** The values written in place of the rows of its groups since it started, in their order */
  readonly log: InPlaceEntry[];
  /** The rows deleted it leaves out (nothing keeps them), of its groups and of the delta */
  readonly dropped: RowHandle[];
}

/** A write in place of a row of a group whose next version is being made */
export interface InPlaceEntry {
  readonly handle: RowHandle;
  readonly fields: ReadonlyMap<string, unknown>;
  readonly deleted: boolean;
}

/**
 * A side that draws the rows: the versions wait for its GPU side before they are swapped
 *
 * @internal
 */
export interface GroupVersionReceiver {
  /**
   * Whether the GPU side of a version built is up: `true`, `'partial'` when the side does not
   * wait for part of it, or `false`
   */
  uploaded(version: GroupVersion): boolean | 'partial';
  /** The version replaced its groups */
  swapped(version: GroupVersion): void;
  /** The version was dropped (its groups are not replaced) */
  dropped(version: GroupVersion): void;
}

/**
 * What the versions read and write of the tables
 *
 * @internal
 */
export interface VersionHost {
  /** The tables */
  tables(): Iterable<RowTable>;
  /** The write mark the rows written now are stamped with (`write-marks.ts`) */
  readonly writeMark: number;
  /** The handle a new group gets */
  nextGroupHandle(): RowGroupHandle;
  /** Whether the row of a handle has a copy in a delta */
  inDelta(handle: RowHandle): boolean;
  /** Whether a row of a delta is drawn only (a row drawn over a row): no version takes it */
  drawnOnly(handle: RowHandle): boolean;
  /** Whether a next version leaves a row out: deleted, and nothing keeps it */
  drops(handle: RowHandle, group: RowGroup, row: number): boolean;
  /** The group of the copy of the row of a handle read in a group (-1 for none) */
  mainGroup(handle: RowHandle): RowGroupHandle;
  /** The values of a row with what was written in place, as the builder takes them */
  rowInput(group: RowGroup, row: number): RowInput;
  /**
   * Builds rows into one row group of coordinates of dimensions, numbered and with their handles
   * (null for none)
   */
  buildRows(inputs: readonly RowInput[], dims: CoordinateDimensions): RowBlockData | null;
  /** The system of the coordinates of the rows */
  readonly coordinates: CoordinateSystem;
  /** The number of coordinates a row that draws a ring is counted as (`RowRings.ringVertices`) */
  readonly ringVertices: number;
  /** The keys of the order of the groups */
  readonly groupKeys: RowBlockDataMerge['groups'];
  /** The same as a list (what a Worker is sent) */
  groupKeyList(): GroupEntry[];
  /** The version of the key of the order of a group */
  orderVersionOf(group: GroupHandle): number;
  /** Puts the groups of a version in place of the ones it replaces (see `GroupVersions.swap`) */
  swapIn(version: GroupVersion, waiting: WaitingCopies): RowsChange | null;
  /** Counts the styles of the rows of groups as used (or not any more) */
  retainStyles(data: RowBlockData, count: 1 | -1): void;
  /** The Worker of the host (none: everything on the main thread) */
  readonly worker: FeatureTablesWorker | undefined;
  /** Asks for a frame (work is left) */
  requestWork(): void;
  /** Reports a version that went wrong (there is no caller to throw to) */
  report(error: unknown): void;
}

/**
 * The copies of rows waiting in a group for the next version of the group they came from: by
 * handle, the group and the row, and the write mark the version took the rows of the delta up to
 * (-1 once the row of the delta is not the copy any more: it was held, or written under that mark
 * after the version started)
 *
 * @internal
 */
export type WaitingCopies = Map<RowHandle, { group: RowGroup; row: number; mark: number }>;

/**
 * The next versions of the row groups of the tables
 *
 * @internal
 */
export class GroupVersions {
  /** The versions started and not swapped or dropped */
  private readonly pending = new Map<number, GroupVersion>();
  /** The version each group being replaced is locked by */
  private readonly locked = new Map<RowGroupHandle, GroupVersion>();
  /** The groups due for their next version, with the frame they were first seen due in */
  private readonly due = new Map<RowGroupHandle, number>();
  /** The groups whose next version goes first (the frames cut them too much) */
  private readonly urged = new Set<RowGroupHandle>();
  private readonly receivers = new Set<GroupVersionReceiver>();
  readonly waiting: WaitingCopies = new Map();
  private frame = 0;
  private nextId = 1;
  /** The versions swapped (diagnostics) */
  swapped = 0;
  /** The bytes the versions held at once may take (`PENDING_VERSION_BYTES`) */
  pendingBytesLimit = PENDING_VERSION_BYTES;
  /** The most versions held at once so far (diagnostics) */
  mostPending = 0;
  /** The time the last merge on the main thread took (ms) */
  lastMergeMs = 0;

  constructor(private readonly host: VersionHost) {}

  /** Whether a version is started and not swapped, a group is due, or a delta has rows */
  get hasWork(): boolean {
    if (this.pending.size > 0 || this.due.size > 0) return true;
    for (const table of this.host.tables()) if (table.delta.hasFoldable()) return true;
    return false;
  }

  /** The versions built and waiting for the GPU side, of a table (of every table when omitted) */
  built(table?: RowTable): GroupVersion[] {
    const out: GroupVersion[] = [];
    for (const version of this.pending.values()) {
      if (version.status !== 'built' && version.status !== 'uploaded') continue;
      if (!table || version.table === table) out.push(version);
    }
    return out;
  }

  /** The version a group is locked by (undefined when none) */
  lockOf(group: RowGroupHandle): GroupVersion | undefined {
    return this.locked.get(group);
  }

  /** Adds a side that draws the rows; returns the function that takes it out */
  attach(receiver: GroupVersionReceiver): () => void {
    this.receivers.add(receiver);
    return () => {
      this.receivers.delete(receiver);
    };
  }

  /** Marks groups due for their next version first (the frames cut them too much) */
  urge(groups: Iterable<RowGroupHandle>): void {
    for (const group of groups) this.urged.add(group);
    this.host.requestWork();
  }

  /** Marks a group due for its next version */
  markDue(group: RowGroupHandle): void {
    if (!this.due.has(group)) this.due.set(group, this.frame);
  }

  /**
   * Records a write in place of a row of a group being replaced, to write it again into the
   * next version when it is swapped in
   */
  logWrite(group: RowGroupHandle, entry: InPlaceEntry): void {
    this.locked.get(group)?.log.push(entry);
  }

  /**
   * Whether a row of a delta written or come in under a mark can stay for a version or a copy
   * waiting (`rowChanged`): a version started under the mark, or a copy waiting
   */
  watches(mark: number): boolean {
    if (this.waiting.size > 0) return true;
    for (const version of this.pending.values()) if (version.deltaMark === mark) return true;
    return false;
  }

  /**
   * A row of a delta was written, or came in, under a mark: the versions started under the same
   * mark leave it in the delta, and so does the copy of it waiting that a version under the mark
   * made (the rows written in later frames have later marks)
   */
  rowChanged(handle: RowHandle, mark: number): void {
    for (const version of this.pending.values()) {
      if (version.deltaMark === mark) version.stays.add(handle);
    }
    const copy = this.waiting.get(handle);
    if (copy && copy.mark === mark) copy.mark = -1;
  }

  /**
   * Starts the next versions of the groups due, and builds them on the main thread within the
   * budget (a large one in the Worker of the host). Without a side that draws the rows, a
   * version built is swapped at once
   *
   * @param wait Whether the changes are gathered for a few frames first (false: start every
   *   version due now, the hosts without frames and the tests)
   */
  advance(budget: TableWorkBudget, wait = true): void {
    this.frame++;
    this.findDue();
    const order = [...this.due].sort(([a, af], [b, bf]) => {
      const urgent = Number(this.urged.has(b)) - Number(this.urged.has(a));
      return urgent !== 0 ? urgent : af - bf;
    });
    for (const [handle, since] of order) {
      if (!budget.canStep()) break;
      if (wait && !this.urged.has(handle) && this.frame - since < VERSION_WAIT_FRAMES) continue;
      if (this.locked.has(handle)) continue;
      const found = this.findGroup(handle);
      if (!found) {
        this.due.delete(handle);
        continue;
      }
      // While a reorder of the table waits, the keys of its groups are going to
      // change: the rows of the deltas written meanwhile are placed by the keys written, which a
      // version made now would read by the keys before. It is made once the reorder is in
      if (this.reorders(found.table).length > 0) continue;
      if (this.pendingBytes() + found.group.data.length * ROW_BYTES > this.pendingBytesLimit) {
        // The ones started are swapped first
        if (this.pending.size > 0) break;
      }
      budget.step(() => this.start(found.table, found.group));
    }
    // The first group of a table that has only rows of its delta
    for (const table of this.host.tables()) {
      if (table.groupCount > 0 || !table.delta.hasFoldable() || !budget.canStep()) continue;
      if ([...this.pending.values()].some((v) => v.table === table)) continue;
      budget.step(() => this.startGroups(table, []));
    }
    if (this.receivers.size === 0) this.swapReady();
    if (this.hasWork) this.host.requestWork();
  }

  /**
   * Swaps in the versions built whose GPU side every side that draws the rows has (called in
   * the pass before the main one, after the uploads)
   *
   * @returns The rows the swaps wrote (null when none was swapped)
   */
  swapReady(): RowsChange[] {
    const out: RowsChange[] = [];
    for (const version of [...this.pending.values()]) {
      if (version.status !== 'built' && version.status !== 'uploaded') continue;
      let partial = false;
      let ready = true;
      for (const receiver of this.receivers) {
        const answer = receiver.uploaded(version);
        if (answer === false) ready = false;
        if (answer === 'partial') partial = true;
      }
      if (!ready) continue;
      version.status = 'uploaded';
      version.partial = partial;
      const change = this.swap(version);
      if (change) out.push(change);
    }
    return out;
  }

  /**
   * Drops every version started, and forgets the groups due and the copies waiting (the rows are
   * taken out of the tables): a version a Worker is building is not taken in when it comes back
   */
  clear(): void {
    for (const version of [...this.pending.values()]) this.drop(version);
    this.pending.clear();
    this.locked.clear();
    this.due.clear();
    this.urged.clear();
    this.waiting.clear();
  }

  /** Drops the version a group is locked by (its groups are cut or reordered meanwhile) */
  dropLock(group: RowGroupHandle): void {
    const version = this.locked.get(group);
    if (version) this.drop(version);
  }

  // === The versions ===

  /**
   * The groups that need their next version, found from the rows of the deltas: the group a row
   * of a delta comes into, and the group its copy left (in this table or another)
   */
  private findDue(): void {
    for (const table of this.host.tables()) {
      const delta = table.delta.group;
      if (!delta) continue;
      const places = table.deltaPlaces();
      for (let k = 0; k < delta.data.length; k++) {
        // A row the user of the tables holds stays in the delta until it is no longer held
        if (table.delta.isKept(k)) continue;
        const g = places.groups[k];
        if (g >= 0) this.markDue(table.groupAt(g).handle);
        const main = this.host.mainGroup(delta.data.handles[k]);
        if (main >= 0) this.markDue(main);
      }
    }
  }

  /** Marks a group due when many of its rows moved since it was built */
  checkMoved(group: RowGroup): void {
    const moved = Math.max(MOVED_ROWS_MIN, group.data.length * MOVED_ROWS_SHARE);
    if (group.unindexedCount > moved) this.markDue(group.handle);
  }

  private findGroup(handle: RowGroupHandle): { table: RowTable; group: RowGroup } | null {
    for (const table of this.host.tables()) {
      const group = table.group(handle);
      if (group) return { table, group };
    }
    return null;
  }

  private pendingBytes(): number {
    let rows = 0;
    for (const version of this.pending.values()) {
      for (const group of version.replaces) rows += group.data.length;
    }
    return rows * ROW_BYTES;
  }

  /** Starts the next version of a group, with its neighbor when it is small */
  private start(table: RowTable, group: RowGroup): void {
    const groups = [group];
    const data = group.data;
    if (
      data.length < ROW_BLOCK_TARGET_ROWS / 4 &&
      data.vertexCount < ROW_BLOCK_TARGET_VERTICES / 4 &&
      table.groupCount > 1
    ) {
      const at = table.orderOf(group.handle);
      const neighbor = at + 1 < table.groupCount ? table.groupAt(at + 1) : table.groupAt(at - 1);
      if (!this.locked.has(neighbor.handle)) {
        if (table.orderOf(neighbor.handle) > at) groups.push(neighbor);
        else groups.unshift(neighbor);
      }
    }
    this.startGroups(table, groups);
  }

  /**
   * Starts the next version of groups next to each other in the order (none: the first group of
   * a table from its delta): takes their rows that stay and the rows of the delta in their range,
   * and merges them on the main thread, or in the Worker of the host when they are many
   */
  private startGroups(
    table: RowTable,
    groups: RowGroup[],
    orders: ReadonlyMap<GroupHandle, string> | null = null,
  ): void {
    const host = this.host;
    const version: GroupVersion = {
      id: this.nextId++,
      table,
      replaces: groups,
      groups: null,
      deltaMark: host.writeMark,
      stays: new Set(),
      keys: new Map(),
      takesDelta: true,
      orders,
      status: 'building',
      partial: false,
      log: [],
      dropped: [],
    };
    for (const group of groups) {
      this.locked.set(group.handle, version);
      this.due.delete(group.handle);
      this.urged.delete(group.handle);
    }
    const merge = this.mergeOf(table, groups, version.dropped, version.stays);
    (version as { keys: ReadonlyMap<GroupHandle, number> }).keys = this.keysOf(merge);
    this.pending.set(version.id, version);
    this.mostPending = Math.max(this.mostPending, this.pending.size);
    const rows = merge.rows.length / 2;
    const worker = host.worker;
    if (worker && rows > FOLD_INLINE_ROWS) {
      worker.merge({ ...merge, groups: host.groupKeyList() }).then(
        (built) => {
          if (version.status !== 'building') return;
          // The keys of the groups of its rows changed meanwhile: dropped (the
          // rows are in another order), and the groups are due again
          if (!this.sameKeys(version)) {
            this.drop(version);
            for (const group of groups) this.markDue(group.handle);
            return;
          }
          // The host builds and merges with the builder and the merge of the library
          this.finish(version, built as RowBlockData[]);
          host.requestWork();
        },
        (error) => {
          host.report(error);
          this.drop(version);
        },
      );
      return;
    }
    const start = typeof performance !== 'undefined' ? performance.now() : Date.now();
    this.finish(version, mergeRowBlockData(merge));
    this.lastMergeMs =
      (typeof performance !== 'undefined' ? performance.now() : Date.now()) - start;
  }

  /**
   * What a next version merges: the rows that stay, and the rows of the delta in its range (the
   * rows deleted that nothing keeps are left out, into `dropped`; the rows of the delta kept there
   * go into `stays`)
   */
  private mergeOf(
    table: RowTable,
    groups: readonly RowGroup[],
    dropped: RowHandle[],
    stays: Set<RowHandle>,
  ): RowBlockDataMerge {
    const host = this.host;
    const sources: RowBlockData[] = [];
    const pairs: number[] = [];
    const inputs: RowInput[] = [];
    for (const group of groups) {
      const source = sources.length;
      sources.push(group.data);
      for (let r = 0; r < group.data.length; r++) {
        const handle = group.data.handles[r];
        // A row with a copy in a delta is read there, and a copy waiting for another group is
        // not the row
        if (host.inDelta(handle) || host.mainGroup(handle) !== group.handle) continue;
        if (host.drops(handle, group, r)) {
          dropped.push(handle);
          continue;
        }
        if (writtenInPlace(group, r)) inputs.push(host.rowInput(group, r));
        else pairs.push(source, r);
      }
    }
    // The rows of the delta whose places are in the range of the groups
    const delta = table.delta.group;
    if (delta) {
      const places = table.deltaPlaces();
      const indices = new Set(groups.map((group) => table.orderOf(group.handle)));
      if (groups.length === 0) indices.add(-1);
      const source = sources.length;
      sources.push(delta.data);
      for (let k = 0; k < delta.data.length; k++) {
        if (!indices.has(places.groups[k])) continue;
        if (host.drawnOnly(delta.data.handles[k])) continue;
        if (table.delta.isKept(k)) stays.add(delta.data.handles[k]);
        // A row deleted read here is left out when its copy in a group goes with the version too
        const main = host.mainGroup(delta.data.handles[k]);
        if (
          host.drops(delta.data.handles[k], delta, k) &&
          (main < 0 || groups.some((group) => group.handle === main))
        ) {
          dropped.push(delta.data.handles[k]);
          continue;
        }
        if (writtenInPlace(delta, k)) inputs.push(host.rowInput(delta, k));
        else pairs.push(source, k);
      }
    }
    if (inputs.length > 0) {
      const built = host.buildRows(inputs, table.dims);
      if (built) {
        sources.push(built);
        for (let r = 0; r < built.length; r++) pairs.push(sources.length - 1, r);
      }
    }
    return {
      sources,
      rows: Int32Array.from(pairs),
      groups: host.groupKeys,
      cutPast: 2,
      dimensions: table.dims,
      ringVertices: host.ringVertices,
    };
  }

  /**
   * The versions of the keys of the groups the rows of a merge name (a version built
   * with other keys has its rows in another order)
   */
  private keysOf(merge: RowBlockDataMerge): Map<GroupHandle, number> {
    const out = new Map<GroupHandle, number>();
    for (let i = 0; i < merge.rows.length; i += 2) {
      const group = merge.sources[merge.rows[i]].groups[merge.rows[i + 1]];
      if (group >= 0 && !out.has(group)) out.set(group, this.host.orderVersionOf(group));
    }
    return out;
  }

  /** Whether the keys of the groups of the rows of a version are the ones it has */
  private sameKeys(version: GroupVersion): boolean {
    for (const [group, generation] of version.keys) {
      if (this.host.orderVersionOf(group) !== generation) return false;
    }
    return true;
  }

  /** Makes the groups of a version built (their styles counted while they are held) */
  private finish(version: GroupVersion, built: RowBlockData[]): void {
    const host = this.host;
    const reuse = version.replaces.length === 1 && built.length === 1;
    version.groups = built.map((data) => {
      host.retainStyles(data, 1);
      const handle = reuse ? version.replaces[0].handle : host.nextGroupHandle();
      return createRowGroup(handle, data, host.writeMark);
    });
    version.status = 'built';
  }

  /** Puts a version in place of its groups (see the module) */
  private swap(version: GroupVersion): RowsChange | null {
    for (const group of version.replaces) {
      if (version.table.group(group.handle) !== group) {
        this.drop(version);
        return null;
      }
    }
    // Made with other keys of groups (a reorder swapped since): made again
    if (!this.sameKeys(version)) {
      this.drop(version);
      return null;
    }
    // A group taken in within its range since it started (the rows of a run built into groups
    // of their own, while the first group of the delta of the table was made): its groups would
    // overlap it. Dropped: its rows stay where they are read now (the delta), and the next
    // version of the group they fall in takes them
    if (
      version.orders === null &&
      version.table.overlapsAfter(version.replaces, version.groups ?? [])
    ) {
      this.drop(version);
      this.host.requestWork();
      return null;
    }
    const change = this.host.swapIn(version, this.waiting);
    this.release(version);
    version.status = 'swapped';
    this.swapped++;
    for (const receiver of this.receivers) receiver.swapped(version);
    return change;
  }

  /** Drops a version: its groups are not replaced, and are due again */
  private drop(version: GroupVersion): void {
    if (version.status === 'dropped' || version.status === 'swapped') return;
    for (const group of version.groups ?? []) this.host.retainStyles(group.data, -1);
    this.release(version);
    version.status = 'dropped';
    for (const group of version.replaces) this.markDue(group.handle);
    for (const receiver of this.receivers) receiver.dropped(version);
  }

  private release(version: GroupVersion): void {
    this.pending.delete(version.id);
    for (const group of version.replaces) {
      if (this.locked.get(group.handle) === version) this.locked.delete(group.handle);
    }
  }

  /**
   * Starts a version that puts the rows of groups in another order (the keys of groups
   * changed): its groups are the groups cut at the runs of the members, built already,
   * and the keys go in when it is swapped. A version of the groups being made is dropped
   */
  startReorder(
    table: RowTable,
    groups: RowGroup[],
    built: RowBlockData[],
    orders: ReadonlyMap<GroupHandle, string>,
  ): GroupVersion {
    for (const group of groups) this.dropLock(group.handle);
    for (const version of this.reorders(table)) this.drop(version);
    const version: GroupVersion = {
      id: this.nextId++,
      table,
      replaces: groups,
      groups: null,
      deltaMark: this.host.writeMark,
      stays: new Set(),
      keys: new Map(),
      takesDelta: false,
      orders,
      status: 'building',
      partial: false,
      log: [],
      dropped: [],
    };
    for (const group of groups) {
      this.locked.set(group.handle, version);
      this.due.delete(group.handle);
    }
    this.pending.set(version.id, version);
    const host = this.host;
    version.groups = built.map((data) => {
      host.retainStyles(data, 1);
      return createRowGroup(host.nextGroupHandle(), data, host.writeMark);
    });
    version.status = 'built';
    if (this.receivers.size === 0) this.swapReady();
    host.requestWork();
    return version;
  }

  /** The versions pending that put keys of a group in */
  reordersOf(group: GroupHandle): GroupVersion[] {
    return [...this.pending.values()].filter((version) => version.orders?.has(group));
  }

  /** The reorders pending of a table */
  reorders(table: RowTable | undefined): GroupVersion[] {
    return [...this.pending.values()].filter(
      (version) => version.orders !== null && version.table === table,
    );
  }

  /** The bounds of the groups a version replaces and of its new ones */
  static boundsOf(version: GroupVersion): BBox | null {
    let out: BBox | null = null;
    for (const group of [...version.replaces, ...(version.groups ?? [])]) {
      const b = group.bounds;
      if (!b) continue;
      out = out
        ? [
            Math.min(out[0], b[0]),
            Math.min(out[1], b[1]),
            Math.max(out[2], b[2]),
            Math.max(out[3], b[3]),
          ]
        : [b[0], b[1], b[2], b[3]];
    }
    return out;
  }
}

/** Whether a row holds values written in place (it is built again with them) */
function writtenInPlace(group: RowGroup, row: number): boolean {
  return (
    group.values?.has(row) === true ||
    group.geometries?.geometry(row) !== undefined ||
    group.geometries?.holdsCacheNumbers(row) === true
  );
}
