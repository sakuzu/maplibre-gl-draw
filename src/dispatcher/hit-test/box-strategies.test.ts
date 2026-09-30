// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for BoxSelectionStrategies
 *
 * Box selection of a Circle tests the intersection with the radius (the ring), not only
 * with the center point.
 * It also checks that createCoreBoxSelectionStrategies includes the Circle strategy.
 */

import { describe, expect, it } from 'vitest';
import type { FeatureCoordinates } from '../../shared/types/model.js';
import { geometryFromCoordinates } from '../../shared/utils/coordinates.js';
import type { BoundingBox, Feature } from '../../store/types.js';
import {
  CircleBoxSelectionStrategy,
  createCoreBoxSelectionStrategies,
  MultiLineStringBoxSelectionStrategy,
  MultiPointBoxSelectionStrategy,
  MultiPolygonBoxSelectionStrategy,
} from './box-strategies.js';

function circle(center: [number, number], radiusMeters: number): Feature {
  return {
    id: 'c',
    type: 'Circle',
    geometry: { type: 'Point', coordinates: center },
    layerId: 'l1',
    groupId: undefined,
    properties: { 'maplibre-gl-draw:radiusMeters': radiusMeters },
    locked: false,
    visible: true,
    style: {},
  };
}

const rect = (minX: number, minY: number, maxX: number, maxY: number): BoundingBox => ({
  minX,
  minY,
  maxX,
  maxY,
});

describe('CircleBoxSelectionStrategy', () => {
  const s = new CircleBoxSelectionStrategy();
  // On the equator, a radius of 100 km is about 0.9 degrees
  const c = circle([0, 0], 100000);

  it('selects it when the ring overlaps even though the center is outside the box', () => {
    // The distance to the nearest point [0.5,0.5] is about 0.707 degrees < the radius of
    // 0.9 degrees
    expect(s.intersects(c, rect(0.5, 0.5, 2, 2))).toBe(true);
  });

  it('selects it when the center is inside the box', () => {
    expect(s.intersects(c, rect(-1, -1, 1, 1))).toBe(true);
  });

  it('does not select it for a box the ring does not reach', () => {
    expect(s.intersects(c, rect(5, 5, 6, 6))).toBe(false);
  });

  it('falls back to the center point test when there is no radiusMeters', () => {
    const noRadius = { ...circle([0, 0], 0), properties: {} } as Feature;
    expect(s.intersects(noRadius, rect(-1, -1, 1, 1))).toBe(true);
    expect(s.intersects(noRadius, rect(5, 5, 6, 6))).toBe(false);
  });
});

describe('box selection of the Multi geometries', () => {
  function multi(type: string, coordinates: FeatureCoordinates): Feature {
    return {
      id: 'm',
      type,
      geometry: geometryFromCoordinates(type, coordinates),
      layerId: 'l1',
      groupId: undefined,
      properties: {},
      locked: false,
      visible: true,
      style: {},
    };
  }

  it('selects a MultiPoint when any of its parts is inside the box', () => {
    const s = new MultiPointBoxSelectionStrategy();
    const f = multi('MultiPoint', [
      [0, 0],
      [100, 100],
    ]);

    // A box that only the second part falls into
    expect(s.intersects(f, rect(99, 99, 101, 101))).toBe(true);
    // A box that neither falls into
    expect(s.intersects(f, rect(50, 50, 60, 60))).toBe(false);
  });

  it('selects a MultiLineString when any of its parts intersects', () => {
    const s = new MultiLineStringBoxSelectionStrategy();
    const f = multi('MultiLineString', [
      [
        [0, 0],
        [10, 0],
      ],
      [
        [0, 100],
        [10, 100],
      ],
    ]);

    expect(s.intersects(f, rect(4, 99, 6, 101))).toBe(true);
    expect(s.intersects(f, rect(4, 40, 6, 60))).toBe(false);
  });

  it('selects a MultiPolygon when any of its parts intersects', () => {
    const s = new MultiPolygonBoxSelectionStrategy();
    const f = multi('MultiPolygon', [
      [
        [
          [0, 0],
          [10, 0],
          [10, 10],
          [0, 10],
          [0, 0],
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
    ]);

    // A box that contains the interior of the detached part (the second part)
    expect(s.intersects(f, rect(102, 102, 104, 104))).toBe(true);
    expect(s.intersects(f, rect(50, 50, 60, 60))).toBe(false);
  });
});

describe('createCoreBoxSelectionStrategies', () => {
  it('includes the Circle strategy', () => {
    const types = createCoreBoxSelectionStrategies().map((s) => s.featureType);
    expect(types).toContain('Circle');
  });

  it('includes the strategies of the Multi geometries', () => {
    const types = createCoreBoxSelectionStrategies().map((s) => s.featureType);
    expect(types).toContain('MultiPoint');
    expect(types).toContain('MultiLineString');
    expect(types).toContain('MultiPolygon');
  });
});
