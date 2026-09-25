// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import type { Coordinate } from '../../store/types.js';
import {
  computeRotatedQuadCorners,
  ecefToWGS84,
  kmToDegrees,
  pixelsToDegrees,
  rotateCoordinateOnSphere,
  rotateCoordinatesOnSphere,
  wgs84ToECEF,
} from './rotation.js';

describe('wgs84ToECEF', () => {
  it('converts a coordinate on the equator / prime meridian correctly', () => {
    const ecef = wgs84ToECEF([0, 0]);
    // On the equator / prime meridian it lies on the X axis
    expect(ecef.x).toBeCloseTo(6378137.0, 0);
    expect(ecef.y).toBeCloseTo(0, 0);
    expect(ecef.z).toBeCloseTo(0, 0);
  });

  it('converts the coordinate of the north pole correctly', () => {
    const ecef = wgs84ToECEF([0, 90]);
    // At the north pole it lies on the Z axis
    expect(ecef.x).toBeCloseTo(0, 0);
    expect(ecef.y).toBeCloseTo(0, 0);
    // Because of the WGS84 ellipsoid, the Z coordinate is close to the polar radius
    expect(ecef.z).toBeGreaterThan(6300000);
  });

  it('converts a known coordinate', () => {
    // Longitude 90 degrees, latitude 0 degrees
    const ecef = wgs84ToECEF([90, 0]);
    expect(ecef.x).toBeCloseTo(0, 0);
    expect(ecef.y).toBeCloseTo(6378137.0, 0);
    expect(ecef.z).toBeCloseTo(0, 0);
  });
});

describe('ecefToWGS84', () => {
  it('the round-trip conversion with wgs84ToECEF agrees (equator / prime meridian)', () => {
    const original: Coordinate = [0, 0];
    const ecef = wgs84ToECEF(original);
    const result = ecefToWGS84(ecef.x, ecef.y, ecef.z);
    expect(result[0]).toBeCloseTo(original[0], 6);
    expect(result[1]).toBeCloseTo(original[1], 6);
  });

  it('the round-trip conversion with wgs84ToECEF agrees (near Tokyo)', () => {
    const original: Coordinate = [139.7, 35.7];
    const ecef = wgs84ToECEF(original);
    const result = ecefToWGS84(ecef.x, ecef.y, ecef.z);
    expect(result[0]).toBeCloseTo(original[0], 6);
    expect(result[1]).toBeCloseTo(original[1], 6);
  });

  it('the round-trip conversion with wgs84ToECEF agrees (southern hemisphere)', () => {
    const original: Coordinate = [-43.2, -22.9];
    const ecef = wgs84ToECEF(original);
    const result = ecefToWGS84(ecef.x, ecef.y, ecef.z);
    expect(result[0]).toBeCloseTo(original[0], 6);
    expect(result[1]).toBeCloseTo(original[1], 6);
  });

  it('the round-trip conversion with wgs84ToECEF agrees (high latitude)', () => {
    const original: Coordinate = [25, 80];
    const ecef = wgs84ToECEF(original);
    const result = ecefToWGS84(ecef.x, ecef.y, ecef.z);
    expect(result[0]).toBeCloseTo(original[0], 5);
    expect(result[1]).toBeCloseTo(original[1], 5);
  });
});

describe('rotateCoordinateOnSphere', () => {
  it('a rotation of 0 degrees returns the same point', () => {
    const coord: Coordinate = [139.7, 35.7];
    const center: Coordinate = [139.7, 35.7];
    const result = rotateCoordinateOnSphere(coord, center, 0);
    expect(result[0]).toBeCloseTo(coord[0], 6);
    expect(result[1]).toBeCloseTo(coord[1], 6);
  });

  it('a rotation of 360 degrees returns the same point', () => {
    const coord: Coordinate = [140, 36];
    const center: Coordinate = [139, 35];
    const result = rotateCoordinateOnSphere(coord, center, 360);
    expect(result[0]).toBeCloseTo(coord[0], 4);
    expect(result[1]).toBeCloseTo(coord[1], 4);
  });

  it('rotating the center point itself does not change its position', () => {
    const center: Coordinate = [139.7, 35.7];
    const result = rotateCoordinateOnSphere(center, center, 90);
    expect(result[0]).toBeCloseTo(center[0], 6);
    expect(result[1]).toBeCloseTo(center[1], 6);
  });

  it('a 90 degree rotation on the equator returns the known result', () => {
    // Rotate a point on the equator by 90 degrees about the origin
    const coord: Coordinate = [1, 0];
    const center: Coordinate = [0, 0];
    const result = rotateCoordinateOnSphere(coord, center, 90);
    // Rotating a point 1 degree east on the equator counter-clockwise by 90 degrees moves it
    // north
    expect(result[1]).toBeCloseTo(1, 0);
  });
});

