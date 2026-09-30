// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Edge tracing (the shortest path on a graph of edges)
 *
 * When two clicks made while drawing snap to an existing boundary, the sequence of
 * boundary vertices between those 2 points is copied and inserted as it is. A
 * boundary is not necessarily a single feature (an administrative boundary or a mesh
 * is a collection of edges of several polygons, and a click from corner to corner
 * almost always crosses features), so all the nearby edges are turned into one
 * undirected graph first, and the shortest path is taken on it.
 *
 * How the graph is built.
 *
 *   - A node is the coordinate of a vertex. They are identified by an exact match of
 *     longitude and latitude, so the border between features can be crossed freely
 *     through shared vertices
 *   - The weight of an edge is the haversine distance (meters). Edges with the same
 *     pair of coordinates are folded into one
 *   - Edges that merely cross without a shared vertex are not connected (no
 *     intersection node is created)
 *
 * When an end point snaps to the middle of an edge, a node at that coordinate is
 * added and connected to both ends of the edge with the partial distances. The
 * output is "only the vertices in between", and it does not include the snapped
 * coordinates of the two ends. If the two ends are not connected, null is returned
 * and the caller treats it as an ordinary straight line.
 *
 * This is a pure function that takes only coordinates as input; it looks at neither
 * the Store nor the map.
 */

import { haversineDistanceMeters } from '../geometry/distance.js';
import {
  collectFeatureSegments,
  hasSnapEdges,
  segmentIntersectsBBox,
} from '../shared/utils/feature-segments.js';
import type { BoundingBox, Coordinate, Feature } from '../store/types.js';

/**
 * A connection from a node of a {@link TraceGraph} to an adjacent node, weighted by its
 * geodesic length.
 */
export interface TraceGraphEdge {
  /** The node key this edge connects to */
  to: string;
  /** The haversine length of the edge in meters */
  weight: number;
}

/**
 * A vertex of a {@link TraceGraph}. Vertices at exactly the same coordinate share one node.
 */
export interface TraceGraphNode {
  /** The coordinate of the node, `[lng, lat]` in degrees */
  coordinate: Coordinate;
  /** The adjacent nodes */
  edges: TraceGraphEdge[];
}

/**
 * The undirected graph of the edges near the cursor, built by {@link buildTraceGraph} and
 * searched by {@link findTracePath}.
 */
export interface TraceGraph {
  /** The nodes by key (the key is `"lng,lat"`) */
  nodes: Map<string, TraceGraphNode>;
}

/**
 * One end of a trace: the snapping target of a click, expressed in coordinates.
 *
 * It holds either node (snapped to a vertex) or segment (snapped to the middle of an
 * edge). An end point with neither (a snap to a guide or to an intersection with no
 * reference) cannot be traced.
 */
export interface TraceGraphEndpoint {
  /** The snapped coordinate `[lng, lat]` in degrees (may be in the middle of an edge) */
  coordinate: Coordinate;
  /** When snapped to a vertex, the coordinate of that vertex */
  node?: Coordinate;
  /** When snapped to the middle of an edge, the coordinates of both ends of that edge */
  segment?: { start: Coordinate; end: Coordinate };
}

/**
 * Turns a coordinate into a node key (identified by an exact match)
 */
function nodeKey(coordinate: Coordinate): string {
  return `${coordinate[0]},${coordinate[1]}`;
}

/**
 * Builds the undirected graph of the edges of features within an extent, for
 * {@link findTracePath}.
 *
 * Every segment of LineString, Polygon (holes included), MultiLineString and MultiPolygon
 * features that touches `bbox` becomes an edge weighted by its haversine length in meters.
 * Vertices at exactly the same coordinate share one node, so a path can cross from one
 * feature to another through a shared vertex; edges that merely cross are not connected.
 * Edges with the same pair of coordinates are folded into one, and edges of length 0 are
 * skipped. Features of any other type contribute nothing. It is a pure
 * function; it looks at neither the Store nor the map.
 *
 * @param features The features to build from (pass only the visible ones)
 * @param bbox The extent in degrees; only the edges that touch it are taken in
 * @returns The graph. It has no nodes when no edge falls in `bbox`
 */
