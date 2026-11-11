// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The implementation of the tables: rows held as row blocks of columns (`TablesStore`)
 *
 * Here are the tables themselves: the ids and their handles, the dictionary of the values the
 * tables keep, the groups, the state of the rows, the row blocks of every table and the rows
 * changed since (the delta of each table). The user of the tables reads them as they are drawn and
 * hit through the internals declared here (`RowBlocks`), and adds what it makes of the rows by
 * extending the class.
 *
 * A row is read from one place: its row in its group, or its copy in the delta of a table when
 * it has one (the copy in its group is hidden then, `STATE_DELTA`). A write that fits the
 * columns of its row is written in place; a write that moves the row in the order or to another
 * table, and a new row, put a copy of the row in the delta.
 */

import {
  type CoordinateDimensions,
  type CoordinateSystem,
  isCoordinateDimensions,
  planarCoordinates,
  sortKeyOf,
  type Utf8Column,
  utf8ColumnFromStrings,
  utf8ColumnLength,
  utf8String,
  ValueStringCache,
} from '@sakuzu/tabane';
import type { BBox } from '../geometry/bbox-type.js';
import { DrawError } from '../shared/draw-error.js';
import type { FeatureStyle, LayerRowsChange, RowsChange } from '../shared/types/model.js';
import { propertyColumnsOf, styleColumnOf } from '../table/feature-row-columns.js';
import { KasaneError } from '../table/kasane-error.js';
import { buildCacheColumns, cacheColumnsIn, type RowCache } from '../table/row-caches.js';
import { type RowColumnLayout, rowColumnLayoutOf } from '../table/row-columns.js';
import {
  createRowBlockDataBuilder,
  ROW_BLOCK_TARGET_ROWS,
  type RowInput,
} from '../table/row-group-builder.js';
import { mergeRowBlockData } from '../table/row-group-merge.js';
import {
  ROW_FLAG_DELETED,
  type RowBlockData,
  type RowBlockValues,
} from '../table/row-group-types.js';
import { compareRowKeys, type GroupKeySource, type RowKeySource } from '../table/row-keys.js';
import type { RowRings } from '../table/row-rings.js';
import { groupRunCuts, rowGroupsHolding } from './group-runs.js';
import { GroupTable } from './group-table.js';
import { IdIndex } from './id-index.js';
import { ItemWalk } from './item-walk.js';
import { RowBoxIndex } from './row-box-index.js';
import { groupRowRead, type RowReadContext, rowInputOf, rowValue } from './row-read.js';
import { noteRowState } from './row-skips.js';
import {
  checkStateBits,
  RowStates,
  STATE_DELETED,
  STATE_DELTA,
  STATE_WAIT,
  TABLE_STATES,
  USER_STATES,
  type ValueStates,
} from './row-state.js';
import {
  createRowGroup,
  geometryAt,
  overrideBytesOf,
  type RowGroup,
  RowTable,
} from './row-table.js';
import { type RowField, RowFields, type RowValues, type TableColumns } from './row-values.js';
import {
  type GeometryWrite,
  isRingKey,
  refreshRowShape,
  writeRowGeometry,
  writeRowValue,
} from './row-write.js';
import { StyleTable } from './style-table.js';
import type {
  TableGroupField,
  TableGroupPatch,
  Tables,
  TablesWrite,
  TablesWriteOptions,
  TablesWriter,
} from './tables-writer.js';
import {
  type DeltaRowsChange,
  type GroupHandle,
  type InPlaceRowWrite,
  ROW_WRITE_GEOMETRY,
  ROW_WRITE_STATE,
  ROW_WRITE_STYLE,
  ROW_WRITE_VALUES,
  type RowCursor,
  type RowGroupHandle,
  type RowHandle,
  type TableScan,
  type TableWorkBudget,
  type WhenIdle,
} from './types.js';
import { OVERRIDE_BYTES_LIMIT } from './value-overrides.js';
import {
  type FeatureTablesWorker,
  type GroupVersion,
  type GroupVersionReceiver,
  GroupVersions,
  type VersionHost,
  type WaitingCopies,
} from './versions.js';
import { WriteMarks } from './write-marks.js';

/**
 * The share of the rows of a group deleted and kept by nothing past which the group is due for
 * its next version (which leaves them out), and the number it always keeps before
 */
const DROPPED_ROWS_SHARE = 1 / 8;
const DROPPED_ROWS_MIN = 64;

/**
 * The fields that place a row: its parent (a table or a group) and the key of its order there (the
 * fields the user of the tables declares, `relocatingFields`, place it again too)
 */
const PLACE_FIELDS: ReadonlySet<string> = new Set(['parent', 'key']);

/**
 * The start of the fields of the attributes of a row (`properties:<key>`)
 *
 * @internal
 */
export const PROPERTY_FIELD = 'properties:';

/** The fields a new row is written with: a deleted row written all of them is created again */
const CREATE_FIELDS: readonly RowField[] = ['type', 'parent', 'geometry', 'key'];

/** The fields a box of a row is made of, apart from what a box of its type reads */
const BOX_FIELDS: readonly RowField[] = ['type', 'parent', 'geometry'];

/** The fields of the rows of a row group taken in, told as written (with their attributes) */
const ADDED_FIELDS: readonly RowField[] = [
  'type',
  'parent',
  'key',
  'geometry',
  'hidden',
  'locked',
  'style',
];

/** The rows of a write that writes none */
const NO_ROWS: RowsChange = { layers: new Map() };

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
 * The options of the tables: what the user of the tables declares of its rows, and how the tables
 * run their work
 *
 * @internal
 */
export interface TablesStoreOptions {
  /**
   * Where the large merges and builds of rows run (on the main thread, within the time of the
   * frames, when omitted)
   */
  readonly worker?: FeatureTablesWorker;
  /**
   * Told the deleted rows nothing keeps any more (a token let go of): the user of the tables
   * forgets them (`TablesWriter.forget`) once it no longer needs their ids
   */
  readonly onRelease?: (handles: Int32Array) => void;
  /**
   * The dimensions of the coordinates of the rows of a table, read once, when the table first
   * holds rows (`xy` for every table when omitted)
   */
  readonly dimensionsOf?: (tableId: string) => CoordinateDimensions;
  /**
   * The system of the coordinates the bbox of the rows and their spatial index are made in (the
   * plane when omitted)
   */
  readonly coordinateSystem?: CoordinateSystem;
  /** The number of strings read from the columns that are kept (50,000 when omitted) */
  readonly stringCacheSize?: number;
  /**
   * When the tables run their work, a slice at a time: the build of the index of the boxes of the
   * rows (none: it is left to the first search)
   */
  readonly whenIdle?: WhenIdle;
  /**
   * The columns of the rows of all the tables, by their names: what the names of the fields of the
   * values of rows written and read are checked against
   */
  readonly columns: TableColumns;
  /**
   * The columns of the groups, by their names, besides their fixed fields (`id`, `parent`, `key`;
   * none when omitted): what the names of the fields of the values of groups written are checked
   * against
   */
  readonly groupColumns?: TableColumns;
  /**
   * The fields whose new value places a row again, as a new place does (none when omitted): what
   * the drawing cuts the rows by. A row written another value of one goes to the delta rather
   * than being written in place. The type (`type`) and attributes (`properties:<key>`) can be
   * declared
   */
  readonly relocatingFields?: readonly RowField[];
  /**
   * The rings the rows of some types draw around their point (none when omitted: every row draws
   * its shape). The rows a Worker builds for the tables are to be built with the same
   */
  readonly rings?: RowRings;
  /**
   * The caches of the rows (none when omitted): made of every row built and written, copied where
   * a row does not change. The rows a Worker builds for the tables are to be built with the same;
   * a row block taken in without one has it made then
   */
  readonly caches?: readonly RowCache[];
  /**
   * The number of bits of the state of each handle (0 to 13; none when omitted): the lowest bits
   * of the copy of the state of a row, set with `TablesWriter.setRowStates`. Up to 8 take one byte
   * per handle
   */
  readonly rowStateBits?: number;
  /**
   * The bits of the copy of the state of a row that leave it out of the rows drawn
   * (`listDrawnRows`; none when omitted). The rows deleted and read elsewhere are left out anyway
   */
  readonly hiddenStates?: number;
  /**
   * The byte per row the drawing side reads, made of the copy of the state of the row each time it
   * is made (0 when omitted)
   */
  readonly stateByte?: (state: number) => number;
  /**
   * The bits of the copy of the state of a row made from values (none when omitted): from `flag`
   * columns of the rows and of the groups, and from values of `whole` columns kept by each row
   * block
   */
  readonly valueStates?: ValueStates;
}

/**
 * Where a row is read: its group (a group of a table, or the group of the delta of a table) and
 * its row there
 *
 * @internal
 */
export interface RowPlace {
  readonly table: RowTable;
  readonly group: RowGroup;
  readonly row: number;
}

/**
 * What the user of the tables reads of them besides their reading side: what draws the rows and
 * hits them
 *
 * @internal
 */
export interface RowBlocks {
  readonly ids: IdIndex;
  readonly styles: StyleTable;
  readonly groups: GroupTable;
  /**
   * The keys of the order of groups written and not in the order read yet: their
   * members are read and drawn where the keys before put them until their reorder goes in. The
   * writes read the order written (`ItemWalk`)
   */
  readonly writtenOrders: ReadonlyMap<GroupHandle, string>;
  /** The bits of the state of each handle (`setRowStates`) */
  readonly rowStates: RowStates;
  readonly strings: ValueStringCache;
  readonly readContext: RowReadContext;
  /** Changes with every change of the rows drawn of any table */
  readonly revision: number;
  /** The write mark the rows written are stamped with (`write-marks.ts`) */
  readonly writeMarks: WriteMarks;
  /**
   * Sets the write mark the rows written from now on are stamped with: the Store gives it before
   * the first write of values of each frame of writes (see `write-mark-keeper.ts`), and the writing
   * side stamps it (see `write-marks.ts`)
   *
   * @throws KasaneError (`invalid-state`) for a mark below the one before
   */
  setWriteMark(mark: number): void;
  /** The rows of a table (undefined for a table that holds none) */
  rowTable(tableId: string): RowTable | undefined;
  /**
   * The state of a row as its copy in its row group is made: from the sets of the state, its
   * values, its group and where it is read (the checks compare the copy with it)
   */
  rowStateOf(group: RowGroup, row: number): number;
  /** The table and the row group of a handle of a row group */
  rowGroup(handle: RowGroupHandle): { table: RowTable; group: RowGroup } | undefined;
  /** Where the row of a handle is read (undefined for a handle of no row) */
  placeOf(handle: RowHandle): RowPlace | undefined;
  /**
   * The rows of a table whose boxes meet a box, in the order of the table: the rows a click there
   * may hit. Every row of the tables is in one spatial index by the box it covers as it is drawn
   * (`row-box-index.ts`): the box of its positions, or the box the user of the tables gives for
   * its type (`TablesInternalOptions.rowBoxes`)
   *
   * @param visit Receives each row, in order, with the group it is read from
   */
  searchRowBoxes(
    table: RowTable,
    minX: number,
    minY: number,
    maxX: number,
    maxY: number,
    visit: (group: RowGroup, row: number) => void,
  ): void;
  /**
   * The rows of a table whose boxes meet one of several boxes, each once, in the order of the
   * table (as {@link RowBlocks.searchRowBoxes} for one)
   *
   * @param boxes The boxes, `[minX, minY, maxX, maxY]` one after another
   * @param visit Receives each row, in order, with the group it is read from
   */
  searchRowBoxesIn(
    table: RowTable,
    boxes: readonly number[],
    visit: (group: RowGroup, row: number) => void,
  ): void;
  /**
   * Reads every box the user of the tables gives (`TablesInternalOptions.rowBoxes`) again: what
   * they are worked out from changed (the size of the tiles, the calculation of a type), and the
   * types are asked again which give a box
   */
  refreshBoxes(): void;
  /** The rows in the index of the boxes, and the bytes it holds about */
  rowBoxIndexSize(): { readonly rows: number; readonly bytes: number };
  /**
   * The walk of the items of a table in the order written (`ItemWalk`; null for a table that holds
   * no row)
   */
  walkItems(tableId: string): ItemWalk | null;
  /** The handles of the row groups of a set of rows, the rows by group */
  groupsOfRows(handles: Int32Array): Map<RowGroupHandle, number[]>;
  /** The rows read in a table as members of a group (deleted ones included) */
  membersIn(tableId: string, group: GroupHandle): RowHandle[];
  /** Whether row groups built of new rows written are still waiting to be taken in */
  readonly hasQueuedBlocks: boolean;
  /**
   * Takes in the row groups built of new rows written that wait, one group per step, within the
   * budget of the frame (at least one group per call), but the ones of a table whose reorder of
   * groups waits (taken in once it is in). A group that cannot be taken in goes to the
   * delta
   *
   * @returns Whether groups are still waiting
   */
  advanceQueuedBlocks(budget: TableWorkBudget): boolean;
  /**
   * Builds the new rows written and takes in every row group waiting at once (a host without
   * frames, the tests), but the ones of a table whose reorder of groups waits (they are
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
   * Calls `listener` with the rows of a table written in place, so the drawing writes them
   * into the chunks that draw them (the rows of the delta of a table name the handle of the
   * delta, `DeltaRows.handle`)
   *
   * @returns The function that stops the calls
   */
  onRowsWritten(
    listener: (tableId: string, writes: readonly InPlaceRowWrite[]) => void,
  ): () => void;
  /**
   * Calls `listener` when the rows of the delta of a table came in, left or were made again, so
   * the drawing packs them again before its next frame: with the rows that left it and the rows
   * that came into it (told once the rows that left are read again where they are read)
   *
   * @returns The function that stops the calls
   */
  onDeltaChanged(listener: (tableId: string, change: DeltaRowsChange) => void): () => void;
  /**
   * Puts rows of groups into the delta of their table as they are: rows whose change the
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
  /** The rows moved since their row groups were built, over every table */
  movedRowCount(): number;
  /** The rows held by the deltas of every table */
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
  /** The next versions built and waiting for the GPU side, of a table */
  builtVersions(tableId: string): GroupVersion[];
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
  onTouched(listener: (tableId: string, bounds: BBox) => void): () => void;
  /**
   * What the versions did: swapped so far, pending, the most held at once, the time of the last
   * merge (ms)
   */
  versionStats(): { swapped: number; pending: number; mostPending: number; lastMergeMs: number };
  /** Sets the bytes the versions held at once may take (the tests, the measurements) */
  setPendingVersionBytes(bytes: number): void;
  /** Takes every row out of the tables (see `TablesWriter.clear`) */
  clear(): void;
  /**
   * The rows the tables hold and the positions of their geometries: the rows of the blocks of
   * every table, of the rows changed since (the delta) and of the blocks waiting to be taken in
   * (deleted rows kept included), what the memory of the tables is estimated from
   */
  size(): { readonly rows: number; readonly positions: number };
}

