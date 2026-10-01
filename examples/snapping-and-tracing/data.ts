// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// The sample data of snapping-and-tracing, east of Tokyo Station: a parcel whose east side
// follows a stream, and a road along its south.

import type { FeatureInput, Position } from '@sakuzu/maplibre-gl-draw';

/** The east side of the parcel, along the stream: the boundary to trace, from south to north */
export const STREAM: Position[] = [
  [139.7745, 35.678],
  [139.7753, 35.6795],
  [139.7742, 35.681],
  [139.7754, 35.6825],
  [139.7745, 35.684],
];

/** The parcel and the road */
export const FEATURES: FeatureInput[] = [
  {
    type: 'Polygon',
    geometry: {
      type: 'Polygon',
      coordinates: [[[139.7695, 35.678], ...STREAM, [139.7695, 35.684], [139.7695, 35.678]]],
    },
    properties: { name: 'West parcel' },
  },
  {
    type: 'LineString',
    geometry: {
      type: 'LineString',
      coordinates: [
        [139.7675, 35.677],
        [139.7805, 35.677],
      ],
    },
    properties: { name: 'Road' },
  },
];
