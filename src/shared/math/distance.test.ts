// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import type { Coordinate } from '../../store/types.js';
import {
  euclideanDistance,
  getMetersPerPixel,
  haversineDistanceMeters,
  lngToMeters,
  metersToDegreesLat,
  metersToDegreesLng,
  metersToLat,
  metersToLng,
  midpoint,
  pixelsToDegreesLat,
  pixelsToDegreesLng,
  pointToPolylineDistance,
  pointToSegmentDistance,
  toDegrees,
  toRadians,
} from './distance.js';

describe('toRadians', () => {
  it('0 degrees is 0 radians', () => {
    expect(toRadians(0)).toBe(0);
  });

  it('90 degrees is PI/2', () => {
    expect(toRadians(90)).toBeCloseTo(Math.PI / 2, 10);
  });

  it('180 degrees is PI', () => {
    expect(toRadians(180)).toBeCloseTo(Math.PI, 10);
  });

  it('360 degrees is 2*PI', () => {
    expect(toRadians(360)).toBeCloseTo(2 * Math.PI, 10);
  });

  it('a negative angle can be converted too', () => {
    expect(toRadians(-90)).toBeCloseTo(-Math.PI / 2, 10);
  });

  it('the round-trip conversion with toDegrees agrees', () => {
    expect(toDegrees(toRadians(123.456))).toBeCloseTo(123.456, 10);
  });
});

describe('toDegrees', () => {
  it('0 radians is 0 degrees', () => {
    expect(toDegrees(0)).toBe(0);
  });

  it('PI/2 is 90 degrees', () => {
    expect(toDegrees(Math.PI / 2)).toBeCloseTo(90, 10);
  });

  it('PI is 180 degrees', () => {
    expect(toDegrees(Math.PI)).toBeCloseTo(180, 10);
  });

  it('2*PI is 360 degrees', () => {
    expect(toDegrees(2 * Math.PI)).toBeCloseTo(360, 10);
  });

  it('a negative radian value can be converted too', () => {
    expect(toDegrees(-Math.PI)).toBeCloseTo(-180, 10);
  });

  it('the round-trip conversion with toRadians agrees', () => {
    expect(toRadians(toDegrees(1.5))).toBeCloseTo(1.5, 10);
  });
});

describe('euclideanDistance', () => {
  it('the distance between the same points is 0', () => {
    const p: Coordinate = [135, 35];
    expect(euclideanDistance(p, p)).toBe(0);
  });

  it('a 3-4-5 triangle', () => {
    const a: Coordinate = [0, 0];
    const b: Coordinate = [3, 4];
    expect(euclideanDistance(a, b)).toBeCloseTo(5, 10);
  });

  it('horizontal direction only', () => {
    const a: Coordinate = [0, 0];
    const b: Coordinate = [10, 0];
    expect(euclideanDistance(a, b)).toBeCloseTo(10, 10);
  });

  it('vertical direction only', () => {
    const a: Coordinate = [0, 0];
    const b: Coordinate = [0, 7];
    expect(euclideanDistance(a, b)).toBeCloseTo(7, 10);
  });
});

describe('haversineDistanceMeters', () => {
  it('the distance between the same points is 0', () => {
    const p: Coordinate = [139.6917, 35.6895];
    expect(haversineDistanceMeters(p, p)).toBe(0);
  });

  it('the distance between Tokyo and Osaka is roughly 400km', () => {
    const tokyo: Coordinate = [139.6917, 35.6895];
    const osaka: Coordinate = [135.5023, 34.6937];
    const distance = haversineDistanceMeters(tokyo, osaka);
    // In the range of roughly 395-405km
    expect(distance).toBeGreaterThan(390_000);
    expect(distance).toBeLessThan(410_000);
  });

  it('1 degree of longitude on the equator is roughly 111km', () => {
    const a: Coordinate = [0, 0];
    const b: Coordinate = [1, 0];
    const distance = haversineDistanceMeters(a, b);
    expect(distance).toBeGreaterThan(110_000);
    expect(distance).toBeLessThan(112_000);
  });
});

describe('midpoint', () => {
  it('the midpoint of the same points is the original point', () => {
    const p: Coordinate = [10, 20];
    expect(midpoint(p, p)).toEqual([10, 20]);
  });

  it('computes a known midpoint correctly', () => {
    const a: Coordinate = [0, 0];
    const b: Coordinate = [10, 20];
    expect(midpoint(a, b)).toEqual([5, 10]);
  });

  it('computes correctly with negative coordinates too', () => {
    const a: Coordinate = [-10, -20];
    const b: Coordinate = [10, 20];
    expect(midpoint(a, b)).toEqual([0, 0]);
  });
});

describe('metersToLng / metersToLat / lngToMeters', () => {
  it('the round-trip conversion between metersToLng and lngToMeters agrees (equator)', () => {
    const meters = 1000;
    const lat = 0;
    const lngDiff = metersToLng(meters, lat);
    const result = lngToMeters(lngDiff, lat);
    expect(result).toBeCloseTo(meters, 3);
  });

  it('the round-trip conversion between metersToLng and lngToMeters agrees (high latitude)', () => {
    const meters = 1000;
    const lat = 60;
    const lngDiff = metersToLng(meters, lat);
    const result = lngToMeters(lngDiff, lat);
    expect(result).toBeCloseTo(meters, 3);
  });

  it('metersToLng on the equator comes out close to metersToLat', () => {
    const meters = 10000;
    const lngDeg = metersToLng(meters, 0);
    const latDeg = metersToLat(meters);
    expect(lngDeg).toBeCloseTo(latDeg, 5);
  });

  it('at a high latitude metersToLng becomes larger than metersToLat', () => {
    const meters = 10000;
    const lngDeg = metersToLng(meters, 60);
    const latDeg = metersToLat(meters);
    expect(lngDeg).toBeGreaterThan(latDeg);
  });

  it('0 meters is 0 degrees', () => {
    expect(metersToLng(0, 35)).toBe(0);
    expect(metersToLat(0)).toBe(0);
    expect(lngToMeters(0, 35)).toBe(0);
  });
});

