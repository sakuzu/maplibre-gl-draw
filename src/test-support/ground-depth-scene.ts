// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The ground of a frame in float64, for the tests of reading it back from the depth of the
 * terrain (`view/terrain/drape/ground-depth.ts`)
 *
 * A place is its Mercator offset from the center of the view and its elevation in meters,
 * u = (dx, dy, e). Its clip space is the one maplibre's `projectTileFor3D` draws the depth of the
 * terrain with on the flat map: the Mercator matrix of the frame.
 */

import type { OffsetUniforms } from '../view/shaders/helpers.js';
import type { GroundProjection } from '../view/terrain/drape/ground-depth.js';
import type { FrameProjection } from './glsl-projection.js';

/** A frame, and what the ground is read back with in it */
export interface GroundScene {
  readonly projection: FrameProjection;
  readonly uniforms: OffsetUniforms;
  /** The Mercator units of a meter of elevation */
  readonly scale: number;
  readonly read: GroundProjection;
}

/** A matrix (column-major) times a vector, in float64 */
function transform(m: ArrayLike<number>, v: readonly number[]): [number, number, number, number] {
  const out: [number, number, number, number] = [0, 0, 0, 0];
  for (let i = 0; i < 4; i++) {
    out[i] =
      (m[i] as number) * (v[0] as number) +
      (m[4 + i] as number) * (v[1] as number) +
      (m[8 + i] as number) * (v[2] as number) +
      (m[12 + i] as number) * (v[3] as number);
  }
  return out;
}

/** The clip space of a place (dx, dy, e) */
export function groundClipOf(
  scene: GroundScene,
  u: readonly number[],
): [number, number, number, number] {
  const [cx, cy] = scene.uniforms.centerMercator;
  return transform(scene.projection.mainMatrix, [
    cx + (u[0] as number),
    cy + (u[1] as number),
    (u[2] as number) * scene.scale,
    1,
  ]);
}

/** The point of the clip space over its w of a place */
export function groundNdcOf(scene: GroundScene, u: readonly number[]): [number, number, number] {
  const clip = groundClipOf(scene, u);
  return [clip[0] / clip[3], clip[1] / clip[3], clip[2] / clip[3]];
}

/** The place of a point of the clip space over its w (Newton's method on the projection) */
export function groundPlaceOf(scene: GroundScene, ndc: readonly number[]): number[] {
  const inverse = scene.read.unproject;
  const h = [0, 1, 2, 3].map(
    (i) =>
      (inverse[i] as number) * (ndc[0] as number) +
      (inverse[4 + i] as number) * (ndc[1] as number) +
      (inverse[8 + i] as number) * ((ndc[2] as number) - 1) +
      (inverse[12 + i] as number),
  );
  let u = [0, 1, 2].map((i) => (h[i] as number) / (h[3] as number));
  const steps = [1e-11, 1e-11, 1e-4];
  for (let k = 0; k < 5; k++) {
    const at = groundNdcOf(scene, u);
    const residual = at.map((v, i) => v - (ndc[i] as number));
    const columns = [0, 1, 2].map((j) => {
      const moved = [...u];
      moved[j] = (moved[j] as number) + (steps[j] as number);
      const next = groundNdcOf(scene, moved);
      return next.map((v, i) => (v - (at[i] as number)) / (steps[j] as number));
    });
    const delta = solve3(columns, residual);
    u = u.map((v, i) => v - (delta[i] as number));
  }
  return u;
}

/** Solves for d with the columns of a 3 x 3 matrix and a right side (Cramer's rule) */
function solve3(columns: number[][], right: number[]): number[] {
  const m = [0, 1, 2].map((r) => [0, 1, 2].map((c) => (columns[c] as number[])[r] as number));
  const det = (a: number[][]): number => {
    const [r0, r1, r2] = a as [number[], number[], number[]];
    return (
      (r0[0] as number) *
        ((r1[1] as number) * (r2[2] as number) - (r1[2] as number) * (r2[1] as number)) -
      (r0[1] as number) *
        ((r1[0] as number) * (r2[2] as number) - (r1[2] as number) * (r2[0] as number)) +
      (r0[2] as number) *
        ((r1[0] as number) * (r2[1] as number) - (r1[1] as number) * (r2[0] as number))
    );
  };
  const d = det(m);
  return [0, 1, 2].map(
    (k) => det(m.map((row, r) => row.map((v, c) => (c === k ? (right[r] as number) : v)))) / d,
  );
}

/**
 * Where the ray of a point of the screen (x, y of the clip space over its w) meets the ground of
 * an elevation (meters at a Mercator offset): the place and its depth, null where it does not
 */
export function groundMeet(
  scene: GroundScene,
  x: number,
  y: number,
  elevation: (dx: number, dy: number) => number,
): { u: number[]; z: number } | null {
  const above = (z: number): number => {
    const u = groundPlaceOf(scene, [x, y, z]);
    return (u[2] as number) - elevation(u[0] as number, u[1] as number);
  };
  // A bracket: the last depth over the ground and the first under it, of depths that crowd to 1
  // (the depth of a perspective does)
  const depths = [-0.5, 0, 0.5, 0.8, 0.9, 0.95, 0.99, 0.995, 0.999, 0.9995, 0.9999, 0.99995];
  depths.push(0.99999, 0.999995, 0.999999, 1 - 1e-7);
  let near = Number.NaN;
  let far = Number.NaN;
  let fNear = Number.NaN;
  let fFar = Number.NaN;
  for (const z of depths) {
    const f = above(z);
    if (!Number.isFinite(f)) continue;
    if (f > 0) {
      near = z;
      fNear = f;
    } else if (Number.isFinite(fNear)) {
      far = z;
      fFar = f;
      break;
    }
  }
  if (!(fNear > 0) || !(fFar < 0)) return null;
  // Halved, then the false position (Illinois) on the bracket
  for (let k = 0; k < 24; k++) {
    const mid = (near + far) / 2;
    const f = above(mid);
    if (f > 0) {
      near = mid;
      fNear = f;
    } else {
      far = mid;
      fFar = f;
    }
  }
  let side = 0;
  for (let k = 0; k < 30 && far - near > 1e-17; k++) {
    const z = far - (fFar * (far - near)) / (fFar - fNear);
    const f = above(z);
    if (f > 0) {
      near = z;
      fNear = f;
      if (side === 1) fFar /= 2;
      side = 1;
    } else {
      far = z;
      fFar = f;
      if (side === -1) fNear /= 2;
      side = -1;
    }
    if (f === 0) break;
  }
  const z = Math.abs(fNear) < Math.abs(fFar) ? near : far;
  return { u: groundPlaceOf(scene, [x, y, z]), z };
}
