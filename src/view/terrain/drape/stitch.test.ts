// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Verification of the stitching of tile boundaries
 *
 * The promise to keep is "constrain only when the neighbor is coarser, at the
 * node spacing of the coarser side". The level difference Δz is not necessarily
 * a single level, so we go as far as seeing that the step becomes 2^Δz times for
 * an arbitrary difference.
 */

import { describe, expect, it } from 'vitest';
import {
  buildTileKeySet,
  computeEdgeSteps,
  computeEdgeStitch,
  constrainEdgeElevation,
  neighborTileTransform,
  resolveTileEdges,
  type StitchTile,
} from './stitch.js';

const MESH_SIZE = 128;
const EXTENT = 8192;
/** The step of one mesh cell (TILE_EXTENT / meshSize) */
const DELTA = EXTENT / MESH_SIZE;

describe('computeEdgeSteps', () => {
  it('does not constrain when the neighbor is at the same zoom', () => {
    const tiles: StitchTile[] = [
      { z: 10, x: 100, y: 200 },
      { z: 10, x: 101, y: 200 },
      { z: 10, x: 99, y: 200 },
      { z: 10, x: 100, y: 199 },
      { z: 10, x: 100, y: 201 },
    ];
    const steps = computeEdgeSteps(buildTileKeySet(tiles), tiles[0], MESH_SIZE);
    expect(steps).toEqual({ top: 0, bottom: 0, left: 0, right: 0 });
  });

  it('constrains with a step twice as large when the neighbor is one level coarser', () => {
    const tiles: StitchTile[] = [
      { z: 10, x: 101, y: 200 },
      // The z9 tile covering the right neighbor (x = 102)
      { z: 9, x: 51, y: 100 },
    ];
    const steps = computeEdgeSteps(buildTileKeySet(tiles), tiles[0], MESH_SIZE);
    expect(steps.right).toBe(DELTA * 2);
    expect(steps.left).toBe(0);
    expect(steps.top).toBe(0);
    expect(steps.bottom).toBe(0);
  });

  it('the step becomes 2^3 times even when the difference is 3 levels', () => {
    const tiles: StitchTile[] = [
      { z: 12, x: 400, y: 800 },
      // The z9 tile covering the left neighbor (x = 399)
      { z: 9, x: 49, y: 100 },
    ];
    const steps = computeEdgeSteps(buildTileKeySet(tiles), tiles[0], MESH_SIZE);
    expect(steps.left).toBe(DELTA * 8);
  });

  it('does not constrain when the neighbor is finer (the finer side constrains)', () => {
    const tiles: StitchTile[] = [
      { z: 9, x: 50, y: 100 },
      // The z10 tile covering the right neighbor
      { z: 10, x: 102, y: 200 },
    ];
    const steps = computeEdgeSteps(buildTileKeySet(tiles), tiles[0], MESH_SIZE);
    expect(steps.right).toBe(0);
  });

  it('does not constrain when the neighbor is not drawn', () => {
    const tiles: StitchTile[] = [{ z: 10, x: 100, y: 200 }];
    const steps = computeEdgeSteps(buildTileKeySet(tiles), tiles[0], MESH_SIZE);
    expect(steps).toEqual({ top: 0, bottom: 0, left: 0, right: 0 });
  });

  it('the longitude direction wraps around the world', () => {
    const tiles: StitchTile[] = [
      { z: 2, x: 0, y: 1 },
      // The left neighbor is x = -1 = 3 (wrapped). The z1 tile covering it
      { z: 1, x: 1, y: 0 },
    ];
    const steps = computeEdgeSteps(buildTileKeySet(tiles), tiles[0], MESH_SIZE);
    expect(steps.left).toBe(DELTA * 2);
  });

  it('the top and bottom edges are decided by the same rule', () => {
    const tiles: StitchTile[] = [
      { z: 11, x: 200, y: 400 },
      // The z10 tile covering the top neighbor (y = 399)
      { z: 10, x: 100, y: 199 },
    ];
    const steps = computeEdgeSteps(buildTileKeySet(tiles), tiles[0], MESH_SIZE);
    expect(steps.top).toBe(DELTA * 2);
    expect(steps.bottom).toBe(0);
  });
});

