// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// The sample data of terrain, in the Alps near Innsbruck: a line across the valley and an area
// on the slope.

import type { Position } from '@sakuzu/maplibre-gl-draw';

/** The line across the valley */
export const ACROSS_THE_VALLEY: Position[] = [
  [11.36, 47.255],
  [11.39, 47.275],
  [11.42, 47.3],
];

/** The area on the slope */
export const ON_THE_SLOPE: Position[][] = [
  [
    [11.4, 47.25],
    [11.43, 47.25],
    [11.43, 47.265],
    [11.4, 47.265],
    [11.4, 47.25],
  ],
];
