// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Splitting by a line
 *
 * Cuts a polygon with a polyline and divides it into several parts. The body is a
 * planar arrangement.
 *
 *   1. Find every intersection of the outline of the polygon and the cutting line, and
 *      chop the segments at the intersections (noding)
 *   2. Assemble the chopped segments as a planar graph and drop the dead ends (dangles)
 *   3. Extract the minimal cycles (faces) of the graph
 *   4. Take the intersection of each cycle and the original polygon, and make it a part
 *
 * Because the intersection with the original polygon is taken in step 4, the holes (the
 * inner rings) are restored automatically. A cycle itself is a simple ring with no
 * holes, and a cycle that lies inside a hole has an empty intersection and is dropped.
 *
 * The measure of dropping the dead ends is what realizes "a line that does not pass
 * through does not split". A line that breaks off inside the polygon always has an end
 * of degree 1, so it disappears without contributing to a cycle.
 *
 * The limitations are the same as those of the whole geometry module (crossing the ±180
 * degree meridian and the vicinity of the poles are out of scope). In addition, when
 * the cutting line has an interval that overlaps the outline of the polygon collinearly,
 * that overlap is not treated as an intersection (because a collinear overlap cannot be
 * expressed by a single point).
 */

import { intersection, normalizeArea } from './boolean.js';
import { signedRingArea } from './simplify.js';
import type { AreaCoordinates, Coordinate, MultiPolygonCoordinates, Ring } from './types.js';

/**
 * The error allowed in the parameter of a segment
 *
 * In a T-shaped touch where an endpoint lies on the other segment, the parameter can
 * fall slightly outside 0 / 1 because of the rounding error. That much is allowed.
 */
const PARAMETER_EPSILON = 1e-12;

/**
 * The step of the quantization that identifies a node (degrees)
 *
 * 1e-9 degrees is roughly 0.1mm at the equator. An intersection uses the same value on
 * the outline side and on the line side, so the two match exactly, but in a T-shaped
 * touch that passes over a vertex the computed intersection differs from the original
 * vertex by the least significant digit alone. A key rounded by this step makes them
 * count as the same node.
 */
const NODE_QUANTUM = 1e-9;

/**
 * Returns the intersection point of two segments on the lng/lat plane.
 *
 * Returns null when they do not cross. Parallel segments and collinear segments are
 * null as well. An interval that overlaps collinearly cannot be expressed by a single
 * point, so it is not treated as an intersection (the endpoints of the overlap are not
 * returned either). A touch between endpoints, and a T-shaped touch where an endpoint
 * lies in the interior of the other, are returned as intersections. A segment of length
 * 0 has no direction, so it is always null.
 *
 * The test is whether the parameter is between 0 and 1 inclusive, with both ends
 * loosened by the rounding error.
 *
 * @param a1 The start of segment A, `[lng, lat]` in degrees
 * @param a2 The end of segment A, `[lng, lat]` in degrees
 * @param b1 The start of segment B, `[lng, lat]` in degrees
 * @param b2 The end of segment B, `[lng, lat]` in degrees
 * @returns The intersection `[lng, lat]`, taken on segment A. `null` when they do not
 *   cross, are parallel or collinear, or either has length 0
 */
export function segmentIntersection(
  a1: Coordinate,
  a2: Coordinate,
  b1: Coordinate,
  b2: Coordinate,
): Coordinate | null {
  const ax = a2[0] - a1[0];
  const ay = a2[1] - a1[1];
  const bx = b2[0] - b1[0];
  const by = b2[1] - b1[1];

  // When the cross product is 0, the two segments are parallel (collinear included) or
  // one of them is degenerate
  const denominator = ax * by - ay * bx;
  if (denominator === 0) return null;

  const dx = b1[0] - a1[0];
  const dy = b1[1] - a1[1];
  const t = (dx * by - dy * bx) / denominator;
  const u = (dx * ay - dy * ax) / denominator;

  if (t < -PARAMETER_EPSILON || t > 1 + PARAMETER_EPSILON) return null;
  if (u < -PARAMETER_EPSILON || u > 1 + PARAMETER_EPSILON) return null;

  // Pull what fell outside because of the error back onto the segment
  const clamped = Math.min(1, Math.max(0, t));
  return [a1[0] + clamped * ax, a1[1] + clamped * ay];
}

