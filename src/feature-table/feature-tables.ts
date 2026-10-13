// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The implementation of the features of a document held as rows of columns
 *
 * The reading and writing sides are declared in `api/tables.ts`. Here are the tables
 * themselves: the ids and their handles, the styles, the groups of features, the state of the
 * rows, the row groups of every layer and the rows changed since (the delta of each layer). The
 * drawing and the hit testing read them through `featureTablesInternals`.
 *
 * A row is read from one place: its row in its group, or its copy in the delta of a layer when
 * it has one (the copy in its group is hidden then, `STATE_HIDDEN_DELTA`). A write that fits the
 * columns of its row is written in place; a write that moves the row in the order or to another
 * layer, and a new row, put a copy of the row in the delta.
 */

import type {
  FeatureTables,
  FeatureTablesOptions,
  FeatureTablesWorker,
  FeatureTablesWriter,
  ItemRefs,
  LayerRowsChange,
  LayerTableView,
  RowApplyOptions,
  RowCursor,
  RowField,
  RowHandle,
  RowPatch,
  RowsChange,
  TableGroupPatch,
  TableScanOptions,
} from '../api/tables.js';
import type { BBox } from '../geometry/types.js';
import { drawPropertyKey } from '../shared/properties.js';
import type { BoundingBox, Feature, FeatureStyle, FeatureType } from '../shared/types/model.js';
import {
  createRowGroupBuilder,
  ROW_GROUP_TARGET_ROWS,
  type RowInput,
} from '../table/row-group-builder.js';
import { mergeRowGroup } from '../table/row-group-merge.js';
import {
  ROW_FLAG_DELETED,
  ROW_FLAG_LOCKED,
  ROW_FLAG_VISIBLE,
  type RowGroupData,
} from '../table/row-group-types.js';
import { compareRowKeys, type RowKeySource } from '../table/row-keys.js';
import { utf8ColumnFromStrings, utf8ColumnLength, utf8String } from '../table/utf8-column.js';
import { ValueStringCache } from '../table/value-column.js';
import { GroupTable } from './group-table.js';
import { IdIndex } from './id-index.js';
import { createRowGroup, LayerTable, overrideBytesOf, type RowGroup } from './layer-table.js';
import {
  type RowReadContext,
  rowFeature,
  rowInputOf,
  rowPoint,
  rowType,
  rowValue,
} from './row-read.js';
import {
  RowStateSets,
  STATE_HIDDEN_DELETED,
  STATE_HIDDEN_DELTA,
  STATE_HIDDEN_GROUP,
  STATE_HIDDEN_INVISIBLE,
  STATE_HIDDEN_MASK,
  STATE_HIDDEN_WAIT,
  STATE_UNIFORM,
  toGpuState,
} from './row-state.js';
import {
  type GeometryWrite,
  isRadiusKey,
  refreshRowShape,
  writeRowGeometry,
  writeRowValue,
} from './row-write.js';
import { StyleTable } from './style-table.js';
import {
  type GroupHandle,
  ROW_WRITE_GEOMETRY,
  ROW_WRITE_STATE,
  ROW_WRITE_STYLE,
  ROW_WRITE_VALUES,
  type RowGroupHandle,
  type RowWrite,
  type TableWorkBudget,
} from './types.js';
import { OVERRIDE_BYTES_LIMIT } from './value-overrides.js';
import {
  type GroupVersion,
  type GroupVersionReceiver,
  GroupVersions,
  type VersionHost,
  type WaitingCopies,
} from './versions.js';

/** The key of the created zoom: the cutting of the rows into chunks reads it */
const CREATED_ZOOM_KEY = drawPropertyKey('createdZoom');

/** The attributes the cutting of the rows into chunks reads (a write of one moves the row) */
const CLASSIFY_KEYS: ReadonlySet<string> = new Set([CREATED_ZOOM_KEY]);

/** The fields that place a row in the order of its layer or in another layer */
const PLACE_FIELDS: ReadonlySet<string> = new Set([
  'type',
  'layerId',
  'groupId',
  'order',
  'member',
]);

/** The number of handles a scan reads at a time when not told */
const SCAN_BATCH = 1024;

/** A size no group of rows reaches: the rows of a delta are one group */
const UNBOUNDED = Number.MAX_SAFE_INTEGER;

/**
 * The fewest new rows of one write built into row groups of their own rather than put in the
 * delta (fewer go to the delta, drawn from the frame they are written in; a first estimate, to be
 * set from measured data)
 *
 * @internal
 */
export const CREATE_GROUP_MIN_ROWS = 64;

/**
 * The frames the new rows of a creation wait for more written after them before they are built
 * (the writes of a large import come a part at a time)
 *
 * @internal
 */
export const CREATE_WAIT_FRAMES = 2;

/**
 * Creates the tables of the features of a document, as its reading and writing sides (the
 * implementation of `createFeatureTables`)
 *
 * @internal
 */
export function createFeatureTablesStore(options: FeatureTablesOptions = {}): {
  tables: FeatureTables;
  writer: FeatureTablesWriter;
} {
  const store = new FeatureTablesStore(options);
  const tables: FeatureTables = {
    layer: (layerId) => store.view(layerId),
    handleOf: (id) => store.handleOf(id),
    idOf: (handle) => store.ids.idOf(handle),
    scan: (options) => store.scan(options ?? {}),
  };
  const writer: FeatureTablesWriter = {
    allocateHandles: (ids, hashes) => store.ids.allocate(ids, hashes),
    adopt: (layerId, groups) => store.adopt(layerId, groups),
    apply: (patch, options) => store.apply(patch, options),
    applyGroups: (patch, options) => store.applyGroups(patch, options),
  };
  INTERNALS.set(tables, store);
  return { tables, writer };
}

/**
 * Where a row is read: its group (a group of a layer, or the group of the delta of a layer) and
 * its row there
 *
 * @internal
 */
export interface RowPlace {
  readonly layer: LayerTable;
  readonly group: RowGroup;
  readonly row: number;
}

/**
 * What core reads of the tables besides the reading side (the drawing, the hit testing)
 *
 * @internal
 */
export interface FeatureTablesInternals {
  readonly ids: IdIndex;
  readonly styles: StyleTable;
  readonly groups: GroupTable;
  readonly states: RowStateSets;
  readonly strings: ValueStringCache;
  readonly readContext: RowReadContext;
  /** Changes with every change of the rows drawn of any layer */
  readonly revision: number;
  /** The rows of a layer (undefined for a layer that holds none) */
  layerTable(layerId: string): LayerTable | undefined;
  /** The layer and the row group of a handle of a row group */
  rowGroup(handle: RowGroupHandle): { layer: LayerTable; group: RowGroup } | undefined;
  /** Where the row of a handle is read (undefined for a handle of no row) */
  placeOf(handle: RowHandle): RowPlace | undefined;
  /** The handles of the row groups of a set of rows, the rows by group */
  groupsOfRows(handles: Int32Array): Map<RowGroupHandle, number[]>;
  /** Whether row groups given to `adopt` are still waiting to be taken in */
  readonly hasPendingAdoption: boolean;
  /**
   * Takes in the row groups waiting, one group per step, within the budget of the frame (at
   * least one group per call). A group that cannot be taken in is left out and reported
   *
   * @returns Whether groups are still waiting
   */
  advanceAdoption(budget: TableWorkBudget): boolean;
  /**
   * Takes in every row group waiting at once (a host without frames, the tests)
   *
   * @throws when a group cannot be taken in (the groups after it keep waiting)
   */
  flushAdoption(): void;
  /**
   * Calls `listener` when row groups start waiting, so the drawing asks for a frame
   *
   * @returns The function that stops the calls
   */
  onPendingWork(listener: () => void): () => void;
  /**
   * Calls `listener` with the rows of a layer written in place, so the drawing writes them
   * into the chunks that draw them (the rows of the delta of a layer name the handle of the
   * delta, `DeltaRows.handle`)
   *
   * @returns The function that stops the calls
   */
  onRowsWritten(listener: (layerId: string, writes: readonly RowWrite[]) => void): () => void;
  /**
   * Calls `listener` when the rows of the delta of a layer came in, left or were made again, so
   * the drawing packs them again before its next frame
   *
   * @returns The function that stops the calls
   */
  onDeltaChanged(listener: (layerId: string) => void): () => void;
  /**
   * Puts rows of groups into the delta of their layer as they are: rows whose change the
   * drawing could not write into their places (more coordinates than the place holds, another
   * kind of run). Their copy in their group is hidden from then on
   */
  toDelta(handles: readonly RowHandle[]): void;
  /**
   * The row groups whose values written in place hold more than `OVERRIDE_BYTES_LIMIT` bytes:
   * they are due for their next version
   */
  readonly groupsDue: ReadonlySet<RowGroupHandle>;
  /** The bytes the values written in place of every row group hold */
  overrideBytes(): number;
  /** The rows moved since their row groups were built, over every layer */
  movedRowCount(): number;
  /** The rows held by the deltas of every layer */
  deltaRowCount(): number;
  /** Whether work is left: row groups to take in, next versions of row groups to make */
  readonly hasPendingWork: boolean;
  /**
   * Starts the next versions of the row groups due and builds them within the budget of the
   * frame (`versions.ts`); without a side that draws the rows attached, a version built is
   * swapped at once
   */
  advanceVersions(budget: TableWorkBudget): void;
  /**
   * Swaps in the next versions built whose GPU side every side that draws the rows has (the
   * pass before the main one of a frame, after its uploads)
   */
  swapVersions(): void;
  /**
   * Starts, builds and swaps every next version due at once, as far as the sides that draw the
   * rows let (a host without frames, the tests)
   */
  flushVersions(): void;
  /** The next versions built and waiting for the GPU side, of a layer */
  builtVersions(layerId: string): GroupVersion[];
  /** Adds a side that draws the rows: the versions wait for its GPU side */
  attachReceiver(receiver: GroupVersionReceiver): () => void;
  /** Makes the next versions of groups go first (the frames cut them too much) */
  urgeVersions(groups: Iterable<RowGroupHandle>): void;
  /**
   * Calls `listener` with the extent of the rows whose drawing changed (rows of a delta that came
   * in, left or were written, row groups replaced): what a side that draws the rows in tiles
   * makes again
   *
   * @returns The function that stops the calls
   */
  onTouched(listener: (layerId: string, bounds: BoundingBox) => void): () => void;
  /** What the versions did: swapped so far, pending, the time of the last merge (ms) */
  versionStats(): { swapped: number; pending: number; lastMergeMs: number };
}

