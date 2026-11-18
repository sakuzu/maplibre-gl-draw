// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The deleted rows the built-in Store keeps for the listeners that asked for them
 * (`keepDeletedRows`), and the tokens that keep them (`DeletedRowsToken`)
 *
 * The rows a transaction deletes while a listener keeps them are kept in the tables with one
 * token of the tables, which every write of the transaction gives. When the change is told, each
 * listener that keeps them is given a token of its own, and the tokens share one entry that keeps
 * the rows: it counts the tokens that hold it, and lets go of the rows in the tables once every
 * token is let go of. Nothing is copied per listener.
 *
 * Each deleted row kept is marked with the token of the tables that keeps it, as the tables keep
 * it: a row brought back leaves its token, and the marks of a token let go of are taken off. A
 * deleted row without a mark is not there for the Store: its id may be taken again, it is not
 * read, and it is not brought back.
 *
 * When every token of an entry is let go of, the ids of the rows the writes gave the token of the
 * tables are forgotten (see `changes.ts`): the tables leave the rows another token keeps, and
 * those that are not deleted. So a new row, or a page, takes the id of a row kept once it is let
 * go of, with a new reference.
 *
 * @internal
 */

import type { DeletedRowsToken, RowRef } from './types.js';

/**
 * What keeps the rows one change deleted: the token of the tables, the rows, the rows the writes
 * of its transaction gave the token (whose ids are forgotten when it is let go of), and the number
 * of the tokens given for it that are not let go of
 *
 * @internal
 */
export interface KeptEntry {
  readonly tablesToken: number;
  readonly rows: readonly Int32Array[];
  readonly written: readonly Int32Array[];
  holders: number;
}

/**
 * Lets go of a token of the tables, and forgets the ids of the rows the writes gave it that
 * nothing keeps any more (the tables leave those another token keeps, and those not deleted)
 *
 * @internal
 */
export type ReleaseTablesToken = (tablesToken: number, written: readonly Int32Array[]) => void;

/**
 * The deleted rows kept, and the tokens given
 *
 * @internal
 */
export interface KeptRows {
  /** The token of the tables that keeps each deleted row kept, by the reference of the row */
  readonly keptBy: Map<RowRef, number>;
  /** The entry each token given holds, by the token */
  readonly tokens: Map<number, KeptEntry>;
  /** The number the next token is given */
  nextToken: number;
}

/**
 * No deleted row kept, and no token given
 *
 * @internal
 */
export function createKeptRows(): KeptRows {
  return { keptBy: new Map(), tokens: new Map(), nextToken: 1 };
}

/**
 * Whether a deleted row is kept
 *
 * @internal
 */
export function isKept(kept: KeptRows, row: RowRef): boolean {
  return kept.keptBy.has(row);
}

/**
 * Marks what a write of rows did to the rows it kept: a row written not deleted is not kept any
 * more, and a row deleted is kept by the token of the tables the write gave (when it gave one)
 *
 * @internal
 */
export function markDeletion(
  kept: KeptRows,
  rows: Int32Array,
  deleted: Uint8Array,
  tablesToken: number | undefined,
): void {
  for (let i = 0; i < rows.length; i++) {
    if (deleted[i] === 0) kept.keptBy.delete(rows[i]);
    else if (tablesToken !== undefined) kept.keptBy.set(rows[i], tablesToken);
  }
}

/** Takes the marks of a token of the tables off rows (those another token keeps are left) */
function unmark(kept: KeptRows, tablesToken: number, rows: readonly Int32Array[]): void {
  for (const list of rows) {
    for (let i = 0; i < list.length; i++) {
      if (kept.keptBy.get(list[i]) === tablesToken) kept.keptBy.delete(list[i]);
    }
  }
}

/**
 * Settles what a token of the tables keeps when the change of its transaction is told: the rows
 * the change lists as deleted are kept for the listeners given a token, one token each, and
 * nothing else is (a row the transaction created and deleted again is not listed). Without a row
 * listed or a listener, the token of the tables is let go of.
 *
 * @param written - The rows the writes of the transaction gave the token of the tables
 * @param deleted - The rows the change lists as deleted
 * @param holders - The number of listeners given a token
 * @param release - Lets go of a token of the tables (the ids of the rows the transaction deleted
 *   are forgotten when its change has been told, see `changes.ts`)
 * @returns The tokens, one per listener (none when nothing is kept)
 * @internal
 */
export function settleKept(
  kept: KeptRows,
  tablesToken: number,
  written: readonly Int32Array[],
  deleted: readonly Int32Array[],
  holders: number,
  release: (tablesToken: number) => void,
): DeletedRowsToken[] {
  unmark(kept, tablesToken, written);
  if (deleted.length === 0 || holders === 0) {
    release(tablesToken);
    return [];
  }
  for (const list of deleted) {
    for (let i = 0; i < list.length; i++) kept.keptBy.set(list[i], tablesToken);
  }
  const entry: KeptEntry = { tablesToken, rows: deleted, written, holders };
  const tokens: DeletedRowsToken[] = [];
  for (let i = 0; i < holders; i++) {
    const token = kept.nextToken as DeletedRowsToken;
    kept.nextToken += 1;
    kept.tokens.set(token, entry);
    tokens.push(token);
  }
  return tokens;
}

/**
 * Lets go of a token (see `Store.releaseDeletedRows`): once every token of its entry is let go
 * of, the rows go from the tables and are not kept any more, and their ids are forgotten. A token
 * let go of, or one never given, keeps nothing
 *
 * @internal
 */
export function releaseToken(kept: KeptRows, token: unknown, release: ReleaseTablesToken): void {
  if (typeof token !== 'number') return;
  const entry = kept.tokens.get(token);
  if (!entry) return;
  kept.tokens.delete(token);
  entry.holders -= 1;
  if (entry.holders > 0) return;
  unmark(kept, entry.tablesToken, entry.rows);
  release(entry.tablesToken, entry.written);
}

/**
 * Forgets every row kept and every token given: the tables took every row out (`clear`)
 *
 * @returns The rows the writes gave the tokens of the tables of the entries (whose ids the tables
 *   still know)
 * @internal
 */
export function forgetKept(kept: KeptRows): Int32Array[] {
  const written: Int32Array[] = [];
  for (const entry of new Set(kept.tokens.values())) {
    for (const rows of entry.written) written.push(rows);
  }
  kept.keptBy.clear();
  kept.tokens.clear();
  return written;
}
