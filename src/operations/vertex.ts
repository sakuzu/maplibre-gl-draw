// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Vertex operations
 *
 * The operations that edit the vertices of a feature
 *
 * A vertex is pointed to by a part number + a ring number + a vertex index
 * (VertexRef). A Polygon can have inner rings (holes, ring 1 onwards) in addition to
 * its outer ring (ring 0), so every operation can work across rings. The Multi
 * variants (MultiPoint / MultiLineString / MultiPolygon) can work across parts as
 * well.
 *
 * When part is omitted it means 0. For a single geometry that has no parts
 * (Point / LineString / Polygon) only part 0 is valid, and any part other than 0 is
 * regarded as an invalid reference. Likewise, for LineString / Point, which have no
 * rings, ring is always treated as 0, and any ring other than 0 is regarded as an
 * invalid reference.
 */

import { coordinatesOf } from '../shared/utils/coordinates.js';
import { deleteVertexAt, isVertexOf } from '../shared/utils/vertex-edits.js';
import type { Feature, FeatureCoordinates, VertexRef } from '../store/types.js';

export { sortVertexRefsForDeletion } from '../shared/utils/vertex-edits.js';

/**
 * The state of a vertex operation
 *
 * @internal
 */
export interface VertexState {
  /** The id of the feature being operated on */
  featureId: string;
  /** The array of vertex references being operated on (part number + ring number +
   * vertex index) */
  vertices: VertexRef[];
  /** The mouse coordinate at the start */
  startLngLat: { lng: number; lat: number };
  /**
   * The feature coordinates at the start
   *
   * Coordinates follow the convention of immutable updates (an update is always a
   * replacement with a new array), so a reference to the coordinates at the start is
   * enough here. It must not be rewritten.
   */
  initialCoordinates: FeatureCoordinates;
}

/**
 * Deletes a vertex
 *
 * The coordinates are built with copy-on-write: the top-level array is always made new,
 * only the container that splice changes (the target ring / part) is copied, and the
 * other parts / rings / coordinate pairs keep sharing references with the input. The
 * input geometry is never rewritten.
 *
 * @internal
 */
export function deleteVertex(feature: Feature, ref: VertexRef): FeatureCoordinates | null {
  return deleteVertexAt(feature.type, coordinatesOf(feature), ref);
}

/**
 * Starts the vertex movement operation
 *
 * @internal
 */
export function startVertexMove(
  feature: Feature,
  vertices: readonly VertexRef[],
  startLngLat: { lng: number; lat: number },
): VertexState | null {
  if (vertices.length === 0) return null;

  // Check the validity of the vertex references (a type other than the six of GeoJSON has
  // no vertex to move)
  if (feature.type === 'Point' && vertices.length !== 1) return null;
  const coordinates = coordinatesOf(feature);
  if (!vertices.every((ref) => isVertexOf(feature.type, coordinates, ref))) return null;

  return {
    featureId: feature.id,
    vertices: vertices.map((r) => ({ ...r })),
    startLngLat,
    // Coordinates follow the convention of immutable updates (an update is always a
    // replacement with a new array), so holding a reference from the start is enough:
    // the contents do not change afterwards and no copy is needed
    initialCoordinates: coordinatesOf(feature),
  };
}
