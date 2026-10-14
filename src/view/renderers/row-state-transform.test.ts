// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The uniforms of the transforms of the moving sets: the sets that have one, their matrices, and
 * their centers given as differences from the center the offsets of a draw are taken from,
 * computed in float64 so that the shader works in small values.
 */

import { describe, expect, it } from 'vitest';
import { toPlane } from '../../shared/math/mercator-plane.js';
import {
  latitudeDelta,
  mercatorDelta,
  resizeTransform,
  rotationTransform,
  transformPosition,
} from '../../shared/math/plane-transform.js';
import { ROW_STATE_GLSL, TransformUniformValues } from './row-state.js';

describe('the uniforms of the transforms of the moving sets', () => {
  it('flag the sets that have one, with their matrices and the sine, cosine, tangent of the center', () => {
    const values = new TransformUniformValues();
    const rotation = rotationTransform([139.7, 35.6], 0.5);
    const resize = resizeTransform(toPlane([139.71, 35.61]), 2, 3, 2.5);
    values.set([null, null, rotation, resize], [139.7001, 35.6002]);
    expect(values.flags).toBe((1 << 2) | (1 << 3));
    expect(Array.from(values.matrix.subarray(8, 12))).toEqual(
      Array.from(new Float32Array(rotation.matrix)),
    );
    expect(Array.from(values.uniform.subarray(12, 16))).toEqual([2.5, 0, 0, 2.5]);
    expect(values.matrix[12]).toBe(2);
    expect(values.matrix[15]).toBe(3);
    const phi = (35.6 * Math.PI) / 180;
    expect(values.centerLat[6]).toBe(Math.fround(Math.sin(phi)));
    expect(values.centerLat[7]).toBe(Math.fround(Math.cos(phi)));
    expect(values.centerLat[8]).toBe(Math.fround(Math.tan(phi)));
  });

  it('give the centers as their differences from the center of the draw, in float64', () => {
    const values = new TransformUniformValues();
    const rotation = rotationTransform([139.70000012345, 35.6], 0.5);
    values.set([null, rotation], [139.70001, 35.60002]);
    expect(values.center[2]).toBe(Math.fround(139.70001 - 139.70000012345));
    expect(values.center[3]).toBe(Math.fround(35.60002 - 35.6));
    values.set([null, null], [0, 0]);
    expect(values.flags).toBe(0);
  });

  it('turn an offset of a draw around the center of the transform, wherever the camera and the origin of the batch are', () => {
    // The features selected around Tokyo at zoom 14, turned around the center of their frame;
    // the camera and the origin of the batch elsewhere near it, as a draw has them
    const center: [number, number] = [139.7, 35.6805];
    const angle = 0.7;
    const rotation = rotationTransform(center, angle);
    const camera: [number, number] = [139.6912, 35.6741];
    const origin: [number, number] = [139.694, 35.6832];
    const values = new TransformUniformValues();
    values.set([null, null, rotation], camera);
    const f32 = Math.fround;
    const originShift = [f32(origin[0] - camera[0]), f32(origin[1] - camera[1])];
    /** `rowStateMove` of the moving set 2, as the shader computes it from its uniforms */
    const move = (offset: [number, number]): [number, number] => {
      const rel = [
        offset[0] + originShift[0] + values.center[4],
        offset[1] + originShift[1] + values.center[5],
      ];
      const [sinC, cosC, tanC] = values.centerLat.subarray(6, 9);
      const [a, b, c, d] = values.matrix.subarray(8, 12);
      const y = mercatorDelta(rel[1], sinC, cosC);
      const q = [a * rel[0] + c * y, b * rel[0] + d * y];
      return [
        q[0] - originShift[0] - values.center[4],
        latitudeDelta(q[1], cosC, tanC) - originShift[1] - values.center[5],
      ];
    };
    const drawnAt = (position: [number, number]): [number, number] => {
      const moved = move([f32(position[0] - origin[0]), f32(position[1] - origin[1])]);
      return [origin[0] + moved[0], origin[1] + moved[1]];
    };
    // The center stays where it is, and every position turns around it as the CPU turns it
    const still = drawnAt(center);
    expect(still[0]).toBeCloseTo(center[0], 6);
    expect(still[1]).toBeCloseTo(center[1], 6);
    for (const position of [
      [139.694, 35.6835],
      [139.706, 35.6835],
      [139.7, 35.678],
    ] as Array<[number, number]>) {
      const drawn = drawnAt(position);
      const expected = transformPosition(rotation, position, false);
      // Within about 10 cm (1e-6 degrees)
      expect(Math.abs(drawn[0] - expected[0])).toBeLessThan(1e-6);
      expect(Math.abs(drawn[1] - expected[1])).toBeLessThan(1e-6);
    }
  });

  it('are declared by the variant of the rows, with the function that moves an offset', () => {
    for (const name of [
      'u_state_transformed',
      'u_state_matrix',
      'u_state_matrix_uniform',
      'u_state_center',
      'u_state_center_lat',
      'vec2 rowStateMove(uint state, vec2 offset)',
      // The small half angles and differences of tangent by their series
      'vec2 halfAngle = rowSinCos(delta',
      'return rowAtan(deltaTan',
    ]) {
      expect(ROW_STATE_GLSL).toContain(name);
    }
  });
});
