// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tessellation for terrain
 *
 * On terrain, a long segment sinks into the ground where it crosses a valley and floats
 * above a ridge. Since elevation can only be given to vertices, the only option is to cut
 * segments and triangles finely and give elevation to the split points as well.
 *
 * ## Why we align with "the lattice of MapLibre's terrain mesh"
 *
 * If the step were an arbitrary interval, we would be sampling the same DEM with "two
 * triangulations that know nothing about each other". Neither the vertex positions nor the
 * directions of the triangle diagonals would agree, so the two surfaces would never agree
 * exactly anywhere, and the discrepancy is largest where the twist inside a DEM cell is
 * largest -- at the creases of a slope. Making the tessellation finer only makes the
 * discrepancy asymptotically smaller, never zero, and a constant lift cannot cover it.
 *
 * So we place the split points on the lattice nodes of MapLibre's terrain mesh themselves.
 * MapLibre draws terrain on a regular lattice that divides one tile into `terrain.meshSize`
 * (128 by default) parts, so the nodes line up at multiples of 1/(2^z * meshSize) in
 * Mercator coordinates. On a node both elevations become the same interpolated value of the
 * same DEM, so the surfaces agree. We also match the direction of the cell diagonal to
 * MapLibre (getTerrainMesh splits along the main diagonal (x, y) -> (x+1, y+1)), so they
 * agree inside a cell as well. All that remains is floating point rounding, and that can be
 * covered with a depth bias.
 *
 * The lattice is defined in Mercator space, so the tessellation is done in Mercator space
 * too. A lattice with equal intervals in longitude and latitude does not sit on the Mercator
 * lattice (the latitude direction is non-linear). Input and output stay in longitude and
 * latitude; only the internals move to Mercator.
 *
 * This code is only reached when terrain is enabled. When it is disabled the caller passes
 * straight through, so the result is byte-for-byte identical to the conventional rendering.
 */

import type { Coordinate } from '../../store/types.js';

/**
 * A rectangle in Web Mercator coordinates (0..1 across the world, y growing southward).
 */
export interface MercatorRect {
  /** The west edge */
  readonly x0: number;
  /** The north edge */
  readonly y0: number;
  /** The east edge */
  readonly x1: number;
  /** The south edge */
  readonly y1: number;
}

/**
 * How finely a line or a fill is subdivided to follow the terrain mesh, as
 * {@link getTerrainTessellationStep} returns it.
 */
export interface TessellationStep {
  /**
   * Lattice interval (in Mercator units)
   *
   * The node interval of MapLibre's terrain mesh, 1/(2^z * meshSize), or that value
   * coarsened by a power of two. Even when coarsened it still sits on a subset of the nodes.
   */
  readonly grid: number;
  /** Upper limit on the number of vertices that may be generated */
  readonly maxPoints: number;
  /**
   * The area that may be tessellated (in Mercator; null means no area = split anywhere)
   *
   * Elevation is read from the DEM atlas, but the atlas only covers the neighbourhood of
   * the view, and outside it the value saturates at the edge value (`dem_elevation_meters`
   * in `shaders/helpers.ts` clamps the uv). In other words, splitting finely outside the
   * atlas only splits a flat surface finely while it stays flat, and the elevation does not
   * change by a single metre.
   *
   * Splitting there anyway was the root of the slowness. With a dataset
   * (8,172 administrative boundaries, all of Japan), the cost of splitting even the features
   * that never appear on screen ate up the batch's tessellation budget, and the uniform
   * coarsening applied to stay within the budget (up to 64x) reached even the features on
   * screen. The chord of a coarse triangle dives below a hill, gets cut away by the depth
   * test, and a hole opens in the fill.
   *
   * So we limit the area we split to the atlas (plus a margin). The cost is decided by how
   * wide the view is and no longer depends on the number of records, so what is on screen
   * can always be split at the finest step.
   */
  readonly region?: MercatorRect | null;
  /**
   * The actual mesh step of each terrain tile (if null, `grid` is used everywhere)
   *
   * MapLibre's terrain is drawn with a fixed lattice per tile, and in a pitched view the
   * more distant the view is, the coarser the zoom of the tiles used. Matching the step to
   * the tile's actual mesh makes our own surface agree with MapLibre's both on the nodes and
   * inside the cells. If it is not matched, too fine a step sinks along the valley bottoms
   * and too coarse a step dives under the ridges, and both are cut away by depth.
   */
  readonly tiling?: TessellationTiling | null;
  /**
   * The coarsening factor applied to the tile step (a power of two; 1 = the actual mesh)
   *
   * Splitting at the actual mesh itself is ideal, but in a wide view the amount to split
   * jumps. As long as we coarsen by a power of two, the split points keep sitting on a
   * subset of the actual mesh nodes, so the problem of sinking along the valley bottoms does
   * not occur (sinking happens when we leave the nodes). What remains is only that the chord
   * dives slightly under a ridge, and that can be covered with a depth bias proportional to
   * the step. Keep the factor small (TERRAIN_MAX_TILED_COARSEN).
   */
  readonly coarsen?: number;
}

/**
 * The subdivision step of each terrain tile, indexed by a grid of cells.
 *
 * The set of tiles is indexed by cells the size of the finest tile. A coarse tile spans
 * several cells, but a cell boundary always lies on one of that tile's mesh lines (the side
 * length of the finest tile is an integer multiple of the mesh interval), so cutting along
 * the cells does not create a seam.
 */
