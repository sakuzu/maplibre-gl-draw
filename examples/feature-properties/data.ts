// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// The sample data of feature-properties: a few places east of Tokyo Station as GeoJSON, each
// with attributes of several kinds (text, numbers, a boolean and a list).

import type { FeatureCollection } from 'geojson';

export const PLACES: FeatureCollection = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [139.78, 35.6745],
            [139.786, 35.6745],
            [139.786, 35.6785],
            [139.78, 35.6785],
            [139.78, 35.6745],
          ],
        ],
      },
      properties: {
        name: 'Market hall',
        description: 'A covered market east of the station.',
        use: 'commercial',
        floors: 3,
        opened: 1998,
        accessible: true,
        stalls: ['fish', 'fruit', 'flowers'],
      },
    },
    {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [139.772, 35.6835] },
      properties: { name: 'Library', use: 'public', floors: 5, opened: 1972, accessible: true },
    },
    {
      type: 'Feature',
      geometry: {
        type: 'LineString',
        coordinates: [
          [139.7675, 35.6775],
          [139.772, 35.6812],
          [139.7766, 35.6812],
        ],
      },
      properties: { name: 'Avenue', use: 'road', lanes: 4, oneWay: false },
    },
  ],
};
