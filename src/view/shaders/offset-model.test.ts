// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The numerical contract of the offset model (positions projected relative to a center)
 *
 * The shaders project the offset of a position from a center and add the center in clip space
 * computed on the CPU. The formula is exact (it is not a linearization around the center), so a
 * position lands where the frame projects it from any center: the center of the view, or the
 * origin of a retained batch far from it. A retained batch whose vertices are offsets from its
 * origin is drawn from the center of the view by adding the gap between the two
 * (`u_origin_shift`). These are held on the copy of the GLSL in exact arithmetic
 * (`test-support/glsl-projection.ts`; its precision on a GPU is held by
 * `projection-precision.test.ts`), against the projection of the CPU in float64.
 */

import { describe, expect, it } from 'vitest';
import {
  exactArithmetic,
  frameProjection,
  projectOffsetToClip,
  screenOf,
  type TestCamera,
  uniformsOf,
} from '../../test-support/glsl-projection.js';
import { clipOfPosition } from './center-projection.js';
import { calculateOffsetUniforms } from './helpers.js';

const CAMERA: TestCamera = {
  center: [140.3, 35.4],
  zoom: 16,
  pitch: 40,
  bearing: 15,
  width: 1000,
  height: 800,
};

/** The screen position (px) a copy of the GLSL gives an offset from a center */
function drawn(
  transition: number,
  center: readonly [number, number],
  offset: readonly [number, number],
): [number, number] {
  const uniforms = uniformsOf(frameProjection(CAMERA, transition), center);
  return screenOf(
    projectOffsetToClip(exactArithmetic, offset[0], offset[1], uniforms),
    CAMERA.width,
    CAMERA.height,
  );
}

/** The screen position (px) the frame projects a position to, in float64 */
function projected(transition: number, lngLat: readonly [number, number]): [number, number] {
  const projection = frameProjection(CAMERA, transition);
  return screenOf(
    clipOfPosition(projection as never, lngLat[0], lngLat[1]),
    CAMERA.width,
    CAMERA.height,
  );
}

const distance = (a: readonly number[], b: readonly number[]): number =>
  Math.hypot((a[0] as number) - (b[0] as number), (a[1] as number) - (b[1] as number));

const f32 = (v: readonly [number, number]): [number, number] => [
  Math.fround(v[0]),
  Math.fround(v[1]),
];

describe.each([
  ['Web Mercator', 0],
  ['the globe', 1],
  ['the transition', 0.5],
])('the offset model on %s', (_name, transition) => {
  it('projects a position from the center of the view where the frame projects it', () => {
    const center = f32(CAMERA.center);
    for (const [dLng, dLat] of [
      [0, 0],
      [0.002, 0.002],
      [-0.003, 0.0015],
      [0.001, -0.004],
    ] as Array<[number, number]>) {
      const position: [number, number] = [center[0] + dLng, center[1] + dLat];
      expect(
        distance(drawn(transition, center, [dLng, dLat]), projected(transition, position)),
      ).toBeLessThan(1e-3);
    }
  });

  it('projects a position from a center far from the view where the frame projects it', () => {
    // A retained batch whose origin is far from the view: the formula is exact from any center
    const origin = f32([CAMERA.center[0] - 0.2, CAMERA.center[1] - 0.8]);
    const target: [number, number] = [CAMERA.center[0] + 0.001, CAMERA.center[1] + 0.001];
    const offset: [number, number] = [target[0] - origin[0], target[1] - origin[1]];
    expect(distance(drawn(transition, origin, offset), projected(transition, target))).toBeLessThan(
      0.01,
    );
  });

  it('draws the offsets from an origin from the center with the gap between the two', () => {
    // The contract that connects a retained batch (whose vertices are relative to its origin)
    // with the projection from the center of the view (u_origin_shift)
    const camera = calculateOffsetUniforms(
      CAMERA.center,
      frameProjection(CAMERA, transition) as never,
    );
    const origin: [number, number] = [140.1, 34.6];
    const shift: [number, number] = [
      origin[0] - camera.centerLngLat[0],
      origin[1] - camera.centerLngLat[1],
    ];
    for (const [dLng, dLat] of [
      [0.2, 0.8],
      [0.21, 0.79],
      [0.195, 0.802],
    ] as Array<[number, number]>) {
      const viaShift = drawn(transition, camera.centerLngLat, [dLng + shift[0], dLat + shift[1]]);
      expect(
        distance(viaShift, projected(transition, [origin[0] + dLng, origin[1] + dLat])),
      ).toBeLessThan(0.01);
    }
  });
});
