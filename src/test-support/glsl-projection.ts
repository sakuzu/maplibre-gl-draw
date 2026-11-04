// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A copy on the CPU of the GLSL that projects positions relative to the center of the view
 * (`OFFSET_MODE_GLSL` in `view/shaders/helpers.ts`), operation by operation, for the tests of its
 * precision
 *
 * GLSL ES 3.00 (4.5.1) bounds the error of a few operations only: `+ - *` are correctly rounded,
 * `/` is within 2.5 ULP, `log` within 3 ULP (an absolute 2^-21 for an argument in [0.5, 2]),
 * `exp(x)` within 3 + 2|x| ULP, `inversesqrt` within 2 ULP, and `sqrt` inherits `1.0 /
 * inversesqrt()`. The copy runs each operation through an `Arithmetic`, which computes it:
 *
 * - exactly in float64 (`exactArithmetic`): the formula itself, the inputs and the constants as
 *   the GPU holds them (32-bit floats)
 * - rounded to a 32-bit float after every operation (`float32Arithmetic`): what an IEEE GPU
 *   computes, to compare with the GLSL run on the GPU of the browser
 * - moved by the bound of the operation, in the direction asked for each operation
 *   (`boundedArithmetic`): {@link worstCase} takes the direction of each one that moves the
 *   result most, which is the worst a GPU at the limit of the specification may give
 *
 * The reference positions are computed apart, in float64, from the longitude and the latitude.
 * The matrices are those maplibre builds for a custom layer (Web Mercator and the globe).
 */

import { CENTER_PROJECTION_CONSTANTS } from '../view/shaders/center-projection.js';

const F32 = Math.fround;
const DEG = Math.PI / 180;

/** The unit roundoff of a correctly rounded operation on 32-bit floats */
export const UNIT_ROUNDOFF = 2 ** -24;
/** One ULP of a 32-bit float, relative to the value (its largest) */
const ULP = 2 ** -23;

/** The operations of the GLSL, computed one way or another */
export interface Arithmetic {
  add(a: number, b: number): number;
  sub(a: number, b: number): number;
  mul(a: number, b: number): number;
  div(a: number, b: number): number;
  log(x: number): number;
  exp(x: number): number;
  inversesqrt(x: number): number;
}

/** The operations exactly (the formula, with 32-bit inputs and constants) */
export const exactArithmetic: Arithmetic = {
  add: (a, b) => a + b,
  sub: (a, b) => a - b,
  mul: (a, b) => a * b,
  div: (a, b) => a / b,
  log: (x) => Math.log(x),
  exp: (x) => Math.exp(x),
  inversesqrt: (x) => 1 / Math.sqrt(x),
};

/** The operations rounded to a 32-bit float each */
export const float32Arithmetic: Arithmetic = {
  add: (a, b) => F32(a + b),
  sub: (a, b) => F32(a - b),
  mul: (a, b) => F32(a * b),
  div: (a, b) => F32(a / b),
  log: (x) => F32(Math.log(x)),
  exp: (x) => F32(Math.exp(x)),
  inversesqrt: (x) => F32(1 / Math.sqrt(x)),
};

/**
 * The operations moved by the bound of the specification, operation k by `directions[k]` times
 * its bound (0 = exact). The operations are counted as they are made (`count`).
 */
export class BoundedArithmetic implements Arithmetic {
  count = 0;
  private readonly directions: Float64Array | null;

  constructor(directions: Float64Array | null) {
    this.directions = directions;
  }

  private relative(value: number, bound: number): number {
    const s = this.directions?.[this.count] ?? 0;
    this.count++;
    return value * (1 + s * bound);
  }

  private absolute(value: number, bound: number): number {
    const s = this.directions?.[this.count] ?? 0;
    this.count++;
    return value + s * bound;
  }

  add(a: number, b: number): number {
    return this.relative(a + b, UNIT_ROUNDOFF);
  }
  sub(a: number, b: number): number {
    return this.relative(a - b, UNIT_ROUNDOFF);
  }
  mul(a: number, b: number): number {
    return this.relative(a * b, UNIT_ROUNDOFF);
  }
  div(a: number, b: number): number {
    return this.relative(a / b, 2.5 * ULP);
  }
  log(x: number): number {
    const y = Math.log(x);
    return x >= 0.5 && x <= 2 ? this.absolute(y, 2 ** -21) : this.relative(y, 3 * ULP);
  }
  exp(x: number): number {
    return this.relative(Math.exp(x), (3 + 2 * Math.abs(x)) * ULP);
  }
  inversesqrt(x: number): number {
    return this.relative(1 / Math.sqrt(x), 2 * ULP);
  }
}

