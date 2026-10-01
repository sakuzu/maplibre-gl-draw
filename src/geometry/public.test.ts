// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for the public functions of the subpath entry
 *
 * The computations underneath have their own tests; these check the GeoJSON input and output,
 * the units, the new functions (midpoint, along, nearestPointOnLine, perimeter) and the
 * tolerance in meters of simplify.
 */

import type { Feature, LineString, MultiPolygon, Polygon, Position } from 'geojson';
import { describe, expect, it } from 'vitest';
import type { Feature as DrawnFeature } from '../api/model.js';
import {
  along,
  area,
  bbox,
  bboxContains,
  bboxIntersects,
  bearing,
  buffer,
  centroid,
  circle,
  contains,
  destination,
  difference,
  distance,
  EARTH_RADIUS_METERS,
  GeometryError,
  intersection,
  length,
  makeValid,
  metersToDegrees,
  midpoint,
  nearestPointOnLine,
  overlaps,
  perimeter,
  pointInPolygon,
  pointOnSurface,
  rewind,
  simplify,
  split,
  union,
} from './index.js';
import { sphericalArea } from './measure.js';
import { signedRingArea } from './simplify.js';

const square: Polygon = {
  type: 'Polygon',
  coordinates: [
    [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
      [0, 0],
    ],
  ],
};

const shifted: Polygon = {
  type: 'Polygon',
  coordinates: [
    [
      [0.5, 0],
      [1.5, 0],
      [1.5, 1],
      [0.5, 1],
      [0.5, 0],
    ],
  ],
};

function feature<G extends Feature['geometry']>(geometry: G): Feature<G> {
  return { type: 'Feature', geometry, properties: {} };
}

function line(coordinates: Position[]): LineString {
  return { type: 'LineString', coordinates };
}

function expectPosition(actual: Position, expected: Position, digits = 9): void {
  expect(actual[0]).toBeCloseTo(expected[0], digits);
  expect(actual[1]).toBeCloseTo(expected[1], digits);
}

describe('distance, bearing and destination', () => {
  it('measure between positions and Points alike', () => {
    const tokyo: Position = [139.767, 35.681];
    const osaka: Position = [135.495, 34.702];
    expect(distance(tokyo, osaka)).toBeCloseTo(403_139, -2);
    expect(distance({ type: 'Point', coordinates: tokyo }, osaka)).toBe(distance(tokyo, osaka));
    expect(bearing([0, 0], [1, 0])).toBeCloseTo(90, 12);
    expect(bearing([0, 0], { type: 'Point', coordinates: [0, 1] })).toBe(0);
  });

  it('destination is the inverse of distance and bearing', () => {
    const origin: Position = [139.767, 35.681];
    const reached = destination(origin, 1000, 90);
    expect(distance(origin, reached)).toBeCloseTo(1000, 6);
    expect(bearing(origin, reached)).toBeCloseTo(90, 6);
  });
});

describe('midpoint', () => {
  it('lies halfway along the great circle', () => {
    const cases: [Position, Position][] = [
      [
        [0, 0],
        [10, 0],
      ],
      [
        [139.767, 35.681],
        [135.495, 34.702],
      ],
      [
        [-20, -40],
        [30, 50],
      ],
    ];
    for (const [from, to] of cases) {
      const middle = midpoint(from, to);
      const whole = distance(from, to);
      expect(distance(from, middle)).toBeCloseTo(whole / 2, 5);
      expect(distance(middle, to)).toBeCloseTo(whole / 2, 5);
    }
  });

  it('bends toward the pole between two points on a parallel', () => {
    expectPosition(midpoint([0, 0], [10, 0]), [5, 0]);
    const middle = midpoint([0, 60], { type: 'Point', coordinates: [90, 60] });
    expect(middle[0]).toBeCloseTo(45, 9);
    expect(middle[1]).toBeCloseTo(67.7923, 3);
  });

  it('continues the longitude of the first point across the antimeridian', () => {
    const middle = midpoint([179, 0], [-179, 0]);
    expect(middle[0]).toBeCloseTo(180, 9);
  });
});

