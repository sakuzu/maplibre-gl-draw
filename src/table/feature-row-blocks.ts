// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The builder and the merge of the row blocks of the features (`createFeatureRowBlockBuilder`,
 * `mergeFeatureRowBlock`): those of the tables, with what the library declares of its features
 *
 * What the library declares of its features for the builder and the merge of the tables
 * (`row-group-builder.ts`, `row-group-merge.ts`) is given here: the rings of the Circles as the
 * rings of the rows when none are given (`circleRowRings`; the tables have none of their own),
 * the triangles of the fills as a cache of the rows (`FEATURE_CACHES`), and what they throw for
 * the rows as a `DrawError`, as every error of the library. A Worker of
 * the host imports these: a function cannot be sent to it, so what the library declares is held
 * here, where the Worker runs them.
 *
 * The rings given to the builder here are read from the type, the point and the attributes of a
 * row (`PointRowRings`), and given to the builder of the tables as rings that read a row.
 */

import { circleRowRings } from './circle-rings.js';
import { drawErrorOf } from './draw-error-of.js';
import { FEATURE_CACHES } from './fill-triangles.js';
import { KasaneError } from './kasane-error.js';
import {
  createRowBlockBuilder,
  type RowBlockBuilder,
  type RowBlockBuilderOptions,
  type RowInput,
} from './row-group-builder.js';
import { mergeRowBlock, type RowBlockMerge } from './row-group-merge.js';
import type { RowBlock } from './row-group-types.js';
import { rowRingsOfPoint } from './row-rings.js';

/**
 * One feature given to the builder of the row blocks of the features, as a row
 *
 * @internal
 */
export type FeatureRowInput = RowInput;

/**
 * The options of {@link createFeatureRowBlockBuilder}: those of the builder of the tables, whose
 * rings are the rings of the Circles when omitted
 *
 * @internal
 */
export type FeatureRowBlockBuilderOptions = RowBlockBuilderOptions;

/**
 * An error of the tables (`KasaneError`) as a `DrawError`; what a function given in the options
 * threw (the system of coordinates, the rings) as it is
 */
function rowsError(error: unknown): unknown {
  return error instanceof KasaneError ? drawErrorOf(error) : error;
}

/**
 * Creates the builder of the row blocks of the features of one layer
 *
 * Its methods throw `DrawError`: with the code `invalid-input` when a row is refused (an id added
 * twice, a geometry or a value that cannot be held, more than 255 types), or `not-found` when a
 * row names a group the options do not give.
 *
 * @internal
 */
export function createFeatureRowBlockBuilder(
  options: FeatureRowBlockBuilderOptions = {},
): RowBlockBuilder {
  const builder = createRowBlockBuilder({
    ...options,
    rings: options.rings ? rowRingsOfPoint(options.rings) : circleRowRings,
    caches: FEATURE_CACHES,
  });
  return {
    get length() {
      return builder.length;
    },
    addRow(row: FeatureRowInput): void {
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
 * Merges rows of row blocks of the features into new row blocks, in the order of the layer
 *
 * @returns The new row blocks (none for no row); their handles are those of the rows
 * @throws `DrawError` with the code `invalid-input` when a source holds styles not numbered yet,
 *   or `not-found` when a row names a group of features the keys do not give
 * @internal
 */
export function mergeFeatureRowBlock(merge: RowBlockMerge): RowBlock[] {
  try {
    return mergeRowBlock(merge);
  } catch (error) {
    throw rowsError(error);
  }
}
