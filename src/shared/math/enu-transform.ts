// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The built-in computation of moves, rotations and scalings, in the shape of a
 * {@link TransformProvider}: arrays of positions and of values per feature in, arrays out
 *
 * The positions are longitudes and latitudes in degrees on the WGS 84 ellipsoid. Each is taken at
 * height 0 into the earth-centred coordinates, written in the east, north and up frame of a point
 * and turned back:
 *
 * - A move from P to Q: `X' = O_Q + B_Q B_Pᵀ (X − O_P)`, where `O_P` is the earth-centred position
 *   of P and `B_P` the matrix whose columns are the east, north and up of P
 * - A rotation about C by an angle, counterclockwise seen from above:
 *   `X' = O_C + B_C R B_Cᵀ (X − O_C)`, `R` turning east toward north about up
 * - A scaling about C by sx along the east and sy along the north:
 *   `X' = O_C + B_C diag(sx, sy, √(sx·sy)) B_Cᵀ (X − O_C)`. A feature that keeps its shape
 *   (`isScaledUniformly`) moves by `sizeFactor` along both in place of sx and sy
 *
 * The frame of a point is built from its longitude and latitude, so it is defined at the poles
 * too. A position turned back onto the axis of the poles keeps the longitude it had. Each
 * longitude is the value nearest to the one it had (for a move, plus the longitude of Q less that
 * of P), so the longitudes of a feature across the ±180 degree meridian stay together, and are
 * not brought within [-180, 180]. A position that is bit for bit the center of a rotation or a
 * scaling stays as it is. The numbers of a position past the longitude and the latitude are
 * copied, and are not read.
 *
 * An operation that moves no position (a move to the same point, a rotation by 0, a scaling whose
 * factors are 1) copies the positions as they are. The values per feature follow the contract of
 * {@link TransformInput}: a rotation adds its angle to the rotation and takes it from the
 * direction, each then within [0, 360); a scaling multiplies the size by `sizeFactor`.
 *
 * It computes every operation of finite numbers whose factors are above 0, near the poles and
 * across the ±180 degree meridian too. It is computed with the functions of `Math`: the same
 * values give the same bits on one device, not on every device. The result of a feature depends on
 * the operation and on its own values only.
 */

import type {
  TransformInput,
  TransformOperation,
  TransformOutput,
  TransformProvider,
} from '../types/model.js';

const DEGREE = Math.PI / 180;
const RADIAN = 180 / Math.PI;
/** The semi-major axis of WGS 84, in metres */
const SEMI_MAJOR_AXIS = 6378137;
/** The flattening of WGS 84 */
const FLATTENING = 1 / 298.257223563;
/** The square of the first eccentricity of WGS 84 */
const ECCENTRICITY_SQUARED = FLATTENING * (2 - FLATTENING);
const FULL_TURN = 360;

/** Whether a value is a finite number */
function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Whether a value is a point of an operation: an array whose first two numbers are finite */
function isPoint(value: unknown): value is readonly number[] {
  return (
    Array.isArray(value) &&
    value.length >= 2 &&
    isFiniteNumber(value[0]) &&
    isFiniteNumber(value[1])
  );
}

/** Whether a value is a factor of a scaling: finite and above 0 */
function isFactor(value: unknown): value is number {
  return isFiniteNumber(value) && value > 0;
}

/**
 * Whether the built-in computation computes an operation: its points finite, its angle finite and
 * its factors finite and above 0
 *
 * @internal
 */
export function acceptsBuiltInTransform(operation: TransformOperation): boolean {
  if (typeof operation !== 'object' || operation === null) return false;
  switch (operation.kind) {
    case 'translate':
      return isPoint(operation.from) && isPoint(operation.to);
    case 'rotate':
      return isPoint(operation.center) && isFiniteNumber(operation.counterclockwiseDegrees);
    case 'scale':
      return (
        isPoint(operation.center) &&
        isFactor(operation.eastFactor) &&
        isFactor(operation.northFactor) &&
        isFactor(operation.sizeFactor)
      );
    default:
      return false;
  }
}

