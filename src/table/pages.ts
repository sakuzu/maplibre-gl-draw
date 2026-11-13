// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The builder and the merge of pages as the entries hand them out: those of the features
 * (`createFeaturePageBuilder`, `mergeFeaturePages`), so that what they throw for the rows is a
 * `DrawError`, as every error of the library, and a Circle built has the ring of its radius. The
 * list of the buffers to transfer takes a table of `/table` as well as pages
 */

import type { Page } from '@sakuzu/kasane';
import { transferList as pageTransferList } from '@sakuzu/kasane';
import {
  createFeaturePageBuilder,
  type FeaturePageBuilder,
  mergeFeaturePages,
} from './feature-row-blocks.js';
import { transferList as tableTransferList } from './prepare.js';
import type { PageBuilderOptions, PageMerge } from './tables-values.js';
import type { PreparedTable, Table } from './types.js';

/**
 * Creates the builder of the pages of one layer
 *
 * Its methods throw `DrawError`: with the code `invalidInput` when a row is refused (an id added
 * twice, a geometry or a value that cannot be held, more than 255 types), or `notFound` when a
 * row names a group the options do not give.
 */
export function createPageBuilder(options: PageBuilderOptions = {}): FeaturePageBuilder {
  return createFeaturePageBuilder(options);
}

/**
 * Merges rows of pages into new pages, in the order of the layer
 *
 * @returns The new pages (none for no row); their handles are those of the rows
 * @throws `DrawError` with the code `invalidInput` when a source holds styles not numbered yet,
 *   or `notFound` when a row names a group of features the keys do not give
 */
export function mergePages(merge: PageMerge): Page[] {
  return mergeFeaturePages(merge);
}

/**
 * Every buffer of a table or of pages, for `postMessage` with transfer (each one once, a
 * `SharedArrayBuffer` left out): a table, the result of `prepareTable`, or the pages a builder or
 * a merge made. After the transfer the arrays are empty on the sending side.
 *
 * @param value The table, or the pages
 * @returns The buffers to pass as the transfer list
 *
 * @example
 * ```ts
 * const prepared = prepareTable(tableFromFeatures(features));
 * self.postMessage(prepared, { transfer: transferList(prepared) });
 *
 * const pages = builder.finish();
 * self.postMessage(pages, { transfer: transferList(pages) });
 * ```
 */
export function transferList(value: Table | PreparedTable | readonly Page[]): ArrayBuffer[] {
  return Array.isArray(value)
    ? pageTransferList(value as readonly Page[])
    : tableTransferList(value as Table | PreparedTable);
}
