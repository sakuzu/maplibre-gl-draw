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
 * The circle, the triangle and the star are inscribed in the circle of radius `r` (the
 * circumradius equals the radius of the circle shape), so a point of a given size occupies the same
 * circle whatever its shape, and the hit area (that circle) covers it. The square has half its
 * side `r`: it fills the square the circle is inscribed in, and its corners reach `r√2`. The distance is negative inside, zero on the edge and
 * positive outside, in the units of the input (device pixels in the shader). The fill and the
 * stroke are separated by a band of this distance: the stroke is the band `-strokeWidth < d <= 0`
 * inside the outer edge.
 *
 * The triangle is equilateral with a vertex pointing up (+y), and the star is a regular pentagram
 * with a tip pointing up. +y is up on the screen for both renderers.
 */

/** The shapes the built-in renderers draw */
export type SdfPointShape = 'circle' | 'square' | 'triangle' | 'star';

/** The code of each shape, as the shaders read it */
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

/**
 * The steps of the rotation of a marker in one turn: the rotation is held in steps of 0.01 degree
 *
 * A marker of a feature with a rotation (`maplibre-gl-draw:rotation`) keeps its direction on the
 * map: it turns with the map. A marker of a feature without one stays upright on screen. The
 * three ways points are drawn (the rows in one draw, the rows by kind and the features of the
 * Store or of a frame) hold the rotation as the same whole number (`pointAngleSteps`), so they
 * draw a marker at the same angle:
 *
 * - an instance of the renderer of the points folds it into the float of the code of its shape
 *   (`pointMarkerCode`): the code plus 8 times the steps, the code alone without a rotation. The
 *   largest value, 3 + 8 × 36,000, is below 2^24, so a float holds it exactly
 * - a row drawn in one draw holds the steps in the free float of the texel of its style
 *
 * @internal
 */
export const POINT_ANGLE_STEPS = 36_000;

/** The steps of the rotation in one degree */
const POINT_ANGLE_STEPS_PER_DEGREE = POINT_ANGLE_STEPS / 360;

/** What a code of a marker holds besides its shape: the shape is its 3 lowest bits */
const POINT_SHAPE_BITS = 8;

/**
 * The rotation of a marker as it is drawn: 0 for a marker upright on screen (no rotation, or one
 * that is not a finite number), else 1 plus the rotation in steps of 0.01 degree within one turn
 * (1 to {@link POINT_ANGLE_STEPS})
 *
 * @param rotation The rotation in degrees counterclockwise seen from above, 0 with the north up
 * @internal
 */
export function pointAngleSteps(rotation: number | undefined): number {
  if (rotation === undefined || !Number.isFinite(rotation)) return 0;
  const turn = ((rotation % 360) + 360) % 360;
  return (Math.round(turn * POINT_ANGLE_STEPS_PER_DEGREE) % POINT_ANGLE_STEPS) + 1;
}

/**
 * The code of a marker an instance of the renderer of the points holds: the code of its shape,
 * plus 8 times its steps of rotation ({@link pointAngleSteps})
 *
 * @internal
 */
export function pointMarkerCode(shapeCode: number, angleSteps: number): number {
  return shapeCode + POINT_SHAPE_BITS * angleSteps;
}

/**
 * How far a shape turned by any angle reaches along either axis of the screen, in units of the
 * reach of the upright shape: the circle, the triangle and the star are inscribed in the circle of
 * the outer radius, which no angle takes beyond the billboard of the upright shape (1); the
 * square, half its side the outer radius, reaches its corners at √2 times the outer radius when
 * turned by 45 degrees
 *
 * @param shapeCode The code of the shape ({@link POINT_SHAPE_CODE})
 * @internal
 */
export function pointTurnReach(shapeCode: number): number {
  return shapeCode === POINT_SHAPE_CODE.square ? Math.SQRT2 : 1;
}

/**
 * GLSL that turns a marker by its rotation
 *
 * - `float pointAngleDegrees(int steps)`: the rotation of steps of {@link pointAngleSteps} (1 or
 *   more), in degrees
 * - `vec2 pointTurnOffset(vec2 offsetPx, float degrees)`: the offset of a fragment from the center
 *   of a marker turned counterclockwise by `degrees` on screen, as the offset of the upright
 *   shape `pointShapeSdf` reads (+y up)
 *
 * - `float pointTurnReach(float shape)`: {@link pointTurnReach}, for the code of a shape
 *
 * A marker turned on the map by its rotation is turned on screen by it plus the bearing of the
 * map. The billboard is not turned: it is widened by `pointTurnReach` for a turned marker, so it
 * covers the shape whatever the angle. A marker that is not turned keeps the billboard it had.
 */
export const POINT_TURN_GLSL = `
float pointTurnReach(float shape) {
    return abs(shape - ${POINT_SHAPE_CODE.square.toFixed(1)}) < 0.5 ? ${Math.SQRT2} : 1.0;
}

float pointAngleDegrees(int steps) {
    return float(steps - 1) * ${(1 / POINT_ANGLE_STEPS_PER_DEGREE).toFixed(2)};
}

vec2 pointTurnOffset(vec2 offsetPx, float degrees) {
    float a = radians(degrees);
    float s = sin(a);
    float c = cos(a);
    return vec2(c * offsetPx.x + s * offsetPx.y, c * offsetPx.y - s * offsetPx.x);
}
`;

/**
 * GLSL that takes a code of a marker apart (`pointMarkerCode`): `int pointMarkerShape(int code)`
 * gives the code of its shape, `int pointMarkerSteps(int code)` its steps of rotation (0 for an
 * upright marker)
 */
export const POINT_MARKER_GLSL = `
int pointMarkerShape(int code) {
    return code & ${POINT_SHAPE_BITS - 1};
}

int pointMarkerSteps(int code) {
    return code >> 3;
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
