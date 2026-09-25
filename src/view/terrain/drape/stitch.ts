// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Stitching tile boundaries (resolving T-junctions)
 *
 * MapLibre chooses the zoom of terrain tiles by distance, so tiles of different
 * zooms coexist within a single screen (in a pitched view z6 and z9 sit side by
 * side). The difference is not necessarily a single level.
 *
 * When tiles of different zooms are adjacent, nodes that the coarser side does
 * not have are lined up along the boundary of the finer side. The finer side
 * takes the elevation of its own DEM at those nodes, but the coarser side joins
 * node to node with a straight line, so the two surfaces separate in between (a
 * T-junction). The basemap below shows through the gap that opens, and it looks
 * like a dotted gap running along the tile boundary.
 *
 * The way to fix it is to "constrain the elevation of the finer side boundary
 * onto the polyline of the coarser side". The boundary itself is a straight line
 * in tile coordinates, so only the elevation has to be moved. Taking the node
 * spacing of the coarser side (`delta * 2^Δz` in this tile coordinates) as the
 * step, and using the value obtained by linearly interpolating the elevations at
 * both ends of that step, the gap becomes structurally zero whatever the level
 * difference Δz is.
 *
 * However, "the polyline of the coarser side" is decided by the DEM of the
 * coarser side. MapLibre reads the DEM one level coarser than the render tile
 * (`deltaZoom = 1`), so adjacent tiles of different zooms always read DEMs of
 * different resolutions. Taking the node elevations from one own DEM yields not
 * the polyline of the coarser side but "a polyline that steps one own DEM
 * coarsely", and the two stay apart by the difference in DEM resolution. This is
 * the true identity of the thin line that remains at tile boundaries.
 *
 * Therefore the constraint uses the DEM of the coarser side itself. Here, for
 * each edge, we obtain the "step" and the "tile on the coarser side", and
 * further produce the transform that maps one own tile coordinates to the tile
 * coordinates of the coarser side. The actual constraining is done by the vertex
 * shader (drape_constrain in renderer.ts).
 */

import { TILE_EXTENT } from './mesh.js';