export interface TessellationTiling {
  /** The area the index covers (in Mercator) */
  readonly rect: MercatorRect;
  /** The side length of an index cell (= the side length of the finest tile) */
  readonly cell: number;
  /** The number of cell columns */
  readonly cols: number;
  /** The number of cell rows */
  readonly rows: number;
  /** The step of each cell (0 = there is no tile = do not split) */
  readonly grids: Float64Array;
}

/**
 * Whether the rectangles intersect
 */
export function rectsIntersect(
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
  region: MercatorRect,
): boolean {
  return minX <= region.x1 && maxX >= region.x0 && minY <= region.y1 && maxY >= region.y0;
}

/**
 * Whether the rectangle `outer` wholly contains the rectangle `inner`
 */
export function containsRect(outer: MercatorRect, inner: MercatorRect): boolean {
  return (
    outer.x0 <= inner.x0 && outer.y0 <= inner.y0 && outer.x1 >= inner.x1 && outer.y1 >= inner.y1
  );
}

/**
 * Expand a rectangle outwards by `margin` as a ratio of its side lengths
 */
export function expandRect(rect: MercatorRect, margin: number): MercatorRect {
  const dx = (rect.x1 - rect.x0) * margin;
  const dy = (rect.y1 - rect.y0) * margin;
  return { x0: rect.x0 - dx, y0: rect.y0 - dy, x1: rect.x1 + dx, y1: rect.y1 + dy };
}

/**
 * The intersection of two rectangles (null if they do not intersect)
 */
export function intersectRect(a: MercatorRect, b: MercatorRect): MercatorRect | null {
  const x0 = Math.max(a.x0, b.x0);
  const y0 = Math.max(a.y0, b.y0);
  const x1 = Math.min(a.x1, b.x1);
  const y1 = Math.min(a.y1, b.y1);
  if (x1 <= x0 || y1 <= y0) return null;
  return { x0, y0, x1, y1 };
}

/**
 * Convert the DEM atlas uniform representation [x0, y0, 1/width, 1/height] into a rectangle
 */
export function atlasCoverage(rect: readonly [number, number, number, number]): MercatorRect {
  const width = rect[2] > 0 ? 1 / rect[2] : 0;
  const height = rect[3] > 0 ? 1 / rect[3] : 0;
  return { x0: rect[0], y0: rect[1], x1: rect[0] + width, y1: rect[1] + height };
}

/**
 * The number of lattice cells a bounding box touches within the area (an estimate)
 *
 * We do not split outside the area, so it is left out of the cost estimate too.
 */
export function cellsInRegion(
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
  grid: number,
  region: MercatorRect | null | undefined,
): number {
  if (!(grid > 0)) return 0;

  let x0 = minX;
  let y0 = minY;
  let x1 = maxX;
  let y1 = maxY;
  if (region) {
    x0 = Math.max(x0, region.x0);
    y0 = Math.max(y0, region.y0);
    x1 = Math.min(x1, region.x1);
    y1 = Math.min(y1, region.y1);
    if (x1 < x0 || y1 < y0) return 0;
  }
  return ((x1 - x0) / grid) * ((y1 - y0) / grid);
}

/** The result of the triangulation */
export interface TessellatedFill {
  flatCoords: number[];
  indices: number[];
  /**
   * Whether the step was too fine to split through
   *
   * When true, the result contains triangles that are "left as they were (flat triangles
   * that do not follow the terrain)". Either the vertex budget ran out, or one triangle
   * covered too many cells. A flat triangle is visible as a wedge piercing the terrain, so
   * the caller must coarsen the step and split again (tessellatePolygonFill in
   * terrain/polygon.ts). It is exactly this mixture of "fine in places, flat in the rest"
   * that is the real cause of the visual breakdown.
   */
  overflowed: boolean;
  /**
   * By what factor the step has to be coarsened to split through (1 = it split through as
   * it was)
   *
   * Repeating "it did not split through, so double it and try again" means that for a huge
   * feature (a municipal boundary with 130,000 vertices, for example) the work is redone
   * every time up to the limit of 6 rounds, spending hundreds of milliseconds on a single
   * feature. The factor we need follows directly from the amount that overflowed, so we
   * return it and get it right in one go.
   */
  overflowFactor: number;
}

/** Upper limit on the number of lattice cells one triangle may cover (a runaway guard) */
const MAX_CELLS_PER_TRIANGLE = 65536;

/** Longitude -> Mercator x */
export function mercatorX(lng: number): number {
  return (lng + 180) / 360;
}

/** Latitude -> Mercator y */
export function mercatorY(lat: number): number {
  const latRad = (lat * Math.PI) / 180;
  return (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2;
}

/** Mercator x -> longitude */
export function lngFromMercatorX(x: number): number {
  return x * 360 - 180;
}

/** Mercator y -> latitude */
export function latFromMercatorY(y: number): number {
  return (Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180) / Math.PI;
}

/**
 * Inserts vertices where a line crosses the lattice of the terrain mesh, so that it follows
 * the terrain when each vertex is lifted.
 *
 * The original vertices are always kept, and only the intersections with the lattice lines
 * are inserted. The intersections are found by linear interpolation in Mercator space
 * (rendering also draws a straight line after projection, so an inserted point always lies
 * on the original line).
 *
 * @param path The vertices `[lng, lat]` in degrees
 * @param step The step from {@link getTerrainTessellationStep}
 * @returns The densified vertices. The input itself for fewer than 2 positions or a step of
 *   0; insertion stops when `step.maxPoints` is reached
 */
export function densifyPath(path: readonly Coordinate[], step: TessellationStep): Coordinate[] {
  if (path.length < 2 || !(step.grid > 0)) return path as Coordinate[];

  const out: Coordinate[] = [path[0]];
  let budget = step.maxPoints;

  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1];
    const b = path[i];
    if (budget > 0) {
      const inserted = crossingPoints(a, b, step.grid, budget, step.region);
      for (const point of inserted) out.push(point);
      budget -= inserted.length;
    }
    out.push(b);
  }

  return out;
}

