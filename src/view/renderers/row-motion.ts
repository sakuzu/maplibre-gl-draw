// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The motion of a moving set of rows on the GPU: the move, rotation or scaling of an edit
 * (`geometry/enu-transforms.ts`), computed by the same formulas as the edit written once the rows
 * are let go, in float32
 *
 * An edit moves the earth-centred coordinates of the positions by one affine map `Y = L X + t`
 * (on the WGS 84 ellipsoid, at height 0). An affine map keeps differences, `Y − Y_R = L (X − X_R)`,
 * so the GPU works only with the differences from a reference point R: no large value (an
 * earth-centred coordinate, the distance to the center of the edit) is ever in a float32.
 *
 * R is the place the center K of the camera is moved from: the image of K under the inverse map,
 * brought onto the ellipsoid, then corrected until its image S is on K. The CPU computes R, S and
 * the values below in float64 for every draw (K changes with the camera, the origin of the offsets
 * with the batch); the positions seen near K come from near R, so every value the GPU computes is
 * about as large as the region on the screen.
 *
 * The GPU, for an offset `o` of a position from the origin O of its batch (degrees):
 *
 * - `q = o + (O − R)`: the longitude and the latitude of the position from R
 * - The difference of its earth-centred coordinates from those of R, in the axes of R turned by
 *   the longitude of R, by the formulas of the differences of the sine and the cosine (which do
 *   not cancel for small differences) and of the radius of curvature in the prime vertical N
 * - The 3 × 3 matrix `Rz(−λ_S) L Rz(λ_R)`: the difference from S, in the axes of S
 * - Back to the longitude and the latitude from S: the longitude exactly, the latitude by three
 *   steps of the fixed point `φ = atan2(z + e² N sin φ, p)` written as differences
 * - Plus `S − K`: the position from K, which is handed to the projection as it is (the offset is
 *   then taken from the center, not from the origin of the batch: `g_offset_from_center`)
 *
 * The sine, the cosine and the arctangent of small values are taken from their series, as a GPU's
 * own functions may be off by a float32 step of 1, a large share of a small sine.
 *
 * `moveOffsetFloat32` computes the same in JavaScript, every operation rounded to float32, in the
 * order the GLSL writes it: the tests measure with it how far what is drawn is from what is
 * written.
 */

import { type EnuEdit, enuAffineOf } from '../../geometry/enu-transforms.js';

const DEGREE = Math.PI / 180;
const RADIAN = 180 / Math.PI;
/** The semi-major axis of WGS 84, in metres */
const SEMI_MAJOR_AXIS = 6378137;
/** The flattening of WGS 84 */
const FLATTENING = 1 / 298.257223563;
/** The square of the first eccentricity of WGS 84 */
const ECCENTRICITY_SQUARED = FLATTENING * (2 - FLATTENING);
/** The times R is corrected so that its image is on K */
const REFERENCE_STEPS = 3;
/** The steps of the latitude on the GPU */
const LATITUDE_STEPS = 3;

/** The number of motions the uniforms hold: two (any row, a row that keeps its shape) per set */
export const MOTION_SLOTS = 6;

/**
 * The GLSL of the motions (part of `ROW_STATE_GLSL`, after `OFFSET_MODE_GLSL`)
 *
 * The values of the motion of slot k (`2 (set − 1) + 1` for a row that keeps its shape):
 *
 * - `u_motion_rows[3k + i]`: the row i of the matrix, and in w the values A and B of S
 *   (`(N_S + h_S) sin φ_S`, `(N_S + h_S) cos φ_S`) in the first two
 * - `u_motion_offsets[k]`: `O − R` and `S − K` (degrees)
 * - `u_motion_from[k]`, `u_motion_to[k]`: the sine and the cosine of the latitude, `w` and N of R
 *   and of S
 */
