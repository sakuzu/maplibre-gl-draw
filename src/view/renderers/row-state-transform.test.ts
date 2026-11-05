// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The uniforms of the motions of the moving sets: the sets that have one, the values of each
 * computed in float64 for the origin of the batch and the center of the camera of a draw, the
 * rows that keep their shape scaled by the factor of the size, and the GLSL that reads them.
 */

import { describe, expect, it } from 'vitest';
import { applyEnuEdit, type EnuEdit } from '../../geometry/enu-transforms.js';
import { gpuOf } from '../../test-utils.js';
import { moveOffsetFloat32 } from './row-motion.js';
import {
  createRowStateTexture,
  MotionStateValues,
  ROW_STATE_GLSL,
  RowStateUniforms,
} from './row-state.js';

/** Where a position is drawn: moved by the motion of a slot, from the origin to the camera */
function drawnAt(
  values: MotionStateValues,
  slot: number,
  origin: readonly [number, number],
  camera: readonly [number, number],
  position: readonly [number, number],
): [number, number] {
  const f = Math.fround;
  const moved = moveOffsetFloat32(values.motion, slot, [
    f(position[0] - origin[0]),
    f(position[1] - origin[1]),
  ]);
  return [f(camera[0]) + moved[0], f(camera[1]) + moved[1]];
}

/** Where the computation of the library writes a position */
function writtenAt(edit: EnuEdit, position: [number, number], uniformScale = false): number[] {
  return applyEnuEdit(edit, { geometry: { type: 'Point', coordinates: position }, uniformScale })
    .geometry.coordinates as number[];
}

describe('the uniforms of the motions of the moving sets', () => {
  it('flag the sets that have one, and leave the others out', () => {
    const values = new MotionStateValues();
    const rotate: EnuEdit = { kind: 'rotate', center: [139.7, 35.6], angleDegrees: 30 };
    const still: EnuEdit = { kind: 'rotate', center: [139.7, 35.6], angleDegrees: 0 };
    values.set([null, null, rotate, still], [139.7, 35.6], [139.7001, 35.6002]);
    expect(values.flags).toBe(1 << 2);
    values.set([null, null], [0, 0], [0, 0]);
    expect(values.flags).toBe(0);
  });

  it('move a position of a draw as it is written, wherever the camera and the origin of the batch are', () => {
    // The features selected around Tokyo at zoom 14, turned around the center of their frame;
    // the camera and the origin of the batch elsewhere near it, as a draw has them
    const edit: EnuEdit = { kind: 'rotate', center: [139.7, 35.6805], angleDegrees: 40 };
    const camera: [number, number] = [139.6912, 35.6741];
    const origin: [number, number] = [139.694, 35.6832];
    const values = new MotionStateValues();
    values.set([null, null, edit], origin, camera);
    for (const position of [
      [139.7, 35.6805],
      [139.694, 35.6835],
      [139.706, 35.6835],
      [139.7, 35.678],
    ] as Array<[number, number]>) {
      const drawn = drawnAt(values, 2, origin, camera, position);
      const expected = writtenAt(edit, position);
      // Within about 1 cm (1e-7 degrees)
      expect(Math.abs(drawn[0] - (expected[0] as number))).toBeLessThan(1e-7);
      expect(Math.abs(drawn[1] - (expected[1] as number))).toBeLessThan(1e-7);
    }
  });

  it('scale the rows that keep their shape by the factor of the size, the others by theirs', () => {
    const edit: EnuEdit = {
      kind: 'scale',
      center: [139.7, 35.68],
      eastFactor: 1,
      northFactor: 1,
      sizeFactor: 1.5,
    };
    const camera: [number, number] = [139.71, 35.69];
    const origin: [number, number] = [139.705, 35.685];
    const values = new MotionStateValues();
    values.set([null, null, edit], origin, camera);
    // The others do not move, the ones that keep their shape do
    expect(values.flags).toBe(1 << 2);
    const position: [number, number] = [139.705, 35.687];
    const others = drawnAt(values, 2, origin, camera, position);
    expect(Math.abs(others[0] - position[0])).toBeLessThan(1e-7);
    expect(Math.abs(others[1] - position[1])).toBeLessThan(1e-7);
    const shaped = drawnAt(values, 3, origin, camera, position);
    const expected = writtenAt(edit, position, true);
    expect(Math.abs(shaped[0] - (expected[0] as number))).toBeLessThan(1e-7);
    expect(Math.abs(shaped[1] - (expected[1] as number))).toBeLessThan(1e-7);
  });

  it('are declared by the variant of the rows, with the function that moves an offset', () => {
    for (const name of [
      'u_state_transformed',
      'u_motion_rows',
      'u_motion_offsets',
      'u_motion_from',
      'u_motion_to',
      'vec2 rowStateMove(uint state, vec2 offset)',
      'vec2 rowMotionMove(int k, vec2 offset)',
      // A moved row is taken from the center of the camera by the projection
      'g_offset_from_center = 1.0;',
      // The small half angles and the latitude by their series
      'vec2 h = rowSinCos(delta * 0.5);',
      'delta = rowAtan(num / den);',
    ]) {
      expect(ROW_STATE_GLSL).toContain(name);
    }
  });
});

