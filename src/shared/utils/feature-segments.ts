// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The edges of a feature
 *
 * Lists the edges (and the parts) of a feature with their vertex references. The snapping
 * providers and the tracing graph (operations/trace-graph.ts) both enumerate edges this way,
 * so the listing sits in shared/. It is pure: it reads only the coordinates of the feature.
 */

import {
  getSegmentGrid,
  querySegmentIndicesInBBox,
  SEGMENT_INDEX_THRESHOLD,
} from '../math/segment-grid.js';
import type { BoundingBox, Coordinate, Feature, VertexRef } from '../types/model.js';
import { coordinatesOf } from './coordinates.js';

/**
 * The visit function for an edge (called during the listing of edges)
 *
 * @internal
 */
export type SegmentVisitor = (
  start: Coordinate,
  end: Coordinate,
  startRef: VertexRef,
  endRef: VertexRef,
) => void;

/**
 * Whether the feature type has edges (whether it is a target of edge snapping)
 *
 * It is aligned with the types that support vertex editing. Point has vertices only,
 * and Circle / Image / Freehand are out of scope.
 */
export function hasSnapEdges(type: string): boolean {
  return (
    type === 'LineString' ||
    type === 'Polygon' ||
    type === 'MultiLineString' ||
    type === 'MultiPolygon'
  );
}

/**
 * Whether the segment overlaps the bbox (a cheap preliminary test)
 *
 * The real test against the tolerance is done by SnapService using the distance to
 * the nearest point, so all this guarantees is that nothing is missed.
 */
export function segmentIntersectsBBox(
  start: Coordinate,
  end: Coordinate,
  bbox: BoundingBox,
): boolean {
  const minX = Math.min(start[0], end[0]);
  const maxX = Math.max(start[0], end[0]);
  const minY = Math.min(start[1], end[1]);
  const maxY = Math.max(start[1], end[1]);
  return minX <= bbox.maxX && maxX >= bbox.minX && minY <= bbox.maxY && maxY >= bbox.minY;
}

/**
 * Whether the point is inside the bbox (the boundary included)
 *
 * @internal
 */
export function isInBBox(position: Coordinate, bbox: BoundingBox): boolean {
  return (
    position[0] >= bbox.minX &&
    position[0] <= bbox.maxX &&
    position[1] >= bbox.minY &&
    position[1] <= bbox.maxY
  );
}

/**
 * The visit function for a part (one line / one ring)
 *
 * ring / part are the very values used to build a VertexRef. isRing says whether it
 * is a ring (a ring of a Polygon / MultiPolygon), which changes how the closing point
 * is handled.
 *
 * @internal
 */
export type PartVisitor = (
  coords: Coordinate[],
  ring: number,
  part: number | undefined,
  isRing: boolean,
) => void;

/**
 * Lists the parts of a feature per type
 *
 * A helper that lets the listing of edges and the listing of vertices share the
 * branching on type. Types without edges (Point / MultiPoint / custom types) call
 * nothing.
 *
 * @internal
 */
export function forEachPart(feature: Feature, visit: PartVisitor): void {
  switch (feature.type) {
    case 'LineString':
      visit(coordinatesOf(feature) as Coordinate[], 0, undefined, false);
      break;

    case 'Polygon': {
      const rings = coordinatesOf(feature) as Coordinate[][];
      for (let ring = 0; ring < rings.length; ring++) {
        visit(rings[ring], ring, undefined, true);
      }
      break;
    }

    case 'MultiLineString': {
      const parts = coordinatesOf(feature) as Coordinate[][];
      for (let part = 0; part < parts.length; part++) {
        visit(parts[part], 0, part, false);
      }
      break;
    }

    case 'MultiPolygon': {
      const parts = coordinatesOf(feature) as Coordinate[][][];
      for (let part = 0; part < parts.length; part++) {
        const rings = parts[part];
        for (let ring = 0; ring < rings.length; ring++) {
          visit(rings[ring], ring, part, true);
        }
      }
      break;
    }
  }
}

/**
 * Builds a function that builds vertex references
 *
 * @internal
 */
export function makeRefFactory(
  ring: number,
  part: number | undefined,
): (index: number) => VertexRef {
  return (index: number): VertexRef =>
    part === undefined ? { ring, index } : { part, ring, index };
}

/**
 * Whether the coordinate sequence is closed (whether the last item is a copy of the
 * first one)
 *
 * @internal
 */
export function isClosedCoords(coords: Coordinate[]): boolean {
  if (coords.length === 0) return false;
  const first = coords[0];
  const last = coords[coords.length - 1];
  return first[0] === last[0] && first[1] === last[1];
}

/**
 * Gathers the edges of one coordinate sequence (a line / a ring)
 *
 * In a ring where closed is true, the last item is a copy of the first one, so the
 * vertex reference of the last item is normalized to index 0 (to make the test for
 * exclusion match the vertex handles).
 */
function collectSegments(
  coords: Coordinate[],
  ring: number,
  part: number | undefined,
  visit: SegmentVisitor,
): void {
  if (coords.length < 2) return;

  const closed = isClosedCoords(coords);
  const vertexCount = closed ? coords.length - 1 : coords.length;
  const toRef = makeRefFactory(ring, part);

  for (let i = 0; i < coords.length - 1; i++) {
    const endIndex = closed && i + 1 === vertexCount ? 0 : i + 1;
    visit(coords[i], coords[i + 1], toRef(i), toRef(endIndex));
  }
}

/**
 * Gathers only the edges of one coordinate sequence (a line / a ring) that fall
 * within the bbox
 *
 * For a part whose vertex count is at or above the threshold, the candidates are
 * narrowed down with a segment grid index. The values passed to visit are exactly the
 * same as in collectSegments (the last item of a closed ring is normalized to index
 * 0).
 */
function collectSegmentsInBBox(
  coords: Coordinate[],
  ring: number,
  part: number | undefined,
  bbox: BoundingBox,
  visit: SegmentVisitor,
): void {
  if (coords.length < 2) return;

  const closed = isClosedCoords(coords);
  const vertexCount = closed ? coords.length - 1 : coords.length;
  const toRef = makeRefFactory(ring, part);

  const visitSegment = (i: number): void => {
    if (!segmentIntersectsBBox(coords[i], coords[i + 1], bbox)) return;
    const endIndex = closed && i + 1 === vertexCount ? 0 : i + 1;
    visit(coords[i], coords[i + 1], toRef(i), toRef(endIndex));
  };

  // For a small part, building an index costs more, so it is scanned as it is
  if (coords.length < SEGMENT_INDEX_THRESHOLD) {
    for (let i = 0; i < coords.length - 1; i++) {
      visitSegment(i);
    }
    return;
  }

  for (const i of querySegmentIndicesInBBox(getSegmentGrid(coords), bbox)) {
    visitSegment(i);
  }
}

/**
 * Gathers the edges of a feature
 *
 * @internal
 */
export function collectFeatureSegments(feature: Feature, visit: SegmentVisitor): void {
  forEachPart(feature, (coords, ring, part) => {
    collectSegments(coords, ring, part, visit);
  });
}

/**
 * Gathers only the edges of a feature that fall within the bbox
 *
 * The result is the same as applying a preliminary bbox filter to
 * collectFeatureSegments; only for a huge part is the listing narrowed down with a
 * segment grid index.
 */
export function collectFeatureSegmentsInBBox(
  feature: Feature,
  bbox: BoundingBox,
  visit: SegmentVisitor,
): void {
  forEachPart(feature, (coords, ring, part) => {
    collectSegmentsInBBox(coords, ring, part, bbox, visit);
  });
}