/**
 * A row of a patch that comes into the delta of a table
 *
 * @internal
 */
export interface DeltaInput {
  readonly handle: RowHandle;
  readonly input: RowInput;
}

/**
 * New rows of a table built into row groups of their own: a run of keys no
 * row of the table is within, at a place between two groups (or before the first, after the
 * last), gathered over the writes that continue it
 */
interface Creation {
  readonly table: RowTable;
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

/** A row group given to `adopt`, or built of new rows, waiting to be taken in */
interface Adoption {
  readonly table: RowTable;
  readonly data: RowBlockData;
  /** The new rows written the group is built of (put in the delta when it cannot be taken in) */
  readonly creation: Creation;
}

/** What a change wrote to the rows of one table, as it is gathered */
interface TableChangeDraft {
  readonly created: number[];
  readonly updated: number[];
  readonly deleted: number[];
  readonly fields: Set<RowField>;
  readonly styleKeys: Set<string>;
}

/** The implementation of the tables */
export class TablesStore implements RowBlocks, TablesWriter, Tables {
  readonly ids = new IdIndex();
  readonly styles = new StyleTable();
  readonly groups: GroupTable;
  readonly writtenOrders = new Map<GroupHandle, string>();
  readonly strings: ValueStringCache;
  readonly readContext: RowReadContext;
  protected readonly tables = new Map<string, RowTable>();
  /** The tables by their serial number */
  private readonly tableList: RowTable[] = [];
  readonly rowStates: RowStates;
  /** The bits that leave a row out of the rows drawn: those declared, and those of the tables */
  readonly drawnHidden: number;
  /** The byte per row the drawing side reads, made of the copy of the state of the row */
  private readonly stateByte: (state: number) => number;
  private readonly rowGroups = new Map<RowGroupHandle, { table: RowTable; group: RowGroup }>();
  private nextGroup = 0;
  protected revisionCount = 0;
  readonly writeMarks = new WriteMarks();
  /** The row groups given to `adopt` and not taken in yet, in the order they were given */
  private readonly adoptions: Adoption[] = [];
  /** The new rows built into groups of their own, being gathered or built */
  private readonly creations: Creation[] = [];
  /** The creation of each row in one */
  private readonly creationOf = new Map<RowHandle, Creation>();
  private readonly workListeners = new Set<() => void>();
  protected readonly writeListeners = new Set<
    (tableId: string, writes: readonly InPlaceRowWrite[]) => void
  >();
  private readonly deltaListeners = new Set<(tableId: string, change: DeltaRowsChange) => void>();
  private readonly touchListeners = new Set<(tableId: string, bounds: BBox) => void>();
  readonly groupsDue = new Set<RowGroupHandle>();
  private readonly versions: GroupVersions;
  private readonly worker: FeatureTablesWorker | undefined;
  private readonly onRelease: ((handles: Int32Array) => void) | undefined;
  /** The rows of the deltas that are rows drawn over rows (drawn, not read) */
  protected readonly drawnOnlyRows = new Set<RowHandle>();
  /**
   * The rows each deletion of this client keeps, by token, in the order the tokens were made (a
   * token that keeps groups only has no row)
   */
  private readonly retained = new Map<number, Set<RowHandle>>();
  /** The token that keeps each deleted row kept */
  private readonly retainOf = new Map<RowHandle, number>();
  /** The groups each deletion of this client keeps, by token */
  private readonly retainedGroups = new Map<number, Set<GroupHandle>>();
  /** The token that keeps each deleted group kept */
  private readonly groupRetainOf = new Map<GroupHandle, number>();
  private nextToken = 1;
  /** The deleted rows whose ids are forgotten, freed once their rows are gone */
  private readonly forgotten = new Set<RowHandle>();
  /**
   * The groups deleted that rows still name or a token keeps (taken out once none
   * does)
   */
  private readonly deletedGroups = new Set<GroupHandle>();
  /** `TablesStoreOptions.dimensionsOf` */
  private readonly declaredDims: ((tableId: string) => CoordinateDimensions) | undefined;
  /** The system of the coordinates of the rows (`TablesStoreOptions.coordinateSystem`) */
  private readonly coordinates: CoordinateSystem;
  /**
   * The dimensions of the tables whose rows were all taken out (`clear`), kept for the rows that
   * come next
   */
  private readonly clearedDims = new Map<string, CoordinateDimensions>();
  /** The boxes of every row, in one spatial index (the rows a click may hit) */
  private readonly rowBoxes: RowBoxIndex;
  /** The fields whose new value places a row again (`relocatingFields`) */
  protected readonly relocating: ReadonlySet<string>;
  /** The rings the rows of some types draw around their point (`rings`; null for none) */
  private readonly rings: RowRings | null;
  /** The caches of the rows (`caches`) */
  private readonly caches: readonly RowCache[];
  /** The fields of the values of rows the columns declared allow (`columns`) */
  private readonly fields: RowFields;
  /** The columns of the rows (`columns`), and their places in a row block */
  private readonly columns: TableColumns;
  private readonly layout: RowColumnLayout;
  /**
   * The `whole` columns whose values each row block keeps, by their names: their places in
   * `RowBlockData.wholes`. A value a row block does not hold puts the row in the delta
   */
  private readonly blockWholes: ReadonlyMap<string, number>;
  /** The bits of the `flag` columns in `RowBlockData.flags`, by their names */
  private readonly flagBits: ReadonlyMap<string, number>;
  /** The fields of the values of groups: the fixed ones, and the group columns (`groupColumns`) */
  private readonly groupFields: ReadonlySet<string>;
  /** The `flag` columns of the groups, in the order of their bits */
  private readonly groupFlags: readonly string[];
  /**
   * The bits of the copy of the state of a row its flags give it, by the byte of its flags: the
   * deleted mark, and the `flag` columns declared (`valueStates.rowFlags`)
   */
  private readonly flagStates = new Uint16Array(256);
  /** The values of `whole` columns kept by each row block that give a row bits of its state */
  private readonly wholeStates: readonly WholeStates[];

  constructor(options: TablesStoreOptions) {
    this.fields = new RowFields(options.columns);
    this.columns = options.columns;
    this.layout = rowColumnLayoutOf(options.columns);
    if (this.layout.shapes.length > 1 || this.layout.keyed.length > 1) {
      throw new KasaneError(
        'invalid-input',
        'Tables: the rows hold one shape column and one keyed column at most',
      );
    }
    const blockWholes = new Map<string, number>();
    this.layout.wholes.forEach((name, w) => {
      if (this.layout.dictionaries[w] === 'rowBlock') blockWholes.set(name, w);
    });
    this.blockWholes = blockWholes;
    this.flagBits = new Map(
      this.layout.flags.map((name, f) => [name, ROW_FLAG_DELETED << (f + 1)]),
    );
    this.groupFields = new Set(['id', 'parent', 'key', ...Object.keys(options.groupColumns ?? {})]);
    this.groupFlags = rowColumnLayoutOf(options.groupColumns ?? {}).flags;
    this.groups = new GroupTable(this.groupFlags);
    this.strings = new ValueStringCache(options.stringCacheSize);
    this.rowStates = new RowStates(options.rowStateBits ?? 0);
    const hiddenStates = options.hiddenStates ?? 0;
    checkStateBits('the hidden states', hiddenStates, USER_STATES);
    this.drawnHidden = hiddenStates | TABLE_STATES;
    this.wholeStates = this.declareValueStates(options.valueStates ?? {});
    this.stateByte = options.stateByte ?? noStateByte;
    this.declaredDims = options.dimensionsOf;
    this.coordinates = options.coordinateSystem ?? planarCoordinates;
    this.readContext = {
      styles: this.styles,
      groups: this.groups,
      strings: this.strings,
      dimensionsOf: (tableId) => this.dimsOfTable(tableId),
    };
    this.worker = options.worker;
    this.onRelease = options.onRelease;
    this.rings = options.rings ?? null;
    this.caches = options.caches ?? [];
    for (const field of options.relocatingFields ?? []) {
      if (!this.blockWholes.has(field) && !(this.fields.has(field) && field.includes(':'))) {
        throw new KasaneError(
          'invalid-input',
          `Tables: the field ${field} cannot place a row again (a whole column whose values a row block keeps and a key of a keyed column can)`,
        );
      }
    }
    this.relocating = new Set(options.relocatingFields);
    this.versions = new GroupVersions(this.versionHost());
    this.rowBoxes = new RowBoxIndex(
      {
        boxOf: (handle, out, inBuild) => this.rowBoxOf(handle, out, inBuild),
        rowLists: () => this.tableList.map((table) => table.rowOrder().handles),
        countRows: () => {
          let count = 0;
          for (const table of this.tableList) count += table.groupRowCount + table.delta.length;
          return count;
        },
      },
      { whenIdle: options.whenIdle, sortKey: sortKeyOf(this.coordinates) },
    );
  }

  /**
   * The box of a row as it is drawn now, and the number of its table (null for no row): the box
   * the user of the tables gives for it (`givenRowBox`), or the box of its positions
   */
  private rowBoxOf(handle: RowHandle, out: Float64Array, inBuild: boolean): number | null {
    const place = this.placeOf(handle);
    if (!place) return null;
    const { table, group, row } = place;
    if ((group.data.flags[row] & ROW_FLAG_DELETED) !== 0) return null;
    const given = this.givenRowBox(place, out, inBuild);
    if (given !== null) return given ? table.serial : null;
    return table.rowBox(group, row, out) ? table.serial : null;
  }

  /**
   * The box the user of the tables gives a row that is not deleted, written to `out`: true when
   * it gives one, false when it gives one that is not finite (no box), null for a row that takes
   * the box of its positions (every row of the tables)
   *
   * @param inBuild Whether the box is read for a build of every box
   */
  protected givenRowBox(_place: RowPlace, _out: Float64Array, _inBuild: boolean): boolean | null {
    return null;
  }

  /**
   * Whether the user of the tables gives the box of a row (`givenRowBox`): a write of any value
   * of it marks its box (none of the tables)
   */
  protected hasGivenBox(_group: RowGroup, _row: number): boolean {
    return false;
  }

  searchRowBoxes(
    table: RowTable,
    minX: number,
    minY: number,
    maxX: number,
    maxY: number,
    visit: (group: RowGroup, row: number) => void,
  ): void {
    table.visitInOrder(this.rowsInBoxes(table, [minX, minY, maxX, maxY]), visit);
  }

