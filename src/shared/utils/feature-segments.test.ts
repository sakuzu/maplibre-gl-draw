// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The edges a vertex starts and ends, by the vertex each starts from, as the listing of the edges
 * names them: at the ends of a line, in its middle, at the first vertex of a ring (whose closing
 * edge starts from its last vertex) and in a part of a Multi geometry
 */

import { describe, expect, it } from 'vitest';
import type { Feature } from '../types/model.js';
import { geometryFromCoordinates } from './coordinates.js';
import { edgesOfVertex } from './feature-segments.js';

function feature(type: string, coordinates: unknown): Feature {
  return {
    id: 'f',
    type,
    geometry: geometryFromCoordinates(type, coordinates as never),
    layerId: 'l',
    groupId: undefined,
    properties: {},
    locked: false,
    visible: true,
    style: {},
  };
}

describe('edgesOfVertex', () => {
  const line = feature('LineString', [
    [0, 0],
    [1, 0],
    [2, 0],
  ]);
  const ring = [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
    [0, 0],
  ];

  it('gives the edge a line ends at and the one it starts from', () => {
    expect(edgesOfVertex(line, { ring: 0, index: 0 })).toEqual([{ ring: 0, index: 0 }]);
    expect(edgesOfVertex(line, { ring: 0, index: 1 })).toEqual([
      { ring: 0, index: 0 },
      { ring: 0, index: 1 },
    ]);
    expect(edgesOfVertex(line, { ring: 0, index: 2 })).toEqual([{ ring: 0, index: 1 }]);
  });

  it('gives the first vertex of a ring its first edge and the closing one', () => {
    expect(edgesOfVertex(feature('Polygon', [ring]), { ring: 0, index: 0 })).toEqual([
      { ring: 0, index: 0 },
      { ring: 0, index: 3 },
    ]);
  });

  it('names the edges of a part of a Multi geometry by the part', () => {
    const polygons = feature('MultiPolygon', [[ring], [ring]]);
    expect(edgesOfVertex(polygons, { part: 1, ring: 0, index: 2 })).toEqual([
      { part: 1, ring: 0, index: 1 },
      { part: 1, ring: 0, index: 2 },
    ]);
  });
});
