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

import {
  type CoordinateDimensions,
  type CoordinateSystem,
  dimsWithin,
  isCoordinateDimensions,
  planarCoordinates,
  utf8ColumnFromStrings,
  utf8ColumnLength,
  utf8String,
  ValueStringCache,
} from '@sakuzu/tabane';
import type { Position } from 'geojson';
import type {
  FeatureTables,
  FeatureTablesOptions,
  FeatureTablesWorker,
  FeatureTablesWriter,
  ItemHandles,
  LayerRowsChange,
  LayerTableView,
  OpenedApplyOptions,
  RowApplyOptions,
  RowCursor,
  RowField,
  RowHandle,
  RowsChange,
  RowWrite,
  TableGroupPatch,
  TableScanOptions,
} from '../api/tables.js';
import type { BBox } from '../geometry/types.js';
import { circleRowRings } from '../shared/circle-rings.js';
import { DrawError } from '../shared/draw-error.js';
import { drawPropertyKey } from '../shared/properties.js';
import type {
  BoundingBox,
  Feature,
  FeatureStyle,
  FeatureType,
  ItemOrderChange,
  RestoreToken,
  RowValues,
  StoreChange,
} from '../shared/types/model.js';
import { getBoundingBox } from '../shared/utils/feature-bbox.js';
import type { IdleScheduler } from '../shared/utils/idle.js';
import {
  createRowBlockDataBuilder,
  ROW_BLOCK_TARGET_ROWS,
  type RowInput,
} from '../table/row-group-builder.js';
import { mergeRowBlockData } from '../table/row-group-merge.js';
import {
  ROW_FLAG_DELETED,
  ROW_FLAG_LOCKED,
  ROW_FLAG_VISIBLE,
  type RowBlockData,
} from '../table/row-group-types.js';
import { compareRowKeys, type RowKeySource } from '../table/row-keys.js';
import { type BulkOperation, planBulk } from './bulk-plan.js';
import type { RowContainers } from './bulk-rows.js';
import { featureFields, featureWithFields } from './feature-fields.js';
import { groupRunCuts, rowGroupsHolding } from './group-runs.js';
import { GroupTable } from './group-table.js';
import { translationBetween } from './held-move.js';
import { IdIndex } from './id-index.js';
import {
  groupKeyMoves,
  type ItemOrderSource,
  ItemOrderWatch,
  ORDER_ITEM_LIMIT,
} from './item-order.js';
import { ItemWalk } from './item-walk.js';
import { createRowGroup, LayerTable, overrideBytesOf, type RowGroup } from './layer-table.js';
import { RowBoxIndex } from './row-box-index.js';
import {
  type RowReadContext,
  rowFeature,
  rowGeometry,
  rowInputOf,
  rowPoint,
  rowType,
  rowValue,
} from './row-read.js';
import { noteRowState } from './row-skips.js';
import {
  RowStateSets,
  STATE_HIDDEN_DELETED,
  STATE_HIDDEN_DELTA,
  STATE_HIDDEN_GROUP,
  STATE_HIDDEN_INVISIBLE,
  STATE_HIDDEN_LOCAL,
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
import type { TableSelection } from './selection.js';
import { StyleTable } from './style-table.js';
import {
  type GroupHandle,
  type InPlaceRowWrite,
  ROW_WRITE_GEOMETRY,
  ROW_WRITE_STATE,
  ROW_WRITE_STYLE,
  ROW_WRITE_VALUES,
  type RowGroupHandle,
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

/** The tokens of the deletions kept, at most, when the options do not tell (`restoreLimit`) */
const RETAIN_TOKENS = 100;

/** The bytes of the rows the deletions keep, at most, when the options do not tell */
const RETAIN_BYTES = 64 * 1024 * 1024;

/** The bytes a row kept is counted as (4.10 of the design: a polygon of five corners) */
const RETAINED_ROW_BYTES = 342;

/**
 * The share of the rows of a group deleted and kept by nothing past which the group is due for
 * its next version (which leaves them out), and the number it always keeps before
 */
const DROPPED_ROWS_SHARE = 1 / 8;
const DROPPED_ROWS_MIN = 64;

/** The fields that place a row in the order of its layer or in another layer */
const PLACE_FIELDS: ReadonlySet<string> = new Set([
  'type',
  'layerId',
  'groupId',
  'order',
  'member',
]);

/** The fields a new row is written with: a deleted row written all of them is created again */
const CREATE_FIELDS: readonly RowField[] = ['type', 'layerId', 'geometry', 'order'];

/** The fields of the rows of a row group taken in, told as written (with their attributes) */
const ADDED_FIELDS: readonly RowField[] = [
  'type',
  'layerId',
  'groupId',
  'order',
  'member',
  'geometry',
  'visible',
  'locked',
  'style',
];

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
 * The options of the tables, with the ones core keeps to itself (the tests and the measurements
 * set them)
 *
 * @internal
 */
export interface FeatureTablesInternalOptions extends FeatureTablesOptions {
  /** The number of strings read from the columns that are kept (50,000 when omitted) */
  readonly stringCacheSize?: number;
  /**
   * The number of rows opened as features from which a row opened moved as a whole in the middle
   * of an edit (a drag of the selection) is drawn moved by its state rather than written in every
   * frame: its feature takes every value written, and its row is written once, with the values
   * the edit ends with (100 when omitted; `Infinity`: every row is written)
   */
  readonly moveOpenedByStateFrom?: number;
  /**
   * Runs a slice of the build of the index of the boxes of the rows while the page is idle
   * (`requestIdleCallback`, or a timer, when omitted): a test runs the slices itself
   */
  readonly whenIdle?: IdleScheduler;
}

/**
 * Creates the tables of the features of a document, as its reading and writing sides (the
 * implementation of `createFeatureTables`)
 *
 * @internal
 */
export function createFeatureTablesStore(options: FeatureTablesInternalOptions = {}): {
  tables: FeatureTables;
  writer: FeatureTablesWriter;
} {
  const store = new FeatureTablesStore(options);
  // A read through the reading side lets the gate of the reads finish what is written first
  // (`setReadGate`); core reads the rows through its internals
  const gate = (): void => store.readGate?.();
  // The views and the scans handed out read through the gate at each of their reads (a view kept
  // from before a write is read later); the drawing reads the views of the internals
  const gated = new WeakMap<LayerTableView, LayerTableView>();
  const tables: FeatureTables = {
    get: (layerId) => {
      gate();
      const view = store.view(layerId);
      if (!view) return undefined;
      let out = gated.get(view);
      if (!out) {
        out = new GatedLayerView(view, gate);
        gated.set(view, out);
      }
      return out;
    },
    findRow: (id) => {
      gate();
      return store.handleOf(id);
    },
    getRowId: (handle) => {
      gate();
      return store.ids.idOf(handle);
    },
    getGroupId: (groupHandle) => {
      gate();
      return store.groups.idOf(groupHandle);
    },
    findGroup: (id) => {
      gate();
      const group = store.groups.handleOfId(id);
      return group >= 0 ? group : undefined;
    },
    scan: (options) => {
      gate();
      const cursor = store.scan(options ?? {});
      return {
        next: () => {
          gate();
          return cursor.next();
        },
      };
    },
    readValues: (rows) => {
      gate();
      return store.readValues(rows);
    },
    release: (token) => {
      gate();
      store.release(token);
    },
    showInPlace: (owner, features) => {
      gate();
      store.showInPlace(owner, features);
    },
  };
  const writer: FeatureTablesWriter = {
    allocateHandles: (ids, hashes) => store.ids.allocate(ids, hashes),
    // The blocks are made by the builder and the merge of the library
    addRowBlocks: (layerId, blocks) =>
      store.addRowBlocks(layerId, blocks as readonly RowBlockData[]),
    raiseDimensions: (layerId, dimensions) => store.raiseDimensions(layerId, dimensions),
    apply: (values, options) => store.apply(values, options),
    applyGroups: (patch, options) => store.applyGroups(patch, options),
    applyOpened: (id, feature, options) => store.applyOpened(id, feature, options),
    lookup: (id) => store.lookup(id),
    createRestoreToken: () => store.createRestoreToken(),
    forget: (handles) => store.forget(handles),
    getGroupOrder: (groupHandle) => store.getGroupOrder(groupHandle),
    clear: () => store.clear(),
  };
  INTERNALS.set(tables, store);
  return { tables, writer };
}

/**
 * A view of a layer handed out by the reading side of the tables: each read goes through the gate
 * of the reads first (see `FeatureTablesInternals.setReadGate`), a check of one flag when there is
 * nothing to finish
 */
class GatedLayerView implements LayerTableView {
  constructor(
    private readonly view: LayerTableView,
    private readonly gate: () => void,
  ) {}

  get layerId(): string {
    return this.view.layerId;
  }
  get rowCount(): number {
    this.gate();
    return this.view.rowCount;
  }
  get rowCountWithDeleted(): number {
    this.gate();
    return this.view.rowCountWithDeleted;
  }
  get itemCount(): number {
    this.gate();
    return this.view.itemCount;
  }
  listDrawnRows(bbox: BBox): Int32Array {
    this.gate();
    return this.view.listDrawnRows(bbox);
  }
  getRowBounds(handle: RowHandle): BBox | null {
    this.gate();
    return this.view.getRowBounds(handle);
  }
  getRowType(handle: RowHandle): FeatureType | null {
    this.gate();
    return this.view.getRowType(handle);
  }
  getRowPoint(handle: RowHandle): Position | null {
    this.gate();
    return this.view.getRowPoint(handle);
  }
  getRowValue(handle: RowHandle, key: string): unknown {
    this.gate();
    return this.view.getRowValue(handle, key);
  }
  getRowStyle(handle: RowHandle): Readonly<FeatureStyle> | undefined {
    this.gate();
    return this.view.getRowStyle(handle);
  }
  getRow(handle: RowHandle): Feature | undefined {
    this.gate();
    return this.view.getRow(handle);
  }
  getDrawnRowsRevision(): number {
    this.gate();
    return this.view.getDrawnRowsRevision();
  }
  listRowHandles(start: number, count: number): Int32Array {
    this.gate();
    return this.view.listRowHandles(start, count);
  }
  listItems(start: number, count: number): ItemHandles {
    this.gate();
    return this.view.listItems(start, count);
  }
  countGroupMembers(groupHandle: number): number {
    this.gate();
    return this.view.countGroupMembers(groupHandle);
  }
  listGroupMembers(groupHandle: number, start: number, count: number): Int32Array {
    this.gate();
    return this.view.listGroupMembers(groupHandle, start, count);
  }
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
  /**
   * The keys of the order of groups of features written and not in the order read yet: their
   * members are read and drawn where the keys before put them until their reorder goes in. The
   * writes read the order written (`ItemWalk`)
   */
  readonly writtenOrders: ReadonlyMap<GroupHandle, string>;
  readonly states: RowStateSets;
  readonly strings: ValueStringCache;
  readonly readContext: RowReadContext;
  /** Changes with every change of the rows drawn of any layer */
  readonly revision: number;
  /** The rows of a layer (undefined for a layer that holds none) */
  layerTable(layerId: string): LayerTable | undefined;
  /** The reads of the rows of a layer without making features (undefined for a layer of none) */
  view(layerId: string): LayerTableView | undefined;
  /** The layer and the row group of a handle of a row group */
  rowGroup(handle: RowGroupHandle): { layer: LayerTable; group: RowGroup } | undefined;
  /** Where the row of a handle is read (undefined for a handle of no row) */
  placeOf(handle: RowHandle): RowPlace | undefined;
  /**
   * The rows of a layer whose boxes meet a box, in the order of the layer: the rows a click there
   * may hit. Every row of the tables is in one spatial index by the box it covers as it is drawn
   * (`row-box-index.ts`): the box of its positions, the box the calculation of its type gives
   * (`setRowBoxCalculator`), or for a row held, the box of its feature
   *
   * @param visit Receives each row, in order, with the group it is read from
   */
  searchRowBoxes(
    table: LayerTable,
    minX: number,
    minY: number,
    maxX: number,
    maxY: number,
    visit: (group: RowGroup, row: number) => void,
  ): void;
  /**
   * Sets how the box of the rows of a type is worked out from their features (the type of an
   * extension that covers more than its positions); undefined puts it back to its positions
   */
  setRowBoxCalculator(type: string, calculator: RowBoxCalculator | undefined): void;
  /** Sets the size of the tiles the boxes of the rows are worked out at (an Image, a calculation) */
  setRowBoxTileSize(tileSize: number): void;
  /** The rows in the index of the boxes, and the bytes it holds about */
  rowBoxIndexSize(): { readonly rows: number; readonly bytes: number };
  /** The handles of the row groups of a set of rows, the rows by group */
  groupsOfRows(handles: Int32Array): Map<RowGroupHandle, number[]>;
  /** Whether row groups built of new rows written are still waiting to be taken in */
  readonly hasQueuedBlocks: boolean;
  /**
   * Takes in the row groups built of new rows written that wait, one group per step, within the
   * budget of the frame (at least one group per call), but the ones of a layer whose reorder of
   * groups of features waits (taken in once it is in). A group that cannot be taken in goes to the
   * delta
   *
   * @returns Whether groups are still waiting
   */
  advanceQueuedBlocks(budget: TableWorkBudget): boolean;
  /**
   * Builds the new rows written and takes in every row group waiting at once (a host without
   * frames, the tests), but the ones of a layer whose reorder of groups of features waits (they are
   * taken in once it is in)
   */
  addQueuedRowBlocks(): void;
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
  onRowsWritten(
    listener: (layerId: string, writes: readonly InPlaceRowWrite[]) => void,
  ): () => void;
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
  /**
   * What the versions did: swapped so far, pending, the most held at once, the time of the last
   * merge (ms)
   */
  versionStats(): { swapped: number; pending: number; mostPending: number; lastMergeMs: number };
  /** Sets the bytes the versions held at once may take (the tests, the measurements) */
  setPendingVersionBytes(bytes: number): void;
  /** Takes every row out of the tables (see `FeatureTablesWriter.clear`) */
  clear(): void;
  /**
   * The rows the tables hold and the positions of their geometries: the rows of the blocks of
   * every layer, of the rows changed since (the delta) and of the blocks waiting to be taken in
   * (deleted rows kept included), what the memory of the tables is estimated from
   */
  size(): { readonly rows: number; readonly positions: number };
  /** The values the rows of `rows` have now, for its fields (see `FeatureTables.readValues`) */
  readValues(rows: RowValues): RowValues;
  /**
   * The write of an operation on the rows of a selection of many rows (null when it writes
   * nothing or is refused): read only, nothing is written (`bulk-plan.ts`)
   */
  planBulk(op: BulkOperation, rows: TableSelection, containers: RowContainers): RowWrite | null;
  /**
   * Calls `listener` with the rows of a selection of many features once it is decided (a box let
   * go of, every feature selected), and with null once there is none: what moves them on the
   * terrain (the moving parts of the drape) starts being built then, before they are pressed
   *
   * @returns The function that stops the calls
   */
  onBulkSelected(listener: (rows: TableSelection | null) => void): () => void;
  /**
   * Hides or shows the rows of a group of features on this client only, as the features of a
   * group hidden on this client are: the rows that are in the group by the id, now and while it
   * is hidden, are not drawn and not hit
   */
  setGroupHidden(groupId: string, hidden: boolean): void;
  /** Tells the listeners of `onBulkSelected` the rows of a selection of many features decided */
  bulkSelected(rows: TableSelection | null): void;
  /** Whether the row of a handle is held as a feature */
  isHeld(handle: RowHandle): boolean;
  /** The number of rows held as features */
  readonly heldCount: number;
  /** The handles of the rows held as features */
  heldHandles(): IterableIterator<RowHandle>;
  /**
   * The values of a row held without the ones an edit wrote in its middle and did not end
   * (undefined for an id not held): what an undone edit writes back
   */
  heldCommitted(id: string): Feature | undefined;
  /**
   * Makes rows features for this client: the rows `owner` names are now these (the ones it named
   * before and no other owner names are no longer). A row held is a {@link Feature} the Store
   * gives as it is (`getOpenedFeature`) until it is no longer held; it stays a row of the table, drawn
   * from the table while it is not changed. The change is notified as `held`, not as a change of
   * the document. An id of no row, or of a deleted one, is not held.
   *
   * The instance holds the rows selected and edited (`core:selection`) and, for a moment, the row
   * a click is on (`core:pointer`).
   *
   * @param owner Who holds the rows
   * @param ids The ids of the rows it holds (none: it holds no row any more)
   */
  open(owner: string, ids: readonly string[]): void;
  /** The feature of a row held (undefined for an id not held) */
  getOpenedFeature(id: string): Feature | undefined;
  /**
   * Draws features in the places of rows, for this client only: the features `owner` draws over
   * rows are now these (the ones it drew before and does not give are no longer drawn). A
   * feature is drawn in the place of the row of its id, which is not drawn while it is (and is
   * still hit where it is); a feature of no row is drawn at the end of its layer. Nothing is
   * written: the rows, what is read of them and the notifications of the document stay as they
   * are. The edits of others in their middle are shown so.
   *
   * @param owner Who draws the features
   * @param features The features it draws (none: it draws none any more)
   */
  showInPlace(owner: string, features: readonly Feature[]): void;
  /**
   * Sets what a read through the reading side of the tables (`FeatureTables`) calls first (none:
   * nothing): the Store finishes there a write it makes over several tasks, so that what is read
   * is what the write leaves. Each read of a view of a layer and each batch of a scan handed out
   * goes through it, a view kept from before included
   */
  setReadGate(gate: (() => void) | null): void;
  /**
   * Tells the changes of the order of a write made in several parts (a restore written in steps)
   * once, as one write of the whole of it would: the items it disturbs are read now, the writes of
   * rows tell no change of the order until the function returned is called, which tells the
   * changes the whole write made
   */
  watchOrderOf(patch: RowValues): () => void;
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
  /** Its rows not taken in yet */
  readonly rows: DeltaInput[];
  /** The keys of the first and the last row */
  first: RowKeySource;
  last: RowKeySource;
  /** The frames since a row was added */
  idle: number;
  /**
   * Gathering rows, being built in a Worker, built and queued to be taken in, or ended (taken
   * in, or put in the delta)
   */
  status: 'gathering' | 'building' | 'queued' | 'done';
  /** The number of its row groups queued and not taken in yet */
  queued: number;
  /**
   * Its rows not taken in yet, built to be read (not drawn) until they are: made when first read
   * after a change of its rows (`dropReading`)
   */
  reading: { readonly group: RowGroup; readonly rows: ReadonlyMap<RowHandle, number> } | null;
  /**
   * Its rows not taken in yet by their handles, to read a value of one without building them
   * (made when first read after a change of its rows)
   */
  inputs: Map<RowHandle, RowInput> | null;
}

/**
 * How the box of a row of a type is worked out from its feature
 *
 * @internal
 */
export type RowBoxCalculator = (feature: Feature, tileSize: number) => BoundingBox;

/** A row held as a feature */
interface HeldRow {
  /** The feature given for it */
  feature: Feature;
  /** Its values without the ones an edit wrote in its middle and did not end */
  committed: Feature;
  /** The fields an edit wrote in its middle and did not end */
  readonly intermediate: Set<RowField>;
  /**
   * The geometry its row holds while the row is drawn moved by its state (the moving set of the
   * rows held, `HELD_MOVE_SET`): the geometry of its feature is this one moved as a whole, and is
   * not written to the row (undefined while the row is written)
   */
  moved: { readonly geometry: Feature['geometry'] } | undefined;
}

/** The moving set the rows held moved as a whole in the middle of an edit are in */
const HELD_MOVE_SET = 1;

/** The number of rows held from which a row held moved as a whole is moved by its state */
const MOVE_HELD_BY_STATE_FROM = 100;

/** A feature drawn over a row for this client */
interface OverlayEntry {
  /** The row of the delta it is drawn as */
  readonly handle: RowHandle;
  /** Its layer */
  readonly layer: LayerTable;
  /** The row it is drawn over (undefined for a feature of no row) */
  readonly over: RowHandle | undefined;
}

/** A row group given to `adopt`, or built of new rows, waiting to be taken in */
interface Adoption {
  readonly layer: LayerTable;
  readonly data: RowBlockData;
  /** The new rows written the group is built of (put in the delta when it cannot be taken in) */
  readonly creation: Creation;
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
  /** What a read through the reading side calls first (see `setReadGate`) */
  readGate: (() => void) | null = null;
  /** The changes of the order of a write made in several parts, under way (`watchOrderOf`) */
  private partsWatch: { readonly watch: ItemOrderWatch | null } | null = null;
  readonly ids = new IdIndex();
  readonly styles = new StyleTable();
  readonly groups = new GroupTable();
  readonly writtenOrders = new Map<GroupHandle, string>();
  readonly strings: ValueStringCache;
  readonly states: RowStateSets;
  readonly readContext: RowReadContext;
  private readonly layers = new Map<string, LayerTable>();
  /** The layers by their serial number */
  private readonly layerList: LayerTable[] = [];
  private readonly views = new Map<string, LayerTableView>();
  /** The ids of the groups of features hidden on this client */
  private readonly hiddenGroupIds = new Set<string>();
  private readonly rowGroups = new Map<RowGroupHandle, { layer: LayerTable; group: RowGroup }>();
  private nextGroup = 0;
  private revisionCount = 0;
  /** The number of the last change written (the rows of the delta keep the one they were in) */
  private writeCount = 0;
  /** The row groups given to `adopt` and not taken in yet, in the order they were given */
  private readonly adoptions: Adoption[] = [];
  /** The new rows built into groups of their own, being gathered or built */
  private readonly creations: Creation[] = [];
  /** The creation of each row in one */
  private readonly creationOf = new Map<RowHandle, Creation>();
  private readonly workListeners = new Set<() => void>();
  private readonly writeListeners = new Set<
    (layerId: string, writes: readonly InPlaceRowWrite[]) => void
  >();
  private readonly deltaListeners = new Set<(layerId: string) => void>();
  private readonly touchListeners = new Set<(layerId: string, bounds: BoundingBox) => void>();
  readonly groupsDue = new Set<RowGroupHandle>();
  private readonly versions: GroupVersions;
  private readonly worker: FeatureTablesWorker | undefined;
  private readonly onChange: ((change: StoreChange) => void) | undefined;
  private readonly onRelease: ((handles: Int32Array) => void) | undefined;
  /** The features drawn over rows for this client, by owner and by id */
  private readonly overlays = new Map<string, Map<string, OverlayEntry>>();
  /** The rows of the deltas that are features drawn over rows (drawn, not read) */
  private readonly drawnOnlyRows = new Set<RowHandle>();
  /** The rows a feature is drawn over */
  private overlaidRows = new Set<RowHandle>();
  /** The rows held as features, by owner */
  private readonly holders = new Map<string, ReadonlySet<RowHandle>>();
  /** The rows held, with their features */
  private readonly heldRows = new Map<RowHandle, HeldRow>();
  /**
   * The rows each deletion of this client keeps, by token, in the order the tokens were made (a
   * token that keeps groups only has no row)
   */
  private readonly retained = new Map<number, Set<RowHandle>>();
  /** The token that keeps each deleted row kept */
  private readonly retainOf = new Map<RowHandle, number>();
  /** The groups of features each deletion of this client keeps, by token */
  private readonly retainedGroups = new Map<number, Set<GroupHandle>>();
  /** The token that keeps each deleted group kept */
  private readonly groupRetainOf = new Map<GroupHandle, number>();
  private nextToken = 1;
  /** The most tokens and bytes the deletions kept may hold (`FeatureTablesOptions.restoreLimit`) */
  private readonly retainTokens: number;
  private readonly retainBytes: number;
  /** The deleted rows whose ids are forgotten, freed once their rows are gone */
  private readonly forgotten = new Set<RowHandle>();
  /**
   * The groups of features deleted that rows still name or a token keeps (taken out once none
   * does)
   */
  private readonly deletedGroups = new Set<GroupHandle>();
  /** `FeatureTablesInternalOptions.moveOpenedByStateFrom` */
  private readonly moveHeldByStateFrom: number;
  /** `FeatureTablesOptions.dimensionsOf` */
  private readonly declaredDims: ((layerId: string) => CoordinateDimensions) | undefined;
  /** The system of the coordinates of the rows (`FeatureTablesOptions.coordinates`) */
  private readonly coordinates: CoordinateSystem;
  /** The dimensions raised of the layers that hold no rows yet (`raiseDimensions`) */
  private readonly raisedDims = new Map<string, CoordinateDimensions>();
  /** The boxes of every row, in one spatial index (the rows a click may hit) */
  private readonly rowBoxes: RowBoxIndex;
  /** How the boxes of the rows of some types are worked out from their features */
  private readonly rowBoxCalculators = new Map<string, RowBoxCalculator>();
  private rowBoxTileSize = 512;

  constructor(options: FeatureTablesInternalOptions) {
    this.strings = new ValueStringCache(options.stringCacheSize);
    this.states = new RowStateSets((handles) => this.refreshStates(handles));
    this.declaredDims = options.dimensionsOf;
    this.coordinates = options.coordinateSystem ?? planarCoordinates;
    this.readContext = {
      styles: this.styles,
      groups: this.groups,
      strings: this.strings,
      dimensionsOf: (layerId) => this.dimsOfLayer(layerId),
    };
    this.worker = options.worker;
    this.onChange = options.onChange;
    this.onRelease = options.onRelease;
    this.versions = new GroupVersions(this.versionHost());
    this.retainTokens = options.restoreLimit?.tokens ?? RETAIN_TOKENS;
    this.retainBytes = options.restoreLimit?.bytes ?? RETAIN_BYTES;
    this.moveHeldByStateFrom = options.moveOpenedByStateFrom ?? MOVE_HELD_BY_STATE_FROM;
    this.rowBoxes = new RowBoxIndex(
      {
        boxOf: (handle, out) => this.rowBoxOf(handle, out),
        rowLists: () => this.layerList.map((layer) => layer.rowOrder().handles),
        countRows: () => {
          let count = 0;
          for (const layer of this.layerList) count += layer.groupRowCount + layer.delta.length;
          return count;
        },
      },
      { whenIdle: options.whenIdle },
    );
  }

  /**
   * The box of a row as it is drawn now, and the number of its layer (null for no row): the box of
   * the feature of a row held, the box the calculation of its type gives (an Image, the type of an
   * extension), or the box of its positions
   */
  private rowBoxOf(handle: RowHandle, out: Float64Array): number | null {
    const place = this.placeOf(handle);
    if (!place) return null;
    const { layer, group, row } = place;
    if ((group.data.flags[row] & ROW_FLAG_DELETED) !== 0) return null;
    const held = this.heldRows.get(handle);
    const type = held ? held.feature.type : rowType(group.data, row);
    const calculator = this.rowBoxCalculators.get(type);
    if (held || calculator || type === 'Image') {
      const feature = held?.feature ?? rowFeature(this.readContext, layer.layerId, group, row);
      const box = calculator
        ? calculator(feature, this.rowBoxTileSize)
        : getBoundingBox(feature, this.rowBoxTileSize);
      if (![box.minX, box.minY, box.maxX, box.maxY].every(Number.isFinite)) return null;
      out[0] = box.minX;
      out[1] = box.minY;
      out[2] = box.maxX;
      out[3] = box.maxY;
      return layer.serial;
    }
    return layer.rowBox(group, row, out) ? layer.serial : null;
  }

  searchRowBoxes(
    table: LayerTable,
    minX: number,
    minY: number,
    maxX: number,
    maxY: number,
    visit: (group: RowGroup, row: number) => void,
  ): void {
    table.visitInOrder(this.rowsInBox(table, minX, minY, maxX, maxY), visit);
  }

  /** The rows of a layer whose boxes meet a box, by the group they are read from */
  private rowsInBox(
    table: LayerTable,
    minX: number,
    minY: number,
    maxX: number,
    maxY: number,
  ): Map<RowGroup, number[]> {
    const found = new Map<RowGroup, number[]>();
    // The rows found come by neighbourhoods, often many of one group after another: the group of
    // the last row and its list are kept
    let lastGroup: RowGroup | null = null;
    let lastRows: number[] = [];
    for (const handle of this.rowBoxes.search(table.serial, minX, minY, maxX, maxY)) {
      const place = this.placeOf(handle);
      if (!place || place.layer !== table) continue;
      if (place.group !== lastGroup) {
        lastGroup = place.group;
        let rows = found.get(place.group);
        if (!rows) {
          rows = [];
          found.set(place.group, rows);
        }
        lastRows = rows;
      }
      lastRows.push(place.row);
    }
    return found;
  }

  setRowBoxCalculator(type: string, calculator: RowBoxCalculator | undefined): void {
    if (calculator) this.rowBoxCalculators.set(type, calculator);
    else this.rowBoxCalculators.delete(type);
    this.rowBoxes.markAll();
  }

  setRowBoxTileSize(tileSize: number): void {
    if (tileSize === this.rowBoxTileSize) return;
    this.rowBoxTileSize = tileSize;
    this.rowBoxes.markAll();
  }

  rowBoxIndexSize(): { readonly rows: number; readonly bytes: number } {
    this.rowBoxes.search(-1, 0, 0, 0, 0);
    return { rows: this.rowBoxes.size, bytes: this.rowBoxes.bytes };
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
      drawnOnly: (handle) => this.drawnOnlyRows.has(handle),
      mainGroup: (handle) => this.ids.mainGroup(handle),
      rowInput: (group, row) => rowInputOf(this.readContext, group, row),
      buildRows: (inputs, dims) => this.buildRows(inputs, dims),
      coordinates: this.coordinates,
      ringVertices: circleRowRings.ringVertices,
      groupKeys: this.groups,
      groupKeyList: () => this.groups.keyList(),
      orderVersionOf: (group) => this.groups.orderVersionOf(group),
      swapIn: (version, waiting) => this.swapIn(version, waiting),
      retainStyles: (data, count) => {
        for (let r = 0; r < data.length; r++) {
          if (count > 0) this.styles.retain(data.styles[r]);
          else this.styles.release(data.styles[r]);
        }
      },
      drops: (handle, group, row) => this.drops(handle, group, row),
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
    this.addQueuedRowBlocks();
    for (let i = 0; i < 64 && (i === 0 || this.versions.hasWork); i++) {
      const before = this.versions.swapped;
      this.versions.advance(unbounded, false);
      this.versions.swapReady();
      // The row groups that waited for a reorder swapped in now
      this.addQueuedRowBlocks();
      if (this.versions.swapped === before && this.versions.built().length > 0) break;
    }
  }

  /**
   * Whether a reorder of the groups of features of a layer waits to go in: the keys of its groups
   * are going to change, so nothing new is put among its row groups until then (row groups taken
   * in, new rows built into groups of their own, next versions): what is placed by the keys
   * written would be put among the groups by the keys before
   */
  private reorderWaits(layer: LayerTable): boolean {
    return this.versions.reorders(layer).length > 0;
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

  versionStats(): { swapped: number; pending: number; mostPending: number; lastMergeMs: number } {
    return {
      swapped: this.versions.swapped,
      pending: this.versions.built().length,
      mostPending: this.versions.mostPending,
      lastMergeMs: this.versions.lastMergeMs,
    };
  }

  setPendingVersionBytes(bytes: number): void {
    this.versions.pendingBytesLimit = bytes;
  }

  clear(): void {
    this.rowBoxes.markAll();
    // The rows opened as features are let go of, without writing them (their rows go)
    const removed: string[] = [];
    for (const [handle, held] of this.heldRows) {
      this.stopMove(handle, held);
      removed.push(held.feature.id);
    }
    this.heldRows.clear();
    this.holders.clear();
    // The features drawn in the places of rows, and the marks of the rows selected in bulk and
    // dragged by their values (the marks of the rows hidden on this client stay with their
    // handles, which the rows of the same ids get again)
    if (this.overlaidRows.size > 0)
      this.states.setOverlaid(Int32Array.from(this.overlaidRows), false);
    this.overlays.clear();
    this.drawnOnlyRows.clear();
    this.overlaidRows = new Set();
    const marked = Int32Array.from(this.states.bulkHandles());
    if (marked.length > 0) {
      this.states.setBulk(marked, false);
      this.states.setByValues(marked, false);
    }
    // The next versions and the work given to the Worker are dropped (what comes back is not
    // taken in), and the blocks queued and the new rows gathered go
    this.versions.clear();
    for (const creation of [...this.creations]) this.endCreation(creation);
    this.creations.length = 0;
    this.creationOf.clear();
    this.adoptions.length = 0;
    // The keys of the order of the groups written go into the table of the groups at once
    for (const [group, key] of this.writtenOrders) this.groups.setOrder(group, key);
    this.writtenOrders.clear();
    // The rows of every layer: their styles let go of, and their handles placed nowhere (an id
    // keeps its handle until the Store forgets it)
    const release = (group: RowGroup): void => {
      const data = group.data;
      for (let r = 0; r < data.length; r++) {
        this.styles.release(data.styles[r]);
        const handle = data.handles[r];
        if (handle < 0) continue;
        if (group.delta) this.ids.setDelta(handle, -1, -1);
        else if (this.ids.mainGroup(handle) === group.handle) this.ids.setMain(handle, -1, -1);
      }
    };
    for (const layer of this.layers.values()) {
      // A layer keeps the dimensions of its coordinates for the rows that come next
      this.raisedDims.set(layer.layerId, layer.dims);
      for (let g = 0; g < layer.groupCount; g++) release(layer.groupAt(g));
      if (layer.delta.group) release(layer.delta.group);
    }
    this.layers.clear();
    this.layerList.length = 0;
    this.views.clear();
    this.rowGroups.clear();
    this.groupsDue.clear();
    // The deletions kept: their rows are gone, and the groups deleted that they kept go too
    for (const token of [...this.retainedGroups.keys()]) this.releaseGroups(token);
    this.retained.clear();
    this.retainOf.clear();
    for (const group of [...this.deletedGroups]) {
      this.deletedGroups.delete(group);
      this.groups.delete(group);
    }
    // The ids forgotten are freed now that no row holds them
    for (const handle of [...this.forgotten]) this.freeIfGone(handle);
    this.revisionCount++;
    this.onChange?.({
      reset: true,
      ...(removed.length > 0 && { opened: { added: [], removed } }),
    });
    this.notifyWork();
  }

  size(): { readonly rows: number; readonly positions: number } {
    let rows = 0;
    let positions = 0;
    for (const layer of this.layers.values()) {
      for (let g = 0; g < layer.groupCount; g++) {
        const data = layer.groupAt(g).data;
        rows += data.length;
        positions += data.vertexCount;
      }
      const delta = layer.delta.group?.data;
      if (delta) {
        rows += delta.length;
        positions += delta.vertexCount;
      }
    }
    for (const { data } of this.adoptions) {
      rows += data.length;
      positions += data.vertexCount;
    }
    return { rows, positions };
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

  /**
   * The dimensions of the coordinates of the rows of a layer: its own once it holds rows, the
   * ones the options declare for it before
   *
   * @throws when the options declare what is not dimensions
   */
  dimsOfLayer(layerId: string): CoordinateDimensions {
    const layer = this.layers.get(layerId);
    if (layer) return layer.dims;
    const raised = this.raisedDims.get(layerId);
    if (raised) return raised;
    const dims = this.declaredDims?.(layerId) ?? 'xy';
    if (!isCoordinateDimensions(dims)) {
      throw new DrawError(
        'invalid-state',
        `FeatureTables: the layer "${layerId}" has the dimensions ${dims}`,
      );
    }
    return dims;
  }

  /**
   * Raises the dimensions of the coordinates of a layer (see `FeatureTablesWriter.raiseDimensions`):
   * the rows built from then on have them, and every row group of the layer is due for its next
   * version, which copies its coordinates into them (the groups of before are read as they are
   * until then)
   */
  raiseDimensions(layerId: string, dims: CoordinateDimensions): void {
    if (!isCoordinateDimensions(dims))
      throw new DrawError('invalid-input', `FeatureTables: ${dims} are not dimensions`);
    const current = this.dimsOfLayer(layerId);
    if (!dimsWithin(current, dims)) {
      throw new DrawError(
        'invalid-input',
        `FeatureTables: the coordinates of ${current} cannot be lowered to ${dims}`,
      );
    }
    if (current === dims) return;
    const layer = this.layers.get(layerId);
    if (!layer) {
      this.raisedDims.set(layerId, dims);
      return;
    }
    for (const handle of this.heldRows.keys()) {
      if (this.placeOf(handle)?.layer === layer) {
        throw new DrawError(
          'invalid-state',
          `FeatureTables: a row of the layer "${layerId}" is opened as a feature, which holds x and y only`,
        );
      }
    }
    layer.dims = dims;
    for (let g = 0; g < layer.groupCount; g++) this.versions.markDue(layer.groupAt(g).handle);
    this.notifyWork();
  }

  /** The rows of a layer, made when first written (with the dimensions declared for it) */
  private layerOf(layerId: string): LayerTable {
    let layer = this.layers.get(layerId);
    if (!layer) {
      layer = new LayerTable(
        layerId,
        this.groups,
        this.layerList.length,
        this.nextGroup++,
        this.dimsOfLayer(layerId),
      );
      const table = layer;
      layer.setPendingSource(() => this.pendingGroups(table));
      layer.onRowBox = (handle) => this.rowBoxes.markOne(handle);
      layer.setDrawnOnly((handle) => this.drawnOnlyRows.has(handle));
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
    if (!this.findPlace(handle)) return undefined;
    return {
      layer: this.foundLayer as LayerTable,
      group: this.foundGroup as RowGroup,
      row: this.foundRow,
    };
  }

  /** The layer of the row the last `findPlace` found (read at once: the next search changes it) */
  foundLayer: LayerTable | null = null;
  /** The group of the row the last `findPlace` found */
  foundGroup: RowGroup | null = null;
  /** The row in its group the last `findPlace` found */
  foundRow = -1;

  /**
   * Finds where a row is read, as `placeOf` does, without making an object: true when it is
   * found, its layer, group and row then in `foundLayer`, `foundGroup` and `foundRow` (a read of a
   * value of each row of many makes nothing per row)
   */
  findPlace(handle: RowHandle): boolean {
    const serial = this.ids.deltaLayer(handle);
    if (serial >= 0) {
      const layer = this.layerList[serial];
      const group = layer.delta.group;
      if (group) return this.found(layer, group, this.ids.deltaSlot(handle));
    }
    const placed = this.rowGroups.get(this.ids.mainGroup(handle));
    if (placed) return this.found(placed.layer, placed.group, this.ids.mainRow(handle));
    // A new row read from its creation until its group is taken in
    const creation = this.creationOf.get(handle);
    const reading = creation ? this.readingOf(creation) : null;
    const row = reading?.rows.get(handle);
    if (!creation || !reading || row === undefined) return false;
    return this.found(creation.layer, reading.group, row);
  }

  private found(layer: LayerTable, group: RowGroup, row: number): true {
    this.foundLayer = layer;
    this.foundGroup = group;
    this.foundRow = row;
    return true;
  }

  /**
   * The input of a new row read from its creation, while its creation is not built to be read
   * (undefined for a row placed elsewhere, or once its creation is built to be read): a value of
   * the row is read from it without building the creation
   */
  newRowInputOf(handle: RowHandle): RowInput | undefined {
    if (this.ids.deltaLayer(handle) >= 0 || this.rowGroups.has(this.ids.mainGroup(handle))) {
      return undefined;
    }
    const creation = this.creationOf.get(handle);
    if (!creation || creation.reading) return undefined;
    if (!creation.inputs) {
      creation.inputs = new Map();
      for (const row of creation.rows) creation.inputs.set(row.handle, row.input);
    }
    return creation.inputs.get(handle);
  }

  handleOf(id: string): RowHandle | undefined {
    const handle = this.ids.handleOf(id);
    if (handle < 0) return undefined;
    const place = this.placeOf(handle);
    if (!place) return undefined;
    return (place.group.data.flags[place.row] & ROW_FLAG_DELETED) !== 0 ? undefined : handle;
  }

  /**
   * The key of the order of a group of features last written: the one not in the order read yet
   * (its members are read in the order before until its reorder goes in), or the one of the table
   * of the groups
   */
  getGroupOrder(group: GroupHandle): string | undefined {
    if (!this.groups.has(group)) return undefined;
    return this.writtenOrders.get(group) ?? this.groups.orderOf(group);
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
   * Takes row groups into a layer at once: every group is checked before any is taken in (its
   * shape, its dimensions, its groups of features, and that none of its ids is a row already), then
   * each is put at its place in the order of the layer (into the delta when its rows are not in the
   * order of their keys, overlap another group, or a reorder of the groups of the layer waits),
   * and its rows are told as created
   */
  addRowBlocks(layerId: string, groups: readonly RowBlockData[]): RowsChange {
    const dims = this.dimsOfLayer(layerId);
    for (const data of groups) {
      checkShape(data);
      checkDims(data, dims);
      if (data.length === 0)
        throw new DrawError('invalid-input', 'FeatureTables: an empty row group');
      for (let r = 0; r < data.length; r++) {
        const group = data.groups[r];
        if (group >= 0 && !this.groups.has(group)) {
          throw new DrawError(
            'not-found',
            `FeatureTables: a row names the group ${group}, which is unknown`,
          );
        }
        const handle = this.ids.handleOfEntry(data.ids, r, data.idHashes[r]);
        if (handle >= 0 && (this.ids.mainGroup(handle) >= 0 || this.ids.deltaLayer(handle) >= 0)) {
          throw new DrawError(
            'already-exists',
            `FeatureTables: "${this.ids.idOf(handle)}" is already a row`,
          );
        }
      }
    }
    const layer = this.layerOf(layerId);
    const drafts = new Map<string, LayerChangeDraft>();
    const draft = draftOf(drafts, layerId);
    for (const data of groups) {
      if (this.reorderWaits(layer)) this.rowsToDelta(layer, data);
      else this.adoptGroup(layer, data);
      for (let r = 0; r < data.length; r++) draft.created.push(data.handles[r]);
      for (const field of ADDED_FIELDS) draft.fields.add(field);
      for (const key of data.properties.keys) draft.fields.add(`property:${key}`);
    }
    const change: RowsChange = { layers: finishChanges(drafts) };
    this.onChange?.({ rows: change });
    this.notifyWork();
    return change;
  }

  get hasQueuedBlocks(): boolean {
    return this.adoptions.length > 0;
  }

  advanceQueuedBlocks(budget: TableWorkBudget): boolean {
    let at = 0;
    while (at < this.adoptions.length && budget.canStep()) {
      const next = this.adoptions[at];
      // The groups of a layer whose reorder waits wait with it, in their order
      if (this.reorderWaits(next.layer)) {
        at++;
        continue;
      }
      this.adoptions.splice(at, 1);
      budget.step(() => this.takeIn(next));
    }
    return this.adoptions.length > 0;
  }

  addQueuedRowBlocks(): void {
    this.advanceCreations(UNBOUNDED_BUDGET, false);
    let at = 0;
    while (at < this.adoptions.length) {
      const next = this.adoptions[at];
      if (this.reorderWaits(next.layer)) {
        at++;
        continue;
      }
      this.adoptions.splice(at, 1);
      this.takeIn(next);
    }
  }

  /**
   * Takes in a row group of new rows written, built and waiting: one that cannot be taken in goes
   * to the delta, and its rows are no longer read from their creation
   */
  private takeIn(adoption: Adoption): void {
    const creation = adoption.creation;
    try {
      this.adoptGroup(adoption.layer, adoption.data);
    } catch {
      this.rowsToDelta(adoption.layer, adoption.data);
    }
    this.settleCreated(creation, adoption.data);
  }

  /**
   * Takes the rows of a group of a creation taken in (or put in the delta) out of the creation,
   * and ends it once its last group is
   */
  private settleCreated(creation: Creation, data: RowBlockData): void {
    const taken = new Set<RowHandle>();
    for (let r = 0; r < data.length; r++) {
      const handle = data.handles[r];
      taken.add(handle);
      if (this.creationOf.get(handle) === creation) this.creationOf.delete(handle);
    }
    const kept = creation.rows.filter((row) => !taken.has(row.handle));
    creation.rows.length = 0;
    creation.rows.push(...kept);
    this.dropReading(creation);
    creation.queued--;
    if (creation.queued <= 0) this.endCreation(creation);
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
      // Its rows are read from it until the reorder of its layer is in, and built then
      if (this.reorderWaits(creation.layer)) continue;
      // Rows keep coming: the groups of the target size are built, the rest keeps gathering (so
      // a long import is not cut into a group per write)
      if (wait && creation.idle <= CREATE_WAIT_FRAMES) this.splitCreation(creation);
    }
    for (const creation of [...this.creations]) {
      if (creation.status !== 'gathering' || this.reorderWaits(creation.layer)) continue;
      if (wait && creation.idle <= CREATE_WAIT_FRAMES) continue;
      const worker = this.worker;
      if (worker && wait) {
        creation.status = 'building';
        const inputs = creation.rows.map((row) => row.input);
        worker
          .build(inputs, { groups: this.groups.keyList(), dimensions: creation.layer.dims })
          .then(
            (groups) => {
              if (creation.status !== 'building') return;
              // The host builds with the builder of the library
              this.queueCreation(creation, groups as RowBlockData[]);
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
    if (creation.rows.length < ROW_BLOCK_TARGET_ROWS) return;
    const keys = keySourceOf(creation.rows.map((row) => row.input));
    const order = creation.rows.map((_, i) => i);
    order.sort((a, b) => compareRowKeys(keys, a, keys, b, this.groups));
    const whole = order.length - (order.length % ROW_BLOCK_TARGET_ROWS);
    if (whole === 0) return;
    const rows = order.map((i) => creation.rows[i]);
    const head: Creation = {
      ...creation,
      rows: rows.slice(0, whole),
      first: oneKey(keys, order[0]),
      last: oneKey(keys, order[whole - 1]),
      reading: null,
      inputs: null,
    };
    // Built in this pass
    head.idle = CREATE_WAIT_FRAMES + 1;
    this.creations.splice(this.creations.indexOf(creation), 0, head);
    for (const row of head.rows) this.creationOf.set(row.handle, head);
    creation.rows.length = 0;
    creation.rows.push(...rows.slice(whole));
    this.dropReading(creation);
    if (creation.rows.length === 0) {
      this.endCreation(creation);
      return;
    }
    creation.first = oneKey(keys, order[whole]);
  }

  /** Builds the rows of a creation into row groups on the main thread */
  private buildCreation(creation: Creation): RowBlockData[] {
    const builder = createRowBlockDataBuilder({
      groups: this.groups.keyList(),
      dimensions: creation.layer.dims,
      coordinateSystem: this.coordinates,
      rings: circleRowRings,
    });
    for (const row of creation.rows) builder.addRow(row.input);
    return builder.finish();
  }

  /**
   * Queues the groups of a creation built, to be taken in (its rows are read from it until they
   * are)
   */
  private queueCreation(creation: Creation, groups: RowBlockData[]): void {
    if (groups.length === 0) {
      this.endCreation(creation);
      return;
    }
    creation.status = 'queued';
    creation.queued = groups.length;
    const wasPending = this.adoptions.length > 0;
    for (const data of groups) this.adoptions.push({ layer: creation.layer, data, creation });
    if (!wasPending && this.adoptions.length > 0) this.notifyWork();
  }

  /** Ends a creation: its rows not taken in are no longer read from it */
  private endCreation(creation: Creation): void {
    creation.status = 'done';
    const at = this.creations.indexOf(creation);
    if (at >= 0) this.creations.splice(at, 1);
    for (const row of creation.rows) {
      if (this.creationOf.get(row.handle) === creation) this.creationOf.delete(row.handle);
    }
    this.dropReading(creation);
  }

  /**
   * Builds and takes in a creation now (a row of it is written before it is taken in); while a
   * reorder of its layer waits, its rows not taken in go to the delta instead
   */
  private finishCreationNow(creation: Creation): void {
    if (this.reorderWaits(creation.layer)) {
      for (const adoption of this.adoptions.filter((entry) => entry.creation === creation)) {
        this.adoptions.splice(this.adoptions.indexOf(adoption), 1);
      }
      this.creationToDelta(creation);
      return;
    }
    if (creation.status === 'queued') {
      // Its groups are built: they are taken in now, before the groups queued before them
      const own = this.adoptions.filter((adoption) => adoption.creation === creation);
      for (const adoption of own) this.adoptions.splice(this.adoptions.indexOf(adoption), 1);
      for (const adoption of own) this.takeIn(adoption);
      return;
    }
    const groups = this.buildCreation(creation);
    creation.status = 'queued';
    creation.queued = groups.length;
    if (groups.length === 0) this.endCreation(creation);
    for (const data of groups) this.takeIn({ layer: creation.layer, data, creation });
  }

  /**
   * The new rows of a layer not taken in yet, built to be read: one group per creation of the
   * layer (made when first read after a change of its rows)
   */
  private pendingGroups(layer: LayerTable): RowGroup[] {
    const out: RowGroup[] = [];
    for (const creation of this.creations) {
      if (creation.layer !== layer || creation.rows.length === 0) continue;
      const reading = this.readingOf(creation);
      if (reading) out.push(reading.group);
    }
    return out;
  }

  /** The rows of a creation not taken in yet, built to be read (made when first read) */
  private readingOf(creation: Creation): Creation['reading'] {
    if (creation.reading || creation.rows.length === 0) return creation.reading;
    const data = this.buildRows(
      creation.rows.map((row) => row.input),
      creation.layer.dims,
    );
    if (!data) return null;
    const group = createRowGroup(-1, data, false, true);
    const rows = new Map<RowHandle, number>();
    for (let r = 0; r < data.length; r++) {
      rows.set(data.handles[r], r);
      this.styles.retain(data.styles[r]);
    }
    creation.reading = { group, rows };
    for (let r = 0; r < data.length; r++) this.writeState(group, r);
    return creation.reading;
  }

  /** Drops what was built to read the rows of a creation (its rows changed) */
  private dropReading(creation: Creation): void {
    const reading = creation.reading;
    creation.reading = null;
    creation.inputs = null;
    if (reading) {
      for (let r = 0; r < reading.group.data.length; r++) {
        this.styles.release(reading.group.data.styles[r]);
      }
    }
    creation.layer.touchPending();
  }

  /** Puts the rows of a creation into the delta (it could not be built) */
  private creationToDelta(creation: Creation): void {
    this.endCreation(creation);
    this.rebuildDelta(creation.layer, new Set(), creation.rows, ++this.writeCount);
    this.revisionCount++;
  }

  /**
   * Puts the rows of a row group that cannot be taken in as a group into the delta of its layer
   * (given to `adopt`, or built of new rows)
   */
  private rowsToDelta(layer: LayerTable, data: RowBlockData): void {
    this.numberStyles(data);
    data.handles.set(this.ids.allocate(data.ids, data.idHashes));
    this.rowBoxes.mark(data.handles);
    const group = createRowGroup(-1, data);
    const rows: DeltaInput[] = [];
    const seen = new Set<RowHandle>();
    for (let r = 0; r < data.length; r++) {
      const handle = data.handles[r];
      // A row read from a row group or a delta is not put there again (one read from its
      // creation, which it is about to leave, is), nor an id the group holds twice (its first)
      if (this.ids.mainGroup(handle) >= 0 || this.ids.deltaLayer(handle) >= 0) continue;
      if (seen.has(handle)) continue;
      seen.add(handle);
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
    if (target && target.rows.length >= ROW_BLOCK_TARGET_ROWS) target = null;
    if (!target) {
      if (rows.length < CREATE_GROUP_MIN_ROWS) return false;
      target = {
        layer,
        rows: [],
        first: oneKey(keys, first),
        last: oneKey(keys, last),
        idle: 0,
        status: 'gathering',
        queued: 0,
        reading: null,
        inputs: null,
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
    this.dropReading(target);
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

  onRowsWritten(
    listener: (layerId: string, writes: readonly InPlaceRowWrite[]) => void,
  ): () => void {
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
    const batch = Math.max(1, Math.floor(options.batchSize ?? SCAN_BATCH));
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
            if (bbox && options.order === 'any') {
              // The rows found in the index of the boxes, as it gives them
              for (const handle of this.rowBoxes.search(
                layer.serial,
                bbox[0],
                bbox[1],
                bbox[2],
                bbox[3],
              )) {
                const place = this.placeOf(handle);
                if (place?.layer === layer && layer.readsRow(place.group, place.row)) {
                  take(place.group, place.row);
                }
              }
            } else if (bbox) {
              this.searchRowBoxes(layer, bbox[0], bbox[1], bbox[2], bbox[3], take);
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
   * Writes values of rows (see `FeatureTablesWriter.apply`). A row held as a feature gets its
   * feature written too, notified as a change of the feature rather than of the row; the fields
   * an edit of it writes in its middle are kept for when the edit ends (`OpenedApplyOptions`)
   */
  apply(patch: RowValues, options: RowApplyOptions = {}): RowsChange {
    // A part of a write made in several parts: its changes of the order are told at its end
    const watch = this.partsWatch ? null : this.watchOrder(patch);
    const drafts = new Map<string, LayerChangeDraft>();
    const heldWritten: Array<{ handle: RowHandle; fields: Map<RowField, unknown> }> = [];
    if (this.heldRows.size === 0) {
      this.applyPatch(patch, drafts);
    } else {
      // The rows held are written one at a time, without the fields an edit holds apart
      const plain: number[] = [];
      const kept: Array<{ i: number; handle: RowHandle; fields: Map<RowField, unknown> }> = [];
      for (let i = 0; i < patch.handles.length; i++) {
        const handle = patch.handles[i];
        if (!this.heldRows.has(handle)) {
          plain.push(i);
          continue;
        }
        const fields = new Map<RowField, unknown>();
        for (const [field, values] of patch.fields) fields.set(field, values[i]);
        kept.push({ i, handle, fields });
      }
      this.checkRows(patch);
      if (plain.length > 0) this.applyPatch(subsetPatch(patch, plain), drafts);
      for (const { i, handle, fields } of kept) {
        const held = this.heldRows.get(handle) as HeldRow;
        const written = new Map<RowField, readonly unknown[]>();
        for (const [field, value] of fields) {
          if (!held.intermediate.has(field)) written.set(field, [value]);
        }
        const deleted = patch.deleted?.[i] ? Uint8Array.of(1) : undefined;
        this.applyPatch({ handles: Int32Array.of(handle), fields: written, deleted }, drafts);
        heldWritten.push({ handle, fields });
      }
    }
    const features = this.heldChanges(heldWritten, drafts);
    const kept = this.keepDeleted(patch, options.restoreToken);
    const change: RowsChange = { layers: finishChanges(drafts) };
    if (this.onChange) {
      // The values before, the token that keeps the rows deleted and the changes of the order go
      // with the last of the additions to the notification
      const order = watch?.finish() ?? [];
      const extra: StoreChange = {
        ...(order.length > 0 && { order }),
        ...(kept && options.restoreToken !== undefined && { restoreToken: options.restoreToken }),
      };
      const hasRows = change.layers.size > 0 || options.before !== undefined;
      if (hasRows) {
        this.onChange({
          rows: change,
          ...(options.before && { previousValues: options.before }),
          ...(!features && extra),
        });
      }
      if (features) this.onChange({ features, ...extra });
      if (!hasRows && !features && Object.keys(extra).length > 0) this.onChange(extra);
    }
    return change;
  }

  // === The rows deleted kept, forgotten ===

  createRestoreToken(): RestoreToken {
    return this.nextToken++ as RestoreToken;
  }

  /**
   * Keeps the rows a write deleted with its token, and takes the rows created again out of the
   * tokens that kept them; the row groups with many deleted rows nothing keeps are due for their
   * next versions
   *
   * @returns Whether the token keeps a row
   */
  private keepDeleted(patch: RowValues, token: RestoreToken | undefined): boolean {
    const deleted = patch.deleted;
    if (!deleted) return false;
    let kept = false;
    const groups = new Set<RowGroup>();
    for (let i = 0; i < patch.handles.length; i++) {
      const handle = patch.handles[i];
      const place = this.placeOf(handle);
      const isDeleted = !!place && (place.group.data.flags[place.row] & ROW_FLAG_DELETED) !== 0;
      if (deleted[i] && isDeleted && token !== undefined) {
        this.unkeep(handle);
        let set = this.retained.get(token);
        if (!set) {
          set = new Set();
          this.retained.set(token, set);
        }
        set.add(handle);
        this.retainOf.set(handle, token);
        kept = true;
        continue;
      }
      if (!isDeleted) this.unkeep(handle);
      else if (place) groups.add(place.group);
    }
    for (const group of groups) this.checkDeleted(group);
    if (kept) this.limitRetained(token as number);
    return kept;
  }

  /** Takes a row out of the token that keeps it */
  private unkeep(handle: RowHandle): void {
    const token = this.retainOf.get(handle);
    if (token === undefined) return;
    this.retainOf.delete(handle);
    this.retained.get(token)?.delete(handle);
  }

  /** Lets go of the oldest tokens past the limit of the deletions kept */
  private limitRetained(current: number): void {
    for (const token of [...this.retained.keys()]) {
      const over =
        this.retained.size > this.retainTokens ||
        this.retainOf.size * RETAINED_ROW_BYTES > this.retainBytes;
      if (!over) break;
      if (token === current && this.retained.size > 1) continue;
      this.release(token as RestoreToken);
    }
  }

  release(token: RestoreToken): void {
    const set = this.retained.get(token);
    if (!set) return;
    this.retained.delete(token);
    this.releaseGroups(token);
    const out: RowHandle[] = [];
    const groups = new Set<RowGroup>();
    for (const handle of set) {
      if (this.retainOf.get(handle) !== token) continue;
      this.retainOf.delete(handle);
      out.push(handle);
      const place = this.placeOf(handle);
      if (place) groups.add(place.group);
    }
    for (const group of groups) this.checkDeleted(group);
    if (out.length > 0) this.onRelease?.(Int32Array.from(out));
  }

  /** Keeps a group deleted with a token (the token counts among the tokens kept) */
  private keepGroup(group: GroupHandle, token: number): void {
    this.unkeepGroup(group);
    let set = this.retainedGroups.get(token);
    if (!set) {
      set = new Set();
      this.retainedGroups.set(token, set);
    }
    set.add(group);
    this.groupRetainOf.set(group, token);
    if (!this.retained.has(token)) this.retained.set(token, new Set());
  }

  /** Takes a group out of the token that keeps it */
  private unkeepGroup(group: GroupHandle): void {
    const token = this.groupRetainOf.get(group);
    if (token === undefined) return;
    this.groupRetainOf.delete(group);
    this.retainedGroups.get(token)?.delete(group);
  }

  /** Lets go of the groups a token keeps: the deleted ones no row names are taken out */
  private releaseGroups(token: number): void {
    const set = this.retainedGroups.get(token);
    if (!set) return;
    this.retainedGroups.delete(token);
    for (const group of set) {
      if (this.groupRetainOf.get(group) !== token) continue;
      this.groupRetainOf.delete(group);
      if (!this.deletedGroups.has(group) || this.groupsNamed([group]).has(group)) continue;
      this.deletedGroups.delete(group);
      this.groups.delete(group);
      this.writtenOrders.delete(group);
    }
  }

  /**
   * Marks a row group due for its next version when many of its rows are deleted and nothing
   * keeps them (they go with it)
   */
  private checkDeleted(group: RowGroup): void {
    if (group.delta || group.pending) return;
    const data = group.data;
    let count = 0;
    for (let r = 0; r < data.length; r++) {
      if ((data.flags[r] & ROW_FLAG_DELETED) === 0) continue;
      if (this.drops(data.handles[r], group, r)) count++;
    }
    if (count > Math.max(DROPPED_ROWS_MIN, data.length * DROPPED_ROWS_SHARE)) {
      this.versions.markDue(group.handle);
      this.notifyWork();
    }
  }

  /** Whether the next version of its group leaves a row out: deleted, and nothing keeps it */
  private drops(handle: RowHandle, group: RowGroup, row: number): boolean {
    return (
      (group.data.flags[row] & ROW_FLAG_DELETED) !== 0 &&
      !this.retainOf.has(handle) &&
      !this.heldRows.has(handle) &&
      !this.drawnOnlyRows.has(handle)
    );
  }

  lookup(id: string): { handle: RowHandle; deleted: boolean } | undefined {
    const handle = this.ids.handleOf(id);
    if (handle < 0) return undefined;
    const place = this.placeOf(handle);
    return {
      handle,
      deleted: !place || (place.group.data.flags[place.row] & ROW_FLAG_DELETED) !== 0,
    };
  }

  forget(handles: Int32Array): void {
    const groups = new Set<RowGroup>();
    for (const handle of handles) {
      if (!this.ids.isLinked(handle) || this.retainOf.has(handle)) continue;
      const place = this.placeOf(handle);
      if (place && (place.group.data.flags[place.row] & ROW_FLAG_DELETED) === 0) continue;
      this.ids.unlink(handle);
      this.forgotten.add(handle);
      if (place) groups.add(place.group);
      this.freeIfGone(handle);
    }
    for (const group of groups) {
      if (group.delta || group.pending) continue;
      this.versions.markDue(group.handle);
    }
    if (groups.size > 0) this.notifyWork();
  }

  /** Frees the handle of a row forgotten once it is in no row group and no delta */
  private freeIfGone(handle: RowHandle): void {
    if (!this.forgotten.has(handle)) return;
    if (this.ids.mainGroup(handle) >= 0 || this.ids.deltaLayer(handle) >= 0) return;
    if (this.creationOf.has(handle)) return;
    this.forgotten.delete(handle);
    this.states.clear(handle);
    this.ids.free(handle);
  }

  readValues(patch: RowValues): RowValues {
    const n = patch.handles.length;
    const fields = new Map<RowField, unknown[]>();
    for (const field of patch.fields.keys()) fields.set(field, new Array(n).fill(undefined));
    const deleted = patch.deleted ? new Uint8Array(n) : undefined;
    for (let i = 0; i < n; i++) {
      const place = this.placeOf(patch.handles[i]);
      if (!place) {
        if (deleted) deleted[i] = 1;
        continue;
      }
      const { group, row } = place;
      const data = group.data;
      if (deleted) deleted[i] = (data.flags[row] & ROW_FLAG_DELETED) !== 0 ? 1 : 0;
      for (const [field, values] of fields) values[i] = this.fieldOf(place, field);
    }
    return { handles: Int32Array.from(patch.handles), fields, ...(deleted && { deleted }) };
  }

  /** The value of a field of a row, as a feature holds it */
  private fieldOf(place: RowPlace, field: RowField): unknown {
    const { group, row } = place;
    const data = group.data;
    const featureGroup = data.groups[row];
    switch (field) {
      case 'type':
        return rowType(data, row);
      case 'layerId':
        return place.layer.layerId;
      case 'groupId':
        return featureGroup >= 0 ? this.groups.idOf(featureGroup) : undefined;
      case 'order':
        return utf8String(data.itemKeys, row);
      case 'member':
        return featureGroup >= 0 ? utf8String(data.memberKeys, row) : undefined;
      case 'geometry':
        return rowGeometry(group, row) ?? undefined;
      case 'visible':
        return (data.flags[row] & ROW_FLAG_VISIBLE) !== 0;
      case 'locked':
        return (data.flags[row] & ROW_FLAG_LOCKED) !== 0;
      case 'style':
        return this.styles.get(data.styles[row]);
      default:
        return rowValue(group, row, field.slice('property:'.length), this.strings);
    }
  }

  /**
   * The items of the layers and the groups a write puts rows in, takes rows from, creates or
   * deletes rows in, kept before it to tell the changes of the order it makes (null when it makes
   * none, or when nothing is told)
   */
  private watchOrder(patch: RowValues): ItemOrderWatch | null {
    if (!this.onChange) return null;
    const { handles, fields, deleted } = patch;
    const layerIds = fields.get('layerId');
    const groupIds = fields.get('groupId');
    const orders = fields.get('order');
    const members = fields.get('member');
    const placeFields = !!(layerIds || groupIds || orders || members);
    // Rows only deleted and created again, more than are told one at a time: they are told by
    // the change of the rows alone (`ItemOrderWatch`), so nothing is kept for them (the deletion
    // of a layer of 100,000 rows, and its undo)
    if (!placeFields && handles.length > ORDER_ITEM_LIMIT) {
      let flips = 0;
      for (let i = 0; i < handles.length; i++) {
        const place = this.placeOf(handles[i]);
        const there = !!place && (place.group.data.flags[place.row] & ROW_FLAG_DELETED) === 0;
        if (there ? !!deleted?.[i] : !!place && !deleted?.[i]) flips++;
      }
      if (flips > ORDER_ITEM_LIMIT) return null;
    }
    const watch = new ItemOrderWatch(this.orderSource);
    const groupOf = (value: unknown): GroupHandle =>
      typeof value === 'string' && value !== '' ? this.groups.handleOfId(value) : -1;
    for (let i = 0; i < handles.length; i++) {
      const handle = handles[i];
      const place = this.placeOf(handle);
      const deleting = !!deleted?.[i];
      if (!place || (place.group.data.flags[place.row] & ROW_FLAG_DELETED) !== 0) {
        // A new row, or a deleted one created again
        const layerId = (layerIds?.[i] as string | undefined) ?? place?.layer.layerId;
        if (deleting || layerId === undefined) continue;
        watch.watchLayer(layerId);
        watch.watchGroup(groupOf(groupIds?.[i]));
        watch.row(handle, false);
        continue;
      }
      const data = place.group.data;
      const row = place.row;
      const group = data.groups[row];
      if (deleting) {
        watch.watchLayer(place.layer.layerId);
        watch.watchGroup(group);
        watch.row(handle, true);
        continue;
      }
      // A row there that no field of its place is written for keeps its place
      if (!placeFields) continue;
      const layerId = layerIds?.[i] as string | undefined;
      const nextGroup = groupIds ? groupOf(groupIds[i]) : group;
      const order = orders?.[i];
      const moved =
        (layerId !== undefined && layerId !== place.layer.layerId) ||
        nextGroup !== group ||
        (order !== undefined && order !== utf8String(data.itemKeys, row)) ||
        (members !== undefined &&
          nextGroup >= 0 &&
          (members[i] ?? '') !== utf8String(data.memberKeys, row));
      if (!moved) continue;
      watch.watchLayer(place.layer.layerId);
      if (layerId !== undefined) watch.watchLayer(layerId);
      watch.watchGroup(group);
      watch.watchGroup(nextGroup);
      watch.row(handle, false);
    }
    if (!watch.changes) return null;
    watch.keep();
    return watch;
  }

  /** What the changes of the order read of the tables */
  private get orderSource(): ItemOrderSource {
    return {
      layer: (layerId) => this.layers.get(layerId),
      groups: this.groups,
      idOf: (handle) => this.ids.idOf(handle),
      placeOf: (handle) => this.placeOf(handle),
      writtenOrders: this.writtenOrders,
    };
  }

  /**
   * The changes of the features of rows held that a write wrote, taken out of the rows written:
   * a row deleted is no longer held (by any owner), and its feature is deleted; the feature of a
   * row written is made again from the row (which keeps the values of an edit in its middle), and
   * the values the edit ends with are written over what was written
   */
  private heldChanges(
    written: ReadonlyArray<{ handle: RowHandle; fields: Map<RowField, unknown> }>,
    drafts: Map<string, LayerChangeDraft>,
  ): StoreChange['features'] | null {
    if (written.length === 0) return null;
    const updated: Array<{ id: string; feature: Feature; previous: Feature }> = [];
    const deletedFeatures: Feature[] = [];
    const handles = new Set<RowHandle>();
    for (const { handle, fields } of written) {
      const held = this.heldRows.get(handle);
      if (!held) continue;
      handles.add(handle);
      const place = this.placeOf(handle);
      if (!place || (place.group.data.flags[place.row] & ROW_FLAG_DELETED) !== 0) {
        this.forgetHeld(handle);
        deletedFeatures.push(held.feature);
        continue;
      }
      const previous = held.feature;
      const read = rowFeature(this.readContext, place.layer.layerId, place.group, place.row);
      // A row drawn moved by its state does not hold the geometry of its feature
      held.feature = held.moved ? { ...read, geometry: previous.geometry } : read;
      if (held.moved) held.moved = { geometry: read.geometry };
      held.committed = featureWithFields(held.committed, fields);
      updated.push({ id: previous.id, feature: held.feature, previous });
    }
    // A row is in the change of its feature or of its row, not both
    for (const draft of drafts.values()) {
      for (const list of [draft.created, draft.updated, draft.deleted]) {
        for (let k = list.length - 1; k >= 0; k--) if (handles.has(list[k])) list.splice(k, 1);
      }
    }
    for (const [layerId, draft] of [...drafts]) {
      if (draft.created.length + draft.updated.length + draft.deleted.length === 0) {
        drafts.delete(layerId);
      }
    }
    if (updated.length === 0 && deletedFeatures.length === 0) return null;
    return {
      ...(updated.length > 0 && { updated }),
      ...(deletedFeatures.length > 0 && { deleted: deletedFeatures }),
    };
  }

  /**
   * Checks the shape of a patch: one value per row in every field (the values are checked where
   * they are written)
   */
  private checkPatch(patch: RowValues): void {
    const n = patch.handles.length;
    for (const [field, values] of patch.fields) {
      if (values.length !== n) {
        throw new DrawError(
          'invalid-input',
          `FeatureTables: "${field}" has ${values.length} values for ${n} rows`,
        );
      }
    }
    if (patch.deleted && patch.deleted.length !== n) {
      throw new DrawError(
        'invalid-input',
        'FeatureTables: deleted has another length than the rows',
      );
    }
  }

  // === The rows held as features ===

  planBulk(op: BulkOperation, rows: TableSelection, containers: RowContainers): RowWrite | null {
    return planBulk(this, op, rows, containers);
  }

  private readonly bulkListeners = new Set<(rows: TableSelection | null) => void>();

  setGroupHidden(groupId: string, hidden: boolean): void {
    if (this.hiddenGroupIds.has(groupId) === hidden) return;
    if (hidden) this.hiddenGroupIds.add(groupId);
    else this.hiddenGroupIds.delete(groupId);
    const group = this.groups.handleOfId(groupId);
    if (group >= 0) this.refreshGroupStates(new Set([group]));
    this.revisionCount++;
    this.notifyWork();
  }

  /** Makes the copies of the state of the rows of groups of features again */
  private refreshGroupStates(shown: ReadonlySet<GroupHandle>): void {
    for (const layer of this.layers.values()) {
      // The row groups around the members of the groups (by their keys), and the delta
      const groups = rowGroupsHolding(layer, shown, this.groups).map((g) => layer.groupAt(g));
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

  onBulkSelected(listener: (rows: TableSelection | null) => void): () => void {
    this.bulkListeners.add(listener);
    return () => {
      this.bulkListeners.delete(listener);
    };
  }

  bulkSelected(rows: TableSelection | null): void {
    for (const listener of this.bulkListeners) listener(rows);
  }

  open(owner: string, ids: readonly string[]): void {
    const next = new Set<RowHandle>();
    for (const id of ids) {
      const handle = this.handleOf(id);
      if (handle !== undefined) next.add(handle);
    }
    const before = this.holders.get(owner);
    if (next.size === 0) this.holders.delete(owner);
    else this.holders.set(owner, next);
    const added: Feature[] = [];
    const removed: string[] = [];
    for (const handle of next) {
      if (this.heldRows.has(handle)) continue;
      const feature = this.holdRow(handle);
      if (feature) added.push(feature);
    }
    for (const handle of before ?? []) {
      if (next.has(handle) || !this.heldRows.has(handle) || this.namedByOwner(handle)) continue;
      const id = this.releaseRow(handle);
      if (id !== undefined) removed.push(id);
    }
    if (this.onChange && (added.length > 0 || removed.length > 0)) {
      this.onChange({ opened: { added, removed } });
    }
  }

  getOpenedFeature(id: string): Feature | undefined {
    const handle = this.ids.handleOf(id);
    return handle >= 0 ? this.heldRows.get(handle)?.feature : undefined;
  }

  /** Whether the row of a handle is held as a feature */
  isHeld(handle: RowHandle): boolean {
    return this.heldRows.has(handle);
  }

  get heldCount(): number {
    return this.heldRows.size;
  }

  /** The handles of the rows held as features */
  heldHandles(): IterableIterator<RowHandle> {
    return this.heldRows.keys();
  }

  /**
   * The values of a row held without the ones of an edit in its middle (undefined for an id not
   * held)
   */
  heldCommitted(id: string): Feature | undefined {
    const handle = this.ids.handleOf(id);
    return handle >= 0 ? this.heldRows.get(handle)?.committed : undefined;
  }

  applyOpened(id: string, feature: Feature, options: OpenedApplyOptions = {}): void {
    const handle = this.ids.handleOf(id);
    const held = handle >= 0 ? this.heldRows.get(handle) : undefined;
    if (!held) throw new DrawError('invalid-state', `FeatureTables: the row "${id}" is not opened`);
    this.rowBoxes.markOne(handle);
    if (feature.id !== id)
      throw new DrawError(
        'invalid-input',
        `FeatureTables: the feature of "${id}" names another id`,
      );
    if (
      feature.layerId !== held.feature.layerId ||
      (feature.groupId ?? undefined) !== (held.feature.groupId ?? undefined)
    ) {
      throw new DrawError(
        'invalid-input',
        `FeatureTables: the layer and the group of "${id}" are written with apply, with its key`,
      );
    }
    const translation = options.intermediate ? this.heldTranslation(held, feature) : null;
    let fields: Map<RowField, unknown>;
    if (translation) {
      // Moved as a whole among many rows held: the row keeps its values without the ones of the
      // edit, and is drawn moved by its state
      fields = new Map([['geometry', feature.geometry]]);
      if (!held.moved) {
        this.writeHeldRow(handle, featureFields(held.feature, held.committed));
        held.moved = { geometry: held.committed.geometry };
        this.states.setMoving(Int32Array.of(handle), HELD_MOVE_SET);
      }
      this.states.setTranslation(HELD_MOVE_SET, translation[0], translation[1]);
    } else {
      fields = featureFields(held.feature, feature);
      this.writeHeldRow(handle, featureFields(this.heldRowValues(held), feature));
      this.stopMove(handle, held);
    }
    const previous = held.feature;
    held.feature = feature;
    if (options.intermediate) {
      for (const field of fields.keys()) held.intermediate.add(field);
    } else {
      held.committed = feature;
      held.intermediate.clear();
    }
    this.onChange?.({
      features: {
        updated: [
          { id, feature, previous, ...(options.intermediate === true && { isIntermediate: true }) },
        ],
      },
    });
  }

  /**
   * The translation a write in the middle of an edit moves a row held by as a whole, when it is
   * drawn moved by its state: many rows are held, and the write changes nothing but the geometry
   * the row holds without the edit, moved as a whole (null when the row is to be written)
   */
  private heldTranslation(held: HeldRow, feature: Feature): [number, number] | null {
    if (this.heldRows.size < this.moveHeldByStateFrom) return null;
    const fields = featureFields(held.committed, feature);
    if (fields.size !== 1 || !fields.has('geometry')) return null;
    return translationBetween((held.moved ?? held.committed).geometry, feature.geometry);
  }

  /** The values the row of a row held holds, as its feature has them */
  private heldRowValues(held: HeldRow): Feature {
    return held.moved ? { ...held.feature, geometry: held.moved.geometry } : held.feature;
  }

  /** Writes fields of a row held, as its feature has them */
  private writeHeldRow(handle: RowHandle, fields: ReadonlyMap<RowField, unknown>): void {
    if (fields.size === 0) return;
    const columns = new Map<RowField, readonly unknown[]>();
    for (const [field, value] of fields) columns.set(field, [value]);
    this.applyPatch({ handles: Int32Array.of(handle), fields: columns }, new Map());
  }

  /** Takes a row held out of the moving set of the rows held, once its row is written */
  private stopMove(handle: RowHandle, held: HeldRow): void {
    if (!held.moved) return;
    held.moved = undefined;
    this.states.setMoving(Int32Array.of(handle), 0);
  }

  // === The features drawn over rows for this client ===

  /**
   * Draws features in the places of rows, for this client only (see `FeatureTables.showInPlace`): a
   * feature is a row of the delta of its layer drawn and not read (`drawnOnlyRows`), with the
   * keys of the row it is drawn over (at the end of its layer for a feature of no row), and the
   * row it is drawn over is not drawn (`STATE_HIDDEN_OVERLAY`). The rows are not written
   */
  setReadGate(gate: (() => void) | null): void {
    this.readGate = gate;
  }

  watchOrderOf(patch: RowValues): () => void {
    const parts = { watch: this.watchOrder(patch) };
    this.partsWatch = parts;
    return () => {
      if (this.partsWatch !== parts) return;
      this.partsWatch = null;
      const order = parts.watch?.finish() ?? [];
      if (order.length > 0) this.onChange?.({ order });
    };
  }

  showInPlace(owner: string, features: readonly Feature[]): void {
    const before = this.overlays.get(owner) ?? new Map<string, OverlayEntry>();
    const next = new Map<string, OverlayEntry>();
    const leaving = new Map<LayerTable, Set<RowHandle>>();
    const coming = new Map<LayerTable, DeltaInput[]>();
    const leave = (layer: LayerTable, handle: RowHandle): void => {
      let set = leaving.get(layer);
      if (!set) {
        set = new Set();
        leaving.set(layer, set);
      }
      set.add(handle);
    };
    for (const feature of features) {
      const id = `\u0000overlay\u0000${owner}\u0000${feature.id}`;
      const [handle] = this.ids.allocate(utf8ColumnFromStrings([id]));
      const over = this.handleOf(feature.id);
      const place = over === undefined ? undefined : this.placeOf(over);
      const layer = this.layerOf(feature.layerId);
      const base: RowInput = place
        ? rowInputOf(this.readContext, place.group, place.row)
        : { id, type: feature.type, geometry: null, order: this.keyAfterLast(layer) };
      const input: RowInput = {
        ...base,
        id,
        type: feature.type,
        geometry: feature.geometry,
        style: (feature.style ?? {}) as Readonly<Record<string, unknown>>,
        properties: feature.properties ?? {},
        visible: feature.visible !== false,
        locked: feature.locked === true,
        deleted: false,
      };
      const previous = before.get(feature.id);
      if (previous && previous.layer !== layer) leave(previous.layer, previous.handle);
      let list = coming.get(layer);
      if (!list) {
        list = [];
        coming.set(layer, list);
      }
      list.push({ handle, input });
      next.set(feature.id, { handle, layer, over: place ? over : undefined });
      this.drawnOnlyRows.add(handle);
    }
    for (const [id, previous] of before) {
      if (!next.has(id)) leave(previous.layer, previous.handle);
    }
    if (next.size > 0) this.overlays.set(owner, next);
    else this.overlays.delete(owner);
    const number = ++this.writeCount;
    for (const layer of new Set([...leaving.keys(), ...coming.keys()])) {
      this.rebuildDelta(layer, leaving.get(layer) ?? new Set(), coming.get(layer) ?? [], number);
    }
    for (const [layer, set] of leaving) {
      for (const handle of set) {
        if (this.ids.deltaLayer(handle) < 0) this.drawnOnlyRows.delete(handle);
      }
      layer.touchPending();
    }
    // The rows drawn over are not drawn
    const overlaid = new Set<RowHandle>();
    for (const entries of this.overlays.values()) {
      for (const entry of entries.values()) if (entry.over !== undefined) overlaid.add(entry.over);
    }
    const on = [...overlaid].filter((handle) => !this.overlaidRows.has(handle));
    const off = [...this.overlaidRows].filter((handle) => !overlaid.has(handle));
    this.overlaidRows = overlaid;
    if (on.length > 0) this.states.setOverlaid(Int32Array.from(on), true);
    if (off.length > 0) this.states.setOverlaid(Int32Array.from(off), false);
    this.revisionCount++;
  }

  /** A key of the order after every item of a layer (a feature drawn at its end) */
  private keyAfterLast(layer: LayerTable): string {
    // The last row of the order, read from the rows at its end
    const last = layer.lastRow();
    if (!last) return 'V';
    const data = last.group.data;
    const row = last.row;
    const group = data.groups[row];
    const key = group >= 0 ? (this.groups.orderOf(group) ?? '') : utf8String(data.itemKeys, row);
    // Any key the last one is a beginning of comes after it
    return `${key}~`;
  }

  /** Makes a row a feature held (null for a row that cannot be read) */
  private holdRow(handle: RowHandle): Feature | null {
    const place = this.placeOf(handle);
    if (!place) return null;
    this.rowBoxes.markOne(handle);
    const feature = rowFeature(this.readContext, place.layer.layerId, place.group, place.row);
    this.heldRows.set(handle, {
      feature,
      committed: feature,
      intermediate: new Set(),
      moved: undefined,
    });
    // Its copy in the delta stays there until it is no longer held
    if (place.group.delta) place.layer.delta.setWritten(place.row, Number.POSITIVE_INFINITY);
    return feature;
  }

  /** Whether an owner names the row of a handle */
  private namedByOwner(handle: RowHandle): boolean {
    for (const handles of this.holders.values()) if (handles.has(handle)) return true;
    return false;
  }

  /**
   * Makes a row held a row only: the values an edit wrote in its middle and did not end are
   * written back to the ones before it, and its copy in the delta can go to the next version of
   * its group
   *
   * @returns Its id
   */
  private releaseRow(handle: RowHandle): string | undefined {
    const held = this.heldRows.get(handle);
    if (!held) return undefined;
    this.rowBoxes.markOne(handle);
    this.heldRows.delete(handle);
    if (held.intermediate.size > 0) {
      this.writeHeldRow(handle, featureFields(this.heldRowValues(held), held.committed));
    }
    this.stopMove(handle, held);
    const serial = this.ids.deltaLayer(handle);
    if (serial >= 0) {
      this.layerList[serial].delta.setWritten(this.ids.deltaSlot(handle), ++this.writeCount);
      this.notifyWork();
    }
    return held.feature.id;
  }

  /** Takes a row out of every owner, without writing it (it was deleted) */
  private forgetHeld(handle: RowHandle): void {
    this.rowBoxes.markOne(handle);
    const held = this.heldRows.get(handle);
    if (held) this.stopMove(handle, held);
    this.heldRows.delete(handle);
    for (const [owner, handles] of [...this.holders]) {
      if (!handles.has(handle)) continue;
      const next = new Set(handles);
      next.delete(handle);
      if (next.size === 0) this.holders.delete(owner);
      else this.holders.set(owner, next);
    }
  }

  /**
   * Checks the values of a patch before anything is written: one value per row in every field,
   * the geometries, the groups of features, the keys, and what a new row cannot be without
   *
   * @returns The handle of the group of features of each row, when the patch writes them
   */
  private checkRows(patch: RowValues): {
    groupHandles: number[] | undefined;
    places: Array<RowPlace | undefined>;
  } {
    const { handles, fields } = patch;
    this.checkPatch(patch);
    const geometries = fields.get('geometry');
    geometries?.forEach((geometry, i) => {
      if (geometry === undefined) return;
      if (!geometry || typeof geometry !== 'object' || !('type' in geometry)) {
        throw new DrawError(
          'invalid-input',
          `FeatureTables: the geometry of the row ${handles[i]} is not a geometry`,
        );
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
        throw new DrawError(
          'invalid-input',
          `FeatureTables: the group of the row ${handles[i]} is not an id`,
        );
      }
      const group = this.groups.handleOfId(id);
      if (group < 0)
        throw new DrawError('not-found', `FeatureTables: the group "${id}" is unknown`);
      return group;
    });
    const places = Array.from(handles, (handle) => this.placeOf(handle));
    // A row moved to a layer of other dimensions keeps its values only when the positions it
    // has are read the same there (xy into any, xyz into xyzm), or when it is given a geometry
    layerIds?.forEach((layerId, i) => {
      const place = places[i];
      if (typeof layerId !== 'string' || !place || place.layer.layerId === layerId) return;
      if (geometries?.[i] !== undefined) return;
      const from = place.layer.dims;
      const to = this.dimsOfLayer(layerId);
      if (from !== to && !to.startsWith(from)) {
        throw new DrawError(
          'invalid-input',
          `FeatureTables: the row ${handles[i]} has coordinates of ${from}, the layer "${layerId}" of ${to}`,
        );
      }
    });
    const strings: Array<[string, readonly unknown[] | undefined, boolean]> = [
      ['type', types, false],
      ['layerId', layerIds, false],
      ['order', orders, false],
      ['member', members, true],
    ];
    for (const [name, values, optional] of strings) {
      values?.forEach((value, i) => {
        if (typeof value === 'string' || (value === undefined && (optional || !!places[i]))) {
          return;
        }
        throw new DrawError(
          'invalid-input',
          `FeatureTables: the ${name} of the row ${handles[i]} is not a string`,
        );
      });
    }
    places.forEach((place, i) => {
      if (place) return;
      if (!this.ids.has(handles[i])) {
        throw new DrawError('not-found', `FeatureTables: no row has the handle ${handles[i]}`);
      }
      // A new row: what a feature cannot be without
      const missing = [
        ['type', types?.[i]],
        ['layerId', layerIds?.[i]],
        ['geometry', geometries?.[i]],
        ['order', orders?.[i]],
      ].filter(([, value]) => value === undefined);
      if (missing.length > 0) {
        throw new DrawError(
          'invalid-input',
          `FeatureTables: no row has the handle ${handles[i]}, and a new row needs ${missing
            .map(([name]) => name)
            .join(', ')}`,
        );
      }
    });
    return { groupHandles, places };
  }

  /**
   * Writes values of rows: every value is checked before anything is written; then the rows are
   * written in place, and the rows placed elsewhere and the new ones are put in the delta of
   * their layer, and the drawing is told
   */
  private applyPatch(patch: RowValues, changes: Map<string, LayerChangeDraft>): void {
    const { handles, fields, deleted } = patch;
    this.rowBoxes.mark(handles);
    const n = handles.length;
    const checked = this.checkRows(patch);
    const groupHandles = checked.groupHandles;
    const layerIds = fields.get('layerId');
    // A row of a creation written before it is taken in: the creation is taken in now (and the
    // places are read again)
    let creations = false;
    if (this.creationOf.size > 0) {
      for (const handle of handles) {
        const creation = this.creationOf.get(handle);
        if (creation) {
          this.finishCreationNow(creation);
          creations = true;
        }
      }
    }
    const places = creations
      ? Array.from(handles, (handle) => this.placeOf(handle))
      : checked.places;
    const columns = patchColumns(fields);
    // Whether a field written can move a row to another place (else no row is looked at for it)
    const mayPlace = [...fields.keys()].some(
      (field) =>
        PLACE_FIELDS.has(field) ||
        (field.startsWith('property:') && CLASSIFY_KEYS.has(field.slice('property:'.length))),
    );
    /** The writes in place of the layer of the row before */
    let lastWritesLayer: string | undefined;
    let lastWrites: InPlaceRowWrite[] | undefined;
    let lastTouched: RowGroup | null = null;
    /** The version of the group of the row before, and whether it is locked */
    let lastGroup: RowGroup | null = null;
    let lastLocked = false;
    // The values are made what the columns hold before anything is written
    const styles = fields.get('style');
    // A style given to many rows (a change of the style of many rows gives each kind of row the
    // same object) is made canonical once
    const internedStyles = new Map<unknown, number>();
    const styleNumbers = styles?.map((style) => {
      let number = internedStyles.get(style);
      if (number === undefined) {
        number = this.styles.intern((style ?? {}) as FeatureStyle);
        internedStyles.set(style, number);
      }
      return number;
    });
    /** The keys a row changes in its style, by the number of its style before and after */
    const styleKeysOf = new Map<number, Map<number, readonly string[]>>();
    const keysAddedTo = new Map<readonly string[], LayerChangeDraft>();
    /** The change of the layer of the row before (a write of many rows is mostly of one layer) */
    let lastLayer: string | undefined;
    let lastChange: LayerChangeDraft | undefined;

    const number = ++this.writeCount;
    const writes = new Map<string, InPlaceRowWrite[]>();
    const touched = new Set<RowGroup>();
    const moving = new Map<LayerTable, DeltaInput[]>();
    const leaving = new Map<LayerTable, Set<RowHandle>>();
    const fresh = new Map<LayerTable, DeltaInput[]>();
    let stateChanged = false;
    let created = false;

    for (let i = 0; i < n; i++) {
      const handle = handles[i];
      const place = places[i];
      // A deleted row written whole (its type, layer, geometry and key) is created again: it
      // goes to the delta as a new row would
      const revived =
        !!place &&
        !deleted?.[i] &&
        (place.group.data.flags[place.row] & ROW_FLAG_DELETED) !== 0 &&
        CREATE_FIELDS.every((field) => fields.get(field)?.[i] !== undefined);
      const placed = place
        ? revived || (mayPlace && this.placeChanged(place, i, fields, groupHandles))
        : true;
      const targetLayer = (layerIds?.[i] as string | undefined) ?? place?.layer.layerId;
      let change = lastChange;
      if (!change || targetLayer !== lastLayer) {
        change = draftOf(changes, targetLayer as string);
        for (const field of fields.keys()) change.fields.add(field);
        lastLayer = targetLayer;
        lastChange = change;
      }
      if (styles && styleNumbers && place) {
        const beforeNumber = place.group.data.styles[place.row];
        const afterNumber = styleNumbers[i];
        let byAfter = styleKeysOf.get(beforeNumber);
        if (!byAfter) {
          byAfter = new Map();
          styleKeysOf.set(beforeNumber, byAfter);
        }
        let keys = byAfter.get(afterNumber);
        if (!keys) {
          keys = changedKeys(this.styles.get(beforeNumber), (styles[i] ?? {}) as FeatureStyle);
          byAfter.set(afterNumber, keys);
        }
        // The keys of a pair are added once per change of a layer
        if (keysAddedTo.get(keys) !== change) {
          for (const key of keys) change.styleKeys.add(key);
          keysAddedTo.set(keys, change);
        }
      }
      const wasDeleted = !!place && (place.group.data.flags[place.row] & ROW_FLAG_DELETED) !== 0;
      if (!place || revived || (wasDeleted && deleted && !deleted[i])) change.created.push(handle);
      else if (deleted?.[i] && !wasDeleted) change.deleted.push(handle);
      else change.updated.push(handle);

      if (!placed && place) {
        // Written in place (and written again into the next version of its group when one is
        // being made)
        if (place.group !== lastGroup) {
          lastGroup = place.group;
          lastLocked = !place.group.delta && !!this.versions.lockOf(place.group.handle);
        }
        if (lastLocked) {
          const values = new Map<string, unknown>();
          for (const [field, list] of fields) values.set(field, list[i]);
          this.versions.logWrite(place.group.handle, {
            handle,
            fields: values,
            deleted: !!deleted?.[i],
          });
        }
        const write = this.writeInPlace(place, i, fields, deleted, styleNumbers, columns);
        if (!write) continue;
        if (write.what & ROW_WRITE_GEOMETRY) this.touch(place.layer.layerId, place.group.bounds);
        if (write.what & (ROW_WRITE_GEOMETRY | ROW_WRITE_STATE)) stateChanged = true;
        if (place.group !== lastTouched) {
          touched.add(place.group);
          lastTouched = place.group;
        }
        if (place.group.delta) {
          place.layer.delta.setWritten(
            place.row,
            this.heldRows.has(handle) ? Number.POSITIVE_INFINITY : number,
          );
        }
        let list =
          lastWritesLayer === place.layer.layerId ? lastWrites : writes.get(place.layer.layerId);
        if (!list) {
          list = [];
          writes.set(place.layer.layerId, list);
        }
        lastWritesLayer = place.layer.layerId;
        lastWrites = list;
        list.push(write);
        continue;
      }
      // Placed elsewhere, or new: a copy in the delta of its layer (many new rows next to each
      // other are built into groups of their own instead)
      const input = this.patchedInput(handle, place, i, fields, deleted, groupHandles, revived);
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
    for (const style of internedStyles.values()) {
      if (this.styles.usesOf(style) === 0) this.styles.release(style);
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
  }

  /**
   * Writes values of groups of features (see `FeatureTablesWriter.applyGroups`): a new key of
   * the order of a group puts its members in another order (`reorderGroups`), a group shown or
   * hidden makes the copies of the state of its members again
   */
  applyGroups(patch: TableGroupPatch, options: RowApplyOptions = {}): void {
    const { handles, fields, deleted } = patch;
    const n = handles.length;
    for (const [field, values] of fields) {
      if (values.length !== n) {
        throw new DrawError(
          'invalid-input',
          `FeatureTables: "${field}" has ${values.length} values for ${n} groups`,
        );
      }
    }
    if (deleted && deleted.length !== n) {
      throw new DrawError(
        'invalid-input',
        'FeatureTables: deleted has another length than the groups',
      );
    }
    const value = (field: 'id' | 'name' | 'order' | 'layerId' | 'visible' | 'locked', i: number) =>
      fields.get(field)?.[i];
    for (let i = 0; i < n; i++) {
      if (deleted?.[i]) continue;
      // The name is the Store's (the tables do not hold it)
      const name = value('name', i);
      if (name !== undefined && typeof name !== 'string') {
        throw new DrawError(
          'invalid-input',
          `FeatureTables: the name of the group ${handles[i]} is not a string`,
        );
      }
      for (const field of ['id', 'order', 'layerId'] as const) {
        const v = value(field, i);
        if (v !== undefined && typeof v !== 'string') {
          throw new DrawError(
            'invalid-input',
            `FeatureTables: the ${field} of the group ${handles[i]} is not a string`,
          );
        }
        if (v === undefined && !this.groups.has(handles[i])) {
          throw new DrawError(
            'invalid-input',
            `FeatureTables: the new group ${handles[i]} needs its ${field}`,
          );
        }
      }
      for (const field of ['visible', 'locked'] as const) {
        const v = value(field, i);
        if (v !== undefined && typeof v !== 'boolean') {
          throw new DrawError(
            'invalid-input',
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
      this.deletedGroups.delete(group);
      this.unkeepGroup(group);
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
    if (shown.size > 0) this.refreshGroupStates(shown);
    // The moves of the groups that are items, with the keys before (told when they are written,
    // whenever the order of their members goes in)
    if (this.onChange) {
      const moves: ItemOrderChange[] = [];
      for (const [layerId, list] of orders) {
        moves.push(...groupKeyMoves(this.orderSource, layerId, list));
      }
      if (moves.length > 0) this.onChange({ order: moves });
    }
    for (const [layerId, list] of orders) this.reorderGroups(layerId, list);
    // The new rows read from their creations are built again with the groups as they are now
    for (const creation of this.creations) this.dropReading(creation);
    // A group deleted with a token is kept until the token is let go of
    const token = options.restoreToken;
    let kept = false;
    const named = this.groupsNamed(removed);
    for (const group of removed) {
      if (token !== undefined && this.groups.has(group)) {
        this.keepGroup(group, token);
        kept = true;
      }
      if (named.has(group) || this.groupRetainOf.has(group)) this.deletedGroups.add(group);
      else {
        this.groups.delete(group);
        this.writtenOrders.delete(group);
      }
    }
    if (kept) this.limitRetained(token as number);
    this.revisionCount++;
    this.notifyWork();
    if (kept) this.onChange?.({ restoreToken: token });
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
    // The keys of a reorder still waiting that are still the ones written (a key written since,
    // here or in another layer, is the one that goes in)
    for (const version of this.versions.reorders(layer)) {
      for (const [group, order] of version.orders ?? []) {
        if (!orders.has(group) && this.writtenOrders.get(group) === order) orders.set(group, order);
      }
    }
    // The cuts of each row group: the runs of the members, and where they go
    const { cuts, members } = layer
      ? groupRunCuts(layer, orders, this.groups)
      : { cuts: new Map<RowGroup, Set<number>>(), members: false };
    if (!layer || !members) {
      // No member in the groups: the keys go in now (the deltas in their new order)
      for (const [group, order] of orders) {
        this.groups.setOrder(group, order);
        this.writtenOrders.delete(group);
      }
      for (const other of this.layers.values()) {
        if (other.delta.group) this.rebuildDelta(other, new Set(), [], this.writeCount);
        other.touchItems();
      }
      return;
    }
    // The pieces
    const groups = [...cuts.keys()].sort(
      (a, b) => layer.orderOf(a.handle) - layer.orderOf(b.handle),
    );
    const pieces: RowBlockData[] = [];
    for (const group of groups) {
      const points = [
        0,
        ...[...(cuts.get(group) as Set<number>)].sort((a, b) => a - b),
        group.data.length,
      ];
      for (let k = 0; k + 1 < points.length; k++) {
        if (points[k + 1] > points[k])
          pieces.push(this.sliceRows(group, points[k], points[k + 1], layer.dims));
      }
    }
    for (const [group, order] of orders) this.writtenOrders.set(group, order);
    this.versions.startReorder(layer, groups, pieces, orders);
  }

  /**
   * The rows `[from, to)` of a group as a group of their own (the values written in place built
   * into them)
   */
  private sliceRows(
    group: RowGroup,
    from: number,
    to: number,
    dims: CoordinateDimensions,
  ): RowBlockData {
    const sources: RowBlockData[] = [group.data];
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
    const built = inputs.length > 0 ? this.buildRows(inputs, dims) : null;
    if (built) {
      sources.push(built);
      for (let r = 0; r < built.length; r++) pairs.push(1, r);
    }
    const [data] = mergeRowBlockData({
      sources,
      rows: Int32Array.from(pairs),
      groups: this.groups,
      targetRows: UNBOUNDED,
      targetVertices: UNBOUNDED,
      dimensions: dims,
      ringVertices: circleRowRings.ringVertices,
      coordinateSystem: this.coordinates,
    });
    return data;
  }

  /**
   * The groups of features a row (of a group, of a delta, of a creation) names, of some groups:
   * the row groups around their rows (by their keys) and the deltas read once for all of them
   */
  private groupsNamed(of: Iterable<GroupHandle>): Set<GroupHandle> {
    const wanted = new Set(of);
    const named = new Set<GroupHandle>();
    if (wanted.size === 0) return named;
    const read = (handles: Int32Array): void => {
      for (const group of handles) if (group >= 0 && wanted.has(group)) named.add(group);
    };
    for (const layer of this.layers.values()) {
      for (const g of rowGroupsHolding(layer, wanted, this.groups))
        read(layer.groupAt(g).data.groups);
      if (layer.delta.group) read(layer.delta.group.data.groups);
    }
    for (const creation of this.creations) {
      for (const row of creation.rows) {
        const group = row.input.group;
        if (group !== undefined && group >= 0 && wanted.has(group)) named.add(group);
      }
    }
    return named;
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
    revived = false,
  ): RowInput {
    // A row created again starts from nothing, as a new one does
    const base: RowInput =
      place && !revived
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
    else if (revived) out.deleted = false;
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
    columns: PatchColumns = patchColumns(fields),
  ): InPlaceRowWrite | null {
    const { layer, group, row } = place;
    const data = group.data;
    let what = 0;
    let shape: GeometryWrite = SAME_SHAPE;
    let keys: string[] | null = null;
    const geometry = columns.geometry?.[i];
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
    const visible = columns.visible?.[i];
    if (visible !== undefined) {
      flags = visible === false ? flags & ~ROW_FLAG_VISIBLE : flags | ROW_FLAG_VISIBLE;
    }
    const locked = columns.locked?.[i];
    if (locked !== undefined) {
      flags = locked === true ? flags | ROW_FLAG_LOCKED : flags & ~ROW_FLAG_LOCKED;
    }
    if (deleted && deleted[i] !== 0) flags |= ROW_FLAG_DELETED;
    // A row deleted written not deleted is created again at its place
    else if (deleted) flags &= ~ROW_FLAG_DELETED;
    if (flags !== data.flags[row]) {
      if ((flags & ROW_FLAG_DELETED) !== (data.flags[row] & ROW_FLAG_DELETED)) layer.touchItems();
      data.flags[row] = flags;
      this.writeState(group, row);
      group.stateVersion++;
      what |= ROW_WRITE_STATE;
    }
    for (const [key, values] of columns.properties) {
      if (!writeRowValue(group, row, key, values[i])) continue;
      what |= ROW_WRITE_VALUES;
      keys ??= [];
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
      keys: keys ?? NO_KEYS,
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
      // The keys that are still the ones written go in (a key written since, in another layer,
      // went in or waits there)
      for (const [group, order] of version.orders) {
        if (this.writtenOrders.get(group) !== order) continue;
        this.groups.setOrder(group, order);
        this.writtenOrders.delete(group);
      }
      for (const creation of this.creations) this.dropReading(creation);
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
    // The rows deleted the version left out: their copies in the deltas go too
    for (const handle of version.dropped) {
      if (takes(handle, version.deltaNumber)) leave(handle);
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
    const writes = new Map<string, InPlaceRowWrite[]>();
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
    // The rows left out are gone: the handles of the ones forgotten are freed, and the groups of
    // features deleted no row names any more are taken out
    for (const handle of version.dropped) this.freeIfGone(handle);
    if (version.dropped.length > 0) {
      const named = this.groupsNamed(this.deletedGroups);
      for (const group of [...this.deletedGroups]) {
        if (named.has(group) || this.groupRetainOf.has(group)) continue;
        this.deletedGroups.delete(group);
        this.groups.delete(group);
        this.writtenOrders.delete(group);
      }
    }
    // A version started before the dimensions of its layer were raised has the ones of before:
    // its groups are due again
    for (const group of groups) {
      if (!hasDims(group.data, layer.dims)) this.versions.markDue(group.handle);
    }
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
    const sources: RowBlockData[] = [];
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
      const built = this.buildRows(inputs, layer.dims);
      if (built) {
        sources.push(built);
        for (let r = 0; r < built.length; r++) pairs.push(sources.length - 1, r);
      }
    }
    const merged = mergeRowBlockData({
      sources,
      rows: Int32Array.from(pairs),
      groups: this.groups,
      targetRows: UNBOUNDED,
      targetVertices: UNBOUNDED,
      dimensions: layer.dims,
      ringVertices: circleRowRings.ringVertices,
      coordinateSystem: this.coordinates,
    });
    const group = merged.length > 0 ? createRowGroup(delta.handle, merged[0], true) : null;
    const written = new Float64Array(group?.data.length ?? 0);
    if (group) {
      for (let r = 0; r < group.data.length; r++) {
        const handle = group.data.handles[r];
        // A row held as a feature stays in the delta until it is no longer held, and a feature
        // drawn over a row as long as it is drawn
        written[r] =
          this.heldRows.has(handle) || this.drawnOnlyRows.has(handle)
            ? Number.POSITIVE_INFINITY
            : (writtenOf.get(handle) ?? number);
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

  /**
   * Builds rows into one row group of coordinates of dimensions, numbered and with their handles
   * (null for no row)
   */
  private buildRows(inputs: readonly RowInput[], dims: CoordinateDimensions): RowBlockData | null {
    const builder = createRowBlockDataBuilder({
      groups: this.groups.keyList(),
      targetRows: UNBOUNDED,
      targetVertices: UNBOUNDED,
      dimensions: dims,
      coordinateSystem: this.coordinates,
      rings: circleRowRings,
    });
    for (const input of inputs) builder.addRow(input);
    const [data] = builder.finish();
    if (!data) return null;
    this.numberStyles(data);
    data.handles.set(this.ids.allocate(data.ids, data.idHashes));
    return data;
  }

  /** Gives the styles of a group built in a Worker the numbers of the table of styles */
  private numberStyles(data: RowBlockData): void {
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
  private adoptGroup(layer: LayerTable, data: RowBlockData): void {
    checkDims(data, layer.dims);
    if (data.handles.some((handle) => handle < 0)) {
      data.handles.set(this.ids.allocate(data.ids, data.idHashes));
    }
    for (let r = 0; r < data.length; r++) {
      const handle = data.handles[r];
      if (!this.ids.has(handle))
        throw new DrawError('not-found', `FeatureTables: the handle ${handle} is unknown`);
      if (this.ids.mainGroup(handle) >= 0 || this.ids.deltaLayer(handle) >= 0) {
        throw new DrawError(
          'already-exists',
          `FeatureTables: "${this.ids.idOf(handle)}" is already a row`,
        );
      }
    }
    // The styles of a group built in a Worker get the numbers of the table of styles
    this.numberStyles(data);
    for (let r = 0; r < data.length; r++) {
      if (!this.styles.has(data.styles[r])) {
        throw new DrawError(
          'not-found',
          `FeatureTables: a row names the style ${data.styles[r]}, which is unknown`,
        );
      }
    }
    // A group whose rows are not in the order of their keys, or whose keys overlap the rows of
    // another group (one taken in, or built of rows written, since it was made), is not left
    // out: its rows go to the delta, read and drawn at their places at once, and into the row
    // groups with their next versions
    if (data.length > 0 && (!layer.inKeyOrder(data) || layer.overlaps(data))) {
      this.rowsToDelta(layer, data);
      return;
    }
    const group = createRowGroup(this.nextGroup++, data);
    layer.insert(group);
    this.rowBoxes.mark(data.handles);
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
    if (featureGroup >= 0 && this.hiddenGroupIds.size > 0) {
      const id = this.groups.idOf(featureGroup);
      if (id !== undefined && this.hiddenGroupIds.has(id)) state |= STATE_HIDDEN_LOCAL;
    }
    if (rowType(data, row) === 'Circle') state |= STATE_UNIFORM;
    if (!group.delta && !group.pending) {
      // The copy of a row read elsewhere: in the delta, or in another group until it is in this
      if (this.ids.deltaLayer(handle) >= 0) state |= STATE_HIDDEN_DELTA;
      if (this.ids.mainGroup(handle) !== group.handle) state |= STATE_HIDDEN_WAIT;
    }
    group.state[row] = state;
    group.gpuState[row] = toGpuState(state);
    noteRowState(group, row);
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
    this.refreshPending(handle);
  }

  /** Makes the state of a new row read from its creation again (when it is built to be read) */
  private refreshPending(handle: RowHandle): void {
    const reading = this.creationOf.get(handle)?.reading;
    const row = reading?.rows.get(handle);
    if (!reading || row === undefined) return;
    this.writeState(reading.group, row);
    reading.group.stateVersion++;
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
      this.refreshPending(handle);
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

/** The columns of a patch a write in place reads, taken from it once */
interface PatchColumns {
  readonly geometry: readonly unknown[] | undefined;
  readonly visible: readonly unknown[] | undefined;
  readonly locked: readonly unknown[] | undefined;
  /** The attributes written: their keys and values */
  readonly properties: ReadonlyArray<readonly [string, readonly unknown[]]>;
}

function patchColumns(fields: ReadonlyMap<RowField, readonly unknown[]>): PatchColumns {
  const properties: Array<readonly [string, readonly unknown[]]> = [];
  for (const [field, values] of fields) {
    if (field.startsWith('property:')) properties.push([field.slice('property:'.length), values]);
  }
  return {
    geometry: fields.get('geometry'),
    visible: fields.get('visible'),
    locked: fields.get('locked'),
    properties,
  };
}

/** A write in place that leaves the shape of the row (shared, never changed) */
const SAME_SHAPE: GeometryWrite = Object.freeze({ sameShape: true, from: 0, to: 0 });

/** The keys of a write in place that writes no attribute (shared) */
const NO_KEYS: readonly string[] = Object.freeze([]);

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
function checkShape(data: RowBlockData): void {
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
      throw new DrawError(
        'invalid-input',
        `FeatureTables: ${name} has ${length} entries for ${n} rows`,
      );
    }
  }
  for (const column of data.properties.columns) {
    if (column.length !== n)
      throw new DrawError('invalid-input', 'FeatureTables: an attribute column has another length');
  }
}

/** Whether every geometry column of a row group has coordinates of dimensions */
function hasDims(data: RowBlockData, dims: CoordinateDimensions): boolean {
  for (const child of data.geometry.children) if ((child.dimensions ?? 'xy') !== dims) return false;
  return true;
}

/**
 * Checks that the coordinates of a row group have the dimensions of its layer
 *
 * @throws when a geometry column of the group has others
 */
function checkDims(data: RowBlockData, dims: CoordinateDimensions): void {
  for (const child of data.geometry.children) {
    const own = child.dimensions ?? 'xy';
    if (own !== dims) {
      throw new DrawError(
        'invalid-input',
        `FeatureTables: a row group has coordinates of ${own}, its layer ${dims}`,
      );
    }
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
    return this.table.itemsOf().rowCount;
  }

  get rowCountWithDeleted(): number {
    return this.table.rowCount;
  }

  listDrawnRows(bbox: BBox): Int32Array {
    const out: number[] = [];
    this.store.searchRowBoxes(this.table, bbox[0], bbox[1], bbox[2], bbox[3], (group, row) => {
      if ((group.state[row] & STATE_HIDDEN_MASK) === 0) out.push(group.data.handles[row]);
    });
    return Int32Array.from(out);
  }

  getRowBounds(handle: RowHandle): BBox | null {
    if (!this.locate(handle)) return null;
    const b = (this.store.foundGroup as RowGroup).data.rowBounds;
    const i = this.store.foundRow * 4;
    if (Number.isNaN(b[i])) return null;
    return [b[i], b[i + 1], b[i + 2], b[i + 3]];
  }

  getRowType(handle: RowHandle): FeatureType | null {
    // A new row not built yet is read from what was written (its creation is not built for it)
    const input = this.store.newRowInputOf(handle);
    if (input) return input.type;
    if (!this.locate(handle)) return null;
    return rowType((this.store.foundGroup as RowGroup).data, this.store.foundRow);
  }

  getRowPoint(handle: RowHandle): Position | null {
    if (!this.locate(handle)) return null;
    return rowPoint(this.store.foundGroup as RowGroup, this.store.foundRow);
  }

  getRowValue(handle: RowHandle, key: string): unknown {
    // A new row not built yet: a value that is not an object is read from what was written, as the
    // row would give it back (an object is read from the row, a copy of its own)
    const input = this.store.newRowInputOf(handle);
    if (input) {
      const value = input.properties?.[key];
      if (value === null || typeof value !== 'object') return value;
    }
    if (!this.locate(handle)) return undefined;
    return rowValue(
      this.store.foundGroup as RowGroup,
      this.store.foundRow,
      key,
      this.store.strings,
    );
  }

  getRowStyle(handle: RowHandle): Readonly<FeatureStyle> | undefined {
    if (!this.locate(handle)) return undefined;
    const group = this.store.foundGroup as RowGroup;
    return this.store.styles.get(group.data.styles[this.store.foundRow]);
  }

  getRow(handle: RowHandle): Feature | undefined {
    if (!this.locate(handle)) return undefined;
    const group = this.store.foundGroup as RowGroup;
    const row = this.store.foundRow;
    if ((group.data.flags[row] & ROW_FLAG_DELETED) !== 0) return undefined;
    return rowFeature(this.store.readContext, this.table.layerId, group, row);
  }

  getDrawnRowsRevision(): number {
    return this.store.revision;
  }

  listRowHandles(start: number, count: number): Int32Array {
    const handles = this.table.rowOrder().handles;
    const from = Math.max(0, Math.min(start, handles.length));
    return handles.slice(from, Math.max(from, Math.min(handles.length, from + Math.max(0, count))));
  }

  get itemCount(): number {
    return this.table.itemsOf().kinds.length;
  }

  listItems(start: number, count: number): ItemHandles {
    const items = this.table.itemsOf();
    const from = Math.max(0, Math.min(start, items.kinds.length));
    const to = Math.max(from, Math.min(items.kinds.length, from + Math.max(0, count)));
    return { kinds: items.kinds.slice(from, to), handles: items.handles.slice(from, to) };
  }

  // The members of a group are read from the list of the items when it is made, and from the
  // rows of the group otherwise (the list is made from every row of the layer)

  countGroupMembers(group: number): number {
    const items = this.table.itemsMade;
    if (items) return items.members.get(group)?.length ?? 0;
    return new ItemWalk(this.table, this.store).memberCount(group);
  }

  listGroupMembers(group: number, start: number, count: number): Int32Array {
    const items = this.table.itemsMade;
    if (!items) {
      const from = Math.max(0, start);
      return Int32Array.from(
        new ItemWalk(this.table, this.store).members(group, from, Math.max(0, count)),
      );
    }
    const members = items.members.get(group);
    if (!members) return new Int32Array(0);
    const from = Math.max(0, Math.min(start, members.length));
    return members.slice(from, Math.max(from, Math.min(members.length, from + Math.max(0, count))));
  }

  /**
   * Whether a handle is read from a row of this layer: its group and row are then the ones the
   * store found (`foundGroup`, `foundRow`), read at once
   */
  private locate(handle: RowHandle): boolean {
    return this.store.findPlace(handle) && this.store.foundLayer === this.table;
  }
}

/** The rows `rows` of a patch, as a patch */
function subsetPatch(patch: RowValues, rows: readonly number[]): RowValues {
  const fields = new Map<RowField, readonly unknown[]>();
  for (const [field, values] of patch.fields) {
    fields.set(
      field,
      rows.map((i) => values[i]),
    );
  }
  return {
    handles: Int32Array.from(rows, (i) => patch.handles[i]),
    fields,
    deleted: patch.deleted ? Uint8Array.from(rows, (i) => patch.deleted?.[i] ?? 0) : undefined,
  };
}
