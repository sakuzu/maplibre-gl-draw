// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The geometry of one row as the rows are built and written
 *
 * The builder of the row groups and the writes of the rows in place read a GeoJSON geometry the
 * same way: its coordinates in one array, the sizes of its rings and parts, and the triangles of
 * its fills. Keeping both on these functions keeps the triangles of a row written in place the
 * ones the builder would have made.
 *
 * A pure module: it depends on nothing outside `/table` but the circle of the geometry, so it
 * runs in a Worker as well.
 */

import earcut from 'earcut';
import type { Geometry, Position } from 'geojson';
import { generateCirclePolygon } from '../geometry/circle.js';
import { polygonRingRuns } from './polygon-rings.js';
import type { GeometryType, TableGeometry } from './types.js';

/** The number of vertices of a fill below which its indices take 16 bits */
export const WIDE_VERTICES = 65_536;

/**
 * The geometry of one row: its coordinates and the sizes of its levels
 *
 * @internal
 */
export interface RowGeometry {
  readonly type: GeometryType;
  /** The coordinates (two values each) */
  readonly coords: Float64Array;
  /**
   * The sizes of the levels: [] for Point, LineString and MultiPoint; the number of coordinates
   * of each ring (part) for Polygon and MultiLineString and MultiPolygon
   */
  readonly parts: readonly number[];
  /** The number of rings per polygon of a MultiPolygon */
  readonly polygons: readonly number[];
}

/**
 * The geometry of a row from a GeoJSON geometry
 *
 * @throws when the geometry is not of one of the six types a row holds
 * @internal
 */
export function toRowGeometry(geometry: Geometry): RowGeometry {
  const positions: number[] = [];
  const push = (position: Position): void => {
    positions.push(Number(position[0]), Number(position[1]));
  };
  const parts: number[] = [];
  const polygons: number[] = [];
  switch (geometry.type) {
    case 'Point':
      push(geometry.coordinates);
      break;
    case 'LineString':
    case 'MultiPoint':
      for (const position of geometry.coordinates) push(position);
      break;
    case 'Polygon':
    case 'MultiLineString':
      for (const ring of geometry.coordinates) {
        for (const position of ring) push(position);
        parts.push(ring.length);
      }
      break;
    case 'MultiPolygon':
      for (const polygon of geometry.coordinates) {
        for (const ring of polygon) {
          for (const position of ring) push(position);
          parts.push(ring.length);
        }
        polygons.push(polygon.length);
      }
      break;
    default:
      throw new Error(`RowGroupBuilder: a ${geometry.type} geometry cannot be a row`);
  }
  return { type: geometry.type, coords: Float64Array.from(positions), parts, polygons };
}

/**
 * The offsets from a ring to its first coordinate, over every ring of a polygon geometry
 *
 * @internal
 */
export function ringOffsetsOf(geometry: RowGeometry): Int32Array {
  const offsets = new Int32Array(geometry.parts.length + 1);
  for (let i = 0; i < geometry.parts.length; i++) offsets[i + 1] = offsets[i] + geometry.parts[i];
  return offsets;
}

/**
 * The rings of each polygon of a polygon geometry, as `[first ring, end ring)`
 *
 * @internal
 */
export function polygonRanges(geometry: RowGeometry): Array<[number, number]> {
  if (geometry.type === 'Polygon') return [[0, geometry.parts.length]];
  const out: Array<[number, number]> = [];
  let ring = 0;
  for (const count of geometry.polygons) {
    out.push([ring, ring + count]);
    ring += count;
  }
  return out;
}

/**
 * The coordinates of the ring of a Circle of a center and a radius (null for no ring)
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
 * The triangles of the fills of the polygons of a row, in pairs, as indices into the vertices of
 * its fill (the rings drawn of each polygon in turn, `polygon-rings.ts`)
 *
 * The triangles of each polygon are the ones earcut makes, paired as the fill draws them in
 * strips of 4 vertices (`pairTriangles`): 4 indices per pair, a lone triangle with its third
 * index twice. The pairs of a polygon come before the pairs of the next.
 *
 * @param coords The coordinates (two values each)
 * @param ringOffsets The offsets from a ring to its first coordinate
 * @param polygons The rings of each polygon, `[first, end)`
 * @returns The indices of the pairs and the number of vertices of the fill
 * @internal
 */
