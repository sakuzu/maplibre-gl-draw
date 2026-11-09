// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The builder and the merge of row blocks as this entry hands them out: those of the features
 * (`createFeatureRowBlockBuilder`, `mergeFeatureRowBlock`), so that what they throw for the rows
 * is a `DrawError`, as every error of the library, and a Circle built has the ring of its radius
 */

import { createFeatureRowBlockBuilder, mergeFeatureRowBlock } from '../table/feature-row-blocks.js';
import type { RowBlockBuilder, RowBlockBuilderOptions } from '../table/row-group-builder.js';
import type { RowBlockMerge } from '../table/row-group-merge.js';
import type { RowBlock } from '../table/row-group-types.js';

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
