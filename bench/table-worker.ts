// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The Worker of the measurement of the layers held as rows: it makes the features (or reads them
 * from a file of `bench/data/`) and builds them into row groups, and sends the groups to the page
 * without a copy, with the rows the edits change and the extent of the features
 */

import {
  circleRowRings,
  createRowGroupBuilder,
  rowGroupTransferList,
} from '@sakuzu/maplibre-gl-draw/table';
import {
  type BenchCandidates,
  type BenchFeature,
  benchFeature,
  candidatesOf,
  extentOf,
  extentOfFeatures,
  featuresOfText,
  stylesOf,
  type TableBenchParams,
} from './table-data';

/** What the page asks for */
export interface TableWorkerRequest {
  readonly params: TableBenchParams;
  /** The address of the file the features are read from (made in the Worker when null) */
  readonly dataUrl: string | null;
}

/** What the Worker sends back */
export interface TableWorkerResult {
  readonly groups: ReturnType<ReturnType<typeof createRowGroupBuilder>['finish']>;
  /** The number of rows */
  readonly count: number;
  /** The rows the edits change */
  readonly candidates: BenchCandidates;
  /** The extent of the features, `[west, south, east, north]` */
  readonly extent: [number, number, number, number];
  /** The time making (or reading) the features took (ms) */
  readonly generateMs: number;
  /** The time adding them to the builder took (ms) */
  readonly addMs: number;
  /** The time sorting them and building the groups took (ms) */
  readonly buildMs: number;
  /** Why the features could not be read (absent when they were) */
  readonly error?: string;
}

self.onmessage = async (event: MessageEvent<TableWorkerRequest>) => {
  const { params, dataUrl } = event.data;
  const t0 = performance.now();
  let features: BenchFeature[] = [];
  let extent = extentOf(params);
  try {
    if (dataUrl) {
      const response = await fetch(dataUrl);
      if (!response.ok) throw new Error(`${dataUrl}: ${response.status}`);
      const text = await response.text();
      features = featuresOfText(text, /\.(ndjson|geojsonl)$/.test(dataUrl), params);
      extent = extentOfFeatures(features);
    } else {
      const styles = stylesOf(params);
      for (let i = 0; i < params.n; i++) features.push(benchFeature(params, styles, i));
    }
  } catch (error) {
    const empty = createRowGroupBuilder().finish();
    const result: TableWorkerResult = {
      groups: empty,
      count: 0,
      candidates: candidatesOf([]),
      extent,
      generateMs: 0,
      addMs: 0,
      buildMs: 0,
      error: String(error),
    };
    (self as unknown as Worker).postMessage(result);
    return;
  }
  const t1 = performance.now();
  const builder = createRowGroupBuilder({ rings: circleRowRings });
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
    count: features.length,
    candidates: candidatesOf(features),
    extent,
    generateMs: t1 - t0,
    addMs: t2 - t1,
    buildMs: t3 - t2,
  };
  (self as unknown as Worker).postMessage(result, rowGroupTransferList(groups));
};
