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
import {
  deleteVertexAt,
  insertVertexAt,
  isClosedRing,
  isVertexOf,
} from '../shared/utils/vertex-edits.js';
import { getVertexPart } from '../shared/utils/vertex-ref.js';
import type { Coordinate, Feature, FeatureCoordinates, VertexRef } from '../store/types.js';

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
 * Picks out only the vertex references that belong to the given part
 */
function refsOfPart(refs: readonly VertexRef[], part: number): VertexRef[] {
  return refs.filter((r) => getVertexPart(r) === part);
}

/**
 * Groups the vertex references by part number
 *
 * For copy-on-write, only "the parts that have references" need to be known. Calling
 * refsOfPart for each part would scan the references times the number of parts, so
 * they are sorted out in a single pass.
 */
function groupRefsByPart(refs: readonly VertexRef[]): Map<number, VertexRef[]> {
  const grouped = new Map<number, VertexRef[]>();
  for (const ref of refs) {
    const part = getVertexPart(ref);
    const list = grouped.get(part);
    if (list) {
      list.push(ref);
    } else {
      grouped.set(part, [ref]);
    }
  }
  return grouped;
}

/**
 * Copies an array of rings with copy-on-write
 *
 * Only the rings that have references are replaced with new arrays; the other rings
 * keep sharing the original arrays. movePolygonVertices updates the array of rings
 * destructively (the contents of a vertex are assigned as a new pair array, so the
 * original pairs are not mutated), so the rings that may be rewritten have to be cut
 * out in advance. The synchronization of a closed ring also touches only the rings
 * that have references.
 */
function copyRingsForRefs(
  initialRings: Coordinate[][],
  refs: readonly VertexRef[],
): Coordinate[][] {
  const rings = initialRings.slice();
  for (const ref of refs) {
    if (ref.ring < 0 || ref.ring >= rings.length) continue;
    if (rings[ref.ring] === initialRings[ref.ring]) {
      rings[ref.ring] = initialRings[ref.ring].slice();
    }
  }
  return rings;
}

/**
 * Moves the vertices of a line (a single coordinate sequence)
 *
 * It has no rings, so any reference other than ring 0 is ignored.
 * coords is updated destructively, so the caller must pass a copied array.
 * A vertex is always rewritten by assigning a new pair array (the original pairs are
 * shared, so [0] / [1] must not be rewritten directly).
 */
function moveLineVertices(
  coords: Coordinate[],
  refs: readonly VertexRef[],
  dx: number,
  dy: number,
): void {
  for (const ref of refs) {
    if (ref.ring !== 0) continue;
    if (ref.index >= 0 && ref.index < coords.length) {
      coords[ref.index] = [coords[ref.index][0] + dx, coords[ref.index][1] + dy];
    }
  }
}

/**
 * Moves the vertices of a polygon (an array of rings) and keeps the rings closed
 *
 * Keeping a ring closed is done ring by ring. Only the rings that were closed before
 * the move are targeted, and when only one of the first and the last vertex moved,
 * it is synchronized to the other one (when both moved, the amount of movement is
 * the same, so it stays closed).
 *
 * rings and the rings within it that have references are updated destructively, so
 * the caller must pass what was copied by copyRingsForRefs. A vertex is always
 * rewritten by assigning a new pair array (the original pairs are shared with
 * initialRings).
 */
function movePolygonVertices(
  rings: Coordinate[][],
  initialRings: Coordinate[][],
  refs: readonly VertexRef[],
  dx: number,
  dy: number,
): void {
  for (const ref of refs) {
    if (ref.ring < 0 || ref.ring >= rings.length) continue;
    const ring = rings[ref.ring];
    if (ref.index >= 0 && ref.index < ring.length) {
      ring[ref.index] = [ring[ref.index][0] + dx, ring[ref.index][1] + dy];
    }
  }

  for (let ringIndex = 0; ringIndex < rings.length; ringIndex++) {
    const ring = rings[ringIndex];
    if (!isClosedRing(initialRings[ringIndex])) continue;

    // refs has already been narrowed down by part, so only the ring and the index are
    // looked at here
    const lastIndex = ring.length - 1;
    const movedFirst = refs.some((r) => r.ring === ringIndex && r.index === 0);
    const movedLast = refs.some((r) => r.ring === ringIndex && r.index === lastIndex);

    if (movedFirst && !movedLast) {
      ring[lastIndex] = [...ring[0]];
    } else if (movedLast && !movedFirst) {
      ring[0] = [...ring[lastIndex]];
    }
  }
}

