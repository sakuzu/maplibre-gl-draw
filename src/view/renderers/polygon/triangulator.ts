// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Injection point for polygon triangulation
 *
 * Retained-mode batch building (buildRetained) can receive the triangulation of the
 * fill through this injection point. If none is passed, earcut is called on the spot
 * as before.
 *
 * Triangulating a huge polygon (a water body on the order of a million vertices)
 * takes more than ten seconds in one go, so the dataset path injects
 * an implementation that slices the work over time (dataset/triangulation.ts) here.
 * For a polygon whose triangulation has not finished yet, null is returned, and the
 * caller omits the fill of that polygon and puts it into the batch with the outline
 * only. Once the triangulation finishes, the injecting side prompts a rebuild.
 *
 * The renderer (view) does not know the implementation being injected. Only the
 * types are placed here in order to keep that direction of dependency.
 */

/**
 * A triangulation request
 */
export interface TriangulationRequest {
  /** Feature ID used for cache and job identity (execution is synchronous without it) */
  featureId: string | undefined;
  /** Part number within a MultiPolygon (0 for a single polygon) */
  partIndex: number;
  /** Coordinate sequence flattened over all rings (the output of buildEarcutInput) */
  flatCoords: number[];
  /** Start vertex indices of the inner rings */
  holeIndices: number[];
}

/**
 * A supplier of triangulations
 */
export interface PolygonTriangulator {
  /**
   * Returns the triangulated index sequence
   *
   * @returns null while the triangulation has not finished yet (the fill is omitted)
   */
  triangulate(request: TriangulationRequest): number[] | null;
}