export function triangulateRow(
  coords: Float64Array,
  ringOffsets: Int32Array,
  polygons: ReadonlyArray<readonly [number, number]>,
): { indices: number[]; vertices: number } {
  const out: number[] = [];
  const runs: number[] = [];
  let base = 0;
  for (const [ringStart, ringEnd] of polygons) {
    runs.length = 0;
    const count = polygonRingRuns(coords, 2, ringOffsets, ringStart, ringEnd, runs);
    if (count === 0) continue;
    const flat: number[] = new Array(count * 2);
    const holes: number[] = [];
    let at = 0;
    for (let k = 0; k < runs.length; k += 2) {
      if (k > 0) holes.push(at);
      for (let v = runs[k]; v < runs[k + 1]; v++) {
        flat[at * 2] = coords[v * 2];
        flat[at * 2 + 1] = coords[v * 2 + 1];
        at++;
      }
    }
    const triangles = earcut(flat, holes);
    pairTriangles(triangles, 0, triangles.length, 0, (a, b, c, d) => {
      out.push(a + base, b + base, c + base, d + base);
    });
    base += count;
  }
  return { indices: out, vertices: base };
}

/**
 * Pairs the triangles of a polygon that share an edge, for the fill drawn in strips of 4
 * vertices: a pair `(a, b, c, d)` is the triangles `(a, b, c)` and `(c, b, d)`, which share the
 * edge `b, c` and keep the winding of the triangles they were; a triangle without a partner is
 * `(a, b, c, c)` (the second triangle has no area). The triangles of a polygon do not overlap and
 * have one color, so how they are paired changes no pixel.
 *
 * @param triangles The indices of the triangles, 3 per triangle
 * @param from The first index of the triangles of the polygon
 * @param to The end of its indices
 * @param base What the indices of the polygon are counted from (subtracted from them)
 * @param emit Receives each pair (or triangle) as indices counted from `base`
 * @internal
 */
export function pairTriangles(
  triangles: ArrayLike<number>,
  from: number,
  to: number,
  base: number,
  emit: (a: number, b: number, c: number, d: number) => void,
): void {
  const count = (to - from) / 3;
  if (count <= 0) return;
  // The triangle of each directed edge, by its two ends
  const edges = new Map<number, number>();
  let span = 1;
  for (let t = from; t < to; t++) span = Math.max(span, triangles[t] - base + 1);
  const key = (u: number, v: number) => u * span + v;
  for (let t = 0; t < count; t++) {
    const at = from + t * 3;
    const a = triangles[at] - base;
    const b = triangles[at + 1] - base;
    const c = triangles[at + 2] - base;
    edges.set(key(a, b), t);
    edges.set(key(b, c), t);
    edges.set(key(c, a), t);
  }
  const used = new Uint8Array(count);
  for (let t = 0; t < count; t++) {
    if (used[t]) continue;
    used[t] = 1;
    const at = from + t * 3;
    const v = [triangles[at] - base, triangles[at + 1] - base, triangles[at + 2] - base];
    let paired = false;
    // An edge `p, q` of this triangle is shared with the triangle that has `q, p`
    for (let e = 0; e < 3 && !paired; e++) {
      const p = v[e];
      const q = v[(e + 1) % 3];
      const other = edges.get(key(q, p));
      if (other === undefined || used[other]) continue;
      const o = from + other * 3;
      const w = [triangles[o] - base, triangles[o + 1] - base, triangles[o + 2] - base];
      // The corner of the other triangle off the shared edge
      let d = -1;
      for (const x of w) if (x !== p && x !== q) d = x;
      if (d < 0) continue;
      used[other] = 1;
      paired = true;
      // This triangle as (r, p, q): the shared edge is p -> q, its third corner r
      const r = v[(e + 2) % 3];
      emit(r, p, q, d);
    }
    if (!paired) emit(v[0], v[1], v[2], v[2]);
  }
}

/**
 * A geometry column of one row holding a row geometry
 *
 * @internal
 */
export function singleRowColumn(geometry: RowGeometry): TableGeometry {
  const coords = geometry.coords.slice();
  const vertices = coords.length / 2;
  switch (geometry.type) {
    case 'Point':
      return { type: 'Point', coords };
    case 'LineString':
    case 'MultiPoint':
      return { type: geometry.type, coords, offsets: [Int32Array.of(0, vertices)] };
    case 'Polygon':
    case 'MultiLineString': {
      const rings = ringOffsetsOf(geometry);
      return {
        type: geometry.type,
        coords,
        offsets: [Int32Array.of(0, geometry.parts.length), rings],
      };
    }
    case 'MultiPolygon': {
      const polygons = new Int32Array(geometry.polygons.length + 1);
      for (let p = 0; p < geometry.polygons.length; p++) {
        polygons[p + 1] = polygons[p] + geometry.polygons[p];
      }
      return {
        type: 'MultiPolygon',
        coords,
        offsets: [Int32Array.of(0, geometry.polygons.length), polygons, ringOffsetsOf(geometry)],
      };
    }
  }
}
