// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A reference of the edits that move, rotate and scale positions, written apart from the
 * computation of the library (`geometry/enu-transforms.ts`) for the tests to compute what they
 * expect: the positions are taken at height 0 on the WGS 84 ellipsoid into earth-centred
 * coordinates, moved by the matrix of the east, north and up of a point, and turned back by
 * iterating the latitude until it no longer changes.
 *
 * It is float64 and slow, and computes one position at a time. Only the tests use it.
 */

const A = 6378137;
const F = 1 / 298.257223563;
const E2 = F * (2 - F);
const RAD = Math.PI / 180;

type Vec3 = [number, number, number];
type Mat3 = [Vec3, Vec3, Vec3];

/** Earth-centred coordinates of a longitude and a latitude at height 0 */
export function referenceEarthCentred(lon: number, lat: number): Vec3 {
  const sinLat = Math.sin(lat * RAD);
  const cosLat = Math.cos(lat * RAD);
  const n = A / Math.sqrt(1 - E2 * sinLat * sinLat);
  return [
    n * cosLat * Math.cos(lon * RAD),
    n * cosLat * Math.sin(lon * RAD),
    n * (1 - E2) * sinLat,
  ];
}

/** The longitude and the latitude of earth-centred coordinates (the height dropped) */
export function referenceGeodetic(x: number, y: number, z: number): [number, number] {
  const p = Math.hypot(x, y);
  let lat = Math.atan2(z, p);
  for (let i = 0; i < 50; i++) {
    const s = Math.sin(lat);
    const n = A / Math.sqrt(1 - E2 * s * s);
    const next = Math.atan2(z + E2 * n * s, p);
    if (next === lat) break;
    lat = next;
  }
  return [Math.atan2(y, x) / RAD, lat / RAD];
}

/** The east, north and up of a point, as the rows of a matrix */
function axesOf(lon: number, lat: number): Mat3 {
  const sl = Math.sin(lon * RAD);
  const cl = Math.cos(lon * RAD);
  const sp = Math.sin(lat * RAD);
  const cp = Math.cos(lat * RAD);
  return [
    [-sl, cl, 0],
    [-sp * cl, -sp * sl, cp],
    [cp * cl, cp * sl, sp],
  ];
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

/** A position moved by a frame: from the coordinates in the frame of `from` to the ones in `to` */
function carry(
  position: readonly number[],
  from: readonly [number, number],
  to: readonly [number, number],
  local: (enu: Vec3) => Vec3,
): [number, number] {
  const x = referenceEarthCentred(position[0] as number, position[1] as number);
  const o = referenceEarthCentred(from[0], from[1]);
  const d: Vec3 = [x[0] - o[0], x[1] - o[1], x[2] - o[2]];
  const a = axesOf(from[0], from[1]);
  const enu = local([dot(a[0], d), dot(a[1], d), dot(a[2], d)]);
  const b = axesOf(to[0], to[1]);
  const t = referenceEarthCentred(to[0], to[1]);
  const y: Vec3 = [0, 1, 2].map(
    (i) =>
      (t[i] as number) +
      (b[0][i] as number) * enu[0] +
      (b[1][i] as number) * enu[1] +
      (b[2][i] as number) * enu[2],
  ) as Vec3;
  const [lon, lat] = referenceGeodetic(y[0], y[1], y[2]);
  // The longitude nearest to the one of the position
  const near = (position[0] as number) + (to[0] - from[0]);
  return [lon + 360 * Math.round((near - lon) / 360), lat];
}

/** A position moved from `from` to `to` */
export function referenceTranslate(
  position: readonly number[],
  from: readonly [number, number],
  to: readonly [number, number],
): [number, number] {
  return carry(position, from, to, (enu) => enu);
}

/** A position rotated around a center by an angle (degrees, counterclockwise seen from above) */
export function referenceRotate(
  position: readonly number[],
  center: readonly [number, number],
  angleDegrees: number,
): [number, number] {
  const c = Math.cos(angleDegrees * RAD);
  const s = Math.sin(angleDegrees * RAD);
  return carry(position, center, center, ([e, n, u]) => [e * c - n * s, e * s + n * c, u]);
}

/** A position scaled around a center by factors along the east and the north */
export function referenceScale(
  position: readonly number[],
  center: readonly [number, number],
  east: number,
  north: number,
): [number, number] {
  return carry(position, center, center, ([e, n, u]) => [
    e * east,
    n * north,
    u * Math.sqrt(east * north),
  ]);
}

/** The east and north of a point in the frame of another, in metres */
export function referenceEnuOffset(
  center: readonly [number, number],
  point: readonly [number, number],
): [number, number] {
  const x = referenceEarthCentred(point[0], point[1]);
  const o = referenceEarthCentred(center[0], center[1]);
  const d: Vec3 = [x[0] - o[0], x[1] - o[1], x[2] - o[2]];
  const a = axesOf(center[0], center[1]);
  return [dot(a[0], d), dot(a[1], d)];
}
