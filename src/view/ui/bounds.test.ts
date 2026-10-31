// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests of hit testing the frames of the selection
 *
 * The zero-area (single coordinate) path is taken not only by Point but also by a MultiPoint
 * with a single point. An implementation that treats coordinates as a Coordinate let NaN
 * flow into the projection and crashed all hit testing, so that is pinned down here.
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_SELECTION_CONFIG } from '../../shared/config/selection.js';
import type { CoordinateTransform } from '../../shared/math/index.js';
import type { Feature } from '../../store/types.js';
import { planeMetersPerPixel } from '../../test-utils.js';
import { isPointInSelectionFrame } from './bounds.js';

/** A planar transform where 1 degree = 100px (for the tests) */
const transform: CoordinateTransform = {
  project: (lngLat) => ({ x: lngLat[0] * 100, y: -lngLat[1] * 100 }),
  unproject: (point) => ({ lng: point.x / 100, lat: -point.y / 100 }),
  metersPerPixel: planeMetersPerPixel(100),
};

function makeFeature(partial: Pick<Feature, 'type' | 'geometry'>): Feature {
  return {
    id: 'feature-1',
    layerId: 'layer-1',
    groupId: undefined,
    properties: {},
    locked: false,
    visible: true,
    style: {},
    ...partial,
  };
}

describe('isPointInSelectionFrame, the frame of a single position', () => {
  /** The frame of a point: the 12px square of its marker and the margin, on the screen */
  const HALF = 6 + DEFAULT_SELECTION_CONFIG.box.margin;
  const inFrame = (feature: Feature, x: number, y: number) =>
    isPointInSelectionFrame({ x, y }, [feature], transform, DEFAULT_SELECTION_CONFIG);

  it('frames a Point on the screen around its position', () => {
    const feature = makeFeature({
      type: 'Point',
      geometry: { type: 'Point', coordinates: [139.7, 35.7] },
    });
    const at = transform.project([139.7, 35.7]);
    expect(inFrame(feature, at.x + HALF - 0.1, at.y)).toBe(true);
    expect(inFrame(feature, at.x + HALF + 0.1, at.y)).toBe(false);
    expect(inFrame(feature, at.x, at.y - HALF + 0.1)).toBe(true);
    expect(inFrame(feature, at.x, at.y - HALF - 0.1)).toBe(false);
  });

  it('frames a MultiPoint with a single point around that point (no NaN)', () => {
    const feature = makeFeature({
      type: 'MultiPoint',
      geometry: { type: 'MultiPoint', coordinates: [[139.74, 35.73]] },
    });
    const at = transform.project([139.74, 35.73]);
    expect(inFrame(feature, at.x + HALF - 0.1, at.y)).toBe(true);
    expect(inFrame(feature, at.x + HALF + 0.1, at.y)).toBe(false);
  });

  it('frames a LineString whose vertices are all the same coordinate around it (no NaN)', () => {
    const feature = makeFeature({
      type: 'LineString',
      geometry: {
        type: 'LineString',
        coordinates: [
          [10, 20],
          [10, 20],
        ],
      },
    });
    const at = transform.project([10, 20]);
    expect(inFrame(feature, at.x, at.y + HALF - 0.1)).toBe(true);
    expect(inFrame(feature, at.x, at.y + HALF + 0.1)).toBe(false);
  });
});

describe('isPointInSelectionFrame, several features', () => {
  it('takes the frame of all of them and the frame of each, a point by its marker', () => {
    const multiPoint = makeFeature({
      type: 'MultiPoint',
      geometry: { type: 'MultiPoint', coordinates: [[0.5, 0]] },
    });
    const line = makeFeature({
      type: 'LineString',
      geometry: {
        type: 'LineString',
        coordinates: [
          [0, 0],
          [0.2, 0.2],
        ],
      },
    });
    const inFrame = (x: number, y: number) =>
      isPointInSelectionFrame({ x, y }, [multiPoint, line], transform, DEFAULT_SELECTION_CONFIG);
    // Inside the frame of all of them, between the line and the point
    expect(inFrame(35, -10)).toBe(true);
    // The frame of the point stands past the frame of all of them, which reaches its position
    const point = transform.project([0.5, 0]);
    expect(inFrame(point.x + 15, point.y)).toBe(true);
    expect(inFrame(point.x + 17, point.y)).toBe(false);
    // Far from both
    expect(inFrame(200, 200)).toBe(false);
  });
});
