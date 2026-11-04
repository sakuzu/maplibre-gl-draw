// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for reading the ground back from the depth of the terrain MapLibre draws, on the CPU
 *
 * - The depth is packed as MapLibre packs it (`packGroundDepth`, its `terrain_depth` shader) and
 *   read back as the shader of the rows reads its bytes (`unpackGroundDepth`)
 * - What the ground is read back with on the flat map (`groundProjectionOf`) takes the clip
 *   space of a place back to it
 *
 * The GLSL itself runs on a real WebGL2 in `ground-depth-gpu.test.ts`.
 */

import { describe, expect, it } from 'vitest';
import { frameProjection, type TestCamera } from '../../../test-support/glsl-projection.js';
import { type GroundScene, groundClipOf } from '../../../test-support/ground-depth-scene.js';
import { calculateOffsetUniforms } from '../../shaders/helpers.js';
import { metersToMercatorScale } from '../metrics.js';
import {
  groundDepthDigit,
  groundProjectionOf,
  packGroundDepth,
  unpackGroundDepth,
} from './ground-depth.js';

const F32 = Math.fround;

describe('the depth MapLibre packs', () => {
  it('reads every byte back as the digit it was written for', () => {
    for (let digit = 0; digit < 256; digit++) {
      const byte = Math.round((digit / 256) * 255);
      const read = groundDepthDigit(byte);
      // 128 is written for 128 and 129 alike: read halfway
      expect(Math.abs(read - digit), `digit ${digit}`).toBeLessThanOrEqual(
        digit === 128 || digit === 129 ? 0.5 : 0,
      );
    }
  });

  it('reads a depth back to its 32-bit float, or within half a step of the second digit', () => {
    let exact = 0;
    const count = 20_000;
    for (let k = 0; k < count; k++) {
      // The depths of the ground: near 1 (the depth of a perspective grows to 1 far away)
      const depth = Math.min(F32(1 - 0.2 * ((k + 0.5) / count) ** 3), F32(1 - 2 ** -24));
      const [r, g, b, a] = packGroundDepth(depth);
      const read = unpackGroundDepth(r, g, b, a) as number;
      const error = Math.abs(read - depth);
      expect(error).toBeLessThanOrEqual(0.5 / 65_536 + 2 ** -24);
      if (error <= 2 ** -23) exact++;
    }
    // Only where the second digit is 128 or 129 (2 of 256) is it read halfway
    expect(exact / count).toBeGreaterThan(0.99);
  });

  it('takes white as no terrain, and writes no white for a depth below 1', () => {
    expect(unpackGroundDepth(255, 255, 255, 255)).toBeNull();
    for (const depth of [0, 0.5, 0.9999, F32(1 - 2 ** -24)]) {
      expect(packGroundDepth(depth)[3]).toBeLessThan(255);
    }
  });
});

describe('groundProjectionOf', () => {
  const camera: TestCamera = {
    center: [138.72, 35.36],
    zoom: 14.5,
    pitch: 50,
    bearing: 20,
    width: 1280,
    height: 720,
  };

  function sceneOf(): GroundScene {
    const projection = frameProjection(camera, 0);
    const uniforms = calculateOffsetUniforms(camera.center, {
      ...projection,
      clippingPlane: [...projection.clippingPlane],
    } as never);
    const scale = metersToMercatorScale(uniforms.centerLngLat[1]);
    const read = groundProjectionOf(projection.mainMatrix, uniforms.centerMercator, scale, 0.5);
    expect(read).not.toBeNull();
    return { projection, uniforms, scale, read: read as NonNullable<typeof read> };
  }

  it('takes the clip space back to the place, from the depth less 1', () => {
    const scene = sceneOf();
    const u = scene.read.unproject;
    for (const place of [
      [0, 0, 0],
      [2e-6, -1e-6, 800],
      [-3e-6, 2e-6, 2500],
    ]) {
      const clip = groundClipOf(scene, place);
      const w = clip[3] as number;
      const h = [0, 1, 2, 3].map(
        (i) =>
          ((u[i] as number) * (clip[0] as number)) / w +
          ((u[4 + i] as number) * (clip[1] as number)) / w +
          (u[8 + i] as number) * ((clip[2] as number) / w - 1) +
          (u[12 + i] as number),
      );
      const back = [0, 1, 2].map((i) => (h[i] as number) / (h[3] as number));
      expect(Math.abs((back[0] as number) - (place[0] as number))).toBeLessThan(1e-14);
      expect(Math.abs((back[1] as number) - (place[1] as number))).toBeLessThan(1e-14);
      expect(Math.abs((back[2] as number) - (place[2] as number))).toBeLessThan(1e-4);
    }
  });

  it('gives the lift over the w of the clip space of the center', () => {
    const scene = sceneOf();
    const center = groundClipOf(scene, [0, 0, 0]);
    expect(scene.read.lift).toBeCloseTo(0.5 / (center[3] as number), 12);
  });
});
