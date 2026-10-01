// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// The sample data of columnar-data-in-a-worker: a table of points in clusters east of Tokyo,
// along the north shore of Tokyo Bay, in the layout of GeoArrow (what a reader of GeoParquet or
// Arrow would hand over). The Worker makes it; a real one would read it from a file.

import type { Table } from '@sakuzu/maplibre-gl-draw/table';

/** The center of the clusters and of the map */
export const CENTER: [number, number] = [140.03, 35.65];

/** The number of rows */
export const COUNT = 200_000;

/** The values of the `kind` column (a dictionary: each row holds the index of its value) */
const KINDS = ['shop', 'school', 'station', 'park'];

/** A table of `count` points scattered in clusters around the center */
export function createTable(count = COUNT, center = CENTER): Table {
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
