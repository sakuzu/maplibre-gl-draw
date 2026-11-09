// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The writing side of the tables (`TablesWriter`)
 *
 * The tables write the rows and the groups given, and return what they wrote: the rows written by
 * table, whether the token of the write keeps what it deleted, and whether every row was taken
 * out. They tell nobody: what is told of a write, and to whom, is the business of the one that
 * holds the writer and calls it, which reads before a write what it needs to tell of it.
 */

import type { Utf8Column } from '@sakuzu/tabane';
import type { RestoreToken, RowsChange, RowValues } from '../shared/types/model.js';
import type { RowBlockData } from '../table/row-group-types.js';
import type { RowHandle } from './types.js';

/**
 * A field of a group a {@link TableGroupPatch} writes.
 */
export type TableGroupField = 'id' | 'name' | 'order' | 'layerId' | 'visible' | 'locked';

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
  readonly restoreToken?: RestoreToken;
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
  createRestoreToken(): RestoreToken;
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
}
