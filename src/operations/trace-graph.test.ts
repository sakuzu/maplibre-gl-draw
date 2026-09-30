// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for edge tracing (the shortest path on the graph)
 *
 * The main subject is a 2 x 2 grid (4 cells = 4 polygons). A click from corner to
 * corner always crosses the edges of several polygons, so these tests look at
 * whether the boundary connects across features, whether the shorter path is
 * chosen, and whether it survives duplicated boundaries.
 */

import { describe, expect, it } from 'vitest';
import type { BoundingBox, Coordinate, Feature } from '../store/types.js';
import type { TraceGraphEndpoint } from './trace-graph.js';
import { buildTraceGraph, findTracePath } from './trace-graph.js';

/** An extent wide enough to contain everything */
const WIDE: BoundingBox = { minX: -1, minY: -1, maxX: 1, maxY: 1 };

/**
 * A 2 x 2 grid (the grid points are 0.0 / 0.1 / 0.2)
 *
 *   A02 ── A12 ── A22      y = 0.2
 *    │      │      │
 *   A01 ── A11 ── A21      y = 0.1
 *    │      │      │
 *   A00 ── A10 ── A20      y = 0
 */
function at(x: number, y: number): Coordinate {
  return [x / 10, y / 10];
}

/** One cell (the lower left grid point is given) */
function cell(id: string, x: number, y: number): Feature {
  const ring: Coordinate[] = [at(x, y), at(x + 1, y), at(x + 1, y + 1), at(x, y + 1), at(x, y)];
  return {
    id,
    type: 'Polygon',
    geometry: { type: 'Polygon', coordinates: [ring] },
    layerId: 'l1',
    groupId: undefined,
    properties: {},
    locked: false,
    visible: true,
    style: {},
  };
}

/** The 4 cells of the 2 x 2 grid */
function grid(): Feature[] {
  return [cell('c00', 0, 0), cell('c10', 1, 0), cell('c01', 0, 1), cell('c11', 1, 1)];
}

function line(id: string, coordinates: Coordinate[]): Feature {
  return {
    id,
    type: 'LineString',
    geometry: { type: 'LineString', coordinates: coordinates },
    layerId: 'l1',
    groupId: undefined,
    properties: {},
    locked: false,
    visible: true,
    style: {},
  };
}

/** An end point snapped to a vertex */
function atNode(coordinate: Coordinate): TraceGraphEndpoint {
  return { coordinate, node: coordinate };
}

/** An end point snapped to the middle of an edge */
function onEdge(coordinate: Coordinate, start: Coordinate, end: Coordinate): TraceGraphEndpoint {
  return { coordinate, segment: { start, end } };
}

function pathBetween(
  features: Feature[],
  from: TraceGraphEndpoint,
  to: TraceGraphEndpoint,
  bbox: BoundingBox = WIDE,
): Coordinate[] | null {
  return findTracePath(buildTraceGraph(features, bbox), from, to);
}

describe('buildTraceGraph', () => {
  it('folds vertices with matching coordinates into a single node', () => {
    const graph = buildTraceGraph(grid(), WIDE);

    // Only the 3 x 3 grid points become nodes
    expect(graph.nodes.size).toBe(9);
    // The central grid point connects in all 4 directions
    expect(graph.nodes.get('0.1,0.1')?.edges).toHaveLength(4);
  });

  it('folds edges with the same pair of coordinates into one', () => {
    // Adjacent cells share the central vertical line
    const graph = buildTraceGraph(grid(), WIDE);
    const node = graph.nodes.get('0.1,0')?.edges.filter((edge) => edge.to === '0.1,0.1');

    expect(node).toHaveLength(1);
  });

  it('does not take in edges that fall outside the extent', () => {
    const bbox: BoundingBox = { minX: -0.01, minY: -0.01, maxX: 0.01, maxY: 0.01 };
    const graph = buildTraceGraph(grid(), bbox);

    // Only the 2 edges touching the origin are left
    expect(graph.nodes.get('0,0')?.edges).toHaveLength(2);
  });

  it('does not build from types that have no edges', () => {
    const point: Feature = {
      id: 'p1',
      type: 'Point',
      geometry: { type: 'Point', coordinates: at(0, 0) },
      layerId: 'l1',
      groupId: undefined,
      properties: {},
      locked: false,
      visible: true,
      style: {},
    };

    expect(buildTraceGraph([point], WIDE).nodes.size).toBe(0);
  });
});

