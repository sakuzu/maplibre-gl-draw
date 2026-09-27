// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for the vertex/midpoint handle computation
 *
 * The handle computation is used by both handle rendering and hit testing, so as long as
 * it returns all rings and all parts, inconsistencies such as "visible but not grabbable"
 * or "grabbable but not visible" cannot occur.
 */

import { describe, expect, it } from 'vitest';
import { destinationPoint, haversineDistanceMeters } from '../../geometry/distance.js';
import { DEFAULT_SELECTION_CONFIG } from '../../shared/config/selection.js';
import type { Coordinate, Feature } from '../../store/types.js';
import type { PointShapeRenderer, PointStyle } from '../renderers/point/point-shape.js';
import type { StrokeRenderer } from '../renderers/stroke.js';
import {
  computeCircleRadiusHandle,
  computeMidpointHandles,
  computeVertexHandles,
  SelectionHandlesRenderer,
  supportsVertexEditing,
} from './handles.js';

function makePolygon(...rings: Coordinate[][]): Feature {
  return {
    id: 'polygon-1',
    type: 'Polygon',
    coordinates: rings,
    layerId: 'layer-1',
    properties: {},
    locked: false,
    visible: true,
  };
}

/** A polygon whose 20x20 outer ring contains one 10x10 hole */
function polygonWithHole(): Feature {
  return makePolygon(
    [
      [0, 0],
      [20, 0],
      [20, 20],
      [0, 20],
      [0, 0],
    ],
    [
      [5, 5],
      [15, 5],
      [15, 15],
      [5, 15],
      [5, 5],
    ],
  );
}

describe('computeVertexHandles', () => {
  it('returns all vertices of ring 0 for a LineString', () => {
    const feature: Feature = {
      id: 'line-1',
      type: 'LineString',
      coordinates: [
        [0, 0],
        [10, 10],
      ],
      layerId: 'layer-1',
      properties: {},
      locked: false,
      visible: true,
    };
    expect(computeVertexHandles(feature).map((h) => h.vertexRef)).toEqual([
      { ring: 0, index: 0 },
      { ring: 0, index: 1 },
    ]);
  });

  it('returns inner ring vertices as handles for a Polygon (closing point excluded)', () => {
    const handles = computeVertexHandles(polygonWithHole());

    expect(handles.map((h) => h.vertexRef)).toEqual([
      { ring: 0, index: 0 },
      { ring: 0, index: 1 },
      { ring: 0, index: 2 },
      { ring: 0, index: 3 },
      { ring: 1, index: 0 },
      { ring: 1, index: 1 },
      { ring: 1, index: 2 },
      { ring: 1, index: 3 },
    ]);
    // The handle positions of the inner ring are the inner ring coordinates
    expect(handles[4].position).toEqual([5, 5]);
  });

  it('makes the last vertex a handle as well for a ring that is not closed', () => {
    const feature = makePolygon([
      [0, 0],
      [10, 0],
      [10, 10],
    ]);
    expect(computeVertexHandles(feature).map((h) => h.vertexRef)).toEqual([
      { ring: 0, index: 0 },
      { ring: 0, index: 1 },
      { ring: 0, index: 2 },
    ]);
  });
});

describe('computeMidpointHandles', () => {
  it('returns the midpoints of the inner ring edges too for a Polygon', () => {
    const handles = computeMidpointHandles(polygonWithHole());

    expect(handles.map((h) => h.vertexRef)).toEqual([
      { ring: 0, index: 0 },
      { ring: 0, index: 1 },
      { ring: 0, index: 2 },
      { ring: 0, index: 3 },
      { ring: 1, index: 0 },
      { ring: 1, index: 1 },
      { ring: 1, index: 2 },
      { ring: 1, index: 3 },
    ]);
    // Midpoint of the first edge of the inner ring ([5,5]-[15,5])
    expect(handles[4].position).toEqual([10, 5]);
  });

  it('puts the midpoint of a long slanted edge on the edge as drawn', () => {
    const line: Feature = {
      id: 'slanted',
      type: 'LineString',
      coordinates: [
        [-60, 0],
        [60, 50],
      ],
      layerId: 'layer-1',
      properties: {},
      locked: false,
      visible: true,
    };
    const [handle] = computeMidpointHandles(line);
    // Halfway across in longitude, on the straight line of the Mercator plane (not at 25)
    expect(handle.position[0]).toBe(0);
    expect(handle.position[1]).toBeCloseTo(27.795, 3);
  });
});