describe('along', () => {
  const path = line([
    [0, 0],
    [1, 0],
    [1, 1],
  ]);
  const first = distance([0, 0], [1, 0]);
  const second = distance([1, 0], [1, 1]);

  it('returns the point at a distance from the start', () => {
    const point = along(path, 1000);
    expect(distance([0, 0], point)).toBeCloseTo(1000, 6);
    expect(point[1]).toBeCloseTo(0, 12);
    expectPosition(along(path, first), [1, 0]);
    expectPosition(along(feature(path), first + second / 2), [1, 0.5], 6);
  });

  it('clamps to the start and to the end', () => {
    expect(along(path, 0)).toEqual([0, 0]);
    expect(along(path, -5)).toEqual([0, 0]);
    expect(along(path, first + second + 1)).toEqual([1, 1]);
    expect(along(line([[3, 4]]), 100)).toEqual([3, 4]);
  });

  it('rejects a line without positions and a distance that is not finite', () => {
    expect(() => along(line([]), 1)).toThrow(GeometryError);
    expect(() => along(path, Number.NaN)).toThrow(GeometryError);
    expect(() => along(square as never, 1)).toThrow(GeometryError);
  });
});

describe('nearestPointOnLine', () => {
  it('drops a perpendicular onto a segment', () => {
    const result = nearestPointOnLine(
      line([
        [0, 0],
        [2, 0],
      ]),
      [1, 1],
    );
    expectPosition(result.position, [1, 0]);
    expect(result.distanceMeters).toBeCloseTo(distance([1, 1], [1, 0]), 6);
    expect(result.segmentIndex).toBe(0);
  });

  it('takes the nearer end when the perpendicular falls outside the segment', () => {
    const result = nearestPointOnLine(
      line([
        [0, 0],
        [2, 0],
      ]),
      { type: 'Point', coordinates: [3, 1] },
    );
    expect(result.position).toEqual([2, 0]);
    expect(result.distanceMeters).toBeCloseTo(distance([3, 1], [2, 0]), 6);
  });

  it('counts the segments across the lines of a MultiLineString', () => {
    const polyline = line([
      [0, 0],
      [1, 0],
      [1, 1],
    ]);
    expect(nearestPointOnLine(polyline, [1.5, 0.5]).segmentIndex).toBe(1);
    const multi = nearestPointOnLine(
      feature({
        type: 'MultiLineString',
        coordinates: [
          [
            [0, 0],
            [1, 0],
            [2, 0],
          ],
          [
            [0, 2],
            [1, 2],
          ],
        ],
      }),
      [0.5, 1.9],
    );
    expect(multi.segmentIndex).toBe(2);
    expect(multi.position[0]).toBeCloseTo(0.5, 6);
    expect(multi.position[1]).toBeCloseTo(2, 3);
  });

  it('finds no point nearer than the result along the segment', () => {
    const a: Position = [139.7, 35.6];
    const b: Position = [139.9, 35.75];
    const target: Position = [139.82, 35.62];
    const result = nearestPointOnLine(line([a, b]), target);
    const heading = bearing(a, b);
    const total = distance(a, b);
    for (let i = 0; i <= 200; i++) {
      const sample = destination(a, (total * i) / 200, heading);
      expect(distance(target, sample)).toBeGreaterThanOrEqual(result.distanceMeters - 1e-6);
    }
    expect(distance(target, result.position)).toBeCloseTo(result.distanceMeters, 9);
  });

  it('returns a point on the line itself at distance 0', () => {
    const on = destination([10, 20], 5000, 45);
    const result = nearestPointOnLine(line([[10, 20], destination([10, 20], 10_000, 45)]), on);
    expect(result.distanceMeters).toBeLessThan(1e-6);
  });

  it('rejects a line without positions', () => {
    expect(() => nearestPointOnLine(line([]), [0, 0])).toThrow(GeometryError);
  });
});

