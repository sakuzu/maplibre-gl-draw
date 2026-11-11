// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The columns the user of the tables declares, as the places a row block holds them in
 * (`rowColumnLayoutOf`)
 *
 * A row block holds its columns by kind, each kind in the order the columns of that kind are
 * declared: the `shape` columns in `shapes`, the `whole` columns in `wholes`, the `keyed` columns
 * in `keyed`, and the `flag` columns as bits of one byte per row, after the bit of the deleted
 * mark. The names are read once, when the tables are created; what reads the rows reads them by
 * these places, never by a name.
 *
 * A pure module (no state), so it runs in a Worker as well.
 */

import type { TableColumns, WholeDictionary } from '../feature-table/row-values.js';
import { KasaneError } from './kasane-error.js';
import { ROW_FLAG_DELETED } from './row-group-types.js';

/** The number of bits of the byte of the flags of a row */
const FLAG_BITS = 8;

/**
 * The places of the columns declared in a row block
 *
 * @internal
 */
export interface RowColumnLayout {
  /** The names of the `shape` columns, in the order of `RowBlockData.shapes` */
  readonly shapes: readonly string[];
  /** The names of the `whole` columns, in the order of `RowBlockData.wholes` */
  readonly wholes: readonly string[];
  /** Where the values of each `whole` column are kept, in the order of `wholes` */
  readonly dictionaries: readonly WholeDictionary[];
  /** The names of the `keyed` columns, in the order of `RowBlockData.keyed` */
  readonly keyed: readonly string[];
  /** The names of the `flag` columns, in the order of their bits */
  readonly flags: readonly string[];
}

/**
 * The places of the columns declared, read once from their declaration
 *
 * @throws `KasaneError` with the code `invalid-input` when more `flag` columns are declared than
 *   the byte of the flags of a row holds besides the deleted mark
 * @internal
 */
export function rowColumnLayoutOf(columns: TableColumns): RowColumnLayout {
  const shapes: string[] = [];
  const wholes: string[] = [];
  const dictionaries: WholeDictionary[] = [];
  const keyed: string[] = [];
  const flags: string[] = [];
  for (const [name, declared] of Object.entries(columns)) {
    const kind = typeof declared === 'string' ? declared : declared.kind;
    switch (kind) {
      case 'shape':
        shapes.push(name);
        break;
      case 'whole':
        wholes.push(name);
        dictionaries.push(typeof declared === 'string' ? 'rowBlock' : declared.dictionary);
        break;
      case 'keyed':
        keyed.push(name);
        break;
      case 'flag':
        flags.push(name);
        break;
    }
  }
  if (flags.length > FLAG_BITS - 1) {
    throw new KasaneError(
      'invalid-input',
      `The rows hold at most ${FLAG_BITS - 1} flag columns, not ${flags.length}`,
    );
  }
  return Object.freeze({
    shapes: Object.freeze(shapes),
    wholes: Object.freeze(wholes),
    dictionaries: Object.freeze(dictionaries),
    keyed: Object.freeze(keyed),
    flags: Object.freeze(flags),
  });
}

/**
 * The place of a `shape` column in `RowBlockData.shapes` (-1 for a name that is not one)
 *
 * @internal
 */
export function shapeColumnOf(layout: RowColumnLayout, name: string): number {
  return layout.shapes.indexOf(name);
}

/**
 * The place of a `whole` column in `RowBlockData.wholes` (-1 for a name that is not one)
 *
 * @internal
 */
export function wholeColumnOf(layout: RowColumnLayout, name: string): number {
  return layout.wholes.indexOf(name);
}

/**
 * The place of a `keyed` column in `RowBlockData.keyed` (-1 for a name that is not one)
 *
 * @internal
 */
export function keyedColumnOf(layout: RowColumnLayout, name: string): number {
  return layout.keyed.indexOf(name);
}

/**
 * The bit of a `flag` column in `RowBlockData.flags` (0 for a name that is not one): the bits
 * after the deleted mark, in the order the columns are declared
 *
 * @internal
 */
export function flagBitOf(layout: RowColumnLayout, name: string): number {
  const at = layout.flags.indexOf(name);
  return at < 0 ? 0 : ROW_FLAG_DELETED << (at + 1);
}

/**
 * The bit of a `flag` column of the groups in the flags of a group (0 for a name that is not one):
 * a bit each, in the order the columns are declared (`GroupTable.flagsOf`)
 *
 * @internal
 */
export function groupFlagBitOf(layout: RowColumnLayout, name: string): number {
  const at = layout.flags.indexOf(name);
  return at < 0 ? 0 : 1 << at;
}