/**
 * Densify an array of rings along the lattice
 *
 * A ring is closed, so the edge that goes back from the end to the start is split too.
 *
 * @internal
 */
export function densifyRings(
  rings: readonly Coordinate[][],
  step: TessellationStep,
): Coordinate[][] {
  if (!(step.grid > 0)) return rings as Coordinate[][];

  return rings.map((ring) => {
    if (ring.length < 3) return ring;
    // Regardless of whether a closing point is present, add one "edge back to the start",
    // densify, then drop the closing point
    const closed: Coordinate[] = [...ring, ring[0]];
    const dense = densifyPath(closed, step);
    dense.pop();
    return dense;
  });
}

/**
 * Return the points where the edge (a, b) crosses the lattice lines, in order from a to b
 */
function crossingPoints(
  a: Coordinate,
  b: Coordinate,
  grid: number,
  budget: number,
  region?: MercatorRect | null,
): Coordinate[] {
  const ax = mercatorX(a[0]);
  const ay = mercatorY(a[1]);
  const bx = mercatorX(b[0]);
  const by = mercatorY(b[1]);

  // An edge outside the area is not split (the elevation saturates at the edge value, so
  // there is no point in splitting it)
  if (
    region &&
    !rectsIntersect(Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by), region)
  ) {
    return [];
  }

  const ts: number[] = [];
  collectAxisCrossings(ax, bx, grid, ts);
  collectAxisCrossings(ay, by, grid, ts);
  if (ts.length === 0) return [];

  ts.sort((x, y) => x - y);

  const points: Coordinate[] = [];
  let previous = -1;
  for (const t of ts) {
    if (t <= 0 || t >= 1 || t === previous) continue;
    if (points.length >= budget) break;
    previous = t;
    const mx = ax + (bx - ax) * t;
    const my = ay + (by - ay) * t;
    points.push([lngFromMercatorX(mx), latFromMercatorY(my)]);
  }
  return points;
}

/**
 * Collect the parameters of the intersections with the lattice lines for one axis
 */
function collectAxisCrossings(v0: number, v1: number, grid: number, out: number[]): void {
  if (!(grid > 0) || v0 === v1) return;

  const lo = Math.min(v0, v1);
  const hi = Math.max(v0, v1);
  const first = Math.floor(lo / grid) + 1;
  const last = Math.ceil(hi / grid) - 1;
  if (last < first) return;

  // If the step is so fine that the intersections explode, give up (the caller's upper
  // limit protects us)
  if (last - first > 100000) return;

  for (let k = first; k <= last; k++) {
    const value = k * grid;
    const t = (value - v0) / (v1 - v0);
    if (t > 0 && t < 1) out.push(t);
  }
}

/**
 * Subdivide the result of a triangulation along the lattice of the terrain mesh
 *
 * @param flatCoords The flattened coordinate array ([lng, lat, ...])
 * @param indices The index array of the triangles
 *
 * @internal
 */