export function buildTraceGraph(features: readonly Feature[], bbox: BoundingBox): TraceGraph {
  const nodes = new Map<string, TraceGraphNode>();
  const seenEdges = new Set<string>();

  const nodeAt = (coordinate: Coordinate): TraceGraphNode => {
    const key = nodeKey(coordinate);
    let node = nodes.get(key);
    if (!node) {
      node = { coordinate: [coordinate[0], coordinate[1]], edges: [] };
      nodes.set(key, node);
    }
    return node;
  };

  const addEdge = (start: Coordinate, end: Coordinate): void => {
    const startKey = nodeKey(start);
    const endKey = nodeKey(end);
    // An edge of length 0 (a coordinate sequence where the same coordinate repeats)
    // adds no connection
    if (startKey === endKey) return;

    // Fold edges with the same pair of coordinates into one (so overlapping boundaries
    // do not break it even when duplicated)
    const edgeKey = startKey < endKey ? `${startKey}|${endKey}` : `${endKey}|${startKey}`;
    if (seenEdges.has(edgeKey)) return;
    seenEdges.add(edgeKey);

    const weight = haversineDistanceMeters(start, end);
    nodeAt(start).edges.push({ to: endKey, weight });
    nodeAt(end).edges.push({ to: startKey, weight });
  };

  for (const feature of features) {
    if (!hasSnapEdges(feature.type)) continue;

    collectFeatureSegments(feature, (start, end) => {
      if (!segmentIntersectsBBox(start, end, bbox)) return;
      addEdge(start, end);
    });
  }

  return { nodes };
}

/**
 * The working graph for the path search
 *
 * It does not touch the original graph; it only layers the end-point nodes and their
 * edges on top of it.
 */
interface WorkingGraph {
  graph: TraceGraph;
  /** The coordinates of the end-point nodes */
  extraCoordinates: Map<string, Coordinate>;
  /** The edges added just for the end-point nodes */
  extraEdges: Map<string, TraceGraphEdge[]>;
}

/**
 * Adds a one-way edge to the working graph
 */
function addExtraEdge(working: WorkingGraph, from: string, to: string, weight: number): void {
  const edges = working.extraEdges.get(from);
  if (edges) {
    edges.push({ to, weight });
    return;
  }
  working.extraEdges.set(from, [{ to, weight }]);
}

/**
 * Connects an end point to the graph and returns the node key of that end point
 *
 * A snap to a vertex uses the existing node in the graph. A snap to the middle of an
 * edge adds a node for the end point and connects it to both ends of the edge with
 * the partial distances. If it cannot be connected, null is returned.
 */
function attachEndpoint(working: WorkingGraph, endpoint: TraceGraphEndpoint): string | null {
  const { nodes } = working.graph;

  if (endpoint.node) {
    const key = nodeKey(endpoint.node);
    return nodes.has(key) ? key : null;
  }

  const segment = endpoint.segment;
  if (!segment) return null;

  const startKey = nodeKey(segment.start);
  const endKey = nodeKey(segment.end);
  if (!nodes.has(startKey) || !nodes.has(endKey)) return null;

  const key = nodeKey(endpoint.coordinate);
  // When the end point lies exactly on the end of the edge, use the node of that
  // vertex as it is
  if (key === startKey || key === endKey) return key;

  working.extraCoordinates.set(key, [endpoint.coordinate[0], endpoint.coordinate[1]]);
  for (const to of [startKey, endKey]) {
    const weight = haversineDistanceMeters(
      endpoint.coordinate,
      to === startKey ? segment.start : segment.end,
    );
    addExtraEdge(working, key, to, weight);
    addExtraEdge(working, to, key, weight);
  }

  return key;
}

/**
 * Whether the 2 end points lie on the same edge
 */
function isOnSameSegment(from: TraceGraphEndpoint, to: TraceGraphEndpoint): boolean {
  if (!from.segment || !to.segment) return false;
  const a = [nodeKey(from.segment.start), nodeKey(from.segment.end)].sort().join('|');
  const b = [nodeKey(to.segment.start), nodeKey(to.segment.end)].sort().join('|');
  return a === b;
}

