// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The geometry of the analytic drape (a cache of Mercator coordinates)
 *
 * The binning runs per tile. Converting longitude/latitude into Mercator per tile would mean
 * applying the logarithmic transform of the latitude over and over, and for a dataset on
 * the order of a million vertices such as administrative boundaries it throws away tens of
 * milliseconds on every tile. The conversion is done once here and kept, so that descending to
 * within-tile coordinates takes only a multiplication and a subtraction.
 *
 * In addition, the edges are cut into chunks (blocks) of a fixed number and given bounding
 * boxes. Only a tiny part of a long outline is involved in a single tile, so dropping whole
 * blocks shrinks the amount scanned down to the range that actually matters.
 *
 * The precision is held in Float64. Mercator world coordinates are 0..1, and in Float32 a
 * rounding of several pixels appears within a z16 tile (a relative error of 1.2e-7 amounts to
 * 0.4% of the tile width 1.5e-5).
 */

import type { Coordinate } from '../../../store/types.js';

/** The number of edges in one block */
export const DRAPE_BLOCK_EDGES = 64;

/** The geometry of a single path */
export interface DrapeGeometryPath {
  /** An interleaved array of Mercator coordinates (x, y) */
  readonly xy: Float64Array;
  /** The number of edges (the same as the vertex count for a closed path, the vertex count -
   * 1 for an open one) */
  readonly edgeCount: number;
  /** Whether it is closed (the rings of a polygon are closed) */
  readonly closed: boolean;
  /** The bounding box of each block (minX, minY, maxX, maxY) */
  readonly blocks: Float64Array;
  /**
   * Where the vertices of a quantized path came from (absent on a path of the original
   * geometry)
   *
   * A dashed line keeps the pattern of the original path on a coarse tile: the length along
   * the path at a vertex is that of the original vertex it was rounded from
   * ({@link drapePathStarts}).
   */
  readonly origin?: DrapePathOrigin;
}

/** The original path of a quantized path, and the original vertex of each of its vertices */
export interface DrapePathOrigin {
  readonly path: DrapeGeometryPath;
  readonly vertices: Int32Array;
}

