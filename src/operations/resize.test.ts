// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for the resize operation
 *
 * startResize captures the initial state (coordinates / scale / radius), and
 * computeResize computes the new coordinates for a handle drag. They verify the
 * axis scaling of a polygon, the radius scaling of a Circle, the change of scale for
 * a feature with a scale property, and the clamping of the minimum scale. The scaling happens
 * in Web Mercator, so a latitude is scaled through the Mercator y of the anchor; the helpers
 * below state that with the textbook formula.
 */

import { describe, expect, it } from 'vitest';
import { coordinatesOf } from '../shared/utils/coordinates.js';
import type { Feature } from '../store/types.js';
import type { BoundingBoxCoords } from '../view/ui/selection-ui/index.js';
import { computeResize, startResize } from './resize.js';

/** The Mercator y of a latitude (radians of the sphere, north up) */
function mercatorY(lat: number): number {
  return Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
}

/** Scales a latitude by s about an anchor latitude in Web Mercator */
function scaleLat(lat: number, anchorLat: number, s: number): number {
  const y = mercatorY(anchorLat) + (mercatorY(lat) - mercatorY(anchorLat)) * s;
  return ((2 * Math.atan(Math.exp(y)) - Math.PI / 2) * 180) / Math.PI;
}

/** Compares nested coordinates to 9 decimal places */
function expectCoordinatesClose(actual: unknown, expected: unknown): void {
  if (typeof expected === 'number') {
    expect(actual as number).toBeCloseTo(expected, 9);
    return;
  }
  const list = expected as unknown[];
  expect(Array.isArray(actual)).toBe(true);
  expect((actual as unknown[]).length).toBe(list.length);
  list.forEach((item, i) => {
    expectCoordinatesClose((actual as unknown[])[i], item);
  });
}

// A square bbox of 0,0 - 10,10 (following the convention topLeft=[minX,maxY] ...)
const bbox: BoundingBoxCoords = {
  topLeft: [0, 10],
  topRight: [10, 10],
  bottomLeft: [0, 0],
  bottomRight: [10, 0],
  center: [5, 5],
};

function polygon(): Feature {
  return {
    id: 'poly',
    type: 'Polygon',
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          [0, 0],
          [10, 0],
          [10, 10],
          [0, 10],
        ],
      ],
    },
    layerId: 'l1',
    groupId: undefined,
    properties: {},
    locked: false,
    visible: true,
    style: {},
  };
}

describe('startResize', () => {
  it('captures the coordinates as a deep copy, so changing the original feature has no effect', () => {
    const poly = polygon();
    const state = startResize('resize-se', { lng: 10, lat: 0 }, bbox, [poly]);
    // Destroy the coordinates of the original feature
    (coordinatesOf(poly) as number[][][])[0][0][0] = 999;
    const captured = state.initialCoordinates.get('poly') as number[][][];
    expect(captured[0][0][0]).toBe(0);
  });

  it('captures the initial radius for a Circle', () => {
    const circle: Feature = {
      id: 'c',
      type: 'Circle',
      geometry: { type: 'Point', coordinates: [5, 5] },
      layerId: 'l1',
      groupId: undefined,
      properties: { 'maplibre-gl-draw:radiusMeters': 100 },
      locked: false,
      visible: true,
      style: {},
    };
    const state = startResize('resize-se', { lng: 10, lat: 0 }, bbox, [circle]);
    expect(state.initialRadiusMeters.get('c')).toBe(100);
  });
});

