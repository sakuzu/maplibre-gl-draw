// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The Worker the tables of the measurement page hand their large work to: the next versions of
 * the row groups merged (`mergeRowBlock`) and the new rows of an import built
 * (`createRowBlockBuilder`), sent back without a copy
 */

import {
  createRowBlockBuilder,
  mergeRowBlock,
  type RowBlockBuilderOptions,
  type RowBlockMerge,
  type RowInput,
  transferList,
} from '@sakuzu/maplibre-gl-draw/kasane';

/** What the page asks for */
export interface RowsWorkerRequest {
  readonly id: number;
  readonly merge?: RowBlockMerge;
  readonly rows?: readonly RowInput[];
  readonly options?: RowBlockBuilderOptions;
}

self.onmessage = (event: MessageEvent<RowsWorkerRequest>) => {
  const { id, merge, rows, options } = event.data;
  let groups: ReturnType<typeof mergeRowBlock>;
  if (merge) {
    groups = mergeRowBlock(merge);
  } else {
    const builder = createRowBlockBuilder(options);
    for (const row of rows ?? []) builder.addRow(row);
    groups = builder.finish();
  }
  (self as unknown as Worker).postMessage({ id, groups }, transferList(groups));
};
