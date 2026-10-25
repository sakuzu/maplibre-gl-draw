// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The rotation of a rotate drag as an edit, and what the drag writes over its features
 *
 * - The angle is the one the pointer turned around the center in the east, north and up frame of
 *   the center: a quarter of a turn counterclockwise is 90, the other way -90, within (-180, 180];
 *   the pointer on the center is 0
 * - The center: the one of the frame, or the position of an only feature that turns by its
 *   rotation and is a point
 * - The positions are rotated as the reference rotates them (computed apart, in float64), at any
 *   latitude and size, the parts of the Multi geometries kept; a pole gives no NaN
 * - An image alone keeps its position, and its rotation takes the angle within [0, 360); with
 *   another feature it turns around the center of the frame
 * - A rotation by 0 leaves the positions as they were
 */

import type { LineString, MultiPolygon, Point, Polygon } from 'geojson';
import { describe, expect, it } from 'vitest';
import { DRAW_PROPERTY_KEYS } from '../shared/properties.js';
import { DEFAULT_TRANSFORMS } from '../store/feature-edits.js';
import type { Coordinate, Feature } from '../store/types.js';
import { referenceEnuOffset, referenceRotate } from '../test-support/enu-reference.js';
import type { BoundingBoxCoords } from '../view/ui/selection-ui/index.js';
import { rotateEditOf, rotationAngleOf, rotationCenterOf } from './rotate.js';
import { transformedUpdates, transformStartOf } from './transform-features.js';

/** About 0.1 mm, in degrees */
const TOLERANCE = 1e-9;
const ROTATION = DRAW_PROPERTY_KEYS.rotation;

function createFeature(
  overrides: Partial<Feature> & { id: string; type: string; geometry: Feature['geometry'] },
): Feature {
  return {
    layerId: 'layer-1',
    properties: {},
    locked: false,
    visible: true,
    style: {},
    ...overrides,
  } as Feature;
}

function createBBox(center: Coordinate, half = 1): BoundingBoxCoords {
  return {
    topLeft: [center[0] - half, center[1] + half],
    topRight: [center[0] + half, center[1] + half],
    bottomRight: [center[0] + half, center[1] - half],
    bottomLeft: [center[0] - half, center[1] - half],
    center,
  };
}

/** The positions of a feature rotated by a drag from `start` to `current` around `center` */
function rotated(
  feature: Feature,
  center: [number, number],
  start: { lng: number; lat: number },
  current: { lng: number; lat: number },
): Partial<Feature> {
  const edit = rotateEditOf(center, start, current);
  const updates = transformedUpdates(DEFAULT_TRANSFORMS, edit, transformStartOf(feature), feature);
  if (!updates) throw new Error('the edit was not taken');
  return updates;
}

function expectNear(actual: readonly number[], expected: readonly number[]): void {
  expect(Math.abs((actual[0] as number) - (expected[0] as number))).toBeLessThan(TOLERANCE);
  expect(Math.abs((actual[1] as number) - (expected[1] as number))).toBeLessThan(TOLERANCE);
}