/**
 * Computes the movement of vertices
 *
 * The coordinates are built with copy-on-write. initialCoordinates is not copied as
 * a whole; only the levels the moving vertices belong to (the top-level array and
 * the parts / rings that have references) are replaced with new arrays, and the
 * other elements keep sharing references with initialCoordinates. This function runs
 * once per movement during a drag, so with a full copy the cost would be
 * proportional to the number of vertices. The shared elements are not rewritten, so
 * initialCoordinates is not mutated.
 *
 * The top-level array is always returned as a new array even when nothing changed
 * (the caller assumes that "new coordinates are returned").
 *
 * @internal
 */
export function computeVertexMove(
  state: VertexState,
  currentLngLat: { lng: number; lat: number },
  feature: Feature,
): FeatureCoordinates {
  const { vertices, startLngLat, initialCoordinates } = state;

  // Compute the amount of movement
  const dx = currentLngLat.lng - startLngLat.lng;
  const dy = currentLngLat.lat - startLngLat.lat;

  if (feature.type === 'Point') {
    // A Point is a single coordinate
    const coord = initialCoordinates as Coordinate;
    return [coord[0] + dx, coord[1] + dy];
  }

  // For a single geometry, only the references of part 0 are looked at (part > 0 is an
  // invalid reference)
  if (feature.type === 'LineString') {
    const coords = (initialCoordinates as Coordinate[]).slice();
    moveLineVertices(coords, refsOfPart(vertices, 0), dx, dy);
    return coords;
  }

  if (feature.type === 'Polygon') {
    const initialRings = initialCoordinates as Coordinate[][];
    const refs = refsOfPart(vertices, 0);
    const rings = copyRingsForRefs(initialRings, refs);
    movePolygonVertices(rings, initialRings, refs, dx, dy);
    return rings;
  }

  if (feature.type === 'MultiPoint') {
    // Each coordinate is one part. In a reference, part = the part number, and
    // ring / index are 0
    const points = (initialCoordinates as Coordinate[]).slice();
    for (const ref of vertices) {
      if (ref.ring !== 0 || ref.index !== 0) continue;
      const part = getVertexPart(ref);
      if (part < 0 || part >= points.length) continue;
      points[part] = [points[part][0] + dx, points[part][1] + dy];
    }
    return points;
  }

  if (feature.type === 'MultiLineString') {
    // Copy only the parts that have references. A part without references shares the
    // original array
    const initialParts = initialCoordinates as Coordinate[][];
    const parts = initialParts.slice();
    for (const [part, refs] of groupRefsByPart(vertices)) {
      if (part < 0 || part >= parts.length) continue;
      const coords = initialParts[part].slice();
      moveLineVertices(coords, refs, dx, dy);
      parts[part] = coords;
    }
    return parts;
  }

  if (feature.type === 'MultiPolygon') {
    const initialParts = initialCoordinates as Coordinate[][][];
    const parts = initialParts.slice();
    for (const [part, refs] of groupRefsByPart(vertices)) {
      if (part < 0 || part >= parts.length) continue;
      const initialRings = initialParts[part];
      const rings = copyRingsForRefs(initialRings, refs);
      movePolygonVertices(rings, initialRings, refs, dx, dy);
      parts[part] = rings;
    }
    return parts;
  }

  // Types without vertex movement (Circle / Image and so on). startVertexMove creates
  // no state for them so control does not reach here, but even if it does the
  // coordinates are not changed
  return initialCoordinates;
}

/**
 * Adds a vertex (an addition from a midpoint handle)
 *
 * A MultiPoint has no edges, so there is no addition from a midpoint, and the
 * coordinates are never changed.
 *
 * The coordinates are built with copy-on-write (the same manner as
 * computeVertexMove). The top-level array is always made new, only the container
 * that splice changes (the target ring / part) is copied, and the other parts /
 * rings / coordinate pairs keep sharing references with the input. The input
 * geometry is never rewritten. For a feature on the order of 100,000
 * vertices a full copy took more than ten milliseconds each time, which produced a
 * hitch on a single click that added a vertex.
 *
 * @param after The vertex reference just before the position where the new vertex is
 *   inserted
 *
 * @internal
 */
export function addVertex(
  feature: Feature,
  after: VertexRef,
  newCoord: Coordinate,
): FeatureCoordinates {
  return insertVertexAt(
    feature.type,
    coordinatesOf(feature),
    { ...after, index: after.index + 1 },
    newCoord,
  );
}

/**
 * Deletes a vertex
 *
 * The coordinates are built with copy-on-write (the same manner as
 * computeVertexMove). The top-level array is always made new, only the container
 * that splice changes (the target ring / part) is copied, and the other parts /
 * rings / coordinate pairs keep sharing references with the input. The input
 * geometry is never rewritten.
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
    // replacement with a new array), and during a drag computeVertexMove also builds a
    // new array every time and swaps it in.
    // So holding a reference from the start is enough: the contents do not change
    // afterwards and no copy is needed
    initialCoordinates: coordinatesOf(feature),
  };
}