/**
 * Cuts a polygon with a polyline and returns each resulting part.
 *
 * When the line does not pass through the polygon (it does not cross, it stops inside the
 * polygon, it only touches an edge or a vertex, or it runs only inside a hole), the
 * original polygon is returned as a single part without splitting. When the line crosses several times, the result is
 * divided into one part per spatially connected mass. When only a portion of a
 * MultiPolygon is cut, the parts that were not cut are returned as separate parts as
 * well.
 *
 * Each part is MultiPolygon coordinates with the orientations and the degeneracies
 * tidied up (a part with a hole comes with its inner ring). An empty array is returned
 * for an input that has no area.
 *
 * A stretch where the line runs collinear with the outline is not treated as a crossing,
 * and positions closer than 1e-9 degrees (about 0.1 mm) count as the same position.
 *
 * @param area The Polygon or MultiPolygon coordinates to cut, in degrees
 * @param line The cutting polyline `[lng, lat][]` in degrees. Fewer than 2 positions cut
 *   nothing
 * @returns The normalized MultiPolygon coordinates of each part. A single element (the
 *   input normalized) when it is not split. An empty array when the input has no area
 * @throws {@link GeometryError} when the boolean operation engine fails even after the
 *   retry on the 1e-9 degree grid
 */
export function splitArea(area: AreaCoordinates, line: Coordinate[]): MultiPolygonCoordinates[] {
  const normalized = normalizeArea(area);
  if (normalized.length === 0) return [];
  if (line.length < 2) return [normalized];

  const arrangement = buildArrangement(normalized, line);
  if (arrangement === null) return [normalized];

  const parts: MultiPolygonCoordinates[] = [];
  for (const face of extractFaces(arrangement)) {
    // A cycle is a simple ring with no holes. The intersection with the original
    // polygon drops the holes and the outside
    const part = intersection([face], normalized);
    if (part.length > 0) parts.push(part);
  }

  // If only one mass comes out, the line has not divided the polygon
  return parts.length > 1 ? parts : [normalized];
}

/** A segment before noding */
interface RawSegment {
  a: Coordinate;
  b: Coordinate;
}

/** An edge of the planar graph */
interface ArrangementEdge {
  /** The node ID of one end */
  a: number;
  /** The node ID of the other end */
  b: number;
  /** Whether it derives from the cutting line */
  fromLine: boolean;
  /** Whether it derives from the outline of the polygon */
  fromRing: boolean;
  /** Whether it was dropped by the dangle removal */
  removed: boolean;
}

/** The planar graph */
interface Arrangement {
  /** The coordinates of the nodes (the index is the node ID) */
  nodes: Coordinate[];
  /** The edges */
  edges: ArrangementEdge[];
  /** The IDs of the edges connected to each node */
  adjacency: number[][];
}

/** The key that identifies a node */
function nodeKey(coordinate: Coordinate): string {
  return `${Math.round(coordinate[0] / NODE_QUANTUM)},${Math.round(coordinate[1] / NODE_QUANTUM)}`;
}

/** Pushes only the segments whose length is not 0 */
function pushSegment(segments: RawSegment[], a: Coordinate, b: Coordinate): void {
  if (a[0] === b[0] && a[1] === b[1]) return;
  segments.push({ a, b });
}

/**
 * Expands every ring of the polygon into segments
 *
 * A ring that is not closed is treated as closed as well.
 */
function ringSegments(area: MultiPolygonCoordinates): RawSegment[] {
  const segments: RawSegment[] = [];
  for (const polygon of area) {
    for (const ring of polygon) {
      if (ring.length < 3) continue;
      for (let i = 0; i + 1 < ring.length; i++) {
        pushSegment(segments, ring[i], ring[i + 1]);
      }
      pushSegment(segments, ring[ring.length - 1], ring[0]);
    }
  }
  return segments;
}

/** Expands a polyline into segments */
function lineSegments(line: Coordinate[]): RawSegment[] {
  const segments: RawSegment[] = [];
  for (let i = 0; i + 1 < line.length; i++) {
    pushSegment(segments, line[i], line[i + 1]);
  }
  return segments;
}

/**
 * Divides a segment at the points that chop it, making a coordinate sequence from end
 * to end
 *
 * The points are ordered by the distance from the start point, and both ends as well as
 * duplicates at the same position are dropped.
 */
