// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The ring of a Circle held as a row: the circle of its radius in meters around its center in
 * degrees, which the rows draw as its fill and its outline (a `RowRings` of the rows)
 */

import { generateCirclePolygon } from '../geometry/circle.js';
import { drawPropertyKey } from '../shared/properties.js';
import type { RowRead } from './row-read-type.js';
import type { RowRings } from './row-rings.js';

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
 * The library gives it to the tables and to the builder of their row blocks
 * (`createFeatureRowBlockBuilder`, which a Worker of the host imports) as the rings of the rows,
 * so that the Circles have the bbox and the triangles of their rings.
 */
export const circleRowRings: RowRings = {
  draws: (type: string): boolean => type === 'Circle',
  ringOf: (row: RowRead): Float64Array | null => {
    if (row.type !== 'Circle') return null;
    const shape = row.shape();
    if (shape?.column.type !== 'Point') return null;
    const { coords, stride } = shape.column;
    const radius = row.value(RADIUS_KEY);
    return circleRingCoords(
      [coords[shape.at * stride], coords[shape.at * stride + 1]],
      typeof radius === 'number' ? radius : 0,
    );
  },
  ringVertices: CIRCLE_RING_VERTICES,
  keys: [RADIUS_KEY],
};