export const ROW_MOTION_GLSL = `
uniform vec4 u_motion_rows[${MOTION_SLOTS * 3}];
uniform vec4 u_motion_offsets[${MOTION_SLOTS}];
uniform vec4 u_motion_from[${MOTION_SLOTS}];
uniform vec4 u_motion_to[${MOTION_SLOTS}];

const float MOTION_E2 = ${glslNumber(ECCENTRICITY_SQUARED)};
const float MOTION_A = ${glslNumber(SEMI_MAJOR_AXIS)};
const float MOTION_ONE_MINUS_E2 = ${glslNumber(1 - ECCENTRICITY_SQUARED)};
const float MOTION_HALF_DEGREE = ${glslNumber(Math.PI / 360)};
const float MOTION_DEGREE = ${glslNumber(DEGREE)};
const float MOTION_RADIAN = ${glslNumber(RADIAN)};

// The change of sin φ, of cos φ and of N, and N after it, when the latitude moves by delta (rad)
// from the one of base (its sine, its cosine, w and N)
vec4 rowMotionStep(vec4 base, float delta) {
    vec2 h = rowSinCos(delta * 0.5);
    float ds = 2.0 * (base.y * h.y - base.x * h.x) * h.x;
    float dc = -2.0 * (base.x * h.y + base.y * h.x) * h.x;
    float s1 = base.x + ds;
    float w1 = sqrt(1.0 - MOTION_E2 * (s1 * s1));
    float dw = -MOTION_E2 * ds * (base.x + s1) / (base.z + w1);
    float dn = -MOTION_A * dw / (base.z * w1);
    return vec4(ds, dc, dn, base.w + dn);
}

// A position moved by the motion of slot k: from its offset from the origin of the batch to its
// offset from the center of the camera
vec2 rowMotionMove(int k, vec2 offset) {
    vec4 offsets = u_motion_offsets[k];
    vec4 atR = u_motion_from[k];
    vec2 q = offset + offsets.xy;
    // The earth-centred difference from R, in the axes of R
    vec2 l = rowSinCos(q.x * MOTION_HALF_DEGREE);
    vec4 d = rowMotionStep(atR, q.y * MOTION_DEGREE);
    float dnc = d.w * d.y + d.z * atR.y;
    float dns = d.w * d.x + d.z * atR.x;
    float nc1 = d.w * (atR.y + d.y);
    vec3 e = vec3(dnc - nc1 * 2.0 * (l.x * l.x), nc1 * 2.0 * (l.x * l.y), MOTION_ONE_MINUS_E2 * dns);
    // The difference from S, in the axes of S
    vec4 r0 = u_motion_rows[3 * k];
    vec4 r1 = u_motion_rows[3 * k + 1];
    vec4 r2 = u_motion_rows[3 * k + 2];
    vec3 w = vec3(
        r0.x * e.x + r0.y * e.y + r0.z * e.z,
        r1.x * e.x + r1.y * e.y + r1.z * e.z,
        r2.x * e.x + r2.y * e.y + r2.z * e.z
    );
    // Back to the longitude and the latitude from S
    vec4 atS = u_motion_to[k];
    float capA = r0.w;
    float capB = r1.w;
    float bp = capB + w.x;
    float dLon = rowAtan(w.y / bp);
    float p = sqrt(bp * bp + w.y * w.y);
    float dp = (w.x * (2.0 * capB + w.x) + w.y * w.y) / (p + capB);
    float dT = 0.0;
    float delta = 0.0;
    for (int i = 0; i < ${LATITUDE_STEPS}; i++) {
        float zt = w.z + dT;
        float num = zt * capB - capA * dp;
        float den = capB * (capB + dp) + capA * (capA + zt);
        delta = rowAtan(num / den);
        if (i + 1 < ${LATITUDE_STEPS}) {
            vec4 s = rowMotionStep(atS, delta);
            dT = MOTION_E2 * (s.w * s.x + s.z * atS.x);
        }
    }
    return vec2(dLon * MOTION_RADIAN + offsets.z, delta * MOTION_RADIAN + offsets.w);
}
`;

/** A number as a GLSL float literal */
function glslNumber(value: number): string {
  const text = String(value);
  return /[.eE]/.test(text) ? text : `${text}.0`;
}

