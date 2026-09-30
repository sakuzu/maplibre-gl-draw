// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests of computing the geographic bounding box
 *
 * The zero-area (single coordinate) path is taken not only by Point but also by a MultiPoint
 * with a single point. An implementation that treats coordinates as a Coordinate let NaN
 * flow into the projection and crashed all hit testing, so that is pinned down here.
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_SELECTION_CONFIG } from '../../shared/config/selection.js';
import type { CoordinateTransform } from '../../shared/math/index.js';
import type { Feature } from '../../store/types.js';
import { computeCombinedGeoBoundingBox, computeFeatureGeoBoundingBox } from './bounds.js';

/** A planar transform where 1 degree = 100px (for the tests) */
const transform: CoordinateTransform = {
  project: (lngLat) => ({ x: lngLat[0] * 100, y: -lngLat[1] * 100 }),
  unproject: (point) => ({ lng: point.x / 100, lat: -point.y / 100 }),
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

function expectFiniteBbox(bbox: ReturnType<typeof computeFeatureGeoBoundingBox>): void {
  expect(bbox).not.toBeNull();
  if (!bbox) return;
  for (const corner of [bbox.topLeft, bbox.topRight, bbox.bottomRight, bbox.bottomLeft]) {
    expect(Number.isFinite(corner[0])).toBe(true);
    expect(Number.isFinite(corner[1])).toBe(true);
  }
  expect(Number.isFinite(bbox.center[0])).toBe(true);
  expect(Number.isFinite(bbox.center[1])).toBe(true);
}

describe('computeFeatureGeoBoundingBox the zero-area path', () => {
  it('returns a finite bbox centered on the coordinate for a Point', () => {
    const feature = makeFeature({
      type: 'Point',
      geometry: { type: 'Point', coordinates: [139.7, 35.7] },
    });
    const bbox = computeFeatureGeoBoundingBox(feature, transform, DEFAULT_SELECTION_CONFIG);
    expectFiniteBbox(bbox);
    expect(bbox?.center).toEqual([139.7, 35.7]);
  });

  it('emits no NaN for a MultiPoint with a single point and centers on that point', () => {
    const feature = makeFeature({
      type: 'MultiPoint',
      geometry: { type: 'MultiPoint', coordinates: [[139.74, 35.73]] },
    });
    const bbox = computeFeatureGeoBoundingBox(feature, transform, DEFAULT_SELECTION_CONFIG);
    expectFiniteBbox(bbox);
    expect(bbox?.center).toEqual([139.74, 35.73]);
  });

  it('emits no NaN for a LineString whose vertices are all the same coordinate', () => {
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
    const bbox = computeFeatureGeoBoundingBox(feature, transform, DEFAULT_SELECTION_CONFIG);
    expectFiniteBbox(bbox);
    expect(bbox?.center).toEqual([10, 20]);
  });
});

describe('computeCombinedGeoBoundingBox', () => {
  it('returns a finite bbox for a multi-selection including a single-point MultiPoint', () => {
    const multiPoint = makeFeature({
      type: 'MultiPoint',
      geometry: { type: 'MultiPoint', coordinates: [[139.74, 35.73]] },
    });
    const line = makeFeature({
      type: 'LineString',
      geometry: {
        type: 'LineString',
        coordinates: [
          [139.7, 35.7],
          [139.72, 35.72],
        ],
      },
    });
    const bbox = computeCombinedGeoBoundingBox(
      [multiPoint, line],
      transform,
      DEFAULT_SELECTION_CONFIG,
    );
    expectFiniteBbox(bbox);
  });
});