const INTERNALS = new WeakMap<FeatureTables, FeatureTablesStore>();

/**
 * The internals of tables made by {@link createFeatureTables} (undefined for an object made
 * elsewhere)
 *
 * @internal
 */
export function featureTablesInternals(
  tables: FeatureTables | undefined,
): FeatureTablesInternals | undefined {
  return tables ? INTERNALS.get(tables) : undefined;
}

/** A row of a patch that comes into the delta of a layer */
interface DeltaInput {
  readonly handle: RowHandle;
  readonly input: RowInput;
}

/**
 * New rows of a layer built into row groups of their own (6.5 of the design): a run of keys no
 * row of the layer is within, at a place between two groups (or before the first, after the
 * last), gathered over the writes that continue it
 */
interface Creation {
  readonly layer: LayerTable;
  readonly rows: DeltaInput[];
  /** The keys of the first and the last row */
  first: RowKeySource;
  last: RowKeySource;
  /** The frames since a row was added */
  idle: number;
  status: 'gathering' | 'building' | 'done';
}

/** What a change wrote to the rows of one layer, as it is gathered */
interface LayerChangeDraft {
  readonly created: number[];
  readonly updated: number[];
  readonly deleted: number[];
  readonly fields: Set<RowField>;
  readonly styleKeys: Set<string>;
}

/** The implementation of the tables */
class FeatureTablesStore implements FeatureTablesInternals {
  readonly ids = new IdIndex();
  readonly styles = new StyleTable();
  readonly groups = new GroupTable();
  readonly strings: ValueStringCache;
  readonly states: RowStateSets;
  readonly readContext: RowReadContext;
  private readonly layers = new Map<string, LayerTable>();
  /** The layers by their serial number */
  private readonly layerList: LayerTable[] = [];
  private readonly views = new Map<string, LayerTableView>();
  private readonly rowGroups = new Map<RowGroupHandle, { layer: LayerTable; group: RowGroup }>();
  private nextGroup = 0;
  private revisionCount = 0;
  /** The number of the last change written (the rows of the delta keep the one they were in) */
  private writeCount = 0;
  /** The row groups given to `adopt` and not taken in yet, in the order they were given */
  private readonly adoptions: Array<{
    layer: LayerTable;
    data: RowGroupData;
    /** Whether the group is new rows written (put in the delta when it cannot be taken in) */
    created?: boolean;
  }> = [];
  /** The new rows built into groups of their own, being gathered or built */
  private readonly creations: Creation[] = [];
  /** The creation of each row in one */
  private readonly creationOf = new Map<RowHandle, Creation>();
  private readonly workListeners = new Set<() => void>();
  private readonly writeListeners = new Set<
    (layerId: string, writes: readonly RowWrite[]) => void
  >();
  private readonly deltaListeners = new Set<(layerId: string) => void>();
  private readonly touchListeners = new Set<(layerId: string, bounds: BoundingBox) => void>();
  readonly groupsDue = new Set<RowGroupHandle>();
  private readonly versions: GroupVersions;
  private readonly worker: FeatureTablesWorker | undefined;

  constructor(options: FeatureTablesOptions) {
    this.strings = new ValueStringCache(options.stringCacheSize);
    this.states = new RowStateSets((handles) => this.refreshStates(handles));
    this.readContext = { styles: this.styles, groups: this.groups, strings: this.strings };
    this.worker = options.worker;
    this.versions = new GroupVersions(this.versionHost());
  }

  /** What the versions read and write of the tables */
  private versionHost(): VersionHost {
    const store = this;
    return {
      layers: () => this.layers.values(),
      get writeNumber() {
        return store.writeCount;
      },
      nextGroupHandle: () => this.nextGroup++,
      inDelta: (handle) => this.ids.deltaLayer(handle) >= 0,
      mainGroup: (handle) => this.ids.mainGroup(handle),
      rowInput: (group, row) => rowInputOf(this.readContext, group, row),
      buildRows: (inputs) => this.buildRows(inputs),
      groupKeys: this.groups,
      orderVersionOf: (group) => this.groups.orderVersionOf(group),
      swapIn: (version, waiting) => this.swapIn(version, waiting),
      retainStyles: (data, count) => {
        for (let r = 0; r < data.length; r++) {
          if (count > 0) this.styles.retain(data.styles[r]);
          else this.styles.release(data.styles[r]);
        }
      },
      worker: this.worker,
      requestWork: () => this.notifyWork(),
      report: (error) => console.error(error),
    };
  }

  get hasPendingWork(): boolean {
    return this.adoptions.length > 0 || this.creations.length > 0 || this.versions.hasWork;
  }

  advanceVersions(budget: TableWorkBudget): void {
    this.advanceCreations(budget, true);
    this.versions.advance(budget);
  }

  swapVersions(): void {
    this.versions.swapReady();
  }

  flushVersions(): void {
    const unbounded = UNBOUNDED_BUDGET;
    this.flushAdoption();
    for (let i = 0; i < 64 && (i === 0 || this.versions.hasWork); i++) {
      const before = this.versions.swapped;
      this.versions.advance(unbounded, false);
      this.versions.swapReady();
      if (this.versions.swapped === before && this.versions.built().length > 0) break;
    }
  }

  builtVersions(layerId: string): GroupVersion[] {
    const layer = this.layers.get(layerId);
    return layer ? this.versions.built(layer) : [];
  }

  attachReceiver(receiver: GroupVersionReceiver): () => void {
    return this.versions.attach(receiver);
  }

  urgeVersions(groups: Iterable<RowGroupHandle>): void {
    this.versions.urge(groups);
  }

  onTouched(listener: (layerId: string, bounds: BoundingBox) => void): () => void {
    this.touchListeners.add(listener);
    return () => {
      this.touchListeners.delete(listener);
    };
  }

  versionStats(): { swapped: number; pending: number; lastMergeMs: number } {
    return {
      swapped: this.versions.swapped,
      pending: this.versions.built().length,
      lastMergeMs: this.versions.lastMergeMs,
    };
  }

  /** Tells the sides that draw in tiles the extent of rows whose drawing changed */
  private touch(layerId: string, bounds: BoundingBox | null): void {
    if (!bounds || this.touchListeners.size === 0) return;
    for (const listener of this.touchListeners) listener(layerId, bounds);
  }

  get revision(): number {
    return this.revisionCount;
  }

  layerTable(layerId: string): LayerTable | undefined {
    return this.layers.get(layerId);
  }

  rowGroup(handle: RowGroupHandle): { layer: LayerTable; group: RowGroup } | undefined {
    return this.rowGroups.get(handle);
  }

  /** The rows of a layer, made when first written */
  private layerOf(layerId: string): LayerTable {
    let layer = this.layers.get(layerId);
    if (!layer) {
      layer = new LayerTable(layerId, this.groups, this.layerList.length, this.nextGroup++);
      this.layers.set(layerId, layer);
      this.layerList.push(layer);
    }
    return layer;
  }

  view(layerId: string): LayerTableView | undefined {
    const layer = this.layers.get(layerId);
    if (!layer) return undefined;
    let view = this.views.get(layerId);
    if (!view) {
      view = new LayerTableViewImpl(this, layer);
      this.views.set(layerId, view);
    }
    return view;
  }

  placeOf(handle: RowHandle): RowPlace | undefined {
    const serial = this.ids.deltaLayer(handle);
    if (serial >= 0) {
      const layer = this.layerList[serial];
      const group = layer.delta.group;
      if (group) return { layer, group, row: this.ids.deltaSlot(handle) };
    }
    const placed = this.rowGroups.get(this.ids.mainGroup(handle));
    if (!placed) return undefined;
    return { layer: placed.layer, group: placed.group, row: this.ids.mainRow(handle) };
  }

  handleOf(id: string): RowHandle | undefined {
    const handle = this.ids.handleOf(id);
    if (handle < 0) return undefined;
    const place = this.placeOf(handle);
    if (!place) return undefined;
    return (place.group.data.flags[place.row] & ROW_FLAG_DELETED) !== 0 ? undefined : handle;
  }

  groupsOfRows(handles: Int32Array): Map<RowGroupHandle, number[]> {
    const out = new Map<RowGroupHandle, number[]>();
    for (const handle of handles) {
      const group = this.ids.mainGroup(handle);
      if (group < 0) continue;
      let rows = out.get(group);
      if (!rows) {
        rows = [];
        out.set(group, rows);
      }
      rows.push(this.ids.mainRow(handle));
    }
    return out;
  }