/**
 * The neighbors of a node (the original graph plus the end-point part)
 */
function neighborsOf(working: WorkingGraph, key: string): TraceGraphEdge[] {
  const base = working.graph.nodes.get(key)?.edges;
  const extra = working.extraEdges.get(key);
  if (!base) return extra ?? [];
  return extra ? [...base, ...extra] : base;
}

/**
 * Looks up the coordinate from a node key
 */
function coordinateOf(working: WorkingGraph, key: string): Coordinate | null {
  const node = working.graph.nodes.get(key);
  if (node) return node.coordinate;
  return working.extraCoordinates.get(key) ?? null;
}

/**
 * Finds the sequence of node keys on the shortest path with Dijkstra (both ends
 * included)
 *
 * The graph covers only the neighborhood and is small in scale, so the priority queue
 * is replaced by a linear scan over the unprocessed set.
 */
function shortestPath(working: WorkingGraph, from: string, to: string): string[] | null {
  const distances = new Map<string, number>([[from, 0]]);
  const previous = new Map<string, string>();
  const settled = new Set<string>();
  const frontier = new Set<string>([from]);

  while (frontier.size > 0) {
    let current: string | null = null;
    let best = Number.POSITIVE_INFINITY;
    for (const key of frontier) {
      const distance = distances.get(key) ?? Number.POSITIVE_INFINITY;
      if (distance < best) {
        best = distance;
        current = key;
      }
    }
    if (current === null) break;

    frontier.delete(current);
    settled.add(current);
    if (current === to) break;

    for (const edge of neighborsOf(working, current)) {
      if (settled.has(edge.to)) continue;
      const candidate = best + edge.weight;
      if (candidate >= (distances.get(edge.to) ?? Number.POSITIVE_INFINITY)) continue;
      distances.set(edge.to, candidate);
      previous.set(edge.to, current);
      frontier.add(edge.to);
    }
  }

  if (!settled.has(to)) return null;

  const path: string[] = [to];
  let cursor = to;
  while (cursor !== from) {
    const parent = previous.get(cursor);
    if (parent === undefined) return null;
    path.push(parent);
    cursor = parent;
  }
  return path.reverse();
}

/**
 * Returns the boundary vertices on the shortest path between two snapped points.
 *
 * The search is Dijkstra over the geodesic lengths of {@link TraceGraph}. An end snapped to
 * the middle of an edge is connected to both ends of that edge with the partial lengths;
 * when both ends lie on the same edge they are connected directly. It is a pure function.
 *
 * @param graph The graph built from the nearby edges by {@link buildTraceGraph}
 * @param from The snapping target of the click confirmed just before
 * @param to The snapping target of this click (or of the cursor)
 * @returns The vertices `[lng, lat]` in between, both ends excluded. An empty array when
 *   the two ends are the same node or adjacent. `null` when an end has neither `node` nor
 *   `segment`, when an end is not in the graph, and when the two ends are not connected
 */
export function findTracePath(
  graph: TraceGraph,
  from: TraceGraphEndpoint,
  to: TraceGraphEndpoint,
): Coordinate[] | null {
  const working: WorkingGraph = {
    graph,
    extraCoordinates: new Map(),
    extraEdges: new Map(),
  };

  const fromKey = attachEndpoint(working, from);
  const toKey = attachEndpoint(working, to);
  if (fromKey === null || toKey === null) return null;
  if (fromKey === toKey) return [];

  // When both points snapped to the same edge, connect them directly without going
  // around the end points of that edge
  if (isOnSameSegment(from, to)) {
    const weight = haversineDistanceMeters(from.coordinate, to.coordinate);
    addExtraEdge(working, fromKey, toKey, weight);
    addExtraEdge(working, toKey, fromKey, weight);
  }

  const path = shortestPath(working, fromKey, toKey);
  if (!path) return null;

  // The caller holds the snapped coordinates of the two ends, so drop them
  const middle: Coordinate[] = [];
  for (let i = 1; i < path.length - 1; i++) {
    const coordinate = coordinateOf(working, path[i]);
    if (coordinate) middle.push([coordinate[0], coordinate[1]]);
  }
  return middle;
}