/**
 * The earth-centred position of a point and the east, north and up of its frame:
 * [x, y, z, east x, east y, east z, north x, north y, north z, up x, up y, up z]
 */
type Frame = Float64Array;

/** Writes the earth-centred coordinates of a longitude and a latitude at height 0 into `out` */
function toEarthCentred(lon: number, lat: number, out: Float64Array): void {
  const l = lon * DEGREE;
  const p = lat * DEGREE;
  const sinP = Math.sin(p);
  const cosP = Math.cos(p);
  const n = SEMI_MAJOR_AXIS / Math.sqrt(1 - ECCENTRICITY_SQUARED * sinP * sinP);
  out[0] = n * cosP * Math.cos(l);
  out[1] = n * cosP * Math.sin(l);
  out[2] = n * (1 - ECCENTRICITY_SQUARED) * sinP;
}

/** The frame of a point at height 0, built from its longitude and latitude */
function frameAt(lon: number, lat: number): Frame {
  const l = lon * DEGREE;
  const p = lat * DEGREE;
  const sinP = Math.sin(p);
  const cosP = Math.cos(p);
  const sinL = Math.sin(l);
  const cosL = Math.cos(l);
  const frame = new Float64Array(12);
  toEarthCentred(lon, lat, frame);
  // East
  frame[3] = -sinL;
  frame[4] = cosL;
  frame[5] = 0;
  // North: up × east
  frame[6] = -sinP * cosL;
  frame[7] = -sinP * sinL;
  frame[8] = cosP;
  // Up
  frame[9] = cosP * cosL;
  frame[10] = cosP * sinL;
  frame[11] = sinP;
  return frame;
}

/**
 * The longitude and the latitude of earth-centred coordinates, into `out`. A point on the axis of
 * the poles keeps the longitude `lon` it had
 */
function fromEarthCentred(x: number, y: number, z: number, lon: number, out: Float64Array): void {
  const p = Math.sqrt(x * x + y * y);
  let lat = Math.atan2(z, p * (1 - ECCENTRICITY_SQUARED));
  for (let i = 0; i < 3; i++) {
    const s = Math.sin(lat);
    const n = SEMI_MAJOR_AXIS / Math.sqrt(1 - ECCENTRICITY_SQUARED * s * s);
    lat = Math.atan2(z + ECCENTRICITY_SQUARED * n * s, p);
  }
  const latitude = lat * RADIAN;
  out[0] = latitude === 90 || latitude === -90 ? lon : Math.atan2(y, x) * RADIAN;
  out[1] = latitude;
}

/** The longitude, a whole number of turns from `r`, nearest to the one expected */
function nearest(r: number, expected: number): number {
  return r + FULL_TURN * Math.floor((expected - r) / FULL_TURN + 0.5);
}

/**
 * How an operation moves the positions, once its arguments are read: the earth-centred origin
 * and frame the positions are read in, and those they are written in, with the map of the east
 * and the north between them (`east' = e a + n b`, `north' = e c + n d`, `up' = u up`)
 */
interface Motion {
  readonly from: Frame;
  readonly to: Frame;
  readonly a: number;
  readonly b: number;
  readonly c: number;
  readonly d: number;
  readonly up: number;
  /** The longitude added to the one of a position, before the nearest one is taken */
  readonly shift: number;
  /** The center that stays as it is, bit for bit (a rotation and a scaling) */
  readonly centerLon: number;
  readonly centerLat: number;
  readonly hasCenter: boolean;
}