describe('length, area and perimeter', () => {
  it('length sums the great-circle distances of every line', () => {
    const path = line([
      [0, 0],
      [1, 0],
      [1, 1],
    ]);
    const expected = distance([0, 0], [1, 0]) + distance([1, 0], [1, 1]);
    expect(length(path)).toBeCloseTo(expected, 9);
    expect(length(feature(path))).toBeCloseTo(expected, 9);
    expect(
      length({
        type: 'MultiLineString',
        coordinates: [path.coordinates, path.coordinates],
      }),
    ).toBeCloseTo(2 * expected, 9);
    expect(length(line([[0, 0]]))).toBe(0);
  });

  it('area is the spherical area in square meters', () => {
    const expected = sphericalArea(square.coordinates as [number, number][][]);
    expect(area(square)).toBe(expected);
    expect(area(feature(square))).toBe(expected);
    expect(area(square)).toBeCloseTo(1.236e10, -8);
  });

  it('perimeter sums every ring, holes included, closing open rings', () => {
    const outer = square.coordinates[0];
    const ringLength = (ring: Position[]) => length(line(ring));
    expect(perimeter(square)).toBeCloseTo(ringLength(outer), 6);
    const open: Polygon = { type: 'Polygon', coordinates: [outer.slice(0, 4)] };
    expect(perimeter(open)).toBeCloseTo(ringLength(outer), 6);
    const hole: Position[] = [
      [0.25, 0.25],
      [0.25, 0.75],
      [0.75, 0.75],
      [0.75, 0.25],
      [0.25, 0.25],
    ];
    const withHole: Polygon = { type: 'Polygon', coordinates: [outer, hole] };
    expect(perimeter(feature(withHole))).toBeCloseTo(ringLength(outer) + ringLength(hole), 6);
    const multi: MultiPolygon = {
      type: 'MultiPolygon',
      coordinates: [square.coordinates, shifted.coordinates],
    };
    expect(perimeter(multi)).toBeCloseTo(perimeter(square) + perimeter(shifted), 6);
  });
});

describe('centroid and pointOnSurface', () => {
  it('return Points', () => {
    expect(centroid(square)).toEqual({ type: 'Point', coordinates: [0.5, 0.5] });
    expect(centroid({ type: 'Polygon', coordinates: [] })).toBeNull();
    const u: Polygon = {
      type: 'Polygon',
      coordinates: [
        [
          [0, 0],
          [3, 0],
          [3, 3],
          [2, 3],
          [2, 1],
          [1, 1],
          [1, 3],
          [0, 3],
          [0, 0],
        ],
      ],
    };
    const inside = pointOnSurface(feature(u));
    expect(inside?.type).toBe('Point');
    expect(pointInPolygon(inside as NonNullable<typeof inside>, u)).toBe(true);
  });
});

describe('circle', () => {
  it('returns a counter-clockwise Polygon whose vertices lie at the radius', () => {
    const center: Position = [139.767, 35.681];
    const polygon = circle(center, 500, { segments: 32 });
    expect(polygon.type).toBe('Polygon');
    const ring = polygon.coordinates[0];
    expect(ring).toHaveLength(33);
    expect(ring[0]).toEqual(ring[32]);
    expect(ring[0][0]).toBeCloseTo(center[0], 9);
    expect(ring[0][1]).toBeGreaterThan(center[1]);
    expect(signedRingArea(ring as [number, number][])).toBeGreaterThan(0);
    for (const vertex of ring) expect(distance(center, vertex)).toBeCloseTo(500, 6);
    expect(circle({ type: 'Point', coordinates: center }, 500).coordinates[0]).toHaveLength(65);
  });

  it('rejects a radius that is negative or not finite', () => {
    expect(() => circle([0, 0], -1)).toThrow(GeometryError);
    expect(() => circle([0, 0], Number.POSITIVE_INFINITY)).toThrow(GeometryError);
  });
});

describe('buffer', () => {
  it('builds a polygon around a point, a line and a polygon', () => {
    const disc = buffer({ type: 'Point', coordinates: [139.7, 35.6] }, 100);
    expect(disc?.type).toBe('Polygon');
    expect(area(disc as Polygon) / (Math.PI * 100 * 100)).toBeCloseTo(1, 2);
    const corridor = buffer(
      feature(
        line([
          [139.76, 35.68],
          [139.77, 35.69],
        ]),
      ),
      100,
      { segments: 16 },
    );
    expect(corridor?.type).toBe('Polygon');
    const grown = buffer(square, 1000);
    expect(area(grown as Polygon)).toBeGreaterThan(area(square));
  });

  it('returns null when nothing remains', () => {
    expect(buffer(square, -1_000_000)).toBeNull();
    expect(buffer({ type: 'Point', coordinates: [0, 0] }, -10)).toBeNull();
    expect(buffer({ type: 'Point', coordinates: [0, 0] }, 0)).toBeNull();
  });

  it('buffers each member of a collection and merges them', () => {
    const result = buffer(
      {
        type: 'GeometryCollection',
        geometries: [
          { type: 'Point', coordinates: [0, 0] },
          { type: 'Point', coordinates: [1, 1] },
        ],
      },
      100,
    );
    expect(result?.type).toBe('MultiPolygon');
    expect((result as MultiPolygon).coordinates).toHaveLength(2);
  });

  it('rejects a distance that is not finite', () => {
    expect(() => buffer(square, Number.NaN)).toThrow(GeometryError);
  });
});

