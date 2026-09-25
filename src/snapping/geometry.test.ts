// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for the distance computation of snapping
 *
 * They verify the conversion between pixels and degrees (which depends on the
 * latitude and the zoom) and the nearest point on a segment.
 */

import { describe, expect, it } from 'vitest';
import { degreesPerPixel, distanceInPixels, nearestPointOnSegment } from './geometry.js';

describe('degreesPerPixel', () => {
  it('makes the longitude direction independent of the latitude and halved by the zoom', () => {
    const atEquator = degreesPerPixel(0, 14);
    const atHighLat = degreesPerPixel(60, 14);
    expect(atHighLat.lng).toBeCloseTo(atEquator.lng, 12);

    const zoomedIn = degreesPerPixel(0, 15);
    expect(zoomedIn.lng).toBeCloseTo(atEquator.lng / 2, 12);
  });

  it('shrinks the degrees in the latitude direction at higher latitudes (cos of the latitude)', () => {
    const atEquator = degreesPerPixel(0, 14);
    const atHighLat = degreesPerPixel(60, 14);
    expect(atHighLat.lat).toBeCloseTo(atEquator.lat * Math.cos((60 * Math.PI) / 180), 10);
  });
});

describe('distanceInPixels', () => {
  it('returns the distance converted into pixels', () => {
    const perPixel = degreesPerPixel(35.68, 14);
    const origin: [number, number] = [139.7, 35.68];
    const shifted: [number, number] = [139.7 + perPixel.lng * 3, 35.68 + perPixel.lat * 4];

    expect(distanceInPixels(origin, shifted, perPixel)).toBeCloseTo(5, 9);
  });
});

describe('nearestPointOnSegment', () => {
  const perPixel = degreesPerPixel(35.68, 14);

  it('returns the foot of the perpendicular inside the segment', () => {
    const point = nearestPointOnSegment([0.5, 0], [0, -1], [0, 1], perPixel);
    expect(point[0]).toBeCloseTo(0, 12);
    expect(point[1]).toBeCloseTo(0, 12);
  });

  it('returns an end point outside the segment', () => {
    expect(nearestPointOnSegment([0, 5], [0, -1], [0, 1], perPixel)).toEqual([0, 1]);
    expect(nearestPointOnSegment([0, -5], [0, -1], [0, 1], perPixel)).toEqual([0, -1]);
  });

  it('returns the start point for a segment of length 0', () => {
    expect(nearestPointOnSegment([1, 1], [2, 2], [2, 2], perPixel)).toEqual([2, 2]);
  });

  it('does the projection in pixel space (taking the shrinking in the latitude direction into account)', () => {
    // At a latitude of 60 degrees, 1 degree of latitude is twice as many pixels as 1
    // degree of longitude, so the nearest point on a diagonal segment differs from the
    // position computed in degree space (t = 0.5)
    const highLatPerPixel = degreesPerPixel(60, 14);
    const point = nearestPointOnSegment([1, 0], [0, 0], [1, 1], highLatPerPixel);
    const t = point[0];
    expect(t).toBeCloseTo(0.2, 10);
    expect(point[1]).toBeCloseTo(0.2, 10);
  });
});