describe('the angle of a rotate drag', () => {
  const center: [number, number] = [139.7, 35.68];

  it('is a quarter of a turn when the pointer goes from the east to the north', () => {
    const angle = rotationAngleOf(center, { lng: 139.71, lat: 35.68 }, { lng: 139.7, lat: 35.69 });
    expect(Math.abs(angle - 90)).toBeLessThan(0.01);
  });

  it('is negative the other way, and within (-180, 180]', () => {
    const back = rotationAngleOf(center, { lng: 139.71, lat: 35.68 }, { lng: 139.7, lat: 35.67 });
    expect(Math.abs(back + 90)).toBeLessThan(0.01);
    const far = rotationAngleOf(center, { lng: 139.7, lat: 35.69 }, { lng: 139.69, lat: 35.679 });
    expect(far).toBeGreaterThan(-180);
    expect(far).toBeLessThanOrEqual(180);
    // From the north to nearly the west, past it: counterclockwise by a little more than 90
    const [se, sn] = referenceEnuOffset(center, [139.7, 35.69]);
    const [ce, cn] = referenceEnuOffset(center, [139.69, 35.679]);
    const expected = ((Math.atan2(cn, ce) - Math.atan2(sn, se)) * 180) / Math.PI + 360;
    expect(Math.abs(far - expected)).toBeLessThan(1e-9);
    expect(far).toBeGreaterThan(90);
    const across = rotationAngleOf(
      center,
      { lng: 139.71, lat: 35.6801 },
      { lng: 139.69, lat: 35.6801 },
    );
    expect(across).toBeGreaterThan(170);
    expect(across).toBeLessThanOrEqual(180);
  });

  it('is 0 for the same position, and for a pointer on the center', () => {
    expect(rotationAngleOf(center, { lng: 139.71, lat: 35.7 }, { lng: 139.71, lat: 35.7 })).toBe(0);
    expect(rotationAngleOf(center, { lng: 139.7, lat: 35.68 }, { lng: 139.71, lat: 35.7 })).toBe(0);
  });
});

describe('the center of a rotate drag', () => {
  const bbox = createBBox([139.7, 35.7], 0.1);

  it('is the position of an image alone', () => {
    const image = createFeature({
      id: 'image',
      type: 'Image',
      geometry: { type: 'Point', coordinates: [139.65, 35.72] },
    });
    expect(rotationCenterOf(bbox, [image])).toEqual([139.65, 35.72]);
  });

  it('is the center of the frame for several features, or a feature that does not turn by its rotation', () => {
    const image = createFeature({
      id: 'image',
      type: 'Image',
      geometry: { type: 'Point', coordinates: [139.65, 35.72] },
    });
    const line = createFeature({
      id: 'line',
      type: 'LineString',
      geometry: {
        type: 'LineString',
        coordinates: [
          [139.6, 35.6],
          [139.8, 35.8],
        ],
      },
    });
    expect(rotationCenterOf(bbox, [image, line])).toEqual([139.7, 35.7]);
    expect(rotationCenterOf(bbox, [line])).toEqual([139.7, 35.7]);
  });
});