describe('union, intersection, difference and split', () => {
  it('union merges an array of polygons', () => {
    expect(union([square, feature(shifted)])).toEqual({
      type: 'Polygon',
      coordinates: [
        [
          [0, 0],
          [1.5, 0],
          [1.5, 1],
          [0, 1],
          [0, 0],
        ],
      ],
    });
    const far: Polygon = {
      type: 'Polygon',
      coordinates: [
        [
          [5, 5],
          [6, 5],
          [6, 6],
          [5, 5],
        ],
      ],
    };
    expect(union([square, far])?.type).toBe('MultiPolygon');
    expect(union([])).toBeNull();
  });

  it('intersection keeps the common part', () => {
    expect(intersection([square, shifted])).toEqual({
      type: 'Polygon',
      coordinates: [
        [
          [0.5, 0],
          [1, 0],
          [1, 1],
          [0.5, 1],
          [0.5, 0],
        ],
      ],
    });
    const touching: Polygon = {
      type: 'Polygon',
      coordinates: [
        [
          [1, 0],
          [2, 0],
          [2, 1],
          [1, 1],
          [1, 0],
        ],
      ],
    };
    expect(intersection([square, touching])).toBeNull();
    expect(intersection([])).toBeNull();
  });

  it('difference removes the others from the subject', () => {
    expect(difference(square, [shifted])).toEqual({
      type: 'Polygon',
      coordinates: [
        [
          [0, 0],
          [0.5, 0],
          [0.5, 1],
          [0, 1],
          [0, 0],
        ],
      ],
    });
    expect(difference(shifted, [square, feature(shifted)])).toBeNull();
    expect(difference(square, [])).toEqual(makeValid(square));
  });

  it('split cuts a polygon into Polygons', () => {
    const pieces = split(
      square,
      feature(
        line([
          [0.5, -1],
          [0.5, 2],
        ]),
      ),
    );
    expect(pieces).toHaveLength(2);
    for (const piece of pieces) {
      expect(piece.type).toBe('Polygon');
      expect(area(piece)).toBeCloseTo(area(square) / 2, -6);
    }
    const uncut = split(
      square,
      line([
        [2, -1],
        [2, 2],
      ]),
    );
    expect(uncut).toHaveLength(1);
    expect(area(uncut[0])).toBeCloseTo(area(square), 0);
  });
});

