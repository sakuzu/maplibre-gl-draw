// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Signed distance functions of the built-in point shapes
 *
 * Both point renderers draw the same four shapes, and both take them from here: the instanced
 * renderer evaluates `POINT_SDF_GLSL` in its fragment shader, and the per-point renderer builds
 * its vertices by sampling `pointShapeSdf`, which is the same formula written in TypeScript. The
 * two copies are kept side by side so that a change to one is a change to the other.
 *
 * Every shape is inscribed in the circle of radius `r` (the circumradius equals the radius of the
 * circle shape), so a point of a given size occupies the same circle whatever its shape, and the
 * hit area (the circumcircle) covers it. The distance is negative inside, zero on the edge and
 * positive outside, in the units of the input (device pixels in the shader). The fill and the
 * stroke are separated by a band of this distance: the stroke is the band `-strokeWidth < d <= 0`
 * inside the outer edge.
 *
 * The triangle is equilateral with a vertex pointing up (+y), and the star is a regular pentagram
 * with a tip pointing up. +y is up on the screen for both renderers.
 */

/** The shapes the built-in renderers draw */
export type SdfPointShape = 'circle' | 'square' | 'triangle' | 'star';

/** Value of the `u_shape` uniform for each shape */
export const POINT_SHAPE_CODE: Readonly<Record<SdfPointShape, number>> = {
  circle: 0,
  square: 1,
  triangle: 2,
  star: 3,
};

/**
 * Ratio of the inner vertices of the star to its tips ((3 - √5) / 2, a regular pentagram)
 */
export const STAR_INNER_RATIO = 0.381966011250105;

const SQRT3 = 1.7320508075688772;
/** Half the side of an equilateral triangle inscribed in the unit circle (√3 / 2) */
const TRIANGLE_HALF_SIDE = 0.8660254037844386;
/** (cos 36°, -sin 36°): the mirror axes of the star */
const STAR_K1X = 0.8090169943749475;
const STAR_K1Y = -0.5877852522924731;

/**
 * Signed distance to an equilateral triangle inscribed in the circle of radius `r`
 */
function sdTriangle(x: number, y: number, r: number): number {
  const h = r * TRIANGLE_HALF_SIDE;
  let px = Math.abs(x) - h;
  let py = y + h / SQRT3;
  if (px + SQRT3 * py > 0) {
    const nx = (px - SQRT3 * py) / 2;
    const ny = (-SQRT3 * px - py) / 2;
    px = nx;
    py = ny;
  }
  px -= Math.min(Math.max(px, -2 * h), 0);
  return -Math.hypot(px, py) * Math.sign(py);
}

/**
 * Signed distance to a regular pentagram whose tips lie on the circle of radius `r`
 */
function sdStar(x: number, y: number, r: number): number {
  let px = Math.abs(x);
  let py = y;
  // Fold the plane into one tenth of the star (mirrors about the two axes k1 and k2)
  let t = Math.max(STAR_K1X * px + STAR_K1Y * py, 0);
  px -= 2 * t * STAR_K1X;
  py -= 2 * t * STAR_K1Y;
  t = Math.max(-STAR_K1X * px + STAR_K1Y * py, 0);
  px -= 2 * t * -STAR_K1X;
  py -= 2 * t * STAR_K1Y;
  px = Math.abs(px);
  py -= r;
  // Edge from the tip (0, r) toward the inner vertex
  const bax = STAR_INNER_RATIO * -STAR_K1Y;
  const bay = STAR_INNER_RATIO * STAR_K1X - 1;
  const h = Math.min(Math.max((px * bax + py * bay) / (bax * bax + bay * bay), 0), r);
  return Math.hypot(px - bax * h, py - bay * h) * Math.sign(py * bax - px * bay);
}

/**
 * Signed distance from `(x, y)` (relative to the center of the point) to the edge of a shape
 * inscribed in the circle of radius `r`
 *
 * The same formula as `pointShapeSdf` of `POINT_SDF_GLSL`. The circle uses the Euclidean
 * distance and the square the Chebyshev distance (half its side is `r`).
 */
export function pointShapeSdf(shape: SdfPointShape, x: number, y: number, r: number): number {
  switch (shape) {
    case 'square':
      return Math.max(Math.abs(x), Math.abs(y)) - r;
    case 'triangle':
      return sdTriangle(x, y, r);
    case 'star':
      return sdStar(x, y, r);
    default:
      return Math.hypot(x, y) - r;
  }
}

/**
 * GLSL of `pointShapeSdf` (the shape is selected by the value of `POINT_SHAPE_CODE`)
 */