/**
 * The worst a GPU at the limit of the specification gives for a computation: the result exact,
 * and the largest it may be off by in each component (to the first order of the bounds: each
 * operation moved alone by its bound, and the moves of all of them added up in their worst
 * directions)
 */
export function worstCase(compute: (arithmetic: Arithmetic) => readonly number[]): {
  exact: number[];
  error: number[];
} {
  const counting = new BoundedArithmetic(null);
  const exact = [...compute(counting)];
  const n = counting.count;
  const error = exact.map(() => 0);
  const directions = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    directions.fill(0);
    directions[k] = 1;
    const moved = compute(new BoundedArithmetic(directions));
    for (let i = 0; i < exact.length; i++) {
      error[i] = (error[i] as number) + Math.abs((moved[i] as number) - (exact[i] as number));
    }
  }
  return { exact, error };
}

// ============================================================================
// The values the CPU gives the shader
// ============================================================================

/** A 4x4 matrix, column-major (as maplibre and WebGL take it) */
export type Matrix = readonly number[];

/** The projection of a frame as maplibre gives it to a custom layer */
export interface FrameProjection {
  /** Web Mercator: the matrix of the Mercator coordinates; on the globe: of the unit sphere */
  mainMatrix: Matrix;
  /** On the globe: the matrix of the Mercator coordinates */
  fallbackMatrix: Matrix;
  /** 0 on Web Mercator, 1 on the globe, between in the transition */
  projectionTransition: number;
  clippingPlane: readonly [number, number, number, number];
}

/** The uniforms the shader reads, as 32-bit floats */
export interface ShaderUniforms {
  /** sin and cos of the latitude, sin and cos of the longitude of the center */
  centerSineCosine: [number, number, number, number];
  /** The center in clip space (computed in float64) */
  projectionCenter: [number, number, number, number];
  mainMatrix: number[];
  fallbackMatrix: number[];
  transition: number;
  clippingPlane: [number, number, number, number];
}

/** Multiplies a matrix by a vector in float64 */
export function transform(m: Matrix, v: readonly number[]): [number, number, number, number] {
  const [x, y, z, w] = v as [number, number, number, number];
  return [
    (m[0] as number) * x + (m[4] as number) * y + (m[8] as number) * z + (m[12] as number) * w,
    (m[1] as number) * x + (m[5] as number) * y + (m[9] as number) * z + (m[13] as number) * w,
    (m[2] as number) * x + (m[6] as number) * y + (m[10] as number) * z + (m[14] as number) * w,
    (m[3] as number) * x + (m[7] as number) * y + (m[11] as number) * z + (m[15] as number) * w,
  ];
}

/** The Mercator coordinates of a longitude and a latitude, in float64 */
export function mercatorOf(lng: number, lat: number): [number, number] {
  return [(lng + 180) / 360, 0.5 - Math.asinh(Math.tan(lat * DEG)) / (2 * Math.PI)];
}

/** The position on the unit sphere of the globe of a longitude and a latitude, in float64 */
export function sphereOf(lng: number, lat: number): [number, number, number] {
  const c = Math.cos(lat * DEG);
  return [Math.sin(lng * DEG) * c, Math.sin(lat * DEG), Math.cos(lng * DEG) * c];
}

/** The threshold over which maplibre draws the globe alone, as the shader compares it */
const GLOBE_ONLY = CENTER_PROJECTION_CONSTANTS.globeOnly;

/**
 * The position of a longitude and a latitude in clip space, in float64, as maplibre's projection
 * of a custom layer puts it (`projectTileWithElevation` of its globe prelude): the reference of
 * the tests
 */
