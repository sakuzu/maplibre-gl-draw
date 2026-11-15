// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests the distance functions of the built-in point shapes and the outlines sampled from them.
 */

import type { Geometry } from 'geojson';
import { describe, expect, it } from 'vitest';
import {
  applyEnuEdit,
  type EnuEdit,
  rotationTurnedFrom,
} from '../../../geometry/enu-transforms.js';
import {
  roleFieldsOf,
  transformRolesOf,
  transformValuesOf,
} from '../../../store/transform-roles.js';
import { POINT_AA_PADDING_PX } from './point-instance.js';
import {
  POINT_ANGLE_STEPS,
  POINT_SDF_GLSL,
  POINT_SHAPE_CODE,
  POINT_TURN_GLSL,
  pointAngleSteps,
  pointMarkerCode,
  pointShapeSdf,
  pointTurnReach,
  type SdfPointShape,
  STAR_INNER_RATIO,
  samplePointShapeRings,
} from './point-sdf.js';

const R = 10;

function polar(radius: number, degreesFromUp: number): [number, number] {
  const a = Math.PI / 2 + (degreesFromUp * Math.PI) / 180;
  return [Math.cos(a) * radius, Math.sin(a) * radius];
}

describe('pointShapeSdf', () => {
  it('keeps the circle and the square as before (Euclidean and Chebyshev distance)', () => {
    expect(pointShapeSdf('circle', 3, 4, R)).toBeCloseTo(-5);
    expect(pointShapeSdf('square', 3, -7, R)).toBeCloseTo(-3);
    expect(pointShapeSdf('square', 12, 0, R)).toBeCloseTo(2);
  });

  it('puts the vertices of the triangle on the circumcircle with one pointing up', () => {
    for (const deg of [0, 120, 240]) {
      const [x, y] = polar(R, deg);
      expect(pointShapeSdf('triangle', x, y, R)).toBeCloseTo(0, 6);
    }
    // The inradius of an equilateral triangle is half its circumradius
    expect(pointShapeSdf('triangle', 0, 0, R)).toBeCloseTo(-R / 2, 6);
    // Straight down reaches the base at half the radius; up reaches the apex at the full radius
    expect(pointShapeSdf('triangle', 0, -R / 2, R)).toBeCloseTo(0, 6);
    expect(pointShapeSdf('triangle', 0, R * 0.9, R)).toBeLessThan(0);
    expect(pointShapeSdf('triangle', 0, -R * 0.9, R)).toBeCloseTo(0.4 * R, 6);
  });

  it('puts the tips of the star on the circumcircle and the inner vertices inside', () => {
    for (let i = 0; i < 5; i++) {
      const [tx, ty] = polar(R, i * 72);
      expect(pointShapeSdf('star', tx, ty, R)).toBeCloseTo(0, 6);
      const [ix, iy] = polar(R * STAR_INNER_RATIO, i * 72 + 36);
      expect(pointShapeSdf('star', ix, iy, R)).toBeCloseTo(0, 6);
    }
    // The nearest edge from the center is an inner vertex
    expect(pointShapeSdf('star', 0, 0, R)).toBeCloseTo(-R * STAR_INNER_RATIO, 6);
    // Between two tips, outside the inner vertex, is outside the star
    const [ox, oy] = polar(R * 0.8, 36);
    expect(pointShapeSdf('star', ox, oy, R)).toBeGreaterThan(0);
  });

  it('is positive outside every shape and never exceeds the circumcircle', () => {
    for (const shape of ['circle', 'square', 'triangle', 'star'] as const) {
      for (let deg = 0; deg < 360; deg += 7) {
        const [x, y] = polar(R * 1.5, deg);
        expect(pointShapeSdf(shape, x, y, R)).toBeGreaterThan(0);
        if (shape !== 'square') {
          const [cx, cy] = polar(R * 1.0001, deg);
          expect(pointShapeSdf(shape, cx, cy, R)).toBeGreaterThanOrEqual(0);
        }
      }
    }
  });
});

describe('POINT_SDF_GLSL', () => {
  it('dispatches on the shape codes 0 to 3', () => {
    expect(POINT_SHAPE_CODE).toEqual({ circle: 0, square: 1, triangle: 2, star: 3 });
    expect(POINT_SDF_GLSL).toContain('float pointShapeSdf(vec2 p, float r, float shape)');
    expect(POINT_SDF_GLSL).toContain(String(STAR_INNER_RATIO));
  });
});

