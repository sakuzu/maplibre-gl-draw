// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// The sample features of style-features, around Tokyo Station, without their styles: main.ts
// gives each its look.

import type { FeatureInput } from '@sakuzu/maplibre-gl-draw';

export const STATION: FeatureInput = {
  type: 'Point',
  geometry: { type: 'Point', coordinates: [139.7671, 35.6812] },
  properties: { name: 'Station' },
};

export const WALK: FeatureInput = {
  type: 'LineString',
  geometry: {
    type: 'LineString',
    coordinates: [
      [139.758, 35.6775],
      [139.7625, 35.6835],
      [139.7665, 35.6858],
      [139.7725, 35.6866],
    ],
  },
  properties: { name: 'Walk' },
};

export const BLOCK: FeatureInput = {
  type: 'Polygon',
  geometry: {
    type: 'Polygon',
    coordinates: [
      [
        [139.7705, 35.673],
        [139.777, 35.673],
        [139.777, 35.679],
        [139.7705, 35.679],
        [139.7705, 35.673],
      ],
    ],
  },
  properties: { name: 'Block', description: 'A block east of the station.' },
};

export const RANGE: FeatureInput = {
  type: 'Circle',
  geometry: { type: 'Point', coordinates: [139.7605, 35.6885] },
  properties: { name: 'Within 300 m', 'maplibre-gl-draw:radiusMeters': 300 },
};

/** A stroke drawn by hand: a wave from west to east */
export const SKETCH: FeatureInput = {
  type: 'Freehand',
  geometry: {
    type: 'LineString',
    coordinates: Array.from({ length: 30 }, (_, i) => [
      139.757 + i * 0.0004,
      35.6725 + 0.001 * Math.sin(i / 3),
    ]),
  },
  properties: { name: 'Sketch' },
};