export function referenceClip(
  projection: FrameProjection,
  lng: number,
  lat: number,
): [number, number, number, number] {
  const t = F32(projection.projectionTransition);
  const [mx, my] = mercatorOf(lng, lat);
  if (!(t > 0)) return transform(projection.mainMatrix, [mx, my, 0, 1]);
  const globe = transform(projection.mainMatrix, [...sphereOf(lng, lat), 1]);
  if (t > GLOBE_ONLY) return globe;
  const flat = transform(projection.fallbackMatrix, [mx, my, 0, 1]);
  return [
    flat[0] + (globe[0] - flat[0]) * t,
    flat[1] + (globe[1] - flat[1]) * t,
    0,
    flat[3] + (globe[3] - flat[3]) * t,
  ];
}

/**
 * The uniforms of a center (rounded to 32-bit floats as the CPU rounds it) for a frame, the
 * center in clip space computed in float64 from the rounded center
 */
export function uniformsOf(
  projection: FrameProjection,
  center: readonly [number, number],
): ShaderUniforms {
  const lng = F32(center[0]);
  const lat = F32(center[1]);
  const clip = referenceClip(projection, lng, lat);
  return {
    centerSineCosine: [
      F32(Math.sin(lat * DEG)),
      F32(Math.cos(lat * DEG)),
      F32(Math.sin(lng * DEG)),
      F32(Math.cos(lng * DEG)),
    ],
    projectionCenter: clip.map(F32) as [number, number, number, number],
    mainMatrix: projection.mainMatrix.map(F32),
    fallbackMatrix: projection.fallbackMatrix.map(F32),
    transition: F32(projection.projectionTransition),
    clippingPlane: projection.clippingPlane.map(F32) as [number, number, number, number],
  };
}

/** Clip space to CSS pixels of a viewport (y down) */
export function screenOf(clip: readonly number[], width: number, height: number): [number, number] {
  const w = clip[3] as number;
  return [
    ((clip[0] as number) / w + 1) * 0.5 * width,
    (1 - ((clip[1] as number) / w + 1) * 0.5) * height,
  ];
}

// ============================================================================
// The GLSL, operation by operation
// ============================================================================

// The coefficients and the constants as the GLSL holds them
const {
  sine: SINE,
  cosine: COSINE,
  atanh: ATANH,
  tanh: TANH,
  halfDegree: HALF_DEGREE,
  perDegree: PER_DEGREE,
  mercatorY: MERCATOR_Y,
  pi: PI_32,
  globeRadius: GLOBE_RADIUS,
  seriesLimit: SERIES_LIMIT,
} = CENTER_PROJECTION_CONSTANTS;

/** Horner's rule: c0 + x (c1 + x (c2 + ...)) */
function horner(ar: Arithmetic, x: number, c: readonly number[]): number {
  let p = c[c.length - 1] as number;
  for (let i = c.length - 2; i >= 0; i--) p = ar.add(c[i] as number, ar.mul(x, p));
  return p;
}

/** `offset_sine_cosine`: sin and cos of an angle in radians (|x| <= PI / 2) */
export function offsetSineCosine(ar: Arithmetic, x: number): [number, number] {
  const x2 = ar.mul(x, x);
  return [ar.mul(x, horner(ar, x2, SINE)), horner(ar, x2, COSINE)];
}

/**
 * `mercator_offset_y`: the Mercator y offset, from sin and cos of half the latitude offset
 *
 * With h half the offset and m = φ0 + h the latitude halfway, the offset of the isometric
 * latitude is 2 atanh(w) with w = sin h / cos m. A small w takes the series of atanh; a large one
 * the log of (cos m + sin h) / (cos m - sin h), whose two sides are formed from the center
 * directly (1 - sin φ0 and 1 + sin φ0 as cos² φ0 over the other), so that no difference of
 * numbers near 1 is left to the log.
 */
export function mercatorOffsetY(
  ar: Arithmetic,
  half: readonly [number, number],
  u: ShaderUniforms,
): number {
  const [s0, c0] = u.centerSineCosine;
  const cosMid = ar.sub(ar.mul(c0, half[1]), ar.mul(s0, half[0]));
  const w = ar.div(half[0], cosMid);
  let psi: number;
  if (Math.abs(w) < SERIES_LIMIT) {
    psi = ar.mul(ar.mul(2, w), horner(ar, ar.mul(w, w), ATANH));
  } else {
    const c2 = ar.mul(c0, c0);
    let onePlus: number;
    let oneMinus: number;
    if (s0 >= 0) {
      onePlus = ar.add(1, s0);
      oneMinus = ar.div(c2, onePlus);
    } else {
      oneMinus = ar.sub(1, s0);
      onePlus = ar.div(c2, oneMinus);
    }
    const cosH = ar.mul(c0, half[1]);
    const above = ar.add(cosH, ar.mul(oneMinus, half[0]));
    const below = ar.sub(cosH, ar.mul(onePlus, half[0]));
    psi = ar.log(ar.div(above, below));
  }
  return ar.mul(psi, MERCATOR_Y);
}