describe('findTracePath', () => {
  it('returns a boundary chain across the edges of several features', () => {
    // From the lower left corner to the lower right corner (the bottom edge spans the
    // 2 polygons c00 and c10)
    const path = pathBetween(grid(), atNode(at(0, 0)), atNode(at(2, 0)));

    expect(path).toEqual([at(1, 0)]);
  });

  it('chooses the shorter path', () => {
    // From the middle of the bottom edge to the middle of the top edge. The path
    // straight through the central vertical line (0.2) is shorter than the path all
    // the way around the left (0.4)
    const path = pathBetween(grid(), atNode(at(1, 0)), atNode(at(1, 2)));

    expect(path).toEqual([at(1, 1)]);
  });

  it('survives duplicated boundaries whose coordinates overlap exactly', () => {
    // Overlay polygons with boundaries at the same coordinates, like administrative
    // boundaries before and after a merger
    const merged: Feature = {
      ...cell('merged', 0, 0),
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            at(0, 0),
            at(1, 0),
            at(2, 0),
            at(2, 1),
            at(2, 2),
            at(1, 2),
            at(0, 2),
            at(0, 1),
            at(0, 0),
          ],
        ],
      },
    };
    const path = pathBetween([...grid(), merged], atNode(at(0, 0)), atNode(at(2, 0)));

    expect(path).toEqual([at(1, 0)]);
  });

  it('makes a path even between two points in the middle of edges', () => {
    const from: Coordinate = [0.05, 0];
    const to: Coordinate = [0.15, 0];
    const path = pathBetween(
      grid(),
      onEdge(from, at(0, 0), at(1, 0)),
      onEdge(to, at(1, 0), at(2, 0)),
    );

    expect(path).toEqual([at(1, 0)]);
  });

  it('does not go around the end points when the 2 points are on the same edge', () => {
    const from: Coordinate = [0.02, 0];
    const to: Coordinate = [0.08, 0];
    const path = pathBetween(
      grid(),
      onEdge(from, at(0, 0), at(1, 0)),
      onEdge(to, at(0, 0), at(1, 0)),
    );

    expect(path).toEqual([]);
  });

  it('makes a path for a combination of a point in the middle of an edge and a vertex', () => {
    const from: Coordinate = [0.05, 0];
    const path = pathBetween(grid(), onEdge(from, at(0, 0), at(1, 0)), atNode(at(2, 0)));

    expect(path).toEqual([at(1, 0)]);
  });

  it('puts nothing in between for two adjacent vertices', () => {
    expect(pathBetween(grid(), atNode(at(0, 0)), atNode(at(1, 0)))).toEqual([]);
  });

  it('returns null when they are not connected', () => {
    const separate = [line('a', [at(0, 0), at(1, 0)]), line('b', [at(0, 2), at(1, 2)])];

    expect(pathBetween(separate, atNode(at(0, 0)), atNode(at(1, 2)))).toBeNull();
  });

  it('does not connect when they merely cross without a shared vertex', () => {
    const crossing = [
      line('h', [
        [-0.1, 0.05],
        [0.3, 0.05],
      ]),
      line('v', [at(1, 0), at(1, 1)]),
    ];

    expect(pathBetween(crossing, atNode([-0.1, 0.05]), atNode(at(1, 1)))).toBeNull();
  });

  it('makes a path on an open line as well', () => {
    const open = line('l', [at(0, 0), at(1, 0), at(2, 0), at(2, 1)]);

    expect(pathBetween([open], atNode(at(0, 0)), atNode(at(2, 1)))).toEqual([at(1, 0), at(2, 0)]);
    // In the reverse direction it returns the same vertices in reverse order
    expect(pathBetween([open], atNode(at(2, 1)), atNode(at(0, 0)))).toEqual([at(2, 0), at(1, 0)]);
  });

  it('cannot use a vertex that is not in the graph as an end point', () => {
    expect(pathBetween(grid(), atNode([5, 5]), atNode(at(0, 0)))).toBeNull();
  });

  it('cannot trace an end point that points to neither a vertex nor an edge', () => {
    const bare: TraceGraphEndpoint = { coordinate: at(0, 0) };

    expect(pathBetween(grid(), bare, atNode(at(2, 0)))).toBeNull();
  });

  it('puts nothing in between for two identical end points', () => {
    expect(pathBetween(grid(), atNode(at(0, 0)), atNode(at(0, 0)))).toEqual([]);
  });
});