/** The motion of a scaling by the two factors, null when they are both 1 */
function scaleMotion(
  operation: Extract<TransformOperation, { kind: 'scale' }>,
  east: number,
  north: number,
): Motion | null {
  if (east === 1 && north === 1) return null;
  const centerLon = operation.center[0] as number;
  const centerLat = operation.center[1] as number;
  const frame = frameAt(centerLon, centerLat);
  return {
    from: frame,
    to: frame,
    a: east,
    b: 0,
    c: 0,
    d: north,
    up: Math.sqrt(east * north),
    shift: 0,
    centerLon,
    centerLat,
    hasCenter: true,
  };
}

/**
 * The motions of an operation: the one of the features that do not keep their shape, and the one
 * of those that do (the same but for a scaling); null for one that moves no position
 */
function motionsOf(operation: TransformOperation): [Motion | null, Motion | null] {
  switch (operation.kind) {
    case 'translate': {
      const fromLon = operation.from[0] as number;
      const fromLat = operation.from[1] as number;
      const toLon = operation.to[0] as number;
      const toLat = operation.to[1] as number;
      if (fromLon === toLon && fromLat === toLat) return [null, null];
      const motion: Motion = {
        from: frameAt(fromLon, fromLat),
        to: frameAt(toLon, toLat),
        a: 1,
        b: 0,
        c: 0,
        d: 1,
        up: 1,
        shift: toLon - fromLon,
        centerLon: 0,
        centerLat: 0,
        hasCenter: false,
      };
      return [motion, motion];
    }
    case 'rotate': {
      const angle = operation.counterclockwiseDegrees;
      if (angle === 0) return [null, null];
      const centerLon = operation.center[0] as number;
      const centerLat = operation.center[1] as number;
      const frame = frameAt(centerLon, centerLat);
      const theta = angle * DEGREE;
      const cos = Math.cos(theta);
      const sin = Math.sin(theta);
      const motion: Motion = {
        from: frame,
        to: frame,
        a: cos,
        b: -sin,
        c: sin,
        d: cos,
        up: 1,
        shift: 0,
        centerLon,
        centerLat,
        hasCenter: true,
      };
      return [motion, motion];
    }
    case 'scale':
      return [
        scaleMotion(operation, operation.eastFactor, operation.northFactor),
        scaleMotion(operation, operation.sizeFactor, operation.sizeFactor),
      ];
  }
}

/** Whether two numbers have the same bits */
function sameBits(a: number, b: number): boolean {
  return a === b && (a !== 0 || 1 / a === 1 / b);
}

/**
 * Moves the longitude and the latitude of the position at `offset` of `source` into `target`,
 * with two arrays of scratch of the call (earth-centred, 3 numbers; geographic, 2 numbers)
 */
function movePosition(
  motion: Motion,
  source: Float64Array,
  target: Float64Array,
  offset: number,
  earth: Float64Array,
  geographic: Float64Array,
): void {
  const lon = source[offset] as number;
  const lat = source[offset + 1] as number;
  if (motion.hasCenter && sameBits(lon, motion.centerLon) && sameBits(lat, motion.centerLat)) {
    target[offset] = lon;
    target[offset + 1] = lat;
    return;
  }
  const f = motion.from;
  const t = motion.to;
  toEarthCentred(lon, lat, earth);
  const d0 = (earth[0] as number) - (f[0] as number);
  const d1 = (earth[1] as number) - (f[1] as number);
  const d2 = (earth[2] as number) - (f[2] as number);
  const e = d0 * (f[3] as number) + d1 * (f[4] as number) + d2 * (f[5] as number);
  const n = d0 * (f[6] as number) + d1 * (f[7] as number) + d2 * (f[8] as number);
  const u = d0 * (f[9] as number) + d1 * (f[10] as number) + d2 * (f[11] as number);
  const e2 = e * motion.a + n * motion.b;
  const n2 = e * motion.c + n * motion.d;
  const u2 = u * motion.up;
  const x =
    (t[0] as number) + (t[3] as number) * e2 + (t[6] as number) * n2 + (t[9] as number) * u2;
  const y =
    (t[1] as number) + (t[4] as number) * e2 + (t[7] as number) * n2 + (t[10] as number) * u2;
  const z =
    (t[2] as number) + (t[5] as number) * e2 + (t[8] as number) * n2 + (t[11] as number) * u2;
  fromEarthCentred(x, y, z, lon, geographic);
  target[offset] = nearest(geographic[0] as number, lon + motion.shift);
  target[offset + 1] = geographic[1] as number;
}