/** The geometry of a single feature */
export interface DrapeGeometry {
  readonly paths: readonly DrapeGeometryPath[];
  readonly edgeCount: number;
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

/** Longitude -> Mercator x */
export function drapeMercatorX(lng: number): number {
  return (lng + 180) / 360;
}

/** Latitude -> Mercator y */
export function drapeMercatorY(lat: number): number {
  const latRad = (lat * Math.PI) / 180;
  return (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2;
}

/**
 * The geometry cache
 *
 * The key is decided by the caller. For a feature in the Store the instance is replaced on
 * every edit, so the feature itself is the key; for a dataset the replacement
 * happens per `setRows` and the coordinate arrays are not reused, so the coordinate array
 * is the key (when applying a style rule rebuilds only the feature instances, the same
 * coordinate arrays remain, so merely changing a color does not require converting a million
 * vertices again).
 */
const cache = new WeakMap<object, DrapeGeometry>();

/** A cache of bounding boxes alone (it allows narrowing tiles down without building the
 * geometry) */
const boundsCache = new WeakMap<object, DrapeBounds>();

/** A Mercator bounding box */
export interface DrapeBounds {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

/**
 * Computes the bounding box alone (with a cache)
 *
 * This is all that is needed to narrow tiles down. The minimum and maximum of the
 * longitude/latitude are taken first and converted into Mercator afterwards, so the logarithm
 * and the tangent are evaluated only four times (converting every vertex takes 76 ms for 1.1
 * million vertices, and that single hit becomes a stutter during a zoom gesture). The Mercator
 * conversion is monotonic in longitude and in latitude separately, so the rectangle obtained
 * in this order agrees with the one obtained by converting every vertex.
 */
export function drapeBoundsOf(
  key: object,
  paths: ReadonlyArray<ReadonlyArray<Coordinate>>,
): DrapeBounds {
  const hit = boundsCache.get(key);
  if (hit) return hit;

  let minLng = Number.POSITIVE_INFINITY;
  let minLat = Number.POSITIVE_INFINITY;
  let maxLng = Number.NEGATIVE_INFINITY;
  let maxLat = Number.NEGATIVE_INFINITY;
  for (const path of paths) {
    for (const point of path) {
      if (point[0] < minLng) minLng = point[0];
      if (point[0] > maxLng) maxLng = point[0];
      if (point[1] < minLat) minLat = point[1];
      if (point[1] > maxLat) maxLat = point[1];
    }
  }

  const bounds: DrapeBounds =
    minLng > maxLng
      ? { minX: 0, minY: 0, maxX: -1, maxY: -1 }
      : {
          minX: drapeMercatorX(minLng),
          // Mercator y decreases as the latitude increases
          minY: drapeMercatorY(maxLat),
          maxX: drapeMercatorX(maxLng),
          maxY: drapeMercatorY(minLat),
        };
  boundsCache.set(key, bounds);
  return bounds;
}

/**
 * Builds the geometry (with a cache)
 *
 * @param key The cache key (it must be identical as long as it points at the same coordinates)
 * @param paths The array of paths. For a polygon, rings with the closing point dropped; for a
 *   line, as it is
 * @param closed Whether to treat them as the rings of a polygon
 */
export function drapeGeometryOf(
  key: object,
  paths: ReadonlyArray<ReadonlyArray<Coordinate>>,
  closed: boolean,
): DrapeGeometry {
  const hit = cache.get(key);
  if (hit) return hit;

  const built = buildDrapeGeometry(paths, closed);
  cache.set(key, built);
  return built;
}

/**
 * Builds the geometry (a pure function that uses no cache)
 */
export function buildDrapeGeometry(
  paths: ReadonlyArray<ReadonlyArray<Coordinate>>,
  closed: boolean,
): DrapeGeometry {
  const converted: Float64Array[] = [];
  for (const path of paths) {
    const count = path.length;
    if (count < 2) continue;
    const xy = new Float64Array(count * 2);
    for (let i = 0; i < count; i++) {
      xy[i * 2] = drapeMercatorX(path[i][0]);
      xy[i * 2 + 1] = drapeMercatorY(path[i][1]);
    }
    converted.push(xy);
  }
  return buildFromMercatorPaths(converted, closed);
}

/**
 * Assembles the geometry from paths in Mercator coordinates
 *
 * @param origins The origin of each path, for quantized geometry (null for a path that has none)
 */
function buildFromMercatorPaths(
  paths: readonly Float64Array[],
  closed: boolean,
  origins?: ReadonlyArray<DrapePathOrigin | null>,
): DrapeGeometry {
  const out: DrapeGeometryPath[] = [];
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let edgeCount = 0;

  for (let p = 0; p < paths.length; p++) {
    const xy = paths[p];
    const count = xy.length / 2;
    if (count < 2) continue;

    for (let i = 0; i < count; i++) {
      const x = xy[i * 2];
      const y = xy[i * 2 + 1];
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }

    const edges = closed ? count : count - 1;
    const blockCount = Math.ceil(edges / DRAPE_BLOCK_EDGES);
    const blocks = new Float64Array(blockCount * 4);
    for (let b = 0; b < blockCount; b++) {
      const from = b * DRAPE_BLOCK_EDGES;
      const to = Math.min(edges, from + DRAPE_BLOCK_EDGES);
      let bx0 = Number.POSITIVE_INFINITY;
      let by0 = Number.POSITIVE_INFINITY;
      let bx1 = Number.NEGATIVE_INFINITY;
      let by1 = Number.NEGATIVE_INFINITY;
      // Edge e is vertices e and e+1 (on a closed path only the last one wraps back to 0)
      for (let e = from; e <= to; e++) {
        const v = e < count ? e : 0;
        const x = xy[v * 2];
        const y = xy[v * 2 + 1];
        if (x < bx0) bx0 = x;
        if (x > bx1) bx1 = x;
        if (y < by0) by0 = y;
        if (y > by1) by1 = y;
      }
      blocks[b * 4] = bx0;
      blocks[b * 4 + 1] = by0;
      blocks[b * 4 + 2] = bx1;
      blocks[b * 4 + 3] = by1;
    }

    const origin = origins?.[p];
    out.push(
      origin
        ? { xy, edgeCount: edges, closed, blocks, origin }
        : { xy, edgeCount: edges, closed, blocks },
    );
    edgeCount += edges;
  }

  if (out.length === 0) {
    return { paths: [], edgeCount: 0, minX: 0, minY: 0, maxX: -1, maxY: -1 };
  }
  return { paths: out, edgeCount, minX, minY, maxX, maxY };
}

/**
 * Quantized geometry for coarse tiles (LOD)
 *
 * Once the pitch is raised, the terrain tiles in the distance become very coarse (measured:
 * a view at map zoom 13.75 with pitch 70 contained one z8 tile, and that single tile contained
 * all 780,000 edges of the 8,172 administrative boundaries). Solving that as is is worth
 * neither the cost of the index nor the memory, and yet that tile is drawn only in a strip on
 * the horizon side of the screen.
 *
 * So the vertices are rounded to a grid that matches the resolution of the tile. Thinning by
 * distance would thin a boundary shared by adjoining polygons separately and open a gap, but
 * rounding to a grid is decided with respect to space, so boundaries that share the same
 * coordinates round to the same point. A polygon left with fewer than 3 points after the
 * rounding is dropped (its size is less than a pixel; the wide-area polygon laid underneath
 * simply shows through).
 *
 * @param level The fineness of the grid. The grid spacing is 2^-level (in Mercator units)
 */
export function drapeQuantizedGeometry(geometry: DrapeGeometry, level: number): DrapeGeometry {
  let cache = quantizedCache.get(geometry);
  if (!cache) {
    cache = new Map();
    quantizedCache.set(geometry, cache);
  }
  const hit = cache.get(level);
  if (hit) return hit;

  const step = 2 ** -level;
  const paths: Float64Array[] = [];
  const origins: Array<DrapePathOrigin | null> = [];
  for (const path of geometry.paths) {
    const source = path.xy;
    const count = source.length / 2;
    const out: number[] = [];
    /** The original vertex of each vertex kept */
    const kept: number[] = [];
    let lastX = Number.NaN;
    let lastY = Number.NaN;
    for (let i = 0; i < count; i++) {
      const qx = Math.round(source[i * 2] / step) * step;
      const qy = Math.round(source[i * 2 + 1] / step) * step;
      if (qx === lastX && qy === lastY) continue;
      out.push(qx, qy);
      kept.push(i);
      lastX = qx;
      lastY = qy;
    }
    if (path.closed) {
      // The convention is to hold no closing point, so a tail coinciding with the head is
      // dropped
      while (out.length >= 6 && out[out.length - 2] === out[0] && out[out.length - 1] === out[1]) {
        out.length -= 2;
        kept.length -= 1;
      }
      if (out.length / 2 < 3) {
        // A polygon collapsed by the rounding is replaced with a square of one grid cell.
        // Dropping it would leave the fill missing just there and produce spotty white
        // blotches (confirmed hands-on, the city center at z8.7; it was pronounced in areas
        // where small polygons at the chome level line up).
        // The error stays within one grid cell (1/256 of a tile = about 2 pixels on screen).
        // It has no origin: a dash pattern on it would be smaller than a pixel anyway
        const box = squareAt(source, step);
        if (box) {
          paths.push(box);
          origins.push(null);
        }
        continue;
      }
    } else if (out.length / 2 < 2) {
      continue;
    }
    paths.push(new Float64Array(out));
    origins.push({ path, vertices: new Int32Array(kept) });
  }

  const built = buildFromMercatorPaths(paths, geometry.paths[0]?.closed ?? true, origins);
  cache.set(level, built);
  return built;
}

/** The cache of quantized geometry (original geometry -> fineness -> geometry) */
const quantizedCache = new WeakMap<DrapeGeometry, Map<number, DrapeGeometry>>();

/**
 * The square of one grid cell put in place of a collapsed polygon
 *
 * Its top left is the center of the original polygon rounded to the grid. The purpose is to
 * avoid leaving the fill missing, so its winding is the same as the outer ring (whether it is
 * clockwise has no effect on the inside/outside test).
 */
function squareAt(source: Float64Array, step: number): Float64Array | null {
  const count = source.length / 2;
  if (count === 0) return null;
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < count; i++) {
    sx += source[i * 2];
    sy += source[i * 2 + 1];
  }
  const cx = Math.round(sx / count / step) * step;
  const cy = Math.round(sy / count / step) * step;
  return new Float64Array([cx, cy, cx + step, cy, cx + step, cy + step, cx, cy + step]);
}

/** The lengths along the paths (path -> the length at each vertex) */
const startsCache = new WeakMap<DrapeGeometryPath, Float64Array>();

/**
 * The length along a path from its first vertex to each of its vertices (Mercator units)
 *
 * Entry `e` is where edge `e` starts on the path, so a dashed line can place its pattern on
 * every edge on its own (on a closed path the last edge, back to the first vertex, starts at
 * the last vertex). It is built only for dashed lines and polygons with a dashed outline, the
 * first time a tile needs it, so a solid line pays nothing for it.
 *
 * A quantized path takes the lengths of the original vertices it was rounded from, so the
 * pattern on a coarse tile stays in step with the pattern on the fine tiles next to it. A
 * square standing in for a collapsed polygon has no original and measures itself.
 */
export function drapePathStarts(path: DrapeGeometryPath): Float64Array {
  const hit = startsCache.get(path);
  if (hit) return hit;

  const count = path.xy.length / 2;
  const starts = new Float64Array(count);
  if (path.origin) {
    const original = drapePathStarts(path.origin.path);
    for (let i = 0; i < count; i++) starts[i] = original[path.origin.vertices[i]];
  } else {
    const xy = path.xy;
    let total = 0;
    for (let i = 1; i < count; i++) {
      total += Math.hypot(xy[i * 2] - xy[i * 2 - 2], xy[i * 2 + 1] - xy[i * 2 - 1]);
      starts[i] = total;
    }
  }
  startsCache.set(path, starts);
  return starts;
}