export function subdivideTriangles(
  flatCoords: readonly number[],
  indices: readonly number[],
  step: TessellationStep,
): TessellatedFill {
  if (indices.length === 0 || !(step.grid > 0)) {
    return {
      flatCoords: [...flatCoords],
      indices: [...indices],
      overflowed: false,
      overflowFactor: 1,
    };
  }

  const pool = new VertexPool(flatCoords, step.maxPoints);
  const out: number[] = [];
  const tiling = step.tiling ?? null;
  const coarsen = step.coarsen && step.coarsen > 1 ? step.coarsen : 1;
  // Raised if there is even one triangle that was "emitted as it was, without splitting"
  let overflowed = false;
  // The step factor needed to split through (derived from the amount that overflowed)
  let overflowFactor = 1;

  for (let i = 0; i + 2 < indices.length; i += 3) {
    const triangle = [indices[i], indices[i + 1], indices[i + 2]];
    if (pool.exhausted()) {
      overflowed = true;
      pushOriented(out, pool, triangle[0], triangle[1], triangle[2]);
      continue;
    }

    let minX = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (const index of triangle) {
      const x = pool.x(index);
      const y = pool.y(index);
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }

    // Outside the area, emit as it is (splitting would not change the elevation, so this is
    // not a breakdown).
    if (step.region && !rectsIntersect(minX, minY, maxX, maxY, step.region)) {
      emitFan(triangle, 3, pool, out);
      continue;
    }

    // A triangle that straddles the area is cut into the part inside and the part outside
    // before being split.
    //
    // Without that cut, covering every cell of the whole bounding box means that a single
    // triangle of a large feature (a municipal boundary, the outline of a country) holds
    // hundreds of millions of cells, and one build of a retained batch turns into seconds
    // or tens of seconds (measured at 6.8 seconds for one chunk). Holding the cells we
    // cover to the inside of the area alone caps the cost at how wide the view is.
    //
    // The outside is emitted as convex polygon fragments, as they are, without splitting.
    // Outside the area the elevation saturates at the edge value so there is no point in
    // splitting, and a fragment shares its edges with the original triangle, so neither
    // gaps nor overlaps arise.
    let piece: readonly number[] | Int32Array = triangle;
    let pieceLength = 3;
    if (step.region) {
      pieceLength = clipToRegion(triangle, 3, pool, step.region, minX, minY, maxX, maxY, out);
      if (pieceLength < 3) continue;
      piece = regionBuffer;
      minX = Number.POSITIVE_INFINITY;
      maxX = Number.NEGATIVE_INFINITY;
      minY = Number.POSITIVE_INFINITY;
      maxY = Number.NEGATIVE_INFINITY;
      for (let k = 0; k < pieceLength; k++) {
        const x = pool.x(piece[k]);
        const y = pool.y(piece[k]);
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }

    if (!tiling) {
      subdividePiece(piece, pieceLength, pool, step.grid, minX, minY, maxX, maxY, out);
      if (pieceOverflowed) {
        overflowed = true;
        if (pieceOverflowFactor > overflowFactor) overflowFactor = pieceOverflowFactor;
      }
      continue;
    }

    // Cut along each cell of the tile index and split with that cell's step.
    //
    // An index cell has the size of the finest tile, and a coarse tile occupies an integer
    // multiple of it. A cell boundary always lies on that tile's mesh lines, so cutting at
    // the boundary only adds nodes and does not create a seam.
    const ix0 = Math.max(0, Math.floor((minX - tiling.rect.x0) / tiling.cell));
    const ix1 = Math.min(tiling.cols - 1, Math.floor((maxX - tiling.rect.x0) / tiling.cell));
    const iy0 = Math.max(0, Math.floor((minY - tiling.rect.y0) / tiling.cell));
    const iy1 = Math.min(tiling.rows - 1, Math.floor((maxY - tiling.rect.y0) / tiling.cell));
    if (ix1 < ix0 || iy1 < iy0) {
      // Outside the index (where there is no tile), emit as it is
      emitFan(piece, pieceLength, pool, out);
      continue;
    }

    for (let iy = iy0; iy <= iy1; iy++) {
      for (let ix = ix0; ix <= ix1; ix++) {
        const tileGrid = tiling.grids[iy * tiling.cols + ix] * coarsen;
        const tx0 = tiling.rect.x0 + ix * tiling.cell;
        const ty0 = tiling.rect.y0 + iy * tiling.cell;
        const tx1 = tx0 + tiling.cell;
        const ty1 = ty0 + tiling.cell;

        // If it fits within a single index cell we can do without cutting (most features)
        let sub: readonly number[] | Int32Array = piece;
        let subLength = pieceLength;
        let sminX = minX;
        let sminY = minY;
        let smaxX = maxX;
        let smaxY = maxY;
        const contained = minX >= tx0 && maxX <= tx1 && minY >= ty0 && maxY <= ty1;
        if (!contained) {
          subLength = clipHalfPlane(piece, pieceLength, tileBufferA, pool, 0, tx0, false);
          if (subLength < 3) continue;
          subLength = clipHalfPlane(tileBufferA, subLength, tileBufferB, pool, 0, tx1, true);
          if (subLength < 3) continue;
          subLength = clipHalfPlane(tileBufferB, subLength, tileBufferA, pool, 1, ty0, false);
          if (subLength < 3) continue;
          subLength = clipHalfPlane(tileBufferA, subLength, tileBufferB, pool, 1, ty1, true);
          if (subLength < 3) continue;
          sub = tileBufferB;
          sminX = Number.POSITIVE_INFINITY;
          smaxX = Number.NEGATIVE_INFINITY;
          sminY = Number.POSITIVE_INFINITY;
          smaxY = Number.NEGATIVE_INFINITY;
          for (let k = 0; k < subLength; k++) {
            const x = pool.x(sub[k]);
            const y = pool.y(sub[k]);
            if (x < sminX) sminX = x;
            if (x > smaxX) smaxX = x;
            if (y < sminY) sminY = y;
            if (y > smaxY) smaxY = y;
          }
        }

        if (!(tileGrid > 0)) {
          // A cell with no tile is not split (the elevation saturates at the atlas edge
          // value)
          emitFan(sub, subLength, pool, out);
          continue;
        }

        subdividePiece(sub, subLength, pool, tileGrid, sminX, sminY, smaxX, smaxY, out);
        if (pieceOverflowed) {
          overflowed = true;
          if (pieceOverflowFactor > overflowFactor) overflowFactor = pieceOverflowFactor;
        }
      }
    }
  }

  if (pool.exhausted()) {
    const needed = pool.overflowRatio();
    if (needed > overflowFactor) overflowFactor = needed;
  }
  return {
    flatCoords: pool.output(),
    indices: out,
    overflowed: overflowed || pool.exhausted(),
    overflowFactor,
  };
}

/** A note for subdividePiece to report that it "could not split through" */
let pieceOverflowed = false;
/** The "necessary coarsening factor" that subdividePiece worked out */
let pieceOverflowFactor = 1;

/**
 * Split one convex polygon along the lattice of the given step and emit it
 *
 * For each cell we cut "the original polygon". Since what we cut is always the same, the
 * intersections produced when the neighbouring triangle that shares an edge cuts the same
 * cell agree down to the last bit (they do not depend on the order). With a scheme that
 * recursively cuts in half, the order of the cuts differs between neighbours, so the
 * intersections drift slightly and a T-junction appears.
 */
function subdividePiece(
  poly: readonly number[] | Int32Array,
  polyLength: number,
  pool: VertexPool,
  grid: number,
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
  out: number[],
): void {
  pieceOverflowed = false;
  pieceOverflowFactor = 1;

  const cx0 = Math.floor(minX / grid);
  const cx1 = Math.floor(maxX / grid);
  const cy0 = Math.floor(minY / grid);
  const cy1 = Math.floor(maxY / grid);

  // If it fits within a single cell there is no need to split (this is not a breakdown).
  // Anything that covers too many cells has to be emitted as it is, but that is a flat
  // surface that does not follow the terrain, so we report it as a breakdown and have the
  // caller coarsen the step and split again.
  const cellCount = (cx1 - cx0 + 1) * (cy1 - cy0 + 1);
  if (cellCount <= 1) {
    emitFan(poly, polyLength, pool, out);
    return;
  }
  if (cellCount > MAX_CELLS_PER_TRIANGLE) {
    pieceOverflowed = true;
    // The number of cells falls with the square of the step
    pieceOverflowFactor = Math.sqrt(cellCount / MAX_CELLS_PER_TRIANGLE);
    emitFan(poly, polyLength, pool, out);
    return;
  }

  // A sign that absorbs the orientation (clockwise / counter-clockwise)
  const orientation = signedAreaSign(poly, polyLength, pool);

  // Remember the numbers of the lattice nodes row by row. Neighbouring cells share two
  // nodes, and the rows above and below share a whole row, so each node only has to be
  // registered once.
  const nodeWidth = cx1 - cx0 + 2;
  let nodesLow = ensureNodeRow(0, nodeWidth);
  let nodesHigh = ensureNodeRow(1, nodeWidth);
  nodesLow.fill(-1, 0, nodeWidth);
  nodesHigh.fill(-1, 0, nodeWidth);

  for (let cy = cy0; cy <= cy1; cy++) {
    const gy0 = cy * grid;
    const gy1 = (cy + 1) * grid;
    // The top edge of the previous row is the bottom edge of this row
    const swap = nodesLow;
    nodesLow = nodesHigh;
    nodesHigh = swap;
    nodesHigh.fill(-1, 0, nodeWidth);
    if (cy === cy0) nodesLow.fill(-1, 0, nodeWidth);

    // Work out "the columns this row actually touches" from the row's band. For a long thin
    // triangle most of the bounding box is a miss, so simply narrowing the column range row
    // by row cuts the number of cells we cover by an order of magnitude.
    const range = bandXRange(poly, polyLength, pool, gy0, gy1);
    if (!range) continue;
    const bx0 = Math.max(cx0, Math.floor(range[0] / grid));
    const bx1 = Math.min(cx1, Math.floor(range[1] / grid));

    for (let cx = bx0; cx <= bx1; cx++) {
      const gx0 = cx * grid;
      const gx1 = (cx + 1) * grid;

      // If the cell is wholly inside there is no need to cut and the four corners of the
      // cell can be emitted as they are (the coordinates of an intersection come out exactly
      // equal to the corner even when found by cutting: one axis is the value of the lattice
      // line itself, and the other is an interpolation between two identical values). A
      // polygon is usually bigger than a cell, so this path accounts for the vast majority.
      const inside = cellInsidePolygon(poly, polyLength, pool, gx0, gy0, gx1, gy1, orientation);
      if (inside === CELL_OUTSIDE) continue;
      if (inside === CELL_INSIDE) {
        const i0 = cx - cx0;
        const v00 = nodeAt(pool, nodesLow, i0, gx0, gy0);
        const v10 = nodeAt(pool, nodesLow, i0 + 1, gx1, gy0);
        const v11 = nodeAt(pool, nodesHigh, i0 + 1, gx1, gy1);
        const v01 = nodeAt(pool, nodesHigh, i0, gx0, gy1);
        // The direction of the diagonal is the same as in emitFan (fan out from the corner
        // with the smallest coordinate sum). It is the same way of splitting as MapLibre's
        // terrain mesh, so the surfaces agree inside the cell as well
        pushOriented(out, pool, v00, v10, v11);
        pushOriented(out, pool, v00, v11, v01);
        continue;
      }

      // The working arrays are reused (creating 8 arrays per cell would make array creation
      // dominant for data with thousands of small polygons)
      let length = clipHalfPlane(poly, polyLength, clipBufferA, pool, 0, gx0, false);
      if (length < 3) continue;
      length = clipHalfPlane(clipBufferA, length, clipBufferB, pool, 0, gx1, true);
      if (length < 3) continue;
      length = clipHalfPlane(clipBufferB, length, clipBufferA, pool, 1, gy0, false);
      if (length < 3) continue;
      length = clipHalfPlane(clipBufferA, length, clipBufferB, pool, 1, gy1, true);
      if (length < 3) continue;
      emitFan(clipBufferB, length, pool, out);
    }
  }
}

/**
 * Working storage for cutting with the area (a convex polygon has at most 7 vertices; 16
 * for headroom)
 */
const regionBuffer = new Int32Array(16);
const tileBufferA = new Int32Array(16);
const tileBufferB = new Int32Array(16);
const regionScratch = new Int32Array(16);
const outsideBuffer = new Int32Array(16);

/**
 * Cut a triangle with the rectangle of the area and leave what is inside in regionBuffer
 *
 * A fragment that falls outside the area is emitted to `out` on the spot (without
 * splitting). A fragment shares its edges with the original triangle, so neither gaps nor
 * overlaps arise.
 *
 * A triangle that lies wholly inside the area is left untouched. Cutting it would mean the
 * intersections of its edges with the lattice lines are no longer "values derived from the
 * original edge", and the agreement with the neighbouring triangle (down to the last bit)
 * would break. The only triangles that straddle the area are those along its border, and
 * that is off screen.
 *
 * @returns The number of vertices left inside the area (fewer than 3 means nothing is left)
 */
function clipToRegion(
  poly: readonly number[] | Int32Array,
  polyLength: number,
  pool: VertexPool,
  region: MercatorRect,
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
  out: number[],
): number {
  // If it is wholly inside, leave it untouched
  if (minX >= region.x0 && maxX <= region.x1 && minY >= region.y0 && maxY <= region.y1) {
    for (let i = 0; i < polyLength; i++) regionBuffer[i] = poly[i];
    return polyLength;
  }

  let source: readonly number[] | Int32Array = poly;
  let length = polyLength;

  for (let plane = 0; plane < 4; plane++) {
    const axis: 0 | 1 = plane < 2 ? 0 : 1;
    const line =
      plane === 0 ? region.x0 : plane === 1 ? region.x1 : plane === 2 ? region.y0 : region.y1;
    const keepLower = plane === 1 || plane === 3;

    // The outside fragment is emitted without splitting (outside the area the elevation
    // saturates at the edge, so there is no point in splitting it)
    const outsideLength = clipHalfPlane(
      source,
      length,
      outsideBuffer,
      pool,
      axis,
      line,
      !keepLower,
    );
    if (outsideLength >= 3) emitFan(outsideBuffer, outsideLength, pool, out);

    length = clipHalfPlane(source, length, regionScratch, pool, axis, line, keepLower);
    if (length < 3) return 0;
    for (let i = 0; i < length; i++) regionBuffer[i] = regionScratch[i];
    source = regionBuffer;
  }

  return length;
}

/**
 * Emit a triangle with its winding order aligned
 *
 * The terrain-following fill culls the far side of a ridge with back-face culling (the cure
 * for the silhouette bleed-through in which a fill laid on the far slope shows through the
 * ridge in front). For the culling to hold, the winding order of every triangle must be
 * uniform, but the orientation of the input ring (clockwise / counter-clockwise) differs
 * from feature to feature. So here we normalise to the orientation in which the cross
 * product in Mercator (x right, y down) is positive. In a y-down coordinate system a
 * positive cross product = clockwise on screen = counter-clockwise in GL window coordinates
 * (y up) = the front face of the default frontFace(CCW).
 */
export function pushOriented(
  out: number[],
  pool: VertexPool,
  a: number,
  b: number,
  c: number,
): void {
  const ax = pool.x(a);
  const ay = pool.y(a);
  const cross = (pool.x(b) - ax) * (pool.y(c) - ay) - (pool.x(c) - ax) * (pool.y(b) - ay);
  // The sign determined on real hardware: in Mercator (y down), the orientation with a
  // negative cross product is GL's front face (CCW). Choosing the opposite makes the whole
  // fill get culled and disappear in a straight-down view (confirmed in the field).
  if (cross <= 0) out.push(a, b, c);
  else out.push(a, c, b);
}

/**
 * The orientation of a convex polygon (the sign of the signed area)
 */
function signedAreaSign(poly: readonly number[] | Int32Array, n: number, pool: VertexPool): number {
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % n];
    sum += pool.x(a) * pool.y(b) - pool.x(b) * pool.y(a);
  }
  return sum >= 0 ? 1 : -1;
}

