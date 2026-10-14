// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A rotation or a resize of many features at once, as a linear map of the transform plane (Web
 * Mercator, `mercator-plane.ts`) around a center
 *
 * The rotate and resize drags compute every position on the CPU (`operations/rotate.ts`,
 * `operations/resize.ts`): `center + M (position - center)` in the plane. Many features selected
 * at once are drawn moved by this map on the GPU while they are dragged, and written by the CPU
 * once let go. This module holds the map, applies it on the CPU (the features drawn one by one
 * while dragged), and gives the values the shader reads.
 *
 * The shader works in the differences from the center, never in absolute values (a float32 of a
 * longitude of 140 degrees steps by about 1.4 m): a position is its difference from the center in
 * degrees, made in the plane of degrees `(Δlng, ΔΨ · 180/π)` where `Ψ = atanh(sin φ)` is the
 * northing of Mercator, mapped there, and turned back to a difference of degrees. The
 * differences of the northing are computed from the sine of the half angle and of `tan`, which
 * do not cancel for small differences (`mercatorDelta`, `latitudeDelta`): the functions here are
 * the reference of the shader (`ROW_STATE_GLSL`), tested against the CPU. The shader takes the
 * sine, the cosine and the arctangent of these small values from their series, as a GPU's own
 * functions may be off by a float32 step of 1, a large share of a small sine.
 */

import { fromPlane, toPlane } from './mercator-plane.js';

/**
 * A linear map of the transform plane around a center: what a rotation or a resize of many
 * features does to them
 *
 * @internal
 */
export interface PlaneTransform {
  /** The center, `[lng, lat]` in degrees */
  readonly center: readonly [number, number];
  /**
   * The matrix of the features resized along the axes, column first: `x' = a x + c y`,
   * `y' = b x + d y` (x east, y north, in the plane)
   */
  readonly matrix: readonly [number, number, number, number];
  /**
   * The matrix of the features that keep their shape (a Circle, a feature that has a scale):
   * the same as `matrix` for a rotation, the uniform scale for a resize
   */
  readonly uniformMatrix: readonly [number, number, number, number];
  /** The angle added to the rotation of a feature that has one (degrees, as the rotate drag adds it) */
  readonly rotationDeg: number;
  /** The factor of the scale and the radius of a feature that has one */
  readonly scale: number;
}

/**
 * The transform of a rotation by an angle around a center, as `rotateCoordinate` rotates
 *
 * @param angle Radians, counterclockwise in the plane
 * @internal
 */
export function rotationTransform(
  center: readonly [number, number],
  angle: number,
): PlaneTransform {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const matrix = [cos, sin, -sin, cos] as const;
  return { center, matrix, uniformMatrix: matrix, rotationDeg: (angle * 180) / Math.PI, scale: 1 };
}

/**
 * The transform of a resize around an anchor of the plane, as `scaleCoordinate` scales
 *
 * @param anchor The anchor in the plane (world units)
 * @internal
 */
export function resizeTransform(
  anchor: readonly [number, number],
  scaleX: number,
  scaleY: number,
  uniformScale: number,
): PlaneTransform {
  return {
    center: fromPlane(anchor[0], anchor[1]) as [number, number],
    matrix: [scaleX, 0, 0, scaleY],
    uniformMatrix: [uniformScale, 0, 0, uniformScale],
    rotationDeg: 0,
    scale: uniformScale,
  };
}

/**
 * A position mapped by a transform on the CPU, in float64 (the values after `x` and `y` kept)
 *
 * @param uniform Whether the feature keeps its shape (`uniformMatrix`)
 * @internal
 */
export function transformPosition(
  transform: PlaneTransform,
  position: readonly number[],
  uniform: boolean,
): number[] {
  const [cx, cy] = toPlane(transform.center as [number, number]);
  const [x, y] = toPlane([position[0], position[1]]);
  const [a, b, c, d] = uniform ? transform.uniformMatrix : transform.matrix;
  const dx = x - cx;
  const dy = y - cy;
  const [lng, lat] = fromPlane(cx + a * dx + c * dy, cy + b * dx + d * dy);
  return position.length > 2 ? [lng, lat, ...position.slice(2)] : [lng, lat];
}

// === The reference of the shader ===

const DEG = Math.PI / 180;

/** `atanh(z)` without cancellation for a small `z` */
function atanhSmall(z: number): number {
  if (Math.abs(z) < 0.1) {
    const z2 = z * z;
    return z * (1 + z2 * (1 / 3 + z2 * (1 / 5 + z2 * (1 / 7 + z2 / 9))));
  }
  return 0.5 * Math.log((1 + z) / (1 - z));
}

/** `sinh(x)` without cancellation for a small `x` */
function sinhSmall(x: number): number {
  if (Math.abs(x) < 0.1) {
    const x2 = x * x;
    return x * (1 + x2 * (1 / 6 + x2 * (1 / 120 + x2 / 5040)));
  }
  return 0.5 * (Math.exp(x) - Math.exp(-x));
}

/**
 * The difference of the northing of Mercator from the center to a latitude `δ` degrees north of
 * it, in degrees (`ΔΨ · 180/π`)
 *
 * @param sinC The sine of the latitude of the center
 * @param cosC Its cosine
 * @internal
 */
export function mercatorDelta(delta: number, sinC: number, cosC: number): number {
  const half = (delta * DEG) / 2;
  const sinHalf = Math.sin(half);
  const cosHalf = Math.cos(half);
  // sin(φ + δ) − sin φ = 2 cos(φ + δ/2) sin(δ/2)
  const cosMid = cosC * cosHalf - sinC * sinHalf;
  const numerator = 2 * cosMid * sinHalf;
  // sin(φ + δ) = sin φ cos δ + cos φ sin δ
  const sinTo = sinC * (cosHalf * cosHalf - sinHalf * sinHalf) + cosC * 2 * sinHalf * cosHalf;
  return atanhSmall(numerator / (1 - sinTo * sinC)) / DEG;
}

/**
 * The difference of latitude from the center to a point `y` degrees of Mercator northing north
 * of it (the inverse of `mercatorDelta`)
 *
 * @param cosC The cosine of the latitude of the center
 * @param tanC Its tangent
 * @internal
 */
export function latitudeDelta(y: number, cosC: number, tanC: number): number {
  const half = (y * DEG) / 2;
  const sinhHalf = sinhSmall(half);
  const coshHalf = Math.sqrt(1 + sinhHalf * sinhHalf);
  // tan φ' − tan φ = sinh(Ψ + h) − sinh Ψ = 2 cosh(Ψ + h/2) sinh(h/2)
  const coshMid = coshHalf / cosC + tanC * sinhHalf;
  const deltaTan = 2 * coshMid * sinhHalf;
  return Math.atan(deltaTan / (1 + tanC * (tanC + deltaTan))) / DEG;
}

/**
 * The difference of a position from the center of a transform, mapped, as the shader maps it:
 * `[Δlng, Δlat]` in degrees from the center
 *
 * @internal
 */
export function transformDelta(
  matrix: readonly [number, number, number, number],
  centerLatitude: number,
  delta: readonly [number, number],
): [number, number] {
  const phi = centerLatitude * DEG;
  const sinC = Math.sin(phi);
  const cosC = Math.cos(phi);
  const y = mercatorDelta(delta[1], sinC, cosC);
  const [a, b, c, d] = matrix;
  const qx = a * delta[0] + c * y;
  const qy = b * delta[0] + d * y;
  return [qx, latitudeDelta(qy, cosC, Math.tan(phi))];
}
