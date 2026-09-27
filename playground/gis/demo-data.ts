// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Demo Data
 *
 * Generates grid-shaped polygons for the large-volume display demo of the
 * dataset (Dataset). They do not go into the Store, so even 10,000 features do
 * not grow the editing data structures at all.
 */

import type { DatasetRow, StyleRule } from '@sakuzu/maplibre-gl-draw';

import { DEMO_GRID, STYLE_RULE_OTHER_COLOR } from '../constants';

/** Style shared by every grid polygon (the color is decided by the styleRule) */
const GRID_STYLE = Object.freeze({
  fillOpacity: 0.7,
  strokeOpacity: 0,
  strokeWidth: 0,
});

/** Graduated rule for the grid polygons */
export const DEMO_GRID_STYLE_RULE: StyleRule = {
  kind: 'graduated',
  property: 'value',
  breaks: [20, 40, 60, 80],
  colors: ['#eff3ff', '#c6dbef', '#9ecae1', '#4292c6', '#08519c'],
  other: STYLE_RULE_OTHER_COLOR,
};

/**
 * A value that changes smoothly with the position relative to the center of the grid (0-100)
 */
function cellValue(dx: number, dy: number): number {
  const distance = Math.sqrt(dx * dx + dy * dy);
  const raw =
    50 + 28 * Math.sin(dx * 3.2) * Math.cos(dy * 3.2) + 24 * Math.exp(-distance * distance * 1.6);
  return Math.round(Math.min(100, Math.max(0, raw)));
}

/**
 * Creates grid polygons around the given center.
 *
 * @param centerLng Longitude of the center
 * @param centerLat Latitude of the center
 */
export function createGridFeatures(centerLng: number, centerLat: number): DatasetRow[] {
  const { cols, rows, cellLng, cellLat } = DEMO_GRID;
  const originLng = centerLng - (cols * cellLng) / 2;
  const originLat = centerLat - (rows * cellLat) / 2;

  const features: DatasetRow[] = [];
  for (let row = 0; row < rows; row++) {
    const y0 = originLat + row * cellLat;
    const y1 = y0 + cellLat;
    const dy = (row - rows / 2) / (rows / 2);

    for (let col = 0; col < cols; col++) {
      const x0 = originLng + col * cellLng;
      const x1 = x0 + cellLng;
      const dx = (col - cols / 2) / (cols / 2);

      features.push({
        type: 'Feature',
        id: `demo-grid-${row}-${col}`,
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [x0, y0],
              [x1, y0],
              [x1, y1],
              [x0, y1],
              [x0, y0],
            ],
          ],
        },
        properties: {
          name: `Cell ${row}-${col}`,
          row,
          col,
          value: cellValue(dx, dy),
        },
        style: GRID_STYLE,
      });
    }
  }
  return features;
}