describe('computeResize on a Polygon (axis scaling)', () => {
  it('doubles the coordinates with topLeft fixed when the se handle is dragged to double the size', () => {
    const poly = polygon();
    const state = startResize('resize-se', { lng: 10, lat: 0 }, bbox, [poly]);
    // Move the se handle ([10,0]) to [20,-10] -> both the width and the height double
    const result = computeResize(state, { lng: 20, lat: -10 }, [poly]);
    const coords = result.get('poly')?.coordinates as number[][][];
    // anchor=topLeft[0,10], scaleX=scaleY=2 → [x,y] -> [x*2, 10+(y-10)*2]
    expectCoordinatesClose(coords[0], [
      [0, -10],
      [20, -10],
      [20, 10],
      [0, 10],
    ]);
  });

  it('clamps at the minimum scale of 0.1 even when shrunk too far', () => {
    const poly = polygon();
    const state = startResize('resize-se', { lng: 10, lat: 0 }, bbox, [poly]);
    // Move the se handle far inwards (in the negative direction) -> the scale is clamped to 0.1
    const result = computeResize(state, { lng: -100, lat: 100 }, [poly]);
    const coords = result.get('poly')?.coordinates as number[][][];
    // 0.1 times with topLeft [0,10] fixed: [0,0] -> [0, about 9], [10,0] -> [1, about 9]
    const lat = scaleLat(0, 10, 0.1);
    expectCoordinatesClose(coords[0], [
      [0, lat],
      [1, lat],
      [1, 10],
      [0, 10],
    ]);
  });
});

describe('computeResize on a Circle (radius scaling)', () => {
  it('enlarges the radius according to uniformScale', () => {
    const circle: Feature = {
      id: 'c',
      type: 'Circle',
      geometry: { type: 'Point', coordinates: [0, 10] },
      layerId: 'l1',
      groupId: undefined,
      properties: { 'maplibre-gl-draw:radiusMeters': 100 },
      locked: false,
      visible: true,
      style: {},
    };
    // anchor=topLeft[0,10]. startLngLat is the se corner [10,0], and current is twice as far away.
    const state = startResize('resize-se', { lng: 10, lat: 0 }, bbox, [circle]);
    const result = computeResize(state, { lng: 20, lat: -10 }, [circle]);
    const r = result.get('c');
    // The distance is about 2 times -> the radius is about 2 times as well (there is a
    // latitude correction, so this is checked as a range rather than an exact match)
    expect(r?.radiusMeters).toBeGreaterThan(150);
    expect(r?.radiusMeters).toBeLessThan(260);
  });
});

describe('computeResize on the Multi variants (preservation of the part structure)', () => {
  it('transforms every part and every ring of a MultiPolygon and keeps the nested structure', () => {
    // Part 1: a square with a hole, part 2: an exclave
    const multiPolygon: Feature = {
      id: 'mpoly',
      type: 'MultiPolygon',
      geometry: {
        type: 'MultiPolygon',
        coordinates: [
          [
            [
              [0, 0],
              [10, 0],
              [10, 10],
              [0, 10],
            ],
            [
              [2, 2],
              [4, 2],
              [4, 4],
            ],
          ],
          [
            [
              [20, 0],
              [30, 0],
              [30, 10],
            ],
          ],
        ],
      },
      layerId: 'l1',
      groupId: undefined,
      properties: {},
      locked: false,
      visible: true,
      style: {},
    };

    const state = startResize('resize-se', { lng: 10, lat: 0 }, bbox, [multiPolygon]);
    // Move the se handle ([10,0]) to [20,-10] -> both the width and the height double,
    // anchor=topLeft[0,10]
    const result = computeResize(state, { lng: 20, lat: -10 }, [multiPolygon]);
    const coords = result.get('mpoly')?.coordinates as number[][][][];

    // [x,y] -> [x*2, the latitude scaled by 2 about 10 in Mercator]
    const lat2 = scaleLat(2, 10, 2);
    const lat4 = scaleLat(4, 10, 2);
    expectCoordinatesClose(coords, [
      [
        [
          [0, -10],
          [20, -10],
          [20, 10],
          [0, 10],
        ],
        [
          [4, lat2],
          [8, lat2],
          [8, lat4],
        ],
      ],
      [
        [
          [40, -10],
          [60, -10],
          [60, 10],
        ],
      ],
    ]);
  });

  it('also transforms MultiPoint / MultiLineString while keeping the nesting depth', () => {
    const multiPoint: Feature = {
      id: 'mp',
      type: 'MultiPoint',
      geometry: {
        type: 'MultiPoint',
        coordinates: [
          [0, 0],
          [10, 10],
        ],
      },
      layerId: 'l1',
      groupId: undefined,
      properties: {},
      locked: false,
      visible: true,
      style: {},
    };
    const multiLine: Feature = {
      id: 'ml',
      type: 'MultiLineString',
      geometry: {
        type: 'MultiLineString',
        coordinates: [
          [
            [0, 0],
            [10, 0],
          ],
          [
            [0, 10],
            [10, 10],
          ],
        ],
      },
      layerId: 'l1',
      groupId: undefined,
      properties: {},
      locked: false,
      visible: true,
      style: {},
    };

    const features = [multiPoint, multiLine];
    const state = startResize('resize-se', { lng: 10, lat: 0 }, bbox, features);
    const result = computeResize(state, { lng: 20, lat: -10 }, features);

    expectCoordinatesClose(result.get('mp')?.coordinates, [
      [0, -10],
      [20, 10],
    ]);
    expectCoordinatesClose(result.get('ml')?.coordinates, [
      [
        [0, -10],
        [20, -10],
      ],
      [
        [0, 10],
        [20, 10],
      ],
    ]);
  });
});

