// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The edits of the vertices of a drag as the tests of the vertices read them: the coordinates a
 * move of the vertices of a state leaves, and the ones a vertex added leaves, as a Store writes
 * them (`updatesOfEdits`)
 */

import type { VertexState } from '../operations/vertex.js';
import { coordinatesOf } from '../shared/utils/coordinates.js';
import { insertVertexAt } from '../shared/utils/vertex-edits.js';
import { updatesOfEdits } from '../store/feature-edits.js';
import type { Coordinate, Feature, FeatureCoordinates, VertexRef } from '../store/types.js';

/** Where a vertex of coordinates is */
function positionOf(kind: string, coordinates: unknown, ref: VertexRef): Coordinate {
  const part = ref.part ?? 0;
  const at = coordinates as Coordinate[] & Coordinate[][] & Coordinate[][][];
  switch (kind) {
    case 'Point':
      return coordinates as Coordinate;
    case 'LineString':
      return at[ref.index] as Coordinate;
    case 'MultiPoint':
      return at[part] as Coordinate;
    case 'Polygon':
      return at[ref.ring]?.[ref.index] as Coordinate;
    case 'MultiLineString':
      return at[part]?.[ref.index] as Coordinate;
    default:
      return (at as Coordinate[][][])[part]?.[ref.ring]?.[ref.index] as Coordinate;
  }
}

/** The coordinates of a feature once the vertices of a state are moved as far as a pointer */
export function computeVertexMove(
  state: VertexState,
  pointer: { lng: number; lat: number },
  feature: Feature,
): FeatureCoordinates {
  const dx = pointer.lng - state.startLngLat.lng;
  const dy = pointer.lat - state.startLngLat.lat;
  const positions = state.vertices.map((ref): Coordinate => {
    const from = positionOf(feature.type, state.initialCoordinates, ref);
    return [from[0] + dx, from[1] + dy];
  });
  const base = { ...feature, geometry: { ...feature.geometry } } as Feature;
  (base.geometry as { coordinates: unknown }).coordinates = state.initialCoordinates;
  const { updates } = updatesOfEdits(
    [{ kind: 'vertex-move', featureId: feature.id, vertices: state.vertices, positions }],
    () => base,
  );
  return coordinatesOf({ ...base, ...updates[0]?.updates } as Feature);
}

/** The coordinates of a feature with a vertex added after another */
export function addVertex(
  feature: Feature,
  after: VertexRef,
  position: Coordinate,
): FeatureCoordinates {
  return insertVertexAt(
    feature.type,
    coordinatesOf(feature),
    { ...after, index: after.index + 1 },
    position,
  );
}