/** `wrapped_longitude_offset`: a longitude offset brought into [-180, 180] */
export function wrappedLongitudeOffset(ar: Arithmetic, d: number): number {
  let x = d;
  for (let i = 0; i < 2; i++) {
    if (x > 180) x = ar.sub(x, 360);
    if (x < -180) x = ar.add(x, 360);
  }
  return x;
}

/** `sphere_offset`: the offset on the unit sphere, from sin and cos of the half offsets */
export function sphereOffset(
  ar: Arithmetic,
  halfLat: readonly [number, number],
  halfLng: readonly [number, number],
  u: ShaderUniforms,
): [number, number, number] {
  const [s0, c0, sl0, cl0] = u.centerSineCosine;
  const cosMid = ar.sub(ar.mul(c0, halfLat[1]), ar.mul(s0, halfLat[0]));
  const sinMid = ar.add(ar.mul(s0, halfLat[1]), ar.mul(c0, halfLat[0]));
  const dSin = ar.mul(ar.mul(2, halfLat[0]), cosMid);
  const dCos = ar.mul(ar.mul(-2, halfLat[0]), sinMid);
  const cosLngMid = ar.sub(ar.mul(cl0, halfLng[1]), ar.mul(sl0, halfLng[0]));
  const sinLngMid = ar.add(ar.mul(sl0, halfLng[1]), ar.mul(cl0, halfLng[0]));
  const dSinLng = ar.mul(ar.mul(2, halfLng[0]), cosLngMid);
  const dCosLng = ar.mul(ar.mul(-2, halfLng[0]), sinLngMid);
  const cosLat = ar.add(c0, dCos);
  return [
    ar.add(ar.mul(sl0, dCos), ar.mul(dSinLng, cosLat)),
    dSin,
    ar.add(ar.mul(cl0, dCos), ar.mul(dCosLng, cosLat)),
  ];
}

/** A matrix times a vector, operation by operation */
function transformBy(ar: Arithmetic, m: readonly number[], v: readonly number[]): number[] {
  const out: number[] = [];
  for (let r = 0; r < 4; r++) {
    let sum = ar.mul(m[r] as number, v[0] as number);
    for (let c = 1; c < 4; c++) sum = ar.add(sum, ar.mul(m[c * 4 + r] as number, v[c] as number));
    out.push(sum);
  }
  return out;
}

/** `project_center_offset`: clip space of a position given by its offsets from the center */
export function projectCenterOffset(
  ar: Arithmetic,
  mercator: readonly [number, number],
  lngOffset: number,
  halfLat: readonly [number, number],
  elevation: number,
  u: ShaderUniforms,
): number[] {
  const c = u.projectionCenter;
  if (u.transition > 0) {
    const halfLng = offsetSineCosine(
      ar,
      ar.mul(wrappedLongitudeOffset(ar, lngOffset), HALF_DEGREE),
    );
    const sphere = sphereOffset(ar, halfLat, halfLng, u);
    const [s0, c0, sl0, cl0] = u.centerSineCosine;
    const center = [ar.mul(sl0, c0), s0, ar.mul(cl0, c0)];
    const lift = ar.div(elevation, GLOBE_RADIUS);
    const offset = sphere.map((d, i) => ar.add(d, ar.mul(ar.add(center[i] as number, d), lift)));
    const globe = transformBy(ar, u.mainMatrix, [...offset, 0]);
    if (u.transition > GLOBE_ONLY) {
      return [
        ar.add(c[0], globe[0] as number),
        ar.add(c[1], globe[1] as number),
        0,
        ar.add(c[3], globe[3] as number),
      ];
    }
    const flat = transformBy(ar, u.fallbackMatrix, [mercator[0], mercator[1], elevation, 0]);
    const t = u.transition;
    const mix = (a: number, b: number): number => ar.add(ar.mul(a, ar.sub(1, t)), ar.mul(b, t));
    return [
      ar.add(c[0], mix(flat[0] as number, globe[0] as number)),
      ar.add(c[1], mix(flat[1] as number, globe[1] as number)),
      0,
      ar.add(c[3], mix(flat[3] as number, globe[3] as number)),
    ];
  }
  const flat = transformBy(ar, u.mainMatrix, [mercator[0], mercator[1], elevation, 0]);
  return flat.map((v, i) => ar.add(v, c[i] as number));
}

