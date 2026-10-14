// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The transform of many features dragged at once: on the CPU it maps a position as the rotate
 * and resize drags do, and the differences the shader works in give the same positions, also
 * with the inputs rounded to float32 as the GPU holds them.
 */

import { describe, expect, it } from 'vitest';
import { fromPlane, toPlane } from './mercator-plane.js';
import {
  latitudeDelta,
  mercatorDelta,
  resizeTransform,
  rotationTransform,
  transformDelta,
  transformPosition,
} from './plane-transform.js';

function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The rotation the rotate drag computes (`rotateCoordinate`) */
function rotated(center: [number, number], position: [number, number], angle: number) {
  const [cx, cy] = toPlane(center);
  const [x, y] = toPlane(position);
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return fromPlane(cx + (x - cx) * cos - (y - cy) * sin, cy + (x - cx) * sin + (y - cy) * cos);
}

describe('the transform of many features dragged at once', () => {
  it('maps a position on the CPU as the rotate and the resize drags do, keeping z', () => {
    const center: [number, number] = [139.7, 35.6];
    const rotation = rotationTransform(center, 0.7);
    expect(transformPosition(rotation, [139.8, 35.65, 12], false)).toEqual([
      ...rotated(center, [139.8, 35.65], 0.7),
      12,
    ]);
    const anchor = toPlane(center);
    const resize = resizeTransform(anchor, 2, 0.5, 1.5);
    const [x, y] = toPlane([139.8, 35.65]);
    expect(transformPosition(resize, [139.8, 35.65], false)).toEqual(
      fromPlane(anchor[0] + (x - anchor[0]) * 2, anchor[1] + (y - anchor[1]) * 0.5),
    );
    expect(transformPosition(resize, [139.8, 35.65], true)).toEqual(
      fromPlane(anchor[0] + (x - anchor[0]) * 1.5, anchor[1] + (y - anchor[1]) * 1.5),
    );
  });

  it('turns a difference of latitude into one of northing and back', () => {
    for (const lat of [-70, -35, 0, 35.6, 60]) {
      const phi = (lat * Math.PI) / 180;
      for (const delta of [1e-7, 1e-4, -0.01, 0.5, -3]) {
        const y = mercatorDelta(delta, Math.sin(phi), Math.cos(phi));
        const exact =
          (Math.atanh(Math.sin(phi + (delta * Math.PI) / 180)) - Math.atanh(Math.sin(phi))) /
          (Math.PI / 180);
        expect(Math.abs(y - exact)).toBeLessThan(1e-9 * Math.max(1, Math.abs(exact)));
        const back = latitudeDelta(y, Math.cos(phi), Math.tan(phi));
        expect(Math.abs(back - delta)).toBeLessThan(1e-9);
      }
    }
  });

  it('gives in differences from the center the positions of the CPU', () => {
    const next = random(7);
    for (let i = 0; i < 200; i++) {
      const center: [number, number] = [-180 + next() * 360, -60 + next() * 120];
      const spread = 10 ** (-4 + next() * 4);
      const position: [number, number] = [
        center[0] + (next() - 0.5) * spread,
        center[1] + (next() - 0.5) * spread,
      ];
      const transform =
        next() < 0.5
          ? rotationTransform(center, (next() - 0.5) * 6)
          : resizeTransform(toPlane(center), 0.2 + next() * 3, 0.2 + next() * 3, 1);
      const expected = transformPosition(transform, position, false);
      const [dLng, dLat] = transformDelta(transform.matrix, center[1], [
        position[0] - center[0],
        position[1] - center[1],
      ]);
      expect(Math.abs(center[0] + dLng - expected[0])).toBeLessThan(1e-9);
      expect(Math.abs(center[1] + dLat - expected[1])).toBeLessThan(1e-9);
    }
  });

  it('keeps the error of float32 differences within a centimeter near the center', () => {
    const f = Math.fround;
    const next = random(11);
    for (let i = 0; i < 200; i++) {
      const center: [number, number] = [139 + next(), 35 + next()];
      const position: [number, number] = [
        center[0] + (next() - 0.5) * 0.02,
        center[1] + (next() - 0.5) * 0.02,
      ];
      const transform = rotationTransform(center, (next() - 0.5) * 6);
      const expected = transformPosition(transform, position, false);
      // The inputs as the GPU holds them: float32 differences, float32 values of the center
      const delta: [number, number] = [f(position[0] - center[0]), f(position[1] - center[1])];
      const matrix = transform.matrix.map(f) as unknown as [number, number, number, number];
      const [dLng, dLat] = transformDelta(matrix, f(center[1]), delta);
      // About 1 cm at the latitude of the center
      expect(Math.abs(center[0] + f(dLng) - expected[0])).toBeLessThan(1e-7);
      expect(Math.abs(center[1] + f(dLat) - expected[1])).toBeLessThan(1e-7);
    }
  });
});
