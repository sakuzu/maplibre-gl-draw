// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { buffer } from './buffer.js';
import { generateCirclePolygon } from './circle.js';
import { haversineDistanceMeters } from './distance.js';
import { sphericalArea } from './measure.js';
import { pointInPolygon } from './predicates.js';
import type { Coordinate, MultiPolygonCoordinates, PolygonCoordinates, Ring } from './types.js';

/** Rectangular ring */
function rect(minX: number, minY: number, maxX: number, maxY: number): Ring {
  return [
    [minX, minY],
    [maxX, minY],
    [maxX, maxY],
    [minX, maxY],
    [minX, minY],
  ];
}

/** Polygon coordinates of a rectangle */
function rectPolygon(minX: number, minY: number, maxX: number, maxY: number): PolygonCoordinates {
  return [rect(minX, minY, maxX, maxY)];
}

/**
 * Returns the latitudes at which the vertical scan line at the given longitude
 * crosses the boundary of the result
 */
function latitudeCrossings(multiPolygon: MultiPolygonCoordinates, lng: number): number[] {
  const values: number[] = [];
  for (const polygon of multiPolygon) {
    for (const ring of polygon) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i];
        const [xj, yj] = ring[j];
        if (xi > lng !== xj > lng) {
          values.push(yi + ((lng - xi) / (xj - xi)) * (yj - yi));
        }
      }
    }
  }
  return values.sort((a, b) => a - b);
}

describe('buffer (point)', () => {
  const center: Coordinate = [139.6917, 35.6895];

  it('produces the same circle as generateCirclePolygon', () => {
    const result = buffer({ type: 'Point', coordinates: center }, 500);
    expect(result).not.toBeNull();
    const ring = (result as MultiPolygonCoordinates)[0][0];

    // Normalization can change the start point and the winding direction, so compare as sets
    const key = (coordinate: Coordinate): string =>
      `${coordinate[0].toFixed(9)},${coordinate[1].toFixed(9)}`;
    const expected = new Set(generateCirclePolygon(center, 500, 64).slice(0, -1).map(key));
    const actual = new Set(ring.map(key));

    expect(actual.size).toBe(64);
    for (const value of actual) {
      expect(expected.has(value)).toBe(true);
    }
  });

  it('puts every vertex at the given distance from the center', () => {
    const result = buffer({ type: 'Point', coordinates: center }, 500);
    for (const coordinate of (result as MultiPolygonCoordinates)[0][0]) {
      expect(haversineDistanceMeters(center, coordinate)).toBeCloseTo(500, 0);
    }
  });

  it('can change the number of segments with segments', () => {
    const result = buffer({ type: 'Point', coordinates: center }, 500, { segments: 8 });
    const ring = (result as MultiPolygonCoordinates)[0][0];
    const unique = new Set(ring.map((coordinate) => coordinate.join(',')));
    expect(unique.size).toBe(8);
  });

  it('returns null for a negative value and for 0', () => {
    expect(buffer({ type: 'Point', coordinates: center }, -100)).toBeNull();
    expect(buffer({ type: 'Point', coordinates: center }, 0)).toBeNull();
  });

  it('splits a MultiPoint into separate parts when the points are apart', () => {
    const result = buffer(
      {
        type: 'MultiPoint',
        coordinates: [
          [0, 0],
          [1, 1],
        ],
      },
      500,
    ) as MultiPolygonCoordinates;
    expect(result).toHaveLength(2);
  });
});

describe('buffer (line)', () => {
  it('makes the width almost 100 m in geodesic distance at 60 degrees north', () => {
    // A line running east-west. Going through a projection distorts the width at high latitudes
    const line: Coordinate[] = [
      [0, 60],
      [0.02, 60],
    ];
    const result = buffer(
      { type: 'LineString', coordinates: line },
      100,
    ) as MultiPolygonCoordinates;
    expect(result).toHaveLength(1);

    const midLng = 0.01;
    const crossings = latitudeCrossings(result, midLng);
    expect(crossings).toHaveLength(2);

    const south = haversineDistanceMeters([midLng, 60], [midLng, crossings[0]]);
    const north = haversineDistanceMeters([midLng, 60], [midLng, crossings[1]]);
    expect(Math.abs(north - 100) / 100).toBeLessThan(0.02);
    expect(Math.abs(south - 100) / 100).toBeLessThan(0.02);
  });

  it('makes the width almost 100 m in geodesic distance even for a north-south line at 60 degrees north', () => {
    const line: Coordinate[] = [
      [0, 60],
      [0, 60.02],
    ];
    const result = buffer(
      { type: 'LineString', coordinates: line },
      100,
    ) as MultiPolygonCoordinates;
    const midLat = 60.01;

    // Measure the east-west spread at the central latitude
    const ring = result[0][0];
    let minLng = Number.POSITIVE_INFINITY;
    let maxLng = Number.NEGATIVE_INFINITY;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if (yi > midLat !== yj > midLat) {
        const lng = xi + ((midLat - yi) / (yj - yi)) * (xj - xi);
        minLng = Math.min(minLng, lng);
        maxLng = Math.max(maxLng, lng);
      }
    }

    const west = haversineDistanceMeters([0, midLat], [minLng, midLat]);
    const east = haversineDistanceMeters([0, midLat], [maxLng, midLat]);
    expect(Math.abs(west - 100) / 100).toBeLessThan(0.02);
    expect(Math.abs(east - 100) / 100).toBeLessThan(0.02);
  });

  it('rounds the ends of the line and fuses the vertex circles and the edge bands into one', () => {
    const result = buffer(
      {
        type: 'LineString',
        coordinates: [
          [0, 0],
          [0.01, 0],
          [0.01, 0.01],
        ],
      },
      200,
    ) as MultiPolygonCoordinates;
    expect(result).toHaveLength(1);
    expect(result[0]).toHaveLength(1);
    expect(pointInPolygon([0.01, 0], result)).toBe(true);
  });

  it('can handle a MultiLineString as a whole', () => {
    const result = buffer(
      {
        type: 'MultiLineString',
        coordinates: [
          [
            [0, 0],
            [0.01, 0],
          ],
          [
            [1, 1],
            [1.01, 1],
          ],
        ],
      },
      100,
    ) as MultiPolygonCoordinates;
    expect(result).toHaveLength(2);
  });

  it('returns null for a negative value', () => {
    expect(
      buffer(
        {
          type: 'LineString',
          coordinates: [
            [0, 0],
            [1, 0],
          ],
        },
        -100,
      ),
    ).toBeNull();
  });
});

