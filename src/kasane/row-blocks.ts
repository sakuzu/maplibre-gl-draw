// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The builder and the merge of row blocks as this entry hands them out: what they throw for the
 * rows is a `DrawError`, as every error of the library
 */

import { drawErrorOf } from '../table/draw-error-of.js';
import { KasaneError } from '../table/kasane-error.js';
import {
  createRowBlockBuilder as createKasaneRowBlockBuilder,
  type RowBlockBuilder,
  type RowBlockBuilderOptions,
  type RowInput,
} from '../table/row-group-builder.js';
import {
  mergeRowBlock as mergeKasaneRowBlock,
  type RowBlockMerge,
} from '../table/row-group-merge.js';
import type { RowBlock } from '../table/row-group-types.js';

/**
 * An error of the tables (`KasaneError`) as a `DrawError`; what a function given in the options
 * threw (the system of coordinates, the rings) as it is
 */
function rowsError(error: unknown): unknown {
  return error instanceof KasaneError ? drawErrorOf(error) : error;
}

/**
 * Creates the builder of the row blocks of one layer
 *
 * Its methods throw `DrawError`: with the code `invalid-input` when a row is refused (an id added
 * twice, a geometry or a value that cannot be held, more than 255 types), or `not-found` when a
 * row names a group the options do not give.
 */
export function createRowBlockBuilder(options: RowBlockBuilderOptions = {}): RowBlockBuilder {
  const builder = createKasaneRowBlockBuilder(options);
  return {
    get length() {
      return builder.length;
    },
    addRow(row: RowInput): void {
      try {
        builder.addRow(row);
      } catch (error) {
        throw rowsError(error);
      }
    },
    finish(): RowBlock[] {
      try {
        return builder.finish();
      } catch (error) {
        throw rowsError(error);
      }
    },
  };
}

/**
 * Merges rows of row blocks into new row blocks, in the order of the layer
 *
 * @returns The new row blocks (none for no row); their handles are those of the rows
 * @throws `DrawError` with the code `invalid-input` when a source holds styles not numbered yet,
 *   or `not-found` when a row names a group of features the keys do not give
 */
export function mergeRowBlock(merge: RowBlockMerge): RowBlock[] {
  try {
    return mergeKasaneRowBlock(merge);
  } catch (error) {
    throw rowsError(error);
  }
}