/**
 * An angle within [0, 360)
 *
 * @internal
 */
export function withinTurn(value: number): number {
  let r = value - FULL_TURN * Math.floor(value / FULL_TURN);
  if (r < 0) r += FULL_TURN;
  if (r >= FULL_TURN) r -= FULL_TURN;
  return r;
}

/** Writes the rotations, the directions and the sizes after an operation */
function applyValues(
  operation: TransformOperation,
  input: TransformInput,
  output: TransformOutput,
): void {
  const count = input.featureCount;
  const rotations = input.rotationDegrees;
  const rotationsOut = output.rotationDegrees;
  if (rotations && rotationsOut) {
    if (operation.kind === 'rotate') {
      const angle = operation.counterclockwiseDegrees;
      for (let i = 0; i < count; i++) {
        const value = rotations[i] as number;
        rotationsOut[i] = withinTurn((Number.isNaN(value) ? 0 : value) + angle);
      }
    } else {
      rotationsOut.set(rotations.subarray(0, count));
    }
  }
  const bearings = input.bearingDegrees;
  const bearingsOut = output.bearingDegrees;
  if (bearings && bearingsOut) {
    if (operation.kind === 'rotate') {
      const angle = operation.counterclockwiseDegrees;
      for (let i = 0; i < count; i++) {
        const value = bearings[i] as number;
        bearingsOut[i] = Number.isNaN(value) ? value : withinTurn(value - angle);
      }
    } else {
      bearingsOut.set(bearings.subarray(0, count));
    }
  }
  const sizes = input.size;
  const sizesOut = output.size;
  if (sizes && sizesOut) {
    if (operation.kind === 'scale') {
      const factor = operation.sizeFactor;
      for (let i = 0; i < count; i++) {
        const value = sizes[i] as number;
        sizesOut[i] = (Number.isNaN(value) ? 1 : value) * factor;
      }
    } else {
      sizesOut.set(sizes.subarray(0, count));
    }
  }
}

/**
 * Computes an operation for some features with the built-in computation (an operation
 * {@link acceptsBuiltInTransform} takes): writes into `output` the values each has after it
 *
 * @internal
 */
export function applyBuiltInTransform(
  operation: TransformOperation,
  input: TransformInput,
  output: TransformOutput,
): void {
  const source = input.coordinates;
  const target = output.coordinates;
  // The heights and the measures, and the positions an operation does not move, as they are
  target.set(source);
  const [motion, uniformMotion] = motionsOf(operation);
  if (motion || uniformMotion) {
    const stride = input.valuesPerPosition;
    const starts = input.positionStarts;
    const uniform = input.isScaledUniformly;
    const earth = new Float64Array(3);
    const geographic = new Float64Array(2);
    for (let i = 0; i < input.featureCount; i++) {
      const moving = uniform !== null && uniform[i] === 1 ? uniformMotion : motion;
      if (!moving) continue;
      const end = starts[i + 1] as number;
      for (let p = starts[i] as number; p < end; p++) {
        movePosition(moving, source, target, p * stride, earth, geographic);
      }
    }
  }
  applyValues(operation, input, output);
}

/**
 * Creates the built-in computation, called as a provider set on the instance is: the computation
 * used when none is set, and the one a drag draws with while it goes on
 *
 * @internal
 */
export function createBuiltInTransform(): TransformProvider {
  return {
    name: 'built-in',
    accepts: acceptsBuiltInTransform,
    apply: applyBuiltInTransform,
  };
}