// === float64: the values of the uniforms ===

/** The earth-centred coordinates of a longitude and a latitude at height 0 */
function earthCentred(lon: number, lat: number): [number, number, number] {
  const l = lon * DEGREE;
  const p = lat * DEGREE;
  const s = Math.sin(p);
  const c = Math.cos(p);
  const n = SEMI_MAJOR_AXIS / Math.sqrt(1 - ECCENTRICITY_SQUARED * s * s);
  return [n * c * Math.cos(l), n * c * Math.sin(l), n * (1 - ECCENTRICITY_SQUARED) * s];
}

/** The longitude, the latitude and the height of earth-centred coordinates */
function geodetic(x: number, y: number, z: number): [number, number, number] {
  const p = Math.hypot(x, y);
  const lon = Math.atan2(y, x) * RADIAN;
  let lat = Math.atan2(z, p * (1 - ECCENTRICITY_SQUARED));
  for (let k = 0; k < 8; k++) {
    const s = Math.sin(lat);
    const n = SEMI_MAJOR_AXIS / Math.sqrt(1 - ECCENTRICITY_SQUARED * s * s);
    lat = Math.atan2(z + ECCENTRICITY_SQUARED * n * s, p);
  }
  const s = Math.sin(lat);
  const c = Math.cos(lat);
  const n = SEMI_MAJOR_AXIS / Math.sqrt(1 - ECCENTRICITY_SQUARED * s * s);
  const h = Math.abs(c) > 0.5 ? p / c - n : z / s - n * (1 - ECCENTRICITY_SQUARED);
  return [lon, lat * RADIAN, h];
}

/** A longitude difference within [-180, 180) */
function wrapped(delta: number): number {
  return delta - 360 * Math.floor((delta + 180) / 360);
}

/** The inverse of a 3 × 3 matrix given row first */
function inverse3(m: Float64Array): number[] {
  const [a, b, c, d, e, f, g, h, i] = m as unknown as number[];
  const ai = e * i - f * h;
  const bi = -(d * i - f * g);
  const ci = d * h - e * g;
  const det = a * ai + b * bi + c * ci;
  return [
    ai / det,
    -(b * i - c * h) / det,
    (b * f - c * e) / det,
    bi / det,
    (a * i - c * g) / det,
    -(a * f - c * d) / det,
    ci / det,
    -(a * h - b * g) / det,
    (a * e - b * d) / det,
  ];
}

/**
 * The values of a motion for a center of the camera, which do not depend on the batch drawn
 *
 * @internal
 */
export interface MotionFrame {
  /** R: where the center of the camera is moved from */
  readonly fromLon: number;
  readonly fromLat: number;
  /** S minus the center of the camera (degrees) */
  readonly toOffsetLon: number;
  readonly toOffsetLat: number;
  /** The matrix, row first */
  readonly matrix: readonly number[];
  /** The sine and the cosine of the latitude, w and N of R and of S */
  readonly from: readonly [number, number, number, number];
  readonly to: readonly [number, number, number, number];
  /** A and B of S */
  readonly capA: number;
  readonly capB: number;
}

/**
 * The values of the motion of an edit for a center of the camera (null when the edit moves no
 * position: the rows are drawn where they are)
 *
 * @param uniformScale Whether the rows keep their shape (a scaling by `sizeFactor`)
 * @param center The center the projection takes the offsets from (`u_center_lnglat`)
 * @internal
 */
export function motionFrameOf(
  edit: EnuEdit,
  uniformScale: boolean,
  center: readonly [number, number],
): MotionFrame | null {
  const affine = enuAffineOf(edit, uniformScale);
  return affine ? frameOfAffine(affine.matrix, affine.offset, center) : null;
}

/**
 * The values of the motion that moves nothing, for a center of the camera (the rows that keep
 * their shape under a scaling that moves only the others)
 *
 * @internal
 */