/** Working storage for returning the x range of a band (not created on every call) */
const bandRange: [number, number] = [0, 0];

/**
 * The x range of a convex polygon cut by the horizontal band [y0, y1]
 *
 * Nothing is added to the vertex pool. What we work out here is only "the columns to look
 * at in this row", while the cut shape itself is derived from the original polygon for each
 * cell (putting it into the pool would leave vertices that no triangle uses).
 *
 * @returns [minX, maxX]. null if it does not touch the band
 */
function bandXRange(
  poly: readonly number[] | Int32Array,
  n: number,
  pool: VertexPool,
  y0: number,
  y1: number,
): [number, number] | null {
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;

  const consider = (x: number): void => {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
  };

  for (let edge = 0; edge < n; edge++) {
    const a = poly[edge];
    const b = poly[(edge + 1) % n];
    const ax = pool.x(a);
    const ay = pool.y(a);
    const bx = pool.x(b);
    const by = pool.y(b);

    // Vertices that lie inside the band
    if (ay >= y0 && ay <= y1) consider(ax);

    // Intersections of the edge with the lines at the top and bottom of the band
    if (ay !== by) {
      for (let k = 0; k < 2; k++) {
        const line = k === 0 ? y0 : y1;
        const t = (line - ay) / (by - ay);
        if (t < 0 || t > 1) continue;
        consider(ax + (bx - ax) * t);
      }
    }
  }

  if (minX > maxX) return null;
  bandRange[0] = minX;
  bandRange[1] = maxX;
  return bandRange;
}