describe('rotateCoordinatesOnSphere', () => {
  it('an empty array returns an empty array', () => {
    const result = rotateCoordinatesOnSphere([], [0, 0], 90);
    expect(result).toEqual([]);
  });

  it('rotating a single coordinate agrees with rotateCoordinateOnSphere', () => {
    const coord: Coordinate = [140, 36];
    const center: Coordinate = [139, 35];
    const angle = 45;

    const single = rotateCoordinateOnSphere(coord, center, angle);
    const multi = rotateCoordinatesOnSphere([coord], center, angle);

    expect(multi).toHaveLength(1);
    expect(multi[0][0]).toBeCloseTo(single[0], 10);
    expect(multi[0][1]).toBeCloseTo(single[1], 10);
  });

  it('rotates multiple coordinates correctly', () => {
    const coords: Coordinate[] = [
      [140, 36],
      [141, 37],
    ];
    const center: Coordinate = [139, 35];
    const result = rotateCoordinatesOnSphere(coords, center, 45);
    expect(result).toHaveLength(2);
  });
});

describe('kmToDegrees', () => {
  it('converts kilometers into degrees at the equator', () => {
    const result = kmToDegrees(111.32, 0);
    // At the equator 1 degree of latitude = roughly 111.32km
    expect(result).toBeCloseTo(1, 1);
  });

  it('at a high latitude the degrees in the longitude direction become larger', () => {
    const equator = kmToDegrees(100, 0);
    const highLat = kmToDegrees(100, 60);
    // At a high latitude the distance per degree of longitude is shorter, so the same
    // distance comes out as a larger number of degrees
    expect(highLat).toBeGreaterThan(equator);
  });

  it('0km returns 0 degrees', () => {
    expect(kmToDegrees(0, 0)).toBe(0);
    expect(kmToDegrees(0, 45)).toBe(0);
  });
});

describe('pixelsToDegrees', () => {
  it('0 pixels returns 0 degrees', () => {
    const result = pixelsToDegrees(0, 0, 10);
    expect(result.lngDegrees).toBe(0);
    expect(result.latDegrees).toBe(0);
  });

  it('returns a positive value at a known zoom level', () => {
    const result = pixelsToDegrees(100, 0, 10);
    expect(result.lngDegrees).toBeGreaterThan(0);
    expect(result.latDegrees).toBeGreaterThan(0);
  });

  it('as the zoom level rises the degrees become smaller', () => {
    const lowZoom = pixelsToDegrees(100, 0, 5);
    const highZoom = pixelsToDegrees(100, 0, 10);
    expect(highZoom.lngDegrees).toBeLessThan(lowZoom.lngDegrees);
    expect(highZoom.latDegrees).toBeLessThan(lowZoom.latDegrees);
  });
});

describe('computeRotatedQuadCorners', () => {
  it('with no rotation it returns vertices along the axes', () => {
    const result = computeRotatedQuadCorners(10, 20, 2, 1, 0);
    expect(result.topLeft).toEqual([8, 21]);
    expect(result.topRight).toEqual([12, 21]);
    expect(result.bottomLeft).toEqual([8, 19]);
    expect(result.bottomRight).toEqual([12, 19]);
  });

  it('a rotation of 0 degrees takes the optimized path and matches the unrotated result', () => {
    const result = computeRotatedQuadCorners(0, 0, 5, 3, 0);
    expect(result.topLeft).toEqual([-5, 3]);
    expect(result.topRight).toEqual([5, 3]);
    expect(result.bottomLeft).toEqual([-5, -3]);
    expect(result.bottomRight).toEqual([5, -3]);
  });

  it('with a rotation the distance from the center is preserved', () => {
    const centerLng = 10;
    const centerLat = 20;
    const halfW = 2;
    const halfH = 1;

    const noRot = computeRotatedQuadCorners(centerLng, centerLat, halfW, halfH, 0);
    const rotated = computeRotatedQuadCorners(centerLng, centerLat, halfW, halfH, 45);

    // The distance from the center is broadly preserved under rotation (it is on a sphere, so
    // it is not an exact match)
    const distNoRot = Math.sqrt(
      (noRot.topLeft[0] - centerLng) ** 2 + (noRot.topLeft[1] - centerLat) ** 2,
    );
    const distRot = Math.sqrt(
      (rotated.topLeft[0] - centerLng) ** 2 + (rotated.topLeft[1] - centerLat) ** 2,
    );
    expect(distRot).toBeCloseTo(distNoRot, 1);
  });
});