export function stillMotionFrame(center: readonly [number, number]): MotionFrame {
  return frameOfAffine(
    Float64Array.of(1, 0, 0, 0, 1, 0, 0, 0, 1),
    Float64Array.of(0, 0, 0),
    center,
  );
}

/** The values of the motion of an affine map of the earth-centred coordinates */
function frameOfAffine(
  L: Float64Array,
  t: Float64Array,
  center: readonly [number, number],
): MotionFrame {
  const apply = (x: readonly number[]): [number, number, number] => [
    (L[0] as number) * (x[0] as number) +
      (L[1] as number) * (x[1] as number) +
      (L[2] as number) * (x[2] as number) +
      (t[0] as number),
    (L[3] as number) * (x[0] as number) +
      (L[4] as number) * (x[1] as number) +
      (L[5] as number) * (x[2] as number) +
      (t[1] as number),
    (L[6] as number) * (x[0] as number) +
      (L[7] as number) * (x[1] as number) +
      (L[8] as number) * (x[2] as number) +
      (t[2] as number),
  ];
  const [kLon, kLat] = center;
  // R: the image of K under the inverse map, brought onto the ellipsoid
  const inv = inverse3(L);
  const xk = earthCentred(kLon, kLat);
  const d = [xk[0] - (t[0] as number), xk[1] - (t[1] as number), xk[2] - (t[2] as number)];
  const pre = [
    (inv[0] as number) * (d[0] as number) +
      (inv[1] as number) * (d[1] as number) +
      (inv[2] as number) * (d[2] as number),
    (inv[3] as number) * (d[0] as number) +
      (inv[4] as number) * (d[1] as number) +
      (inv[5] as number) * (d[2] as number),
    (inv[6] as number) * (d[0] as number) +
      (inv[7] as number) * (d[1] as number) +
      (inv[8] as number) * (d[2] as number),
  ];
  let [rLon, rLat] = geodetic(pre[0] as number, pre[1] as number, pre[2] as number);
  let sLon = kLon;
  let sLat = kLat;
  let sH = 0;
  // Its image S is off K by the height dropped: R is moved until S is on K
  for (let k = 0; k <= REFERENCE_STEPS; k++) {
    const y = apply(earthCentred(rLon, rLat));
    [sLon, sLat, sH] = geodetic(y[0], y[1], y[2]);
    sLon = kLon + wrapped(sLon - kLon);
    if (k < REFERENCE_STEPS) {
      rLon += kLon - sLon;
      rLat = Math.max(-90, Math.min(90, rLat + kLat - sLat));
    }
  }
  const sinR = Math.sin(rLat * DEGREE);
  const cosR = Math.cos(rLat * DEGREE);
  const sinS = Math.sin(sLat * DEGREE);
  const cosS = Math.cos(sLat * DEGREE);
  const wR = Math.sqrt(1 - ECCENTRICITY_SQUARED * sinR * sinR);
  const wS = Math.sqrt(1 - ECCENTRICITY_SQUARED * sinS * sinS);
  const nS = SEMI_MAJOR_AXIS / wS;
  // Rz(−λ_S) L Rz(λ_R)
  const cr = Math.cos(rLon * DEGREE);
  const sr = Math.sin(rLon * DEGREE);
  const cs = Math.cos(sLon * DEGREE);
  const ss = Math.sin(sLon * DEGREE);
  const lr: number[] = [];
  for (let i = 0; i < 3; i++) {
    const l0 = L[i * 3] as number;
    const l1 = L[i * 3 + 1] as number;
    const l2 = L[i * 3 + 2] as number;
    lr.push(l0 * cr + l1 * sr, -l0 * sr + l1 * cr, l2);
  }
  const matrix: number[] = [];
  for (let j = 0; j < 3; j++) {
    matrix.push(cs * (lr[j] as number) + ss * (lr[3 + j] as number));
  }
  for (let j = 0; j < 3; j++) {
    matrix.push(-ss * (lr[j] as number) + cs * (lr[3 + j] as number));
  }
  for (let j = 0; j < 3; j++) matrix.push(lr[6 + j] as number);
  return {
    fromLon: rLon,
    fromLat: rLat,
    toOffsetLon: sLon - kLon,
    toOffsetLat: sLat - kLat,
    matrix,
    from: [sinR, cosR, wR, SEMI_MAJOR_AXIS / wR],
    to: [sinS, cosS, wS, nS],
    capA: (nS + sH) * sinS,
    capB: (nS + sH) * cosS,
  };
}