/** `project_offset_to_clipspace`: clip space of a position given by its offset in degrees */
export function projectOffsetToClip(
  ar: Arithmetic,
  lngOffset: number,
  latOffset: number,
  u: ShaderUniforms,
): number[] {
  const halfLat = offsetSineCosine(ar, ar.mul(latOffset, HALF_DEGREE));
  const mercator: [number, number] = [
    ar.mul(lngOffset, PER_DEGREE),
    mercatorOffsetY(ar, halfLat, u),
  ];
  return projectCenterOffset(ar, mercator, lngOffset, halfLat, 0, u);
}

/** `half_latitude_of_mercator_offset`: sin and cos of half the latitude offset of a Mercator y offset */
export function halfLatitudeOfMercatorOffset(
  ar: Arithmetic,
  dy: number,
  u: ShaderUniforms,
): [number, number] {
  const [s0, c0] = u.centerSineCosine;
  const x = ar.mul(PI_32, dy);
  const a = Math.abs(x);
  let t: number;
  if (a < SERIES_LIMIT) {
    t = ar.mul(a, horner(ar, ar.mul(a, a), TANH));
  } else {
    const e = ar.exp(ar.mul(-2, a));
    t = ar.div(ar.sub(1, e), ar.add(1, e));
  }
  const w = x > 0 ? -t : t;
  const tanHalf = ar.div(ar.mul(w, c0), ar.add(1, ar.mul(w, s0)));
  const c = ar.inversesqrt(ar.add(1, ar.mul(tanHalf, tanHalf)));
  return [ar.mul(tanHalf, c), c];
}

/** `project_mercator_offset_to_clipspace`: clip space of a position given by its Mercator offset */
export function projectMercatorOffsetToClip(
  ar: Arithmetic,
  mercator: readonly [number, number],
  u: ShaderUniforms,
): number[] {
  const halfLat = halfLatitudeOfMercatorOffset(ar, mercator[1], u);
  return projectCenterOffset(ar, mercator, ar.mul(mercator[0], 360), halfLat, 0, u);
}

/** The Mercator offset of a position given by its offset in degrees (`project_offset`) */
export function mercatorOffsetOf(
  ar: Arithmetic,
  lngOffset: number,
  latOffset: number,
  u: ShaderUniforms,
): [number, number] {
  const halfLat = offsetSineCosine(ar, ar.mul(latOffset, HALF_DEGREE));
  return [ar.mul(lngOffset, PER_DEGREE), mercatorOffsetY(ar, halfLat, u)];
}

/**
 * `stationClip` of the line shader on the globe: clip space of the point at `t` along the straight
 * line of the Mercator plane between two positions given by their offsets in degrees
 */
export function stationClip(
  ar: Arithmetic,
  a: readonly [number, number],
  b: readonly [number, number],
  t: number,
  u: ShaderUniforms,
): number[] {
  const ma = mercatorOffsetOf(ar, a[0], a[1], u);
  const mb = mercatorOffsetOf(ar, b[0], b[1], u);
  const s = ar.sub(1, t);
  const mercator: [number, number] = [
    ar.add(ar.mul(ma[0], s), ar.mul(mb[0], t)),
    ar.add(ar.mul(ma[1], s), ar.mul(mb[1], t)),
  ];
  return projectMercatorOffsetToClip(ar, mercator, u);
}

// ============================================================================
// The matrices maplibre builds
// ============================================================================

type Mutable = number[];

const identity = (): Mutable => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function multiply(a: Matrix, b: Matrix): Mutable {
  const out = new Array<number>(16).fill(0);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += (a[k * 4 + r] as number) * (b[c * 4 + k] as number);
      out[c * 4 + r] = s;
    }
  }
  return out;
}

