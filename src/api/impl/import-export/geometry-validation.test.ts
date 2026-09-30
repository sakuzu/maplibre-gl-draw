// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests of the coordinate validation shared by the native and the GeoJSON import
 */

import { describe, expect, it } from 'vitest';
import { describeCoordinateProblem } from './geometry-validation.js';

const SQUARE = [
  [0, 0],
  [1, 0],
  [1, 1],
  [0, 1],
  [0, 0],
];

describe('describeCoordinateProblem', () => {
  it.each([
    ['Point', [0, 0]],
    ['Image', [0, 0]],
    ['Circle', [0, 0]],
    [
      'LineString',
      [
        [0, 0],
        [1, 1],
      ],
    ],
    [
      'Freehand',
      [
        [0, 0],
        [1, 1],
      ],
    ],
    ['MultiPoint', [[0, 0]]],
    ['Polygon', [SQUARE]],
    [
      'MultiLineString',
      [
        [
          [0, 0],
          [1, 1],
        ],
      ],
    ],
    ['MultiPolygon', [[SQUARE]]],
  ])('accepts well-formed %s coordinates', (type, coordinates) => {
    expect(describeCoordinateProblem(type, coordinates)).toBeNull();
  });

  it.each([
    ['Point', [], 'malformed coordinates'],
    ['Point', [0, Number.POSITIVE_INFINITY], 'malformed coordinates'],
    ['Point', [0, 0, 0], 'malformed coordinates'],
    ['Polygon', [[0, 0]], 'coordinates that do not match the type Polygon'],
    ['Freehand', [[0, 0]], 'a line with fewer than two positions'],
    ['MultiLineString', [[[0, 0]]], 'a line with fewer than two positions'],
    ['Polygon', [SQUARE.slice(2)], 'a ring with fewer than four positions'],
    ['Polygon', [[...SQUARE.slice(0, 4), [0, 2]]], 'a ring whose first and last positions differ'],
    ['MultiPolygon', [[SQUARE], [SQUARE.slice(2)]], 'a ring with fewer than four positions'],
  ])('rejects %s %j', (type, coordinates, problem) => {
    expect(describeCoordinateProblem(type, coordinates)).toBe(problem);
  });

  it('accepts a custom type at any regular depth', () => {
    expect(describeCoordinateProblem('Ribbon', [[0, 0]])).toBeNull();
    expect(describeCoordinateProblem('Ribbon', [[[0, 0]]])).toBeNull();
    expect(describeCoordinateProblem('Ribbon', [[0, 0], [[0, 0]]])).toBe('malformed coordinates');
  });
});