/**
 * The values of the uniforms of the motions, for one draw
 *
 * @internal
 */
export class MotionUniformValues {
  readonly rows = new Float32Array(MOTION_SLOTS * 12);
  readonly offsets = new Float32Array(MOTION_SLOTS * 4);
  readonly from = new Float32Array(MOTION_SLOTS * 4);
  readonly to = new Float32Array(MOTION_SLOTS * 4);

  constructor(fill = 0) {
    for (const array of [this.rows, this.offsets, this.from, this.to]) array.fill(fill);
  }

  /**
   * Writes the values of a motion into a slot, for the origin the offsets of the batch are taken
   * from (computed in float64, rounded once to float32)
   */
  write(slot: number, frame: MotionFrame, origin: readonly [number, number]): void {
    const m = frame.matrix;
    const rows = this.rows;
    for (let i = 0; i < 3; i++) {
      const at = (slot * 3 + i) * 4;
      rows[at] = m[i * 3] as number;
      rows[at + 1] = m[i * 3 + 1] as number;
      rows[at + 2] = m[i * 3 + 2] as number;
      rows[at + 3] = i === 0 ? frame.capA : i === 1 ? frame.capB : 0;
    }
    const at = slot * 4;
    // R is taken a whole number of turns from where it is, nearest to the origin
    this.offsets[at] = wrapped(origin[0] - frame.fromLon);
    this.offsets[at + 1] = origin[1] - frame.fromLat;
    this.offsets[at + 2] = frame.toOffsetLon;
    this.offsets[at + 3] = frame.toOffsetLat;
    this.from.set(frame.from, at);
    this.to.set(frame.to, at);
  }

  /** Copies the values of a slot into another */
  copySlot(from: number, to: number): void {
    this.rows.copyWithin(to * 12, from * 12, from * 12 + 12);
    for (const array of [this.offsets, this.from, this.to]) {
      array.copyWithin(to * 4, from * 4, from * 4 + 4);
    }
  }

  copy(other: MotionUniformValues): void {
    this.rows.set(other.rows);
    this.offsets.set(other.offsets);
    this.from.set(other.from);
    this.to.set(other.to);
  }
}

// === float32: the GLSL in JavaScript ===

const f = Math.fround;
const F_E2 = f(ECCENTRICITY_SQUARED);
const F_A = f(SEMI_MAJOR_AXIS);
const F_ONE_MINUS_E2 = f(1 - ECCENTRICITY_SQUARED);
const F_HALF_DEGREE = f(Math.PI / 360);
const F_DEGREE = f(DEGREE);
const F_RADIAN = f(RADIAN);
const F_THIRD = f(1 / 3);
const F_FIFTH = f(0.2);
const F_SEVENTH = f(1 / 7);

/** `rowSinCos` of `ROW_STATE_GLSL` in float32 (the built-in functions taken as correctly rounded) */
function sinCos32(x: number): [number, number] {
  if (Math.abs(x) < 0.1) {
    const x2 = f(x * x);
    const s = f(x * f(1 - f(f(x2 / 6) * f(1 - f(f(x2 / 20) * f(1 - f(x2 / 42)))))));
    const c = f(1 - f(f(x2 / 2) * f(1 - f(f(x2 / 12) * f(1 - f(x2 / 30))))));
    return [s, c];
  }
  return [f(Math.sin(x)), f(Math.cos(x))];
}

/** `rowAtan` of `ROW_STATE_GLSL` in float32 */
function atan32(x: number): number {
  if (Math.abs(x) < 0.1) {
    const x2 = f(x * x);
    const t4 = f(F_SEVENTH - f(x2 / 9));
    const t3 = f(F_FIFTH - f(x2 * t4));
    const t2 = f(F_THIRD - f(x2 * t3));
    return f(x * f(1 - f(x2 * t2)));
  }
  return f(Math.atan(x));
}