  /**
   * Checks the row groups and queues them: they are taken in a group at a time within the
   * budget of the frames (`advanceAdoption`), so a large file does not hold a frame
   */
  adopt(layerId: string, groups: readonly RowGroupData[]): void {
    // The checks of the shape of the groups are cheap and done here, so that a group made wrong
    // is refused before anything is queued; the checks of the rows are done when it is taken in
    for (const data of groups) {
      checkShape(data);
      if (data.length === 0) throw new Error('FeatureTables: an empty row group');
      for (let r = 0; r < data.length; r++) {
        const group = data.groups[r];
        if (group >= 0 && !this.groups.has(group)) {
          throw new Error(`FeatureTables: a row names the group ${group}, which is unknown`);
        }
      }
    }
    const layer = this.layerOf(layerId);
    const wasPending = this.adoptions.length > 0;
    for (const data of groups) this.adoptions.push({ layer, data });
    if (!wasPending && this.adoptions.length > 0) this.notifyWork();
  }

  get hasPendingAdoption(): boolean {
    return this.adoptions.length > 0;
  }

  advanceAdoption(budget: TableWorkBudget): boolean {
    while (this.adoptions.length > 0 && budget.canStep()) {
      const next = this.adoptions.shift() as {
        layer: LayerTable;
        data: RowGroupData;
        created?: boolean;
      };
      budget.step(() => {
        try {
          this.adoptGroup(next.layer, next.data);
        } catch (error) {
          // New rows written go to the delta; a group given to `adopt` is left out (there is no
          // caller to throw to any more)
          if (next.created) this.createdToDelta(next.layer, next.data);
          else console.error(error);
        }
      });
    }
    return this.adoptions.length > 0;
  }

  flushAdoption(): void {
    this.advanceCreations(UNBOUNDED_BUDGET, false);
    while (this.adoptions.length > 0) {
      const next = this.adoptions.shift() as {
        layer: LayerTable;
        data: RowGroupData;
        created?: boolean;
      };
      try {
        this.adoptGroup(next.layer, next.data);
      } catch (error) {
        if (!next.created) throw error;
        this.createdToDelta(next.layer, next.data);
      }
    }
  }

  // === New rows built into groups of their own ===

  /**
   * Builds the creations whose rows stopped coming (or that reached the size of a group) into
   * row groups, in the Worker of the host when it has one, and queues them to be taken in
   *
   * @param wait Whether a creation waits for more rows (false: every one is built now)
   */
  private advanceCreations(budget: TableWorkBudget, wait: boolean): void {
    for (const creation of [...this.creations]) {
      if (creation.status !== 'gathering') continue;
      creation.idle++;
      // Rows keep coming: the groups of the target size are built, the rest keeps gathering (so
      // a long import is not cut into a group per write)
      if (wait && creation.idle <= CREATE_WAIT_FRAMES) this.splitCreation(creation);
    }
    for (const creation of [...this.creations]) {
      if (creation.status !== 'gathering') continue;
      if (wait && creation.idle <= CREATE_WAIT_FRAMES) continue;
      const worker = this.worker;
      if (worker && wait) {
        creation.status = 'building';
        const inputs = creation.rows.map((row) => row.input);
        worker.build(inputs, { groups: this.groups.keyList() }).then(
          (groups) => {
            if (creation.status !== 'building') return;
            this.queueCreation(creation, groups);
          },
          (error) => {
            console.error(error);
            if (creation.status === 'building') this.creationToDelta(creation);
          },
        );
        continue;
      }
      if (!budget.canStep()) break;
      budget.step(() => this.queueCreation(creation, this.buildCreation(creation)));
    }
  }

  /**
   * Takes the first rows of a creation, as many as whole groups of the target size, into a
   * creation of their own (built at once), the rest staying
   */
  private splitCreation(creation: Creation): void {
    if (creation.rows.length < ROW_GROUP_TARGET_ROWS) return;
    const keys = keySourceOf(creation.rows.map((row) => row.input));
    const order = creation.rows.map((_, i) => i);
    order.sort((a, b) => compareRowKeys(keys, a, keys, b, this.groups));
    const whole = order.length - (order.length % ROW_GROUP_TARGET_ROWS);
    if (whole === 0) return;
    const rows = order.map((i) => creation.rows[i]);
    const head: Creation = {
      ...creation,
      rows: rows.slice(0, whole),
      first: oneKey(keys, order[0]),
      last: oneKey(keys, order[whole - 1]),
    };
    // Built in this pass
    head.idle = CREATE_WAIT_FRAMES + 1;
    this.creations.splice(this.creations.indexOf(creation), 0, head);
    for (const row of head.rows) this.creationOf.set(row.handle, head);
    creation.rows.length = 0;
    creation.rows.push(...rows.slice(whole));
    if (creation.rows.length === 0) {
      this.endCreation(creation);
      return;
    }
    creation.first = oneKey(keys, order[whole]);
  }

  /** Builds the rows of a creation into row groups on the main thread */
  private buildCreation(creation: Creation): RowGroupData[] {
    const builder = createRowGroupBuilder({ groups: this.groups.keyList() });
    for (const row of creation.rows) builder.addRow(row.input);
    return builder.finish();
  }

  /** Queues the groups of a creation built, to be taken in */
  private queueCreation(creation: Creation, groups: RowGroupData[]): void {
    this.endCreation(creation);
    const wasPending = this.adoptions.length > 0;
    for (const data of groups) this.adoptions.push({ layer: creation.layer, data, created: true });
    if (!wasPending && this.adoptions.length > 0) this.notifyWork();
  }

  private endCreation(creation: Creation): void {
    creation.status = 'done';
    const at = this.creations.indexOf(creation);
    if (at >= 0) this.creations.splice(at, 1);
    for (const row of creation.rows) {
      if (this.creationOf.get(row.handle) === creation) this.creationOf.delete(row.handle);
    }
  }

  /** Builds and takes in a creation now (a row of it is written before it is built) */
  private finishCreationNow(creation: Creation): void {
    const groups = this.buildCreation(creation);
    this.endCreation(creation);
    for (const data of groups) {
      try {
        this.adoptGroup(creation.layer, data);
      } catch {
        this.createdToDelta(creation.layer, data);
      }
    }
  }

  /** Puts the rows of a creation into the delta (it could not be built) */
  private creationToDelta(creation: Creation): void {
    this.endCreation(creation);
    this.rebuildDelta(creation.layer, new Set(), creation.rows, ++this.writeCount);
    this.revisionCount++;
  }

  /** Puts the rows of a group of new rows that could not be taken in into the delta */
  private createdToDelta(layer: LayerTable, data: RowGroupData): void {
    this.numberStyles(data);
    data.handles.set(this.ids.allocate(data.ids, data.idHashes));
    const group = createRowGroup(-1, data);
    const rows: DeltaInput[] = [];
    for (let r = 0; r < data.length; r++) {
      const handle = data.handles[r];
      if (this.placeOf(handle)) continue;
      rows.push({ handle, input: rowInputOf(this.readContext, group, r) });
    }
    this.rebuildDelta(layer, new Set(), rows, ++this.writeCount);
    this.revisionCount++;
  }

  /**
   * Takes new rows of one write into a creation when their keys are a run no row of the layer is
   * within, at a place between two groups: a new one when they are many, or the creation at the
   * same place whose rows they follow
   *
   * @returns Whether they were taken (they go to the delta otherwise)
   */
  private tryCreate(layer: LayerTable, rows: DeltaInput[]): boolean {
    const keys = keySourceOf(rows.map((row) => row.input));
    const order = rows.map((_, i) => i);
    order.sort((a, b) => compareRowKeys(keys, a, keys, b, this.groups));
    const first = order[0];
    const last = order[order.length - 1];
    if (!this.withinGap(layer, keys, first, keys, last)) return false;
    const cmp = (a: RowKeySource, i: number, b: RowKeySource, j: number): number =>
      compareRowKeys(a, i, b, j, this.groups);
    // The creation whose rows these follow, with no row of the layer between them
    let target: Creation | null = null;
    for (const creation of this.creations) {
      if (creation.layer !== layer) continue;
      const before = cmp(creation.last, 0, keys, first) < 0;
      const after = cmp(keys, last, creation.first, 0) < 0;
      // Within the run of another creation: not a run of its own
      if (!before && !after) return false;
      if (
        before &&
        creation.status === 'gathering' &&
        (!target || cmp(target.last, 0, creation.last, 0) < 0)
      ) {
        target = creation;
      }
    }
    if (target && !this.withinGap(layer, target.first, 0, keys, last)) target = null;
    // Rows of the delta within the run (from the last row of the creation continued)
    const from = target ? target.last : keys;
    if (this.deltaWithin(layer, from, target ? 0 : first, keys, last)) return false;
    if (target && target.rows.length >= ROW_GROUP_TARGET_ROWS) target = null;
    if (!target) {
      if (rows.length < CREATE_GROUP_MIN_ROWS) return false;
      target = {
        layer,
        rows: [],
        first: oneKey(keys, first),
        last: oneKey(keys, last),
        idle: 0,
        status: 'gathering',
      };
      this.creations.push(target);
    } else {
      target.last = oneKey(keys, last);
      target.idle = 0;
    }
    for (const row of rows) {
      target.rows.push(row);
      this.creationOf.set(row.handle, target);
    }
    this.notifyWork();
    return true;
  }

  /**
   * Whether a run of keys `[first, last]` falls between two groups of a layer (or before the
   * first, after the last): no row of a group is within it
   */
  private withinGap(
    layer: LayerTable,
    firstKeys: RowKeySource,
    first: number,
    lastKeys: RowKeySource,
    last: number,
  ): boolean {
    if (layer.groupCount === 0) return true;
    const a = layer.positionOfKey(firstKeys, first);
    const b = layer.positionOfKey(lastKeys, last);
    if (!a || !b || a.group !== b.group || a.slot !== b.slot || a.slot % 2 === 1) return false;
    const g = layer.orderOf(a.group);
    return a.slot === 2 * layer.groupAt(g).data.length || (g === 0 && a.slot === 0);
  }

