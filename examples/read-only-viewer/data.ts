// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// The drawing the viewer shows, east of Tokyo Station: blocks with their use, their height and
// the year they were built, and the stops of a bus around them. Made up for the example.

import type { FeatureCollection } from 'geojson';

/** A rectangle from its south-west corner, its width and its height in degrees */
function block(west: number, south: number, width: number, height: number): number[][][] {
  const east = west + width;
  const north = south + height;
  return [
    [
      [west, south],
      [east, south],
      [east, north],
      [west, north],
      [west, south],
    ],
  ];
}

export const BLOCKS: FeatureCollection = {
  type: 'FeatureCollection',
  features: [
    ['North tower', 'office', 38, 2007, 139.7686, 35.6826],
    ['South tower', 'office', 42, 2007, 139.7686, 35.6795],
    ['Arcade', 'shop', 3, 1964, 139.7705, 35.6811],
    ['Garden hotel', 'hotel', 18, 1999, 139.7728, 35.6826],
    ['Market hall', 'shop', 2, 1971, 139.7728, 35.6795],
  ].map(([name, use, floors, built, west, south]) => ({
    type: 'Feature',
    geometry: {
      type: 'Polygon',
      coordinates: block(west as number, south as number, 0.0016, 0.0011),
    },
    properties: { name, use, floors, built },
  })),
};

export const STOPS: FeatureCollection = {
  type: 'FeatureCollection',
  features: [
    ['Station east', 139.7681, 35.6812],
    ['Arcade', 139.7718, 35.6843],
    ['Market', 139.7748, 35.6809],
  ].map(([name, lng, lat]) => ({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [lng as number, lat as number] },
    properties: { name, line: 'Loop', every: '10 min' },
  })),
};
