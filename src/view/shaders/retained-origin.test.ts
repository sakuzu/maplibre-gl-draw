// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for the origin of a retained batch
 *
 * The shader arithmetic is reproduced with Math.fround: the CPU bakes `fround(vertex - origin)`,
 * the uniform is `fround(origin - center)` (both Float32 values), and the GPU adds the two in
 * Float32. The error is measured against the exact offset from the center, in CSS px.
 */

import { describe, expect, it } from 'vitest';
import type { BoundingBox } from '../../store/types.js';
import {
  RETAINED_ORIGIN_TOLERANCE_PX,
  rebasedRetainedOrigin,
  retainedOriginErrorPx,
} from './retained-origin.js';

/** CSS px per degree of longitude at a zoom */
function pxPerDegree(zoom: number): number {
  return (512 * 2 ** zoom) / 360;
}

/**
 * The screen error (CSS px) of one vertex drawn from a retained batch, as the GPU computes it
 */
function simulatedErrorPx(
  vertex: [number, number],
  origin: [number, number],
  center: [number, number],
  zoom: number,
): number {
  const o: [number, number] = [Math.fround(origin[0]), Math.fround(origin[1])];
  const c: [number, number] = [Math.fround(center[0]), Math.fround(center[1])];
  const cos = Math.cos((vertex[1] * Math.PI) / 180);
  let worst = 0;
  for (const axis of [0, 1]) {
    const baked = Math.fround(vertex[axis] - o[axis]);
    const shift = Math.fround(o[axis] - c[axis]);
    const onGpu = Math.fround(baked + shift);
    const exact = vertex[axis] - c[axis];
    const scale = axis === 1 ? 1 / cos : 1;
    worst = Math.max(worst, Math.abs(onGpu - exact) * scale * pxPerDegree(zoom));
  }
  return worst;
}

/** The worst simulated error over a grid of vertices in a region */
function worstInRegion(origin: [number, number], region: BoundingBox, zoom: number): number {
  let worst = 0;
  const center: [number, number] = [
    (region.minX + region.maxX) / 2,
    (region.minY + region.maxY) / 2,
  ];
  for (let i = 0; i <= 20; i++) {
    for (let j = 0; j <= 20; j++) {
      const vertex: [number, number] = [
        region.minX + ((region.maxX - region.minX) * i) / 20,
        region.minY + ((region.maxY - region.minY) * j) / 20,
      ];
      worst = Math.max(worst, simulatedErrorPx(vertex, origin, center, zoom));
    }
  }
  return worst;
}

const TOKYO: [number, number] = [139.7671, 35.6812];
/** About 1000 px around Osaka at zoom 22 */
const OSAKA_VIEW: BoundingBox = { minX: 135.4959, minY: 34.7024, maxX: 135.4961, maxY: 34.7026 };
const TOKYO_OSAKA: BoundingBox = { minX: 135.4959, minY: 34.7024, maxX: 139.7671, maxY: 35.6812 };

describe('the precision of a retained batch', () => {
  it('an origin in Tokyo leaves more than 0.1 px in Osaka at zoom 22 (the defect)', () => {
    expect(worstInRegion(TOKYO, OSAKA_VIEW, 22)).toBeGreaterThan(RETAINED_ORIGIN_TOLERANCE_PX);
  });

  it('the error bound is never below the simulated error', () => {
    const cases: Array<[[number, number], BoundingBox, number]> = [
      [TOKYO, OSAKA_VIEW, 22],
      [TOKYO, OSAKA_VIEW, 18],
      [[135.49, 34.7], OSAKA_VIEW, 22],
      [[0, 0], { minX: 10, minY: 60, maxX: 10.001, maxY: 60.001 }, 20],
    ];
    for (const [origin, region, zoom] of cases) {
      expect(retainedOriginErrorPx(origin, region, zoom)).toBeGreaterThanOrEqual(
        worstInRegion(origin, region, zoom),
      );
    }
  });

  it('the origin chosen for the view keeps the error within 0.1 px at zoom 22', () => {
    const origin = rebasedRetainedOrigin(TOKYO, TOKYO_OSAKA, OSAKA_VIEW, 22);
    expect(origin).not.toBeNull();
    expect(worstInRegion(origin as [number, number], OSAKA_VIEW, 22)).toBeLessThanOrEqual(
      RETAINED_ORIGIN_TOLERANCE_PX,
    );
  });

  it('keeps the origin when the error is already within the tolerance', () => {
    expect(rebasedRetainedOrigin(TOKYO, TOKYO_OSAKA, OSAKA_VIEW, 14)).toBeNull();
    expect(rebasedRetainedOrigin([135.496, 34.7025], TOKYO_OSAKA, OSAKA_VIEW, 22)).toBeNull();
  });

  it('keeps the origin when no origin can do much better (the region is large on screen)', () => {
    // The whole extent in view: its center is already the best origin
    const center: [number, number] = [137.6315, 35.1918];
    expect(rebasedRetainedOrigin(center, TOKYO_OSAKA, null, 22)).toBeNull();
  });

  it('keeps the origin when the extent is not in view', () => {
    const away: BoundingBox = { minX: 0, minY: 0, maxX: 1, maxY: 1 };
    expect(rebasedRetainedOrigin(TOKYO, TOKYO_OSAKA, away, 22)).toBeNull();
    expect(rebasedRetainedOrigin(TOKYO, null, OSAKA_VIEW, 22)).toBeNull();
  });
});