describe('buffer (polygon)', () => {
  it('expands the polygon for a positive value', () => {
    const polygon = rectPolygon(0, 0, 0.01, 0.01);
    const result = buffer(
      { type: 'Polygon', coordinates: polygon },
      100,
    ) as MultiPolygonCoordinates;
    expect(sphericalArea(result)).toBeGreaterThan(sphericalArea(polygon));
    expect(pointInPolygon([-0.0005, 0.005], result)).toBe(true);
  });

  it('shrinks the polygon for a negative value', () => {
    // Shrinking a roughly 1112 m square rectangle by 100 m leaves a roughly 912 m square
    const polygon = rectPolygon(0, 0, 0.01, 0.01);
    const result = buffer(
      { type: 'Polygon', coordinates: polygon },
      -100,
    ) as MultiPolygonCoordinates;
    expect(result).toHaveLength(1);

    const side = 0.01 * 111194.93;
    const expected = (side - 200) * (side - 200);
    expect(Math.abs(sphericalArea(result) - expected) / expected).toBeLessThan(0.02);
  });

  it('makes parts narrower than 2|d| disappear for a negative value', () => {
    // A band about 55.6 m high shrunk by 50 m is not wide enough and disappears
    const polygon = rectPolygon(0, 0, 0.01, 0.0005);
    const result = buffer({ type: 'Polygon', coordinates: polygon }, -50);
    expect(result).toEqual([]);
  });

  it('also applies the shrinking to the inner ring of a hole', () => {
    const withHole: PolygonCoordinates = [rect(0, 0, 0.02, 0.02), rect(0.008, 0.008, 0.012, 0.012)];
    const shrunk = buffer(
      { type: 'Polygon', coordinates: withHole },
      -100,
    ) as MultiPolygonCoordinates;
    expect(shrunk).toHaveLength(1);
    // The hole expands, so a point that was on the edge of the original hole ends up outside
    expect(pointInPolygon([0.0079, 0.01], shrunk)).toBe(false);
  });

  it('returns the normalized polygon as it is for 0', () => {
    const polygon = rectPolygon(0, 0, 0.01, 0.01);
    const result = buffer({ type: 'Polygon', coordinates: polygon }, 0) as MultiPolygonCoordinates;
    expect(result).toHaveLength(1);
    expect(sphericalArea(result) / sphericalArea(polygon)).toBeCloseTo(1, 6);
  });

  it('expands each part of a MultiPolygon and fuses them', () => {
    const multi: MultiPolygonCoordinates = [
      rectPolygon(0, 0, 0.001, 0.001),
      rectPolygon(0.002, 0, 0.003, 0.001),
    ];
    const result = buffer(
      { type: 'MultiPolygon', coordinates: multi },
      200,
    ) as MultiPolygonCoordinates;
    expect(result).toHaveLength(1);
  });
});

describe('buffer (common)', () => {
  it('returns null for a non-finite distance', () => {
    expect(buffer({ type: 'Point', coordinates: [0, 0] }, Number.NaN)).toBeNull();
    expect(buffer({ type: 'Point', coordinates: [0, 0] }, Number.POSITIVE_INFINITY)).toBeNull();
  });

  it('produces the same output for the same input', () => {
    const line: Coordinate[] = [
      [0, 0],
      [0.01, 0.01],
    ];
    const first = buffer({ type: 'LineString', coordinates: [...line] }, 150);
    const second = buffer({ type: 'LineString', coordinates: [...line] }, 150);
    expect(first).toEqual(second);
  });
});
