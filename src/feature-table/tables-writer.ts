// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The writing side of the tables (`TablesWriter`), and what lets go of what a write deleted
 * (`Tables`)
 *
 * The tables write the rows and the groups given, and return what they wrote: the rows written by
 * table, whether the token of the write keeps what it deleted, and whether every row was taken
 * out. They tell nobody: what is told of a write, and to whom, is the business of the one that
 * holds the writer and calls it, which reads before a write what it needs to tell of it.
 *
 * Every row a write writes, and the row block it is in, is stamped with the write mark given last
 * (`setWriteMark` of the drawing side, `write-marks.ts`): the one that holds the tables gives the
 * marks, and the writer stamps them in its one place that writes the values of rows.
 *
 * A token that keeps the rows and the groups a write deletes is a number the writer makes
 * (`createRestoreToken`). The tables keep what it keeps for as long as it is not let go of
 * (`Tables.release`), with no limit of number or bytes: when to let go is the caller's.
 */

import type { Utf8Column } from '@sakuzu/tabane';
import type { RowBlockData } from '../table/row-group-types.js';
import type { RowField, RowValues } from './row-values.js';
import type { RowHandle } from './types.js';

/**
 * The rows of one table a write created, updated or deleted, by handle
 */
export interface TableRowsChange {
  /** The rows created */
  readonly created: Int32Array;
  /** The rows updated (a row that came from another table included) */
  readonly updated: Int32Array;
  /** The rows deleted */
  readonly deleted: Int32Array;
  /** The fields written */
  readonly fields: ReadonlySet<RowField>;
  /**
   * The keys that changed of the objects the `whole` column kept by the tables holds (declared
   * `'tables'`)
   */
  readonly styleKeys: ReadonlySet<string>;
}

/**
 * The rows a write wrote, by table
 */
export interface RowsChange {
  /** The rows of each table */
  readonly layers: ReadonlyMap<string, TableRowsChange>;
}

/**
 * A field of a group a {@link TableGroupPatch} writes: a fixed field of every group (its `id`,
 * its `parent`, the table it is in, and the `key` of its order among the items there), or a group
 * column declared (`groupColumns`; `hidden` and `locked` for the groups of the library). The
 * `name` of a group is kept by the user of the tables, not by them: the writer of the library
 * takes it out of the values it writes to the tables.
 */
export type TableGroupField = 'id' | 'name' | 'parent' | 'key' | 'hidden' | 'locked';

/**
 * Values written to groups of rows of the tables: the groups by their handles (the handles rows
 * name in their row blocks, `GroupEntry.handle`).
 */
export interface TableGroupPatch {
  /** The groups written */
  readonly handles: Int32Array;
  /** The values of each field written, one per group */
  readonly fields: ReadonlyMap<TableGroupField, readonly unknown[]>;
  /** Non-zero for a group deleted */
  readonly deleted?: Uint8Array;
}

/**
 * The options of a write of the tables ({@link TablesWriter.apply},
 * {@link TablesWriter.applyGroups})
 *
 * @internal
 */
export interface TablesWriteOptions {
  /**
   * What keeps the rows and the groups the write deletes (`TablesWriter.createRestoreToken`):
   * they stay as they were until it is let go of (`Tables.release`), so that writing them not
   * deleted puts them back where they were. Rows deleted without one go with the next versions of
   * their row blocks
   */
  readonly restoreToken?: number;
}

/**
 * What a write of the tables did
 *
 * @internal
 */
export interface TablesWrite {
  /** The rows written, by table (none for a write of groups, or a write that took them out) */
  readonly rows: RowsChange;
  /** Whether the token of the write keeps a row or a group the write deleted */
  readonly kept: boolean;
  /** Whether the write took every row out of the tables (`TablesWriter.clear`) */
  readonly emptied: boolean;
}

/**
 * The writing side of the tables: kept and called by the one that holds the tables only.
 *
 * @internal
 */
export interface TablesWriter {
  /**
   * The handle of the row of an id, deleted rows included (with `deleted`), until the id is
   * forgotten (undefined for an id never seen, or forgotten)
   */
  lookup(id: string): { readonly handle: RowHandle; readonly deleted: boolean } | undefined;
  /** A new token to keep the rows and groups a write deletes (`TablesWriteOptions.restoreToken`) */
  createRestoreToken(): number;
  /**
   * Forgets the ids of deleted rows that nothing keeps any more: they leave the table of the ids
   * (an id seen again is a new row), and their handles are given again once their rows are gone.
   * A row that is not deleted, or is kept, is left as it is
   */
  forget(handles: Int32Array): void;
  /**
   * The handle of the row of each id, given to the ids not seen yet.
   *
   * @param hashes - The hashes of the ids (`RowBlock.idHashes`; computed when omitted)
   */
  allocateHandles(ids: Utf8Column, hashes?: Uint32Array): Int32Array;
  /** Adds row blocks to a table at once, without copying their columns: the rows added */
  addRowBlocks(tableId: string, rowBlocks: readonly RowBlockData[]): TablesWrite;
  /** Writes values of rows: the rows written, and whether the token keeps the rows deleted */
  apply(values: RowValues, options?: TablesWriteOptions): TablesWrite;
  /** Writes values of groups: whether the token keeps the groups deleted */
  applyGroups(patch: TableGroupPatch, options?: TablesWriteOptions): TablesWrite;
  /** Takes every row out of the tables (`emptied`) */
  clear(): TablesWrite;
  /**
   * Sets the bits under a mask of the state of handles (`rowStateBits`; negative handles left
   * out): the copies of the state of their rows are made again. The state version of their row
   * blocks goes up, and the write mark does not: a state is not a value
   *
   * @throws `KasaneError` with the code `invalid-input` when the mask holds a bit that is not one
   * of a handle
   */
  setRowStates(handles: Int32Array, mask: number, bits: number): void;
  /**
   * Sets the bits under a mask of the state of groups: the members of the groups take them, and
   * the copies of the state of their rows are made again. The state version of their row blocks
   * goes up, and the write mark does not. A group deleted takes its bits with it
   *
   * @throws `KasaneError` with the code `invalid-input` when the mask holds a bit of a handle or
   * of the tables, `not-found` for a handle that names no group
   */
  setGroupStates(groups: Int32Array, mask: number, bits: number): void;
}

/**
 * The reading side of the tables, as far as it is declared on its own yet: what lets go of a
 * token
 *
 * @internal
 */
export interface Tables {
  /**
   * Lets go of the rows and the groups a token keeps (`TablesWriteOptions.restoreToken`): they go
   * with the next versions of their row blocks, and the deleted rows that nothing keeps any more
   * are told (`onRelease`), so that their ids may be forgotten. A token let go of, or never used,
   * keeps nothing
   */
  release(token: number): void;
}