/** The cell is outside the triangle (all four corners lie outside one of the edges) */
const CELL_OUTSIDE = 0;
/** The cell is inside the triangle (the four corners are inside for all three edges) */
const CELL_INSIDE = 1;
/** The cell touches the border of the triangle (it has to be cut) */
const CELL_STRADDLE = 2;

/**
 * Decide the relation between a cell and a triangle from the signs of the three edges alone
 *
 * The decision is conservative. When a corner lies exactly on the border we fall to
 * "touches" and send it down the cutting path. The cutting path and the emitting path give
 * the same result, so which way we fall never changes the result (it is only a matter of
 * speed).
 */
function cellInsidePolygon(
  poly: readonly number[] | Int32Array,
  n: number,
  pool: VertexPool,
  gx0: number,
  gy0: number,
  gx1: number,
  gy1: number,
  orientation: number,
): number {
  let allInside = true;

  for (let edge = 0; edge < n; edge++) {
    const a = poly[edge];
    const b = poly[(edge + 1) % n];
    const x0 = pool.x(a);
    const y0 = pool.y(a);
    const ex = pool.x(b) - x0;
    const ey = pool.y(b) - y0;

    // Count the signs of the cross products at the four corners
    let insideCount = 0;
    let outsideCount = 0;
    for (let corner = 0; corner < 4; corner++) {
      const px = corner === 0 || corner === 3 ? gx0 : gx1;
      const py = corner < 2 ? gy0 : gy1;
      const cross = (ex * (py - y0) - ey * (px - x0)) * orientation;
      if (cross > 0) insideCount++;
      else outsideCount++;
    }
    if (insideCount === 0) return CELL_OUTSIDE;
    if (outsideCount > 0) allInside = false;
  }

  return allInside ? CELL_INSIDE : CELL_STRADDLE;
}

