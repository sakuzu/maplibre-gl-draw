// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Public surface check
 *
 * Confirms that every operation is reachable from the subpath export entry point.
 * Running in a node environment without a DOM is itself the guarantee of being
 * independent of maplibre and the DOM.
 */

import { describe, expect, it } from 'vitest';
import * as geometry from './index.js';

/** Functions and constants that must be public */
const EXPECTED_EXPORTS = [
  // Boolean operations
  'union',
  'unionAll',
  'difference',
  'differenceAll',
  'intersection',
  'intersectionAll',
  'clip',
  'normalizeArea',
  // Splitting by a line
  'splitArea',
  'segmentIntersection',
  // Buffer
  'buffer',
  'DEFAULT_BUFFER_SEGMENTS',
  // Predicates
  'pointInPolygon',
  'intersects',
  'contains',
  'within',
  // Measurement
  'geodesicLength',
  'sphericalArea',
  'centroid',
  'pointOnSurface',
  // Shaping
  'simplify',
  'signedRingArea',
  'isRingClockwise',
  'normalizeRingOrientation',
  'normalizePolygonOrientation',
  'normalizeMultiPolygonOrientation',
  // Geodesic basics
  'haversineDistanceMeters',
  'initialBearingDegrees',
  'destinationPoint',
  'getPointAtAngle',
  'generateCirclePolygon',
  'toRadians',
  'toDegrees',
  'EARTH_RADIUS_METERS',
  // Coordinate shapes and bbox
  'isMultiPolygonCoordinates',
  'toMultiPolygonCoordinates',
  'isRingClosed',
  'closeRing',
  'flattenAreaCoordinates',
  'coordinatesBBox',
  'boundingBox',
  'bboxIntersects',
  'bboxContains',
  // Errors
  'GeometryError',
];

describe('public surface of geometry', () => {
  it('exports every operation', () => {
    const missing = EXPECTED_EXPORTS.filter((name) => !(name in geometry));
    expect(missing).toEqual([]);
  });

  it('has no extra export', () => {
    const extra = Object.keys(geometry).filter((name) => !EXPECTED_EXPORTS.includes(name));
    expect(extra).toEqual([]);
  });

  it('can compute without using the DOM', () => {
    expect(typeof globalThis.document).toBe('undefined');
    const result = geometry.buffer({ type: 'Point', coordinates: [139.7, 35.6] }, 100);
    expect(result).not.toBeNull();
  });
});
