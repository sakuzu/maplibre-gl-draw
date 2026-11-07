// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The computation of the edits that move, rotate and scale features, for a Store that gives none
 * of its own (`Store.transforms`)
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
 *   (`uniformScale`) moves by `sizeFactor` along both in place of sx and sy
 *
 * The frame of a point is built from its longitude and latitude, so it is defined at the poles
 * too. A position turned back onto the axis of the poles keeps the longitude it had. Each
 * longitude is the value nearest to the one it had (for a move, plus the longitude of Q less that
 * of P); then the positions of a feature are shifted by the same multiple of 360 degrees, so that
 * its first one is within [-180, 180]. A position that is bit for bit the center of a rotation or
 * a scaling stays as it is. The numbers of a position past the longitude and the latitude are
 * kept as they are, and are not read.
 *
 * The fields: a rotation adds its angle to `angleDegrees` and takes it away from
 * `bearingDegrees`, each then within [0, 360); a scaling multiplies `size` by `sizeFactor`. A
 * field of `null` starts from 0 for `angleDegrees` and 1 for `size`; `bearingDegrees` stays
 * `null`.
 *
 * It takes the finite numbers only, a latitude within [-90, 90], an angle within (-180, 180]
 * and factors within [1/1,000,000, 1,000,000]. An edit that does nothing (a move to the same
 * point, a rotation by 0, a scaling whose factors are all 1) is not computed, and gives the values
 * back as they are.
 *
 * It is computed with the functions of `Math`: the same values give the same bits on one device,
 * not on every device.
 *
 * @internal
 */

import type { Geometry } from 'geojson';

/** A point among the arguments of an edit: its first two numbers are read */
type EditPoint = readonly number[];

/**
 * An edit that moves, rotates or scales (the shape of `TransformEdit` of the Store)
 *
 * @internal
 */
export type EnuEdit =
  | { readonly kind: 'translate'; readonly from: EditPoint; readonly to: EditPoint }
  | { readonly kind: 'rotate'; readonly center: EditPoint; readonly angleDegrees: number }
  | {
      readonly kind: 'scale';
      readonly center: EditPoint;
      readonly eastFactor: number;
      readonly northFactor: number;
      readonly sizeFactor: number;
    };

/**
 * What an edit does to the angle and the size of a feature, whatever its geometry
 *
 * @internal
 */
export interface EnuEditTurn {
  /** The degrees added to the angle of a feature, and taken from its bearing */
  readonly angleDegrees: number;
  /** The factor of its size */
  readonly sizeFactor: number;
}

/**
 * The values of a feature an edit changes (the shape of `TransformValues` of the Store)
 *
 * @internal
 */
export interface EnuValues {
  readonly geometry: Geometry;
  readonly angleDegrees?: number | null;
  readonly bearingDegrees?: number | null;
  readonly size?: number | null;
  readonly uniformScale?: boolean;
}

/** What an edit that neither turns nor scales does */
const NO_TURN: EnuEditTurn = { angleDegrees: 0, sizeFactor: 1 };

const DEGREE = Math.PI / 180;
const RADIAN = 180 / Math.PI;
/** The semi-major axis of WGS 84, in metres */
const SEMI_MAJOR_AXIS = 6378137;
/** The flattening of WGS 84 */
const FLATTENING = 1 / 298.257223563;
/** The square of the first eccentricity of WGS 84 */
const ECCENTRICITY_SQUARED = FLATTENING * (2 - FLATTENING);
const FULL_TURN = 360;
const HALF_TURN = 180;
/** The smallest factor of a scaling and the largest */
const MIN_FACTOR = 1e-6;
const MAX_FACTOR = 1e6;

/** Whether a value is a finite number */
function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Whether a value is a point of an edit: two finite numbers first, the latitude within range */
function isEditPoint(value: unknown): value is EditPoint {
  return (
    Array.isArray(value) &&
    value.length >= 2 &&
    isFiniteNumber(value[0]) &&
    isFiniteNumber(value[1]) &&
    value[1] >= -90 &&
    value[1] <= 90
  );
}