describe('what a rotate drag writes', () => {
  it('rotates a LineString as the reference does', () => {
    const center: [number, number] = [139.7, 35.68];
    const coordinates = [
      [139.6, 35.6],
      [139.8, 35.65],
      [139.75, 35.78],
    ];
    const line = createFeature({
      id: 'line',
      type: 'LineString',
      geometry: { type: 'LineString', coordinates },
    });
    const start = { lng: 139.71, lat: 35.68 };
    const current = { lng: 139.7, lat: 35.69 };
    const angle = rotationAngleOf(center, start, current);
    const moved = (rotated(line, center, start, current).geometry as LineString).coordinates;
    coordinates.forEach((position, i) => {
      expectNear(moved[i] as number[], referenceRotate(position, center, angle));
    });
  });

  it('rotates a large feature far from the equator as the reference does', () => {
    const center: [number, number] = [137, 38];
    const coordinates = [
      [129, 31],
      [145, 31],
      [145, 45],
      [129, 45],
      [129, 31],
    ];
    const polygon = createFeature({
      id: 'polygon',
      type: 'Polygon',
      geometry: { type: 'Polygon', coordinates: [coordinates] },
    });
    const start = { lng: 140, lat: 38 };
    const current = { lng: 139.5, lat: 40 };
    const angle = rotationAngleOf(center, start, current);
    const moved = (rotated(polygon, center, start, current).geometry as Polygon).coordinates[0];
    coordinates.forEach((position, i) => {
      expectNear(moved?.[i] as number[], referenceRotate(position, center, angle));
    });
  });

  it('rotates every part and every ring of a MultiPolygon and keeps the nested structure', () => {
    const center: [number, number] = [10, 50];
    const parts = [
      [
        [
          [9, 49],
          [9.5, 49],
          [9.5, 49.5],
          [9, 49],
        ],
      ],
      [
        [
          [10.5, 50.5],
          [11, 50.5],
          [11, 51],
          [10.5, 50.5],
        ],
        [
          [10.6, 50.6],
          [10.8, 50.6],
          [10.8, 50.8],
          [10.6, 50.6],
        ],
      ],
    ];
    const multi = createFeature({
      id: 'multi',
      type: 'MultiPolygon',
      geometry: { type: 'MultiPolygon', coordinates: parts },
    });
    const start = { lng: 10.5, lat: 50 };
    const current = { lng: 10, lat: 50.5 };
    const angle = rotationAngleOf(center, start, current);
    const moved = (rotated(multi, center, start, current).geometry as MultiPolygon).coordinates;
    expect(moved.length).toBe(2);
    expect(moved[1]?.length).toBe(2);
    parts.forEach((part, p) => {
      part.forEach((ring, r) => {
        ring.forEach((position, i) => {
          expectNear(moved[p]?.[r]?.[i] as number[], referenceRotate(position, center, angle));
        });
      });
    });
  });

  it('keeps the position of an image alone and adds the angle to its rotation within [0, 360)', () => {
    const image = createFeature({
      id: 'image',
      type: 'Image',
      geometry: { type: 'Point', coordinates: [139.7, 35.68] },
      properties: { [ROTATION]: 350 },
    });
    const center = rotationCenterOf(createBBox([139.7, 35.68], 0.01), [image]);
    const updates = rotated(image, center, { lng: 139.71, lat: 35.68 }, { lng: 139.7, lat: 35.69 });
    expect((updates.geometry as Point).coordinates).toEqual([139.7, 35.68]);
    const rotation = updates.properties?.[ROTATION] as number;
    expect(rotation).toBeGreaterThanOrEqual(0);
    expect(Math.abs(rotation - 80)).toBeLessThan(0.01);
  });

  it('turns an image with another feature around the center of the frame', () => {
    const center: [number, number] = [139.7, 35.68];
    const image = createFeature({
      id: 'image',
      type: 'Image',
      geometry: { type: 'Point', coordinates: [139.75, 35.7] },
    });
    const start = { lng: 139.71, lat: 35.68 };
    const current = { lng: 139.7, lat: 35.69 };
    const angle = rotationAngleOf(center, start, current);
    const updates = rotated(image, center, start, current);
    expectNear(
      (updates.geometry as Point).coordinates,
      referenceRotate([139.75, 35.7], center, angle),
    );
    expect(Math.abs((updates.properties?.[ROTATION] as number) - angle)).toBeLessThan(1e-12);
  });

  it('leaves the positions as they were for a rotation by 0', () => {
    const coordinates = [
      [139.6, 35.6],
      [139.8, 35.8],
    ];
    const line = createFeature({
      id: 'line',
      type: 'LineString',
      geometry: { type: 'LineString', coordinates },
    });
    const at = { lng: 139.71, lat: 35.7 };
    expect((rotated(line, [139.7, 35.7], at, at).geometry as LineString).coordinates).toEqual(
      coordinates,
    );
  });

  it('rotates a feature at a pole without producing NaN', () => {
    const line = createFeature({
      id: 'pole',
      type: 'LineString',
      geometry: {
        type: 'LineString',
        coordinates: [
          [0, 90],
          [10, 89],
        ],
      },
    });
    const moved = (
      rotated(line, [5, 89.5], { lng: 6, lat: 89.5 }, { lng: 5, lat: 89.6 }).geometry as LineString
    ).coordinates;
    for (const position of moved) {
      expect(Number.isFinite(position[0])).toBe(true);
      expect(Number.isFinite(position[1])).toBe(true);
    }
  });
});
