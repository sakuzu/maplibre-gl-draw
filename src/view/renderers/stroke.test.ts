// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for the dash distance of the stroke renderer
 *
 * The cumulative distance is compared with the dash pattern in CSS px, so it is checked as a
 * pure function against an independent Web Mercator projection.
 */

import { describe, expect, it } from 'vitest';
import { strokeDashDistances } from './stroke.js';

/** The screen y of a latitude in CSS px at `zoom` (Web Mercator, 512 px world tile) */
function screenY(lat: number, zoom: number): number {
  const world = 512 * 2 ** zoom;
  return (
    ((180 - (180 / Math.PI) * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360))) / 360) *
    world
  );
}

describe('strokeDashDistances', () => {
  for (const zoom of [10, 14]) {
    for (const lat of [0, 60]) {
      it(`measures CSS px on screen (zoom ${zoom}, latitude ${lat})`, () => {
        const world = 512 * 2 ** zoom;
        // East by exactly 100 CSS px, then north by a small step
        const p1: [number, number] = [10 + (100 / world) * 360, lat];
        const p2: [number, number] = [p1[0], lat + 0.001];
        const north = screenY(lat, zoom) - screenY(lat + 0.001, zoom);

        const distances = strokeDashDistances([[10, lat], p1, p2], zoom);

        expect(distances[0]).toBe(0);
        expect(distances[1] / 100).toBeCloseTo(1, 2);
        expect((distances[2] - distances[1]) / north).toBeCloseTo(1, 2);
      });
    }
  }
});
