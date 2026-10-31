// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import type { Coordinate } from '../../store/types.js';
import { metersOnTangentPlane } from './ground-scale.js';
import {
  applyMarginToBoundingBox,
  clampCoordinate,
  clampLatitude,
  expandQuad,
  lngLatToMercator,
} from './transform.js';

describe('clampLatitude', () => {
  it('a value within the range is returned as is', () => {
    expect(clampLatitude(0)).toBe(0);
    expect(clampLatitude(45)).toBe(45);
    expect(clampLatitude(-45)).toBe(-45);
  });

  it('a value above 89.9 is clamped to 89.9', () => {
    expect(clampLatitude(90)).toBe(89.9);
    expect(clampLatitude(100)).toBe(89.9);
    expect(clampLatitude(89.95)).toBe(89.9);
  });

  it('a value below -89.9 is clamped to -89.9', () => {
    expect(clampLatitude(-90)).toBe(-89.9);
    expect(clampLatitude(-100)).toBe(-89.9);
    expect(clampLatitude(-89.95)).toBe(-89.9);
  });

  it('exactly +/-90 is clamped', () => {
    expect(clampLatitude(90)).toBe(89.9);
    expect(clampLatitude(-90)).toBe(-89.9);
  });

  it('exactly +/-89.9 is returned as is', () => {
    expect(clampLatitude(89.9)).toBe(89.9);
    expect(clampLatitude(-89.9)).toBe(-89.9);
  });
});

describe('clampCoordinate', () => {
  it('the longitude is kept as is', () => {
    const result = clampCoordinate([180, 0]);
    expect(result[0]).toBe(180);
  });

  it('the latitude is clamped', () => {
    const result = clampCoordinate([100, 95]);
    expect(result[0]).toBe(100);
    expect(result[1]).toBe(89.9);
  });

  it('a coordinate within the range is returned as is', () => {
    const coord: Coordinate = [139.7, 35.7];
    const result = clampCoordinate(coord);
    expect(result).toEqual([139.7, 35.7]);
  });
});

describe('lngLatToMercator', () => {
  it('lng=-180 becomes x=0', () => {
    const result = lngLatToMercator([-180, 0]);
    expect(result[0]).toBeCloseTo(0);
  });

  it('lng=0 becomes x=0.5', () => {
    const result = lngLatToMercator([0, 0]);
    expect(result[0]).toBeCloseTo(0.5);
  });

  it('lng=180 becomes x=1', () => {
    const result = lngLatToMercator([180, 0]);
    expect(result[0]).toBeCloseTo(1);
  });

  it('lat=0 becomes y=0.5', () => {
    const result = lngLatToMercator([0, 0]);
    expect(result[1]).toBeCloseTo(0.5);
  });

  it('a northern latitude becomes y<0.5', () => {
    const result = lngLatToMercator([0, 45]);
    expect(result[1]).toBeLessThan(0.5);
  });

  it('a southern latitude becomes y>0.5', () => {
    const result = lngLatToMercator([0, -45]);
    expect(result[1]).toBeGreaterThan(0.5);
  });
});

describe('applyMarginToBoundingBox', () => {
  const bbox = {
    topLeft: [139.0, 35.5] as Coordinate,
    topRight: [139.4, 35.5] as Coordinate,
    bottomRight: [139.4, 35.2] as Coordinate,
    bottomLeft: [139.0, 35.2] as Coordinate,
  };
  const center: Coordinate = [139.2, 35.35];
  /** Two meters a pixel, wherever it is asked (the frame is made from the scale alone) */
  const scale = { metersPerPixel: () => 2 };

  it('moves every edge out by the margin in meters on the plane tangent at the center', () => {
    const result = applyMarginToBoundingBox(bbox, 10, scale);
    const [westOf, northOf] = metersOnTangentPlane(center, bbox.topLeft);
    const [east, north] = metersOnTangentPlane(center, result.topLeft);
    expect(east - westOf).toBeCloseTo(-20, 6);
    expect(north - northOf).toBeCloseTo(20, 6);
    const [eastOf, southOf] = metersOnTangentPlane(center, bbox.bottomRight);
    const [farEast, farSouth] = metersOnTangentPlane(center, result.bottomRight);
    expect(farEast - eastOf).toBeCloseTo(20, 6);
    expect(farSouth - southOf).toBeCloseTo(-20, 6);
  });

  it('keeps the center, and the corners for a margin of 0', () => {
    const result = applyMarginToBoundingBox(bbox, 8, scale);
    expect((result.topLeft[0] + result.bottomRight[0]) / 2).toBeCloseTo(center[0], 9);
    expect((result.topLeft[1] + result.bottomRight[1]) / 2).toBeCloseTo(center[1], 9);
    expect(applyMarginToBoundingBox(bbox, 0, scale)).toEqual({
      topLeft: bbox.topLeft,
      topRight: bbox.topRight,
      bottomRight: bbox.bottomRight,
      bottomLeft: bbox.bottomLeft,
    });
  });

  it('asks the scale at the center of the box', () => {
    const asked: Coordinate[] = [];
    applyMarginToBoundingBox(bbox, 4, {
      metersPerPixel: (lngLat) => {
        asked.push(lngLat);
        return 1;
      },
    });
    expect(asked).toEqual([center]);
  });

  it('leaves the box as it is without a scale', () => {
    const result = applyMarginToBoundingBox(bbox, 4, { metersPerPixel: () => Number.NaN });
    expect(result.topLeft).toEqual(bbox.topLeft);
    expect(result.bottomRight).toEqual(bbox.bottomRight);
  });
});

describe('expandQuad', () => {
  const round = (points: { x: number; y: number }[]) =>
    points.map(({ x, y }) => [Math.round(x * 1e6) / 1e6, Math.round(y * 1e6) / 1e6]);

  it('keeps the margin on every side of a wide box, not only at its ends', () => {
    const box = [
      { x: 0, y: 0 },
      { x: 200, y: 0 },
      { x: 200, y: 20 },
      { x: 0, y: 20 },
    ];
    expect(round(expandQuad(box, 10))).toEqual([
      [-10, -10],
      [210, -10],
      [210, 30],
      [-10, 30],
    ]);
  });

  it('moves the edges of a turned box along its own directions', () => {
    // A 20 by 10 box turned by 90 degrees clockwise: its top edge points down the screen
    const turned = [
      { x: 10, y: 0 },
      { x: 10, y: 20 },
      { x: 0, y: 20 },
      { x: 0, y: 0 },
    ];
    expect(round(expandQuad(turned, 2))).toEqual([
      [12, -2],
      [12, 22],
      [-2, 22],
      [-2, -2],
    ]);
  });

  it('gives a straight line a frame on both of its sides', () => {
    const line = [
      { x: 0, y: 5 },
      { x: 40, y: 5 },
      { x: 40, y: 5 },
      { x: 0, y: 5 },
    ];
    expect(round(expandQuad(line, 3))).toEqual([
      [-3, 2],
      [43, 2],
      [43, 8],
      [-3, 8],
    ]);
  });
});