describe('what the edit of a moving set does to a row besides its position', () => {
  const rotate: EnuEdit = { kind: 'rotate', center: [139.7, 35.6], angleDegrees: 30 };
  const scale: EnuEdit = {
    kind: 'scale',
    center: [139.7, 35.6],
    eastFactor: 2,
    northFactor: 2,
    sizeFactor: 2.5,
  };

  it('is the degrees and the factor the edit writes once it is applied, for each set', () => {
    const values = new MotionStateValues();
    values.set([null, rotate, scale, null], [139.7, 35.6], [139.7, 35.6]);
    expect(Array.from(values.rotateScale)).toEqual([0, 1, 30, 1, 0, 2.5, 0, 1]);
    const written = applyEnuEdit(rotate, {
      geometry: { type: 'Point', coordinates: [139.7, 35.6] },
      angleDegrees: 0,
    });
    expect(values.rotateScale[2]).toBe(written.angleDegrees);
    values.set(undefined, [0, 0], [0, 0]);
    expect(Array.from(values.rotateScale)).toEqual([0, 1, 0, 1, 0, 1, 0, 1]);
  });

  it('is read by the GLSL by the moving set of the byte of the row', () => {
    expect(ROW_STATE_GLSL).toContain('uniform vec2 u_state_rotate_scale[4];');
    expect(ROW_STATE_GLSL).toContain('float rowStateRotation(uint state)');
    expect(ROW_STATE_GLSL).toContain('float rowStateScale(uint state)');
  });

  it('is written once its values change, and with the frame', () => {
    const written: number[][] = [];
    const gl = new Proxy(
      {},
      {
        get: (_t, prop: string) => {
          if (/^[A-Z_0-9]+$/.test(prop)) return 1;
          return (...args: unknown[]) => {
            if (prop === 'getUniformLocation') return { name: args[1] };
            if (prop === 'createTexture') return {};
            if (prop === 'uniform2fv' && (args[0] as { name: string }).name.endsWith('_scale')) {
              written.push(Array.from(args[1] as Float32Array));
            }
            return undefined;
          };
        },
      },
    ) as unknown as WebGL2RenderingContext;
    const texture = createRowStateTexture(gpuOf(gl), 1);
    if (!texture) throw new Error('texture');
    const translations = new Float32Array(8);
    const uniforms = new RowStateUniforms(gl, {} as WebGLProgram);
    uniforms.write({ texture, translations, transforms: [null, rotate] });
    uniforms.write({ texture, translations, transforms: [null, rotate] });
    expect(written).toEqual([[0, 1, 30, 1, 0, 1, 0, 1]]);
    uniforms.write({ texture, translations, transforms: [null, scale] });
    expect(written[1]).toEqual([0, 1, 0, 2.5, 0, 1, 0, 1]);
    uniforms.write({ texture, translations, transforms: [null, null] });
    expect(written[2]).toEqual([0, 1, 0, 1, 0, 1, 0, 1]);
  });
});