  /** Whether a row of the delta of a layer has a key within `[from, to]` of two sources */
  private deltaWithin(
    layer: LayerTable,
    fromKeys: RowKeySource,
    from: number,
    toKeys: RowKeySource,
    to: number,
  ): boolean {
    const delta = layer.delta.group;
    if (!delta) return false;
    for (let k = 0; k < delta.data.length; k++) {
      if (
        compareRowKeys(fromKeys, from, delta.data, k, this.groups) <= 0 &&
        compareRowKeys(delta.data, k, toKeys, to, this.groups) <= 0
      ) {
        return true;
      }
    }
    return false;
  }

  onPendingWork(listener: () => void): () => void {
    this.workListeners.add(listener);
    return () => {
      this.workListeners.delete(listener);
    };
  }

  private notifyWork(): void {
    for (const listener of this.workListeners) listener();
  }

  overrideBytes(): number {
    let bytes = 0;
    for (const { group } of this.rowGroups.values()) bytes += overrideBytesOf(group);
    return bytes;
  }

  movedRowCount(): number {
    let count = 0;
    for (const layer of this.layers.values()) count += layer.movedRowCount;
    return count;
  }

  deltaRowCount(): number {
    let count = 0;
    for (const layer of this.layers.values()) count += layer.delta.length;
    return count;
  }

  onRowsWritten(listener: (layerId: string, writes: readonly RowWrite[]) => void): () => void {
    this.writeListeners.add(listener);
    return () => {
      this.writeListeners.delete(listener);
    };
  }

  onDeltaChanged(listener: (layerId: string) => void): () => void {
    this.deltaListeners.add(listener);
    return () => {
      this.deltaListeners.delete(listener);
    };
  }

  /** Reads the handles of the rows of layers a batch at a time */
  scan(options: TableScanOptions): RowCursor {
    const layers = (options.layerIds ?? [...this.layers.keys()])
      .map((id) => this.layers.get(id))
      .filter((layer): layer is LayerTable => layer !== undefined);
    const batch = Math.max(1, Math.floor(options.batch ?? SCAN_BATCH));
    const bbox = options.bbox;
    let layerAt = 0;
    let handles: number[] | null = null;
    let at = 0;
    return {
      next: (): Int32Array | null => {
        const out: number[] = [];
        while (out.length < batch && layerAt < layers.length) {
          if (!handles) {
            handles = [];
            const list = handles;
            const layer = layers[layerAt];
            const take = (group: RowGroup, row: number): void => {
              if ((group.data.flags[row] & ROW_FLAG_DELETED) === 0) {
                list.push(group.data.handles[row]);
              }
            };
            if (bbox) {
              layer.searchInOrder(bbox[0], bbox[1], bbox[2], bbox[3], take);
            } else {
              const order = layer.rowOrder();
              for (let i = 0; i < order.handles.length; i++) take(order.groups[i], order.rows[i]);
            }
            at = 0;
          }
          while (out.length < batch && at < handles.length) out.push(handles[at++]);
          if (at >= handles.length) {
            layerAt++;
            handles = null;
          }
        }
        return out.length > 0 ? Int32Array.from(out) : null;
      },
    };
  }

  /** Puts rows of groups into the delta of their layer as they are */
  toDelta(handles: readonly RowHandle[]): void {
    const inputs = new Map<LayerTable, DeltaInput[]>();
    for (const handle of handles) {
      if (this.ids.deltaLayer(handle) >= 0) continue;
      const placed = this.rowGroups.get(this.ids.mainGroup(handle));
      if (!placed) continue;
      const input = rowInputOf(this.readContext, placed.group, this.ids.mainRow(handle));
      let list = inputs.get(placed.layer);
      if (!list) {
        list = [];
        inputs.set(placed.layer, list);
      }
      list.push({ handle, input });
    }
    if (inputs.size === 0) return;
    const number = ++this.writeCount;
    for (const [layer, list] of inputs) this.rebuildDelta(layer, new Set(), list, number);
    for (const list of inputs.values()) {
      for (const { handle } of list) this.refreshCopies(handle);
    }
    this.revisionCount++;
  }

  /**
   * Writes values of rows (see `FeatureTablesWriter.apply`): every value is checked before
   * anything is written; then the rows are written in place, and the rows placed elsewhere and
   * the new ones are put in the delta of their layer, and the drawing is told
   */
  apply(patch: RowPatch, _options: RowApplyOptions = {}): RowsChange {
    const { handles, fields, deleted } = patch;
    const n = handles.length;
    // The checks
    for (const [field, values] of fields) {
      if (values.length !== n) {
        throw new Error(`FeatureTables: "${field}" has ${values.length} values for ${n} rows`);
      }
    }
    if (deleted && deleted.length !== n) {
      throw new Error('FeatureTables: deleted has another length than the rows');
    }
    const geometries = fields.get('geometry');
    geometries?.forEach((geometry, i) => {
      if (geometry === undefined) return;
      if (!geometry || typeof geometry !== 'object' || !('type' in geometry)) {
        throw new Error(`FeatureTables: the geometry of the row ${handles[i]} is not a geometry`);
      }
    });
    const types = fields.get('type');
    const layerIds = fields.get('layerId');
    const orders = fields.get('order');
    const members = fields.get('member');
    const groupIds = fields.get('groupId');
    const groupHandles = groupIds?.map((id, i) => {
      if (id === undefined || id === null || id === '') return -1;
      if (typeof id !== 'string') {
        throw new Error(`FeatureTables: the group of the row ${handles[i]} is not an id`);
      }
      const group = this.groups.handleOfId(id);
      if (group < 0) throw new Error(`FeatureTables: the group "${id}" is unknown`);
      return group;
    });
    const strings: Array<[string, readonly unknown[] | undefined, boolean]> = [
      ['type', types, false],
      ['layerId', layerIds, false],
      ['order', orders, false],
      ['member', members, true],
    ];
    for (const [name, values, optional] of strings) {
      values?.forEach((value, i) => {
        if (
          typeof value === 'string' ||
          (value === undefined && (optional || !!this.placeOf(handles[i])))
        ) {
          return;
        }
        throw new Error(`FeatureTables: the ${name} of the row ${handles[i]} is not a string`);
      });
    }
    // A row of a creation written before it is built: the creation is built now
    for (const handle of handles) {
      const creation = this.creationOf.get(handle);
      if (creation) this.finishCreationNow(creation);
    }
    const places = Array.from(handles, (handle) => this.placeOf(handle));
    places.forEach((place, i) => {
      if (place) return;
      if (!this.ids.has(handles[i])) {
        throw new Error(`FeatureTables: no row has the handle ${handles[i]}`);
      }
      // A new row: what a feature cannot be without
      const missing = [
        ['type', types?.[i]],
        ['layerId', layerIds?.[i]],
        ['geometry', geometries?.[i]],
        ['order', orders?.[i]],
      ].filter(([, value]) => value === undefined);
      if (missing.length > 0) {
        throw new Error(
          `FeatureTables: no row has the handle ${handles[i]}, and a new row needs ${missing
            .map(([name]) => name)
            .join(', ')}`,
        );
      }
    });
    // The values are made what the columns hold before anything is written
    const styles = fields.get('style');
    const styleNumbers = styles?.map((style) => this.styles.intern((style ?? {}) as FeatureStyle));

    const number = ++this.writeCount;
    const writes = new Map<string, RowWrite[]>();
    const touched = new Set<RowGroup>();
    const moving = new Map<LayerTable, DeltaInput[]>();
    const leaving = new Map<LayerTable, Set<RowHandle>>();
    const fresh = new Map<LayerTable, DeltaInput[]>();
    const changes = new Map<string, LayerChangeDraft>();
    let stateChanged = false;
    let created = false;

    for (let i = 0; i < n; i++) {
      const handle = handles[i];
      const place = places[i];
      const placed = place ? this.placeChanged(place, i, fields, groupHandles) : true;
      const targetLayer = (layerIds?.[i] as string | undefined) ?? place?.layer.layerId;
      const change = draftOf(changes, targetLayer as string);
      for (const field of fields.keys()) change.fields.add(field);
      if (styles && place) {
        const before = this.styles.get(place.group.data.styles[place.row]);
        for (const key of changedKeys(before, (styles[i] ?? {}) as FeatureStyle)) {
          change.styleKeys.add(key);
        }
      }
      if (!place) change.created.push(handle);
      else if (deleted?.[i] && (place.group.data.flags[place.row] & ROW_FLAG_DELETED) === 0) {
        change.deleted.push(handle);
      } else change.updated.push(handle);

      if (!placed && place) {
        // Written in place (and written again into the next version of its group when one is
        // being made)
        if (!place.group.delta && this.versions.lockOf(place.group.handle)) {
          const values = new Map<string, unknown>();
          for (const [field, list] of fields) values.set(field, list[i]);
          this.versions.logWrite(place.group.handle, {
            handle,
            fields: values,
            deleted: deleted?.[i] ? true : false,
          });
        }
        const write = this.writeInPlace(place, i, fields, deleted, styleNumbers);
        if (!write) continue;
        if (write.what & ROW_WRITE_GEOMETRY) this.touch(place.layer.layerId, place.group.bounds);
        if (write.what & (ROW_WRITE_GEOMETRY | ROW_WRITE_STATE)) stateChanged = true;
        touched.add(place.group);
        if (place.group.delta) place.layer.delta.setWritten(place.row, number);
        let list = writes.get(place.layer.layerId);
        if (!list) {
          list = [];
          writes.set(place.layer.layerId, list);
        }
        list.push(write);
        continue;
      }
      // Placed elsewhere, or new: a copy in the delta of its layer (many new rows next to each
      // other are built into groups of their own instead)
      const input = this.patchedInput(handle, place, i, fields, deleted, groupHandles);
      const layer = this.layerOf(targetLayer as string);
      if (!place) {
        let list = fresh.get(layer);
        if (!list) {
          list = [];
          fresh.set(layer, list);
        }
        list.push({ handle, input });
        created = true;
        continue;
      }
      let list = moving.get(layer);
      if (!list) {
        list = [];
        moving.set(layer, list);
      }
      list.push({ handle, input });
      if (place?.group.delta) {
        let set = leaving.get(place.layer);
        if (!set) {
          set = new Set();
          leaving.set(place.layer, set);
        }
        set.add(handle);
      }
      if (!place) created = true;
    }

    // A style interned for a row that kept its own is not held by any row
    if (styleNumbers) {
      for (const style of styleNumbers) {
        if (this.styles.usesOf(style) === 0) this.styles.release(style);
      }
    }
    for (const group of touched) {
      if (group.delta) continue;
      if (overrideBytesOf(group) > OVERRIDE_BYTES_LIMIT) {
        this.groupsDue.add(group.handle);
        this.versions.markDue(group.handle);
      }
      this.versions.checkMoved(group);
    }
    // The new rows: a run of their own built into groups, or into the delta
    for (const [layer, list] of fresh) {
      if (this.tryCreate(layer, list)) continue;
      let into = moving.get(layer);
      if (!into) {
        into = [];
        moving.set(layer, into);
      }
      into.push(...list);
    }
    // The deltas
    const layers = new Set<LayerTable>([...moving.keys(), ...leaving.keys()]);
    for (const layer of layers) {
      this.rebuildDelta(layer, leaving.get(layer) ?? new Set(), moving.get(layer) ?? [], number);
    }
    for (const list of moving.values()) {
      for (const { handle } of list) this.refreshCopies(handle);
    }
    if (stateChanged || layers.size > 0 || created) this.revisionCount++;
    for (const [layerId, list] of writes) {
      for (const listener of this.writeListeners) listener(layerId, list);
    }
    return { layers: finishChanges(changes) };
  }