/**
 * Rows of lattice node numbers (two rows are reused; they are not rebuilt per triangle)
 */
const nodeRows: [Int32Array, Int32Array] = [new Int32Array(0), new Int32Array(0)];

/**
 * Grow the row array to the required length and return it
 */
function ensureNodeRow(slot: 0 | 1, width: number): Int32Array {
  if (nodeRows[slot].length < width) nodeRows[slot] = new Int32Array(width);
  return nodeRows[slot];
}

/**
 * Look up the number of a lattice node (registering it if the row does not remember it)
 */
function nodeAt(pool: VertexPool, row: Int32Array, index: number, x: number, y: number): number {
  const cached = row[index];
  if (cached >= 0) return cached;
  const created = pool.intern(x, y);
  row[index] = created;
  return created;
}

/**
 * The vertex pool (held in Mercator coordinates, with duplicates merged)
 *
 * By assigning the same number to the same coordinate, neighbouring triangles share their
 * split points. If they are shared, their elevations necessarily agree too, so no crack
 * appears in the fill.
 *
 * The longitude and latitude of the vertices that were there from the start are emitted as
 * they are, without a round trip through the conversion.
 */
class VertexPool {
  private readonly mx: number[] = [];
  private readonly my: number[] = [];
  private readonly lng: number[] = [];
  private readonly lat: number[] = [];
  /** A two-stage lookup, x -> (y -> number) (the keys are numbers; no strings are made) */
  private readonly lookup = new Map<number, Map<number, number>>();
  private readonly limit: number;
  private overflow = false;

  constructor(source: readonly number[], maxPoints: number) {
    // The vertices that were there from the start are not put into the matching table.
    //
    // The table exists in order to "let a point newly created by splitting be shared with
    // the neighbouring cell". Even if an original vertex and a split point happen to land on
    // the same coordinate, nothing goes wrong by not sharing them: if the coordinates are
    // identical down to the last bit, the elevation comes out the same value too and the
    // surface does not crack (sharing saves vertices; it does not prevent cracks). Meanwhile
    // the cost of putting them into the table is proportional to the feature's vertex count,
    // and for data with "thousands of small polygons" such as administrative boundaries it
    // costs far more than the number of cells does (measured: most of the 362μs per
    // feature).
    for (let i = 0; i < source.length; i += 2) {
      const lng = source[i];
      const lat = source[i + 1];
      this.mx.push(mercatorX(lng));
      this.my.push(mercatorY(lat));
      this.lng.push(lng);
      this.lat.push(lat);
    }
    this.limit = this.mx.length + Math.max(0, maxPoints);
  }

  exhausted(): boolean {
    return this.overflow;
  }

  /**
   * How many times the budget's worth of vertices we tried to create (usable as a step
   * factor)
   *
   * The vertex count is inversely proportional to the square of the step, so the square root
   * gives the step factor.
   */
  overflowRatio(): number {
    if (!(this.limit > 0)) return 1;
    return Math.max(1, Math.sqrt(this.mx.length / this.limit));
  }

