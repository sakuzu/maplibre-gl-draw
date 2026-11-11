// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The Worker the tables of the measurement page hand their large work to: the next versions of
 * the row groups merged (`mergePages`) and the new rows of an import built
 * (`createPageBuilder`), sent back without a copy
 */

import {
  mergePages,
  type PageBuilderOptions,
  type PageMerge,
  type RowInput,
} from '@sakuzu/maplibre-gl-draw/kasane';
import { createPageBuilder, transferList } from '@sakuzu/maplibre-gl-draw/table';

/** What the page asks for */
export interface RowsWorkerRequest {
  readonly id: number;
  readonly merge?: PageMerge;
  readonly rows?: readonly RowInput[];
  readonly options?: PageBuilderOptions;
}

self.onmessage = (event: MessageEvent<RowsWorkerRequest>) => {
  const { id, merge, rows, options } = event.data;
  let groups: ReturnType<typeof mergePages>;
  if (merge) {
    groups = mergePages(merge);
  } else {
    const builder = createPageBuilder(options);
    for (const row of rows ?? []) builder.addRow(row);
    groups = builder.finish();
  }
  (self as unknown as Worker).postMessage({ id, groups }, transferList(groups));
};