  /**
   * Writes values of groups of features (see `FeatureTablesWriter.applyGroups`): a new key of
   * the order of a group puts its members in another order (`reorderGroups`), a group shown or
   * hidden makes the copies of the state of its members again
   */
  applyGroups(patch: TableGroupPatch, _options: RowApplyOptions = {}): void {
    const { handles, fields, deleted } = patch;
    const n = handles.length;
    for (const [field, values] of fields) {
      if (values.length !== n) {
        throw new Error(`FeatureTables: "${field}" has ${values.length} values for ${n} groups`);
      }
    }
    if (deleted && deleted.length !== n) {
      throw new Error('FeatureTables: deleted has another length than the groups');
    }
    const value = (field: 'id' | 'order' | 'layerId' | 'visible' | 'locked', i: number) =>
      fields.get(field)?.[i];
    for (let i = 0; i < n; i++) {
      if (deleted?.[i]) continue;
      for (const field of ['id', 'order', 'layerId'] as const) {
        const v = value(field, i);
        if (v !== undefined && typeof v !== 'string') {
          throw new Error(`FeatureTables: the ${field} of the group ${handles[i]} is not a string`);
        }
        if (v === undefined && !this.groups.has(handles[i])) {
          throw new Error(`FeatureTables: the new group ${handles[i]} needs its ${field}`);
        }
      }
      for (const field of ['visible', 'locked'] as const) {
        const v = value(field, i);
        if (v !== undefined && typeof v !== 'boolean') {
          throw new Error(
            `FeatureTables: the ${field} of the group ${handles[i]} is not a boolean`,
          );
        }
      }
    }
    const orders = new Map<string, Map<GroupHandle, string>>();
    const shown = new Set<GroupHandle>();
    const removed: GroupHandle[] = [];
    for (let i = 0; i < n; i++) {
      const group = handles[i];
      if (deleted?.[i]) {
        removed.push(group);
        continue;
      }
      if (!this.groups.has(group)) {
        this.groups.set(group, {
          id: value('id', i) as string,
          order: value('order', i) as string,
          layerId: value('layerId', i) as string,
          visible: value('visible', i) !== false,
          locked: value('locked', i) === true,
        });
        continue;
      }
      const visible = this.groups.isVisible(group);
      const next = {
        id: this.groups.idOf(group) as string,
        // A new key goes in with the members in their new order
        order: this.groups.orderOf(group) as string,
        layerId:
          (value('layerId', i) as string | undefined) ?? (this.groups.layerOf(group) as string),
        visible: (value('visible', i) as boolean | undefined) ?? visible,
        locked: (value('locked', i) as boolean | undefined) ?? this.groups.isLocked(group),
      };
      this.groups.set(group, next);
      if (next.visible !== visible) shown.add(group);
      const order = value('order', i) as string | undefined;
      if (order !== undefined && order !== next.order) {
        let list = orders.get(next.layerId);
        if (!list) {
          list = new Map();
          orders.set(next.layerId, list);
        }
        list.set(group, order);
      }
    }
    if (shown.size > 0) {
      for (const layer of this.layers.values()) {
        const groups: RowGroup[] = [];
        for (let g = 0; g < layer.groupCount; g++) groups.push(layer.groupAt(g));
        if (layer.delta.group) groups.push(layer.delta.group);
        for (const group of groups) {
          let changed = false;
          for (let r = 0; r < group.data.length; r++) {
            if (!shown.has(group.data.groups[r])) continue;
            this.writeState(group, r);
            changed = true;
          }
          if (changed) group.stateVersion++;
        }
      }
    }
    for (const [layerId, list] of orders) this.reorderGroups(layerId, list);
    for (const group of removed) {
      if (!this.groupNamed(group)) this.groups.delete(group);
    }
    this.revisionCount++;
    this.notifyWork();
  }

  /**
   * Puts the members of groups of features in the order of new keys of the groups: the row
   * groups of the layer are cut at the runs of the members and at the places they go to, and
   * the pieces are put in their new order by a version swapped in once its chunks are up (the
   * keys go in then; until then the order before is read and drawn). The rows are not written.
   * A reorder still waiting is made again with its keys and the new ones
   */
  private reorderGroups(layerId: string, orders: Map<GroupHandle, string>): void {
    const layer = this.layers.get(layerId);
    for (const version of this.versions.reorders(layer)) {
      for (const [group, order] of version.orders ?? []) {
        if (!orders.has(group)) orders.set(group, order);
      }
    }
    // The cuts of each row group: the runs of the members
    const cuts = new Map<RowGroup, Set<number>>();
    const cut = (group: RowGroup, row: number): void => {
      if (row <= 0 || row >= group.data.length) return;
      let set = cuts.get(group);
      if (!set) {
        set = new Set();
        cuts.set(group, set);
      }
      set.add(row);
    };
    const members: Array<{ group: RowGroup; row: number; of: GroupHandle }> = [];
    for (let g = 0; g < (layer?.groupCount ?? 0); g++) {
      const group = (layer as LayerTable).groupAt(g);
      const data = group.data;
      let run = -1;
      for (let r = 0; r <= data.length; r++) {
        const inside = r < data.length && orders.has(data.groups[r]);
        if (inside && run < 0) {
          run = r;
          members.push({ group, row: r, of: data.groups[r] });
          cuts.set(group, cuts.get(group) ?? new Set());
          cut(group, r);
        } else if (!inside && run >= 0) {
          cut(group, r);
          run = -1;
        } else if (inside && data.groups[r] !== data.groups[r - 1]) {
          cut(group, r);
          members.push({ group, row: r, of: data.groups[r] });
        }
      }
    }
    if (!layer || members.length === 0) {
      // No member in the groups: the keys go in now (the deltas in their new order)
      for (const [group, order] of orders) this.groups.setOrder(group, order);
      for (const other of this.layers.values()) {
        if (other.delta.group) this.rebuildDelta(other, new Set(), [], this.writeCount);
        other.touchItems();
      }
      return;
    }
    // The places the members go to: before the first row that is no member of a group put in
    // another order and comes after them with the new keys
    const keys = this.groups.withOrders(orders);
    for (const member of members) {
      let placed = false;
      for (let g = 0; g < layer.groupCount && !placed; g++) {
        const group = layer.groupAt(g);
        const data = group.data;
        for (let r = 0; r < data.length; r++) {
          if (orders.has(data.groups[r])) continue;
          if (compareRowKeys(member.group.data, member.row, data, r, keys) < 0) {
            if (r > 0 && !orders.has(data.groups[r - 1])) cut(group, r);
            placed = true;
            break;
          }
        }
      }
    }
    // The pieces
    const groups = [...cuts.keys()].sort(
      (a, b) => layer.orderOf(a.handle) - layer.orderOf(b.handle),
    );
    const pieces: RowGroupData[] = [];
    for (const group of groups) {
      const points = [
        0,
        ...[...(cuts.get(group) as Set<number>)].sort((a, b) => a - b),
        group.data.length,
      ];
      for (let k = 0; k + 1 < points.length; k++) {
        if (points[k + 1] > points[k]) pieces.push(this.sliceRows(group, points[k], points[k + 1]));
      }
    }
    this.versions.startReorder(layer, groups, pieces, orders);
  }

