// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The numerical contract of the offset model (the linearization of offset mode)
 *
 * The projection of a retained batch must be linearized around the camera
 * center, not around the reference coordinates of the batch. The grounds for
 * that (a far center produces a displacement on the order of pixels) and the
 * equivalence provided by u_origin_shift are pinned down here. WebGL is not
 * used; verification relies only on the pure functions in helpers.ts and a
 * synthetic projection matrix.
 */

import { describe, expect, it } from 'vitest';
import {
  calculateOffsetUniforms,
  createOffsetModeTransform,
  lngLatToMercator,
  type OffsetUniforms,
  type Viewport,
} from './helpers.js';

/**
 * The viewport (physical px of the draw buffer; used in pair with the scale of
 * the projection matrix)
 */
const VIEWPORT: Viewport = { width: 1000, height: 800 };

/**
 * The scale for the equivalent of z16 at a device pixel ratio of 2
 *
 * The whole Mercator range 0-1 becomes 512 * 2^16 * 2 physical px.
 */
const WORLD_PIXELS_Z16 = 512 * 2 ** 16 * 2;

/** The camera center (around Mobara) */
const CAMERA: [number, number] = [140.3, 35.4];

/**
 * Builds a synthetic projection matrix (a simple scale + translation from
 * Mercator to clip space)
 *
 * A column-major mat4. w is always 1, so NDC = clip coordinates.
 * The translation is chosen so that center lands exactly at the center of the
 * screen (the NDC origin).
 */
function createTestMatrix(center: [number, number]): number[] {
  const scale = (2 * WORLD_PIXELS_Z16) / VIEWPORT.width;
  const [cx, cy] = lngLatToMercator(center[0], center[1]);
  // Y is in a tile coordinate system where downward on the screen is positive, so flip the sign
  return [scale, 0, 0, 0, 0, -scale, 0, 0, 0, 0, 1, 0, -scale * cx, scale * cy, 0, 1];
}

/**
 * The exact screen position (applies the matrix to the Mercator coordinates
 * with no approximation)
 */
function exactProject(
  lngLat: [number, number],
  matrix: number[],
): {
  x: number;
  y: number;
} {
  const [mx, my] = lngLatToMercator(lngLat[0], lngLat[1]);
  const m = matrix;
  const clipX = m[0] * mx + m[4] * my + m[12];
  const clipY = m[1] * mx + m[5] * my + m[13];
  const clipW = m[3] * mx + m[7] * my + m[15];
  return {
    x: ((clipX / clipW) * 0.5 + 0.5) * VIEWPORT.width,
    y: (1 - ((clipY / clipW) * 0.5 + 0.5)) * VIEWPORT.height,
  };
}

/** The screen distance between two points (px) */
function distance(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * Reproduces the shader's project_position_to_clipspace_from_offset (the
 * offset mode branch) on the CPU
 *
 * The vertex is a value relative to the reference coordinates; u_origin_shift
 * (reference coordinates - linearization center) is added exactly once at the
 * start before passing it to project_offset.
 */
function projectFromOffsetWithShift(
  lngLatOffset: [number, number],
  originShift: [number, number],
  uniforms: OffsetUniforms,
  matrix: number[],
): { x: number; y: number } {
  const shiftedX = lngLatOffset[0] + originShift[0];
  const shiftedY = lngLatOffset[1] + originShift[1];
  const { projectionCenter, unitsPerDegree, unitsPerDegree2 } = uniforms;
  const mercX = shiftedX * (unitsPerDegree[0] + unitsPerDegree2[0] * shiftedY);
  const mercY = shiftedY * (unitsPerDegree[1] + unitsPerDegree2[1] * shiftedY);
  const m = matrix;
  const clipX = m[0] * mercX + m[4] * mercY + projectionCenter[0];
  const clipY = m[1] * mercX + m[5] * mercY + projectionCenter[1];
  const clipW = m[3] * mercX + m[7] * mercY + projectionCenter[3];
  return {
    x: ((clipX / clipW) * 0.5 + 0.5) * VIEWPORT.width,
    y: (1 - ((clipY / clipW) * 0.5 + 0.5)) * VIEWPORT.height,
  };
}

