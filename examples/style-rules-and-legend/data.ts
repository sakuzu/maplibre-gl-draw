// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// The sample data of style-rules-and-legend: a grid of 5 by 4 blocks, each with a land use
// (`use`) and a population (`population`). One block has no population, to show the color a
// rule gives to a value it cannot read.

import type { FeatureInput } from '@sakuzu/maplibre-gl-draw';

const USES = ['commercial', 'residential', 'residential', 'industrial', 'park'];
const [WEST, SOUTH, SIZE, GAP] = [139.758, 35.674, 0.0034, 0.0004];

export const BLOCKS: FeatureInput[] = Array.from({ length: 20 }, (_, i) => {
  const [col, row] = [i % 5, Math.floor(i / 5)];
  const [lng, lat] = [WEST + col * (SIZE + GAP), SOUTH + row * (SIZE + GAP)];
  const use = USES[(col + row) % USES.length];
  return {
    type: 'Polygon',
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          [lng, lat],
          [lng + SIZE, lat],
          [lng + SIZE, lat + SIZE],
          [lng, lat + SIZE],
          [lng, lat],
        ],
      ],
    },
    properties: {
      name: `Block ${i + 1}`,
      use,
      // A population from 0 to about 14,000, none in a park, and none known for block 8
      ...(i !== 7 && { population: use === 'park' ? 0 : (i * 2753) % 14000 }),
    },
  };
});