const translation = (x: number, y: number, z: number): Mutable => {
  const m = identity();
  m[12] = x;
  m[13] = y;
  m[14] = z;
  return m;
};
const scaling = (x: number, y: number, z: number): Mutable => {
  const m = identity();
  m[0] = x;
  m[5] = y;
  m[10] = z;
  return m;
};
const rotationX = (a: number): Mutable => {
  const m = identity();
  const c = Math.cos(a);
  const s = Math.sin(a);
  m[5] = c;
  m[6] = s;
  m[9] = -s;
  m[10] = c;
  return m;
};
const rotationY = (a: number): Mutable => {
  const m = identity();
  const c = Math.cos(a);
  const s = Math.sin(a);
  m[0] = c;
  m[2] = -s;
  m[8] = s;
  m[10] = c;
  return m;
};
const rotationZ = (a: number): Mutable => {
  const m = identity();
  const c = Math.cos(a);
  const s = Math.sin(a);
  m[0] = c;
  m[1] = s;
  m[4] = -s;
  m[5] = c;
  return m;
};
function perspective(fovy: number, aspect: number, near: number, far: number): Mutable {
  const f = 1 / Math.tan(fovy / 2);
  const m = new Array<number>(16).fill(0);
  m[0] = f / aspect;
  m[5] = f;
  m[10] = (far + near) / (near - far);
  m[11] = -1;
  m[14] = (2 * far * near) / (near - far);
  return m;
}

/** A camera of a test */
export interface TestCamera {
  center: readonly [number, number];
  zoom: number;
  pitch?: number;
  bearing?: number;
  width: number;
  height: number;
  /** The near and the far plane of the Mercator matrix (pixels; 1 and 100 times the distance) */
  near?: number;
  far?: number;
}

const FOV = 0.6435011087932844;

/** The distance from the camera to the center of the view, in pixels (maplibre's) */
const cameraDistance = (height: number): number => (0.5 / Math.tan(FOV / 2)) * height;

/**
 * The matrix maplibre gives a custom layer on Web Mercator: from the Mercator coordinates (z in
 * Mercator units) to clip space
 */
export function mercatorMatrix(camera: TestCamera): number[] {
  const worldSize = 512 * 2 ** camera.zoom;
  const [cx, cy] = mercatorOf(camera.center[0], camera.center[1]);
  const d = cameraDistance(camera.height);
  let m = perspective(FOV, camera.width / camera.height, camera.near ?? 1, camera.far ?? d * 100);
  m = multiply(m, scaling(1, -1, 1));
  m = multiply(m, translation(0, 0, -d));
  m = multiply(m, rotationX((camera.pitch ?? 0) * DEG));
  m = multiply(m, rotationZ((camera.bearing ?? 0) * DEG));
  m = multiply(m, translation(-cx * worldSize, -cy * worldSize, 0));
  return multiply(m, scaling(worldSize, worldSize, worldSize));
}

/** The matrix maplibre gives a custom layer on the globe: from the unit sphere to clip space */
export function globeMatrix(camera: TestCamera): number[] {
  const worldSize = 512 * 2 ** camera.zoom;
  const radius = worldSize / (2 * Math.PI) / Math.cos(camera.center[1] * DEG);
  const d = cameraDistance(camera.height);
  let m = perspective(FOV, camera.width / camera.height, 0.5, d + radius * 2);
  m = multiply(m, translation(0, 0, -d));
  m = multiply(m, rotationX(-(camera.pitch ?? 0) * DEG));
  m = multiply(m, rotationZ((camera.bearing ?? 0) * DEG));
  m = multiply(m, translation(0, 0, -radius));
  m = multiply(m, rotationX(camera.center[1] * DEG));
  m = multiply(m, rotationY(-camera.center[0] * DEG));
  return multiply(m, scaling(radius, radius, radius));
}

/** The projection of a frame on Web Mercator, on the globe, or in the transition between */
export function frameProjection(camera: TestCamera, transition: number): FrameProjection {
  const mercator = mercatorMatrix(camera);
  if (transition <= 0) {
    return {
      mainMatrix: mercator,
      fallbackMatrix: mercator,
      projectionTransition: 0,
      clippingPlane: [0, 0, 0, 0],
    };
  }
  return {
    mainMatrix: globeMatrix(camera),
    fallbackMatrix: mercator,
    projectionTransition: transition,
    clippingPlane: [0, 0, 1, 0],
  };
}
