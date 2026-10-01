// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// The sample file of save-and-load: GeoJSON as another tool would write it, east of Tokyo
// Station. Its last feature is a line of a single position, which cannot be drawn, so a load
// leaves it out and says why.

import type { FeatureCollection } from 'geojson';

export const SAMPLE: FeatureCollection = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [139.7715, 35.6735],
            [139.776, 35.6735],
            [139.776, 35.6765],
            [139.7715, 35.6765],
            [139.7715, 35.6735],
          ],
        ],
      },
      properties: { name: 'Park', area: 'green' },
    },
    {
      type: 'Feature',
      geometry: {
        type: 'LineString',
        coordinates: [
          [139.7675, 35.6795],
          [139.7715, 35.6815],
          [139.776, 35.6822],
          [139.78, 35.6808],
        ],
      },
      properties: { name: 'Canal' },
    },
    {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [139.7805, 35.6795] },
      properties: { name: 'Bridge', opened: 1911 },
    },
    {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [139.7788, 35.6745] },
      properties: { name: 'Fountain' },
    },
    {
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: [[139.777, 35.678]] },
      properties: { name: 'A line of one position' },
    },
  ],
};
