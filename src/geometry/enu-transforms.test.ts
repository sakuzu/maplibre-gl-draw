// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The computation of the edits that move, rotate and scale features of a Store that gives none
 *
 * - A move takes the point `from` to the point `to`
 * - Twelve rotations of 30 degrees bring the positions back
 * - An edit that does nothing gives the values back, bit for bit
 * - A latitude past the one of Mercator (85.0511287798066) is kept, and a point at a pole is
 *   computed
 * - The longitudes of a feature that crosses the meridian of 180 degrees are brought together,
 *   the first one within [-180, 180]
 * - The numbers past the longitude and the latitude are kept
 * - The fields of the roles: an angle within [0, 360), a size multiplied, the values they start
 *   from, and a feature that keeps its shape moved by the factor of the size
 * - The values taken: the ends of the ranges
 */

import type { Geometry, LineString, Point, Polygon } from 'geojson';
import { describe, expect, it } from 'vitest';
import {
  acceptsEnuEdit,
  applyEnuEdit,
  type EnuEdit,
  type EnuValues,
  enuEditTurn,
} from './enu-transforms.js';

/** The tolerance of a position that comes back, in degrees (about 0.1 mm) */
const TOLERANCE = 1e-9;

function point(lon: number, lat: number): Point {
  return { type: 'Point', coordinates: [lon, lat] };
}

function coordinatesOf(geometry: Geometry): number[] {
  return (geometry as Point).coordinates as number[];
}

/** Positions spread over 0.2 degrees around Tokyo */
function tokyoLine(): LineString {
  const coordinates: number[][] = [];
  for (let i = 0; i < 20; i++) {
    coordinates.push([139.6 + ((i * 37) % 20) / 100, 35.6 + ((i * 11) % 20) / 100]);
  }
  return { type: 'LineString', coordinates };
}

