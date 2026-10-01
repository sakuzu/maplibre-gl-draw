// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// The sample data of datasets: 250 x 200 square cells east of Tokyo Station, from Nihonbashi
// to Ichikawa, each with a value from 0 to 100.

import type { DatasetRow } from '@sakuzu/maplibre-gl-draw';

/** The center of the cells and of the map */
export const CENTER: [number, number] = [139.845, 35.685];

/** The side of a cell, in degrees of longitude */
const SIZE = 0.0006;

/** The cells, made on each call */
export function createCells(): DatasetRow[] {
  const cells: DatasetRow[] = [];
  for (let row = 0; row < 200; row++) {
    for (let col = 0; col < 250; col++) {
      const [x, y] = [CENTER[0] + (col - 125) * SIZE, CENTER[1] + (row - 100) * SIZE * 0.8];
      const value = Math.round(
        50 + 30 * Math.sin(col / 17) * Math.cos(row / 13) + 20 * Math.sin((col + row) / 40),
      );
      const ring = [
        [x, y],
        [x + SIZE, y],
        [x + SIZE, y + SIZE * 0.8],
        [x, y + SIZE * 0.8],
        [x, y],
      ];
      cells.push({
        type: 'Feature',
        id: `cell-${row}-${col}`,
        geometry: { type: 'Polygon', coordinates: [ring] },
        properties: { value },
      });
    }
  }
  return cells;
}