describe('samplePointShapeRings', () => {
  it('samples the triangle at its three vertices', () => {
    const rings = samplePointShapeRings('triangle', R, 0);
    expect(rings.outer).toHaveLength(3);
    expect(rings.outer[0][0]).toBeCloseTo(0, 6);
    expect(rings.outer[0][1]).toBeCloseTo(R, 6);
    expect(rings.inner).toEqual(rings.outer);
  });

  it('puts the outer ring on the edge and the inner ring at the stroke depth', () => {
    for (const shape of ['triangle', 'star'] as const) {
      const rings = samplePointShapeRings(shape, R, 1.5);
      expect(rings.inner).toHaveLength(rings.outer.length);
      for (const [x, y] of rings.outer) expect(pointShapeSdf(shape, x, y, R)).toBeCloseTo(0, 6);
      for (const [x, y] of rings.inner) expect(pointShapeSdf(shape, x, y, R)).toBeCloseTo(-1.5, 6);
    }
  });

  it('shrinks the inner triangle by twice the stroke along the vertex rays', () => {
    const rings = samplePointShapeRings('triangle', R, 2);
    expect(Math.hypot(...rings.inner[0])).toBeCloseTo(R - 4, 6);
  });

  it('collapses the inner ring to the center when the stroke fills the shape', () => {
    const rings = samplePointShapeRings('triangle', R, R);
    for (const [x, y] of rings.inner) expect(Math.hypot(x, y)).toBe(0);
  });
});

describe('the rotation of a marker (pointAngleSteps, pointMarkerCode)', () => {
  it('is 0 without a rotation, and for a value that is not a finite number', () => {
    expect(pointAngleSteps(undefined)).toBe(0);
    expect(pointAngleSteps(Number.NaN)).toBe(0);
    expect(pointAngleSteps(Number.POSITIVE_INFINITY)).toBe(0);
  });

  it('reads a value that is no number as a rotation of 0, and a number not finite as none', () => {
    for (const value of ['30', null, true, { degrees: 30 }]) expect(pointAngleSteps(value)).toBe(1);
    expect(pointAngleSteps(Number.NEGATIVE_INFINITY)).toBe(0);
  });

  it('tells a rotation of 0 from none', () => {
    expect(pointAngleSteps(0)).toBe(1);
    expect(pointAngleSteps(-0)).toBe(1);
  });

  it('holds the rotation in steps of 0.01 degree within one turn, plus 1', () => {
    expect(pointAngleSteps(90)).toBe(9_001);
    expect(pointAngleSteps(-90)).toBe(27_001);
    expect(pointAngleSteps(450)).toBe(9_001);
    expect(pointAngleSteps(12.34)).toBe(1_235);
    // A rotation rounded to a whole turn is 0
    expect(pointAngleSteps(359.996)).toBe(1);
    expect(pointAngleSteps(-0.004)).toBe(1);
    expect(pointAngleSteps(359.99)).toBe(POINT_ANGLE_STEPS);
  });

  it('folds the steps into the code of the shape so a float holds every code exactly', () => {
    const largest = pointMarkerCode(POINT_SHAPE_CODE.star, POINT_ANGLE_STEPS);
    expect(largest).toBeLessThan(2 ** 24);
    expect(Math.fround(largest)).toBe(largest);
    // The shape is the 3 lowest bits, the steps the rest
    for (const [shape, code] of Object.entries(POINT_SHAPE_CODE)) {
      const marker = pointMarkerCode(code, pointAngleSteps(271.5));
      expect(marker & 7, shape).toBe(code);
      expect(marker >> 3, shape).toBe(27_151);
      expect(pointMarkerCode(code, 0), shape).toBe(code);
    }
  });
});

