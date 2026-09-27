// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Simultaneous movement of shared vertices
 *
 * The collection process for moving vertices that adjacent features hold at the
 * same coordinate (shared vertices) together in a single drag. The "features that
 * follow along and their vertex references" are fixed when the drag starts, and no
 * further search is made afterwards (if the set changed during the drag it would
 * interfere with other features such as snapping).
 *
 * The match test is an exact match with a tolerance of 0. Boundaries in GIS data
 * are assumed to share the same coordinate values, and picking up neighbors would
 * drag in unrelated vertices, so no rounding is applied.
 *
 * The targets are only the unlocked, visible features among the geometries that
 * allow vertex editing (Point / LineString / Polygon and the Multi variants). Types
 * without vertex movement, such as Circle / Image / Freehand, are excluded from the
 * candidates.
 */

import { coordinatesOf } from '../shared/utils/coordinates.js';
import { hasVertexRef } from '../shared/utils/vertex-ref.js';
import { isLocallyHidden, type LocalHiddenStore } from '../store/local-visibility.js';
import { type FeatureLockStore, isFeatureLocked } from '../store/lock.js';
import type { SpatialIndex } from '../store/spatial/spatial-index.js';
import type { Coordinate, Feature, FeatureType, VertexRef } from '../store/types.js';
import { startVertexMove, type VertexState } from './vertex.js';

/**
 * The minimal Store interface needed to collect shared vertices
 *
 * In addition to the tests for the effective lock (lock.ts) and local hiding
 * (local-visibility.ts), it is enough to look up a feature by a candidate id.
 *
 * @internal
 */
export interface SharedVertexStore extends FeatureLockStore, LocalHiddenStore {
  getFeature(id: string): Feature | undefined;
}

/**
 * Geometry types eligible for the simultaneous movement of shared vertices
 *
 * They are kept identical to the types whose coordinates computeVertexMove can
 * move.
 */
const VERTEX_MOVABLE_TYPES: ReadonlySet<string> = new Set<FeatureType>([
  'Point',
  'LineString',
  'Polygon',
  'MultiPoint',
  'MultiLineString',
  'MultiPolygon',
]);

/**
 * The result of the dataset
 *
 * @internal
 */
export interface SharedVertexMoves {
  /**
   * The vertex references of the main feature to be moved
   *
   * The dragged vertices plus the vertices within the main feature that were at the
   * same coordinate (the closing point of a closed ring, a vertex where the outer
   * ring and an inner ring touch, and so on).
   */
  mainRefs: VertexRef[];
  /** The vertex movement state of the other features that follow along */
  followers: VertexState[];
}

/**
 * Lists every vertex of a feature
 *
 * The end of a closed ring (the closing point) is also listed as one vertex. The
 * match test for shared vertices is done on coordinates, so leaving out the closing
 * point would lose track of "which of the first and the last one matched".
 */
function forEachVertex(feature: Feature, visit: (coord: Coordinate, ref: VertexRef) => void): void {
  const { type } = feature;
  const coordinates = coordinatesOf(feature);

  if (type === 'Point') {
    visit(coordinates as Coordinate, { ring: 0, index: 0 });
    return;
  }

  if (type === 'LineString') {
    const coords = coordinates as Coordinate[];
    for (let index = 0; index < coords.length; index++) {
      visit(coords[index], { ring: 0, index });
    }
    return;
  }

  if (type === 'Polygon') {
    visitRings(coordinates as Coordinate[][], visit);
    return;
  }

  if (type === 'MultiPoint') {
    // Each coordinate is one part. ring / index is always 0
    const points = coordinates as Coordinate[];
    for (let part = 0; part < points.length; part++) {
      visit(points[part], { part, ring: 0, index: 0 });
    }
    return;
  }

  if (type === 'MultiLineString') {
    const parts = coordinates as Coordinate[][];
    for (let part = 0; part < parts.length; part++) {
      const coords = parts[part];
      for (let index = 0; index < coords.length; index++) {
        visit(coords[index], { part, ring: 0, index });
      }
    }
    return;
  }

  if (type === 'MultiPolygon') {
    const parts = coordinates as Coordinate[][][];
    for (let part = 0; part < parts.length; part++) {
      visitRings(parts[part], visit, part);
    }
  }
}

/**
 * Lists every vertex of an array of rings (including inner rings)
 */