describe('pointInPolygon, overlaps and contains', () => {
  it('pointInPolygon takes positions, Points and features', () => {
    expect(pointInPolygon([0.5, 0.5], square)).toBe(true);
    expect(pointInPolygon({ type: 'Point', coordinates: [2, 0.5] }, feature(square))).toBe(false);
  });

  it('overlaps needs a shared area', () => {
    expect(overlaps(square, shifted)).toBe(true);
    const touching: Polygon = {
      type: 'Polygon',
      coordinates: [
        [
          [1, 0],
          [2, 0],
          [2, 1],
          [1, 1],
          [1, 0],
        ],
      ],
    };
    expect(overlaps(square, touching)).toBe(false);
  });

  it('contains polygons, points and lines', () => {
    const small: Polygon = {
      type: 'Polygon',
      coordinates: [
        [
          [0.2, 0.2],
          [0.8, 0.2],
          [0.8, 0.8],
          [0.2, 0.2],
        ],
      ],
    };
    expect(contains(square, small)).toBe(true);
    expect(contains(square, shifted)).toBe(false);
    expect(contains(square, { type: 'Point', coordinates: [0.5, 0.5] })).toBe(true);
    expect(contains(square, { type: 'Point', coordinates: [1, 0.5] })).toBe(true);
    expect(contains(square, { type: 'Point', coordinates: [1.5, 0.5] })).toBe(false);
    expect(
      contains(
        square,
        line([
          [0.1, 0.1],
          [0.9, 0.9],
        ]),
      ),
    ).toBe(true);
    expect(
      contains(
        square,
        line([
          [0, 0],
          [1, 0],
        ]),
      ),
    ).toBe(true);
    expect(
      contains(
        square,
        feature(
          line([
            [0.5, 0.5],
            [1.5, 0.5],
          ]),
        ),
      ),
    ).toBe(false);
    expect(
      contains(square, {
        type: 'MultiPoint',
        coordinates: [
          [0.1, 0.1],
          [0.9, 0.9],
        ],
      }),
    ).toBe(true);
    expect(contains(square, { type: 'GeometryCollection', geometries: [] })).toBe(false);
  });

  it('does not contain a line that leaves through a gap or crosses a hole', () => {
    const u: Polygon = {
      type: 'Polygon',
      coordinates: [
        [
          [0, 0],
          [3, 0],
          [3, 3],
          [2, 3],
          [2, 1],
          [1, 1],
          [1, 3],
          [0, 3],
          [0, 0],
        ],
      ],
    };
    expect(
      contains(
        u,
        line([
          [0.5, 2],
          [2.5, 2],
        ]),
      ),
    ).toBe(false);
    expect(
      contains(
        u,
        line([
          [0.5, 0.5],
          [2.5, 0.5],
        ]),
      ),
    ).toBe(true);
    const withHole: Polygon = {
      type: 'Polygon',
      coordinates: [
        square.coordinates[0],
        [
          [0.4, 0.4],
          [0.4, 0.6],
          [0.6, 0.6],
          [0.6, 0.4],
          [0.4, 0.4],
        ],
      ],
    };
    expect(
      contains(
        withHole,
        line([
          [0.1, 0.5],
          [0.9, 0.5],
        ]),
      ),
    ).toBe(false);
  });
});

describe('makeValid and rewind', () => {
  it('makeValid resolves a bow tie and drops what has no area', () => {
    const bowTie: Polygon = {
      type: 'Polygon',
      coordinates: [
        [
          [0, 0],
          [1, 1],
          [1, 0],
          [0, 1],
          [0, 0],
        ],
      ],
    };
    const result = makeValid(bowTie);
    expect(result?.type).toBe('MultiPolygon');
    expect((result as MultiPolygon).coordinates).toHaveLength(2);
    expect(
      makeValid({
        type: 'Polygon',
        coordinates: [
          [
            [0, 0],
            [1, 0],
            [2, 0],
            [0, 0],
          ],
        ],
      }),
    ).toBeNull();
  });

  it('rewind orients the rings as RFC 7946 and keeps the type', () => {
    const clockwise: Polygon = {
      type: 'Polygon',
      coordinates: [[...square.coordinates[0]].reverse()],
    };
    const rewound = rewind(clockwise);
    expect(rewound.type).toBe('Polygon');
    expect(signedRingArea(rewound.coordinates[0] as [number, number][])).toBeGreaterThan(0);
    const multi = rewind(feature({ type: 'MultiPolygon', coordinates: [clockwise.coordinates] }));
    expect(multi.type).toBe('MultiPolygon');
    expect(
      signedRingArea((multi as MultiPolygon).coordinates[0][0] as [number, number][]),
    ).toBeGreaterThan(0);
  });
});

