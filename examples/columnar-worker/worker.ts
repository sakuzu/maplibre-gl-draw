// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// The Worker of columnar-worker: it builds a table in the layout of GeoArrow (what a reader
// of GeoParquet or Arrow would hand over), prepares it for the dataset, and
// sends both to the page without a copy.

import {
  columnarTransferables,
  type DatasetColumnarInput,
  prepareDatasetColumnar,
} from '@sakuzu/maplibre-gl-draw/columnar';

/** The values of the `kind` column (a dictionary: each row holds the index of its value) */
const KINDS = ['shop', 'school', 'station', 'park'];

/** A table of `count` points scattered in clusters around the center */
function createTable(count: number, center: [number, number]): DatasetColumnarInput {
  const coords = new Float64Array(count * 2);
  const kind = new Uint8Array(count);
  const value = new Float64Array(count);
  let seed = 1;
  const random = (): number => {
    seed = (seed * 16_807) % 2_147_483_647;
    return seed / 2_147_483_647;
  };
  for (let i = 0; i < count; i++) {
    // A cluster center, then a spread around it
    const cluster = Math.floor(random() * 60);
    const angle = cluster * 2.4;
    const cx = center[0] + Math.cos(angle) * 0.004 * cluster;
    const cy = center[1] + Math.sin(angle) * 0.003 * cluster;
    const r = random() ** 2 * 0.02;
    const t = random() * Math.PI * 2;
    coords[i * 2] = cx + Math.cos(t) * r;
    coords[i * 2 + 1] = cy + Math.sin(t) * r * 0.8;
    kind[i] = cluster % KINDS.length;
    value[i] = Math.round(random() * 1000);
  }
  return {
    length: count,
    geometry: { type: 'Point', coords },
    columns: {
      kind: { codes: kind, dictionary: KINDS },
      value,
    },
  };
}

self.onmessage = (event: MessageEvent<{ count: number; center: [number, number] }>) => {
  const started = performance.now();
  const input = createTable(event.data.count, event.data.center);
  const prepared = prepareDatasetColumnar(input);
  const workerMs = performance.now() - started;
  // The transfer list moves every array to the page instead of copying it
  self.postMessage(
    { input, prepared, workerMs },
    { transfer: columnarTransferables(input, prepared) },
  );
};