  /**
   * The rows `[from, to)` of a group as a group of their own (the values written in place built
   * into them)
   */
  private sliceRows(group: RowGroup, from: number, to: number): RowGroupData {
    const sources: RowGroupData[] = [group.data];
    const pairs: number[] = [];
    const inputs: RowInput[] = [];
    for (let r = from; r < to; r++) {
      if (
        group.values?.has(r) ||
        group.geometries?.geometry(r) !== undefined ||
        group.geometries?.rowTriangles(r) !== undefined
      ) {
        inputs.push(rowInputOf(this.readContext, group, r));
      } else {
        pairs.push(0, r);
      }
    }
    const built = inputs.length > 0 ? this.buildRows(inputs) : null;
    if (built) {
      sources.push(built);
      for (let r = 0; r < built.length; r++) pairs.push(1, r);
    }
    const [data] = mergeRowGroup({
      sources,
      rows: Int32Array.from(pairs),
      groups: this.groups,
      targetRows: UNBOUNDED,
      targetVertices: UNBOUNDED,
    });
    return data;
  }

  /** Whether a row (of a group, of a delta, of a creation) names a group of features */
  private groupNamed(group: GroupHandle): boolean {
    for (const layer of this.layers.values()) {
      const groups: RowGroup[] = [];
      for (let g = 0; g < layer.groupCount; g++) groups.push(layer.groupAt(g));
      if (layer.delta.group) groups.push(layer.delta.group);
      for (const rowGroup of groups) {
        if (rowGroup.data.groups.includes(group)) return true;
      }
    }
    return this.creations.some((creation) =>
      creation.rows.some((row) => row.input.group === group),
    );
  }

  /**
   * Whether a patch places a row elsewhere (another key, group, layer or type, or an attribute
   * the cutting of the rows reads): it then goes to the delta rather than being written in place
   */
  private placeChanged(
    place: RowPlace,
    i: number,
    fields: ReadonlyMap<RowField, readonly unknown[]>,
    groupHandles: number[] | undefined,
  ): boolean {
    const data = place.group.data;
    const row = place.row;
    for (const [field, values] of fields) {
      const value = values[i];
      if (PLACE_FIELDS.has(field)) {
        if (value === undefined && field !== 'member' && field !== 'groupId') continue;
        switch (field) {
          case 'type':
            if (value !== rowType(data, row)) return true;
            break;
          case 'layerId':
            if (value !== place.layer.layerId) return true;
            break;
          case 'order':
            if (value !== utf8String(data.itemKeys, row)) return true;
            break;
          case 'member':
            if ((value ?? '') !== utf8String(data.memberKeys, row)) return true;
            break;
          case 'groupId':
            if ((groupHandles as number[])[i] !== data.groups[row]) return true;
            break;
        }
        continue;
      }
      if (field.startsWith('property:') && CLASSIFY_KEYS.has(field.slice('property:'.length))) {
        if (rowValue(place.group, row, field.slice('property:'.length)) !== value) return true;
      }
    }
    return false;
  }

  /** The values of a row with a patch written over them, as the builder takes them */
  private patchedInput(
    handle: RowHandle,
    place: RowPlace | undefined,
    i: number,
    fields: ReadonlyMap<RowField, readonly unknown[]>,
    deleted: Uint8Array | undefined,
    groupHandles: number[] | undefined,
  ): RowInput {
    const base: RowInput = place
      ? rowInputOf(this.readContext, place.group, place.row)
      : { id: this.ids.idOf(handle) ?? '', type: 'Point', geometry: null, order: '' };
    const out: {
      -readonly [K in keyof RowInput]: RowInput[K];
    } = { ...base, properties: { ...(base.properties ?? {}) } };
    for (const [field, values] of fields) {
      const value = values[i];
      switch (field) {
        case 'type':
          if (value !== undefined) out.type = value as string;
          break;
        case 'geometry':
          if (value !== undefined) out.geometry = value as RowInput['geometry'];
          break;
        case 'order':
          if (value !== undefined) out.order = value as string;
          break;
        case 'member':
          out.member = value as string | undefined;
          break;
        case 'groupId':
          out.group = (groupHandles as number[])[i];
          break;
        case 'style':
          out.style = (value ?? {}) as Readonly<Record<string, unknown>>;
          break;
        case 'visible':
          if (value !== undefined) out.visible = value !== false;
          break;
        case 'locked':
          if (value !== undefined) out.locked = value === true;
          break;
        case 'layerId':
          break;
        default: {
          const key = field.slice('property:'.length);
          const properties = out.properties as Record<string, unknown>;
          if (value === undefined) delete properties[key];
          else properties[key] = value;
        }
      }
    }
    if (deleted?.[i]) out.deleted = true;
    if (out.group === undefined || out.group < 0) out.member = undefined;
    return out;
  }

  /**
   * Writes the values of a row in place
   *
   * @returns What was written, as the drawing is told (null when nothing changed)
   */
  private writeInPlace(
    place: RowPlace,
    i: number,
    fields: ReadonlyMap<RowField, readonly unknown[]>,
    deleted: Uint8Array | undefined,
    styleNumbers: number[] | undefined,
  ): RowWrite | null {
    const { layer, group, row } = place;
    const data = group.data;
    let what = 0;
    let shape: GeometryWrite = { sameShape: true, from: 0, to: 0 };
    const keys: string[] = [];
    const geometry = fields.get('geometry')?.[i];
    if (geometry !== undefined) {
      shape = writeRowGeometry(layer, group, row, geometry as never);
      what |= ROW_WRITE_GEOMETRY;
    }
    if (styleNumbers) {
      const next = styleNumbers[i];
      const old = data.styles[row];
      if (next !== old) {
        this.styles.retain(next);
        this.styles.release(old);
        data.styles[row] = next;
        what |= ROW_WRITE_STYLE;
      }
    }
    let flags = data.flags[row];
    const visible = fields.get('visible')?.[i];
    if (visible !== undefined) {
      flags = visible === false ? flags & ~ROW_FLAG_VISIBLE : flags | ROW_FLAG_VISIBLE;
    }
    const locked = fields.get('locked')?.[i];
    if (locked !== undefined) {
      flags = locked === true ? flags | ROW_FLAG_LOCKED : flags & ~ROW_FLAG_LOCKED;
    }
    if (deleted && deleted[i] !== 0) flags |= ROW_FLAG_DELETED;
    if (flags !== data.flags[row]) {
      if ((flags & ROW_FLAG_DELETED) !== (data.flags[row] & ROW_FLAG_DELETED)) layer.touchItems();
      data.flags[row] = flags;
      this.writeState(group, row);
      group.stateVersion++;
      what |= ROW_WRITE_STATE;
    }
    for (const [field, values] of fields) {
      if (!field.startsWith('property:')) continue;
      const key = field.slice('property:'.length);
      if (!writeRowValue(group, row, key, values[i])) continue;
      what |= ROW_WRITE_VALUES;
      keys.push(key);
      if (isRadiusKey(group, row, key)) {
        // The ring of a Circle follows its radius
        const ring = refreshRowShape(layer, group, row);
        shape = { sameShape: ring.sameTriangles, from: 0, to: ring.ring };
        what |= ROW_WRITE_GEOMETRY;
      }
    }
    if (what === 0) return null;
    return {
      group: group.handle,
      row,
      what,
      sameShape: shape.sameShape,
      from: shape.from,
      to: shape.to,
      keys,
    };
  }

