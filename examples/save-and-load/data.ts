// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// The sample file of save-and-load: GeoJSON as another tool would write it, west of Tokyo
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
            [139.7525, 35.6735],
            [139.757, 35.6735],
            [139.757, 35.6765],
            [139.7525, 35.6765],
            [139.7525, 35.6735],
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
          [139.7485, 35.6795],
          [139.7525, 35.6815],
          [139.757, 35.6822],
          [139.761, 35.6808],
        ],
      },
      properties: { name: 'Moat' },
    },
    {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [139.7615, 35.6795] },
      properties: { name: 'Gate', opened: 1636 },
    },
    {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [139.7598, 35.6745] },
      properties: { name: 'Fountain' },
    },
    {
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: [[139.758, 35.678]] },
      properties: { name: 'A line of one position' },
    },
  ],
};
