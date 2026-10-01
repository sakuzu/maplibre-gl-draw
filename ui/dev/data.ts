// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// The sample data of the development page, around Tokyo Station and east of it: a feature of
// each type, and places colored by their kind.

import type { FeatureInput } from '@sakuzu/maplibre-gl-draw';

/** The center of the map */
export const CENTER: [number, number] = [139.773, 35.68];

/** A feature of each type */
export const FEATURES: FeatureInput[] = [
  {
    type: 'Point',
    geometry: { type: 'Point', coordinates: [139.7671, 35.6812] },
    properties: { name: 'Tokyo Station', kind: 'station', platforms: 30 },
  },
  {
    type: 'LineString',
    geometry: {
      type: 'LineString',
      coordinates: [
        [139.768, 35.676],
        [139.772, 35.684],
        [139.781, 35.686],
      ],
    },
    properties: { name: 'Walk', surface: 'paved' },
  },
  {
    type: 'Polygon',
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          [139.772, 35.672],
          [139.784, 35.672],
          [139.784, 35.68],
          [139.772, 35.68],
          [139.772, 35.672],
        ],
      ],
    },
    properties: { kind: 'block', owner: 'city', description: 'A block east of the station.' },
  },
  {
    type: 'Circle',
    geometry: { type: 'Point', coordinates: [139.7765, 35.6905] },
    properties: { 'maplibre-gl-draw:radiusMeters': 400, name: 'Within 400 m', zone: 'A' },
  },
];

/** The places of the second layer: a name, a kind and where. The first two are parks */
export const PLACES: [name: string, kind: string, coordinates: [number, number]][] = [
  ['Hibiya Park', 'park', [139.7559, 35.6736]],
  ['Hamarikyu Gardens', 'park', [139.7634, 35.66]],
  ['Yurakucho', 'station', [139.7631, 35.675]],
  ['Bridge', 'landmark', [139.7745, 35.6838]],
];