export const POINT_SDF_GLSL = `
float sdPointTriangle(vec2 p, float r) {
    const float k = ${SQRT3};
    float h = r * ${TRIANGLE_HALF_SIDE};
    p.x = abs(p.x) - h;
    p.y = p.y + h / k;
    if (p.x + k * p.y > 0.0) p = vec2(p.x - k * p.y, -k * p.x - p.y) / 2.0;
    p.x -= clamp(p.x, -2.0 * h, 0.0);
    return -length(p) * sign(p.y);
}

float sdPointStar(vec2 p, float r) {
    const vec2 k1 = vec2(${STAR_K1X}, ${STAR_K1Y});
    const vec2 k2 = vec2(${-STAR_K1X}, ${STAR_K1Y});
    p.x = abs(p.x);
    p -= 2.0 * max(dot(k1, p), 0.0) * k1;
    p -= 2.0 * max(dot(k2, p), 0.0) * k2;
    p.x = abs(p.x);
    p.y -= r;
    vec2 ba = ${STAR_INNER_RATIO} * vec2(-k1.y, k1.x) - vec2(0.0, 1.0);
    float h = clamp(dot(p, ba) / dot(ba, ba), 0.0, r);
    return length(p - ba * h) * sign(p.y * ba.x - p.x * ba.y);
}

float pointShapeSdf(vec2 p, float r, float shape) {
    if (shape < 0.5) return length(p) - r;
    if (shape < 1.5) return max(abs(p.x), abs(p.y)) - r;
    if (shape < 2.5) return sdPointTriangle(p, r);
    return sdPointStar(p, r);
}
`;

/** Angles (radians) of the vertices of the polygonal shapes, counterclockwise from the top */
function vertexAngles(shape: 'triangle' | 'star'): number[] {
  const count = shape === 'triangle' ? 3 : 10;
  const angles: number[] = [];
  for (let i = 0; i < count; i++) angles.push(Math.PI / 2 + (i / count) * Math.PI * 2);
  return angles;
}

/** Subdivisions between two vertex angles (the star needs them for the rounded inner corners) */
function subdivisions(shape: 'triangle' | 'star'): number {
  return shape === 'triangle' ? 1 : 4;
}

/**
 * Distance from the center along the direction `(dx, dy)` at which the distance function
 * reaches `level` (bisection; 0 when the center itself is already outside that level)
 */
function radiusAtLevel(
  shape: SdfPointShape,
  dx: number,
  dy: number,
  outer: number,
  level: number,
): number {
  if (pointShapeSdf(shape, 0, 0, outer) >= level) return 0;
  let lo = 0;
  let hi = outer;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (pointShapeSdf(shape, dx * mid, dy * mid, outer) < level) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** A ring of the outline of a shape, sampled along rays from the center */
export interface PointShapeRings {
  /** The outer edge (distance 0) */
  outer: Array<[number, number]>;
  /** The inner edge of the stroke (distance `-inset`), on the same rays as `outer` */
  inner: Array<[number, number]>;
}

/**
 * Samples the outer edge and the inner edge of the stroke of a polygonal shape
 *
 * Both rings are taken on the same rays from the center (through every vertex, plus subdivisions
 * for the star), so the vertices pair up for a strip between them and the center sees each ring
 * as a fan. The inner edge is where the distance function is `-inset`, so the band between the
 * rings is exactly the stroke band of the instanced renderer. The rings are not closed (the first
 * vertex is not repeated).
 *
 * @param outer The circumradius of the outer edge
 * @param inset The stroke width (the depth of the inner edge; 0 makes the rings equal)
 */
export function samplePointShapeRings(
  shape: 'triangle' | 'star',
  outer: number,
  inset: number,
): PointShapeRings {
  const angles = vertexAngles(shape);
  const steps = subdivisions(shape);
  const rings: PointShapeRings = { outer: [], inner: [] };
  for (let i = 0; i < angles.length; i++) {
    const from = angles[i];
    const to = i + 1 < angles.length ? angles[i + 1] : angles[0] + Math.PI * 2;
    for (let s = 0; s < steps; s++) {
      const angle = from + ((to - from) * s) / steps;
      const dx = Math.cos(angle);
      const dy = Math.sin(angle);
      const ro = radiusAtLevel(shape, dx, dy, outer, 0);
      const ri = inset > 0 ? radiusAtLevel(shape, dx, dy, outer, -inset) : ro;
      rings.outer.push([dx * ro, dy * ro]);
      rings.inner.push([dx * ri, dy * ri]);
    }
  }
  return rings;
}