describe('pointToSegmentDistance', () => {
  it('a point on the segment has a distance of 0', () => {
    const point: Coordinate = [5, 0];
    const start: Coordinate = [0, 0];
    const end: Coordinate = [10, 0];
    expect(pointToSegmentDistance(point, start, end)).toBeCloseTo(0, 10);
  });

  it('the distance when a perpendicular can be dropped', () => {
    const point: Coordinate = [5, 3];
    const start: Coordinate = [0, 0];
    const end: Coordinate = [10, 0];
    expect(pointToSegmentDistance(point, start, end)).toBeCloseTo(3, 10);
  });

  it('a degenerate segment (start = end) gives the distance between the points', () => {
    const point: Coordinate = [3, 4];
    const start: Coordinate = [0, 0];
    const end: Coordinate = [0, 0];
    expect(pointToSegmentDistance(point, start, end)).toBeCloseTo(5, 10);
  });

  it('beyond an endpoint it is the distance to that endpoint', () => {
    const point: Coordinate = [15, 0];
    const start: Coordinate = [0, 0];
    const end: Coordinate = [10, 0];
    expect(pointToSegmentDistance(point, start, end)).toBeCloseTo(5, 10);
  });

  it('before the start point it is the distance to the start point', () => {
    const point: Coordinate = [-3, 4];
    const start: Coordinate = [0, 0];
    const end: Coordinate = [10, 0];
    expect(pointToSegmentDistance(point, start, end)).toBeCloseTo(5, 10);
  });
});

describe('pointToPolylineDistance', () => {
  it('an empty line is Infinity', () => {
    expect(pointToPolylineDistance([0, 0], [])).toBe(Infinity);
  });

  it('a line with only 1 point is Infinity', () => {
    expect(pointToPolylineDistance([0, 0], [[1, 1]])).toBe(Infinity);
  });

  it('a point on the line has a distance of 0', () => {
    const line: Coordinate[] = [
      [0, 0],
      [10, 0],
      [10, 10],
    ];
    expect(pointToPolylineDistance([5, 0], line)).toBeCloseTo(0, 10);
  });

  it('computes a known distance correctly', () => {
    const line: Coordinate[] = [
      [0, 0],
      [10, 0],
    ];
    expect(pointToPolylineDistance([5, 3], line)).toBeCloseTo(3, 10);
  });
});

describe('getMetersPerPixel', () => {
  it('the value at zoom 0 on the equator', () => {
    const mpp = getMetersPerPixel(0, 0);
    // 40075016.686 / 512 ~ 78271.5
    expect(mpp).toBeCloseTo(40075016.686 / 512, 0);
  });

  it('the higher the zoom, the smaller the value', () => {
    const mpp0 = getMetersPerPixel(0, 0);
    const mpp10 = getMetersPerPixel(0, 10);
    expect(mpp10).toBeLessThan(mpp0);
    expect(mpp0 / mpp10).toBeCloseTo(1024, 0);
  });

  it('the value becomes smaller at a high latitude', () => {
    const equator = getMetersPerPixel(0, 10);
    const highLat = getMetersPerPixel(60, 10);
    expect(highLat).toBeLessThan(equator);
    // cos(60) = 0.5, so roughly half
    expect(highLat / equator).toBeCloseTo(0.5, 2);
  });
});

describe('metersToDegreesLng / metersToDegreesLat', () => {
  it('0 meters is 0 degrees', () => {
    expect(metersToDegreesLng(0, 0)).toBe(0);
    expect(metersToDegreesLat(0)).toBe(0);
  });

  it('on the equator the longitude and latitude conversion results are roughly the same', () => {
    const meters = 111000;
    const lngDeg = metersToDegreesLng(meters, 0);
    const latDeg = metersToDegreesLat(meters);
    expect(lngDeg).toBeCloseTo(latDeg, 3);
  });

  it('1 degree of latitude is roughly 111km', () => {
    const deg = metersToDegreesLat(111_000);
    expect(deg).toBeCloseTo(1, 1);
  });
});

describe('pixelsToDegreesLng / pixelsToDegreesLat', () => {
  it('0 pixels is 0 degrees', () => {
    expect(pixelsToDegreesLng(0, 35, 10)).toBe(0);
    expect(pixelsToDegreesLat(0, 35, 10)).toBe(0);
  });

  it('consistency with getMetersPerPixel (longitude direction)', () => {
    const lat = 35;
    const zoom = 10;
    const pixels = 100;
    const mpp = getMetersPerPixel(lat, zoom);
    const meters = pixels * mpp;
    const expected = metersToDegreesLng(meters, lat);
    expect(pixelsToDegreesLng(pixels, lat, zoom)).toBeCloseTo(expected, 10);
  });

  it('consistency with getMetersPerPixel (latitude direction)', () => {
    const lat = 35;
    const zoom = 10;
    const pixels = 100;
    const mpp = getMetersPerPixel(lat, zoom);
    const meters = pixels * mpp;
    const expected = metersToDegreesLat(meters);
    expect(pixelsToDegreesLat(pixels, lat, zoom)).toBeCloseTo(expected, 10);
  });
});
