// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// The sample features of style-features, east of Tokyo Station, without their styles: main.ts
// gives each its look. They stand in rows, so the looks compare side by side: three areas, three
// lines under them, four points and a circle.

import type { FeatureInput, Position } from '@sakuzu/maplibre-gl-draw';

/** The west edge of the rows and the top of the first one */
const WEST = 139.77;
const TOP = 35.6842;
/** The width of a column, and the step from one column to the next (degrees of longitude) */
const WIDTH = 0.0011;
const STEP = 0.0015;

/** A square area in column `column` of the first row */
function area(name: string, column: number): FeatureInput {
  const west = WEST + column * STEP;
  const ring: Position[] = [
    [west, TOP - 0.0009],
    [west + WIDTH, TOP - 0.0009],
    [west + WIDTH, TOP],
    [west, TOP],
    [west, TOP - 0.0009],
  ];
  return {
    type: 'Polygon',
    geometry: { type: 'Polygon', coordinates: [ring] },
    properties: { name },
  };
}

/** A line across column `column` of the second row, with a bend in the middle */
function line(name: string, column: number): FeatureInput {
  const west = WEST + column * STEP;
  return {
    type: 'LineString',
    geometry: {
      type: 'LineString',
      coordinates: [
        [west, TOP - 0.0016],
        [west + WIDTH / 2, TOP - 0.0012],
        [west + WIDTH, TOP - 0.0016],
      ],
    },
    properties: { name },
  };
}

/** A point of the third row, the first of four at `index` 0 */
function point(name: string, index: number): FeatureInput {
  return {
    type: 'Point',
    geometry: { type: 'Point', coordinates: [WEST + 0.0002 + index * 0.00123, TOP - 0.0022] },
    properties: { name },
  };
}

/** The three areas, from the west: their outlines solid, dashed and dotted */
export const AREAS = [area('Solid 1 px', 0), area('Dashed 3 px', 1), area('Dotted 6 px', 2)];

/** The three lines under them */
export const LINES = [line('Line 1 px', 0), line('Line 4 px', 1), line('Line 10 px', 2)];

/** The four points: a circle, a square, a triangle and a star */
export const POINTS = [
  point('Circle 6', 0),
  point('Square 9', 1),
  point('Triangle 12', 2),
  point('Star 15', 3),
];

/** A circle of 80 m on the ground, under the points */
export const RANGE: FeatureInput = {
  type: 'Circle',
  geometry: { type: 'Point', coordinates: [WEST + 0.00205, TOP - 0.0032] },
  properties: { name: 'Within 80 m', 'maplibre-gl-draw:radiusMeters': 80 },
};