describe('the linearization center of the offset model', () => {
  const matrix = createTestMatrix(CAMERA);

  it('matches the exact value closely near the camera when linearized at the camera', () => {
    // Confirms that the residual of the second-order approximation is negligible within the
    // visible range (inside 0.02 degrees from the camera)
    const transform = createOffsetModeTransform(
      calculateOffsetUniforms(CAMERA, matrix),
      matrix,
      VIEWPORT,
    );

    for (const [dLng, dLat] of [
      [0, 0],
      [0.02, 0.02],
      [-0.02, 0.015],
      [0.01, -0.02],
    ] as [number, number][]) {
      const lngLat: [number, number] = [CAMERA[0] + dLng, CAMERA[1] + dLat];
      expect(distance(transform.project(lngLat), exactProject(lngLat, matrix))).toBeLessThan(0.1);
    }
  });

  it('shifts visible points by pixels when linearized at coordinates far from the center', () => {
    // The grounds for not linearizing at the reference coordinates of a retained batch
    // (characterization of the bug)
    const farOrigin: [number, number] = [CAMERA[0], CAMERA[1] - 0.8];
    const transform = createOffsetModeTransform(
      calculateOffsetUniforms(farOrigin, matrix),
      matrix,
      VIEWPORT,
    );

    // A camera position 0.8 degrees away from the reference coordinates is displaced
    // greatly from the exact value
    expect(distance(transform.project(CAMERA), exactProject(CAMERA, matrix))).toBeGreaterThan(5);
  });

  it('makes the error at the camera center orders of magnitude smaller than a far one', () => {
    // Pins down the effect of the fix (comparing the same point) numerically
    const farOrigin: [number, number] = [CAMERA[0], CAMERA[1] - 0.8];
    const target: [number, number] = [CAMERA[0] + 0.005, CAMERA[1] + 0.005];
    const exact = exactProject(target, matrix);

    const cameraError = distance(
      createOffsetModeTransform(calculateOffsetUniforms(CAMERA, matrix), matrix, VIEWPORT).project(
        target,
      ),
      exact,
    );
    const originError = distance(
      createOffsetModeTransform(
        calculateOffsetUniforms(farOrigin, matrix),
        matrix,
        VIEWPORT,
      ).project(target),
      exact,
    );

    expect(cameraError * 100).toBeLessThan(originError);
  });
});

describe('the equivalence of u_origin_shift', () => {
  const matrix = createTestMatrix(CAMERA);

  it('matches projecting absolute coordinates at the camera center with offset + shift', () => {
    // The contract that connects a retained batch (whose vertices are relative to the
    // reference coordinates) with the linearization at the camera center
    const cameraUniforms = calculateOffsetUniforms(CAMERA, matrix);
    const transform = createOffsetModeTransform(cameraUniforms, matrix, VIEWPORT);
    const origin: [number, number] = [140.1, 34.6];
    const originShift: [number, number] = [
      origin[0] - cameraUniforms.centerLngLat[0],
      origin[1] - cameraUniforms.centerLngLat[1],
    ];

    for (const [dLng, dLat] of [
      [0, 0],
      [0.2, 0.8],
      [-0.35, 0.9],
      [0.4, 1.2],
    ] as [number, number][]) {
      const lngLat: [number, number] = [origin[0] + dLng, origin[1] + dLat];
      const viaShift = projectFromOffsetWithShift(
        [dLng, dLat],
        originShift,
        cameraUniforms,
        matrix,
      );
      expect(distance(viaShift, transform.project(lngLat))).toBeLessThan(1e-6);
    }
  });

  it('projects a center-relative offset as is when the shift is (0,0)', () => {
    // Confirms that the behavior does not change in immediate mode (uniform unset =
    // default value 0)
    const cameraUniforms = calculateOffsetUniforms(CAMERA, matrix);
    const transform = createOffsetModeTransform(cameraUniforms, matrix, VIEWPORT);
    const lngLat: [number, number] = [CAMERA[0] + 0.03, CAMERA[1] - 0.02];
    const offset: [number, number] = [
      lngLat[0] - cameraUniforms.centerLngLat[0],
      lngLat[1] - cameraUniforms.centerLngLat[1],
    ];

    const viaShift = projectFromOffsetWithShift(offset, [0, 0], cameraUniforms, matrix);
    expect(distance(viaShift, transform.project(lngLat))).toBeLessThan(1e-6);
  });
});
