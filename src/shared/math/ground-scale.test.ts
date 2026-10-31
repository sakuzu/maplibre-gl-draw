// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import {
  degreesPerMeterAt,
  degreesPerPixelAtZoom,
  metersOnTangentPlane,
  metersPerPixelAtZoom,
  offsetOnTangentPlane,
  worldSizeAtZoom,
} from './ground-scale.js';

const RADIUS = 6371008.8;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

describe('worldSizeAtZoom', () => {
  it('is the tiles of a zoom side by side', () => {
    expect(worldSizeAtZoom(0)).toBe(512);
    expect(worldSizeAtZoom(3)).toBe(4096);
    expect(worldSizeAtZoom(1, 256)).toBe(512);
  });
});

describe('metersPerPixelAtZoom', () => {
  it('spreads the circumference of the sphere of the map over the world at the equator', () => {
    expect(metersPerPixelAtZoom(0, 0)).toBeCloseTo(CIRCUMFERENCE / 512, 6);
  });

  it('halves with every zoom and follows the cosine of the latitude', () => {
    expect(metersPerPixelAtZoom(0, 0) / metersPerPixelAtZoom(0, 10)).toBeCloseTo(1024, 9);
    expect(metersPerPixelAtZoom(60, 10) / metersPerPixelAtZoom(0, 10)).toBeCloseTo(0.5, 12);
  });
});

describe('degreesPerPixelAtZoom', () => {
  it('is the degrees of a pixel of Web Mercator: the same longitude at every latitude', () => {
    for (const latitude of [0, 35.68, 60, -70]) {
      const [lng, lat] = degreesPerPixelAtZoom(latitude, 14);
      expect(lng).toBeCloseTo(360 / worldSizeAtZoom(14), 15);
      expect(lat / lng).toBeCloseTo(Math.cos((latitude * Math.PI) / 180), 12);
    }
  });
});

describe('the plane tangent to the sphere', () => {
  it('takes a degree of latitude as an arc of the sphere of the map', () => {
    expect(1 / degreesPerMeterAt(0)[1]).toBeCloseTo((RADIUS * Math.PI) / 180, 6);
    expect(degreesPerMeterAt(60)[0] / degreesPerMeterAt(60)[1]).toBeCloseTo(2, 9);
  });

  it('goes back to the meters it laid', () => {
    const origin: [number, number] = [139.7, 35.68];
    const moved = offsetOnTangentPlane(origin, 120, -45);
    const [east, north] = metersOnTangentPlane(origin, moved);
    expect(east).toBeCloseTo(120, 9);
    expect(north).toBeCloseTo(-45, 9);
  });
});