function chainOf(segment: RawSegment, cuts: Coordinate[]): Coordinate[] {
  if (cuts.length === 0) return [segment.a, segment.b];

  const startKey = nodeKey(segment.a);
  const endKey = nodeKey(segment.b);
  const seen = new Set<string>([startKey, endKey]);
  const inner: { coordinate: Coordinate; distance: number }[] = [];

  for (const cut of cuts) {
    const key = nodeKey(cut);
    if (seen.has(key)) continue;
    seen.add(key);
    const dx = cut[0] - segment.a[0];
    const dy = cut[1] - segment.a[1];
    inner.push({ coordinate: cut, distance: dx * dx + dy * dy });
  }

  inner.sort((left, right) => left.distance - right.distance);
  return [segment.a, ...inner.map((entry) => entry.coordinate), segment.b];
}

/**
 * Assembles the noded planar graph and drops the dangles
 *
 * The outlines of the polygon do not cross one another (normalizeArea guarantees this),
 * so only "line x outline" and "line x line" are examined for intersections.
 *
 * @returns The graph when an edge of the cutting line remains. null when none remains
 *   (no passing through)
 */
function buildArrangement(area: MultiPolygonCoordinates, line: Coordinate[]): Arrangement | null {
  const ringSegs = ringSegments(area);
  const lineSegs = lineSegments(line);
  if (ringSegs.length === 0 || lineSegs.length === 0) return null;

  const ringCuts: Coordinate[][] = ringSegs.map(() => []);
  const lineCuts: Coordinate[][] = lineSegs.map(() => []);

  for (let i = 0; i < lineSegs.length; i++) {
    for (let j = 0; j < ringSegs.length; j++) {
      const point = segmentIntersection(lineSegs[i].a, lineSegs[i].b, ringSegs[j].a, ringSegs[j].b);
      if (point === null) continue;
      lineCuts[i].push(point);
      ringCuts[j].push(point);
    }
    // A self-intersection of the line can also form a cycle, so make it a node
    for (let k = i + 1; k < lineSegs.length; k++) {
      const point = segmentIntersection(lineSegs[i].a, lineSegs[i].b, lineSegs[k].a, lineSegs[k].b);
      if (point === null) continue;
      lineCuts[i].push(point);
      lineCuts[k].push(point);
    }
  }

  const nodes: Coordinate[] = [];
  const nodeIds = new Map<string, number>();
  const edges: ArrangementEdge[] = [];
  const edgeIds = new Map<string, number>();
  const adjacency: number[][] = [];

  const idOf = (coordinate: Coordinate): number => {
    const key = nodeKey(coordinate);
    const existing = nodeIds.get(key);
    if (existing !== undefined) return existing;
    const id = nodes.length;
    nodes.push(coordinate);
    nodeIds.set(key, id);
    adjacency.push([]);
    return id;
  };

  const addEdge = (a: number, b: number, fromLine: boolean): void => {
    // An edge whose ends fell onto the same node by the quantization has no length
    if (a === b) return;
    const key = a < b ? `${a}-${b}` : `${b}-${a}`;
    const existing = edgeIds.get(key);
    if (existing !== undefined) {
      // A line that overlaps the outline is not a "cutting edge"
      edges[existing].fromLine ||= fromLine;
      edges[existing].fromRing ||= !fromLine;
      return;
    }
    const id = edges.length;
    edges.push({ a, b, fromLine, fromRing: !fromLine, removed: false });
    edgeIds.set(key, id);
    adjacency[a].push(id);
    adjacency[b].push(id);
  };

  const addChain = (segments: RawSegment[], cuts: Coordinate[][], fromLine: boolean): void => {
    for (let i = 0; i < segments.length; i++) {
      const chain = chainOf(segments[i], cuts[i]);
      let previous = idOf(chain[0]);
      for (let j = 1; j < chain.length; j++) {
        const current = idOf(chain[j]);
        addEdge(previous, current, fromLine);
        previous = current;
      }
    }
  };

  // Insert the outlines first so that the representative coordinate of a node is
  // aligned with the original vertex
  addChain(ringSegs, ringCuts, false);
  addChain(lineSegs, lineCuts, true);

  const arrangement: Arrangement = { nodes, edges, adjacency };
  removeDangles(arrangement);

  const hasCut = edges.some((edge) => !edge.removed && edge.fromLine && !edge.fromRing);
  return hasCut ? arrangement : null;
}

/**
 * Drops the dead-end edges
 *
 * Erasing the nodes of degree 1 and their edges is repeated until nothing more is
 * erased. A line that sticks out beyond the polygon and a line that breaks off inside
 * the polygon stop contributing to a cycle this way.
 */
