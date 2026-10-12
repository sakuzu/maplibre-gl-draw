// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The Worker of the measurement of the layers held as rows: it makes the features and builds
 * them into row groups, and sends the groups to the page without a copy
 */

import { createRowGroupBuilder, rowGroupTransferList } from '@sakuzu/maplibre-gl-draw/table';
import { benchFeature, stylesOf, type TableBenchParams } from './table-data';

/** What the Worker sends back */
export interface TableWorkerResult {
  readonly groups: ReturnType<ReturnType<typeof createRowGroupBuilder>['finish']>;
  /** The time making the features took (ms) */
  readonly generateMs: number;
  /** The time adding them to the builder took (ms) */
  readonly addMs: number;
  /** The time sorting them and building the groups took (ms) */
  readonly buildMs: number;
}

self.onmessage = (event: MessageEvent<TableBenchParams>) => {
  const params = event.data;
  const t0 = performance.now();
  const styles = stylesOf(params);
  const features = [];
  for (let i = 0; i < params.n; i++) features.push(benchFeature(params, styles, i));
  const t1 = performance.now();
  const builder = createRowGroupBuilder();
  for (const feature of features) {
    builder.addRow({
      id: feature.id,
      type: feature.type,
      geometry: feature.geometry,
      order: feature.order,
      style: feature.style,
      properties: feature.properties,
    });
  }
  const t2 = performance.now();
  const groups = builder.finish();
  const t3 = performance.now();
  const result: TableWorkerResult = {
    groups,
    generateMs: t1 - t0,
    addMs: t2 - t1,
    buildMs: t3 - t2,
  };
  (self as unknown as Worker).postMessage(result, rowGroupTransferList(groups));
};
