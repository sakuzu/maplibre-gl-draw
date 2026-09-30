// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for the hit testing strategies of the Multi geometries
 *
 * They verify "a hit if any part is hit" and "the distance is the minimum over the parts".
 */

import { describe, expect, it } from 'vitest';
import type { Coordinate, Feature } from '../../../store/types.js';
import { latitudeScale } from '../local-frame.js';
import {
  MultiLineStringHitTestStrategy,
  MultiPointHitTestStrategy,
  MultiPolygonHitTestStrategy,
} from './multi.js';

function createFeature(overrides: Partial<Feature> & Pick<Feature, 'type' | 'geometry'>): Feature {
  return {
    id: 'test-feature',
    layerId: 'test-layer',
    groupId: undefined,
    properties: {},
    locked: false,
    visible: true,
    style: {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// MultiPointHitTestStrategy
// ---------------------------------------------------------------------------
describe('MultiPointHitTestStrategy', () => {
  const strategy = new MultiPointHitTestStrategy();

  const multiPoint = createFeature({
    type: 'MultiPoint',
    geometry: {
      type: 'MultiPoint',
      coordinates: [
        [0, 0],
        [100, 0],
      ] as Coordinate[],
    },
  });

  it('has geometryType MultiPoint', () => {
    expect(strategy.geometryType).toBe('MultiPoint');
  });

  it('hits even when a part other than the first one is hit', () => {
    expect(strategy.test(multiPoint, [101, 0], 2)).toBe(true);
  });

  it('misses when it is far from every part', () => {
    expect(strategy.test(multiPoint, [50, 0], 2)).toBe(false);
  });

  it('takes the minimum distance over the parts', () => {
    // 40 from [0,0] and 60 from [100,0] -> 40
    expect(strategy.distance(multiPoint, [40, 0])).toBeCloseTo(40, 10);
  });
});

// ---------------------------------------------------------------------------
// MultiLineStringHitTestStrategy
// ---------------------------------------------------------------------------
describe('MultiLineStringHitTestStrategy', () => {
  const strategy = new MultiLineStringHitTestStrategy();

  const multiLine = createFeature({
    type: 'MultiLineString',
    geometry: {
      type: 'MultiLineString',
      coordinates: [
        [
          [0, 0],
          [10, 0],
        ],
        [
          [0, 60],
          [10, 60],
        ],
      ] as Coordinate[][],
    },
  });

  it('has geometryType MultiLineString', () => {
    expect(strategy.geometryType).toBe('MultiLineString');
  });

  it('hits near the second part as well', () => {
    // 0.5 degrees of latitude at latitude 60.5 is about 1 degree of longitude on screen
    expect(strategy.test(multiLine, [5, 60.5], 2)).toBe(true);
  });

  it('misses when it is far from every part', () => {
    expect(strategy.test(multiLine, [5, 30], 2)).toBe(false);
  });

  it('takes the minimum distance over the parts', () => {
    // 20 to the first one and 40 to the second one (in degrees of latitude). Distances are
    // in degrees of longitude at the click latitude
    expect(strategy.distance(multiLine, [5, 20])).toBeCloseTo(20 / latitudeScale(20), 10);
  });
});

// ---------------------------------------------------------------------------
// MultiPolygonHitTestStrategy
// ---------------------------------------------------------------------------
describe('MultiPolygonHitTestStrategy', () => {
  const strategy = new MultiPolygonHitTestStrategy();

  // Two parts. The first one has a hole (the inner ring [2,2]-[8,8]), and the second one
  // is a detached part in a distant place
  const multiPolygon = createFeature({
    type: 'MultiPolygon',
    geometry: {
      type: 'MultiPolygon',
      coordinates: [
        [
          [
            [0, 0],
            [10, 0],
            [10, 10],
            [0, 10],
            [0, 0],
          ],
          [
            [2, 2],
            [8, 2],
            [8, 8],
            [2, 8],
            [2, 2],
          ],
        ],
        [
          [
            [100, 100],
            [110, 100],
            [110, 110],
            [100, 110],
            [100, 100],
          ],
        ],
      ] as Coordinate[][][],
    },
  });

  it('has geometryType MultiPolygon', () => {
    expect(strategy.geometryType).toBe('MultiPolygon');
  });

  it('hits inside the first part', () => {
    expect(strategy.test(multiPolygon, [1, 1], 0)).toBe(true);
    expect(strategy.distance(multiPolygon, [1, 1])).toBe(0);
  });

  it('hits inside the detached part (the second part) as well', () => {
    expect(strategy.test(multiPolygon, [105, 105], 0)).toBe(true);
    expect(strategy.distance(multiPolygon, [105, 105])).toBe(0);
  });

  it('does not hit inside a hole of a part', () => {
    expect(strategy.test(multiPolygon, [5, 5], 0)).toBe(false);
  });

  it('misses at a position that belongs to no part', () => {
    expect(strategy.test(multiPolygon, [50, 50], 0)).toBe(false);
  });

  it('takes the minimum distance over the parts', () => {
    // 5 to the right edge of the first part (x=10), and 85 to the second one
    expect(strategy.distance(multiPolygon, [15, 5])).toBeCloseTo(5, 10);
  });
});
