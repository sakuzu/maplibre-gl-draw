// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// The sample data of 200000-features: a made-up town of 500 x 400 plots east of Tokyo
// Station, from Nihonbashi to Ichikawa, each with a building of its own size, place and number
// of floors.

import type { Feature, FeatureCollection, Polygon } from 'geojson';

/** The center of the town and of the map */
export const CENTER: [number, number] = [139.87, 35.69];

const COLUMNS = 500;
const ROWS = 400;
const PLOT = 0.0004; // degrees, about 40 m

/** The town, the same on every call: the random numbers start from the same seed */
export function createTown(): FeatureCollection<Polygon> {
  let seed = 42;
  const random = (): number => {
    seed = (seed * 16_807) % 2_147_483_647;
    return seed / 2_147_483_647;
  };
  const features: Feature<Polygon>[] = [];
  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLUMNS; col++) {
      const west = CENTER[0] + (col - COLUMNS / 2) * PLOT + random() * PLOT * 0.3;
      const south = CENTER[1] + (row - ROWS / 2) * PLOT * 0.8 + random() * PLOT * 0.2;
      const width = PLOT * (0.3 + random() * 0.35);
      const depth = PLOT * 0.8 * (0.3 + random() * 0.35);
      const ring = [
        [west, south],
        [west + width, south],
        [west + width, south + depth],
        [west, south + depth],
        [west, south],
      ];
      const floors = 1 + Math.floor(random() ** 3 * 30);
      features.push({
        type: 'Feature',
        geometry: { type: 'Polygon', coordinates: [ring] },
        properties: { name: `Building ${row * COLUMNS + col + 1}`, floors },
      });
    }
  }
  return { type: 'FeatureCollection', features };
}
