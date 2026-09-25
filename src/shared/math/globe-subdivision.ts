// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The path of an edge on the globe
 *
 * maplibre draws its own layers on the globe the way they look on the Mercator plane: an edge
 * between two vertices is the straight line of the Web Mercator plane, carried onto the sphere
 * (a parallel stays a parallel, a meridian a meridian). It gets there by cutting the geometry
 * finely on the plane before projecting it (its subdivision, `SubdivisionGranularitySetting`).
 * Projecting only the two vertices of an edge would join them with a chord through the sphere.
 *
 * These are the pure parts of doing the same: how finely to cut at a zoom, and the cut itself.
 * The rendering cuts the drawn geometry with them, and hit testing cuts the tested geometry the
 * same way, so what is drawn and what can be clicked follow the same path.
 */

import type { Coordinate } from '../types/model.js';
import { fromPlane, toPlane } from './mercator-plane.js';

/** What is being cut: the fills (and their outlines) or the lines */
export type GlobeSubdivisionKind = 'fill' | 'line';

/**
 * maplibre's granularity on the globe: the number of cells along the side of a tile of zoom 0,
 * halved at each zoom level, and the least it goes down to (`vertical_perspective_projection.ts`)
 */
const GRANULARITY: Record<GlobeSubdivisionKind, { base: number; min: number }> = {
  fill: { base: 128, min: 2 },
  line: { base: 512, min: 1 },
};

/**
 * The side of a subdivision cell on the globe, in Mercator world units (1 = the world)
 *
 * The tile zoom is the integer part of the zoom, as maplibre picks the tiles it cuts. A cell
 * is the world divided by the base granularity up to the zoom where a tile reaches its least
 * granularity, and half a tile (fills) or a tile (lines) beyond. It changes only when the zoom
 * crosses an integer, so what is cut for it stays valid while zooming within a level.
 *
 * @param zoom The zoom of the map
 * @param kind Fills or lines
 * @returns The side of a cell (a power of two fraction of the world)
 */
export function globeSubdivisionGrid(zoom: number, kind: GlobeSubdivisionKind): number {
  const z = Math.min(Math.max(0, Math.floor(Number.isFinite(zoom) ? zoom : 0)), 30);
  const { base, min } = GRANULARITY[kind];
  const tiles = 2 ** z;
  const cells = Math.max(Math.floor(base / tiles), min, 1);
  return 1 / (tiles * cells);
}

/**
 * The point at `t` along the straight line of the Mercator plane from `a` to `b`
 *
 * The longitude moves linearly; the latitude moves linearly in Mercator y, not in degrees.
 * Latitudes beyond the Mercator limit are clamped to it.
 */
export function mercatorLerp(a: Coordinate, b: Coordinate, t: number): Coordinate {
  const [ax, ay] = toPlane(a);
  const [bx, by] = toPlane(b);
  return fromPlane(ax + (bx - ax) * t, ay + (by - ay) * t);
}

/**
 * The midpoint of an edge as drawn: halfway across in longitude, on the edge
 *
 * An edge is drawn along the straight line of the Mercator plane, so the average of the two
 * latitudes in degrees lies off a long slanted edge (on the Mercator map as on the globe). The
 * point returned lies on the drawn edge at the average longitude. An edge along a meridian or
 * a parallel keeps the plain average, which lies on it already.
 */
export function mercatorMidpoint(a: Coordinate, b: Coordinate): Coordinate {
  const lng = (a[0] + b[0]) / 2;
  if (a[0] === b[0] || a[1] === b[1]) return [lng, (a[1] + b[1]) / 2];
  const y = (toPlane(a)[1] + toPlane(b)[1]) / 2;
  return [lng, fromPlane(0, y)[1]];
}

/**
 * The length of an edge on the Mercator plane, in world units
 */
export function mercatorEdgeLength(a: Coordinate, b: Coordinate): number {
  const [ax, ay] = toPlane(a);
  const [bx, by] = toPlane(b);
  return Math.hypot(bx - ax, by - ay);
}

/**
 * Cuts every edge of a path into pieces of at most `grid` along the Mercator plane
 *
 * Each edge is cut into equal pieces on the plane, so every point added lies on the edge as it
 * is drawn. The vertices of the path are kept. A path whose edges are all shorter than `grid`
 * is returned as it is (the same array).
 *
 * @param path The vertices `[lng, lat]` in degrees
 * @param grid The longest piece, in Mercator world units (0 or less cuts nothing)
 * @param maxPoints The most points to add over the whole path
 * @returns The path with the points added
 */
export function densifyOnMercatorPlane(
  path: readonly Coordinate[],
  grid: number,
  maxPoints = 1 << 16,
): Coordinate[] {
  if (path.length < 2 || !(grid > 0)) return path as Coordinate[];

  let out: Coordinate[] | null = null;
  let budget = maxPoints;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1];
    const b = path[i];
    const [ax, ay] = toPlane(a);
    const [bx, by] = toPlane(b);
    const pieces = Math.min(Math.ceil(Math.hypot(bx - ax, by - ay) / grid), budget + 1);
    if (pieces > 1) {
      out ??= path.slice(0, i) as Coordinate[];
      for (let k = 1; k < pieces; k++) {
        const t = k / pieces;
        out.push(fromPlane(ax + (bx - ax) * t, ay + (by - ay) * t));
      }
      budget -= pieces - 1;
    }
    out?.push(b);
  }
  return out ?? (path as Coordinate[]);
}
