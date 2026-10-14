// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The Worker the tables of the measurement page hand their large work to: the next versions of
 * the row groups merged (`mergeRowGroup`) and the new rows of an import built
 * (`createRowGroupBuilder`), sent back without a copy
 */

import {
  circleRowRings,
  createRowGroupBuilder,
  mergeRowGroup,
  type RowGroupBuilderOptions,
  type RowGroupMerge,
  type RowInput,
  rowGroupTransferList,
} from '@sakuzu/maplibre-gl-draw/table';

/** What the page asks for */
export interface RowsWorkerRequest {
  readonly id: number;
  readonly merge?: RowGroupMerge;
  readonly rows?: readonly RowInput[];
  readonly options?: RowGroupBuilderOptions;
}

self.onmessage = (event: MessageEvent<RowsWorkerRequest>) => {
  const { id, merge, rows, options } = event.data;
  let groups: ReturnType<typeof mergeRowGroup>;
  if (merge) {
    groups = mergeRowGroup(merge);
  } else {
    // The rings of the Circles: a function, which is not posted
    const builder = createRowGroupBuilder({ ...options, rings: circleRowRings });
    for (const row of rows ?? []) builder.addRow(row);
    groups = builder.finish();
  }
  (self as unknown as Worker).postMessage({ id, groups }, rowGroupTransferList(groups));
};
