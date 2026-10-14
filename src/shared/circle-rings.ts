// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The ring of a Circle held as a row: the circle of its radius in meters around its center in
 * degrees, which the rows draw as its fill and its outline (a `RowRings` of the rows)
 */

import { generateCirclePolygon } from '../geometry/circle.js';
import { drawPropertyKey } from './properties.js';

/** The key of the radius of a Circle in the attributes of a row */
const RADIUS_KEY = drawPropertyKey('radiusMeters');

/** The number of coordinates of the ring of a Circle (its segments and the closing one) */
const CIRCLE_RING_VERTICES = 65;

/**
 * The coordinates of the ring of a Circle of a center and a radius in meters, 2 values each
 * (null for no ring)
 *
 * @internal
 */
export function circleRingCoords(center: [number, number], radius: number): Float64Array | null {
  if (!(radius > 0)) return null;
  const ring = generateCirclePolygon(center, radius);
  if (ring.length === 0) return null;
  const coords = new Float64Array(ring.length * 2);
  for (let i = 0; i < ring.length; i++) {
    coords[i * 2] = ring[i][0];
    coords[i * 2 + 1] = ring[i][1];
  }
  return coords;
}

/**
 * The rings of the Circles held as rows: a row of the type `Circle` draws the circle of its
 * radius in meters (`maplibre-gl-draw:radiusMeters`) around its point in degrees.
 *
 * A Worker that builds the rows of a document (`createRowGroupBuilder`) passes it as `rings`, so
 * that the Circles it builds have the bbox and the triangles of their rings.
 */
export const circleRowRings = {
  draws: (type: string): boolean => type === 'Circle',
  ringOf: (
    type: string,
    x: number,
    y: number,
    value: (key: string) => unknown,
  ): Float64Array | null => {
    if (type !== 'Circle') return null;
    const radius = value(RADIUS_KEY);
    return circleRingCoords([x, y], typeof radius === 'number' ? radius : 0);
  },
  ringVertices: CIRCLE_RING_VERTICES,
};