  /**
   * Register a Mercator coordinate and return its number
   *
   * The matching is exact. It is tempting to round before matching, but it must not be
   * done. The intersection of a lattice line and an edge can come arbitrarily close to a
   * lattice node, so with even the slightest rounding "a nearby but different point" is
   * treated as the same one, that cell's fragment degenerates and drops out, and a hole one
   * cell wide opens in the surface (measured). With exact matching, what remains instead is
   * that vertices that are "the same point but differ in the last bit" occasionally survive.
   * That becomes a crack 1e-16 degrees wide (1e-11 m on the ground), but it does not show on
   * screen. Unlike a hole, the coverage of the surface is not lost.
   *
   * The key is a two-stage numeric lookup. A Map's numeric keys use SameValueZero
   * comparison, so the matching is just as exact as it was back when we turned them into the
   * string `${x},${y}`, while the per-point string creation disappears.
   */
  intern(x: number, y: number): number {
    const row = this.lookup.get(x);
    if (row) {
      const found = row.get(y);
      if (found !== undefined) return found;
    }

    if (this.mx.length >= this.limit) this.overflow = true;

    const index = this.mx.length;
    this.mx.push(x);
    this.my.push(y);
    this.lng.push(lngFromMercatorX(x));
    this.lat.push(latFromMercatorY(y));
    if (row) row.set(y, index);
    else this.lookup.set(x, new Map([[y, index]]));
    return index;
  }

  x(index: number): number {
    return this.mx[index];
  }

  y(index: number): number {
    return this.my[index];
  }

  /** Build the flattened coordinate array of longitudes and latitudes */
  output(): number[] {
    const out: number[] = new Array(this.lng.length * 2);
    for (let i = 0; i < this.lng.length; i++) {
      out[i * 2] = this.lng[i];
      out[i * 2 + 1] = this.lat[i];
    }
    return out;
  }
}

/**
 * Cut a convex polygon with an axis-aligned straight line (Sutherland-Hodgman)
 *
 * @param axis 0 = Mercator x (a vertical line), 1 = Mercator y (a horizontal line)
 * @param keepLower If true, keep the side with the smaller value
 */
function clipHalfPlane(
  poly: readonly number[] | Int32Array,
  polyLength: number,
  out: Int32Array,
  pool: VertexPool,
  axis: 0 | 1,
  line: number,
  keepLower: boolean,
): number {
  let count = 0;
  const push = (index: number): void => {
    // Fold it away if it has the same number as the one just before (a vertex on a lattice
    // line can be added twice)
    if (count > 0 && out[count - 1] === index) return;
    out[count++] = index;
  };

  for (let i = 0; i < polyLength; i++) {
    const current = poly[i];
    const next = poly[(i + 1) % polyLength];
    const currentValue = axis === 0 ? pool.x(current) : pool.y(current);
    const nextValue = axis === 0 ? pool.x(next) : pool.y(next);
    const currentIn = keepLower ? currentValue <= line : currentValue >= line;
    const nextIn = keepLower ? nextValue <= line : nextValue >= line;

    if (currentIn) push(current);
    if (currentIn !== nextIn) {
      const crossed = intersectAxis(current, next, pool, axis, line);
      if (crossed !== current) push(crossed);
    }
  }

  if (count > 1 && out[0] === out[count - 1]) count--;
  return count;
}

/**
 * The intersection of an edge and an axis-aligned line (independent of the order of the
 * endpoints)
 */
function intersectAxis(a: number, b: number, pool: VertexPool, axis: 0 | 1, line: number): number {
  // Normalise the order of the endpoints, so that the neighbouring triangle that shares the
  // same edge gets the same floating point result even when it traverses in the opposite
  // direction.
  let p = a;
  let q = b;
  const ax = pool.x(a);
  const ay = pool.y(a);
  const bx = pool.x(b);
  const by = pool.y(b);
  if (bx < ax || (bx === ax && by < ay)) {
    p = b;
    q = a;
  }

  const px = pool.x(p);
  const py = pool.y(p);
  const qx = pool.x(q);
  const qy = pool.y(q);

  if (axis === 0) {
    const denominator = qx - px;
    const t = denominator === 0 ? 0 : (line - px) / denominator;
    return pool.intern(line, py + (qy - py) * t);
  }
  const denominator = qy - py;
  const t = denominator === 0 ? 0 : (line - py) / denominator;
  return pool.intern(px + (qx - px) * t, line);
}

/**
 * Triangulate a convex polygon as a fan and emit it
 *
 * A lattice cell (4 vertices) is split along the same diagonal as MapLibre's terrain mesh.
 * MapLibre's `getTerrainMesh` splits along the main diagonal joining (x, y) and (x+1, y+1),
 * so we take the corner with the smallest Mercator coordinates as the origin of the fan. If
 * this disagrees, the surfaces twist and disagree inside a cell even though they agree on
 * the nodes.
 */
function emitFan(
  poly: readonly number[] | Int32Array,
  n: number,
  pool: VertexPool,
  out: number[],
): void {
  let start = 0;
  if (n === 4) {
    let best = Number.POSITIVE_INFINITY;
    for (let i = 0; i < n; i++) {
      const score = pool.x(poly[i]) + pool.y(poly[i]);
      if (score < best) {
        best = score;
        start = i;
      }
    }
  }

  for (let i = 1; i + 1 < n; i++) {
    pushOriented(out, pool, poly[start], poly[(start + i) % n], poly[(start + i + 1) % n]);
  }
}

/**
 * Working storage used for carving out each cell (a convex polygon obtained by cutting a
 * triangle with 4 axis-aligned lines has at most 7 vertices; we reserve 16 for headroom)
 */
const clipBufferA = new Int32Array(16);
const clipBufferB = new Int32Array(16);
