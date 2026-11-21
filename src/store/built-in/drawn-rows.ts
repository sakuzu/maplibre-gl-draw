// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The reader the drawing reads the rows of a built-in Store through
 *
 * The drawing draws the rows of the features from the pages of the tables of the document, without
 * making a feature of a row: the row groups of each layer in their order, the parts of the rows
 * written since (the delta of the layer), where each row is, the state of each row, and the rows
 * written in place. It reads them here, and nowhere else: this file is the one place of the drawing
 * that knows the tables are those of `@sakuzu/kasane`, so the drawing imports nothing of them.
 *
 * The reader is held by the tables of the Store in a field no other module can name
 * (`holdDrawnRows`, once, when the Store is made). A Store of the application that spreads a
 * built-in Store hands out the same tables, so the drawing finds the same reader through it
 * (`drawnRowsOf`); for tables of another Store it finds none, and draws the features as they are
 * read. Nothing here is shared between two Stores.
 *
 * The drawing also takes the work of the tables into its frames through the reader: the new rows
 * gathered into row groups of their own, the next versions of the row groups (`rebuild`), the row
 * groups taken in (`advanceQueuedBlocks`) and the versions swapped in (`swap`).
 *
 * @internal
 */

import {
  compareRowKeys,
  type DeltaPart,
  type DeltaRowsChange,
  type GroupVersion,
  type GroupVersionReceiver,
  geometryAt,
  type InPlaceRowWrite,
  listPages,
  type PageDictionary,
  type Pages,
  type PageValues,
  pageRowBox,
  ROW_WRITE_GEOMETRY,
  ROW_WRITE_STATE,
  ROW_WRITE_STYLE,
  ROW_WRITE_VALUES,
  type RowGroup,
  type RowGroupHandle,
  type RowTable,
  rowColumnLayoutOf,
  rowNumber,
  rowValue,
  type ShapeFormReader,
  STATE_DELETED,
  STATE_DELTA,
  STATE_WAIT,
  type TableWorkBudget,
} from '@sakuzu/kasane/render';
import type { FeatureStyle } from '../../shared/types/model.js';
import type { StoreDocument } from './document.js';
import { ROW_COLUMNS } from './row-columns.js';

export type {
  DeltaPart,
  DeltaRowsChange,
  GroupVersion,
  GroupVersionReceiver,
  InPlaceRowWrite,
  RowGroup,
  RowGroupHandle,
  RowTable,
  ShapeFormReader,
  TableWorkBudget,
};
export {
  geometryAt,
  pageRowBox,
  ROW_WRITE_GEOMETRY,
  ROW_WRITE_STATE,
  ROW_WRITE_STYLE,
  ROW_WRITE_VALUES,
  rowNumber,
  rowValue,
};

/** The place of the column of the type in the `value` columns of a page */
const TYPE_AT = rowColumnLayoutOf(ROW_COLUMNS).wholes.indexOf('type');
/** The place of the column of the style in the `value` columns of a page */
const STYLE_AT = rowColumnLayoutOf(ROW_COLUMNS).wholes.indexOf('style');
/** The place of the column of the geometry in the `shape` columns of a page */
const GEOMETRY_AT = rowColumnLayoutOf(ROW_COLUMNS).shapes.indexOf('geometry');

/**
 * The rebuilds a frame gives the tables: the new rows gathered wait two rebuilds without a new row
 * before they are built into groups of their own, and the third builds them
 */
const CREATION_REBUILDS = 3;

/**
 * The bits of the copy of the state of a row that leave it out of the rows drawn: hidden by its own
 * flag or by the flag of its group (the bits `document.ts` declares), deleted, or read elsewhere
 * (from the delta of its table, or from the row group it moved into)
 */
const NOT_DRAWN = (1 << 7) | (1 << 8) | STATE_DELETED | STATE_DELTA | STATE_WAIT;

/**
 * Rows of a layer read outside its row groups, drawn at one place among the rows of its row
 * groups: before the row `at` of the row group at the place `group` of the order of the layer (-1:
 * a layer without row groups), the rows `[from, to)` of `rows`, a part of the delta of the layer
 * or a group of its new rows not taken in yet
 *
 * @internal
 */
export interface DeltaInsert {
  readonly group: number;
  readonly at: number;
  readonly rows: RowGroup;
  readonly from: number;
  readonly to: number;
}

/**
 * What the drawing reads of the rows of a built-in Store
 *
 * @internal
 */