describe('handles of the Multi types (scanning all parts)', () => {
  const multiPoint: Feature = {
    id: 'multi-point-1',
    type: 'MultiPoint',
    coordinates: [
      [0, 0],
      [10, 10],
      [20, 20],
    ] as Coordinate[],
    layerId: 'layer-1',
    properties: {},
    locked: false,
    visible: true,
  };

  const multiLineString: Feature = {
    id: 'multi-line-1',
    type: 'MultiLineString',
    coordinates: [
      [
        [0, 0],
        [10, 0],
      ],
      [
        [0, 10],
        [10, 10],
        [20, 10],
      ],
    ] as Coordinate[][],
    layerId: 'layer-1',
    properties: {},
    locked: false,
    visible: true,
  };

  /** A MultiPolygon whose part 0 has a hole and whose part 1 is a triangle */
  const multiPolygon: Feature = {
    id: 'multi-polygon-1',
    type: 'MultiPolygon',
    coordinates: [
      [
        [
          [0, 0],
          [20, 0],
          [20, 20],
          [0, 20],
          [0, 0],
        ],
        [
          [5, 5],
          [15, 5],
          [15, 15],
          [5, 15],
          [5, 5],
        ],
      ],
      [
        [
          [100, 100],
          [110, 100],
          [110, 110],
          [100, 100],
        ],
      ],
    ] as Coordinate[][][],
    layerId: 'layer-1',
    properties: {},
    locked: false,
    visible: true,
  };

  it('returns vertex handles where one coordinate = one part for a MultiPoint', () => {
    const handles = computeVertexHandles(multiPoint);
    expect(handles.map((h) => h.vertexRef)).toEqual([
      { part: 0, ring: 0, index: 0 },
      { part: 1, ring: 0, index: 0 },
      { part: 2, ring: 0, index: 0 },
    ]);
    expect(handles.map((h) => h.position)).toEqual([
      [0, 0],
      [10, 10],
      [20, 20],
    ]);
  });

  it('returns no midpoint handles for a MultiPoint', () => {
    expect(computeMidpointHandles(multiPoint)).toEqual([]);
  });

  it('returns the vertex handles of all parts for a MultiLineString', () => {
    const handles = computeVertexHandles(multiLineString);
    expect(handles.map((h) => h.vertexRef)).toEqual([
      { part: 0, ring: 0, index: 0 },
      { part: 0, ring: 0, index: 1 },
      { part: 1, ring: 0, index: 0 },
      { part: 1, ring: 0, index: 1 },
      { part: 1, ring: 0, index: 2 },
    ]);
    expect(handles[2].position).toEqual([0, 10]);
  });

  it('returns the midpoint handles of all parts for a MultiLineString', () => {
    const handles = computeMidpointHandles(multiLineString);
    expect(handles.map((h) => h.vertexRef)).toEqual([
      { part: 0, ring: 0, index: 0 },
      { part: 1, ring: 0, index: 0 },
      { part: 1, ring: 0, index: 1 },
    ]);
    expect(handles[0].position).toEqual([5, 0]);
    expect(handles[2].position).toEqual([15, 10]);
  });

  it('returns vertex handles of every ring and part for a MultiPolygon (no closing point)', () => {
    const handles = computeVertexHandles(multiPolygon);
    expect(handles.map((h) => h.vertexRef)).toEqual([
      { part: 0, ring: 0, index: 0 },
      { part: 0, ring: 0, index: 1 },
      { part: 0, ring: 0, index: 2 },
      { part: 0, ring: 0, index: 3 },
      { part: 0, ring: 1, index: 0 },
      { part: 0, ring: 1, index: 1 },
      { part: 0, ring: 1, index: 2 },
      { part: 0, ring: 1, index: 3 },
      { part: 1, ring: 0, index: 0 },
      { part: 1, ring: 0, index: 1 },
      { part: 1, ring: 0, index: 2 },
    ]);
    // First vertex of the inner ring of part 0
    expect(handles[4].position).toEqual([5, 5]);
    // First vertex of the outer ring of part 1
    expect(handles[8].position).toEqual([100, 100]);
  });

  it('returns midpoint handles of all rings of all parts for a MultiPolygon', () => {
    const handles = computeMidpointHandles(multiPolygon);
    expect(handles.map((h) => h.vertexRef)).toEqual([
      { part: 0, ring: 0, index: 0 },
      { part: 0, ring: 0, index: 1 },
      { part: 0, ring: 0, index: 2 },
      { part: 0, ring: 0, index: 3 },
      { part: 0, ring: 1, index: 0 },
      { part: 0, ring: 1, index: 1 },
      { part: 0, ring: 1, index: 2 },
      { part: 0, ring: 1, index: 3 },
      { part: 1, ring: 0, index: 0 },
      { part: 1, ring: 0, index: 1 },
      { part: 1, ring: 0, index: 2 },
    ]);
    // Midpoint of the first edge ([5,5]-[15,5]) of the inner ring of part 0
    expect(handles[4].position).toEqual([10, 5]);
  });
});