function removeDangles(arrangement: Arrangement): void {
  const { edges, adjacency } = arrangement;
  const degree = adjacency.map((edgeIds) => edgeIds.length);

  const queue: number[] = [];
  for (let node = 0; node < degree.length; node++) {
    if (degree[node] <= 1) queue.push(node);
  }

  while (queue.length > 0) {
    const node = queue.pop() as number;
    if (degree[node] > 1) continue;

    for (const edgeId of adjacency[node]) {
      const edge = edges[edgeId];
      if (edge.removed) continue;
      edge.removed = true;
      degree[node]--;
      const other = edge.a === node ? edge.b : edge.a;
      degree[other]--;
      if (degree[other] <= 1) queue.push(other);
    }
  }
}

/** The key of a directed edge (the edge ID and the direction) */
function directedKey(edgeId: number, forward: boolean): string {
  return forward ? `${edgeId}+` : `${edgeId}-`;
}

/**
 * Extracts the minimal cycles (faces)
 *
 * Traversing every directed edge once each yields, per connected component, the "inner
 * faces (counter-clockwise)" and the "outer boundary (clockwise)". Only the cycles
 * whose area is positive are returned.
 */
function extractFaces(arrangement: Arrangement): Ring[] {
  const { edges } = arrangement;
  const visited = new Set<string>();
  const faces: Ring[] = [];

  for (let edgeId = 0; edgeId < edges.length; edgeId++) {
    if (edges[edgeId].removed) continue;
    for (const forward of [true, false]) {
      if (visited.has(directedKey(edgeId, forward))) continue;
      const ring = traceFace(arrangement, edgeId, forward, visited);
      if (ring !== null && signedRingArea(ring) > 0) faces.push(ring);
    }
  }
  return faces;
}

/**
 * Traces one minimal cycle from a directed edge
 *
 * At each node, it proceeds to "the edge nearest in the clockwise direction from the
 * direction it came in". Under this rule the inner faces close counter-clockwise.
 */
function traceFace(
  arrangement: Arrangement,
  startEdge: number,
  startForward: boolean,
  visited: Set<string>,
): Ring | null {
  const { nodes, edges } = arrangement;
  const ring: Ring = [];

  let edgeId = startEdge;
  let forward = startForward;

  // A directed edge is used only once each, so it closes within this count for certain
  for (let step = 0; step <= edges.length * 2; step++) {
    const key = directedKey(edgeId, forward);
    if (visited.has(key)) break;
    visited.add(key);

    const edge = edges[edgeId];
    const from = forward ? edge.a : edge.b;
    const to = forward ? edge.b : edge.a;
    ring.push(nodes[from]);

    const next = nextDirectedEdge(arrangement, to, from);
    if (next === null) return null;
    edgeId = next.edgeId;
    forward = next.forward;
  }

  if (ring.length < 3) return null;
  ring.push(ring[0]);
  return ring;
}

/**
 * Chooses the next directed edge
 *
 * Taking the reverse of the edge it came in on (the direction looking from at toward
 * previous) as the base, it chooses the edge nearest in the clockwise direction. After
 * the dangle removal the degree is 2 or more, so a candidate other than going back
 * always exists.
 */
function nextDirectedEdge(
  arrangement: Arrangement,
  at: number,
  previous: number,
): { edgeId: number; forward: boolean } | null {
  const { nodes, edges, adjacency } = arrangement;
  const base = Math.atan2(nodes[previous][1] - nodes[at][1], nodes[previous][0] - nodes[at][0]);

  let bestEdge = -1;
  let bestForward = true;
  let bestDifference = Number.POSITIVE_INFINITY;

  for (const edgeId of adjacency[at]) {
    const edge = edges[edgeId];
    if (edge.removed) continue;
    const other = edge.a === at ? edge.b : edge.a;
    const angle = Math.atan2(nodes[other][1] - nodes[at][1], nodes[other][0] - nodes[at][0]);

    // The clockwise angle difference from the base (0 means going back, so make it the
    // last candidate)
    let difference = base - angle;
    while (difference <= 0) difference += Math.PI * 2;

    if (difference < bestDifference) {
      bestDifference = difference;
      bestEdge = edgeId;
      bestForward = edge.a === at;
    }
  }

  return bestEdge < 0 ? null : { edgeId: bestEdge, forward: bestForward };
}
