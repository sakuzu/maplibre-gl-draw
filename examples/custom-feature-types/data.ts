// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// The sample data of custom-feature-types: the lines of two routes.

import type { Position } from '@sakuzu/maplibre-gl-draw';

/** The hill route */
export const HILL_ROUTE: Position[] = [
  [139.7, 35.68],
  [139.72, 35.69],
  [139.74, 35.68],
];

/** The river route */
export const RIVER_ROUTE: Position[] = [
  [139.705, 35.672],
  [139.722, 35.676],
  [139.738, 35.671],
];
