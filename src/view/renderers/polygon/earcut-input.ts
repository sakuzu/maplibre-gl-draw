// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Building the earcut input
 *
 * Provides a pure function that converts a polygon with holes (an array of rings)
 * into the "flattened coordinate sequence + start indices of the inner rings" that
 * earcut requires. Following the coordinate format convention, rings[0] is the outer
 * ring and rings[1..] are the inner rings.
 */

import type { Coordinate } from '../../../store/types.js';

/**
 * The input to earcut
 */
export interface EarcutInput {
  /** Coordinate sequence flattened over all rings ([lng, lat, lng, lat, ...]) */
  flatCoords: number[];
  /** Start vertex indices of the inner rings (earcut's holeIndices) */
  holeIndices: number[];
  /**
   * Array of rings with the closing point removed (rings[0] is the outer ring,
   * rings[1..] are the inner rings)
   *
   * Rings that have no area have already been excluded, so it can also be used for
   * drawing the outline (stroke).
   */
  rings: Coordinate[][];
}

/**
 * Removes the closing point at the end of a ring (the same coordinate as the first)
 *
 * Neither earcut nor outline drawing needs the closing point, so it is normalized at
 * the entrance.
 */
function openRing(ring: Coordinate[]): Coordinate[] {
  if (ring.length < 2) return ring;

  const first = ring[0];
  const last = ring[ring.length - 1];
  if (first[0] === last[0] && first[1] === last[1]) {
    return ring.slice(0, -1);
  }
  return ring;
}

/**
 * Builds the earcut input from an array of rings
 *
 * - The closing point of each ring is removed
 * - A ring with fewer than 3 vertices has no area, so it is ignored
 * - If the outer ring is invalid, an empty input is returned (the caller skips drawing)
 *
 * @param rings Array of rings (rings[0] is the outer ring, rings[1..] are the inner rings)
 * @returns The flattened coordinate sequence and the start indices of the inner rings
 */
export function buildEarcutInput(rings: Coordinate[][]): EarcutInput {
  if (rings.length === 0) {
    return { flatCoords: [], holeIndices: [], rings: [] };
  }

  const outerRing = openRing(rings[0]);
  if (outerRing.length < 3) {
    return { flatCoords: [], holeIndices: [], rings: [] };
  }

  const flatCoords: number[] = [];
  const holeIndices: number[] = [];
  const openRings: Coordinate[][] = [outerRing];

  for (const [lng, lat] of outerRing) {
    flatCoords.push(lng, lat);
  }

  for (let i = 1; i < rings.length; i++) {
    const holeRing = openRing(rings[i]);
    if (holeRing.length < 3) continue;

    // Start vertex index of the inner ring (coordinate count = flatCoords.length / 2)
    holeIndices.push(flatCoords.length / 2);
    for (const [lng, lat] of holeRing) {
      flatCoords.push(lng, lat);
    }
    openRings.push(holeRing);
  }

  return { flatCoords, holeIndices, rings: openRings };
}
