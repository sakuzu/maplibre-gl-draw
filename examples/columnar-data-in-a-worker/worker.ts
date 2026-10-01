// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// The Worker of columnar-data-in-a-worker: it builds a table in the layout of GeoArrow (what a
// reader of GeoParquet or Arrow would hand over; data.ts), prepares it for the dataset, and
// sends it to the page without a copy.

import { prepareTable, transferList } from '@sakuzu/maplibre-gl-draw/table';
import { createTable } from './data.ts';

self.onmessage = (event: MessageEvent<{ count: number; center: [number, number] }>) => {
  const started = performance.now();
  const prepared = prepareTable(createTable(event.data.count, event.data.center));
  const workerMs = performance.now() - started;
  // The transfer list moves every array to the page instead of copying it
  self.postMessage({ prepared, workerMs }, { transfer: transferList(prepared) });
};