  /**
   * Puts the groups of a next version in place of the ones it replaces, in one step: the rows of
   * the version are read from it (a row whose copy is still read in another group waits in it),
   * a row that left the groups replaced and waits in another group is handed to it, the rows of
   * the deltas the version took leave them, the values written in place since it started are
   * written again into it, and the copies of the state of its rows are made again
   */
  private swapIn(version: GroupVersion, waiting: WaitingCopies): RowsChange | null {
    const layer = version.layer;
    const groups = version.groups ?? [];
    const replaced = new Set(version.replaces.map((group) => group.handle));
    const replacedGroups = new Set<RowGroup>(version.replaces);
    if (version.orders) {
      for (const [group, order] of version.orders) this.groups.setOrder(group, order);
    }
    layer.replaceGroups(version.replaces, groups);
    for (const old of version.replaces) {
      this.rowGroups.delete(old.handle);
      this.groupsDue.delete(old.handle);
    }
    for (const group of groups) this.rowGroups.set(group.handle, { layer, group });
    const leaving = new Map<LayerTable, Set<RowHandle>>();
    const leave = (handle: RowHandle): void => {
      const serial = this.ids.deltaLayer(handle);
      if (serial < 0) return;
      const delta = this.layerList[serial];
      let set = leaving.get(delta);
      if (!set) {
        set = new Set();
        leaving.set(delta, set);
      }
      set.add(handle);
    };
    const takes = (handle: RowHandle, number: number): boolean => {
      const serial = this.ids.deltaLayer(handle);
      if (serial < 0) return false;
      return this.layerList[serial].delta.writtenOf(this.ids.deltaSlot(handle)) <= number;
    };
    // The rows of the version
    const inNew = new Set<RowHandle>();
    for (const group of groups) {
      const data = group.data;
      for (let r = 0; r < data.length; r++) {
        const handle = data.handles[r];
        inNew.add(handle);
        const main = this.ids.mainGroup(handle);
        if (main < 0 || replaced.has(main)) {
          this.ids.setMain(handle, group.handle, r);
          waiting.delete(handle);
        } else {
          // Read in another group until that one has its next version (a copy that waited in
          // a group replaced keeps the number of the version that put it there)
          const before = waiting.get(handle);
          const number =
            before && replacedGroups.has(before.group) ? before.number : version.deltaNumber;
          waiting.set(handle, { group, row: r, number });
        }
      }
    }
    // The rows that left the groups replaced
    const handed: Array<{ group: RowGroup; row: number }> = [];
    for (const old of version.replaces) {
      const data = old.data;
      for (let r = 0; r < data.length; r++) {
        const handle = data.handles[r];
        if (inNew.has(handle) || !replaced.has(this.ids.mainGroup(handle))) continue;
        const copy = waiting.get(handle);
        if (copy && this.rowGroups.get(copy.group.handle)?.group === copy.group) {
          this.ids.setMain(handle, copy.group.handle, copy.row);
          waiting.delete(handle);
          handed.push(copy);
          if (takes(handle, copy.number)) leave(handle);
        } else {
          this.ids.setMain(handle, -1, -1);
        }
      }
    }
    // The rows of the deltas the version took (a reorder takes none: its copies stay as they are)
    for (const group of version.takesDelta ? groups : []) {
      const data = group.data;
      for (let r = 0; r < data.length; r++) {
        const handle = data.handles[r];
        if (this.ids.mainGroup(handle) === group.handle && takes(handle, version.deltaNumber)) {
          leave(handle);
        }
      }
    }
    // A copy waiting in a group replaced waits in the version, or not any more
    const newGroups = new Set<RowGroup>(groups);
    for (const [handle, copy] of waiting) {
      if (replacedGroups.has(copy.group) && !newGroups.has(copy.group)) waiting.delete(handle);
    }
    for (const old of version.replaces) {
      for (let r = 0; r < old.data.length; r++) this.styles.release(old.data.styles[r]);
    }
    for (const group of groups) {
      for (let r = 0; r < group.data.length; r++) this.writeState(group, r);
      group.stateVersion++;
    }
    for (const copy of handed) {
      this.writeState(copy.group, copy.row);
      copy.group.stateVersion++;
      this.rowGroups.get(copy.group.handle)?.layer.touchItems();
    }
    for (const [delta, set] of leaving) this.rebuildDelta(delta, set, [], this.writeCount);
    // The values written in place since the version started
    const writes = new Map<string, RowWrite[]>();
    for (const entry of version.log) {
      const place = this.placeOf(entry.handle);
      if (!place || place.group.delta || !groups.includes(place.group)) continue;
      const fields = new Map<RowField, unknown[]>();
      for (const [field, value] of entry.fields) fields.set(field as RowField, [value]);
      const style = fields.get('style');
      const numbers = style ? [this.styles.intern((style[0] ?? {}) as FeatureStyle)] : undefined;
      const write = this.writeInPlace(
        place,
        0,
        fields,
        entry.deleted ? Uint8Array.of(1) : undefined,
        numbers,
      );
      if (numbers && this.styles.usesOf(numbers[0]) === 0) this.styles.release(numbers[0]);
      if (!write) continue;
      let list = writes.get(place.layer.layerId);
      if (!list) {
        list = [];
        writes.set(place.layer.layerId, list);
      }
      list.push(write);
    }
    if (version.orders) {
      // The rows of the deltas in the order of the new keys
      for (const other of this.layers.values()) {
        if (other.delta.group && !leaving.has(other)) {
          this.rebuildDelta(other, new Set(), [], this.writeCount);
        }
      }
      for (const other of this.layers.values()) other.touchItems();
    }
    layer.touchItems();
    this.revisionCount++;
    for (const [layerId, list] of writes) {
      for (const listener of this.writeListeners) listener(layerId, list);
    }
    this.touch(layer.layerId, GroupVersions.boundsOf(version));
    return null;
  }

  /**
   * Makes the rows of the delta of a layer again: its rows but the ones leaving it, and the rows
   * coming into it (written in the change `number`). A row of the delta written in place is
   * built again with its values, so the new rows hold no values written in place
   */
  private rebuildDelta(
    layer: LayerTable,
    leaving: ReadonlySet<RowHandle>,
    coming: readonly DeltaInput[],
    number: number,
  ): void {
    const delta = layer.delta;
    const old = delta.group;
    const sources: RowGroupData[] = [];
    const pairs: number[] = [];
    const writtenOf = new Map<RowHandle, number>();
    const inputs: RowInput[] = [];
    const comingHandles = new Set(coming.map((entry) => entry.handle));
    if (old) {
      sources.push(old.data);
      for (let r = 0; r < old.data.length; r++) {
        const handle = old.data.handles[r];
        if (leaving.has(handle) || comingHandles.has(handle)) continue;
        writtenOf.set(handle, delta.writtenOf(r));
        if (old.values?.has(r) || old.geometries?.geometry(r) || old.geometries?.rowTriangles(r)) {
          inputs.push(rowInputOf(this.readContext, old, r));
        } else {
          pairs.push(0, r);
        }
      }
    }
    for (const entry of coming) {
      inputs.push(entry.input);
      writtenOf.set(entry.handle, number);
    }
    if (inputs.length > 0) {
      const built = this.buildRows(inputs);
      if (built) {
        sources.push(built);
        for (let r = 0; r < built.length; r++) pairs.push(sources.length - 1, r);
      }
    }
    const merged = mergeRowGroup({
      sources,
      rows: Int32Array.from(pairs),
      groups: this.groups,
      targetRows: UNBOUNDED,
      targetVertices: UNBOUNDED,
    });
    const group = merged.length > 0 ? createRowGroup(delta.handle, merged[0], true) : null;
    const written = new Float64Array(group?.data.length ?? 0);
    if (group) {
      for (let r = 0; r < group.data.length; r++) {
        written[r] = writtenOf.get(group.data.handles[r]) ?? number;
        this.styles.retain(group.data.styles[r]);
      }
    }
    if (old) {
      for (let r = 0; r < old.data.length; r++) {
        const handle = old.data.handles[r];
        this.styles.release(old.data.styles[r]);
        if (this.ids.deltaLayer(handle) === layer.serial) this.ids.setDelta(handle, -1, -1);
      }
      layer.dropMoved(old);
    }
    if (group) {
      for (let r = 0; r < group.data.length; r++) {
        this.ids.setDelta(group.data.handles[r], layer.serial, r);
      }
      for (let r = 0; r < group.data.length; r++) this.writeState(group, r);
    }
    delta.rebuild(group, written);
    layer.touchItems();
    this.touch(layer.layerId, unionBounds(old?.bounds ?? null, group?.bounds ?? null));
    // The copies the rows leaving the delta had in their groups are read again
    for (const handle of leaving) {
      if (this.ids.deltaLayer(handle) < 0) this.refreshCopies(handle);
    }
    for (const listener of this.deltaListeners) listener(layer.layerId);
  }

  /** Builds rows into one row group, numbered and with their handles (null for no row) */
  private buildRows(inputs: readonly RowInput[]): RowGroupData | null {
    const builder = createRowGroupBuilder({
      groups: this.groups.keyList(),
      targetRows: UNBOUNDED,
      targetVertices: UNBOUNDED,
    });
    for (const input of inputs) builder.addRow(input);
    const [data] = builder.finish();
    if (!data) return null;
    this.numberStyles(data);
    data.handles.set(this.ids.allocate(data.ids, data.idHashes));
    return data;
  }

  /** Gives the styles of a group built in a Worker the numbers of the table of styles */
  private numberStyles(data: RowGroupData): void {
    const dictionary = data.styleDictionary;
    if (!dictionary) return;
    const numbers = new Uint32Array(utf8ColumnLength(dictionary));
    for (let i = 0; i < numbers.length; i++) {
      numbers[i] = this.styles.internBytes(
        dictionary.bytes,
        dictionary.offsets[i],
        dictionary.offsets[i + 1],
      );
    }
    for (let r = 0; r < data.length; r++) data.styles[r] = numbers[data.styles[r]];
    data.styleDictionary = null;
  }

  /** Takes in one row group: the handles, the numbers of its styles, the state of its rows */
  private adoptGroup(layer: LayerTable, data: RowGroupData): void {
    if (data.handles.some((handle) => handle < 0)) {
      data.handles.set(this.ids.allocate(data.ids, data.idHashes));
    }
    for (let r = 0; r < data.length; r++) {
      const handle = data.handles[r];
      if (!this.ids.has(handle)) throw new Error(`FeatureTables: the handle ${handle} is unknown`);
      if (this.ids.mainGroup(handle) >= 0 || this.ids.deltaLayer(handle) >= 0) {
        throw new Error(`FeatureTables: "${this.ids.idOf(handle)}" is already a row`);
      }
    }
    // The styles of a group built in a Worker get the numbers of the table of styles
    this.numberStyles(data);
    for (let r = 0; r < data.length; r++) {
      if (!this.styles.has(data.styles[r])) {
        throw new Error(`FeatureTables: a row names the style ${data.styles[r]}, which is unknown`);
      }
    }
    const group = createRowGroup(this.nextGroup++, data);
    layer.insert(group);
    // The rows that use each style are counted (a style no row uses is given again)
    for (let r = 0; r < data.length; r++) this.styles.retain(data.styles[r]);
    this.rowGroups.set(group.handle, { layer, group });
    for (let r = 0; r < data.length; r++) {
      const handle = data.handles[r];
      this.ids.setMain(handle, group.handle, r);
      this.ids.rehome(handle, data.ids, r);
    }
    for (let r = 0; r < data.length; r++) this.writeState(group, r);
    this.revisionCount++;
  }