export interface DrawnRows {
  /** Changes with every change of the rows drawn of any layer */
  readonly revision: number;
  /** The rows of a layer (undefined for a layer that holds none) */
  table(layerId: string): RowTable | undefined;
  /** Whether a row is left out of the rows drawn (hidden, deleted, read elsewhere) */
  notDrawn(group: RowGroup, row: number): boolean;
  /** The type of a row */
  typeOf(group: RowGroup, row: number): string;
  /** The number of the style of a row (the rows of one style share it) */
  styleNumberOf(group: RowGroup, row: number): number;
  /** The style of a number (undefined for a number of no style) */
  styleOf(number: number): Readonly<FeatureStyle> | undefined;
  /** The times a number of style was given to another style (what is kept of it is read again) */
  styleEpochOf(number: number): number;
  /** Whether a row has a geometry */
  hasGeometry(group: RowGroup, row: number): boolean;
  /** The reference of a row of a group */
  refOf(group: RowGroup, row: number): number;
  /** The id of the feature of a reference (undefined for none) */
  idOf(ref: number): string | undefined;
  /** The reference of the row of the id of a feature (undefined for none) */
  refOfId(id: string): number | undefined;
  /** The id of the group of features a row is in (undefined for a row in no group) */
  groupIdOf(group: RowGroup, row: number): string | undefined;
  /** The references of the rows of a group of features in a layer */
  membersOf(layerId: string, groupId: string): readonly number[];
  /** The row group and the row a reference is read from (undefined for none) */
  placeOf(ref: number): { readonly group: RowGroup; readonly row: number } | undefined;
  /** The row group of a handle (undefined for none) */
  groupOf(handle: RowGroupHandle): RowGroup | undefined;
  /**
   * The groups of the rows of a layer read outside its row groups: the parts of its delta, and
   * its new rows not taken in yet into row groups of their own (drawn until they are)
   */
  extraGroups(table: RowTable): RowGroup[];
  /**
   * The rows of a layer read outside its row groups (`extraGroups`) at their places among its row
   * groups, in the order they are drawn
   */
  deltaInserts(table: RowTable): DeltaInsert[];
  /**
   * Gives the work of the tables a frame: the new rows gathered into groups of their own, the next
   * versions of the row groups, the row groups taken in
   *
   * @returns Whether work is left for later frames
   */
  advance(budget: TableWorkBudget): boolean;
  /** Swaps in the next versions whose drawing is ready (the pass before the main one of a frame) */
  swap(): void;
  /** Whether the tables have work left */
  readonly hasPendingWork: boolean;
  /** Makes the next versions of row groups wait until the drawing has drawn them */
  attachReceiver(receiver: GroupVersionReceiver): () => void;
  /** The next versions of the row groups of a layer built and waiting */
  builtVersions(layerId: string): GroupVersion[];
  /** Calls `listener` with the rows of a layer written in place */
  onRowsWritten(
    listener: (layerId: string, writes: readonly InPlaceRowWrite[]) => void,
  ): () => void;
  /** Calls `listener` when the parts of the delta of a layer changed */
  onDeltaChanged(listener: (layerId: string, change: DeltaRowsChange) => void): () => void;
  /** Calls `listener` when work starts waiting */
  onPendingWork(listener: () => void): () => void;
  /** Puts rows of row groups into the delta of their layer (they could not be drawn in place) */
  toDelta(refs: readonly number[]): void;
}

/** The field of the tables of a built-in Store that holds the reader of the drawing */
const DRAWN_ROWS = Symbol('drawn rows');

/** The reader of the drawing over the tables of a document */
function drawnRowsOfDocument(document: StoreDocument): DrawnRows {
  const pages = listPages(document.rows) as Pages<FeatureStyle>;
  return {
    get revision() {
      return pages.revision;
    },
    table: (layerId) => pages.rowTable(layerId),
    notDrawn: (group, row) => (group.state[row] & NOT_DRAWN) !== 0,
    typeOf: (group, row) => {
      const column = group.data.wholes[TYPE_AT] as PageValues | null;
      return column ? (column.values[column.indexes[row]] as string) : '';
    },
    styleNumberOf: (group, row) => {
      const column = group.data.wholes[STYLE_AT] as PageDictionary | null;
      return column ? column.indexes[row] : -1;
    },
    styleOf: (number) => (number < 0 ? undefined : pages.styles.get(number)),
    styleEpochOf: (number) => (number < 0 ? 0 : pages.styles.epochOf(number)),
    hasGeometry: (group, row) => {
      const shapes = group.data.shapes[GEOMETRY_AT];
      if (shapes && shapes.types[row] >= 0) return true;
      return group.geometries?.geometry(row) !== undefined;
    },
    refOf: (group, row) => group.data.rows[row],
    idOf: (ref) => pages.ids.idOf(ref),
    refOfId: (id) => document.rows.getRowRef(id),
    groupIdOf: (group, row) => {
      const ref = group.data.groups[row];
      return ref >= 0 ? pages.groups.idOf(ref) : undefined;
    },
    membersOf: (layerId, groupId) => {
      const ref = document.rows.getGroupRef(groupId);
      return ref === undefined ? [] : pages.membersIn(layerId, ref);
    },
    placeOf: (ref) => {
      const place = pages.placeOf(ref);
      return place ? { group: place.group, row: place.row } : undefined;
    },
    groupOf: (handle) => pages.rowGroup(handle)?.group,
    extraGroups: (table) => [...pendingGroupsOf(table), ...table.delta.parts.map((p) => p.group)],
    deltaInserts: (table) => deltaInsertsOf(table, pages),
    advance: (budget) => {
      // The new rows gathered wait a few rebuilds for more rows to come before they are built into
      // groups of their own, and the new rows of a layer wait for the order of its groups to be
      // swapped in: a frame of the drawing gives them those rebuilds and swaps, so the rows written
      // before a frame are built in it (in the Worker of the Store when it has one)
      for (let i = 0; i < CREATION_REBUILDS && pages.hasPendingWork; i++) {
        pages.rebuild(budget);
        pages.swap();
      }
      if (pages.hasQueuedBlocks) pages.advanceQueuedBlocks(budget);
      return pages.hasPendingWork;
    },
    swap: () => pages.swap(),
    get hasPendingWork() {
      return pages.hasPendingWork;
    },
    attachReceiver: (receiver) => pages.attachReceiver(receiver),
    builtVersions: (layerId) => pages.builtVersions(layerId),
    onRowsWritten: (listener) => pages.onRowsWritten(listener),
    onDeltaChanged: (listener) => pages.onDeltaChanged(listener),
    onPendingWork: (listener) => pages.onPendingWork(listener),
    toDelta: (refs) => pages.toDelta(refs),
  };
}