describe('computeEdgeStitch', () => {
  it('returns the coarse neighbor tile itself (the constraint is solved with its DEM)', () => {
    const fine: StitchTile = { z: 11, x: 200, y: 400 };
    const coarse: StitchTile = { z: 10, x: 100, y: 199 };
    const stitch = computeEdgeStitch(buildTileKeySet([fine, coarse]), fine, MESH_SIZE);
    expect(stitch.top).toEqual({ step: DELTA * 2, tile: coarse });
    expect(stitch.bottom.tile).toBeNull();
  });

  it('a neighbor wrapped in longitude is returned with the x of the frame before wrapping', () => {
    // The left neighbor of x = 0 at z2 is x = -1 (= 3 once wrapped). The z1 tile
    // covering it has x = 1 in the wrapped key, but is returned as x = -1 so
    // that the coordinate transform can be built
    const fine: StitchTile = { z: 2, x: 0, y: 1 };
    const stitch = computeEdgeStitch(
      buildTileKeySet([fine, { z: 1, x: 1, y: 0 }]),
      fine,
      MESH_SIZE,
    );
    expect(stitch.left).toEqual({ step: DELTA * 2, tile: { z: 1, x: -1, y: 0 } });

    // That transform means "one own left edge (x = 0) lands on the right edge
    // (x = EXTENT) of the coarser side"
    const transform = neighborTileTransform(fine, { z: 1, x: -1, y: 0 });
    expect(transform.scale).toBe(0.5);
    expect(0 * transform.scale + transform.offsetX).toBe(EXTENT);
  });
});

/**
 * Landing on the polyline of the coarser side
 *
 * The promise of the constraint is that "the vertices of the edge on the finer
 * side lie exactly on the polyline joining the mesh nodes of the coarser side".
 * If it does not hold for a level difference Δz of one or of two, a band that is
 * not covered remains at the boundary.
 */