  /** Makes the copy of the state of a row again */
  private writeState(group: RowGroup, row: number): void {
    const data = group.data;
    const handle = data.handles[row];
    const flags = data.flags[row];
    let state = this.states.stateOf(handle);
    if ((flags & ROW_FLAG_VISIBLE) === 0) state |= STATE_HIDDEN_INVISIBLE;
    if ((flags & ROW_FLAG_DELETED) !== 0) state |= STATE_HIDDEN_DELETED;
    const featureGroup = data.groups[row];
    if (featureGroup >= 0 && !this.groups.isVisible(featureGroup)) state |= STATE_HIDDEN_GROUP;
    if (rowType(data, row) === 'Circle') state |= STATE_UNIFORM;
    if (!group.delta) {
      // The copy of a row read elsewhere: in the delta, or in another group until it is in this
      if (this.ids.deltaLayer(handle) >= 0) state |= STATE_HIDDEN_DELTA;
      if (this.ids.mainGroup(handle) !== group.handle) state |= STATE_HIDDEN_WAIT;
    }
    group.state[row] = state;
    group.gpuState[row] = toGpuState(state);
  }

  /** Makes the copies of the state of the row of a handle again (in its group and its delta) */
  private refreshCopies(handle: RowHandle): void {
    const placed = this.rowGroups.get(this.ids.mainGroup(handle));
    if (placed) {
      this.writeState(placed.group, this.ids.mainRow(handle));
      placed.group.stateVersion++;
      placed.layer.touchItems();
    }
    const serial = this.ids.deltaLayer(handle);
    const delta = serial >= 0 ? this.layerList[serial].delta.group : null;
    if (delta) {
      this.writeState(delta, this.ids.deltaSlot(handle));
      delta.stateVersion++;
    }
  }

  /** Makes the copies of the rows whose state changed again */
  private refreshStates(handles: Int32Array): void {
    for (const handle of handles) {
      const placed = this.rowGroups.get(this.ids.mainGroup(handle));
      if (placed) {
        this.writeState(placed.group, this.ids.mainRow(handle));
        placed.group.stateVersion++;
      }
      const serial = this.ids.deltaLayer(handle);
      const delta = serial >= 0 ? this.layerList[serial].delta.group : null;
      if (delta) {
        this.writeState(delta, this.ids.deltaSlot(handle));
        delta.stateVersion++;
      }
    }
    this.revisionCount++;
  }
}

/** A budget without limit */
const UNBOUNDED_BUDGET: TableWorkBudget = {
  canStep: () => true,
  step: (work) => work(Number.POSITIVE_INFINITY),
};

/** The keys of the order of rows given to the builder */
function keySourceOf(inputs: readonly RowInput[]): RowKeySource {
  return {
    ids: utf8ColumnFromStrings(inputs.map((input) => input.id)),
    itemKeys: utf8ColumnFromStrings(inputs.map((input) => input.order)),
    memberKeys: utf8ColumnFromStrings(
      inputs.map((input) => ((input.group ?? -1) >= 0 ? (input.member ?? '') : '')),
    ),
    groups: Int32Array.from(inputs, (input) => input.group ?? -1),
  };
}

/** The keys of one row of a source, as a source of one row */
function oneKey(keys: RowKeySource, row: number): RowKeySource {
  return {
    ids: utf8ColumnFromStrings([utf8String(keys.ids, row)]),
    itemKeys: utf8ColumnFromStrings([utf8String(keys.itemKeys, row)]),
    memberKeys: utf8ColumnFromStrings([utf8String(keys.memberKeys, row)]),
    groups: Int32Array.of(keys.groups[row]),
  };
}

/** The union of two extents (null when both are) */
function unionBounds(a: BoundingBox | null, b: BoundingBox | null): BoundingBox | null {
  if (!a) return b;
  if (!b) return a;
  return {
    minX: Math.min(a.minX, b.minX),
    minY: Math.min(a.minY, b.minY),
    maxX: Math.max(a.maxX, b.maxX),
    maxY: Math.max(a.maxY, b.maxY),
  };
}

/** The draft of the change of a layer */
function draftOf(changes: Map<string, LayerChangeDraft>, layerId: string): LayerChangeDraft {
  let draft = changes.get(layerId);
  if (!draft) {
    draft = {
      created: [],
      updated: [],
      deleted: [],
      fields: new Set(),
      styleKeys: new Set(),
    };
    changes.set(layerId, draft);
  }
  return draft;
}

/** The changes of the layers, as the writer returns them */
function finishChanges(changes: Map<string, LayerChangeDraft>): Map<string, LayerRowsChange> {
  const out = new Map<string, LayerRowsChange>();
  for (const [layerId, draft] of changes) {
    out.set(layerId, {
      created: Int32Array.from(draft.created),
      updated: Int32Array.from(draft.updated),
      deleted: Int32Array.from(draft.deleted),
      fields: draft.fields,
      styleKeys: draft.styleKeys,
    });
  }
  return out;
}

/** The keys whose values differ between two styles */
function changedKeys(a: FeatureStyle, b: FeatureStyle): string[] {
  const out: string[] = [];
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
    if (JSON.stringify(left[key]) !== JSON.stringify(right[key])) out.push(key);
  }
  return out;
}

/** Checks that the arrays of a group have one entry per row */
function checkShape(data: RowGroupData): void {
  const n = data.length;
  const perRow: Array<[string, number]> = [
    ['handles', data.handles.length],
    ['ids', utf8ColumnLength(data.ids)],
    ['idHashes', data.idHashes.length],
    ['types', data.types.length],
    ['geometry.types', data.geometry.types.length],
    ['geometry.offsets', data.geometry.offsets.length],
    ['itemKeys', utf8ColumnLength(data.itemKeys)],
    ['memberKeys', utf8ColumnLength(data.memberKeys)],
    ['groups', data.groups.length],
    ['flags', data.flags.length],
    ['styles', data.styles.length],
    ['rowBounds', data.rowBounds.length / 4],
    ['triangles.offsets', data.triangles.offsets.length - 1],
  ];
  for (const [name, length] of perRow) {
    if (length !== n) {
      throw new Error(`FeatureTables: ${name} has ${length} entries for ${n} rows`);
    }
  }
  for (const column of data.properties.columns) {
    if (column.length !== n)
      throw new Error('FeatureTables: an attribute column has another length');
  }
}

/** The rows of one layer, read without making features */
class LayerTableViewImpl implements LayerTableView {
  constructor(
    private readonly store: FeatureTablesStore,
    private readonly table: LayerTable,
  ) {}

  get layerId(): string {
    return this.table.layerId;
  }

  get rowCount(): number {
    return this.table.rowCount;
  }

  listDrawnRows(bbox: BBox): Int32Array {
    const out: number[] = [];
    this.table.searchInOrder(bbox[0], bbox[1], bbox[2], bbox[3], (group, row) => {
      if ((group.state[row] & STATE_HIDDEN_MASK) === 0) out.push(group.data.handles[row]);
    });
    return Int32Array.from(out);
  }

  getRowBounds(handle: RowHandle): BBox | null {
    const at = this.locate(handle);
    if (!at) return null;
    const b = at.group.data.rowBounds;
    const i = at.row * 4;
    if (Number.isNaN(b[i])) return null;
    return [b[i], b[i + 1], b[i + 2], b[i + 3]];
  }

  getRowType(handle: RowHandle): FeatureType | null {
    const at = this.locate(handle);
    return at ? rowType(at.group.data, at.row) : null;
  }

  getRowPoint(handle: RowHandle): [number, number] | null {
    const at = this.locate(handle);
    return at ? rowPoint(at.group, at.row) : null;
  }

  valueAt(handle: RowHandle, key: string): unknown {
    const at = this.locate(handle);
    return at ? rowValue(at.group, at.row, key, this.store.strings) : undefined;
  }

  getRow(handle: RowHandle): Feature | undefined {
    const at = this.locate(handle);
    if (!at || (at.group.data.flags[at.row] & ROW_FLAG_DELETED) !== 0) return undefined;
    return rowFeature(this.store.readContext, this.table.layerId, at.group, at.row);
  }

  getDrawnRowsRevision(): number {
    return this.store.revision;
  }

  rowsInOrder(start: number, count: number): Int32Array {
    const handles = this.table.rowOrder().handles;
    const from = Math.max(0, Math.min(start, handles.length));
    return handles.slice(from, Math.max(from, Math.min(handles.length, from + Math.max(0, count))));
  }

  get itemCount(): number {
    return this.table.itemsOf().kinds.length;
  }

  itemsInOrder(start: number, count: number): ItemRefs {
    const items = this.table.itemsOf();
    const from = Math.max(0, Math.min(start, items.kinds.length));
    const to = Math.max(from, Math.min(items.kinds.length, from + Math.max(0, count)));
    return { kinds: items.kinds.slice(from, to), handles: items.handles.slice(from, to) };
  }

  groupMemberCount(group: number): number {
    return this.table.itemsOf().members.get(group)?.length ?? 0;
  }

  groupMembersInOrder(group: number, start: number, count: number): Int32Array {
    const members = this.table.itemsOf().members.get(group);
    if (!members) return new Int32Array(0);
    const from = Math.max(0, Math.min(start, members.length));
    return members.slice(from, Math.max(from, Math.min(members.length, from + Math.max(0, count))));
  }

  /** The group and row a handle is read from, when its row is in this layer */
  private locate(handle: RowHandle): { group: RowGroup; row: number } | null {
    const place = this.store.placeOf(handle);
    if (!place || place.layer !== this.table) return null;
    return { group: place.group, row: place.row };
  }
}
