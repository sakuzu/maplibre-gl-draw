// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import type { Coordinate } from '../../store/types.js';
import { getAngleFromCenter, getPointAtAngle } from './angle.js';

describe('getPointAtAngle', () => {
  const center: Coordinate = [139.6917, 35.6895];
  const radius = 1000; // 1km

  it('north (0 degrees) increases the latitude and barely changes the longitude', () => {
    const point = getPointAtAngle(center, radius, 0);
    expect(point[0]).toBeCloseTo(center[0], 5);
    expect(point[1]).toBeGreaterThan(center[1]);
  });

  it('east (90 degrees) increases the longitude and barely changes the latitude', () => {
    const point = getPointAtAngle(center, radius, 90);
    expect(point[0]).toBeGreaterThan(center[0]);
    expect(point[1]).toBeCloseTo(center[1], 5);
  });

  it('south (180 degrees) decreases the latitude and barely changes the longitude', () => {
    const point = getPointAtAngle(center, radius, 180);
    expect(point[0]).toBeCloseTo(center[0], 5);
    expect(point[1]).toBeLessThan(center[1]);
  });

  it('west (270 degrees) decreases the longitude and barely changes the latitude', () => {
    const point = getPointAtAngle(center, radius, 270);
    expect(point[0]).toBeLessThan(center[0]);
    expect(point[1]).toBeCloseTo(center[1], 5);
  });

  it('a radius of 0 gives the same coordinate as the center', () => {
    const point = getPointAtAngle(center, 0, 45);
    expect(point[0]).toBeCloseTo(center[0], 10);
    expect(point[1]).toBeCloseTo(center[1], 10);
  });

  it('the round-trip conversion with getAngleFromCenter agrees', () => {
    const angles = [0, 45, 90, 135, 180, 225, 270, 315];
    for (const angle of angles) {
      const point = getPointAtAngle(center, radius, angle);
      const recovered = getAngleFromCenter(center, point);
      expect(recovered).toBeCloseTo(angle, 2);
    }
  });
});

describe('getAngleFromCenter', () => {
  const center: Coordinate = [139.6917, 35.6895];

  it('a point due north is 0 degrees', () => {
    const north: Coordinate = [center[0], center[1] + 0.01];
    expect(getAngleFromCenter(center, north)).toBeCloseTo(0, 1);
  });

  it('a point due east is 90 degrees', () => {
    // The longitude difference is latitude-corrected, so use a slightly larger value
    const latRad = (center[1] * Math.PI) / 180;
    const lngOffset = 0.01 / Math.cos(latRad);
    const east: Coordinate = [center[0] + lngOffset, center[1]];
    expect(getAngleFromCenter(center, east)).toBeCloseTo(90, 1);
  });

  it('a point due south is 180 degrees', () => {
    const south: Coordinate = [center[0], center[1] - 0.01];
    expect(getAngleFromCenter(center, south)).toBeCloseTo(180, 1);
  });

  it('a point due west is 270 degrees', () => {
    const latRad = (center[1] * Math.PI) / 180;
    const lngOffset = 0.01 / Math.cos(latRad);
    const west: Coordinate = [center[0] - lngOffset, center[1]];
    expect(getAngleFromCenter(center, west)).toBeCloseTo(270, 1);
  });

  it('returns 0 degrees for the same point', () => {
    expect(getAngleFromCenter(center, center)).toBe(0);
  });
});
