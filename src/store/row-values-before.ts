// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The values rows had before the writes of one transaction, from the values each write read
 *
 * Each write of rows reads the values its rows have for the fields it writes before it writes
 * them. The values before of the transaction are those of the first write of each row and field:
 * a row and a field no write read keep the value they had, which is read once the transaction
 * ends (nothing wrote it, or what wrote it read nothing, and tells its value otherwise).
 */

import type { RowField } from '../api/tables.js';
import type { RowValues } from './types.js';

/**
 * Where the values of the rows and fields no write read are read from, at the end of the
 * transaction
 *
 * @internal
 */
export interface UnreadValues {
  /** The values of a field of rows before the transaction, one per row */
  field(handles: Int32Array, field: RowField): readonly unknown[];
  /** Whether rows were deleted before the transaction (non-zero for a deleted row), one per row */
  deleted(handles: Int32Array): Uint8Array;
}

/** The values of one field of the rows, with which of them a write read */
interface Column<T> {
  readonly values: T[];
  readonly read: boolean[];
}

/**
 * The values the rows had before the writes of a transaction, each row once, from the values the
 * writes read in their order (the first read of a row and a field is the value before); one write
 * is given as it is
 *
 * @param parts The values each write read, in the order of the writes
 * @param unread Where a field of a row that no write read is read from
 * @returns The values before (undefined when no write read any)
 * @internal
 */
export function combineValuesBefore(
  parts: readonly RowValues[],
  unread: UnreadValues,
): RowValues | undefined {
  if (parts.length === 0) return undefined;
  if (parts.length === 1) return parts[0];
  const index = new Map<number, number>();
  const handles: number[] = [];
  const fields = new Map<RowField, Column<unknown>>();
  let deleted: Column<number> | null = null;
  const take = <T>(column: Column<T>, at: number, value: T): void => {
    if (column.read[at]) return;
    column.read[at] = true;
    column.values[at] = value;
  };
  for (const part of parts) {
    const rows = Array.from(part.handles, (handle) => {
      let at = index.get(handle);
      if (at === undefined) {
        at = handles.length;
        index.set(handle, at);
        handles.push(handle);
      }
      return at;
    });
    for (const [field, values] of part.fields) {
      let column = fields.get(field);
      if (!column) {
        column = { values: [], read: [] };
        fields.set(field, column);
      }
      for (let i = 0; i < rows.length; i++) take(column, rows[i], values[i]);
    }
    if (part.deleted) {
      deleted ??= { values: [], read: [] };
      for (let i = 0; i < rows.length; i++) take(deleted, rows[i], part.deleted[i]);
    }
  }
  const n = handles.length;
  const all = Int32Array.from(handles);
  /** The rows of a column no write read, by their places */
  const unreadOf = (column: Column<unknown>): number[] => {
    const out: number[] = [];
    for (let at = 0; at < n; at++) if (!column.read[at]) out.push(at);
    return out;
  };
  const out = new Map<RowField, unknown[]>();
  for (const [field, column] of fields) {
    const missing = unreadOf(column);
    if (missing.length > 0) {
      const values = unread.field(
        Int32Array.from(missing, (at) => all[at]),
        field,
      );
      missing.forEach((at, k) => {
        column.values[at] = values[k];
      });
    }
    column.values.length = n;
    out.set(field, column.values);
  }
  let deletedOut: Uint8Array | undefined;
  if (deleted) {
    const missing = unreadOf(deleted);
    if (missing.length > 0) {
      const values = unread.deleted(Int32Array.from(missing, (at) => all[at]));
      missing.forEach((at, k) => {
        (deleted as Column<number>).values[at] = values[k];
      });
    }
    deletedOut = Uint8Array.from({ length: n }, (_, at) =>
      ((deleted as Column<number>).values[at] ?? 0) !== 0 ? 1 : 0,
    );
  }
  return { handles: all, fields: out, ...(deletedOut && { deleted: deletedOut }) };
}