function visitRings(
  rings: Coordinate[][],
  visit: (coord: Coordinate, ref: VertexRef) => void,
  part?: number,
): void {
  for (let ring = 0; ring < rings.length; ring++) {
    const coords = rings[ring];
    for (let index = 0; index < coords.length; index++) {
      visit(coords[index], part === undefined ? { ring, index } : { part, ring, index });
    }
  }
}

/**
 * Whether the coordinates match exactly (tolerance 0)
 */
function isSameCoordinate(a: Coordinate, b: Coordinate): boolean {
  return a[0] === b[0] && a[1] === b[1];
}

/**
 * Returns every vertex reference that matches one of the given coordinates exactly
 *
 * When a single feature has several vertices at the same coordinate (the first and
 * the last one of a closed ring, for instance), all of them are returned.
 *
 * @internal
 */
export function findVertexRefsAt(feature: Feature, targets: readonly Coordinate[]): VertexRef[] {
  const refs: VertexRef[] = [];
  if (!VERTEX_MOVABLE_TYPES.has(feature.type)) return refs;

  forEachVertex(feature, (coord, ref) => {
    if (targets.some((target) => isSameCoordinate(coord, target))) {
      refs.push(ref);
    }
  });
  return refs;
}

/**
 * Takes out the coordinates pointed to by the vertex references (duplicates removed)
 *
 * @internal
 */
export function resolveVertexCoordinates(
  feature: Feature,
  refs: readonly VertexRef[],
): Coordinate[] {
  const coords: Coordinate[] = [];
  forEachVertex(feature, (coord, ref) => {
    if (!hasVertexRef(refs, ref)) return;
    if (coords.some((existing) => isSameCoordinate(existing, coord))) return;
    coords.push([coord[0], coord[1]]);
  });
  return coords;
}

/**
 * Whether a feature can follow along with shared vertices
 *
 * Features under an effective lock (their own, their group's or their layer's) and
 * hidden features are excluded. The cascade of the shared visible flag is aligned
 * with the test in listFeaturesInOrder, and local hiding with the one in
 * getDisplayFeatures.
 */
function isFollowCandidate(feature: Feature, store: SharedVertexStore): boolean {
  if (!VERTEX_MOVABLE_TYPES.has(feature.type)) return false;
  if (isFeatureLocked(feature, store)) return false;

  if (!feature.visible) return false;
  if (feature.groupId && !store.getGroup(feature.groupId)?.visible) return false;
  if (!store.getLayer(feature.layerId)?.visible) return false;

  return !isLocallyHidden(feature, store);
}

/**
 * Fixes the targets of the simultaneous movement of shared vertices when the drag
 * starts
 *
 * Candidate features are narrowed down with SpatialIndex.findNear (tolerance 0), and
 * only the features among them that have a vertex matching the coordinate exactly
 * are taken. No further search is made during the drag; the set fixed here keeps
 * being used.
 *
 * @param feature The feature being dragged (the main one)
 * @param vertexRefs The vertex references being dragged
 *
 * @internal
 */
export function collectSharedVertexMoves(params: {
  store: SharedVertexStore;
  spatialIndex: SpatialIndex;
  feature: Feature;
  vertexRefs: readonly VertexRef[];
  startLngLat: { lng: number; lat: number };
}): SharedVertexMoves {
  const { store, spatialIndex, feature, vertexRefs, startLngLat } = params;

  const targets = resolveVertexCoordinates(feature, vertexRefs);
  const mainRefs = vertexRefs.map((ref) => ({ ...ref }));
  if (targets.length === 0) {
    return { mainRefs, followers: [] };
  }

  // Narrow down the candidate features with the spatial index (tolerance 0 = a point query)
  const candidateIds = new Set<string>();
  for (const target of targets) {
    for (const id of spatialIndex.findNear(target, 0)) {
      candidateIds.add(id);
    }
  }

  // Also move the vertices at the same coordinate within the main feature (the closing
  // point of a closed ring, for instance)
  for (const ref of findVertexRefsAt(feature, targets)) {
    if (!hasVertexRef(mainRefs, ref)) mainRefs.push(ref);
  }

  const followers: VertexState[] = [];
  for (const id of candidateIds) {
    if (id === feature.id) continue;

    const candidate = store.getFeature(id);
    if (!candidate || !isFollowCandidate(candidate, store)) continue;

    const refs = findVertexRefsAt(candidate, targets);
    if (refs.length === 0) continue;

    const state = startVertexMove(candidate, refs, startLngLat);
    if (state) followers.push(state);
  }

  return { mainRefs, followers };
}
