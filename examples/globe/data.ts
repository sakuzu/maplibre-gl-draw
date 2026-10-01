// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// The sample data of globe: London, Tokyo (its airport by the bay), the great circle between
// them, and an area across the antimeridian.

import type { Position } from '@sakuzu/maplibre-gl-draw';

/** Points along the great circle from `a` to `b`, in degrees, by spherical interpolation */
function greatCircle(a: [number, number], b: [number, number], steps: number): Position[] {
  const rad = Math.PI / 180;
  const toVector = ([lng, lat]: [number, number]) => [
    Math.cos(lat * rad) * Math.cos(lng * rad),
    Math.cos(lat * rad) * Math.sin(lng * rad),
    Math.sin(lat * rad),
  ];
  const [p, q] = [toVector(a), toVector(b)];
  const angle = Math.acos(p[0] * q[0] + p[1] * q[1] + p[2] * q[2]);
  return Array.from({ length: steps + 1 }, (_, i) => {
    const t = i / steps;
    const [s, u] = [Math.sin((1 - t) * angle), Math.sin(t * angle)];
    const [x, y, z] = p.map((v, k) => (s * v + u * q[k]) / Math.sin(angle));
    return [Math.atan2(y, x) / rad, Math.asin(z) / rad];
  });
}

export const LONDON: [number, number] = [-0.1276, 51.5072];
export const TOKYO: [number, number] = [139.7798, 35.5494];

/** The great circle from London to Tokyo, over the north of Siberia, with 64 edges */
export const GREAT_CIRCLE: Position[] = greatCircle(LONDON, TOKYO, 64);

/**
 * An area across the antimeridian. Its longitudes run on past 180 instead of jumping to -180,
 * as a shape drawn across the line is kept; the GeoJSON written out wraps them
 */
export const ACROSS_THE_ANTIMERIDIAN: Position[][] = [
  [
    [174, -21],
    [186, -21],
    [186, -12],
    [174, -12],
    [174, -21],
  ],
];