describe('the computation of the library', () => {
  it('takes the point from to the point to', () => {
    const cases: Array<[[number, number], [number, number]]> = [
      [
        [139.7, 35.68],
        [141.35, 43.06],
      ],
      [
        [139.7, 35.68],
        [139.75, 35.73],
      ],
      [
        [-73.98, 40.75],
        [2.35, 48.85],
      ],
      [
        [0, -60],
        [170, 70],
      ],
    ];
    for (const [from, to] of cases) {
      const edit: EnuEdit = { kind: 'translate', from, to };
      const moved = coordinatesOf(applyEnuEdit(edit, { geometry: point(...from) }).geometry);
      expect(Math.abs((moved[0] as number) - to[0])).toBeLessThan(TOLERANCE);
      expect(Math.abs((moved[1] as number) - to[1])).toBeLessThan(TOLERANCE);
    }
  });

  it('brings the positions back after twelve rotations of 30 degrees', () => {
    const line = tokyoLine();
    const edit: EnuEdit = { kind: 'rotate', center: [139.71, 35.69], angleDegrees: 30 };
    let values: EnuValues = { geometry: line, angleDegrees: 15 };
    for (let i = 0; i < 12; i++) values = applyEnuEdit(edit, values);
    const back = (values.geometry as LineString).coordinates;
    line.coordinates.forEach((position, i) => {
      expect(Math.abs((back[i]?.[0] as number) - (position[0] as number))).toBeLessThan(TOLERANCE);
      expect(Math.abs((back[i]?.[1] as number) - (position[1] as number))).toBeLessThan(TOLERANCE);
    });
    expect(values.angleDegrees).toBeCloseTo(15, 9);
  });

  it('gives the values back as they are for an edit that does nothing', () => {
    const values: EnuValues = {
      geometry: tokyoLine(),
      angleDegrees: 370,
      size: 2,
      uniformScale: true,
    };
    const edits: EnuEdit[] = [
      { kind: 'translate', from: [139.7, 35.6], to: [139.7, 35.6] },
      { kind: 'rotate', center: [139.7, 35.6], angleDegrees: 0 },
      { kind: 'scale', center: [139.7, 35.6], eastFactor: 1, northFactor: 1, sizeFactor: 1 },
    ];
    for (const edit of edits) expect(applyEnuEdit(edit, values)).toBe(values);
  });

  it('tells what an edit does to an angle and a size as it writes them', () => {
    const center: [number, number] = [139.7, 35.6];
    const edits: EnuEdit[] = [
      { kind: 'translate', from: center, to: [139.8, 35.6] },
      { kind: 'rotate', center, angleDegrees: 30 },
      { kind: 'rotate', center, angleDegrees: 0 },
      { kind: 'scale', center, eastFactor: 2, northFactor: 3, sizeFactor: 2.5 },
      { kind: 'scale', center, eastFactor: 1, northFactor: 1, sizeFactor: 1 },
    ];
    for (const edit of edits) {
      const values: EnuValues = { geometry: tokyoLine(), angleDegrees: 10, size: 4 };
      const written = applyEnuEdit(edit, values);
      const turn = enuEditTurn(edit);
      expect(written.angleDegrees).toBeCloseTo(10 + turn.angleDegrees, 9);
      expect(written.size).toBeCloseTo(4 * turn.sizeFactor, 9);
    }
    expect(enuEditTurn(edits[0])).toEqual({ angleDegrees: 0, sizeFactor: 1 });
    expect(enuEditTurn(edits[1])).toEqual({ angleDegrees: 30, sizeFactor: 1 });
    expect(enuEditTurn(edits[3])).toEqual({ angleDegrees: 0, sizeFactor: 2.5 });
  });

  it('keeps a latitude past the one of Mercator, and computes a point at a pole', () => {
    const north: EnuEdit = { kind: 'translate', from: [0, 86], to: [1, 86] };
    const moved = coordinatesOf(applyEnuEdit(north, { geometry: point(0, 86) }).geometry);
    expect(moved[0]).toBeCloseTo(1, 9);
    expect(moved[1]).toBeCloseTo(86, 9);
    const turned = coordinatesOf(
      applyEnuEdit(
        { kind: 'rotate', center: [0, 86], angleDegrees: 30 },
        { geometry: point(10, 86.5) },
      ).geometry,
    );
    expect(turned[1] as number).toBeGreaterThan(86);
    expect(turned[1]).not.toBe(85.0511287798066);
    // About the north pole, a quarter turn counterclockwise seen from above adds 90 degrees of
    // longitude
    const aboutPole = coordinatesOf(
      applyEnuEdit(
        { kind: 'rotate', center: [0, 90], angleDegrees: 90 },
        { geometry: point(10, 89) },
      ).geometry,
    );
    expect(aboutPole[0]).toBeCloseTo(100, 9);
    expect(aboutPole[1]).toBeCloseTo(89, 9);
    // The pole itself is turned with the rest: it stays at the pole
    const pole = coordinatesOf(
      applyEnuEdit(
        { kind: 'rotate', center: [10, 89], angleDegrees: 0.000001 },
        { geometry: point(45, 90) },
      ).geometry,
    );
    expect(Number.isFinite(pole[0])).toBe(true);
    expect(pole[1]).toBeCloseTo(90, 6);
    // A point that is the center is not computed
    const center = applyEnuEdit(
      { kind: 'scale', center: [45, 90], eastFactor: 2, northFactor: 2, sizeFactor: 2 },
      { geometry: point(45, 90) },
    );
    expect(coordinatesOf(center.geometry)).toEqual([45, 90]);
  });

  it('brings the longitudes of a feature across the meridian of 180 degrees together', () => {
    const line: LineString = {
      type: 'LineString',
      coordinates: [
        [179.95, 10],
        [179.99, 10],
        [180.02, 10],
      ],
    };
    const moved = (
      applyEnuEdit({ kind: 'translate', from: [0, 10], to: [0.1, 10] }, { geometry: line })
        .geometry as LineString
    ).coordinates;
    // Each longitude stays near the one it had; then the first comes within [-180, 180], and the
    // others follow it
    const first = moved[0]?.[0] as number;
    expect(first).toBeGreaterThanOrEqual(-180);
    expect(first).toBeLessThanOrEqual(180);
    expect(first).toBeCloseTo(-179.95, 6);
    expect(moved[1]?.[0]).toBeCloseTo(-179.91, 6);
    expect(moved[2]?.[0]).toBeCloseTo(-179.88, 6);
    // A ring that crosses it stays one ring
    const ring: Polygon = {
      type: 'Polygon',
      coordinates: [
        [
          [179.9, 0],
          [180.1, 0],
          [180.1, 0.2],
          [179.9, 0.2],
          [179.9, 0],
        ],
      ],
    };
    const turned = (
      applyEnuEdit({ kind: 'rotate', center: [180, 0.1], angleDegrees: 10 }, { geometry: ring })
        .geometry as Polygon
    ).coordinates[0] as number[][];
    for (let i = 1; i < turned.length; i++) {
      expect(Math.abs((turned[i]?.[0] as number) - (turned[i - 1]?.[0] as number))).toBeLessThan(1);
    }
    expect(turned[0]?.[0]).toBe(turned[4]?.[0]);
  });

  it('keeps the numbers past the longitude and the latitude', () => {
    const values = applyEnuEdit(
      { kind: 'rotate', center: [139.7, 35.6], angleDegrees: 45 },
      {
        geometry: {
          type: 'LineString',
          coordinates: [
            [139.71, 35.61, 123.456, 7],
            [139.72, 35.62, -0],
          ],
        },
      },
    );
    const coordinates = (values.geometry as LineString).coordinates;
    expect(coordinates[0]?.slice(2)).toEqual([123.456, 7]);
    expect(Object.is(coordinates[1]?.[2], -0)).toBe(true);
    expect(coordinates[1]).toHaveLength(3);
  });

  it('changes the fields of the roles', () => {
    const rotate: EnuEdit = { kind: 'rotate', center: [139.7, 35.6], angleDegrees: -90 };
    expect(
      applyEnuEdit(rotate, { geometry: point(139.7, 35.6), angleDegrees: 30 }).angleDegrees,
    ).toBe(300);
    expect(
      applyEnuEdit(rotate, { geometry: point(139.7, 35.6), angleDegrees: null }).angleDegrees,
    ).toBe(270);
    const turned = applyEnuEdit(
      { kind: 'rotate', center: [139.7, 35.6], angleDegrees: 180 },
      { geometry: point(139.7, 35.6), angleDegrees: 270, bearingDegrees: 90 },
    );
    expect(turned.angleDegrees).toBe(90);
    expect(turned.bearingDegrees).toBe(270);
    expect(
      applyEnuEdit(rotate, { geometry: point(139.7, 35.6), bearingDegrees: null }).bearingDegrees,
    ).toBeNull();
    const scale: EnuEdit = {
      kind: 'scale',
      center: [139.7, 35.6],
      eastFactor: 2,
      northFactor: 1,
      sizeFactor: 3,
    };
    expect(applyEnuEdit(scale, { geometry: point(139.7, 35.6), size: 2 }).size).toBe(6);
    expect(applyEnuEdit(scale, { geometry: point(139.7, 35.6), size: null }).size).toBe(3);
    // A rotation does not change the size, nor a scaling the angle
    expect(applyEnuEdit(rotate, { geometry: point(139.7, 35.6), size: 2 }).size).toBe(2);
    expect(
      applyEnuEdit(scale, { geometry: point(139.7, 35.6), angleDegrees: 30 }).angleDegrees,
    ).toBe(30);
  });

  it('moves a feature that keeps its shape by the factor of the size', () => {
    const scale: EnuEdit = {
      kind: 'scale',
      center: [139.7, 35.6],
      eastFactor: 2,
      northFactor: 1,
      sizeFactor: 3,
    };
    const at = point(139.71, 35.61);
    const uniform = applyEnuEdit(scale, { geometry: at, uniformScale: true });
    const uniformly = applyEnuEdit(
      { kind: 'scale', center: [139.7, 35.6], eastFactor: 3, northFactor: 3, sizeFactor: 1 },
      { geometry: at },
    );
    expect(coordinatesOf(uniform.geometry)).toEqual(coordinatesOf(uniformly.geometry));
    const stretched = coordinatesOf(applyEnuEdit(scale, { geometry: at }).geometry);
    expect(stretched[0]).toBeCloseTo(139.72, 5);
    expect(stretched[1]).toBeCloseTo(35.61, 5);
    // A scaling whose factors of the east and the north are 1 moves only the ones that keep
    // their shape
    const sizeOnly: EnuEdit = {
      kind: 'scale',
      center: [139.7, 35.6],
      eastFactor: 1,
      northFactor: 1,
      sizeFactor: 2,
    };
    expect(applyEnuEdit(sizeOnly, { geometry: at }).geometry).toBe(at);
    expect(applyEnuEdit(sizeOnly, { geometry: at, uniformScale: true }).geometry).not.toBe(at);
  });

  it('takes the values within the ranges only', () => {
    const translate = (from: number[], to: number[]): EnuEdit => ({
      kind: 'translate',
      from,
      to,
    });
    const rotate = (angleDegrees: number): EnuEdit => ({
      kind: 'rotate',
      center: [0, 0],
      angleDegrees,
    });
    const scale = (eastFactor: number, northFactor = 1, sizeFactor = 1): EnuEdit => ({
      kind: 'scale',
      center: [0, 0],
      eastFactor,
      northFactor,
      sizeFactor,
    });
    const taken: EnuEdit[] = [
      translate([0, 90], [0, -90]),
      translate([540, 0], [-720, 0]),
      translate([0, 0, Number.NaN], [1, 1]),
      rotate(180),
      rotate(-179.999999),
      scale(1e-6),
      scale(1e6),
      scale(1, 1e-6, 1e6),
    ];
    const refused: EnuEdit[] = [
      translate([0, 90.000001], [0, 0]),
      translate([0, 0], [0, -90.000001]),
      translate([Number.NaN, 0], [0, 0]),
      translate([0, 0], [Number.POSITIVE_INFINITY, 0]),
      translate([0], [0, 0]),
      rotate(-180),
      rotate(180.000001),
      rotate(Number.NaN),
      scale(0),
      scale(1e-6 * 0.999),
      scale(1e6 * 1.001),
      scale(1, -1),
      scale(1, 1, Number.POSITIVE_INFINITY),
      { kind: 'rotate', center: [0, 91], angleDegrees: 1 },
    ];
    for (const edit of taken) expect(acceptsEnuEdit(edit), JSON.stringify(edit)).toBe(true);
    for (const edit of refused) expect(acceptsEnuEdit(edit), JSON.stringify(edit)).toBe(false);
  });
});