describe('computeCircleRadiusHandle', () => {
  it.each([
    [[10, 0] as Coordinate, 100_000, 135],
    [[10, 60] as Coordinate, 100_000, 45],
    [[10, 60] as Coordinate, 1_000_000, 90],
    [[-120, -75] as Coordinate, 500_000, 300],
  ])(
    'puts the handle on the drawn circle (center %j, radius %d m, angle %d)',
    (center, radiusMeters, angle) => {
      const circle: Feature = {
        id: 'circle-1',
        type: 'Circle',
        coordinates: center,
        layerId: 'layer-1',
        properties: { radiusMeters, radiusHandleAngle: angle },
        locked: false,
        visible: true,
      };
      const handle = computeCircleRadiusHandle(circle);
      expect(handle?.type).toBe('radius');
      const position = handle?.position as Coordinate;
      // The circle is laid out with destinationPoint, so the handle sits on its outline
      expect(haversineDistanceMeters(center, position) / radiusMeters).toBeCloseTo(1, 9);
      const expected = destinationPoint(center, radiusMeters, angle);
      expect(position[0]).toBeCloseTo(expected[0], 9);
      expect(position[1]).toBeCloseTo(expected[1], 9);
    },
  );
});

describe('supportsVertexEditing', () => {
  it('supports vertex editing for LineString / Polygon / the Multi types', () => {
    expect(supportsVertexEditing('LineString')).toBe(true);
    expect(supportsVertexEditing('Polygon')).toBe(true);
    expect(supportsVertexEditing('MultiPoint')).toBe(true);
    expect(supportsVertexEditing('MultiLineString')).toBe(true);
    expect(supportsVertexEditing('MultiPolygon')).toBe(true);
  });

  it('does not support Point / Circle / Freehand / Image / custom features', () => {
    expect(supportsVertexEditing('Point')).toBe(false);
    expect(supportsVertexEditing('Circle')).toBe(false);
    expect(supportsVertexEditing('Freehand')).toBe(false);
    expect(supportsVertexEditing('Image')).toBe(false);
    expect(supportsVertexEditing('Marker')).toBe(false);
  });
});

describe('SelectionHandlesRenderer.drawFollowedVertexHandles', () => {
  /** A renderer that only records the draw calls */
  function makeRenderer() {
    const calls: Array<{ position: Coordinate; style: PointStyle }> = [];
    const pointRenderer = {
      draw: (position: Coordinate, style: PointStyle) => {
        calls.push({ position, style });
      },
    } as unknown as PointShapeRenderer;
    const strokeRenderer = { draw: () => {} } as unknown as StrokeRenderer;
    const renderer = new SelectionHandlesRenderer(
      strokeRenderer,
      pointRenderer,
      DEFAULT_SELECTION_CONFIG,
    );
    return { renderer, calls };
  }

  it('draws only the specified vertices in the following style', () => {
    const { renderer, calls } = makeRenderer();
    renderer.drawFollowedVertexHandles(polygonWithHole(), [{ ring: 0, index: 1 }], 10);

    expect(calls).toHaveLength(1);
    expect(calls[0].position).toEqual([20, 0]);
    expect(calls[0].style).toBe(DEFAULT_SELECTION_CONFIG.vertexHandle.followed);
  });

  it('draws only the first one even when the references include a closing point', () => {
    const { renderer, calls } = makeRenderer();
    // The outer ring has 5 points (the last one is the closing point), and the closing
    // point has no handle
    renderer.drawFollowedVertexHandles(
      polygonWithHole(),
      [
        { ring: 0, index: 0 },
        { ring: 0, index: 4 },
      ],
      10,
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].position).toEqual([0, 0]);
  });

  it('draws nothing when the references are empty', () => {
    const { renderer, calls } = makeRenderer();
    renderer.drawFollowedVertexHandles(polygonWithHole(), [], 10);
    expect(calls).toEqual([]);
  });
});