  searchRowBoxesIn(
    table: RowTable,
    boxes: readonly number[],
    visit: (group: RowGroup, row: number) => void,
  ): void {
    table.visitInOrder(this.rowsInBoxes(table, boxes), visit);
  }

  /**
   * The rows of a table whose boxes meet one of the boxes (`[minX, minY, maxX, maxY]` one after
   * another), each once, by the group they are read from
   */
  private rowsInBoxes(table: RowTable, boxes: readonly number[]): Map<RowGroup, number[]> {
    const found = new Map<RowGroup, number[]>();
    // A row found in a box before is not taken again (one box needs no check)
    const seen = boxes.length > 4 ? new Set<RowHandle>() : null;
    // The rows found come by neighbourhoods, often many of one group after another: the group of
    // the last row and its list are kept
    let lastGroup: RowGroup | null = null;
    let lastRows: number[] = [];
    for (let at = 0; at + 3 < boxes.length; at += 4) {
      const handles = this.rowBoxes.search(
        table.serial,
        boxes[at],
        boxes[at + 1],
        boxes[at + 2],
        boxes[at + 3],
      );
      for (const handle of handles) {
        if (seen) {
          if (seen.has(handle)) continue;
          seen.add(handle);
        }
        const place = this.placeOf(handle);
        if (!place || place.table !== table) continue;
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
    }
    return found;
  }

  refreshBoxes(): void {
    this.rowBoxes.markAll();
  }

  rowBoxIndexSize(): { readonly rows: number; readonly bytes: number } {
    this.rowBoxes.search(-1, 0, 0, 0, 0);
    return { rows: this.rowBoxes.size, bytes: this.rowBoxes.bytes };
  }

  walkItems(tableId: string): ItemWalk | null {
    const table = this.tables.get(tableId);
    return table ? new ItemWalk(table, this) : null;
  }

  /** What the versions read and write of the tables */
  private versionHost(): VersionHost {
    const store = this;
    return {
      tables: () => this.tables.values(),
      get writeMark() {
        return store.writeMarks.mark;
      },
      nextGroupHandle: () => this.nextGroup++,
      inDelta: (handle) => this.ids.deltaTable(handle) >= 0,
      drawnOnly: (handle) => this.drawnOnlyRows.has(handle),
      mainGroup: (handle) => this.ids.mainGroup(handle),
      rowInput: (group, row) => rowInputOf(this.readContext, group, row),
      buildRows: (inputs, dims) => this.buildRows(inputs, dims),
      coordinates: this.coordinates,
      ringVertices: this.rings?.ringVertices ?? 1,
      groupKeys: this.groups,
      groupKeyList: () => this.groups.keyList(),
      orderVersionOf: (group) => this.groups.orderVersionOf(group),
      swapIn: (version, waiting) => this.swapIn(version, waiting),
      retainStyles: (data, count) => {
        for (let r = 0; r < data.length; r++) {
          if (count > 0) this.styles.retain(styleColumnOf(data).indexes[r]);
          else this.styles.release(styleColumnOf(data).indexes[r]);
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
   * Whether a reorder of the groups of a table waits to go in: the keys of its groups
   * are going to change, so nothing new is put among its row groups until then (row groups taken
   * in, new rows built into groups of their own, next versions): what is placed by the keys
   * written would be put among the groups by the keys before
   */
  private reorderWaits(table: RowTable): boolean {
    return this.versions.reorders(table).length > 0;
  }

  builtVersions(tableId: string): GroupVersion[] {
    const table = this.tables.get(tableId);
    return table ? this.versions.built(table) : [];
  }

  attachReceiver(receiver: GroupVersionReceiver): () => void {
    return this.versions.attach(receiver);
  }

  urgeVersions(groups: Iterable<RowGroupHandle>): void {
    this.versions.urge(groups);
  }

  onTouched(listener: (tableId: string, bounds: BBox) => void): () => void {
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

  clear(): TablesWrite {
    this.rowBoxes.markAll();
    // The rows drawn and not read go with the delta
    this.drawnOnlyRows.clear();
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
    // The rows of every table: their styles let go of, and their handles placed nowhere (an id
    // keeps its handle until the Store forgets it)
    const release = (group: RowGroup): void => {
      const data = group.data;
      for (let r = 0; r < data.length; r++) {
        this.styles.release(styleColumnOf(data).indexes[r]);
        const handle = data.handles[r];
        if (handle < 0) continue;
        if (group.delta) this.ids.setDelta(handle, -1, -1);
        else if (this.ids.mainGroup(handle) === group.handle) this.ids.setMain(handle, -1, -1);
      }
    };
    for (const table of this.tables.values()) {
      // A table keeps the dimensions of its coordinates for the rows that come next
      this.clearedDims.set(table.tableId, table.dims);
      for (let g = 0; g < table.groupCount; g++) release(table.groupAt(g));
      if (table.delta.group) release(table.delta.group);
    }
    this.tables.clear();
    this.tableList.length = 0;
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
    this.notifyWork();
    return { rows: NO_ROWS, kept: false, emptied: true };
  }

  size(): { readonly rows: number; readonly positions: number } {
    let rows = 0;
    let positions = 0;
    for (const table of this.tables.values()) {
      for (let g = 0; g < table.groupCount; g++) {
        const data = table.groupAt(g).data;
        rows += data.length;
        positions += data.vertexCount;
      }
      const delta = table.delta.group?.data;
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
  protected touch(tableId: string, bounds: BBox | null): void {
    if (!bounds || this.touchListeners.size === 0) return;
    for (const listener of this.touchListeners) listener(tableId, bounds);
  }

  get revision(): number {
    return this.revisionCount;
  }

  rowTable(tableId: string): RowTable | undefined {
    return this.tables.get(tableId);
  }

  rowGroup(handle: RowGroupHandle): { table: RowTable; group: RowGroup } | undefined {
    return this.rowGroups.get(handle);
  }

  /**
   * The dimensions of the coordinates of the rows of a table: its own once it holds rows, the
   * ones it had when its rows were taken out (`clear`), the ones the options declare for it before
   *
   * @throws when the options declare what is not dimensions
   */
  dimsOfTable(tableId: string): CoordinateDimensions {
    const table = this.tables.get(tableId);
    if (table) return table.dims;
    const cleared = this.clearedDims.get(tableId);
    if (cleared) return cleared;
    const dims = this.declaredDims?.(tableId) ?? 'xy';
    if (!isCoordinateDimensions(dims)) {
      throw new DrawError(
        'invalid-state',
        `Tables: the table "${tableId}" has the dimensions ${dims}`,
      );
    }
    return dims;
  }

  /** The rows of a table, made when first written (with the dimensions declared for it) */
  protected tableOf(tableId: string): RowTable {
    let table = this.tables.get(tableId);
    if (!table) {
      table = new RowTable(
        tableId,
        this.groups,
        this.tableList.length,
        this.nextGroup++,
        this.dimsOfTable(tableId),
      );
      table.setPendingSource(() => this.pendingGroups(table as RowTable));
      table.onRowBox = (handle) => this.rowBoxes.markOne(handle);
      table.setDrawnOnly((handle) => this.drawnOnlyRows.has(handle));
      this.tables.set(tableId, table);
      this.tableList.push(table);
    }
    return table;
  }

  placeOf(handle: RowHandle): RowPlace | undefined {
    if (!this.findPlace(handle)) return undefined;
    return {
      table: this.foundTable as RowTable,
      group: this.foundGroup as RowGroup,
      row: this.foundRow,
    };
  }

  /** The table of the row the last `findPlace` found (read at once: the next search changes it) */
  foundTable: RowTable | null = null;
  /** The group of the row the last `findPlace` found */
  foundGroup: RowGroup | null = null;
  /** The row in its group the last `findPlace` found */
  foundRow = -1;

  /**
   * Finds where a row is read, as `placeOf` does, without making an object: true when it is
   * found, its table, group and row then in `foundTable`, `foundGroup` and `foundRow` (a read of a
   * value of each row of many makes nothing per row)
   */
  findPlace(handle: RowHandle): boolean {
    const serial = this.ids.deltaTable(handle);
    if (serial >= 0) {
      const table = this.tableList[serial];
      const group = table.delta.group;
      if (group) return this.found(table, group, this.ids.deltaSlot(handle));
    }
    const placed = this.rowGroups.get(this.ids.mainGroup(handle));
    if (placed) return this.found(placed.table, placed.group, this.ids.mainRow(handle));
    // A new row read from its creation until its group is taken in
    const creation = this.creationOf.get(handle);
    const reading = creation ? this.readingOf(creation) : null;
    const row = reading?.rows.get(handle);
    if (!creation || !reading || row === undefined) return false;
    return this.found(creation.table, reading.group, row);
  }

  private found(table: RowTable, group: RowGroup, row: number): true {
    this.foundTable = table;
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
    if (this.ids.deltaTable(handle) >= 0 || this.rowGroups.has(this.ids.mainGroup(handle))) {
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

  /** The handle of the row of an id (undefined for an id of no row, or of a row deleted) */
  handleOf(id: string): RowHandle | undefined {
    const handle = this.ids.handleOf(id);
    if (handle < 0) return undefined;
    const place = this.placeOf(handle);
    if (!place) return undefined;
    return (place.group.data.flags[place.row] & ROW_FLAG_DELETED) !== 0 ? undefined : handle;
  }

  membersIn(tableId: string, group: GroupHandle): RowHandle[] {
    const table = this.tables.get(tableId);
    if (!table) return [];
    const out: RowHandle[] = [];
    const take = (rowGroup: RowGroup): void => {
      const data = rowGroup.data;
      for (let r = 0; r < data.length; r++) {
        if (data.groups[r] !== group) continue;
        const handle = data.handles[r];
        const place = this.placeOf(handle);
        if (place?.group === rowGroup && place.row === r) out.push(handle);
      }
    };
    for (let g = 0; g < table.groupCount; g++) take(table.groupAt(g));
    if (table.delta.group) take(table.delta.group);
    for (const creation of this.creations) {
      if (creation.table !== table) continue;
      for (const row of creation.rows) if (row.input.group === group) out.push(row.handle);
    }
    return out;
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
   * Takes row groups into a table at once: every group is checked before any is taken in (its
   * shape, its dimensions, its groups, and that none of its ids is a row already), then
   * each is put at its place in the order of the table (into the delta when its rows are not in the
   * order of their keys, overlap another group, or a reorder of the groups of the table waits),
   * and its rows are told as created
   */
  addRowBlocks(tableId: string, groups: readonly RowBlockData[]): TablesWrite {
    const dims = this.dimsOfTable(tableId);
    for (const data of groups) {
      checkShape(data, this.layout);
      checkDims(data, dims);
      this.fitCaches(data);
      if (data.length === 0) throw new DrawError('invalid-input', 'Tables: an empty row group');
      for (let r = 0; r < data.length; r++) {
        const group = data.groups[r];
        if (group >= 0 && !this.groups.has(group)) {
          throw new DrawError(
            'not-found',
            `Tables: a row names the group ${group}, which is unknown`,
          );
        }
        const handle = this.ids.handleOfEntry(data.ids, r, data.idHashes[r]);
        if (handle >= 0 && (this.ids.mainGroup(handle) >= 0 || this.ids.deltaTable(handle) >= 0)) {
          throw new DrawError(
            'already-exists',
            `Tables: "${this.ids.idOf(handle)}" is already a row`,
          );
        }
      }
    }
    const table = this.tableOf(tableId);
    const drafts = new Map<string, TableChangeDraft>();
    const draft = draftOf(drafts, tableId);
    for (const data of groups) {
      if (this.reorderWaits(table)) this.rowsToDelta(table, data);
      else this.adoptGroup(table, data);
      for (let r = 0; r < data.length; r++) draft.created.push(data.handles[r]);
      for (const field of ADDED_FIELDS) draft.fields.add(field);
      for (const key of propertyColumnsOf(data).keys) draft.fields.add(`${PROPERTY_FIELD}${key}`);
    }
    const rows: RowsChange = { layers: finishChanges(drafts) };
    this.notifyWork();
    return { rows, kept: false, emptied: false };
  }

  get hasQueuedBlocks(): boolean {
    return this.adoptions.length > 0;
  }

  advanceQueuedBlocks(budget: TableWorkBudget): boolean {
    let at = 0;
    while (at < this.adoptions.length && budget.canStep()) {
      const next = this.adoptions[at];
      // The groups of a table whose reorder waits wait with it, in their order
      if (this.reorderWaits(next.table)) {
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
      if (this.reorderWaits(next.table)) {
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
      this.adoptGroup(adoption.table, adoption.data);
    } catch {
      this.rowsToDelta(adoption.table, adoption.data);
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
      // Its rows are read from it until the reorder of its table is in, and built then
      if (this.reorderWaits(creation.table)) continue;
      // Rows keep coming: the groups of the target size are built, the rest keeps gathering (so
      // a long import is not cut into a group per write)
      if (wait && creation.idle <= CREATE_WAIT_FRAMES) this.splitCreation(creation);
    }
    for (const creation of [...this.creations]) {
      if (creation.status !== 'gathering' || this.reorderWaits(creation.table)) continue;
      if (wait && creation.idle <= CREATE_WAIT_FRAMES) continue;
      const worker = this.worker;
      if (worker && wait) {
        creation.status = 'building';
        const inputs = creation.rows.map((row) => row.input);
        worker
          .build(inputs, { groups: this.groups.keyList(), dimensions: creation.table.dims })
          .then(
            (groups) => {
              if (creation.status !== 'building') return;
              // The host builds with the builder of the library
              for (const data of groups as RowBlockData[]) this.fitCaches(data);
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
      columns: this.columns,
      groups: this.groups.keyList(),
      dimensions: creation.table.dims,
      coordinateSystem: this.coordinates,
      rings: this.rings ?? undefined,
      caches: this.caches,
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
    for (const data of groups) this.adoptions.push({ table: creation.table, data, creation });
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
   * reorder of its table waits, its rows not taken in go to the delta instead
   */
  private finishCreationNow(creation: Creation): void {
    if (this.reorderWaits(creation.table)) {
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
    for (const data of groups) this.takeIn({ table: creation.table, data, creation });
  }

  /**
   * The new rows of a table not taken in yet, built to be read: one group per creation of the
   * table (made when first read after a change of its rows)
   */
  private pendingGroups(table: RowTable): RowGroup[] {
    const out: RowGroup[] = [];
    for (const creation of this.creations) {
      if (creation.table !== table || creation.rows.length === 0) continue;
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
      creation.table.dims,
    );
    if (!data) return null;
    const group = createRowGroup(-1, data, this.writeMarks.mark, false, true);
    const rows = new Map<RowHandle, number>();
    for (let r = 0; r < data.length; r++) {
      rows.set(data.handles[r], r);
      this.styles.retain(styleColumnOf(data).indexes[r]);
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
        this.styles.release(styleColumnOf(reading.group.data).indexes[r]);
      }
    }
    creation.table.touchPending();
  }

  /** Puts the rows of a creation into the delta (it could not be built) */
  private creationToDelta(creation: Creation): void {
    this.endCreation(creation);
    this.rebuildDelta(creation.table, new Set(), creation.rows);
    this.revisionCount++;
  }

  /**
   * Puts the rows of a row group that cannot be taken in as a group into the delta of its table
   * (given to `adopt`, or built of new rows)
   */
  private rowsToDelta(table: RowTable, data: RowBlockData): void {
    this.numberStyles(data);
    data.handles.set(this.ids.allocate(data.ids, data.idHashes));
    this.rowBoxes.mark(data.handles);
    const group = createRowGroup(-1, data, this.writeMarks.mark);
    const rows: DeltaInput[] = [];
    const seen = new Set<RowHandle>();
    for (let r = 0; r < data.length; r++) {
      const handle = data.handles[r];
      // A row read from a row group or a delta is not put there again (one read from its
      // creation, which it is about to leave, is), nor an id the group holds twice (its first)
      if (this.ids.mainGroup(handle) >= 0 || this.ids.deltaTable(handle) >= 0) continue;
      if (seen.has(handle)) continue;
      seen.add(handle);
      rows.push({ handle, input: rowInputOf(this.readContext, group, r) });
    }
    this.rebuildDelta(table, new Set(), rows);
    this.revisionCount++;
  }

  /**
   * Takes new rows of one write into a creation when their keys are a run no row of the table is
   * within, at a place between two groups: a new one when they are many, or the creation at the
   * same place whose rows they follow. Past the size of a group of the delta, a run gathers wherever
   * it is, and goes into the delta when it is taken in
   *
   * @returns Whether they were taken (they go to the delta otherwise)
   */
  private tryCreate(table: RowTable, rows: DeltaInput[]): boolean {
    const keys = keySourceOf(rows.map((row) => row.input));
    const order = rows.map((_, i) => i);
    order.sort((a, b) => compareRowKeys(keys, a, keys, b, this.groups));
    const first = order[0];
    const last = order[order.length - 1];
    // A delta is made again whole for each write into it: past the size of a group, the rows of a
    // run among the rows of the table gather too, and go into it a group at a time when they are
    // taken in, so that many of them written a part at a time do not make it again for each part
    const large = table.delta.length >= ROW_BLOCK_TARGET_ROWS;
    if (!large && !this.withinGap(table, keys, first, keys, last)) return false;
    const cmp = (a: RowKeySource, i: number, b: RowKeySource, j: number): number =>
      compareRowKeys(a, i, b, j, this.groups);
    // The creation whose rows these follow, with no row of the table between them
    let target: Creation | null = null;
    for (const creation of this.creations) {
      if (creation.table !== table) continue;
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
    if (target && !large && !this.withinGap(table, target.first, 0, keys, last)) target = null;
    // Rows of the delta within the run (from the last row of the creation continued)
    const from = target ? target.last : keys;
    if (!large && this.deltaWithin(table, from, target ? 0 : first, keys, last)) return false;
    if (target && target.rows.length >= ROW_BLOCK_TARGET_ROWS) target = null;
    if (!target) {
      if (rows.length < CREATE_GROUP_MIN_ROWS) return false;
      target = {
        table,
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
   * Whether a run of keys `[first, last]` falls between two groups of a table (or before the
   * first, after the last): no row of a group is within it
   */
  private withinGap(
    table: RowTable,
    firstKeys: RowKeySource,
    first: number,
    lastKeys: RowKeySource,
    last: number,
  ): boolean {
    if (table.groupCount === 0) return true;
    const a = table.positionOfKey(firstKeys, first);
    const b = table.positionOfKey(lastKeys, last);
    if (!a || !b || a.group !== b.group || a.slot !== b.slot || a.slot % 2 === 1) return false;
    const g = table.orderOf(a.group);
    return a.slot === 2 * table.groupAt(g).data.length || (g === 0 && a.slot === 0);
  }

  /** Whether a row of the delta of a table has a key within `[from, to]` of two sources */
  private deltaWithin(
    table: RowTable,
    fromKeys: RowKeySource,
    from: number,
    toKeys: RowKeySource,
    to: number,
  ): boolean {
    const delta = table.delta.group;
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
    for (const table of this.tables.values()) count += table.movedRowCount;
    return count;
  }

  deltaRowCount(): number {
    let count = 0;
    for (const table of this.tables.values()) count += table.delta.length;
    return count;
  }

  onRowsWritten(
    listener: (tableId: string, writes: readonly InPlaceRowWrite[]) => void,
  ): () => void {
    this.writeListeners.add(listener);
    return () => {
      this.writeListeners.delete(listener);
    };
  }

  onDeltaChanged(listener: (tableId: string, change: DeltaRowsChange) => void): () => void {
    this.deltaListeners.add(listener);
    return () => {
      this.deltaListeners.delete(listener);
    };
  }

  /** Reads the handles of the rows of tables a batch at a time */
  scan(options: TableScan): RowCursor {
    const tables = (options.tableIds ?? [...this.tables.keys()])
      .map((id) => this.tables.get(id))
      .filter((table): table is RowTable => table !== undefined);
    const batch = Math.max(1, Math.floor(options.batchSize ?? SCAN_BATCH));
    const bbox = options.bbox;
    let tableAt = 0;
    let handles: number[] | null = null;
    let at = 0;
    return {
      next: (): Int32Array | null => {
        const out: number[] = [];
        while (out.length < batch && tableAt < tables.length) {
          if (!handles) {
            handles = [];
            const list = handles;
            const table = tables[tableAt];
            const take = (group: RowGroup, row: number): void => {
              if ((group.data.flags[row] & ROW_FLAG_DELETED) === 0) {
                list.push(group.data.handles[row]);
              }
            };
            if (bbox && options.order === 'any') {
              // The rows found in the index of the boxes, as it gives them
              for (const handle of this.rowBoxes.search(
                table.serial,
                bbox[0],
                bbox[1],
                bbox[2],
                bbox[3],
              )) {
                const place = this.placeOf(handle);
                if (place?.table === table && table.readsRow(place.group, place.row)) {
                  take(place.group, place.row);
                }
              }
            } else if (bbox) {
              this.searchRowBoxes(table, bbox[0], bbox[1], bbox[2], bbox[3], take);
            } else {
              const order = table.rowOrder();
              for (let i = 0; i < order.handles.length; i++) take(order.groups[i], order.rows[i]);
            }
            at = 0;
          }
          while (out.length < batch && at < handles.length) out.push(handles[at++]);
          if (at >= handles.length) {
            tableAt++;
            handles = null;
          }
        }
        return out.length > 0 ? Int32Array.from(out) : null;
      },
    };
  }

  /** Puts rows of groups into the delta of their table as they are */
  toDelta(handles: readonly RowHandle[]): void {
    const inputs = new Map<RowTable, DeltaInput[]>();
    for (const handle of handles) {
      if (this.ids.deltaTable(handle) >= 0) continue;
      const placed = this.rowGroups.get(this.ids.mainGroup(handle));
      if (!placed) continue;
      const input = rowInputOf(this.readContext, placed.group, this.ids.mainRow(handle));
      let list = inputs.get(placed.table);
      if (!list) {
        list = [];
        inputs.set(placed.table, list);
      }
      list.push({ handle, input });
      // Its group is not where it is read any more
      this.writeMarks.stampGroup(placed.group);
    }
    if (inputs.size === 0) return;
    for (const [table, list] of inputs) this.rebuildDelta(table, new Set(), list);
    for (const list of inputs.values()) {
      for (const { handle } of list) this.refreshCopies(handle);
    }
    this.revisionCount++;
  }

  /** Writes values of rows (see `TablesWriter.apply`) */
  apply(patch: RowValues, options: TablesWriteOptions = {}): TablesWrite {
    const drafts = new Map<string, TableChangeDraft>();
    this.applyPatch(patch, drafts);
    const kept = this.keepDeleted(patch, options.restoreToken);
    return { rows: { layers: finishChanges(drafts) }, kept, emptied: false };
  }

  allocateHandles(ids: Utf8Column, hashes?: Uint32Array): Int32Array {
    return this.ids.allocate(ids, hashes);
  }

  // === The rows deleted kept, forgotten ===

  createRestoreToken(): number {
    return this.nextToken++;
  }

  /**
   * Keeps the rows a write deleted with its token, and takes the rows created again out of the
   * tokens that kept them; the row groups with many deleted rows nothing keeps are due for their
   * next versions
   *
   * @returns Whether the token keeps a row
   */
  private keepDeleted(patch: RowValues, token: number | undefined): boolean {
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
    return kept;
  }

  /** Takes a row out of the token that keeps it */
  private unkeep(handle: RowHandle): void {
    const token = this.retainOf.get(handle);
    if (token === undefined) return;
    this.retainOf.delete(handle);
    this.retained.get(token)?.delete(handle);
  }

  release(token: number): void {
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

  /** Keeps a group deleted with a token */
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
    if (this.ids.mainGroup(handle) >= 0 || this.ids.deltaTable(handle) >= 0) return;
    if (this.creationOf.has(handle)) return;
    this.forgotten.delete(handle);
    // The state of the handle goes with it; the user of the tables is told what it held
    const bits = this.rowStates.clear(handle);
    if (bits !== 0) this.statesForgotten(handle, bits);
    this.ids.free(handle);
  }
  /**
   * Told the bits of the state of a handle freed (`setRowStates`), which go with it: what the user
   * of the tables keeps of them is let go of (nothing of the tables)
   */
  protected statesForgotten(_handle: RowHandle, _bits: number): void {}

  /**
   * Checks the shape of a patch: one value per row in every field (the values are checked where
   * they are written)
   */
  private checkPatch(patch: RowValues): void {
    this.fields.check(patch);
    const n = patch.handles.length;
    for (const [field, values] of patch.fields) {
      if (values.length !== n) {
        throw new DrawError(
          'invalid-input',
          `Tables: "${field}" has ${values.length} values for ${n} rows`,
        );
      }
    }
    if (patch.deleted && patch.deleted.length !== n) {
      throw new DrawError('invalid-input', 'Tables: deleted has another length than the rows');
    }
  }

  setRowStates(handles: Int32Array, mask: number, bits: number): void {
    const changed = this.rowStates.set(handles, mask, bits);
    if (changed.length > 0) this.refreshStates(changed);
  }

  setGroupStates(groups: Int32Array, mask: number, bits: number): void {
    checkStateBits('the bits of groups', mask, USER_STATES & ~this.rowStates.mask);
    for (const group of groups) {
      if (!this.groups.has(group)) {
        throw new KasaneError('not-found', `Tables: no group ${group}`);
      }
    }
    const changed = new Set<GroupHandle>();
    for (const group of groups) {
      if (this.groups.setStates(group, mask, bits)) changed.add(group);
    }
    if (changed.size === 0) return;
    this.refreshGroupStates(changed);
    this.revisionCount++;
    this.notifyWork();
  }

  /** Makes the copies of the state of the rows of groups again */
  private refreshGroupStates(shown: ReadonlySet<GroupHandle>): void {
    for (const table of this.tables.values()) {
      // The row groups around the members of the groups (by their keys), and the delta
      const groups = rowGroupsHolding(table, shown, this.groups).map((g) => table.groupAt(g));
      if (table.delta.group) groups.push(table.delta.group);
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

  setWriteMark(mark: number): void {
    this.writeMarks.set(mark);
  }

  /**
   * Checks the values of a patch before anything is written: one value per row in every field,
   * the geometries, the groups, the keys, and what a new row cannot be without
   *
   * @returns The handle of the group of each row, when the patch writes them
   */
  private checkRows(patch: RowValues): {
    groupHandles: number[] | undefined;
    tableIds: Array<string | undefined> | undefined;
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
          `Tables: the geometry of the row ${handles[i]} is not a geometry`,
        );
      }
    });
    const types = fields.get('type');
    const parents = fields.get('parent');
    const keys = fields.get('key');
    const places = Array.from(handles, (handle) => this.placeOf(handle));
    // The parent of a row is a group (of the table of the group) or a table; a row given none
    // stays in its own
    let groupHandles: number[] | undefined;
    let tableIds: Array<string | undefined> | undefined;
    if (parents) {
      groupHandles = [];
      tableIds = [];
      for (let i = 0; i < handles.length; i++) {
        const parent = parents[i];
        const place = places[i];
        if (parent === undefined) {
          groupHandles.push(place ? place.group.data.groups[place.row] : -1);
          tableIds.push(undefined);
          continue;
        }
        if (typeof parent !== 'string' || parent === '') {
          throw new DrawError(
            'invalid-input',
            `Tables: the parent of the row ${handles[i]} is not an id`,
          );
        }
        const group = this.groups.handleOfId(parent);
        groupHandles.push(group);
        tableIds.push(group >= 0 ? (this.groups.tableOf(group) as string) : parent);
      }
    }
    // A row moved to a table of other dimensions keeps its values only when the positions it
    // has are read the same there (xy into any, xyz into xyzm), or when it is given a geometry
    tableIds?.forEach((tableId, i) => {
      const place = places[i];
      if (typeof tableId !== 'string' || !place || place.table.tableId === tableId) return;
      if (geometries?.[i] !== undefined) return;
      const from = place.table.dims;
      const to = this.dimsOfTable(tableId);
      if (from !== to && !to.startsWith(from)) {
        throw new DrawError(
          'invalid-input',
          `Tables: the row ${handles[i]} has coordinates of ${from}, the table "${tableId}" of ${to}`,
        );
      }
    });
    const strings: Array<[string, readonly unknown[] | undefined]> = [
      ['type', types],
      ['key', keys],
    ];
    for (const [name, values] of strings) {
      values?.forEach((value, i) => {
        if (typeof value === 'string' || (value === undefined && !!places[i])) return;
        throw new DrawError(
          'invalid-input',
          `Tables: the ${name} of the row ${handles[i]} is not a string`,
        );
      });
    }
    places.forEach((place, i) => {
      if (place) return;
      if (!this.ids.has(handles[i])) {
        throw new DrawError('not-found', `Tables: no row has the handle ${handles[i]}`);
      }
      // A new row: what a new row cannot be without
      const missing = [
        ['type', types?.[i]],
        ['parent', parents?.[i]],
        ['geometry', geometries?.[i]],
        ['key', keys?.[i]],
      ].filter(([, value]) => value === undefined);
      if (missing.length > 0) {
        throw new DrawError(
          'invalid-input',
          `Tables: no row has the handle ${handles[i]}, and a new row needs ${missing
            .map(([name]) => name)
            .join(', ')}`,
        );
      }
    });
    return { groupHandles, tableIds, places };
  }

  /**
   * Marks the rows a patch may give another box: every row of a patch that writes what a box is
   * made of (the geometry, the type, the table, the group or whether it is deleted). A patch of the
   * attributes and the style marks only the rows whose box is not their bbox: the box the user of
   * the tables gives (`hasGivenBox`) reads their values
   */
  private markBoxes(patch: RowValues): void {
    const { handles, fields, deleted } = patch;
    if (deleted || BOX_FIELDS.some((field) => fields.has(field))) {
      this.rowBoxes.mark(handles);
      return;
    }
    for (const handle of handles) {
      const place = this.placeOf(handle);
      if (!place) {
        this.rowBoxes.markOne(handle);
        continue;
      }
      if (this.hasGivenBox(place.group, place.row)) {
        this.rowBoxes.markOne(handle);
      }
    }
  }

  /**
   * Writes values of rows: every value is checked before anything is written; then the rows are
   * written in place, and the rows placed elsewhere and the new ones are put in the delta of
   * their table, and the drawing is told
   */
  private applyPatch(patch: RowValues, changes: Map<string, TableChangeDraft>): void {
    const { handles, fields, deleted } = patch;
    this.markBoxes(patch);
    const n = handles.length;
    const checked = this.checkRows(patch);
    const groupHandles = checked.groupHandles;
    const tableIds = checked.tableIds;
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
    const columns = this.patchColumns(fields);
    // Whether a field written can move a row to another place (else no row is looked at for it)
    const relocating = this.relocating;
    const blockWholes = this.blockWholes;
    const mayPlace = [...fields.keys()].some(
      (field) => PLACE_FIELDS.has(field) || blockWholes.has(field) || relocating.has(field),
    );
    /** The writes in place of the table of the row before */
    let lastWritesTable: string | undefined;
    let lastWrites: InPlaceRowWrite[] | undefined;
    let lastTouched: RowGroup | null = null;
    /** The version of the group of the row before, and whether it is locked */
    let lastGroup: RowGroup | null = null;
    let lastLocked = false;
    // The values are made what the columns hold before anything is written
    const styles = fields.get('style');
    // A style given to many rows (a change of the style of many rows gives each kind of row the
    // same object) is made canonical once. The patch counts as a user of each until its rows are
    // written: a row that leaves a style as its last user would otherwise take back the number a
    // later row of the patch is given
    const internedStyles = new Map<unknown, number>();
    const styleNumbers = styles?.map((style) => {
      let number = internedStyles.get(style);
      if (number === undefined) {
        number = this.styles.intern((style ?? {}) as FeatureStyle);
        this.styles.retain(number);
        internedStyles.set(style, number);
      }
      return number;
    });
    /** The keys a row changes in its style, by the number of its style before and after */
    const styleKeysOf = new Map<number, Map<number, readonly string[]>>();
    const keysAddedTo = new Map<readonly string[], TableChangeDraft>();
    /** The change of the table of the row before (a write of many rows is mostly of one table) */
    let lastTable: string | undefined;
    let lastChange: TableChangeDraft | undefined;

    const marks = this.writeMarks;
    // The rows of the deltas written under the mark a version started under stay for it
    const watched = this.versions.watches(marks.mark);
    const writes = new Map<string, InPlaceRowWrite[]>();
    const touched = new Set<RowGroup>();
    const moving = new Map<RowTable, DeltaInput[]>();
    const leaving = new Map<RowTable, Set<RowHandle>>();
    const fresh = new Map<RowTable, DeltaInput[]>();
    let stateChanged = false;
    let created = false;

    for (let i = 0; i < n; i++) {
      const handle = handles[i];
      const place = places[i];
      // A deleted row written whole (its type, table, geometry and key) is created again: it
      // goes to the delta as a new row would
      const revived =
        !!place &&
        !deleted?.[i] &&
        (place.group.data.flags[place.row] & ROW_FLAG_DELETED) !== 0 &&
        CREATE_FIELDS.every((field) => fields.get(field)?.[i] !== undefined);
      const placed = place
        ? revived || (mayPlace && this.placeChanged(place, i, fields, groupHandles, tableIds))
        : true;
      const targetTable = (tableIds?.[i] as string | undefined) ?? place?.table.tableId;
      let change = lastChange;
      if (!change || targetTable !== lastTable) {
        change = draftOf(changes, targetTable as string);
        for (const field of fields.keys()) change.fields.add(field);
        lastTable = targetTable;
        lastChange = change;
      }
      if (styles && styleNumbers && place) {
        const beforeNumber = styleColumnOf(place.group.data).indexes[place.row];
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
        // The keys of a pair are added once per change of a table
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
        marks.stamp(place.group, place.row);
        if (watched && place.group.delta) this.versions.rowChanged(handle, marks.mark);
        if (write.what & ROW_WRITE_GEOMETRY) this.touch(place.table.tableId, place.group.bounds);
        if (write.what & (ROW_WRITE_GEOMETRY | ROW_WRITE_STATE)) stateChanged = true;
        if (place.group !== lastTouched) {
          touched.add(place.group);
          lastTouched = place.group;
        }
        let list =
          lastWritesTable === place.table.tableId ? lastWrites : writes.get(place.table.tableId);
        if (!list) {
          list = [];
          writes.set(place.table.tableId, list);
        }
        lastWritesTable = place.table.tableId;
        lastWrites = list;
        list.push(write);
        continue;
      }
      // Placed elsewhere, or new: a copy in the delta of its table (many new rows next to each
      // other are built into groups of their own instead)
      const input = this.patchedInput(handle, place, i, fields, deleted, groupHandles, revived);
      const table = this.tableOf(targetTable as string);
      if (!place) {
        let list = fresh.get(table);
        if (!list) {
          list = [];
          fresh.set(table, list);
        }
        list.push({ handle, input });
        created = true;
        continue;
      }
      let list = moving.get(table);
      if (!list) {
        list = [];
        moving.set(table, list);
      }
      list.push({ handle, input });
      if (place?.group.delta) {
        let set = leaving.get(place.table);
        if (!set) {
          set = new Set();
          leaving.set(place.table, set);
        }
        set.add(handle);
      } else {
        // Its group is not where it is read any more (the delta it goes to is made again)
        marks.stampGroup(place.group);
      }
      if (!place) created = true;
    }

    // A style interned for a row that kept its own is not held by any row, and goes here
    for (const style of internedStyles.values()) this.styles.release(style);
    for (const group of touched) {
      if (group.delta) continue;
      if (overrideBytesOf(group) > OVERRIDE_BYTES_LIMIT) {
        this.groupsDue.add(group.handle);
        this.versions.markDue(group.handle);
      }
      this.versions.checkMoved(group);
    }
    // The new rows: a run of their own built into groups, or into the delta
    for (const [table, list] of fresh) {
      if (this.tryCreate(table, list)) continue;
      let into = moving.get(table);
      if (!into) {
        into = [];
        moving.set(table, into);
      }
      into.push(...list);
    }
    // The deltas
    const tables = new Set<RowTable>([...moving.keys(), ...leaving.keys()]);
    for (const table of tables) {
      this.rebuildDelta(table, leaving.get(table) ?? new Set(), moving.get(table) ?? []);
    }
    for (const list of moving.values()) {
      for (const { handle } of list) this.refreshCopies(handle);
    }
    if (stateChanged || tables.size > 0 || created) this.revisionCount++;
    for (const [tableId, list] of writes) {
      for (const listener of this.writeListeners) listener(tableId, list);
    }
  }

  /**
   * Writes values of groups (see `TablesWriter.applyGroups`): a new key of
   * the order of a group puts its members in another order (`reorderGroups`), a new parent takes
   * its members to that table with it (they are told as written), a group shown or hidden makes
   * the copies of the state of its members again
   */
  applyGroups(patch: TableGroupPatch, options: TablesWriteOptions = {}): TablesWrite {
    const { handles, fields, deleted } = patch;
    const n = handles.length;
    for (const [field, values] of fields) {
      if (!this.groupFields.has(field)) {
        throw new KasaneError(
          'invalid-input',
          `Tables: ${JSON.stringify(field)} is not a field of a group`,
        );
      }
      if (values.length !== n) {
        throw new DrawError(
          'invalid-input',
          `Tables: "${field}" has ${values.length} values for ${n} groups`,
        );
      }
    }
    if (deleted && deleted.length !== n) {
      throw new DrawError('invalid-input', 'Tables: deleted has another length than the groups');
    }
    const value = (field: TableGroupField, i: number) => fields.get(field)?.[i];
    for (let i = 0; i < n; i++) {
      if (deleted?.[i]) continue;
      for (const field of ['id', 'key', 'parent'] as const) {
        const v = value(field, i);
        if (v !== undefined && typeof v !== 'string') {
          throw new DrawError(
            'invalid-input',
            `Tables: the ${field} of the group ${handles[i]} is not a string`,
          );
        }
        if (v === undefined && !this.groups.has(handles[i])) {
          throw new DrawError(
            'invalid-input',
            `Tables: the new group ${handles[i]} needs its ${field}`,
          );
        }
      }
      for (const field of this.groupFlags) {
        const v = value(field as TableGroupField, i);
        if (v !== undefined && typeof v !== 'boolean') {
          throw new DrawError(
            'invalid-input',
            `Tables: the ${field} of the group ${handles[i]} is not a boolean`,
          );
        }
      }
    }
    const orders = new Map<string, Map<GroupHandle, string>>();
    const shown = new Set<GroupHandle>();
    const removed: GroupHandle[] = [];
    // The members of the groups given another parent, which go there with them
    const following: RowHandle[] = [];
    const followed: string[] = [];
    for (let i = 0; i < n; i++) {
      const group = handles[i];
      if (deleted?.[i]) {
        removed.push(group);
        continue;
      }
      const parent = value('parent', i) as string | undefined;
      const before = this.groups.tableOf(group);
      if (parent !== undefined && before !== undefined && parent !== before) {
        const id = this.groups.idOf(group) as string;
        for (const member of this.membersIn(before, group)) {
          following.push(member);
          followed.push(id);
        }
      }
      this.deletedGroups.delete(group);
      this.unkeepGroup(group);
      // The flags written, the others kept (none set for a new group)
      let flags = this.groups.flagsOf(group);
      for (const field of this.groupFlags) {
        const v = value(field as TableGroupField, i) as boolean | undefined;
        if (v === undefined) continue;
        const bit = this.groups.flagBitOf(field);
        flags = v ? flags | bit : flags & ~bit;
      }
      if (!this.groups.has(group)) {
        this.groups.set(group, {
          id: value('id', i) as string,
          order: value('key', i) as string,
          tableId: value('parent', i) as string,
          flags,
        });
        continue;
      }
      const memberStates = this.groups.memberStatesOf(group);
      const next = {
        id: this.groups.idOf(group) as string,
        // A new key goes in with the members in their new order
        order: this.groups.orderOf(group) as string,
        tableId:
          (value('parent', i) as string | undefined) ?? (this.groups.tableOf(group) as string),
        flags,
      };
      this.groups.set(group, next);
      if (this.groups.memberStatesOf(group) !== memberStates) shown.add(group);
      const order = value('key', i) as string | undefined;
      if (order !== undefined && order !== next.order) {
        let list = orders.get(next.tableId);
        if (!list) {
          list = new Map();
          orders.set(next.tableId, list);
        }
        list.set(group, order);
      }
    }
    if (shown.size > 0) this.refreshGroupStates(shown);
    // The members go to the table of their group, before the group is put in its new place there
    const drafts = new Map<string, TableChangeDraft>();
    if (following.length > 0) {
      this.applyPatch(
        { handles: Int32Array.from(following), fields: new Map([['parent', followed]]) },
        drafts,
      );
    }
    for (const [tableId, list] of orders) this.reorderGroups(tableId, list);
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
    this.revisionCount++;
    this.notifyWork();
    const rows = drafts.size > 0 ? { layers: finishChanges(drafts) } : NO_ROWS;
    return { rows, kept, emptied: false };
  }

  /**
   * Puts the members of groups in the order of new keys of the groups: the row
   * groups of the table are cut at the runs of the members and at the places they go to, and
   * the pieces are put in their new order by a version swapped in once its chunks are up (the
   * keys go in then; until then the order before is read and drawn). The rows are not written.
   * A reorder still waiting is made again with its keys and the new ones
   */
  private reorderGroups(tableId: string, orders: Map<GroupHandle, string>): void {
    const table = this.tables.get(tableId);
    // The keys of a reorder still waiting that are still the ones written (a key written since,
    // here or in another table, is the one that goes in)
    for (const version of this.versions.reorders(table)) {
      for (const [group, order] of version.orders ?? []) {
        if (!orders.has(group) && this.writtenOrders.get(group) === order) orders.set(group, order);
      }
    }
    // The cuts of each row group: the runs of the members, and where they go
    const { cuts, members } = table
      ? groupRunCuts(table, orders, this.groups)
      : { cuts: new Map<RowGroup, Set<number>>(), members: false };
    if (!table || !members) {
      // No member in the groups: the keys go in now (the deltas in their new order)
      for (const [group, order] of orders) {
        this.groups.setOrder(group, order);
        this.writtenOrders.delete(group);
      }
      for (const other of this.tables.values()) {
        if (other.delta.group) this.rebuildDelta(other, new Set(), []);
        other.touchItems();
      }
      return;
    }
    // The pieces
    const groups = [...cuts.keys()].sort(
      (a, b) => table.orderOf(a.handle) - table.orderOf(b.handle),
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
          pieces.push(this.sliceRows(group, points[k], points[k + 1], table.dims));
      }
    }
    for (const [group, order] of orders) this.writtenOrders.set(group, order);
    this.versions.startReorder(table, groups, pieces, orders);
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
        group.geometries?.holdsCacheNumbers(r) === true
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
      ringVertices: this.rings?.ringVertices ?? 1,
    });
    return data;
  }

  /**
   * The groups a row (of a group, of a delta, of a creation) names, of some groups:
   * the row groups around their rows (by their keys) and the deltas read once for all of them
   */
  private groupsNamed(of: Iterable<GroupHandle>): Set<GroupHandle> {
    const wanted = new Set(of);
    const named = new Set<GroupHandle>();
    if (wanted.size === 0) return named;
    const read = (handles: Int32Array): void => {
      for (const group of handles) if (group >= 0 && wanted.has(group)) named.add(group);
    };
    for (const table of this.tables.values()) {
      for (const g of rowGroupsHolding(table, wanted, this.groups))
        read(table.groupAt(g).data.groups);
      if (table.delta.group) read(table.delta.group.data.groups);
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
   * Whether a patch places a row elsewhere (another key, group or table, or another value of a
   * field declared to place it again, `relocatingFields`): it then goes to the delta rather than
   * being written in place
   */
  private placeChanged(
    place: RowPlace,
    i: number,
    fields: ReadonlyMap<RowField, readonly unknown[]>,
    groupHandles: number[] | undefined,
    tableIds: Array<string | undefined> | undefined,
  ): boolean {
    const data = place.group.data;
    const row = place.row;
    for (const [field, values] of fields) {
      const value = values[i];
      if (PLACE_FIELDS.has(field)) {
        if (value === undefined) continue;
        if (field === 'key') {
          if (value !== utf8String(data.keys, row)) return true;
        } else if (
          (groupHandles as number[])[i] !== data.groups[row] ||
          (tableIds as Array<string | undefined>)[i] !== place.table.tableId
        ) {
          return true;
        }
        continue;
      }
      const whole = this.blockWholes.get(field);
      if (whole !== undefined) {
        // A value the row block does not hold, or another value of a field that places a row
        // again
        if (value === undefined) continue;
        const column = data.wholes[whole] as RowBlockValues | null;
        if (!column) return true;
        if (this.relocating.has(field)) {
          if (column.values[column.indexes[row]] !== value) return true;
        } else if (!column.values.includes(value)) return true;
        continue;
      }
      if (this.relocating.has(field)) {
        if (rowValue(place.group, row, field.slice(PROPERTY_FIELD.length)) !== value) return true;
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
        : { id: this.ids.idOf(handle) ?? '', type: 'Point', geometry: null, key: '' };
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
        case 'key':
          if (value !== undefined) out.key = value as string;
          break;
        case 'parent':
          out.group = (groupHandles as number[])[i];
          break;
        case 'style':
          out.style = (value ?? {}) as Readonly<Record<string, unknown>>;
          break;
        case 'hidden':
          if (value !== undefined) out.hidden = value === true;
          break;
        case 'locked':
          if (value !== undefined) out.locked = value === true;
          break;
        default: {
          const key = field.slice(PROPERTY_FIELD.length);
          const properties = out.properties as Record<string, unknown>;
          if (value === undefined) delete properties[key];
          else properties[key] = value;
        }
      }
    }
    if (deleted?.[i]) out.deleted = true;
    else if (revived) out.deleted = false;
    return out;
  }

  /** The columns of a patch, as a write in place writes them */
  private patchColumns(fields: ReadonlyMap<RowField, readonly unknown[]>): PatchColumns {
    const properties: Array<readonly [string, readonly unknown[]]> = [];
    const flags: Array<readonly [number, readonly unknown[]]> = [];
    const wholes: Array<readonly [number, readonly unknown[]]> = [];
    for (const [field, values] of fields) {
      if (field.startsWith(PROPERTY_FIELD)) {
        properties.push([field.slice(PROPERTY_FIELD.length), values]);
        continue;
      }
      const bit = this.flagBits.get(field);
      if (bit !== undefined) {
        flags.push([bit, values]);
        continue;
      }
      const whole = this.blockWholes.get(field);
      if (whole !== undefined) wholes.push([whole, values]);
    }
    return { geometry: fields.get('geometry'), flags, wholes, properties };
  }

  /**
   * Whether the values of a row can be written in place: every value of a `whole` column a row
   * block keeps is one its row block holds
   */
  private fitsInPlace(place: RowPlace, fields: ReadonlyMap<RowField, readonly unknown[]>): boolean {
    for (const [field, values] of fields) {
      const whole = this.blockWholes.get(field);
      if (whole === undefined || values[0] === undefined) continue;
      const column = place.group.data.wholes[whole] as RowBlockValues | null;
      if (!column?.values.includes(values[0])) return false;
    }
    return true;
  }

  /**
   * Writes the values of a row in place
   *
   * @returns What was written, as the drawing is told (null when nothing changed)
   */
  protected writeInPlace(
    place: RowPlace,
    i: number,
    fields: ReadonlyMap<RowField, readonly unknown[]>,
    deleted: Uint8Array | undefined,
    styleNumbers: number[] | undefined,
    columns: PatchColumns = this.patchColumns(fields),
  ): InPlaceRowWrite | null {
    const { table, group, row } = place;
    const data = group.data;
    let what = 0;
    let shape: GeometryWrite = SAME_SHAPE;
    let keys: string[] | null = null;
    const geometry = columns.geometry?.[i];
    if (geometry !== undefined) {
      shape = writeRowGeometry(
        table,
        group,
        row,
        geometry as never,
        this.coordinates,
        this.rings,
        this.caches,
      );
      what |= ROW_WRITE_GEOMETRY;
    }
    if (styleNumbers) {
      const next = styleNumbers[i];
      const old = styleColumnOf(data).indexes[row];
      if (next !== old) {
        this.styles.retain(next);
        this.styles.release(old);
        styleColumnOf(data).indexes[row] = next;
        what |= ROW_WRITE_STYLE;
      }
    }
    // A value of a whole column a row block keeps is written as its index (a value the row block
    // does not hold puts the row in the delta: `placeChanged`, `fitsInPlace`)
    for (const [whole, values] of columns.wholes) {
      const value = values[i];
      if (value === undefined) continue;
      const column = data.wholes[whole] as RowBlockValues | null;
      const at = column ? column.values.indexOf(value) : -1;
      if (!column || at < 0 || column.indexes[row] === at) continue;
      column.indexes[row] = at;
      what |= ROW_WRITE_VALUES;
    }
    let flags = data.flags[row];
    for (const [bit, values] of columns.flags) {
      const value = values[i];
      if (value !== undefined) flags = value === true ? flags | bit : flags & ~bit;
    }
    if (deleted && deleted[i] !== 0) flags |= ROW_FLAG_DELETED;
    // A row deleted written not deleted is created again at its place
    else if (deleted) flags &= ~ROW_FLAG_DELETED;
    if (flags !== data.flags[row]) {
      if ((flags & ROW_FLAG_DELETED) !== (data.flags[row] & ROW_FLAG_DELETED)) table.touchItems();
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
      if (isRingKey(this.rings, group, row, key)) {
        // The ring of a row follows the attributes it is made from
        const ring = refreshRowShape(table, group, row, this.coordinates, this.rings, this.caches);
        shape = { sameShape: ring.sameTriangles, from: 0, to: ring.ring };
        what |= ROW_WRITE_GEOMETRY;
      }
    }
    if (what === 0) return null;
    return {
      group: group.handle,
      row,
      handle: data.handles[row],
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
    const table = version.table;
    const groups = version.groups ?? [];
    const replaced = new Set(version.replaces.map((group) => group.handle));
    const replacedGroups = new Set<RowGroup>(version.replaces);
    if (version.orders) {
      // The keys that are still the ones written go in (a key written since, in another table,
      // went in or waits there)
      for (const [group, order] of version.orders) {
        if (this.writtenOrders.get(group) !== order) continue;
        this.groups.setOrder(group, order);
        this.writtenOrders.delete(group);
      }
      for (const creation of this.creations) this.dropReading(creation);
    }
    // The rows of the version keep the write marks they have where they are read until now, and
    // its groups go in with the mark of now (rows were written since they were built)
    for (const group of groups) {
      group.mark = this.writeMarks.mark;
      const handles = group.data.handles;
      for (let r = 0; r < handles.length; r++) {
        if (this.findPlace(handles[r])) {
          group.marks[r] = (this.foundGroup as RowGroup).marks[this.foundRow];
        }
      }
    }
    table.replaceGroups(version.replaces, groups);
    for (const old of version.replaces) {
      this.rowGroups.delete(old.handle);
      this.groupsDue.delete(old.handle);
    }
    for (const group of groups) this.rowGroups.set(group.handle, { table, group });
    const leaving = new Map<RowTable, Set<RowHandle>>();
    const leave = (handle: RowHandle): void => {
      const serial = this.ids.deltaTable(handle);
      if (serial < 0) return;
      const delta = this.tableList[serial];
      let set = leaving.get(delta);
      if (!set) {
        set = new Set();
        leaving.set(delta, set);
      }
      set.add(handle);
    };
    // Whether the copy of a row in a delta goes, for a version that took the rows of the deltas
    // up to a mark (-1: none): it is not kept, and was not written since
    const takes = (handle: RowHandle, mark: number): boolean => {
      const serial = this.ids.deltaTable(handle);
      if (serial < 0) return false;
      const delta = this.tableList[serial].delta;
      const slot = this.ids.deltaSlot(handle);
      return !delta.isKept(slot) && (delta.group as RowGroup).marks[slot] <= mark;
    };
    const markOf = (handle: RowHandle): number =>
      version.stays.has(handle) ? -1 : version.deltaMark;
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
          // a group replaced keeps the mark of the version that put it there)
          const before = waiting.get(handle);
          const mark = before && replacedGroups.has(before.group) ? before.mark : markOf(handle);
          waiting.set(handle, { group, row: r, mark });
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
          if (takes(handle, copy.mark)) leave(handle);
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
        if (this.ids.mainGroup(handle) === group.handle && takes(handle, markOf(handle))) {
          leave(handle);
        }
      }
    }
    // The rows deleted the version left out: their copies in the deltas go too
    for (const handle of version.dropped) {
      if (takes(handle, markOf(handle))) leave(handle);
    }
    // A copy waiting in a group replaced waits in the version, or not any more
    const newGroups = new Set<RowGroup>(groups);
    for (const [handle, copy] of waiting) {
      if (replacedGroups.has(copy.group) && !newGroups.has(copy.group)) waiting.delete(handle);
    }
    for (const old of version.replaces) {
      for (let r = 0; r < old.data.length; r++)
        this.styles.release(styleColumnOf(old.data).indexes[r]);
    }
    for (const group of groups) {
      for (let r = 0; r < group.data.length; r++) this.writeState(group, r);
      group.stateVersion++;
    }
    for (const copy of handed) {
      this.writeState(copy.group, copy.row);
      copy.group.stateVersion++;
      this.rowGroups.get(copy.group.handle)?.table.touchItems();
    }
    for (const [delta, set] of leaving) this.rebuildDelta(delta, set, []);
    // The values written in place since the version started (a row whose values its new row block
    // does not hold goes to the delta)
    const writes = new Map<string, InPlaceRowWrite[]>();
    const moved = new Map<RowTable, DeltaInput[]>();
    for (const entry of version.log) {
      const place = this.placeOf(entry.handle);
      if (!place || place.group.delta || !groups.includes(place.group)) continue;
      const fields = new Map<RowField, unknown[]>();
      for (const [field, value] of entry.fields) fields.set(field as RowField, [value]);
      if (!this.fitsInPlace(place, fields)) {
        const deleted = entry.deleted ? Uint8Array.of(1) : undefined;
        const input = this.patchedInput(entry.handle, place, 0, fields, deleted, [
          place.group.data.groups[place.row],
        ]);
        let list = moved.get(place.table);
        if (!list) {
          list = [];
          moved.set(place.table, list);
        }
        list.push({ handle: entry.handle, input });
        this.writeMarks.stampGroup(place.group);
        continue;
      }
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
      let list = writes.get(place.table.tableId);
      if (!list) {
        list = [];
        writes.set(place.table.tableId, list);
      }
      list.push(write);
    }
    for (const [delta, list] of moved) {
      this.rebuildDelta(delta, new Set(), list);
      for (const { handle } of list) this.refreshCopies(handle);
    }
    if (version.orders) {
      // The rows of the deltas in the order of the new keys
      for (const other of this.tables.values()) {
        if (other.delta.group && !leaving.has(other)) {
          this.rebuildDelta(other, new Set(), []);
        }
      }
      for (const other of this.tables.values()) other.touchItems();
    }
    table.touchItems();
    this.revisionCount++;
    for (const [tableId, list] of writes) {
      for (const listener of this.writeListeners) listener(tableId, list);
    }
    this.touch(table.tableId, GroupVersions.boundsOf(version));
    // The rows left out are gone: the handles of the ones forgotten are freed, and the groups
    // deleted no row names any more are taken out
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
    // A version started before the dimensions of its table were raised has the ones of before:
    // its groups are due again
    for (const group of groups) {
      if (!hasDims(group.data, table.dims)) this.versions.markDue(group.handle);
    }
    return null;
  }

  /**
   * Makes the rows of the delta of a table again: its rows but the ones leaving it, and the rows
   * coming into it (stamped with the write mark of now; the rows that stay keep theirs). A row of
   * the delta written in place is built again with its values, so the new rows hold no values
   * written in place
   */
  protected rebuildDelta(
    table: RowTable,
    leaving: ReadonlySet<RowHandle>,
    coming: readonly DeltaInput[],
  ): void {
    const delta = table.delta;
    const old = delta.group;
    const sources: RowBlockData[] = [];
    /** The rows of the delta that stay as they are, in their order */
    const stay: number[] = [];
    /** The marks of the rows made again of their values */
    const marksOf = new Map<RowHandle, number>();
    const inputs: RowInput[] = [];
    const comingHandles = new Set(coming.map((entry) => entry.handle));
    const keysKept = old !== null && table.deltaKeysRevision === this.groups.revision;
    if (old) {
      sources.push(old.data);
      for (let r = 0; r < old.data.length; r++) {
        const handle = old.data.handles[r];
        if (leaving.has(handle) || comingHandles.has(handle)) continue;
        if (
          old.values?.has(r) ||
          old.geometries?.geometry(r) ||
          old.geometries?.holdsCacheNumbers(r)
        ) {
          marksOf.set(handle, old.marks[r]);
          inputs.push(rowInputOf(this.readContext, old, r));
        } else {
          if (!keysKept) marksOf.set(handle, old.marks[r]);
          stay.push(r);
        }
      }
    }
    for (const entry of coming) inputs.push(entry.input);
    const built = inputs.length > 0 ? this.buildRows(inputs, table.dims) : null;
    if (built) sources.push(built);
    const pairs = keysKept
      ? deltaRowsInOrder(old.data, stay, built, this.groups)
      : deltaRowsOf(old !== null, stay, built);
    const merged = mergeRowBlockData({
      sources,
      rows: pairs,
      groups: this.groups,
      sort: !keysKept,
      targetRows: UNBOUNDED,
      targetVertices: UNBOUNDED,
      dimensions: table.dims,
      ringVertices: this.rings?.ringVertices ?? 1,
    });
    const marks = this.writeMarks;
    const group =
      merged.length > 0 ? createRowGroup(delta.handle, merged[0], marks.mark, true) : null;
    const kept = new Uint8Array(group?.data.length ?? 0);
    if (group) {
      // The rows coming in under the mark a version started under stay for it
      const watched = coming.length > 0 && this.versions.watches(marks.mark);
      for (let r = 0; r < group.data.length; r++) {
        const handle = group.data.handles[r];
        // A row drawn over a row stays in the delta as long as it is drawn
        if (this.drawnOnlyRows.has(handle)) kept[r] = 1;
        // A row of the delta before, in the order of the rows when they are found in their order
        const mark =
          keysKept && pairs[r * 2] === 0 ? old.marks[pairs[r * 2 + 1]] : marksOf.get(handle);
        if (mark !== undefined) group.marks[r] = mark;
        else if (this.drawnOnlyRows.has(handle)) {
          // A row drawn over the rows is not a value written: it has the mark of now, and
          // stamps nothing (it is drawn in a frame that writes none too)
          group.marks[r] = marks.mark;
        } else {
          marks.stamp(group, r);
          if (watched) this.versions.rowChanged(handle, marks.mark);
        }
        this.styles.retain(styleColumnOf(group.data).indexes[r]);
      }
    }
    if (old) {
      for (let r = 0; r < old.data.length; r++) {
        const handle = old.data.handles[r];
        this.styles.release(styleColumnOf(old.data).indexes[r]);
        if (this.ids.deltaTable(handle) === table.serial) this.ids.setDelta(handle, -1, -1);
      }
      table.dropMoved(old);
    }
    if (group) {
      for (let r = 0; r < group.data.length; r++) {
        this.ids.setDelta(group.data.handles[r], table.serial, r);
      }
      for (let r = 0; r < group.data.length; r++) this.writeState(group, r);
    }
    const places = keysKept ? table.placesOfDelta() : null;
    delta.rebuild(group, kept);
    table.deltaKeysRevision = this.groups.revision;
    if (places) table.carryDeltaPlaces(places, pairs);
    table.touchItems();
    this.touch(table.tableId, unionBounds(old?.bounds ?? null, group?.bounds ?? null));
    // The copies the rows leaving the delta had in their groups are read again
    for (const handle of leaving) {
      if (this.ids.deltaTable(handle) < 0) this.refreshCopies(handle);
    }
    if (this.deltaListeners.size === 0) return;
    const change: DeltaRowsChange = { leaving, coming };
    for (const listener of this.deltaListeners) listener(table.tableId, change);
  }

  /**
   * Builds rows into one row group of coordinates of dimensions, numbered and with their handles
   * (null for no row)
   */
  private buildRows(inputs: readonly RowInput[], dims: CoordinateDimensions): RowBlockData | null {
    const builder = createRowBlockDataBuilder({
      columns: this.columns,
      groups: this.groups.keyList(),
      targetRows: UNBOUNDED,
      targetVertices: UNBOUNDED,
      dimensions: dims,
      coordinateSystem: this.coordinates,
      rings: this.rings ?? undefined,
      caches: this.caches,
    });
    for (const input of inputs) builder.addRow(input);
    const [data] = builder.finish();
    if (!data) return null;
    this.numberStyles(data);
    data.handles.set(this.ids.allocate(data.ids, data.idHashes));
    return data;
  }

  /**
   * Puts the caches of a row block taken in in the order of the caches of the tables, making the
   * ones it does not hold
   */
  private fitCaches(data: RowBlockData): void {
    const fitted = cacheColumnsIn(data.caches, this.caches, (cache) => {
      const group = createRowGroup(-1, data, this.writeMarks.mark);
      const rings = this.rings;
      return buildCacheColumns([cache], data.length, (r) => {
        const geometry = geometryAt(group, r);
        if (!geometry) return null;
        const read = groupRowRead(group, r);
        const ring =
          rings && geometry.reader.type === 'Point' && rings.draws(read.type)
            ? rings.ringOf(read)
            : null;
        return { read, ring };
      })[0];
    });
    if (fitted) data.caches = fitted;
  }

  /** Gives the styles of a group built in a Worker the numbers of the table of styles */
  private numberStyles(data: RowBlockData): void {
    const dictionary = styleColumnOf(data).dictionary;
    if (!dictionary) return;
    const numbers = new Uint32Array(utf8ColumnLength(dictionary));
    for (let i = 0; i < numbers.length; i++) {
      numbers[i] = this.styles.internBytes(
        dictionary.bytes,
        dictionary.offsets[i],
        dictionary.offsets[i + 1],
      );
    }
    const column = styleColumnOf(data);
    const indexes = column.indexes;
    for (let r = 0; r < data.length; r++) indexes[r] = numbers[indexes[r]];
    column.dictionary = null;
  }

  /** Takes in one row group: the handles, the numbers of its styles, the state of its rows */
  private adoptGroup(table: RowTable, data: RowBlockData): void {
    checkDims(data, table.dims);
    if (data.handles.some((handle) => handle < 0)) {
      data.handles.set(this.ids.allocate(data.ids, data.idHashes));
    }
    for (let r = 0; r < data.length; r++) {
      const handle = data.handles[r];
      if (!this.ids.has(handle))
        throw new DrawError('not-found', `Tables: the handle ${handle} is unknown`);
      if (this.ids.mainGroup(handle) >= 0 || this.ids.deltaTable(handle) >= 0) {
        throw new DrawError(
          'already-exists',
          `Tables: "${this.ids.idOf(handle)}" is already a row`,
        );
      }
    }
    // The styles of a group built in a Worker get the numbers of the table of styles
    this.numberStyles(data);
    const styles = styleColumnOf(data).indexes;
    for (let r = 0; r < data.length; r++) {
      if (!this.styles.has(styles[r])) {
        throw new DrawError(
          'not-found',
          `Tables: a row names the style ${styles[r]}, which is unknown`,
        );
      }
    }
    // A group whose rows are not in the order of their keys, or whose keys overlap the rows of
    // another group (one taken in, or built of rows written, since it was made), is not left
    // out: its rows go to the delta, read and drawn at their places at once, and into the row
    // groups with their next versions
    if (data.length > 0 && (!table.inKeyOrder(data) || table.overlaps(data))) {
      this.rowsToDelta(table, data);
      return;
    }
    const group = createRowGroup(this.nextGroup++, data, this.writeMarks.mark);
    table.insert(group);
    this.rowBoxes.mark(data.handles);
    // The rows that use each style are counted (a style no row uses is given again)
    for (let r = 0; r < data.length; r++) this.styles.retain(styles[r]);
    this.rowGroups.set(group.handle, { table, group });
    for (let r = 0; r < data.length; r++) {
      const handle = data.handles[r];
      this.ids.setMain(handle, group.handle, r);
      this.ids.rehome(handle, data.ids, r);
    }
    for (let r = 0; r < data.length; r++) this.writeState(group, r);
    this.revisionCount++;
  }

  /**
   * Reads the bits of the state of the rows declared from values once: the bits of each byte of
   * the flags of a row, those the flags of a group give its members, and the values of the
   * `whole` columns
   *
   * @throws `KasaneError` with the code `invalid-input` for a column that is not one of the kind
   * named, or bits that are not bits of the user besides those of the handles
   */
  private declareValueStates(declared: ValueStates): WholeStates[] {
    const among = USER_STATES & ~this.rowStates.mask;
    const rowFlags = (declared.rowFlags ?? []).map(({ column, states }) => {
      const flag = this.flagBits.get(column);
      if (flag === undefined) {
        throw new KasaneError('invalid-input', `Tables: "${column}" is not a flag column`);
      }
      checkStateBits(`the states of "${column}"`, states, among);
      return { flag, states };
    });
    for (let flags = 0; flags < 256; flags++) {
      let states = (flags & ROW_FLAG_DELETED) !== 0 ? STATE_DELETED : 0;
      for (const { flag, states: bits } of rowFlags) if ((flags & flag) !== 0) states |= bits;
      this.flagStates[flags] = states;
    }
    this.groups.setMemberFlags(
      (declared.groupFlags ?? []).map(({ column, states }) => {
        const flag = this.groups.flagBitOf(column);
        if (flag === 0) {
          throw new KasaneError(
            'invalid-input',
            `Tables: "${column}" is not a flag column of the groups`,
          );
        }
        checkStateBits(`the states of "${column}"`, states, among);
        return { flag, states };
      }),
    );
    return (declared.wholeValues ?? []).map(({ column, values, states }) => {
      const at = this.blockWholes.get(column);
      if (at === undefined) {
        throw new KasaneError(
          'invalid-input',
          `Tables: "${column}" is not a whole column each row block keeps`,
        );
      }
      checkStateBits(`the states of "${column}"`, states, among);
      return { at, values: new Set(values), states };
    });
  }

  /** Makes the copy of the state of a row again */
  private writeState(group: RowGroup, row: number): void {
    const state = this.rowStateOf(group, row);
    group.state[row] = state;
    group.gpuState[row] = this.stateByte(state);
    noteRowState(group, row);
  }

  rowStateOf(group: RowGroup, row: number): number {
    const data = group.data;
    const handle = data.handles[row];
    const flags = data.flags[row];
    let state = this.rowStates.of(handle) | this.flagStates[flags];
    const inGroup = data.groups[row];
    if (inGroup >= 0) state |= this.groups.memberStatesOf(inGroup);
    for (const { at, values, states } of this.wholeStates) {
      const column = data.wholes[at] as RowBlockValues | null;
      if (column && values.has(column.values[column.indexes[row]])) state |= states;
    }
    if (!group.delta && !group.pending) {
      // The copy of a row read elsewhere: in the delta, or in another group until it is in this
      if (this.ids.deltaTable(handle) >= 0) state |= STATE_DELTA;
      if (this.ids.mainGroup(handle) !== group.handle) state |= STATE_WAIT;
    }
    return state;
  }

  /** Makes the copies of the state of the row of a handle again (in its group and its delta) */
  private refreshCopies(handle: RowHandle): void {
    const placed = this.rowGroups.get(this.ids.mainGroup(handle));
    if (placed) {
      this.writeState(placed.group, this.ids.mainRow(handle));
      placed.group.stateVersion++;
      placed.table.touchItems();
    }
    const serial = this.ids.deltaTable(handle);
    const delta = serial >= 0 ? this.tableList[serial].delta.group : null;
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
      const serial = this.ids.deltaTable(handle);
      const delta = serial >= 0 ? this.tableList[serial].delta.group : null;
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
    keys: utf8ColumnFromStrings(inputs.map((input) => input.key)),
    groups: Int32Array.from(inputs, (input) => input.group ?? -1),
  };
}

/** The keys of one row of a source, as a source of one row */
function oneKey(keys: RowKeySource, row: number): RowKeySource {
  return {
    ids: utf8ColumnFromStrings([utf8String(keys.ids, row)]),
    keys: utf8ColumnFromStrings([utf8String(keys.keys, row)]),
    groups: Int32Array.of(keys.groups[row]),
  };
}

/**
 * The rows of a delta made again, two numbers each (the source and the row there): the rows that
 * stay of the delta before (source 0 when it has one), then the rows built
 */
function deltaRowsOf(hasOld: boolean, stay: readonly number[], built: RowBlockData | null) {
  const pairs = new Int32Array((stay.length + (built?.length ?? 0)) * 2);
  let at = 0;
  for (const r of stay) {
    pairs[at++] = 0;
    pairs[at++] = r;
  }
  const source = hasOld ? 1 : 0;
  for (let r = 0; r < (built?.length ?? 0); r++) {
    pairs[at++] = source;
    pairs[at++] = r;
  }
  return pairs;
}

/**
 * The rows of a delta made again in the order of the table, as {@link deltaRowsOf} gives them: the
 * rows that stay are in that order, so only the rows built are looked for among them
 */
function deltaRowsInOrder(
  old: RowBlockData,
  stay: readonly number[],
  built: RowBlockData | null,
  groups: GroupKeySource,
): Int32Array {
  const count = built?.length ?? 0;
  const pairs = new Int32Array((stay.length + count) * 2);
  const order = new Int32Array(count);
  for (let r = 0; r < count; r++) order[r] = r;
  if (built) order.sort((a, b) => compareRowKeys(built, a, built, b, groups));
  let at = 0;
  let next = 0;
  for (let k = 0; k < count; k++) {
    const row = order[k];
    // The first row that stays after the row built
    let lo = next;
    let hi = stay.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (compareRowKeys(old, stay[mid], built as RowBlockData, row, groups) < 0) lo = mid + 1;
      else hi = mid;
    }
    for (; next < lo; next++) {
      pairs[at++] = 0;
      pairs[at++] = stay[next];
    }
    pairs[at++] = 1;
    pairs[at++] = row;
  }
  for (; next < stay.length; next++) {
    pairs[at++] = 0;
    pairs[at++] = stay[next];
  }
  return pairs;
}

/** The union of two extents (null when both are) */
function unionBounds(a: BBox | null, b: BBox | null): BBox | null {
  if (!a) return b;
  if (!b) return a;
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
}

/** The draft of the change of a table */
function draftOf(changes: Map<string, TableChangeDraft>, tableId: string): TableChangeDraft {
  let draft = changes.get(tableId);
  if (!draft) {
    draft = {
      created: [],
      updated: [],
      deleted: [],
      fields: new Set(),
      styleKeys: new Set(),
    };
    changes.set(tableId, draft);
  }
  return draft;
}

/** The changes of the tables, as the writer returns them */
function finishChanges(changes: Map<string, TableChangeDraft>): Map<string, LayerRowsChange> {
  const out = new Map<string, LayerRowsChange>();
  for (const [tableId, draft] of changes) {
    out.set(tableId, {
      created: Int32Array.from(draft.created),
      updated: Int32Array.from(draft.updated),
      deleted: Int32Array.from(draft.deleted),
      fields: draft.fields,
      styleKeys: draft.styleKeys,
    });
  }
  return out;
}

/** The values of a `whole` column kept by each row block that give a row bits of its state */
interface WholeStates {
  /** The place of the column in `RowBlockData.wholes` */
  readonly at: number;
  readonly values: ReadonlySet<unknown>;
  readonly states: number;
}

/** The columns of a patch a write in place reads, taken from it once */
interface PatchColumns {
  readonly geometry: readonly unknown[] | undefined;
  /** The `flag` columns written: their bits and values */
  readonly flags: ReadonlyArray<readonly [number, readonly unknown[]]>;
  /** The `whole` columns whose values a row block keeps written: their places and values */
  readonly wholes: ReadonlyArray<readonly [number, readonly unknown[]]>;
  /** The attributes written: their keys and values */
  readonly properties: ReadonlyArray<readonly [string, readonly unknown[]]>;
}

/** The byte per row of the drawing side of tables whose user gives none */
const noStateByte = (): number => 0;

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
function checkShape(data: RowBlockData, layout: RowColumnLayout): void {
  const n = data.length;
  if (
    data.shapes.length !== layout.shapes.length ||
    data.wholes.length !== layout.wholes.length ||
    data.keyed.length !== layout.keyed.length
  ) {
    throw new DrawError(
      'invalid-input',
      'Tables: a row group holds other columns than the ones declared',
    );
  }
  const perRow: Array<[string, number]> = [
    ['handles', data.handles.length],
    ['ids', utf8ColumnLength(data.ids)],
    ['idHashes', data.idHashes.length],
    ...data.shapes.flatMap(
      (shape, k): Array<[string, number]> =>
        shape
          ? [
              [`shapes[${k}].types`, shape.types.length],
              [`shapes[${k}].offsets`, shape.offsets.length],
            ]
          : [],
    ),
    ...data.wholes.flatMap(
      (whole, k): Array<[string, number]> =>
        whole ? [[`wholes[${k}]`, whole.indexes.length]] : [],
    ),
    ['keys', utf8ColumnLength(data.keys)],
    ['groups', data.groups.length],
    ['flags', data.flags.length],
    ['rowBounds', data.rowBounds.length / 4],
    ...data.caches.map((cache): [string, number] => [
      `caches ${cache.name}`,
      cache.offsets.length - 1,
    ]),
  ];
  for (const [name, length] of perRow) {
    if (length !== n) {
      throw new DrawError('invalid-input', `Tables: ${name} has ${length} entries for ${n} rows`);
    }
  }
  for (const keyed of data.keyed) {
    for (const column of keyed?.columns ?? []) {
      if (column.length !== n)
        throw new DrawError('invalid-input', 'Tables: an attribute column has another length');
    }
  }
}

/** Whether every geometry column of a row group has coordinates of dimensions */
function hasDims(data: RowBlockData, dims: CoordinateDimensions): boolean {
  for (const shape of data.shapes) {
    for (const child of shape?.children ?? [])
      if ((child.dimensions ?? 'xy') !== dims) return false;
  }
  return true;
}

/**
 * Checks that the coordinates of a row group have the dimensions of its table
 *
 * @throws when a geometry column of the group has others
 */
function checkDims(data: RowBlockData, dims: CoordinateDimensions): void {
  for (const child of data.shapes.flatMap((shape) => shape?.children ?? [])) {
    const own = child.dimensions ?? 'xy';
    if (own !== dims) {
      throw new DrawError(
        'invalid-input',
        `Tables: a row group has coordinates of ${own}, its table ${dims}`,
      );
    }
  }
}
