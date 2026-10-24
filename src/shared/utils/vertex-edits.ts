// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The edits of the vertices of coordinates
 *
 * The vertex operations of the select mode and the edits a Store applies change the vertices of
 * a geometry the same way, through the functions here. They take the kind of the coordinates
 * (`Point`, `LineString`, `Polygon` and their Multi kinds; any other name is a kind without
 * vertices) and a vertex as a part number + a ring number + a vertex index (VertexRef).
 *
 * The coordinates are built with copy-on-write: the top-level array is always new, only the
 * containers that change (the target ring / part) are copied, and the other parts / rings /
 * coordinate pairs keep sharing references with the input. The input is never rewritten.
 */

import type { Coordinate, FeatureCoordinates, VertexRef } from '../types/model.js';
import { getVertexPart } from './vertex-ref.js';

/**
 * Whether the ring is closed (first = last)
 *
 * @internal
 */
export function isClosedRing(ring: readonly Coordinate[]): boolean {
  return (
    ring.length >= 2 &&
    ring[0][0] === ring[ring.length - 1][0] &&
    ring[0][1] === ring[ring.length - 1][1]
  );
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
 * Whether the reference names a vertex of the coordinates of this kind
 *
 * A Point has the one vertex of part 0, ring 0, index 0; each point of a MultiPoint is a part,
 * with ring 0 and index 0; a line has ring 0 only; a single kind has part 0 only. A kind without
 * vertices has none.
 *
 * @internal
 */
export function isVertexOf(kind: string, coordinates: FeatureCoordinates, ref: VertexRef): boolean {
  const part = getVertexPart(ref);
  switch (kind) {
    case 'Point':
      return part === 0 && ref.ring === 0 && ref.index === 0;
    case 'LineString':
      return (
        part === 0 &&
        ref.ring === 0 &&
        ref.index >= 0 &&
        ref.index < (coordinates as Coordinate[]).length
      );
    case 'Polygon': {
      const rings = coordinates as Coordinate[][];
      return (
        part === 0 &&
        ref.ring >= 0 &&
        ref.ring < rings.length &&
        ref.index >= 0 &&
        ref.index < rings[ref.ring].length
      );
    }
    case 'MultiPoint':
      return (
        part >= 0 &&
        part < (coordinates as Coordinate[]).length &&
        ref.ring === 0 &&
        ref.index === 0
      );
    case 'MultiLineString': {
      const parts = coordinates as Coordinate[][];
      if (part < 0 || part >= parts.length) return false;
      return ref.ring === 0 && ref.index >= 0 && ref.index < parts[part].length;
    }
    case 'MultiPolygon': {
      const parts = coordinates as Coordinate[][][];
      if (part < 0 || part >= parts.length) return false;
      const rings = parts[part];
      if (ref.ring < 0 || ref.ring >= rings.length) return false;
      return ref.index >= 0 && ref.index < rings[ref.ring].length;
    }
    default:
      return false;
  }
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
 * Inserts a vertex into a line or a ring, at the index of `at` (the vertex there and the ones
 * after it follow the new one)
 *
 * A point and the points of a MultiPoint take no vertex, and a reference to a ring or a part the
 * coordinates do not have inserts nothing: the coordinates are returned unchanged then (with a
 * new top-level array). The index is not checked against the length of the line or the ring.
 *
 * @internal
 */
export function insertVertexAt(
  kind: string,
  coordinates: FeatureCoordinates,
  at: VertexRef,
  position: Coordinate,
): FeatureCoordinates {
  const part = getVertexPart(at);

  if (kind === 'LineString') {
    const lineCoords = (coordinates as Coordinate[]).slice();
    // It has neither rings nor parts, so nothing is added other than ring 0 / part 0
    if (at.ring !== 0 || part !== 0) return lineCoords;
    lineCoords.splice(at.index, 0, position);
    return lineCoords;
  }

  if (kind === 'Polygon') {
    const initialRings = coordinates as Coordinate[][];
    const rings = initialRings.slice();
    if (part !== 0) return rings;
    if (at.ring < 0 || at.ring >= rings.length) return rings;
    const ring = initialRings[at.ring].slice();
    ring.splice(at.index, 0, position);
    rings[at.ring] = ring;
    return rings;
  }

  if (kind === 'MultiLineString') {
    const initialParts = coordinates as Coordinate[][];
    const parts = initialParts.slice();
    if (at.ring !== 0) return parts;
    if (part < 0 || part >= parts.length) return parts;
    const line = initialParts[part].slice();
    line.splice(at.index, 0, position);
    parts[part] = line;
    return parts;
  }

  if (kind === 'MultiPolygon') {
    const initialParts = coordinates as Coordinate[][][];
    const parts = initialParts.slice();
    if (part < 0 || part >= parts.length) return parts;
    const initialRings = initialParts[part];
    if (at.ring < 0 || at.ring >= initialRings.length) return parts;
    const rings = initialRings.slice();
    const ring = initialRings[at.ring].slice();
    ring.splice(at.index, 0, position);
    rings[at.ring] = ring;
    parts[part] = rings;
    return parts;
  }

  return copyTopLevelCoordinates(coordinates);
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
 * A line keeps at least 2 positions and a ring at least 3 vertices (4 positions when it is
 * closed); the closing point of a closed ring is deleted through its first vertex (index 0).
 * Deleting a point of a MultiPoint removes the part itself, and the last one stays. The index of
 * a line is not checked against its length. A kind without vertices other than Point is
 * returned unchanged (with a new top-level array).
 *
 * @returns The new coordinates, or null when the vertex cannot be deleted
 * @internal
 */
export function deleteVertexAt(
  kind: string,
  coordinates: FeatureCoordinates,
  ref: VertexRef,
): FeatureCoordinates | null {
  const part = getVertexPart(ref);

  if (kind === 'Point') {
    // The vertex of a Point cannot be deleted
    return null;
  }

  if (kind === 'LineString') {
    // It has neither rings nor parts, so anything other than ring 0 / part 0 is an
    // invalid reference
    if (ref.ring !== 0 || part !== 0) return null;
    const initialCoords = coordinates as Coordinate[];
    // At least 2 points are needed
    if (initialCoords.length <= 2) return null;
    const lineCoords = initialCoords.slice();
    lineCoords.splice(ref.index, 1);
    return lineCoords;
  }

  if (kind === 'Polygon') {
    if (part !== 0) return null;
    return deleteVertexFromRings(coordinates as Coordinate[][], ref);
  }

  if (kind === 'MultiPoint') {
    // Deleting a vertex removes the part itself. The last remaining part cannot be
    // removed
    const initialPoints = coordinates as Coordinate[];
    if (ref.ring !== 0 || ref.index !== 0) return null;
    if (part < 0 || part >= initialPoints.length) return null;
    if (initialPoints.length <= 1) return null;
    const points = initialPoints.slice();
    points.splice(part, 1);
    return points;
  }

  if (kind === 'MultiLineString') {
    const initialParts = coordinates as Coordinate[][];
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

  if (kind === 'MultiPolygon') {
    const initialParts = coordinates as Coordinate[][][];
    if (part < 0 || part >= initialParts.length) return null;
    const rings = deleteVertexFromRings(initialParts[part], ref);
    if (!rings) return null;
    const parts = initialParts.slice();
    parts[part] = rings;
    return parts;
  }

  return copyTopLevelCoordinates(coordinates);
}

/**
 * Puts vertices at positions: each reference at the position of the same index
 *
 * The references are vertices of the coordinates ({@link isVertexOf}); a later reference to the
 * same vertex wins. The two ends of a closed ring are not kept together here: the caller gives
 * both. The positions are copied.
 *
 * @internal
 */
export function setVertices(
  kind: string,
  coordinates: FeatureCoordinates,
  refs: readonly VertexRef[],
  positions: readonly Coordinate[],
): FeatureCoordinates {
  const copy = (position: Coordinate): Coordinate => [position[0], position[1]];
  if (kind === 'Point') {
    return refs.length === 0 ? coordinates : copy(positions[refs.length - 1]);
  }
  const top = (coordinates as unknown[]).slice();
  // The arrays copied already, which are written in place
  const copied = new Set<unknown>();
  const own = (parent: unknown[], at: number): unknown[] => {
    let child = parent[at] as unknown[];
    if (!copied.has(child)) {
      child = child.slice();
      parent[at] = child;
      copied.add(child);
    }
    return child;
  };
  refs.forEach((ref, i) => {
    const position = copy(positions[i]);
    const part = getVertexPart(ref);
    switch (kind) {
      case 'LineString':
        top[ref.index] = position;
        break;
      case 'MultiPoint':
        top[part] = position;
        break;
      case 'Polygon':
        own(top, ref.ring)[ref.index] = position;
        break;
      case 'MultiLineString':
        own(top, part)[ref.index] = position;
        break;
      case 'MultiPolygon':
        own(own(top, part), ref.ring)[ref.index] = position;
        break;
    }
  });
  return top as FeatureCoordinates;
}