describe('computeResize: the minimum extent and the plane', () => {
  /** A bbox 0.00005 degrees (about 5.6 m) wide and tall at latitude 35 */
  const smallBox: BoundingBoxCoords = {
    topLeft: [139, 35.00005],
    topRight: [139.00005, 35.00005],
    bottomLeft: [139, 35],
    bottomRight: [139.00005, 35],
    center: [139.000025, 35.000025],
  };

  function smallPolygon(): Feature {
    return {
      id: 'small',
      type: 'Polygon',
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [139, 35],
            [139.00005, 35],
            [139.00005, 35.00005],
            [139, 35.00005],
          ],
        ],
      },
      layerId: 'l1',
      groupId: undefined,
      properties: {},
      locked: false,
      visible: true,
      style: {},
    };
  }

  it('stretches a box smaller than 0.0001 degrees along one axis', () => {
    const poly = smallPolygon();
    // The e handle; 1 pixel at zoom 22 with 512 pixel tiles
    const minAxisExtent = 1 / (512 * 2 ** 22);
    const state = startResize(
      'resize-e',
      { lng: 139.00005, lat: 35.000025 },
      smallBox,
      [poly],
      undefined,
      minAxisExtent,
    );
    const result = computeResize(state, { lng: 139.0001, lat: 35.000025 }, [poly]);
    const coords = result.get('small')?.coordinates as number[][][];
    // The width doubles and the height stays
    expect(coords[0][1][0]).toBeCloseTo(139.0001, 9);
    expect(coords[0][2][1]).toBeCloseTo(35.00005, 9);
  });

  it('leaves an axis thinner than the minimum extent alone', () => {
    const poly = smallPolygon();
    // 1 pixel at zoom 10 is far wider than the box
    const minAxisExtent = 1 / (512 * 2 ** 10);
    const state = startResize(
      'resize-e',
      { lng: 139.00005, lat: 35.000025 },
      smallBox,
      [poly],
      undefined,
      minAxisExtent,
    );
    const result = computeResize(state, { lng: 139.0001, lat: 35.000025 }, [poly]);
    const coords = result.get('small')?.coordinates as number[][][];
    expect(coords[0][1][0]).toBeCloseTo(139.00005, 9);
  });

  it('computes at a latitude of 90 degrees without producing NaN', () => {
    const poly = polygon();
    const state = startResize('resize-se', { lng: 10, lat: 0 }, bbox, [poly]);
    const result = computeResize(state, { lng: 20, lat: 90 }, [poly]);
    const coords = result.get('poly')?.coordinates as number[][][];
    for (const [lng, lat] of coords[0]) {
      expect(Number.isFinite(lng)).toBe(true);
      expect(Number.isFinite(lat)).toBe(true);
    }
  });
});
