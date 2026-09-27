// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for the bbox of a retained chunk and the thinning by the viewport
 */

import { describe, expect, it } from 'vitest';
import type { FeatureCoordinates } from '../../shared/types/model.js';
import { geometryFromCoordinates } from '../../shared/utils/coordinates.js';
import type { Coordinate, Feature } from '../../store/types.js';
import {
  bboxIntersects,
  chunkBBoxToBounds,
  computeFeaturesBBox,
  expandBBox,
} from './store-retained-bbox.js';

function makeFeature(
  id: string,
  type: Feature['type'],
  coordinates: FeatureCoordinates,
  properties: Record<string, unknown> = {},
): Feature {
  return {
    id,
    type,
    geometry: geometryFromCoordinates(type, coordinates),
    layerId: 'layer-1',
    properties,
    locked: false,
    visible: true,
    style: {},
  } as Feature;
}

describe('bboxIntersects', () => {
  const viewport = { minX: 0, minY: 0, maxX: 10, maxY: 10 };

  it('counts touching edges as intersecting', () => {
    expect(bboxIntersects([10, 10, 20, 20], viewport)).toBe(true);
    expect(bboxIntersects([-5, -5, 0, 0], viewport)).toBe(true);
  });

  it('rejects a bbox entirely outside on any side', () => {
    expect(bboxIntersects([11, 0, 20, 5], viewport)).toBe(false);
    expect(bboxIntersects([0, 11, 5, 20], viewport)).toBe(false);
    expect(bboxIntersects([-20, 0, -1, 5], viewport)).toBe(false);
    expect(bboxIntersects([0, -20, 5, -1], viewport)).toBe(false);
  });
});

describe('chunkBBoxToBounds', () => {
  it('maps the tuple onto the BoundingBox fields', () => {
    expect(chunkBBoxToBounds([1, 2, 3, 4])).toEqual({ minX: 1, minY: 2, maxX: 3, maxY: 4 });
  });
});

describe('expandBBox', () => {
  it('only grows the bbox', () => {
    expect(expandBBox([0, 0, 1, 1], [2, -1])).toEqual([0, -1, 2, 1]);
    expect(expandBBox([0, 0, 1, 1], [0.5, 0.5])).toEqual([0, 0, 1, 1]);
  });

  it('keeps null (always drawn) and ignores a non-finite coordinate', () => {
    expect(expandBBox(null, [1, 1])).toBeNull();
    expect(expandBBox([0, 0, 1, 1], [Number.NaN, 5])).toEqual([0, 0, 1, 1]);
  });
});

describe('computeFeaturesBBox', () => {
  it('covers every coordinate of every feature, whatever the nesting', () => {
    const line: Coordinate[] = [
      [0, 0],
      [2, 1],
    ];
    const bbox = computeFeaturesBBox(
      [
        makeFeature('l', 'LineString', line),
        makeFeature('p', 'Polygon', [
          [
            [-3, 4],
            [1, 4],
            [1, 5],
          ],
        ]),
        makeFeature('m', 'Point', [5, -2]),
      ],
      undefined,
    );
    expect(bbox).toEqual([-3, -2, 5, 5]);
  });

  it('returns null when there is no finite coordinate', () => {
    expect(computeFeaturesBBox([], undefined)).toBeNull();
    expect(computeFeaturesBBox([makeFeature('x', 'Point', [Number.NaN, 0])], undefined)).toBeNull();
  });

  it('uses the extent of the geodesic circle rather than its center', () => {
    const bbox = computeFeaturesBBox(
      [makeFeature('c', 'Circle', [0, 0], { radiusMeters: 100_000 })],
      undefined,
    );
    expect(bbox).not.toBeNull();
    const [minLng, minLat, maxLng, maxLat] = bbox as number[];
    expect(minLng).toBeLessThan(-0.8);
    expect(maxLng).toBeGreaterThan(0.8);
    expect(minLat).toBeLessThan(-0.8);
    expect(maxLat).toBeGreaterThan(0.8);
  });
});