/** `rowMotionStep` in float32 */
function step32(
  base: ArrayLike<number>,
  at: number,
  delta: number,
): [number, number, number, number] {
  const s = base[at] as number;
  const c = base[at + 1] as number;
  const w = base[at + 2] as number;
  const n = base[at + 3] as number;
  const [hs, hc] = sinCos32(f(delta * 0.5));
  const ds = f(f(2 * f(f(c * hc) - f(s * hs))) * hs);
  const dc = f(f(-2 * f(f(s * hc) + f(c * hs))) * hs);
  const s1 = f(s + ds);
  const w1 = f(Math.sqrt(f(1 - f(F_E2 * f(s1 * s1)))));
  const dw = f(f(f(-F_E2 * ds) * f(s + s1)) / f(w + w1));
  const dn = f(f(-F_A * dw) / f(w * w1));
  return [ds, dc, dn, f(n + dn)];
}

/**
 * A position moved by the motion of a slot, as the GPU moves it (`rowMotionMove`), every operation
 * rounded to float32: from its offset from the origin of the batch to its offset from the center
 * of the camera, in degrees
 *
 * @param offset The offset of the position from the origin, as the batch holds it (float32)
 * @internal
 */
export function moveOffsetFloat32(
  values: MotionUniformValues,
  slot: number,
  offset: readonly [number, number],
): [number, number] {
  const at = slot * 4;
  const o = values.offsets;
  const from = values.from;
  const to = values.to;
  const rows = values.rows;
  const qx = f(offset[0] + (o[at] as number));
  const qy = f(offset[1] + (o[at + 1] as number));
  const [ls, lc] = sinCos32(f(qx * F_HALF_DEGREE));
  const [ds, dc, dn, n1] = step32(from, at, f(qy * F_DEGREE));
  const fs = from[at] as number;
  const fc = from[at + 1] as number;
  const dnc = f(f(n1 * dc) + f(dn * fc));
  const dns = f(f(n1 * ds) + f(dn * fs));
  const nc1 = f(n1 * f(fc + dc));
  const e = [
    f(dnc - f(f(nc1 * 2) * f(ls * ls))),
    f(f(nc1 * 2) * f(ls * lc)),
    f(F_ONE_MINUS_E2 * dns),
  ];
  const w = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    const r = (slot * 3 + i) * 4;
    w[i] = f(
      f(f((rows[r] as number) * (e[0] as number)) + f((rows[r + 1] as number) * (e[1] as number))) +
        f((rows[r + 2] as number) * (e[2] as number)),
    );
  }
  const capA = rows[slot * 12 + 3] as number;
  const capB = rows[slot * 12 + 7] as number;
  const [wx, wy, wz] = w as [number, number, number];
  const bp = f(capB + wx);
  const dLon = atan32(f(wy / bp));
  const p = f(Math.sqrt(f(f(bp * bp) + f(wy * wy))));
  const dp = f(f(f(wx * f(f(2 * capB) + wx)) + f(wy * wy)) / f(p + capB));
  let dT = 0;
  let delta = 0;
  for (let i = 0; i < LATITUDE_STEPS; i++) {
    const zt = f(wz + dT);
    const num = f(f(zt * capB) - f(capA * dp));
    const den = f(f(capB * f(capB + dp)) + f(capA * f(capA + zt)));
    delta = atan32(f(num / den));
    if (i + 1 < LATITUDE_STEPS) {
      const [sds, , sdn, sn1] = step32(to, at, delta);
      dT = f(F_E2 * f(f(sn1 * sds) + f(sdn * (to[at] as number))));
    }
  }
  return [
    f(f(dLon * F_RADIAN) + (o[at + 2] as number)),
    f(f(delta * F_RADIAN) + (o[at + 3] as number)),
  ];
}