describe('the billboard of a turned marker (pointTurnReach)', () => {
  /** The band of the edge the fragment shader still draws, outside the shape (half a pixel) */
  const AA = 0.5;

  /**
   * The share of a marker turned on screen by `degrees` that falls outside its billboard: the
   * places of a grid around it where the distance the fragment shader reads (at the offset turned
   * as `pointTurnOffset` turns it) is within the band of its edge, and the share of them beyond
   * the billboard of half its side `extent`
   */
  function clipped(shape: SdfPointShape, outer: number, degrees: number, extent: number): number {
    const a = (degrees * Math.PI) / 180;
    const c = Math.cos(a);
    const s = Math.sin(a);
    const step = 0.2;
    const far = outer * 2 + 2;
    let inside = 0;
    let out = 0;
    for (let x = -far; x <= far; x += step) {
      for (let y = -far; y <= far; y += step) {
        if (pointShapeSdf(shape, c * x + s * y, c * y - s * x, outer) >= AA) continue;
        inside++;
        if (Math.abs(x) > extent || Math.abs(y) > extent) out++;
      }
    }
    return out / inside;
  }

  const shapes = Object.keys(POINT_SHAPE_CODE) as SdfPointShape[];

  it('leaves no part of a marker of any shape outside its billboard, at any angle', () => {
    for (const shape of shapes) {
      for (const outer of [0.5, 7, 16]) {
        const extent = (outer + POINT_AA_PADDING_PX) * pointTurnReach(POINT_SHAPE_CODE[shape]);
        for (let degrees = 0; degrees < 360; degrees += 5) {
          expect(clipped(shape, outer, degrees, extent), `${shape} ${outer} ${degrees}`).toBe(0);
        }
      }
    }
  });

  it('widens the billboard of the square only, whose corners a turn takes beyond it', () => {
    expect(shapes.map((shape) => pointTurnReach(POINT_SHAPE_CODE[shape]))).toEqual([
      1,
      Math.SQRT2,
      1,
      1,
    ]);
    // The billboard of the upright square cuts its corners once it is turned
    expect(clipped('square', 16, 45, 16 + POINT_AA_PADDING_PX)).toBeGreaterThan(0.1);
    expect(clipped('square', 16, 0, 16 + POINT_AA_PADDING_PX)).toBe(0);
  });

  it('is in the GLSL with the same value', () => {
    expect(POINT_TURN_GLSL).toContain(`? ${Math.SQRT2} : 1.0`);
  });
});

describe('the rotation of a marker as a turn of its point writes it', () => {
  const KEY = 'maplibre-gl-draw:rotation';
  const TURN: EnuEdit = { kind: 'rotate', center: [139.7, 35.6], angleDegrees: 50 };
  const GEOMETRY: Geometry = { type: 'Point', coordinates: [139.71, 35.6] };
  const VALUES: unknown[] = [
    undefined,
    30,
    -0,
    359.5,
    '30',
    null,
    true,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
  ];

  /** The roles of a point holding a value of its rotation (none for undefined) */
  const rolesOf = (type: string, value: unknown) =>
    transformRolesOf(type, (key) => key === KEY && value !== undefined);

  /**
   * The value of the rotation of a point once a turn is written, as the library writes it (the
   * value it held when the write leaves it)
   */
  function written(type: string, value: unknown): unknown {
    const read = (key: string): unknown => (key === KEY ? value : undefined);
    const roles = rolesOf(type, value);
    const before = transformValuesOf(GEOMETRY, roles, read);
    const fields = new Map(roleFieldsOf(roles, before, applyEnuEdit(TURN, before)));
    return fields.has(KEY) ? fields.get(KEY) : value;
  }

  it('draws a marker turned by a drag at the angle written once it is let go, whatever the value', () => {
    for (const type of ['Point', 'MultiPoint']) {
      for (const value of VALUES) {
        const held = pointAngleSteps(value);
        // The GPU turns a marker with a rotation by the angle of the drag
        const during = held > 0 ? pointAngleSteps((rotationTurnedFrom(value) as number) + 50) : 0;
        expect(pointAngleSteps(written(type, value)), `${type} ${String(value)}`).toBe(during);
      }
    }
  });

  it('turns by a drag only the markers the drag turns by their values (the points with the role of a rotation)', () => {
    // The core draws its markers for the built-in types Point and MultiPoint only (a custom type
    // is drawn by its extension, and an override of Point cannot declare fields): their roles are
    // the built-in ones, so a marker the GPU turns is one the CPU turns by its values
    for (const type of ['Point', 'MultiPoint']) {
      for (const value of VALUES) {
        if (pointAngleSteps(value) === 0) continue;
        expect(rolesOf(type, value).angleDegrees, `${type} ${String(value)}`).toBe(KEY);
      }
      expect(rolesOf(type, undefined).angleDegrees).toBeUndefined();
    }
  });
});
