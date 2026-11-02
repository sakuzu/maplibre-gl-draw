// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The edges and the vertices of the rows read on their columns, for tracing and snapping
 *
 * - The graph a trace walks, built from the edges of the rows read on their columns, is the graph
 *   built from the features of the rows
 * - The vertices of a ring leave out its closing position, as the vertex handles of a feature do
 */

import { describe, expect, it } from 'vitest';
import { buildTraceGraph } from '../operations/trace-graph.js';
import type { Feature } from '../shared/types/model.js';
import { feature, tablesOfFeatures } from '../test-utils.js';
import { forEachSnapRow, rowSegmentsInBBox, rowVerticesInBBox } from './snap-rows.js';

const features: Feature[] = [
  feature('a', 'LineString', [
    [0, 0],
    [1, 0],
    [2, 1],
  ]),
  feature('b', 'Polygon', [
    [
      [2, 1],
      [3, 1],
      [3, 2],
      [2, 1],
    ],
  ]),
  feature('c', 'MultiLineString', [
    [
      [3, 2],
      [4, 2],
    ],
    [
      [4, 2],
      [4, 3],
    ],
  ]),
  feature('d', 'Point', [9, 9]),
];

describe('the rows read on their columns for tracing and snapping', () => {
  it('give a trace the graph the features give', () => {
    const { tables } = tablesOfFeatures('layer', features);
    const bbox = { minX: -1, minY: -1, maxX: 5, maxY: 5 };
    const fromFeatures = buildTraceGraph(features, bbox);
    const fromRows = buildTraceGraph([], bbox, (visit) =>
      forEachSnapRow(
        tables,
        bbox,
        () => true,
        () => false,
        (row) => rowSegmentsInBBox(row, bbox, (start, end) => visit(start, end)),
      ),
    );
    const edges = (graph: ReturnType<typeof buildTraceGraph>) =>
      [...graph.nodes].map(([key, node]) => [key, node.edges.map((e) => e.to).sort()]).sort();
    expect(edges(fromRows)).toEqual(edges(fromFeatures));
    expect(fromRows.nodes.size).toBe(7);
  });

  it('list the vertices of a ring without its closing position', () => {
    const { tables } = tablesOfFeatures('layer', features);
    const bbox = { minX: -1, minY: -1, maxX: 10, maxY: 10 };
    const refs: string[] = [];
    forEachSnapRow(
      tables,
      bbox,
      () => true,
      (id) => id !== 'b',
      (row) =>
        rowVerticesInBBox(row, bbox, (position, ref) =>
          refs.push(`${position}:${JSON.stringify(ref)}`),
        ),
    );
    expect(refs).toEqual([
      '2,1:{"ring":0,"index":0}',
      '3,1:{"ring":0,"index":1}',
      '3,2:{"ring":0,"index":2}',
    ]);
  });
});
