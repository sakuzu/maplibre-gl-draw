// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// The sample data of geometry-operations, east of Tokyo Station: two squares that share an
// edge, a third that overlaps them, and a line across the first.

import type { FeatureInput } from '@sakuzu/maplibre-gl-draw';

/** A square area of `size` degrees with its south-west corner at [lng, lat] */
function square(name: string, lng: number, lat: number, size: number): FeatureInput {
  const ring = [
    [lng, lat],
    [lng + size, lat],
    [lng + size, lat + size],
    [lng, lat + size],
    [lng, lat],
  ];
  return {
    type: 'Polygon',
    geometry: { type: 'Polygon', coordinates: [ring] },
    properties: { name },
  };
}

/** The West and East squares, the Overlap square and the Cut line, in this order */
export const SHAPES: FeatureInput[] = [
  square('West', 139.7685, 35.679, 0.004),
  square('East', 139.7725, 35.679, 0.004),
  square('Overlap', 139.7755, 35.682, 0.003),
  {
    type: 'LineString',
    geometry: {
      type: 'LineString',
      coordinates: [
        [139.7675, 35.6805],
        [139.7735, 35.6815],
      ],
    },
    properties: { name: 'Cut line' },
  },
];
