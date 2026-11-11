// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The values of rows (`RowValues`), the columns the user of the tables names (`TableColumns`),
 * and the check of the names of the fields of values against those columns
 *
 * A field of the values of rows is a fixed field of every row (its place) or a column the user
 * declared: a `shape`, `flag` or `whole` column by its name, a key of a `keyed` column as
 * `<column>:<key>`. `createRowValues` checks the shape of values only; the writer checks their
 * names against the columns declared (`checkRowFields`).
 */

import type { TabaneColumnKind } from '@sakuzu/tabane';
import { KasaneError } from '../table/kasane-error.js';

/**
 * A field of the values of rows: a fixed field of every row, or a column declared (a key of a
 * `keyed` column as `<column>:<key>`)
 */
export type RowField = string;

/**
 * The values of a field, one per row of {@link RowValues} (for a key of a `keyed` column,
 * `undefined` takes the key off the row)
 */
export type RowFieldValues = readonly unknown[];

/**
 * Values of rows: the rows by their handles, and the values of fields, one per row. Read from
 * the rows, they are the values the rows have; written to them, they put the values there.
 */
export interface RowValues {
  /** The rows */
  readonly handles: Int32Array;
  /** The values of each field, one per row */
  readonly fields: ReadonlyMap<RowField, RowFieldValues>;
  /**
   * Non-zero for a row deleted, zero for a row not deleted (a row deleted and kept,
   * `RestoreToken`, written not deleted comes back at its place, as it was); absent when the
   * deletion is not read or written
   */
  readonly deleted?: Uint8Array;
}

/**
 * Where the values of a `whole` column are kept: in one dictionary for all the tables
 * (`'tables'`), or in one per row block (`'rowBlock'`)
 */
export type WholeDictionary = 'tables' | 'rowBlock';

/**
 * A column of the rows, as the user of the tables declares it: one of the four kinds of Tabane,
 * and for a `whole` column, where its values are kept (`'rowBlock'` when only the kind is given)
 */
export type ColumnDeclaration =
  | TabaneColumnKind
  | { readonly kind: 'whole'; readonly dictionary: WholeDictionary };

/**
 * The columns of the rows of all the tables, by their names: declared once, so a row that moves
 * to another table keeps its columns
 */
export type TableColumns = Readonly<Record<string, ColumnDeclaration>>;

/**
 * The fixed fields of a row: its place (not a column, so not declared)
 *
 * @internal
 */
export const PLACE_FIELDS: readonly RowField[] = Object.freeze([
  'layerId',
  'groupId',
  'order',
  'member',
]);

/**
 * The columns declared, read once: the names of the fields of the values of rows they allow
 *
 * @internal
 */
export class RowFields {
  /** The fields of a name: the fixed fields, and the columns other than `keyed` ones */
  readonly #named: ReadonlySet<string>;
  /** The `keyed` columns, each as the start of its fields (`<column>:`) */
  readonly #keyed: readonly string[];

  constructor(columns: TableColumns) {
    const named = new Set<string>(PLACE_FIELDS);
    const keyed: string[] = [];
    for (const [name, declared] of Object.entries(columns)) {
      const kind = typeof declared === 'string' ? declared : declared.kind;
      if (kind === 'keyed') keyed.push(`${name}:`);
      else named.add(name);
    }
    this.#named = named;
    this.#keyed = keyed;
  }

  /** Whether a field is one of the rows */
  has(field: RowField): boolean {
    if (this.#named.has(field)) return true;
    for (const start of this.#keyed) {
      if (field.length > start.length && field.startsWith(start)) return true;
    }
    return false;
  }

  /**
   * Checks the names of the fields of values against the columns
   *
   * @throws `KasaneError` with the code `invalid-input` for a field that is not one of the rows
   */
  check(values: RowValues): void {
    for (const field of values.fields.keys()) {
      if (!this.has(field)) {
        throw new KasaneError('invalid-input', `${JSON.stringify(field)} is not a field of a row`);
      }
    }
  }
}

/**
 * The values checked: rows by their handles, values of fields, one per row
 *
 * @throws `KasaneError` with the code `invalid-input` when they have another shape
 * @internal
 */
export function checkRowValues(values: unknown): RowValues {
  if (typeof values !== 'object' || values === null || Array.isArray(values)) {
    throw new KasaneError('invalid-input', 'The values must be an object');
  }
  const { handles, fields, deleted } = values as Partial<RowValues>;
  if (!(handles instanceof Int32Array)) {
    throw new KasaneError('invalid-input', 'The handles must be an Int32Array');
  }
  if (!(fields instanceof Map)) throw new KasaneError('invalid-input', 'The fields must be a Map');
  const n = handles.length;
  for (const [field, list] of fields) {
    if (typeof field !== 'string' || field === '') {
      throw new KasaneError('invalid-input', `${JSON.stringify(field)} is not a name of a field`);
    }
    if (!Array.isArray(list) || list.length !== n) {
      throw new KasaneError(
        'invalid-input',
        `The values of ${field} must be an array of one value per row`,
      );
    }
  }
  if (deleted !== undefined && (!(deleted instanceof Uint8Array) || deleted.length !== n)) {
    throw new KasaneError(
      'invalid-input',
      'The deletions must be a Uint8Array of one value per row',
    );
  }
  return values as RowValues;
}

/**
 * Makes values of rows, checking their shape only (the writer checks the names of their fields
 * against the columns declared)
 *
 * @param values - The rows by their handles, the values of each field, one per row, and the
 *   deletion of each row (non-zero for a row deleted)
 * @returns The values
 * @throws `KasaneError` with the code `invalid-input` when they have another shape: a field that
 *   is not a name, or not one value per row
 */
export function createRowValues(values: {
  readonly handles: Int32Array;
  readonly fields: ReadonlyMap<RowField, RowFieldValues>;
  readonly deleted?: Uint8Array;
}): RowValues {
  const checked = checkRowValues(values);
  return {
    handles: checked.handles,
    fields: checked.fields,
    ...(checked.deleted && { deleted: checked.deleted }),
  };
}