describe('simplify', () => {
  it('takes the tolerance in meters', () => {
    // The middle vertex lies about 1.1 m off the line
    const path = line([
      [0, 0],
      [0.001, 0.00001],
      [0.002, 0],
    ]);
    expect(simplify(path, 5).coordinates).toEqual([
      [0, 0],
      [0.002, 0],
    ]);
    expect(simplify(path, 0.5).coordinates).toHaveLength(3);
    expect(simplify(path, 0).coordinates).toEqual(path.coordinates);
  });

  it('measures an east-west offset in meters at the latitude of the geometry', () => {
    // At latitude 60 a degree of longitude is half as long as at the equator: the middle
    // vertex lies 3 m east of a line that runs north
    const offset = metersToDegrees(3, 60).lng;
    const path = line([
      [10, 59.999],
      [10 + offset, 60],
      [10, 60.001],
    ]);
    expect(simplify(path, 4).coordinates).toHaveLength(2);
    expect(simplify(path, 2).coordinates).toHaveLength(3);
  });

  it('keeps the type and the closure of polygons and returns new arrays', () => {
    const ring: Position[] = [
      [0, 0],
      [0.0005, 0.000001],
      [0.001, 0],
      [0.001, 0.001],
      [0, 0.001],
      [0, 0],
    ];
    const polygon: Polygon = { type: 'Polygon', coordinates: [ring] };
    const simplified = simplify(feature(polygon), 10);
    expect(simplified.type).toBe('Polygon');
    expect(simplified.coordinates[0]).toEqual([
      [0, 0],
      [0.001, 0],
      [0.001, 0.001],
      [0, 0.001],
      [0, 0],
    ]);
    expect(simplified.coordinates[0][0]).not.toBe(ring[0]);
    const multi = simplify({ type: 'MultiPolygon', coordinates: [[ring]] }, 10);
    expect(multi.type).toBe('MultiPolygon');
    expect(multi.coordinates[0][0]).toHaveLength(5);
  });

  it('rejects other geometries and a tolerance that is not finite', () => {
    expect(() => simplify({ type: 'Point', coordinates: [0, 0] } as never, 1)).toThrow(
      GeometryError,
    );
    expect(() => simplify(square, Number.POSITIVE_INFINITY)).toThrow(GeometryError);
  });
});

describe('bbox and metersToDegrees', () => {
  it('bbox spans every position of any geometry', () => {
    expect(
      bbox(
        line([
          [139.7, 35.6],
          [139.8, 35.7],
        ]),
      ),
    ).toEqual([139.7, 35.6, 139.8, 35.7]);
    expect(bbox(feature(square))).toEqual([0, 0, 1, 1]);
    expect(
      bbox({
        type: 'GeometryCollection',
        geometries: [
          { type: 'Point', coordinates: [-1, 2] },
          { type: 'Point', coordinates: [3, -4] },
        ],
      }),
    ).toEqual([-1, -4, 3, 2]);
  });

  it('bbox throws for a geometry without a position', () => {
    try {
      bbox({ type: 'LineString', coordinates: [] });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(GeometryError);
      expect((error as GeometryError).code).toBe('invalid-input');
      expect((error as GeometryError).operation).toBe('bbox');
    }
  });

  it('metersToDegrees agrees with distance', () => {
    const { lng, lat } = metersToDegrees(1000, 60);
    expect(lat).toBeCloseTo(((1000 / EARTH_RADIUS_METERS) * 180) / Math.PI, 15);
    expect(lng).toBeCloseTo(2 * lat, 12);
    expect(distance([0, 0], [0, lat])).toBeCloseTo(1000, 6);
  });

  it('bboxIntersects and bboxContains compare boxes', () => {
    expect(bboxIntersects([0, 0, 1, 1], [1, 1, 2, 2])).toBe(true);
    expect(bboxIntersects([0, 0, 1, 1], [1.1, 0, 2, 1])).toBe(false);
    expect(bboxContains([0, 0, 2, 2], [0, 0, 1, 1])).toBe(true);
    expect(bboxContains([0, 0, 1, 1], [0, 0, 2, 1])).toBe(false);
  });
});