/** Whether a value is a factor of a scaling */
function isFactor(value: unknown): value is number {
  return isFiniteNumber(value) && value >= MIN_FACTOR && value <= MAX_FACTOR;
}

/**
 * Whether the values of an edit are taken: finite numbers, latitudes within [-90, 90], the angle
 * within (-180, 180] and the factors within [1/1,000,000, 1,000,000]
 *
 * @internal
 */
export function acceptsEnuEdit(edit: EnuEdit): boolean {
  switch (edit.kind) {
    case 'translate':
      return isEditPoint(edit.from) && isEditPoint(edit.to);
    case 'rotate': {
      const angle = edit.angleDegrees;
      return (
        isEditPoint(edit.center) &&
        isFiniteNumber(angle) &&
        angle > -HALF_TURN &&
        angle <= HALF_TURN
      );
    }
    case 'scale':
      return (
        isEditPoint(edit.center) &&
        isFactor(edit.eastFactor) &&
        isFactor(edit.northFactor) &&
        isFactor(edit.sizeFactor)
      );
    default:
      return false;
  }
}

/** Whether an edit does nothing: it is not computed */
function doesNothing(edit: EnuEdit): boolean {
  switch (edit.kind) {
    case 'translate':
      return edit.from[0] === edit.to[0] && edit.from[1] === edit.to[1];
    case 'rotate':
      return edit.angleDegrees === 0;
    case 'scale':
      return edit.eastFactor === 1 && edit.northFactor === 1 && edit.sizeFactor === 1;
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

/** How an edit moves the positions, once its arguments are read */
type Motion =
  | {
      readonly kind: 'translate';
      readonly from: Frame;
      readonly to: Frame;
      /** The longitude of `to` less that of `from` */
      readonly shift: number;
    }
  | {
      readonly kind: 'linear';
      readonly centerLon: number;
      readonly centerLat: number;
      readonly frame: Frame;
      /** east' = e a + n b, north' = e c + n d */
      readonly a: number;
      readonly b: number;
      readonly c: number;
      readonly d: number;
      /** The factor of up */
      readonly up: number;
    };

/** The motion of an edit, undefined when it moves no position */
function motionOf(edit: EnuEdit, uniformScale: boolean): Motion | undefined {
  switch (edit.kind) {
    case 'translate': {
      const [fromLon, fromLat] = edit.from as [number, number];
      const [toLon, toLat] = edit.to as [number, number];
      if (fromLon === toLon && fromLat === toLat) return undefined;
      return {
        kind: 'translate',
        from: frameAt(fromLon, fromLat),
        to: frameAt(toLon, toLat),
        shift: toLon - fromLon,
      };
    }
    case 'rotate': {
      if (edit.angleDegrees === 0) return undefined;
      const [centerLon, centerLat] = edit.center as [number, number];
      const theta = edit.angleDegrees * DEGREE;
      const cos = Math.cos(theta);
      const sin = Math.sin(theta);
      return {
        kind: 'linear',
        centerLon,
        centerLat,
        frame: frameAt(centerLon, centerLat),
        a: cos,
        b: -sin,
        c: sin,
        d: cos,
        up: 1,
      };
    }
    case 'scale': {
      const east = uniformScale ? edit.sizeFactor : edit.eastFactor;
      const north = uniformScale ? edit.sizeFactor : edit.northFactor;
      if (east === 1 && north === 1) return undefined;
      const [centerLon, centerLat] = edit.center as [number, number];
      return {
        kind: 'linear',
        centerLon,
        centerLat,
        frame: frameAt(centerLon, centerLat),
        a: east,
        b: 0,
        c: 0,
        d: north,
        up: Math.sqrt(east * north),
      };
    }
  }
}

/** Whether two numbers have the same bits */
function sameBits(a: number, b: number): boolean {
  return a === b && (a !== 0 || 1 / a === 1 / b);
}

const SCRATCH_X = new Float64Array(3);
const SCRATCH_R = new Float64Array(2);

/** A position moved by a motion: a new array, the numbers past the first two as they were */
function movePosition(motion: Motion, position: readonly number[]): number[] {
  const out = position.slice();
  const lon = position[0] as number;
  const lat = position[1] as number;
  if (motion.kind === 'translate') {
    const f = motion.from;
    const t = motion.to;
    toEarthCentred(lon, lat, SCRATCH_X);
    const d0 = (SCRATCH_X[0] as number) - (f[0] as number);
    const d1 = (SCRATCH_X[1] as number) - (f[1] as number);
    const d2 = (SCRATCH_X[2] as number) - (f[2] as number);
    const e = d0 * (f[3] as number) + d1 * (f[4] as number) + d2 * (f[5] as number);
    const n = d0 * (f[6] as number) + d1 * (f[7] as number) + d2 * (f[8] as number);
    const u = d0 * (f[9] as number) + d1 * (f[10] as number) + d2 * (f[11] as number);
    const x = (t[0] as number) + (t[3] as number) * e + (t[6] as number) * n + (t[9] as number) * u;
    const y =
      (t[1] as number) + (t[4] as number) * e + (t[7] as number) * n + (t[10] as number) * u;
    const z =
      (t[2] as number) + (t[5] as number) * e + (t[8] as number) * n + (t[11] as number) * u;
    fromEarthCentred(x, y, z, lon, SCRATCH_R);
    out[0] = nearest(SCRATCH_R[0] as number, lon + motion.shift);
    out[1] = SCRATCH_R[1] as number;
    return out;
  }
  if (sameBits(lon, motion.centerLon) && sameBits(lat, motion.centerLat)) return out;
  const f = motion.frame;
  toEarthCentred(lon, lat, SCRATCH_X);
  const d0 = (SCRATCH_X[0] as number) - (f[0] as number);
  const d1 = (SCRATCH_X[1] as number) - (f[1] as number);
  const d2 = (SCRATCH_X[2] as number) - (f[2] as number);
  const e = d0 * (f[3] as number) + d1 * (f[4] as number) + d2 * (f[5] as number);
  const n = d0 * (f[6] as number) + d1 * (f[7] as number) + d2 * (f[8] as number);
  const u = d0 * (f[9] as number) + d1 * (f[10] as number) + d2 * (f[11] as number);
  const e2 = e * motion.a + n * motion.b;
  const n2 = e * motion.c + n * motion.d;
  const u2 = u * motion.up;
  const x =
    (f[0] as number) + (f[3] as number) * e2 + (f[6] as number) * n2 + (f[9] as number) * u2;
  const y =
    (f[1] as number) + (f[4] as number) * e2 + (f[7] as number) * n2 + (f[10] as number) * u2;
  const z =
    (f[2] as number) + (f[5] as number) * e2 + (f[8] as number) * n2 + (f[11] as number) * u2;
  fromEarthCentred(x, y, z, lon, SCRATCH_R);
  out[0] = nearest(SCRATCH_R[0] as number, lon);
  out[1] = SCRATCH_R[1] as number;
  return out;
}

/** Whether a value of coordinates is a position (numbers), not a list of positions */
function isPosition(value: readonly unknown[]): boolean {
  return value.length > 0 && typeof value[0] === 'number';
}

/** The coordinates moved, in the same lists; the moved positions in their order into `moved` */
function moveAll(motion: Motion, value: unknown, moved: number[][]): unknown {
  if (!Array.isArray(value)) return value;
  if (isPosition(value)) {
    const position = movePosition(motion, value as readonly number[]);
    moved.push(position);
    return position;
  }
  return (value as readonly unknown[]).map((child) => moveAll(motion, child, moved));
}

/**
 * Shifts the positions of a feature by the same whole number of turns, when the longitude of its
 * first one is outside [-180, 180], so that it comes within [-180, 180)
 */
function bringWithinRange(positions: number[][]): void {
  const first = positions[0]?.[0];
  if (first === undefined || (first >= -HALF_TURN && first <= HALF_TURN)) return;
  const turns = Math.floor((first + HALF_TURN) / FULL_TURN);
  if (turns === 0) return;
  for (const position of positions) position[0] = (position[0] as number) - FULL_TURN * turns;
}

/** A geometry moved by a motion */
function moveGeometry(motion: Motion, geometry: Geometry): Geometry {
  if (geometry.type === 'GeometryCollection') {
    return {
      ...geometry,
      geometries: geometry.geometries.map((child) => moveGeometry(motion, child)),
    };
  }
  const moved: number[][] = [];
  const coordinates = moveAll(motion, geometry.coordinates, moved);
  bringWithinRange(moved);
  return { ...geometry, coordinates } as Geometry;
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

/** The edit and its motions last computed (a Store applies one edit to many features) */
let lastEdit: EnuEdit | null = null;
let lastMotions: [Motion | undefined, Motion | undefined] = [undefined, undefined];

/** The motion of an edit for a feature that keeps its shape or does not */
function cachedMotion(edit: EnuEdit, uniformScale: boolean): Motion | undefined {
  if (lastEdit !== edit) {
    lastEdit = edit;
    lastMotions = [motionOf(edit, false), edit.kind === 'scale' ? motionOf(edit, true) : undefined];
  }
  return edit.kind === 'scale' && uniformScale ? lastMotions[1] : lastMotions[0];
}

/**
 * The values of a feature with an edit applied (an edit the computation takes:
 * {@link acceptsEnuEdit})
 *
 * @internal
 */
export function applyEnuEdit<V extends EnuValues>(edit: EnuEdit, values: V): V {
  if (doesNothing(edit)) return values;
  const motion = cachedMotion(edit, values.uniformScale === true);
  const out: { -readonly [K in keyof EnuValues]: EnuValues[K] } = { ...values };
  if (motion) out.geometry = moveGeometry(motion, values.geometry);
  const turn = enuEditTurn(edit);
  if (edit.kind === 'rotate') {
    if ('angleDegrees' in values) {
      out.angleDegrees = withinTurn((values.angleDegrees ?? 0) + turn.angleDegrees);
    }
    if ('bearingDegrees' in values && typeof values.bearingDegrees === 'number') {
      out.bearingDegrees = withinTurn(values.bearingDegrees - turn.angleDegrees);
    }
  } else if (edit.kind === 'scale') {
    if ('size' in values) out.size = (values.size ?? 1) * turn.sizeFactor;
  }
  return out as V;
}

/**
 * What an edit does to the angle and the size of a feature: the values {@link applyEnuEdit} writes
 * them with once an edit is applied, so what follows an edit on the GPU while it lasts ends where
 * the feature does
 *
 * @internal
 */
export function enuEditTurn(edit: EnuEdit): EnuEditTurn {
  if (doesNothing(edit)) return NO_TURN;
  if (edit.kind === 'rotate') return { angleDegrees: edit.angleDegrees, sizeFactor: 1 };
  if (edit.kind === 'scale') return { angleDegrees: 0, sizeFactor: edit.sizeFactor };
  return NO_TURN;
}

/**
 * A position moved by an edit, as a feature of it is moved by {@link applyEnuEdit}: a new array,
 * the numbers past the first two as they were; the position given back as it is when the edit
 * does nothing
 *
 * The longitude is the one nearest to the position's own (for a move, plus the longitude of the
 * end less that of the start): a feature whose first longitude leaves [-180, 180] is shifted
 * as a whole by {@link applyEnuEdit}, which a single position does not know.
 *
 * @param uniformScale Whether the feature of the position keeps its shape (moved by
 *   `sizeFactor` along both the east and the north)
 * @internal
 */
export function moveEnuPosition(
  edit: EnuEdit,
  position: readonly number[],
  uniformScale: boolean,
): number[] {
  if (doesNothing(edit)) return position.slice();
  const motion = cachedMotion(edit, uniformScale);
  return motion ? movePosition(motion, position) : position.slice();
}

/**
 * The offset of a point from another in the east, north and up frame of the other, at height 0:
 * `[east, north]` in metres
 *
 * @internal
 */
export function enuOffsetOf(center: EditPoint, point: EditPoint): [number, number] {
  const frame = frameAt(center[0] as number, center[1] as number);
  toEarthCentred(point[0] as number, point[1] as number, SCRATCH_X);
  const d0 = (SCRATCH_X[0] as number) - (frame[0] as number);
  const d1 = (SCRATCH_X[1] as number) - (frame[1] as number);
  const d2 = (SCRATCH_X[2] as number) - (frame[2] as number);
  return [
    d0 * (frame[3] as number) + d1 * (frame[4] as number) + d2 * (frame[5] as number),
    d0 * (frame[6] as number) + d1 * (frame[7] as number) + d2 * (frame[8] as number),
  ];
}

/**
 * The edit that takes what an edit moved back where it was: a move from the end to the start, a
 * rotation by the opposite angle, a scaling by the inverse factors
 *
 * @internal
 */
export function inverseEnuEdit(edit: EnuEdit): EnuEdit {
  switch (edit.kind) {
    case 'translate':
      return { kind: 'translate', from: edit.to, to: edit.from };
    case 'rotate':
      return { kind: 'rotate', center: edit.center, angleDegrees: -edit.angleDegrees };
    case 'scale':
      return {
        kind: 'scale',
        center: edit.center,
        eastFactor: 1 / edit.eastFactor,
        northFactor: 1 / edit.northFactor,
        sizeFactor: 1 / edit.sizeFactor,
      };
  }
}

/**
 * How an edit moves the earth-centred coordinates of the positions: `X' = L X + t`, with `L`
 * given row first (`matrix[3 i + j]`) and `t` as `offset`
 *
 * @internal
 */
export interface EnuAffine {
  readonly matrix: Float64Array;
  readonly offset: Float64Array;
}

/**
 * The affine map of the earth-centred coordinates an edit makes (null when it moves no position):
 * the same motion as {@link applyEnuEdit}, written as one matrix and one offset
 *
 * @param uniformScale Whether the feature keeps its shape (a scaling by `sizeFactor`)
 * @internal
 */
export function enuAffineOf(edit: EnuEdit, uniformScale: boolean): EnuAffine | null {
  if (doesNothing(edit)) return null;
  const motion = motionOf(edit, uniformScale);
  if (!motion) return null;
  const matrix = new Float64Array(9);
  const offset = new Float64Array(3);
  let origin: Frame;
  let target: Frame;
  if (motion.kind === 'translate') {
    // L = B_to B_fromᵀ
    const f = motion.from;
    const t = motion.to;
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        matrix[i * 3 + j] =
          (t[3 + i] as number) * (f[3 + j] as number) +
          (t[6 + i] as number) * (f[6 + j] as number) +
          (t[9 + i] as number) * (f[9 + j] as number);
      }
    }
    origin = f;
    target = t;
  } else {
    // L = B M Bᵀ, M = [[a, b, 0], [c, d, 0], [0, 0, up]] over the east, north and up
    const b = motion.frame;
    const m = [motion.a, motion.b, 0, motion.c, motion.d, 0, 0, 0, motion.up];
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        let sum = 0;
        for (let k = 0; k < 3; k++) {
          for (let l = 0; l < 3; l++) {
            sum +=
              (b[3 + k * 3 + i] as number) *
              (m[k * 3 + l] as number) *
              (b[3 + l * 3 + j] as number);
          }
        }
        matrix[i * 3 + j] = sum;
      }
    }
    origin = b;
    target = b;
  }
  // t = O_target − L O_origin
  for (let i = 0; i < 3; i++) {
    offset[i] =
      (target[i] as number) -
      ((matrix[i * 3] as number) * (origin[0] as number) +
        (matrix[i * 3 + 1] as number) * (origin[1] as number) +
        (matrix[i * 3 + 2] as number) * (origin[2] as number));
  }
  return { matrix, offset };
}
