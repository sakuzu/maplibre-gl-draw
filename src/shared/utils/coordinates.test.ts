// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests of the coordinate traversal utilities
 *
 * Verifies the recursive traversal shared by the coordinate mapping of moving / resizing /
 * rotating and by the bounding box computation. Confirms that the transform is applied to
 * every coordinate while the shape of the nesting is preserved, even for Multi geometries
 * (MultiPolygon has 4 levels of nesting).
 */

import { describe, expect, it } from 'vitest';
import type { Coordinate } from '../../store/types.js';
import {
  flattenCoordinatesDeep,
  isCoordinate,
  isMultiFeatureType,
  mapCoordinatesDeep,
} from './coordinates.js';

const shift = (coord: Coordinate): Coordinate => [coord[0] + 1, coord[1] + 2];

describe('isCoordinate', () => {
  it('identifies [lng, lat] as a single coordinate', () => {
    expect(isCoordinate([1, 2])).toBe(true);
  });

  it('does not identify an array of coordinates as a single coordinate', () => {
    expect(
      isCoordinate([
        [1, 2],
        [3, 4],
      ]),
    ).toBe(false);
  });
});

describe('isMultiFeatureType', () => {
  it('returns true only for the Multi family', () => {
    expect(isMultiFeatureType('MultiPoint')).toBe(true);
    expect(isMultiFeatureType('MultiLineString')).toBe(true);
    expect(isMultiFeatureType('MultiPolygon')).toBe(true);
    expect(isMultiFeatureType('Point')).toBe(false);
    expect(isMultiFeatureType('Polygon')).toBe(false);
    expect(isMultiFeatureType('Freehand')).toBe(false);
  });
});

describe('mapCoordinatesDeep', () => {
  it('transforms a Point (1 level)', () => {
    expect(mapCoordinatesDeep([0, 0] as Coordinate, shift)).toEqual([1, 2]);
  });

  it('transforms a LineString / MultiPoint (2 levels)', () => {
    expect(
      mapCoordinatesDeep(
        [
          [0, 0],
          [10, 10],
        ] as Coordinate[],
        shift,
      ),
    ).toEqual([
      [1, 2],
      [11, 12],
    ]);
  });

  it('transforms a Polygon / MultiLineString (3 levels)', () => {
    expect(
      mapCoordinatesDeep(
        [
          [
            [0, 0],
            [10, 0],
          ],
          [[1, 1]],
        ] as Coordinate[][],
        shift,
      ),
    ).toEqual([
      [
        [1, 2],
        [11, 2],
      ],
      [[2, 3]],
    ]);
  });

  it('transforms a MultiPolygon (4 levels) while preserving the shape of the nesting', () => {
    const parts: Coordinate[][][] = [
      [
        [
          [0, 0],
          [10, 0],
          [10, 10],
        ],
        [
          [2, 2],
          [3, 2],
          [3, 3],
        ],
      ],
      [
        [
          [100, 100],
          [110, 100],
        ],
      ],
    ];

    expect(mapCoordinatesDeep(parts, shift)).toEqual([
      [
        [
          [1, 2],
          [11, 2],
          [11, 12],
        ],
        [
          [3, 4],
          [4, 4],
          [4, 5],
        ],
      ],
      [
        [
          [101, 102],
          [111, 102],
        ],
      ],
    ]);
  });

  it('does not destroy the input', () => {
    const coords: Coordinate[][][] = [[[[0, 0]]]].map((p) => p as Coordinate[][]);
    mapCoordinatesDeep(coords, shift);
    expect(coords).toEqual([[[[0, 0]]]]);
  });
});

describe('flattenCoordinatesDeep', () => {
  it('flattens the coordinates of every part and every ring of a MultiPolygon', () => {
    const parts: Coordinate[][][] = [
      [
        [
          [0, 0],
          [1, 1],
        ],
      ],
      [
        [
          [10, 10],
          [11, 11],
        ],
        [[20, 20]],
      ],
    ];

    expect(flattenCoordinatesDeep(parts)).toEqual([
      [0, 0],
      [1, 1],
      [10, 10],
      [11, 11],
      [20, 20],
    ]);
  });
});