describe('inputs that carry a geometry', () => {
  /**
   * A feature as the drawing returns it: a `geometry` field, and a `type` that names the type
   * of the feature (the type of its geometry by default), not a GeoJSON `Feature`
   */
  function drawn(
    id: string,
    geometry: DrawnFeature['geometry'],
    type: DrawnFeature['type'] = geometry.type,
  ): DrawnFeature {
    return {
      id,
      type,
      geometry,
      layerId: 'layer',
      groupId: undefined,
      properties: {},
      style: {},
      visible: true,
      locked: false,
    };
  }

  it('takes the features of the drawing as they are', () => {
    const merged = union([drawn('a', square), drawn('b', shifted)]);
    expect(merged && area(merged)).toBeCloseTo(area(union([square, shifted]) as Polygon), 3);
    expect(area(drawn('a', square))).toBeCloseTo(area(square), 6);
    expect(bbox(drawn('a', square))).toEqual([0, 0, 1, 1]);
    expect(
      length(
        drawn(
          'l',
          line([
            [0, 0],
            [1, 0],
          ]),
        ),
      ),
    ).toBeCloseTo(distance([0, 0], [1, 0]), 6);
    expect(simplify(drawn('a', square), 1)).toEqual(simplify(square, 1));
    expect(contains(drawn('a', square), drawn('b', square))).toBe(true);
  });

  it('reads a drawing feature whose type is Polygon as a feature, not as a geometry', () => {
    const polygon = drawn('a', square, 'Polygon');
    expect(area(polygon)).toBeCloseTo(area(square), 6);
    expect(perimeter(polygon)).toBeCloseTo(perimeter(square), 6);
    expect(centroid(polygon)).toEqual(centroid(square));
    expect(pointOnSurface(polygon)).toEqual(pointOnSurface(square));
    expect(pointInPolygon([0.5, 0.5], polygon)).toBe(true);
    expect(overlaps(polygon, drawn('b', shifted, 'Polygon'))).toBe(true);
    expect(contains(polygon, drawn('p', { type: 'Point', coordinates: [0.5, 0.5] }))).toBe(true);
    expect(makeValid(polygon)).toEqual(makeValid(square));
    expect(rewind(polygon)).toEqual(rewind(square));
    expect(simplify(polygon, 1)).toEqual(simplify(square, 1));
    expect(buffer(polygon, 10)).toEqual(buffer(square, 10));
    expect(bbox(polygon)).toEqual([0, 0, 1, 1]);
    expect(union([polygon, drawn('b', shifted, 'Polygon')])).toEqual(union([square, shifted]));
    expect(intersection([polygon, drawn('b', shifted, 'Polygon')])).toEqual(
      intersection([square, shifted]),
    );
    expect(difference(polygon, [drawn('b', shifted, 'Polygon')])).toEqual(
      difference(square, [shifted]),
    );
    const cut = line([
      [0.5, -1],
      [0.5, 2],
    ]);
    expect(split(polygon, drawn('l', cut, 'LineString'))).toEqual(split(square, cut));
  });

  it('reads a drawing feature whose type is LineString as a feature', () => {
    const path = line([
      [0, 0],
      [1, 0],
    ]);
    const feature = drawn('l', path, 'LineString');
    expect(length(feature)).toBeCloseTo(length(path), 9);
    expect(along(feature, 1000)).toEqual(along(path, 1000));
    expect(nearestPointOnLine(feature, [0.5, 1])).toEqual(nearestPointOnLine(path, [0.5, 1]));
  });

  it('reads a drawing Circle feature by its Polygon geometry', () => {
    const ring = circle([0, 0], 1000);
    const feature = drawn('c', ring, 'Circle');
    expect(area(feature)).toBeCloseTo(area(ring), 6);
    expect(perimeter(feature)).toBeCloseTo(perimeter(ring), 6);
    expect(bbox(feature)).toEqual(bbox(ring));
  });

  it('reads a drawing Freehand feature by its geometry', () => {
    const feature = drawn('f', square, 'Freehand');
    expect(area(feature)).toBeCloseTo(area(square), 6);
  });

  it('reads a GeoJSON Feature and a bare geometry', () => {
    expect(area(feature(square))).toBeCloseTo(area(square), 6);
    expect(area(square)).toBeGreaterThan(0);
    const plain: Feature<Polygon> = { type: 'Feature', geometry: square, properties: null };
    expect(bbox(plain)).toEqual([0, 0, 1, 1]);
  });

  it('rejects a feature-like object whose geometry is missing or not a geometry', () => {
    const inputs = [
      { id: 'a', type: 'Polygon' },
      { id: 'a', type: 'Polygon', geometry: null },
      { id: 'a', type: 'Circle', geometry: { type: 'Circle' } },
      { type: 'Feature', geometry: null, properties: {} },
      { type: 'Feature', properties: {} },
      { type: 'Polygon' },
    ];
    for (const input of inputs) {
      expect(() => area(input as unknown as Polygon)).toThrow(GeometryError);
    }
  });

  it('takes any object with a geometry field', () => {
    expect(area({ geometry: square })).toBeCloseTo(area(square), 6);
    expect(buffer({ geometry: square }, 10)).not.toBeNull();
  });

  it('rejects an object whose geometry field is not a geometry', () => {
    for (const input of [{ geometry: null }, { geometry: { type: 'Feature' } }, { id: 'x' }]) {
      try {
        area(input as unknown as Polygon);
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(GeometryError);
        expect((error as GeometryError).code).toBe('invalid-input');
      }
    }
  });
});