describe('constraining onto the polyline of the coarser side', () => {
  /** Elevation of a node on the coarser side (synthetic terrain decided only by node position) */
  const coarseNodeElevation = (qx: number, qy: number): number =>
    Math.sin(qx / 977) * 120 + Math.cos(qy / 613) * 80;

  /**
   * Elevation of the polyline of the coarser side (straight between nodes). q is
   * the tile coordinate of the coarser side
   */
  const coarsePolyline = (qAlong: number, qFixed: number, horizontal: boolean): number => {
    const n0 = Math.floor(qAlong / DELTA) * DELTA;
    const n1 = Math.min(n0 + DELTA, EXTENT);
    const at = (t: number): number =>
      horizontal ? coarseNodeElevation(t, qFixed) : coarseNodeElevation(qFixed, t);
    const w = n1 > n0 ? (qAlong - n0) / (n1 - n0) : 0;
    return at(n0) + (at(n1) - at(n0)) * w;
  };

  const check = (
    fine: StitchTile,
    coarse: StitchTile,
    edge: 'top' | 'bottom' | 'left' | 'right',
  ): void => {
    const stitch = computeEdgeStitch(buildTileKeySet([fine, coarse]), fine, MESH_SIZE);
    const step = stitch[edge].step;
    expect(stitch[edge].tile).toEqual(coarse);
    expect(step).toBe(DELTA * 2 ** (fine.z - coarse.z));

    const { scale, offsetX, offsetY } = neighborTileTransform(fine, coarse);
    const horizontal = edge === 'top' || edge === 'bottom';
    // The coordinate of the side that is fixed on the edge (one own tile coordinates)
    const fixed = edge === 'top' || edge === 'left' ? 0 : EXTENT;
    const qFixed = horizontal ? fixed * scale + offsetY : fixed * scale + offsetX;
    // One own edge lands on the facing edge of the coarser side itself (for the
    // top edge, the bottom edge of the coarser side)
    expect(qFixed).toBe(edge === 'top' || edge === 'left' ? EXTENT : 0);

    // A sample that puts the DEM of the coarser side into the form of "looking
    // it up in one own tile coordinates"
    const sample = (at: number): number => {
      const q = horizontal ? at * scale + offsetX : at * scale + offsetY;
      return horizontal ? coarseNodeElevation(q, qFixed) : coarseNodeElevation(qFixed, q);
    };

    for (let i = 0; i <= MESH_SIZE; i++) {
      const along = i * DELTA;
      // The nodes of the step land exactly on the mesh nodes of the coarser side
      const t0 = Math.floor(along / step) * step;
      const q0 = t0 * scale + (horizontal ? offsetX : offsetY);
      expect(q0 % DELTA).toBe(0);

      const constrained = constrainEdgeElevation(along, step, sample);
      const onLine = coarsePolyline(
        along * scale + (horizontal ? offsetX : offsetY),
        qFixed,
        horizontal,
      );
      expect(constrained).toBeCloseTo(onLine, 10);
    }
  };

  it('Δz = 1 (top edge) — every finer-side vertex lies on a coarser-side segment', () => {
    check({ z: 11, x: 200, y: 400 }, { z: 10, x: 100, y: 199 }, 'top');
  });

  it('Δz = 1 (top edge, sitting on the right half of the coarse tile)', () => {
    check({ z: 11, x: 201, y: 400 }, { z: 10, x: 100, y: 199 }, 'top');
  });

  it('Δz = 2 (left edge) — it lies on even with a difference of two levels', () => {
    check({ z: 12, x: 400, y: 800 }, { z: 10, x: 99, y: 200 }, 'left');
  });

  it('Δz = 2 (right edge) — it lies on even with a difference of two levels', () => {
    check({ z: 12, x: 403, y: 802 }, { z: 10, x: 101, y: 200 }, 'right');
  });

  it('both ends of the edge are coarser-side nodes themselves (no extrapolation)', () => {
    const sample = (at: number): number => at;
    expect(constrainEdgeElevation(0, DELTA * 2, sample)).toBe(0);
    expect(constrainEdgeElevation(EXTENT, DELTA * 2, sample)).toBe(EXTENT);
  });

  it('constrained elevation is unbroken along the edge (ends agree with the next step)', () => {
    const step = DELTA * 4;
    const sample = (at: number): number => Math.sin(at / 311) * 50;
    for (let t = step; t < EXTENT; t += step) {
      // Values closed in from left and right at the seam of the step converge to the same point
      const left = constrainEdgeElevation(t - 1e-6, step, sample);
      const right = constrainEdgeElevation(t, step, sample);
      expect(left).toBeCloseTo(right, 6);
    }
  });
});

/**
 * Simultaneous derivation of the level difference, the coordinate transform, the
 * step and the DEM of the constraint target
 *
 * The promise to keep is that "the four always come out of the terrain tile
 * state of one and the same point in time". In a frame where the level of the
 * neighbor changed during a pan or a zoom, they must be at the values of the new
 * level right there (constraining with the neighborhood of the previous frame
 * would pull toward the polyline of a different level and a band would appear).
 */
