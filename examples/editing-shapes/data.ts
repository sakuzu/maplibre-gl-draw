// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// The sample features of editing-shapes, east of Tokyo Station: two parcels that share an edge
// above, and an area with a hole, an area of two parts and a line below.

import type { FeatureInput, Position } from '@sakuzu/maplibre-gl-draw';

/**
 * The two ends of the edge the parcels share. Both parcels list these very positions, so their
 * vertices there are exactly equal, which is what a shared vertex is
 */
export const SHARED: { lower: Position; upper: Position } = {
  lower: [139.7716, 35.6824],
  upper: [139.7719, 35.6838],
};

/** An area from its outer ring, without the closing position, and its holes */
function area(name: string, outer: Position[], ...holes: Position[][]): FeatureInput {
  const close = (ring: Position[]) => [...ring, ring[0]];
  return {
    type: 'Polygon',
    geometry: { type: 'Polygon', coordinates: [close(outer), ...holes.map(close)] },
    properties: { name },
  };
}

export const WEST_PARCEL = area('West parcel', [
  [139.77, 35.6821],
  SHARED.lower,
  SHARED.upper,
  [139.7702, 35.6842],
]);

export const EAST_PARCEL = area('East parcel', [
  SHARED.lower,
  [139.7737, 35.682],
  [139.774, 35.6841],
  SHARED.upper,
]);

/** An area with a hole: the second ring of its geometry */
export const COURTYARD = area(
  'Courtyard',
  [
    [139.77, 35.6797],
    [139.7714, 35.6797],
    [139.7714, 35.6811],
    [139.77, 35.6811],
  ],
  [
    [139.7704, 35.6801],
    [139.7704, 35.6807],
    [139.771, 35.6807],
    [139.771, 35.6801],
  ],
);

/** One feature of two separate parts */
export const ISLANDS: FeatureInput = {
  type: 'MultiPolygon',
  geometry: {
    type: 'MultiPolygon',
    coordinates: [
      [
        [
          [139.7718, 35.6798],
          [139.7724, 35.6798],
          [139.7721, 35.681],
          [139.7718, 35.6798],
        ],
      ],
      [
        [
          [139.7727, 35.6799],
          [139.7732, 35.6799],
          [139.7732, 35.6809],
          [139.7727, 35.6809],
          [139.7727, 35.6799],
        ],
      ],
    ],
  },
  properties: { name: 'Islands' },
};

export const PATH: FeatureInput = {
  type: 'LineString',
  geometry: {
    type: 'LineString',
    coordinates: [
      [139.7735, 35.6797],
      [139.7739, 35.681],
      [139.7744, 35.68],
    ],
  },
  properties: { name: 'Path' },
};
