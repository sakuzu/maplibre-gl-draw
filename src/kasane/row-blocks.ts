// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The builder and the merge of row blocks as this entry hands them out: those of the features
 * (`createFeatureRowBlockBuilder`, `mergeFeatureRowBlock`), so that what they throw for the rows
 * is a `DrawError`, as every error of the library, and a Circle built has the ring of its radius.
 * The list of the buffers to transfer takes a table of `/table` as well as row blocks
 */

import type { RowBlock, RowBlockBuilderOptions, RowBlockMerge } from '@sakuzu/kasane';
import { transferList as rowBlockTransferList } from '@sakuzu/kasane';
import {
  createFeatureRowBlockBuilder,
  mergeFeatureRowBlock,
  type FeatureRowBlockBuilder as RowBlockBuilder,
} from '../table/feature-row-blocks.js';
import { transferList as tableTransferList } from '../table/prepare.js';
import type { PreparedTable, Table } from '../table/types.js';

/**
 * Creates the builder of the row blocks of one layer
 *
 * Its methods throw `DrawError`: with the code `invalid-input` when a row is refused (an id added
 * twice, a geometry or a value that cannot be held, more than 255 types), or `not-found` when a
 * row names a group the options do not give.
 */
export function createRowBlockBuilder(options: RowBlockBuilderOptions = {}): RowBlockBuilder {
  return createFeatureRowBlockBuilder(options);
}

/**
 * Merges rows of row blocks into new row blocks, in the order of the layer
 *
 * @returns The new row blocks (none for no row); their handles are those of the rows
 * @throws `DrawError` with the code `invalid-input` when a source holds styles not numbered yet,
 *   or `not-found` when a row names a group of features the keys do not give
 */
export function mergeRowBlock(merge: RowBlockMerge): RowBlock[] {
  return mergeFeatureRowBlock(merge);
}

/**
 * Every buffer of a table or of row blocks, for `postMessage` with transfer (each one once,
 * a `SharedArrayBuffer` left out): a table, the result of `prepareTable`, or the row blocks a builder
 * or a merge made. After the transfer the arrays are empty on the sending side.
 *
 * @param value The table, or the row blocks
 * @returns The buffers to pass as the transfer list
 *
 * @example
 * ```ts
 * const rowBlocks = builder.finish();
 * self.postMessage(rowBlocks, { transfer: transferList(rowBlocks) });
 * ```
 */
export function transferList(value: Table | PreparedTable | readonly RowBlock[]): ArrayBuffer[] {
  return Array.isArray(value)
    ? rowBlockTransferList(value as readonly RowBlock[])
    : tableTransferList(value as Table | PreparedTable);
}