/** Tile identity (the minimum) */
export interface StitchTile {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/**
 * The constraint step per edge (tile coordinates)
 *
 * 0 means no constraint (the neighbor is at the same zoom, or finer, or is not
 * drawn). top = the edge at y 0, bottom = the edge at y EXTENT, left = the edge
 * at x 0, right = the edge at x EXTENT.
 */
export interface TileEdgeSteps {
  readonly top: number;
  readonly bottom: number;
  readonly left: number;
  readonly right: number;
}

/** The stitching of a single edge */
export interface EdgeStitch {
  /** The constraint step (tile coordinates). 0 means no constraint */
  readonly step: number;
  /**
   * The neighboring tile on the coarser side (null when not constraining)
   *
   * x is expressed "in the same wrap as this tile" (a neighbor reached by
   * wrapping the world in the longitude direction becomes a negative value or
   * 2^z or more). This is so that the coordinate transform can be built from
   * this value just as it is.
   */
  readonly tile: StitchTile | null;
}

/** The stitching of the four edges of a tile */
export interface TileEdgeStitch {
  readonly top: EdgeStitch;
  readonly bottom: EdgeStitch;
  readonly left: EdgeStitch;
  readonly right: EdgeStitch;
}

/** No constraint */
export const NO_EDGE_STEPS: TileEdgeSteps = { top: 0, bottom: 0, left: 0, right: 0 };

/** Four edges with no constraint */
export const NO_EDGE_STITCH: TileEdgeStitch = {
  top: { step: 0, tile: null },
  bottom: { step: 0, tile: null },
  left: { step: 0, tile: null },
  right: { step: 0, tile: null },
};

/**
 * The key of a tile (folding the wrap in the longitude direction)
 *
 * `computeEdgeStitch` returns the neighbor in the frame before wrapping so that
 * the coordinate transform can be built, so fold it here when looking up the
 * set.
 */
export function wrappedTileKey(tile: StitchTile): string {
  const span = 2 ** tile.z;
  return `${tile.z}/${((tile.x % span) + span) % span}/${tile.y}`;
}

/**
 * Build the set of keys from the set of tiles in view
 *
 * What is passed is "the tiles actually drawn in this frame". Putting in tiles
 * that are not drawn would mean constraining onto the polyline of a counterpart
 * that is not drawn.
 */
export function buildTileKeySet(tiles: readonly StitchTile[]): Set<string> {
  const set = new Set<string>();
  for (const tile of tiles) set.add(wrappedTileKey(tile));
  return set;
}

/** Floor division that holds even for negative values (x goes negative with the wrap) */
function floorShift(value: number, shift: number): number {
  return Math.floor(value / 2 ** shift);
}

/**
 * Look up the neighboring tile
 *
 * Walking up the ancestors in order starting from the same zoom, the first one
 * found is the neighbor (drawn tiles do not overlap, so at most one is found).
 *
 * The lookup uses the key wrapped in the longitude direction, but the x that is
 * returned is expressed in the frame before wrapping. Doing so lets the caller
 * build the transform "one own tile coordinates -> the neighbor tile
 * coordinates" out of a difference and a ratio alone (`neighborTileTransform`).
 *
 * @returns The neighboring tile. null if it is not found
 */
function neighborTile(
  keys: ReadonlySet<string>,
  z: number,
  x: number,
  y: number,
): StitchTile | null {
  const span = 2 ** z;
  if (y < 0 || y >= span) return null;
  // The longitude direction wraps around the world
  const wrapped = ((x % span) + span) % span;
  for (let nz = z; nz >= 0; nz--) {
    const shift = z - nz;
    if (keys.has(`${nz}/${wrapped >> shift}/${y >> shift}`)) {
      return { z: nz, x: floorShift(x, shift), y: y >> shift };
    }
  }
  return null;
}

/**
 * Obtain the stitching of the four edges of this tile
 *
 * @param meshSize The subdivision count of the terrain mesh (MapLibre default is 128)
 */
export function computeEdgeStitch(
  keys: ReadonlySet<string>,
  tile: StitchTile,
  meshSize: number,
): TileEdgeStitch {
  const delta = TILE_EXTENT / meshSize;
  const edgeFor = (nx: number, ny: number): EdgeStitch => {
    const neighbor = neighborTile(keys, tile.z, nx, ny);
    if (!neighbor || neighbor.z >= tile.z) return { step: 0, tile: null };
    return { step: delta * 2 ** (tile.z - neighbor.z), tile: neighbor };
  };

  return {
    top: edgeFor(tile.x, tile.y - 1),
    bottom: edgeFor(tile.x, tile.y + 1),
    left: edgeFor(tile.x - 1, tile.y),
    right: edgeFor(tile.x + 1, tile.y),
  };
}

/** Take only the steps out of the stitching */
export function edgeStepsOf(stitch: TileEdgeStitch): TileEdgeSteps {
  return {
    top: stitch.top.step,
    bottom: stitch.bottom.step,
    left: stitch.left.step,
    right: stitch.right.step,
  };
}

/**
 * Obtain the constraint steps of the four edges of this tile
 *
 * @param meshSize The subdivision count of the terrain mesh (MapLibre default is 128)
 */
export function computeEdgeSteps(
  keys: ReadonlySet<string>,
  tile: StitchTile,
  meshSize: number,
): TileEdgeSteps {
  return edgeStepsOf(computeEdgeStitch(keys, tile, meshSize));
}

/** The similarity transform mapping one own tile coordinates to the neighbor tile coordinates */
export interface NeighborTileTransform {
  /** The scale factor (a power of 2; less than 1 because the neighbor is coarser) */
  readonly scale: number;
  readonly offsetX: number;
  readonly offsetY: number;
}

/**
 * One own tile coordinates -> the tile coordinates of the neighbor (the coarser
 * side)
 *
 * It is `q = p * scale + offset`. The scale factor is a power of 2 and the
 * translation is an integer multiple of one mesh cell, so the mapping is exact
 * even in float. That is, the nodes of the step land exactly on the mesh nodes
 * of the coarser side, and read the same DEM texels with the same weights as the
 * coarser side reads at its own vertices. This is the ground for "the edge
 * vertices of the finer side lying exactly on the line segments of the coarser
 * side".
 */
export function neighborTileTransform(
  fine: StitchTile,
  coarse: StitchTile,
  extent: number = TILE_EXTENT,
): NeighborTileTransform {
  const scale = 2 ** (coarse.z - fine.z);
  return {
    scale,
    offsetX: (fine.x * scale - coarse.x) * extent,
    offsetY: (fine.y * scale - coarse.y) * extent,
  };
}

/**
 * The constraint for a single edge (holding the step, the coordinate transform
 * and the DEM of the constraint target as one set)
 *
 * The point is that the three are gathered into a single value. It is a shape
 * that makes a state where only the step is new and the DEM is old (or the
 * other way around) impossible to create, so that applying the constraint and
 * holding the constraint target become one and the same fact.
 */
export interface ResolvedEdge<T> {
  /** The constraint step (tile coordinates). It never becomes 0 */
  readonly step: number;
  /** The tile on the coarser side (x in the frame before wrapping) */
  readonly tile: StitchTile;
  /** One own tile coordinates -> the tile coordinates of the coarser side */
  readonly transform: NeighborTileTransform;
  /** The DEM of the coarser side (looked up at the same point in time as the step) */
  readonly terrain: T;
}

/** The constraints of the four edges of a tile (an edge that is not constrained is null) */
export interface ResolvedTileEdges<T> {
  readonly top: ResolvedEdge<T> | null;
  readonly bottom: ResolvedEdge<T> | null;
  readonly left: ResolvedEdge<T> | null;
  readonly right: ResolvedEdge<T> | null;
}

/** No edge is constrained */
export const NO_RESOLVED_EDGES: ResolvedTileEdges<never> = {
  top: null,
  bottom: null,
  left: null,
  right: null,
};

/**
 * Derive the constraints of the four edges of this tile wholly from the current
 * tile state
 *
 * The level difference (Δz), the coordinate transform, the step and the DEM of
 * the constraint target are all brought together in a single call. The step is
 * not baked into the vertex data (the mesh is a single one independent of the
 * tile, and the step can only be passed as a uniform), so merely passing through
 * here again every frame structurally prevents the mismatch "the DEM is new but
 * the level difference is old".
 *
 * An edge for which `resolve` returns null is not constrained. Leaving only the
 * step when the DEM of the constraint target cannot be held would mean
 * constraining onto a polyline that steps one own DEM coarsely, and the crack
 * that was supposed to be fixed would come back just there.
 *
 * @param keys The set of keys of the tiles actually drawn in this frame
 * @param resolve Look up the DEM from the tile on the coarser side (null if it
 *   cannot be looked up)
 */
export function resolveTileEdges<T>(
  keys: ReadonlySet<string>,
  tile: StitchTile,
  meshSize: number,
  resolve: (neighbor: StitchTile) => T | null,
): ResolvedTileEdges<T> {
  const stitch = computeEdgeStitch(keys, tile, meshSize);
  const resolveEdge = (edge: EdgeStitch): ResolvedEdge<T> | null => {
    if (!edge.tile || edge.step <= 0) return null;
    const terrain = resolve(edge.tile);
    if (terrain === null) return null;
    return {
      step: edge.step,
      tile: edge.tile,
      transform: neighborTileTransform(tile, edge.tile),
      terrain,
    };
  };

  return {
    top: resolveEdge(stitch.top),
    bottom: resolveEdge(stitch.bottom),
    left: resolveEdge(stitch.left),
    right: resolveEdge(stitch.right),
  };
}

/**
 * The elevation after constraining (the same expression as drape_constrain in
 * the vertex shader)
 *
 * The shader is the authority for the implementation, but the expression itself
 * is placed here as a pure function so that it can be verified. `sample` returns
 * the elevation of a node of the polyline on the coarser side.
 *
 * @param along The position along the edge (in this tile coordinates)
 * @param step The node spacing of the coarser side (in this tile coordinates)
 */
export function constrainEdgeElevation(
  along: number,
  step: number,
  sample: (at: number) => number,
  extent: number = TILE_EXTENT,
): number {
  const t0 = Math.floor(along / step) * step;
  const t1 = Math.min(t0 + step, extent);
  const e0 = sample(t0);
  const e1 = sample(t1);
  const w = t1 > t0 ? (along - t0) / (t1 - t0) : 0;
  return e0 + (e1 - e0) * w;
}
