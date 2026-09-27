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
import { getVertexPart } from '../shared/utils/vertex-ref.js';
import type { Coordinate, Feature, FeatureCoordinates, VertexRef } from '../store/types.js';

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
 * Whether the ring is closed (first = last)
 */
function isClosedRing(ring: Coordinate[]): boolean {
  return (
    ring.length >= 2 &&
    ring[0][0] === ring[ring.length - 1][0] &&
    ring[0][1] === ring[ring.length - 1][1]
  );
}

/**
 * Picks out only the vertex references that belong to the given part
 */
function refsOfPart(refs: readonly VertexRef[], part: number): VertexRef[] {
  return refs.filter((r) => getVertexPart(r) === part);
}

/**
 * Sorts the vertex references into the order in which vertex deletion is applied
 *
 * Within one ring, unless the larger index is deleted first, the following indices
 * shift by the number already removed. The same holds for parts and rings (deleting
 * from a MultiPoint removes the part itself, so the part numbers shift). They are
 * therefore sorted in descending lexicographic order of (part, ring, index). That
 * way, within the same part and the same ring the order is descending by index as
 * before, and references in different parts or rings do not affect each other's
 * indices.
 *
 * @internal
 */
export function sortVertexRefsForDeletion(refs: readonly VertexRef[]): VertexRef[] {
  return [...refs].sort((a, b) => {
    const partDiff = getVertexPart(b) - getVertexPart(a);
    if (partDiff !== 0) return partDiff;
    const ringDiff = b.ring - a.ring;
    if (ringDiff !== 0) return ringDiff;
    return b.index - a.index;
  });
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
 * Makes only the top-level array of the coordinates new
 *
 * A copy that keeps the current contract, "a new top-level array is returned", even
 * on a branch that does not change the coordinates. The elements (parts / rings /
 * coordinate pairs) keep sharing references with the input.
 */
function copyTopLevelCoordinates(coordinates: FeatureCoordinates): FeatureCoordinates {
  return (coordinates as unknown[]).slice() as FeatureCoordinates;
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
  const part = getVertexPart(after);

  if (feature.type === 'LineString') {
    const lineCoords = (coordinatesOf(feature) as Coordinate[]).slice();
    // It has neither rings nor parts, so nothing is added other than ring 0 / part 0
    if (after.ring !== 0 || part !== 0) return lineCoords;
    lineCoords.splice(after.index + 1, 0, newCoord);
    return lineCoords;
  }

  if (feature.type === 'Polygon') {
    const initialRings = coordinatesOf(feature) as Coordinate[][];
    const rings = initialRings.slice();
    if (part !== 0) return rings;
    if (after.ring < 0 || after.ring >= rings.length) return rings;
    const ring = initialRings[after.ring].slice();
    ring.splice(after.index + 1, 0, newCoord);
    rings[after.ring] = ring;
    return rings;
  }

  if (feature.type === 'MultiLineString') {
    const initialParts = coordinatesOf(feature) as Coordinate[][];
    const parts = initialParts.slice();
    if (after.ring !== 0) return parts;
    if (part < 0 || part >= parts.length) return parts;
    const line = initialParts[part].slice();
    line.splice(after.index + 1, 0, newCoord);
    parts[part] = line;
    return parts;
  }

  if (feature.type === 'MultiPolygon') {
    const initialParts = coordinatesOf(feature) as Coordinate[][][];
    const parts = initialParts.slice();
    if (part < 0 || part >= parts.length) return parts;
    const initialRings = initialParts[part];
    if (after.ring < 0 || after.ring >= initialRings.length) return parts;
    const rings = initialRings.slice();
    const ring = initialRings[after.ring].slice();
    ring.splice(after.index + 1, 0, newCoord);
    rings[after.ring] = ring;
    parts[part] = rings;
    return parts;
  }

  return copyTopLevelCoordinates(coordinatesOf(feature));
}

/**
 * Returns an array of rings with one vertex deleted from a ring of the polygon
 *
 * The tests for the minimum vertex count and for a closed ring are done per ring. For
 * a MultiPolygon they are done per part and ring (even if a ring of one part is at
 * the minimum vertex count, the other parts are unaffected).
 *
 * copy-on-write: only the array of rings and the target ring are copied, and the
 * other rings and the coordinate pairs keep sharing references with initialRings.
 * initialRings is not rewritten.
 *
 * @returns The new array of rings when the deletion succeeded, null when it did not
 */
function deleteVertexFromRings(
  initialRings: Coordinate[][],
  ref: VertexRef,
): Coordinate[][] | null {
  if (ref.ring < 0 || ref.ring >= initialRings.length) return null;
  const initialRing = initialRings[ref.ring];

  const isClosed = isClosedRing(initialRing);

  // A polygon needs at least 3 points (4 counting the closing point). An inner ring
  // has the same condition, and a ring that cannot be reduced any further refuses the
  // deletion (no collapsed ring is created).
  const minPoints = isClosed ? 4 : 3;
  if (initialRing.length <= minPoints) return null;

  // Out of range is refused
  if (ref.index < 0 || ref.index >= initialRing.length) return null;

  // The last vertex of a closed ring is a duplicate of the first one (the closing
  // point) and is not an independent vertex. Deleting it would break the ring (the
  // first one would be overwritten by the value of the last one), so it is refused.
  // To remove the closing point, delete the first one (index 0).
  if (isClosed && ref.index === initialRing.length - 1) return null;

  // Delete (this is done on the copied ring)
  const ring = initialRing.slice();
  ring.splice(ref.index, 1);

  // When the first vertex of a closed ring was removed, the new last one (= the old
  // closing point) is synchronized to the new first one so that it stays closed. For
  // any other vertex deletion the first and the last ones do not change, so no
  // synchronization is needed.
  // The rewrite is done by assigning a new pair array (because the coordinate pairs
  // are shared with the input).
  if (isClosed && ref.index === 0) {
    ring[ring.length - 1] = [...ring[0]];
  }

  const rings = initialRings.slice();
  rings[ref.ring] = ring;
  return rings;
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
  const part = getVertexPart(ref);

  if (feature.type === 'Point') {
    // The vertex of a Point cannot be deleted
    return null;
  }

  if (feature.type === 'LineString') {
    // It has neither rings nor parts, so anything other than ring 0 / part 0 is an
    // invalid reference
    if (ref.ring !== 0 || part !== 0) return null;
    const initialCoords = coordinatesOf(feature) as Coordinate[];
    // At least 2 points are needed
    if (initialCoords.length <= 2) return null;
    const lineCoords = initialCoords.slice();
    lineCoords.splice(ref.index, 1);
    return lineCoords;
  }

  if (feature.type === 'Polygon') {
    if (part !== 0) return null;
    return deleteVertexFromRings(coordinatesOf(feature) as Coordinate[][], ref);
  }

  if (feature.type === 'MultiPoint') {
    // Deleting a vertex removes the part itself. The last remaining part cannot be
    // removed
    const initialPoints = coordinatesOf(feature) as Coordinate[];
    if (ref.ring !== 0 || ref.index !== 0) return null;
    if (part < 0 || part >= initialPoints.length) return null;
    if (initialPoints.length <= 1) return null;
    const points = initialPoints.slice();
    points.splice(part, 1);
    return points;
  }

  if (feature.type === 'MultiLineString') {
    const initialParts = coordinatesOf(feature) as Coordinate[][];
    if (ref.ring !== 0) return null;
    if (part < 0 || part >= initialParts.length) return null;
    const initialLine = initialParts[part];
    // At least 2 points are needed (this is decided per part)
    if (initialLine.length <= 2) return null;
    const line = initialLine.slice();
    line.splice(ref.index, 1);
    const parts = initialParts.slice();
    parts[part] = line;
    return parts;
  }

  if (feature.type === 'MultiPolygon') {
    const initialParts = coordinatesOf(feature) as Coordinate[][][];
    if (part < 0 || part >= initialParts.length) return null;
    const rings = deleteVertexFromRings(initialParts[part], ref);
    if (!rings) return null;
    const parts = initialParts.slice();
    parts[part] = rings;
    return parts;
  }

  return copyTopLevelCoordinates(coordinatesOf(feature));
}

/**
 * Starts the vertex movement operation
 *
 * @internal
 */
export function startVertexMove(
  feature: Feature,
  vertices: VertexRef[],
  startLngLat: { lng: number; lat: number },
): VertexState | null {
  if (vertices.length === 0) return null;

  // Check the validity of the vertex references
  if (feature.type === 'Point') {
    if (vertices.length !== 1) return null;
    const ref = vertices[0];
    if (getVertexPart(ref) !== 0 || ref.ring !== 0 || ref.index !== 0) return null;
  } else if (feature.type === 'LineString') {
    const coords = coordinatesOf(feature) as Coordinate[];
    const isValid = vertices.every(
      (r) => getVertexPart(r) === 0 && r.ring === 0 && r.index >= 0 && r.index < coords.length,
    );
    if (!isValid) return null;
  } else if (feature.type === 'Polygon') {
    const rings = coordinatesOf(feature) as Coordinate[][];
    if (rings.length === 0) return null;
    const isValid = vertices.every(
      (r) =>
        getVertexPart(r) === 0 &&
        r.ring >= 0 &&
        r.ring < rings.length &&
        r.index >= 0 &&
        r.index < rings[r.ring].length,
    );
    if (!isValid) return null;
  } else if (feature.type === 'MultiPoint') {
    const points = coordinatesOf(feature) as Coordinate[];
    if (points.length === 0) return null;
    const isValid = vertices.every((r) => {
      const part = getVertexPart(r);
      return part >= 0 && part < points.length && r.ring === 0 && r.index === 0;
    });
    if (!isValid) return null;
  } else if (feature.type === 'MultiLineString') {
    const parts = coordinatesOf(feature) as Coordinate[][];
    if (parts.length === 0) return null;
    const isValid = vertices.every((r) => {
      const part = getVertexPart(r);
      if (part < 0 || part >= parts.length) return false;
      return r.ring === 0 && r.index >= 0 && r.index < parts[part].length;
    });
    if (!isValid) return null;
  } else if (feature.type === 'MultiPolygon') {
    const parts = coordinatesOf(feature) as Coordinate[][][];
    if (parts.length === 0) return null;
    const isValid = vertices.every((r) => {
      const part = getVertexPart(r);
      if (part < 0 || part >= parts.length) return false;
      const rings = parts[part];
      if (r.ring < 0 || r.ring >= rings.length) return false;
      return r.index >= 0 && r.index < rings[r.ring].length;
    });
    if (!isValid) return null;
  } else {
    return null;
  }

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
