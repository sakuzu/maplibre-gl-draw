// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// The sample data of layers-and-groups, east of Tokyo Station: four parcels in a row and a
// path across them.

import type { Position } from '@sakuzu/maplibre-gl-draw';

/** A rectangle with its south-west corner at [lng, lat] */
function parcel(lng: number, lat: number): Position[][] {
  const [w, h] = [0.0026, 0.0018];
  return [
    [
      [lng, lat],
      [lng + w, lat],
      [lng + w, lat + h],
      [lng, lat + h],
      [lng, lat],
    ],
  ];
}

/** The four parcels, from west to east */
export const PARCELS: Position[][][] = [0, 1, 2, 3].map((i) =>
  parcel(139.768 + i * 0.0028, 35.679),
);

/** The path across them */
export const PATH: Position[] = [
  [139.7675, 35.6785],
  [139.7795, 35.682],
];