/**
 * The groups of the new rows of a table not taken in yet into row groups of their own, built to be
 * read: the tables keep them for a few frames while rows keep coming, and draw them meanwhile from
 * here (each is a run of keys between two row groups)
 *
 * The tables hand them to their order and their searches only (`RowTable.setPendingSource`); the
 * drawing reads them from there, the one place that names it.
 */
function pendingGroupsOf(table: RowTable): readonly RowGroup[] {
  const source = (table as unknown as { pendingSource?: (() => readonly RowGroup[]) | null })
    .pendingSource;
  return source ? source().filter((group) => group.data.length > 0) : [];
}

/**
 * The rows of a table read outside its row groups at their places among its row groups: the rows
 * of its new rows not taken in yet, then of every part of its delta, the oldest first, merged in
 * the order of their keys (each holds its rows in that order), the rows gone of a part left out,
 * the rows that follow each other at one place of one source in one insert
 */
function deltaInsertsOf(table: RowTable, pages: Pages<FeatureStyle>): DeltaInsert[] {
  const pending = pendingGroupsOf(table);
  const parts = table.delta.parts;
  const out: DeltaInsert[] = [];
  if (parts.length === 0 && pending.length === 0) return out;
  const groups: RowGroup[] = [...pending, ...parts.map((part) => part.group)];
  const gone: Array<Uint8Array | null> = [...pending.map(() => null), ...parts.map((p) => p.gone)];
  // A run of new rows is between two row groups: the place of its first row is the place of all
  const places = [
    ...pending.map((group) => {
      const place = table.positionOfKey(group.data, 0);
      const n = group.data.length;
      return place
        ? {
            groups: new Int32Array(n).fill(table.orderOf(place.group)),
            cuts: new Int32Array(n).fill((place.slot + 1) >> 1),
          }
        : { groups: new Int32Array(n).fill(-1), cuts: new Int32Array(n) };
    }),
    ...parts.map((part) => table.partPlaces(part)),
  ];
  const at = new Int32Array(groups.length);
  /** Passes the rows gone of a part */
  const pass = (s: number): void => {
    const marks = gone[s];
    if (!marks) return;
    const n = groups[s].data.length;
    while (at[s] < n && marks[at[s]] === 1) at[s]++;
  };
  for (let s = 0; s < groups.length; s++) pass(s);
  for (;;) {
    // The source whose next row comes first (the one before first at the same key)
    let next = -1;
    for (let s = 0; s < groups.length; s++) {
      if (at[s] >= groups[s].data.length) continue;
      if (next < 0) {
        next = s;
        continue;
      }
      const order = compareRowKeys(
        groups[s].data,
        at[s],
        groups[next].data,
        at[next],
        pages.groups,
      );
      if (order < 0) next = s;
    }
    if (next < 0) return out;
    const rows = groups[next];
    const row = at[next];
    const group = places[next].groups[row];
    const cut = places[next].cuts[row];
    const last = out[out.length - 1];
    if (last && last.rows === rows && last.to === row && last.group === group && last.at === cut) {
      out[out.length - 1] = { ...last, to: row + 1 };
    } else {
      out.push({ group, at: cut, rows, from: row, to: row + 1 });
    }
    at[next]++;
    pass(next);
  }
}

/**
 * Gives the tables of a built-in Store the reader of the drawing, once, when it is made
 *
 * The field is not enumerable, so the tables read, copy and serialize as before.
 *
 * @internal
 */
export function holdDrawnRows(tables: object, document: StoreDocument): void {
  // Made when the drawing first asks: a Store no instance draws makes none
  let reader: DrawnRows | null = null;
  Object.defineProperty(tables, DRAWN_ROWS, {
    get: () => {
      reader ??= drawnRowsOfDocument(document);
      return reader;
    },
  });
}

/**
 * The reader of the drawing the tables of a Store hold (undefined for tables that are not those of
 * a built-in Store)
 *
 * @internal
 */
export function drawnRowsOf(tables: unknown): DrawnRows | undefined {
  if (typeof tables !== 'object' || tables === null) return undefined;
  return (tables as { [DRAWN_ROWS]?: DrawnRows })[DRAWN_ROWS];
}
