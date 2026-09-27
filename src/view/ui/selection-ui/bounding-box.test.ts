// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for the selection frame computation
 *
 * The frame has to follow the feature it surrounds: a circle's frame contains the circle as
 * it is drawn (a geodesic circle), and the frame rotated during a rotation drag lands where
 * the rotate operation puts the feature's coordinates (both in Web Mercator).
 */

import { describe, expect, it } from 'vitest';
import { generateCirclePolygon } from '../../../geometry/circle.js';
import { computeRotation, getRotationDelta, startRotation } from '../../../operations/rotate.js';
import type { Coordinate, Feature } from '../../../store/types.js';
import { computeBoundingBox, rotateBoundingBox } from './bounding-box.js';

function makeCircle(center: Coordinate, radiusMeters: number): Feature {
  return {
    id: 'circle-1',
    type: 'Circle',
    geometry: { type: 'Point', coordinates: center },
    layerId: 'layer-1',
    properties: { 'maplibre-gl-draw:radiusMeters': radiusMeters },
    locked: false,
    visible: true,
    style: {},
  };
}

describe('computeBoundingBox of a Circle', () => {
  it.each([
    [[10, 0] as Coordinate, 100_000],
    [[10, 60] as Coordinate, 100_000],
    [[10, 60] as Coordinate, 1_000_000],
    [[-120, -75] as Coordinate, 500_000],
  ])('contains the drawn circle (center %j, radius %d m)', (center, radiusMeters) => {
    const bbox = computeBoundingBox(makeCircle(center, radiusMeters));
    expect(bbox).not.toBeNull();
    if (!bbox) return;
    const minLng = bbox.topLeft[0];
    const maxLng = bbox.bottomRight[0];
    const maxLat = bbox.topLeft[1];
    const minLat = bbox.bottomRight[1];
    const epsilon = 1e-9;
    for (const [lng, lat] of generateCirclePolygon(center, radiusMeters, 1024)) {
      expect(lng).toBeGreaterThanOrEqual(minLng - epsilon);
      expect(lng).toBeLessThanOrEqual(maxLng + epsilon);
      expect(lat).toBeGreaterThanOrEqual(minLat - epsilon);
      expect(lat).toBeLessThanOrEqual(maxLat + epsilon);
    }
  });

  it('keeps the circle center as the frame center', () => {
    const bbox = computeBoundingBox(makeCircle([10, 60], 100_000));
    expect(bbox?.center).toEqual([10, 60]);
  });
});

describe('rotateBoundingBox', () => {
  it('rotates the frame the way the rotate operation moves the feature', () => {
    const corners: Coordinate[] = [
      [0, 60],
      [20, 60],
      [20, 40],
      [0, 40],
    ];
    const polygon: Feature = {
      id: 'polygon-1',
      type: 'Polygon',
      geometry: { type: 'Polygon', coordinates: [[...corners, corners[0]]] },
      layerId: 'layer-1',
      properties: {},
      locked: false,
      visible: true,
      style: {},
    };
    const bbox = computeBoundingBox(polygon);
    expect(bbox).not.toBeNull();
    if (!bbox) return;

    const state = startRotation({ lng: 25, lat: 50 }, bbox, [polygon]);
    const pointer = { lng: 18, lat: 62 };
    const rotated = computeRotation(state, pointer, [polygon]).get('polygon-1');
    if (!rotated) throw new Error('no rotation result');
    const ring = (rotated.coordinates as Coordinate[][])[0];
    const frame = rotateBoundingBox(bbox, getRotationDelta(state, pointer));

    const frameCorners = [frame.topLeft, frame.topRight, frame.bottomRight, frame.bottomLeft];
    for (let i = 0; i < 4; i++) {
      expect(frameCorners[i][0]).toBeCloseTo(ring[i][0], 9);
      expect(frameCorners[i][1]).toBeCloseTo(ring[i][1], 9);
    }
  });

  it('keeps the rotation center fixed', () => {
    const bbox = computeBoundingBox({
      id: 'polygon-1',
      type: 'Polygon',
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [0, 40],
            [20, 40],
            [20, 60],
            [0, 60],
            [0, 40],
          ],
        ],
      },
      layerId: 'layer-1',
      properties: {},
      locked: false,
      visible: true,
      style: {},
    });
    if (!bbox) throw new Error('no bbox');
    const frame = rotateBoundingBox(bbox, 1.2);
    expect(frame.center[0]).toBeCloseTo(bbox.center[0], 12);
    expect(frame.center[1]).toBeCloseTo(bbox.center[1], 12);
  });
});
