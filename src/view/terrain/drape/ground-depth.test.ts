// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for reading the ground back from the depth of the terrain MapLibre draws, on the CPU
 *
 * - The depth is packed as MapLibre packs it (`packGroundDepth`, its `terrain_depth` shader) and
 *   read back as the shader of the rows reads its bytes (`unpackGroundDepth`)
 * - What the ground is read back with (`groundProjectionOf`) takes the clip space of a place back
 *   to it: exactly on the flat map and on the globe alone, to the first order in the transition
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
    zoom: 11.5,
    pitch: 50,
    bearing: 20,
    width: 1280,
    height: 720,
  };

  function sceneOf(transition: number, zoom = camera.zoom): GroundScene {
    const projection = frameProjection({ ...camera, zoom }, transition);
    const uniforms = calculateOffsetUniforms(camera.center, {
      ...projection,
      clippingPlane: [...projection.clippingPlane],
    } as never);
    const scale = metersToMercatorScale(uniforms.centerLngLat[1]);
    const read = groundProjectionOf(
      projection,
      uniforms.centerLngLat,
      uniforms.centerMercator,
      scale,
      0.5,
    );
    expect(read).not.toBeNull();
    return { projection, uniforms, scale, read: read as NonNullable<typeof read> };
  }

  /** The place a point of the clip space stands for by the projection read back linearized */
  function linear(scene: GroundScene, clip: readonly number[]): number[] {
    const u = scene.read.unproject;
    const w = clip[3] as number;
    const h = [0, 1, 2, 3].map(
      (i) =>
        ((u[i] as number) * (clip[0] as number)) / w +
        ((u[4 + i] as number) * (clip[1] as number)) / w +
        (u[8 + i] as number) * ((clip[2] as number) / w - 1) +
        (u[12 + i] as number),
    );
    return [0, 1, 2].map((i) => (h[i] as number) / (h[3] as number));
  }

  const places = [
    [0, 0, 0],
    [2e-4, -1e-4, 800],
    [-3e-4, 2e-4, 2500],
  ];

  it('takes the clip space back to the place on the flat map', () => {
    const scene = sceneOf(0);
    expect(scene.read.transition).toBe(0);
    for (const place of places) {
      const back = linear(scene, groundClipOf(scene, place));
      expect(Math.abs((back[0] as number) - (place[0] as number))).toBeLessThan(1e-12);
      expect(Math.abs((back[1] as number) - (place[1] as number))).toBeLessThan(1e-12);
      expect(Math.abs((back[2] as number) - (place[2] as number))).toBeLessThan(1e-4);
    }
  });

  it('linearizes the globe and the transition at the center, to the first order', () => {
    for (const transition of [0.5, 1]) {
      const scene = sceneOf(transition);
      expect(scene.read.transition).toBe(F32(transition));
      for (const place of places) {
        const back = linear(scene, groundClipOf(scene, place));
        // The curvature of the sphere over the offsets: of their square (radians)
        const reach = Math.hypot(place[0] as number, place[1] as number) * 2 * Math.PI;
        const bound = 2 * reach * reach;
        expect(Math.abs((back[0] as number) - (place[0] as number))).toBeLessThan(bound + 1e-12);
        expect(Math.abs((back[1] as number) - (place[1] as number))).toBeLessThan(bound + 1e-12);
      }
    }
  });

  it('inverts the projection of the unit sphere on the globe alone', () => {
    const scene = sceneOf(1, 6);
    const g = scene.read.globe;
    const [lng0, lat0] = scene.uniforms.centerLngLat.map((d) => (d * Math.PI) / 180) as [
      number,
      number,
    ];
    const sphereOf = (u: readonly number[]): number[] => {
      const [cx, cy] = scene.uniforms.centerMercator;
      const lng = lng0 + (u[0] as number) * 2 * Math.PI;
      const lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * (cy + (u[1] as number)))));
      expect(cx).toBeGreaterThan(0);
      const lift = 1 + (u[2] as number) / 6_371_008.8;
      return [
        Math.sin(lng) * Math.cos(lat) * lift,
        Math.sin(lat) * lift,
        Math.cos(lng) * Math.cos(lat) * lift,
      ];
    };
    const center = sphereOf([0, 0, 0]);
    expect(Math.abs((center[1] as number) - Math.sin(lat0))).toBeLessThan(1e-9);
    for (const place of [
      [1e-3, -2e-3, 400],
      [-0.01, 0.02, 3000],
    ]) {
      const clip = groundClipOf(scene, place);
      const w = clip[3] as number;
      const h = [0, 1, 2, 3].map(
        (i) =>
          ((g[i] as number) * (clip[0] as number)) / w +
          ((g[4 + i] as number) * (clip[1] as number)) / w +
          (g[8 + i] as number) * ((clip[2] as number) / w - 1) +
          (g[12 + i] as number),
      );
      const at = sphereOf(place);
      for (let i = 0; i < 3; i++) {
        const offset = (at[i] as number) - (center[i] as number);
        expect(Math.abs((h[i] as number) / (h[3] as number) - offset)).toBeLessThan(1e-11);
      }
    }
  });

  it('gives the lift over the w of the clip space of the center', () => {
    const scene = sceneOf(0);
    const center = groundClipOf(scene, [0, 0, 0]);
    expect(scene.read.lift).toBeCloseTo(0.5 / (center[3] as number), 12);
  });
});