describe('resolveTileEdges', () => {
  const fine: StitchTile = { z: 12, x: 400, y: 800 };
  /** A stand-in for a DEM that was looked up (a mark showing which tile it came from) */
  const demOf = (tile: StitchTile): string => `dem:${tile.z}/${tile.x}/${tile.y}`;

  /** Produce the constraints of the four edges from the tiles drawn in that frame */
  const frame = (drawn: StitchTile[]) =>
    resolveTileEdges(buildTileKeySet(drawn), fine, MESH_SIZE, (neighbor) => {
      const span = 2 ** neighbor.z;
      const wrapped = ((neighbor.x % span) + span) % span;
      const hit = drawn.find((t) => t.z === neighbor.z && t.x === wrapped && t.y === neighbor.y);
      return hit ? demOf(hit) : null;
    });

  // The tile covering the left neighbor (x = 399). x = 400 is even, so the right
  // neighbor (401) shares an ancestor with this tile = a coarse tile never
  // becomes the right neighbor (the same holds for the actual coverage)
  const sameZoomLeft: StitchTile = { z: 12, x: 399, y: 800 };
  const coarse1: StitchTile = { z: 11, x: 199, y: 400 };
  const coarse2: StitchTile = { z: 10, x: 99, y: 200 };

  it('does not constrain while the neighbor is at the same level', () => {
    expect(frame([fine, sameZoomLeft]).left).toBeNull();
  });

  it('the frame where the neighbor turns z -> z-1 has the new level, transform and step', () => {
    // In the previous frame (the same level) there is no constraint
    expect(frame([fine, sameZoomLeft]).left).toBeNull();

    // The frame right after the neighbor switched to z11
    const left = frame([fine, coarse1]).left;
    expect(left).not.toBeNull();
    expect(left?.step).toBe(DELTA * 2);
    expect(left?.tile).toEqual(coarse1);
    expect(left?.transform.scale).toBe(0.5);
    // The DEM of the constraint target comes out of the same derivation as well
    // (nothing from the old neighbor gets mixed in)
    expect(left?.terrain).toBe(demOf(coarse1));
    // One own left edge (x = 0) lands on the right edge (x = EXTENT) of the coarser side
    expect(0 * (left?.transform.scale ?? 0) + (left?.transform.offsetX ?? 0)).toBe(EXTENT);
  });

  it('follows along on the spot even in a frame that became one more level coarser', () => {
    const left = frame([fine, coarse2]).left;
    expect(left?.step).toBe(DELTA * 4);
    expect(left?.transform.scale).toBe(0.25);
    expect(left?.terrain).toBe(demOf(coarse2));
    expect(0 * (left?.transform.scale ?? 0) + (left?.transform.offsetX ?? 0)).toBe(EXTENT);
  });

  it('in a frame where the level went back, the constraint goes back too', () => {
    expect(frame([fine, coarse2]).left?.step).toBe(DELTA * 4);
    expect(frame([fine, coarse1]).left?.step).toBe(DELTA * 2);
    expect(frame([fine, sameZoomLeft]).left).toBeNull();
  });

  it('an edge whose constraint target DEM cannot be looked up drops its step as well', () => {
    const edges = resolveTileEdges(buildTileKeySet([fine, coarse1]), fine, MESH_SIZE, () => null);
    expect(edges.left).toBeNull();
  });

  it('a tile that is not drawn in that frame does not become a neighbor', () => {
    // If it is not put in the set it does not become a constraint target (do not
    // pull toward a polyline that nobody draws)
    const edges = frame([fine]);
    expect(edges.top).toBeNull();
    expect(edges.bottom).toBeNull();
    expect(edges.left).toBeNull();
    expect(edges.right).toBeNull();
  });

  it('each of the four edges is decided independently from its own level', () => {
    const edges = frame([
      fine,
      coarse1, // left (Δz = 1)
      { z: 10, x: 100, y: 199 }, // top (Δz = 2)
      { z: 12, x: 401, y: 800 }, // right (the same level)
      { z: 12, x: 400, y: 801 }, // bottom (the same level)
    ]);
    expect(edges.left?.step).toBe(DELTA * 2);
    expect(edges.top?.step).toBe(DELTA * 4);
    expect(edges.right).toBeNull();
    expect(edges.bottom).toBeNull();
  });
});
