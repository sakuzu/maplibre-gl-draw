// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The uniforms of the transforms of the moving sets: the sets that have one, their matrices, and
 * their centers given as differences from the center the offsets of a draw are taken from,
 * computed in float64 so that the shader works in small values.
 */

import { describe, expect, it } from 'vitest';
import { toPlane } from '../../shared/math/mercator-plane.js';
import { resizeTransform, rotationTransform } from '../../shared/math/plane-transform.js';
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

  it('are declared by the variant of the rows, with the function that moves an offset', () => {
    for (const name of [
      'u_state_transformed',
      'u_state_matrix',
      'u_state_matrix_uniform',
      'u_state_center',
      'u_state_center_lat',
      'vec2 rowStateMove(uint state, vec2 offset)',
    ]) {
      expect(ROW_STATE_GLSL).toContain(name);
    }
  });
});
